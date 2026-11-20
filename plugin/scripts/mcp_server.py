#!/usr/bin/env python3
"""Work Tracker MCP server (stdio, newline-delimited JSON-RPC, standard library only).

Gives Claude tools to read and update the status of the Jira ticket being worked on.
The person is always the git identity of the checkout, so updates are recorded under
whoever is committing. Jira itself is never changed.
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wt_common as wt  # noqa: E402

SERVER_INFO = {"name": "work-tracker", "version": "1.0.0"}

INSTRUCTIONS = """Work Tracker shows the team's manager which Jira tickets each person is working on in Claude Code, the status of each, and how long each has waited in each status. It only reads Jira; nothing in Jira is ever changed.

- The ticket is detected automatically from the git branch name (feature/PROJ-123, bug/PROJ-123, merge/PROJ-123, ...), and every tool's `ticket` defaults to it, so you can leave `ticket` out on such a branch. If the user is working on a Jira ticket from a branch without the key, call start_ticket once with that key.
- When you load a Jira ticket to start work on it (for example with the jira-pickup skill), its title and description are saved automatically. Then call start_ticket with the key and `summary`: 1-2 plain sentences on what the ticket asks for and the plan. That summary is shown to the manager from the start.
- Keep the status current without being asked: when work is handed off for review, blocked, or finished, call update_ticket_status with a one-line note. When the user says they're blocked, record what they're waiting on in the note.
- At the end, replace the summary with what was actually done: moving a ticket to a done status needs `summary` (2-4 plain sentences for the manager on what was changed and anything left over). You can refresh it at any time with set_work_summary.
- Statuses are customised by the manager; call list_statuses if unsure which exist.
- If a ticket has no title because it wasn't loaded from Jira: load it from Jira if you can (it's saved automatically). Otherwise, once you understand the work, call set_ticket_details with a short title (and a brief description) written from what you know, and set_work_summary with 1-2 plain sentences on what's being done. Don't stop to ask the user for these. Never change anything in Jira for the tracker.
- Only update tickets the user is actually working on or asked about."""

REPO_PATH = {"type": "string", "description": "Path of the git checkout (defaults to the session's project folder). Pass it when working in a separate worktree."}
TICKET = {"type": "string", "description": "Jira ticket key, e.g. PROJ-123. Optional: defaults to the key in the current branch name (feature/PROJ-123, bug/PROJ-123, merge/PROJ-123, ...)"}

TOOLS = [
    {
        "name": "current_ticket",
        "description": "Show the Jira ticket this checkout's branch is on, with its tracker status, how long it has been in that status, and the work summary.",
        "inputSchema": {"type": "object", "properties": {"repo_path": REPO_PATH}},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "start_ticket",
        "description": "Record that the user is starting or resuming work on a Jira ticket, with a starting summary. Adds the ticket to the tracker if needed. Use after loading a ticket from Jira, or when the branch name doesn't contain the key.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticket": TICKET,
                "summary": {"type": "string", "description": "1-2 plain sentences on what the ticket asks for and the plan; shown to the manager until it's replaced with what was done"},
                "title": {"type": "string", "description": "Ticket title from Jira, only if you already have it"},
                "description": {"type": "string", "description": "Ticket description from Jira, only if you already have it"},
                "repo_path": REPO_PATH,
            },
        },
    },
    {
        "name": "update_ticket_status",
        "description": "Move a ticket to another tracker status, with a short note. Moving to a done status requires `summary`.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticket": TICKET,
                "status": {"type": "string", "description": "Status name, e.g. \"In Review\" or \"Done\""},
                "note": {"type": "string", "description": "Why it moved, or what it's waiting on"},
                "summary": {"type": "string", "description": "Summary of the work done, for the manager (required for done statuses)"},
                "repo_path": REPO_PATH,
            },
            "required": ["status"],
        },
    },
    {
        "name": "set_work_summary",
        "description": "Save or replace the summary of the work done on a ticket, shown to the manager.",
        "inputSchema": {
            "type": "object",
            "properties": {"ticket": TICKET, "summary": {"type": "string"}, "repo_path": REPO_PATH},
            "required": ["summary"],
        },
    },
    {
        "name": "add_ticket_note",
        "description": "Add a progress note to a ticket without changing its status.",
        "inputSchema": {
            "type": "object",
            "properties": {"ticket": TICKET, "note": {"type": "string"}, "repo_path": REPO_PATH},
            "required": ["note"],
        },
    },
    {
        "name": "my_tickets",
        "description": "List the tickets the user is working on, longest-waiting first.",
        "inputSchema": {
            "type": "object",
            "properties": {"include_done": {"type": "boolean", "description": "Also show tickets finished in the last 7 days"}, "repo_path": REPO_PATH},
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "team_tickets",
        "description": "List tickets across the team, optionally for one person (name or email) and/or one status.",
        "inputSchema": {
            "type": "object",
            "properties": {"person": {"type": "string"}, "status": {"type": "string"}, "include_done": {"type": "boolean"}},
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "get_ticket",
        "description": "Show one ticket: title, description, status, work summary, history, and total time in each status.",
        "inputSchema": {"type": "object", "properties": {"ticket": TICKET, "repo_path": REPO_PATH}},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "list_statuses",
        "description": "List the tracker's statuses in board order, with their category and stuck limit.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "set_ticket_details",
        "description": "Give a ticket its title and description when they weren't loaded from Jira: use the Jira text if you have it, otherwise a short title (and brief description) written from what you know about the work. Jira data, when it arrives, replaces it.",
        "inputSchema": {
            "type": "object",
            "properties": {"ticket": TICKET, "title": {"type": "string"}, "description": {"type": "string"}, "repo_path": REPO_PATH},
            "required": ["title"],
        },
    },
]


# ---------- formatting ----------

def dur(ms):
    """Time in days: this is a status tracker, not a stopwatch."""
    if ms is None:
        return ""
    d = int(ms // 86_400_000)
    if d < 1:
        return "less than a day"
    return "1 day" if d == 1 else f"{d} days"


def line(t):
    bits = [f"{t['key']} \"{t.get('title') or '(title not loaded)'}\"", f"{t['status']} for {dur(t.get('time_in_status_ms'))}"]
    if t.get("assignee"):
        bits.append(t["assignee"])
    if t.get("stuck"):
        bits.append(f"STUCK (limit {t.get('stuck_after_days')} days)")
    return "- " + " | ".join(bits)


def detail(t):
    out = [
        f"{t['key']}: {t.get('title') or '(title not loaded from Jira yet)'}",
        f"Status: {t['status']} ({t['status_category']}) for {dur(t.get('time_in_status_ms'))}" + (" - STUCK" if t.get("stuck") else ""),
        f"Working on it: {t.get('assignee') or 'nobody'}",
    ]
    if t.get("jira_url"):
        out.append(f"Jira: {t['jira_url']}")
    if t.get("details_missing"):
        out.append("No title yet: it wasn't loaded from Jira" + (f" ({t['details_error']})" if t.get("details_error") else "") + ". Load it from Jira if you can; otherwise call set_ticket_details with a short title written from what you know about the work.")
    if t.get("work_summary"):
        out += ["", "Work summary:", t["work_summary"]]
    elif t.get("status_category") != "done":
        out.append("No work summary yet: call set_work_summary with 1-2 plain sentences on what's being done.")
    if t.get("description"):
        out += ["", "Description:", t["description"][:4000]]
    if t.get("time_by_status"):
        out += ["", "Time in each status:"] + [f"- {s['status']}: {dur(s['total_ms'])}{' (now)' if s['current'] else ''}" for s in t["time_by_status"]]
    if t.get("history"):
        out += ["", "Recent history:"]
        for e in t["history"][-15:]:
            what = {"created": f"started in {e.get('to')}", "status": f"{e.get('from')} -> {e.get('to')}", "assigned": "picked up", "summary": "summary updated", "comment": "note"}.get(e["kind"], e["kind"])
            note = e.get("note") or ""
            if e["kind"] == "summary":
                note = ""
            out.append(f"- {e.get('by') or 'system'} ({e['source']}): {what}{' - ' + note if note else ''}")
    return "\n".join(out)


# ---------- tool implementations ----------

def checkout(args):
    return args.get("repo_path") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def person(args):
    who = wt.identity(checkout(args))
    if not who.get("email"):
        raise wt.TrackerError("git user.email isn't set for this checkout. Set it with: git config --global user.email you@company.com")
    return who


def ticket_arg(args):
    """The ticket the tool is about: as given, or the Jira key in the checkout's branch name."""
    given = str(args.get("ticket") or "").strip()
    if given:
        return given
    cwd = checkout(args)
    branch = wt.current_branch(cwd)
    key = wt.key_from_branch(branch)
    if not key:
        raise wt.TrackerError(f"No ticket given, and the branch ({branch or 'none'}) has no Jira key in its name. Pass ticket, e.g. PROJ-123.")
    return key


def call_tool(name, args):
    if name == "current_ticket":
        cwd = checkout(args)
        branch = wt.current_branch(cwd)
        key = wt.key_from_branch(branch)
        if not key:
            return f"The checkout at {cwd} is on branch {branch or '(none)'}, which has no Jira key. Ask the user which ticket they're working on, then call start_ticket."
        try:
            return detail(wt.post("/ticket", {"ticket": key}))
        except wt.TrackerError as err:
            if "isn't in the tracker yet" in str(err):
                return f"Branch {branch} is ticket {key}, but it isn't in the tracker yet. Call start_ticket with {key}."
            raise
    if name == "start_ticket":
        r = wt.post("/start", {"person": person(args), "ticket": ticket_arg(args), "title": args.get("title"), "description": args.get("description"), "summary": args.get("summary")})
        t = r["task"]
        lead = "Added" if r.get("created") else "Recorded work on"
        msg = f"{lead} {t['key']} \"{t.get('title') or '(title not loaded)'}\" - status {t['status']}."
        if t.get("details_missing"):
            msg += " It has no title because it wasn't loaded from Jira: load it from Jira if you can, otherwise call set_ticket_details with a short title written from what you know about the work."
        return msg
    if name == "update_ticket_status":
        r = wt.post("/status", {"person": person(args), "ticket": ticket_arg(args), "status": args["status"], "note": args.get("note"), "summary": args.get("summary")})
        t = r["task"]
        if not r.get("changed"):
            return f"{t['key']} is already in {t['status']}" + ("; the note/summary was saved." if args.get("note") or args.get("summary") else ".")
        return f"{t['key']} moved {r['previous_status']} -> {t['status']} (it was in {r['previous_status']} for {dur(r.get('time_in_previous_ms'))})."
    if name == "set_work_summary":
        t = wt.post("/summary", {"person": person(args), "ticket": ticket_arg(args), "summary": args["summary"]})["task"]
        return f"Work summary saved on {t['key']}."
    if name == "add_ticket_note":
        t = wt.post("/note", {"person": person(args), "ticket": ticket_arg(args), "note": args["note"]})["task"]
        return f"Note added to {t['key']}."
    if name == "my_tickets":
        r = wt.post("/my-tickets", {"person": person(args), "include_done": bool(args.get("include_done"))})
        if not r["tickets"]:
            return f"No tickets for {r['person']['name']} yet. Tickets appear when you work on a branch named with the Jira key, or via start_ticket."
        return f"{len(r['tickets'])} ticket(s) for {r['person']['name']}:\n" + "\n".join(line(t) for t in r["tickets"])
    if name == "team_tickets":
        r = wt.post("/tickets", {"assignee": args.get("person"), "status": args.get("status"), "include_done": bool(args.get("include_done"))})
        return ("\n".join(line(t) for t in r["tickets"])) if r["tickets"] else "No matching tickets."
    if name == "get_ticket":
        return detail(wt.post("/ticket", {"ticket": ticket_arg(args)}))
    if name == "list_statuses":
        r = wt.post("/statuses", {})
        return "\n".join(
            f"- {s['name']} ({s['category']})" + (f", stuck after {s['stuck_after_days']} day(s)" if s.get("stuck_after_days") else "")
            for s in r["statuses"]
        )
    if name == "set_ticket_details":
        r = wt.post("/details", {"person": person(args), "ticket": ticket_arg(args), "title": args["title"], "description": args.get("description")})
        if not r.get("tracked"):
            return f"Saved title and description for {ticket_arg(args).upper()}; they'll show once work on it starts."
        return f"Saved title and description for {r['task']['key']}."
    raise wt.TrackerError(f"unknown tool {name}")


# ---------- JSON-RPC over stdio ----------

def respond(msg_id, result=None, error=None):
    payload = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def handle(msg):
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}
    if msg_id is None:  # notification (e.g. notifications/initialized): no reply
        return
    if method == "initialize":
        requested = params.get("protocolVersion")
        version = requested if isinstance(requested, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", requested) else "2025-06-18"
        respond(msg_id, {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS})
    elif method == "ping":
        respond(msg_id, {})
    elif method == "tools/list":
        respond(msg_id, {"tools": TOOLS})
    elif method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            text = call_tool(name, args)
            respond(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
        except wt.TrackerError as err:
            respond(msg_id, {"content": [{"type": "text", "text": str(err)}], "isError": True})
        except KeyError as err:
            respond(msg_id, {"content": [{"type": "text", "text": f"missing argument {err}"}], "isError": True})
        except Exception as err:  # keep the server alive
            wt.stderr(f"work-tracker tool {name} failed: {err!r}")
            respond(msg_id, {"content": [{"type": "text", "text": f"Work Tracker tool failed: {err}"}], "isError": True})
    elif method in ("resources/list", "prompts/list"):
        respond(msg_id, {"resources": []} if method == "resources/list" else {"prompts": []})
    else:
        respond(msg_id, error={"code": -32601, "message": f"Method not found: {method}"})


def main():
    url, key = wt.config()
    wt.log(
        f"mcp server started: tracker={url or 'NOT SET'} team_key={'set' if key else 'NOT SET'}"
    )
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except Exception:
            respond(None, error={"code": -32700, "message": "Parse error"})
            continue
        for m in msg if isinstance(msg, list) else [msg]:
            handle(m)


if __name__ == "__main__":
    main()
