"""Shared helpers for the Work Tracker plugin's hook and MCP server.

Standard library only, compatible with the python3 that ships with macOS (3.9).
Nothing here writes to stdout: the hook's stdout becomes Claude's context and the
MCP server's stdout is the protocol channel.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

# A Jira key inside a branch name, e.g. feature/PROJ-123 or bugfix/proj-123-login.
# The project part needs 2+ characters so things like "v-2" don't match.
KEY_IN_BRANCH = re.compile(r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_]+-\d+)(?![0-9])")
CONFIG_FILE = os.path.expanduser("~/.config/work-tracker/config.json")


class TrackerError(Exception):
    pass


def _usable(value):
    # An unset plugin option can arrive as the literal "${user_config.x}".
    return bool(value) and not str(value).startswith("${")


def config():
    """(server_url, team_key) from plugin settings, then env vars, then ~/.config/work-tracker/config.json."""
    url = next((v for v in (os.environ.get("CLAUDE_PLUGIN_OPTION_SERVER_URL"), os.environ.get("WORK_TRACKER_URL")) if _usable(v)), None)
    key = next((v for v in (os.environ.get("CLAUDE_PLUGIN_OPTION_TEAM_KEY"), os.environ.get("WORK_TRACKER_KEY")) if _usable(v)), None)
    if not (url and key) and os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                data = json.load(f)
            url = url or data.get("server_url")
            key = key or data.get("team_key")
        except Exception:
            pass
    return (url.rstrip("/") if url else None), key


def git(args, cwd):
    try:
        out = subprocess.run(["git", *args], cwd=cwd or None, capture_output=True, text=True, timeout=4)
        value = out.stdout.strip()
        return value if out.returncode == 0 and value else None
    except Exception:
        return None


def identity(cwd):
    """The git name and email Claude Code is committing as in this checkout."""
    return {"email": git(["config", "user.email"], cwd), "name": git(["config", "user.name"], cwd)}


def current_branch(cwd):
    b = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
    return None if b in (None, "HEAD") else b


def key_from_branch(branch, keep_case=False):
    """First Jira-looking key in a branch name. Upper-cased unless keep_case (the server then
    decides whether a lowercase match counts, based on the configured project keys)."""
    if not branch:
        return None
    m = KEY_IN_BRANCH.search(branch)
    if not m:
        return None
    return m.group(1) if keep_case else m.group(1).upper()


def post(path, body, timeout=20):
    url, key = config()
    if not (url and key):
        raise TrackerError(
            "Work Tracker isn't configured. Set the plugin's server address and team key "
            "(claude plugin install work-tracker@work-tracker --config server_url=... --config team_key=...)."
        )
    req = urllib.request.Request(
        f"{url}/api/claude{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as err:
        try:
            message = json.loads(err.read().decode("utf-8")).get("error")
        except Exception:
            message = None
        raise TrackerError(message or f"Work Tracker returned HTTP {err.code}")
    except urllib.error.URLError as err:
        raise TrackerError(f"Can't reach Work Tracker at {url}: {err.reason}")


def log(message):
    """Best-effort debug log in the plugin's data folder (never stdout)."""
    folder = os.environ.get("CLAUDE_PLUGIN_DATA")
    if not folder:
        return
    try:
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "work-tracker.log"), "a") as f:
            f.write(message.rstrip() + "\n")
    except Exception:
        pass


def stderr(message):
    sys.stderr.write(message.rstrip() + "\n")
    sys.stderr.flush()


# ---------- Jira data seen by Claude ----------

ISSUE_KEY = re.compile(r"^[A-Z][A-Z0-9_]+-\d+$")


def active_ticket_title(cwd, key):
    """Title the dev-workflow pickup skill saved in .claude/jira-state/active.json, if it's this ticket."""
    top = git(["rev-parse", "--show-toplevel"], cwd)
    if not top:
        return None
    try:
        with open(os.path.join(top, ".claude", "jira-state", "active.json")) as f:
            data = json.load(f)
        if str(data.get("key", "")).upper() == key and isinstance(data.get("summary"), str):
            return data["summary"].strip() or None
    except Exception:
        return None
    return None


def adf_to_text(node):
    """Flatten Atlassian Document Format (Jira's rich-text JSON) to plain text."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_to_text(n) for n in node)
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    kids = lambda: "".join(adf_to_text(c) for c in node.get("content") or [])  # noqa: E731
    if kind == "text":
        return node.get("text", "")
    if kind == "hardBreak":
        return "\n"
    if kind in ("paragraph", "heading", "codeBlock"):
        return kids() + "\n\n"
    if kind == "bulletList":
        return "\n".join("- " + adf_to_text(li).strip() for li in node.get("content") or []) + "\n\n"
    if kind == "orderedList":
        return "\n".join(f"{i + 1}. " + adf_to_text(li).strip() for i, li in enumerate(node.get("content") or [])) + "\n\n"
    if kind in ("mention", "emoji"):
        attrs = node.get("attrs") or {}
        return attrs.get("text") or attrs.get("shortName") or ""
    if kind in ("inlineCard", "blockCard"):
        return (node.get("attrs") or {}).get("url", "")
    if kind == "doc":
        return re.sub(r"\n{3,}", "\n\n", kids()).strip()
    return kids()


def _dicts(obj, depth=0):
    """Every dict inside obj, outermost first, parsing JSON text along the way (MCP results
    usually carry the payload as text content)."""
    if depth > 8:
        return
    if isinstance(obj, str):
        s = obj.strip()
        if s[:1] in "{[":
            try:
                yield from _dicts(json.loads(s), depth + 1)
            except Exception:
                pass
        return
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _dicts(v, depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            yield from _dicts(v, depth + 1)


def jira_issue_from_tool(tool_input, tool_response):
    """Key, title and description from a getJiraIssue tool call, or None if it isn't one."""
    wanted = str((tool_input or {}).get("issueIdOrKey") or "").strip().upper()
    for d in _dicts(tool_response):
        fields = d.get("fields")
        if not isinstance(fields, dict) or not isinstance(fields.get("summary"), str):
            continue
        key = str(d.get("key") or "").strip().upper()
        if wanted and ISSUE_KEY.match(wanted) and key and key != wanted:
            continue  # a linked issue nested inside the response (parent, subtask...)
        key = key or wanted
        if not ISSUE_KEY.match(key):
            continue
        desc = fields.get("description")
        desc = adf_to_text(desc) if isinstance(desc, (dict, list)) else (desc if isinstance(desc, str) else "")
        return {"key": key, "title": fields["summary"].strip(), "description": desc.strip()}
    return None


def describe_shape(obj, depth=0):
    """Short structural description of a value, for the debug log (no content)."""
    if depth > 3:
        return "..."
    if isinstance(obj, dict):
        return "{" + ", ".join(f"{k}: {describe_shape(v, depth + 1)}" for k, v in list(obj.items())[:8]) + "}"
    if isinstance(obj, list):
        return f"[{describe_shape(obj[0], depth + 1) if obj else ''}]x{len(obj)}"
    if isinstance(obj, str):
        return f"str({len(obj)})"
    return type(obj).__name__
