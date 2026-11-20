#!/usr/bin/env python3
"""Work Tracker hook for Claude Code.

  hook.py context   SessionStart, synchronous. On a ticket branch, prints one line that
                    tells Claude which ticket the session is on (stdout becomes context).
                    No network calls, so it never slows a session down.
  hook.py ping      SessionStart + UserPromptSubmit, async. Reports "this person is
                    working on this ticket in this app" to the tracker.

Always exits 0 and never blocks Claude Code. Outside a ticket branch it does nothing.
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wt_common as wt  # noqa: E402


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "ping"
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    branch = wt.current_branch(cwd)
    key = wt.key_from_branch(branch)
    url, team_key = wt.config()
    if not key or not (url and team_key):
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
        wt.post(
            "/activity",
            {
                "person": who,
                "ticket": wt.key_from_branch(branch, keep_case=True),
                "branch": branch,
                "repo": wt.repo_name(cwd),
                "session_id": data.get("session_id"),
                "event": data.get("hook_event_name"),
                "session_source": data.get("source"),
                "app_info": wt.app_info(),
            },
            timeout=5,
        )
    except wt.TrackerError as err:
        wt.log(f"{time.ctime()} {key}: {err}")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # never break the user's session
        wt.log(f"{time.ctime()} hook error: {err!r}")
    sys.exit(0)
