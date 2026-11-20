#!/usr/bin/env python3
"""Work Tracker hook for Claude Code.

  hook.py context    SessionStart, synchronous. On a ticket branch, prints one line that
                     tells Claude which ticket the session is on (stdout becomes context).
                     No network calls, so it never slows a session down.
  hook.py ping       SessionStart, async. Tells the tracker this person started work on this
                     ticket (git name/email + ticket key, plus the title from
                     .claude/jira-state/active.json when the pickup skill wrote one). Nothing
                     about the session, app, repo or prompts is sent. If the ticket has no title
                     (not loaded from Jira) or no summary, asks Claude to write them.
  hook.py jira       PostToolUse on getJiraIssue (any Atlassian connector), synchronous.
                     Takes the key, title and description from the Jira response, hands them
                     to a background process to send, and asks Claude for a starting summary.
  hook.py jira-post  (internal) the background sender for `jira`.

Always exits 0 and never blocks Claude Code.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wt_common as wt  # noqa: E402


def read_input():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def on_jira_fetch(data):
    """A getJiraIssue call just returned: capture the ticket's details for the tracker."""
    issue = wt.jira_issue_from_tool(data.get("tool_input"), data.get("tool_response"))
    if not issue:
        wt.log(f"{time.ctime()} {data.get('tool_name')}: no issue found in response {wt.describe_shape(data.get('tool_response'))}")
        return
    # Send in a detached process so loading tickets from Jira never waits on the tracker.
    try:
        child = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "jira-post"],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        child.stdin.write(json.dumps({"ticket": issue["key"], "title": issue["title"], "description": issue["description"]}).encode("utf-8"))
        child.stdin.close()
    except Exception as err:
        wt.log(f"{time.ctime()} {issue['key']}: could not start sender: {err!r}")
    key = issue["key"]
    if not first_time_this_session(data.get("session_id"), key):
        return
    note = (
        f"Work Tracker saved {key} \"{issue['title']}\" with its description for the manager's dashboard. "
        f"Only if {key} is the ticket the user is starting or resuming work on now (not a parent, sibling, linked or "
        f"merely viewed ticket): call the work-tracker start_ticket tool with ticket {key} and summary: 1-2 plain "
        "sentences on what the ticket asks for and the plan. When the work is finished, replace that summary with "
        "what was actually done (update_ticket_status with summary, or set_work_summary)."
    )
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": note}}))


def first_time_this_session(session_id, key):
    """Nudge Claude about a ticket once per session (the details are still saved every time)."""
    folder = os.environ.get("CLAUDE_PLUGIN_DATA")
    if not folder or not session_id:
        return True
    path = os.path.join(folder, "nudged.json")
    try:
        with open(path) as f:
            seen = json.load(f)
    except Exception:
        seen = {}
    keys = seen.get(session_id, [])
    if key in keys:
        return False
    seen.pop(session_id, None)
    seen[session_id] = keys + [key]
    try:
        os.makedirs(folder, exist_ok=True)
        with open(path, "w") as f:
            json.dump(dict(list(seen.items())[-50:]), f)  # keep the last 50 sessions
    except Exception:
        pass
    return True


def send_jira_capture():
    payload = read_input()
    try:
        wt.post("/jira-capture", payload, timeout=20)
    except wt.TrackerError as err:
        wt.log(f"{time.ctime()} {payload.get('ticket')}: jira capture failed: {err}")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "ping"
    if mode == "jira-post":
        return send_jira_capture()
    data = read_input()
    url, team_key = wt.config()
    if not (url and team_key):
        return
    if mode == "jira":
        return on_jira_fetch(data)

    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    branch = wt.current_branch(cwd)
    key = wt.key_from_branch(branch)
    if not key:
        return

    if mode == "context":
        print(
            f"Work Tracker: this session is on Jira ticket {key} (branch {branch}). Its status is shown to the "
            "team's manager. When the work is handed off, blocked or finished, update it with the work-tracker "
            "update_ticket_status tool, and include a short summary of the work when marking it done."
        )
        return

    who = wt.identity(cwd)
    if not who.get("email"):
        wt.log(f"{time.ctime()} skipped {key}: git user.email is not set in {cwd}")
        return
    try:
        res = wt.post(
            "/activity",
            {
                "person": who,
                "ticket": wt.key_from_branch(branch, keep_case=True),
                "title": wt.active_ticket_title(cwd, key),
                "event": data.get("hook_event_name"),
                "session_source": data.get("source"),
            },
            timeout=15,  # runs in the background; allows for a cold start on a serverless host
        )
    except wt.TrackerError as err:
        wt.log(f"{time.ctime()} {key}: {err}")
        return
    ask_for_missing_details(res.get("task") or {})


def ask_for_missing_details(task):
    """If the ticket has no title (not loaded from Jira) or no summary, ask Claude to provide them.
    The hook runs in the background, so Claude Code passes this on at Claude's next turn."""
    key = task.get("key")
    if not key or task.get("status_category") == "done":
        return
    if task.get("details_missing"):
        note = (
            f"Work Tracker: {key} has no title or description on the manager's dashboard because it wasn't loaded "
            "from Jira. If you load it from Jira, they're saved automatically. Otherwise, once you understand the "
            "work, call the work-tracker set_ticket_details tool with a short title (and a brief description) "
            "written from what you know, and set_work_summary with 1-2 plain sentences on what's being done. "
            "Don't stop to ask the user for these."
        )
    elif not task.get("work_summary"):
        note = (
            f"Work Tracker: {key} has no work summary yet. Once you understand the work, call the work-tracker "
            "set_work_summary tool with 1-2 plain sentences on what's being done. Don't stop to ask the user for it."
        )
    else:
        return
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": note}}))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # never break the user's session
        wt.log(f"{time.ctime()} hook error: {err!r}")
    sys.exit(0)
