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


def repo_name(cwd):
    remote = git(["config", "--get", "remote.origin.url"], cwd)
    if remote:
        return re.sub(r"\.git$", "", remote.rstrip("/").split("/")[-1].split(":")[-1])
    top = git(["rev-parse", "--show-toplevel"], cwd)
    return os.path.basename(top) if top else None


def key_from_branch(branch, keep_case=False):
    """First Jira-looking key in a branch name. Upper-cased unless keep_case (the server then
    decides whether a lowercase match counts, based on the configured project keys)."""
    if not branch:
        return None
    m = KEY_IN_BRANCH.search(branch)
    if not m:
        return None
    return m.group(1) if keep_case else m.group(1).upper()


def app_info():
    """Raw hints about which app is running Claude Code; the server turns them into a label."""
    return {
        "entrypoint": os.environ.get("CLAUDE_CODE_ENTRYPOINT"),
        "bundle": os.environ.get("__CFBundleIdentifier"),
        "term_program": os.environ.get("TERM_PROGRAM"),
        "cursor": bool(os.environ.get("CURSOR_TRACE_ID")),
    }


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
