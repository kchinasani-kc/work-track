# Work Tracker

A small web app that shows a manager which Jira tickets each person is working on in Claude Code, what status each ticket is in, and how long it has been waiting there. Nobody types updates into it:

- **Jira is only read.** The tracker takes each ticket's key, title and description from Jira and never changes anything there.
- **People come from git.** A person is their `git config user.name` and `user.email`.
- **Claude Code reports the work.** A small Claude Code plugin notices the Jira ticket from the git branch, such as `feature/PROJ-123`. Claude then moves the ticket through the tracker's own statuses and writes a summary of the work when it's done. It works in the terminal, the Claude desktop app, and the VS Code and Cursor extensions.

The manager sees five pages:

- **Board**: one column per status. Each card shows how long the ticket has been in that status, a bar that fills toward the status's "stuck" limit, and a green **Now** badge with the app while someone is actively on it.
- **Team**: one lane per person. It shows what they're on right now and in which app, their open tickets with the wait on each, and what they finished in the last 7 days, with summaries.
- **Waiting time**: for each status, the tickets waiting now, the longest current wait, and the average and median time spent there. Also start-to-done time and a list of stuck tickets.
- **Statuses**: add, rename, recolour, reorder or archive statuses, and set how many days in each counts as stuck.
- **Connect**: the team key and the copy-paste commands to set up each person.

## How it works

```
 developer's machine                                   tracker server
 ───────────────────                                   ──────────────
 git branch feature/PROJ-123
        │
 Claude Code + work-tracker plugin
   hook (session start, each prompt) ── who / ticket / app ──▶  records activity
                                                                  first time: adds PROJ-123
                                                                  in the first Active status
                                                                         │
                                                                         ▼
                                                                  Jira (read-only GET)
                                                                  title + description
   tools: update_ticket_status,  ─── status / note / summary ──▶  history log ──▶ dashboard
          set_work_summary, ...
```

- **Hooks.** The plugin's hooks run on session start and on every prompt, in the background. They never slow Claude down, and they do nothing outside a ticket branch. At session start they also tell Claude which ticket the session is on.
- **Tools.** The plugin's tools let Claude update the ticket. The server instructions tell Claude to do this on its own: move the ticket to review, blocked or done as the work goes, with a one-line note, and write a 2–4 sentence summary when it's done. Moving to a done status is refused without a summary.
- **Attribution.** Every change is kept in an append-only history: who made it (their git identity), when, the note, and whether it came from Claude, from automatic detection, or from the dashboard. Waiting times are calculated from that history.

## Quick start

Requires Node.js 22.13 or newer. It uses Node's built-in SQLite, so there is nothing to compile. The plugin needs `python3` and `git` on each developer's machine; the Python that ships with macOS is enough.

```bash
npm install
npm start
```

On first start it creates a manager login and prints it. To choose it yourself, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first start. Sign in, then:

1. Open **Connect**.
2. Set **Jira projects to track** (for example `PROJ, OPS`), so only branches for those projects count.
3. Follow the steps there for each team member.

### Try it with sample data

```bash
npm run demo
```

This builds a separate `data/demo.db` with four developers and two weeks of history, then starts the server. Sign in with `admin@localhost` / `demo-password`. Your real data in `data/tracker.db` is not touched.

## Reading Jira (optional, read-only)

To load titles and descriptions on the server, set three variables before starting it:

```bash
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=tracker-bot@yourcompany.com
JIRA_API_TOKEN=...
```

The account only needs permission to browse the tracked projects. The tracker only sends `GET /rest/api/3/issue/{key}?fields=summary,description`. In Jira, "summary" is the ticket's title.

Titles are fetched the first time a ticket appears and refreshed at most every 6 hours. There is also a **Reload from Jira** button on each ticket.

Without these variables, the tracker asks each person's Claude for the title instead. If Claude can read Jira, for example with the Atlassian connector, it fills the title in. Otherwise the ticket shows its key until someone reloads it.

## Setting up each team member

The **Connect** page shows these commands with your server's address and team key filled in.

1. **Add the plugin source, once per computer.** Use the git address of this repository, a GitHub `owner/repo`, or a shared folder path:

   ```bash
   claude plugin marketplace add <git address or path of this repo>
   ```

2. **Install the plugin** with the tracker's address and the team key:

   ```bash
   claude plugin install work-tracker@work-tracker --config server_url=http://tracker.office.local:4000 --config team_key=wtk_...
   ```

3. **Let Claude update the tracker without asking each time.** Otherwise Claude Code stops for approval on every status update. A plugin can't pre-approve its own tools, so each person adds this allow rule once. In Claude Code, run `/permissions` and add it as an Allow rule, or add it to `permissions.allow` in `~/.claude/settings.json`:

   ```
   mcp__plugin_work-tracker_work-tracker__*
   ```

4. **Make sure git knows who they are.** This name and email are how they appear in the tracker:

   ```bash
   git config --global user.name "Full Name"
   ```

   ```bash
   git config --global user.email name@company.com
   ```

5. **Restart Claude Code.** In the terminal, desktop app or IDE, run `/mcp` and check that `plugin:work-tracker:work-tracker` is connected.

From then on, opening a session on a ticket branch adds the ticket to the Board. To show the address on the Connect page, set `PLUGIN_SOURCE` on the server.

**Keep the key out of shell history.** Install without the two `--config` parts, then enter the values in Claude Code with `/plugin configure work-tracker@work-tracker`.

**Branch names.** Keys are read from branch names like `feature/PROJ-123`. Until **Jira projects to track** is set, only uppercase keys count. That keeps branches like `bump-lodash-4` from showing up as tickets. Once the projects are set, lowercase keys such as `feature/proj-123` work too, and keys from other projects are ignored.

**Working without a ticket branch?** Tell Claude "I'm working on PROJ-123". It records that with the `start_ticket` tool.

**Updates.** Auto-update is off by default for plugins from your own marketplace. To pick up a new version, run:

```bash
claude plugin marketplace update work-tracker
```

```bash
claude plugin update work-tracker@work-tracker
```

### What people can say to Claude

The plugin tells Claude to keep things current on its own. People can also be direct:

- "I've opened the PR, move this to review"
- "I'm blocked on PROJ-88, waiting for the API keys"
- "This is done": Claude writes the summary and moves the ticket to Done
- "What am I working on?" / "What's Neha working on?"

| Tool | What it does |
| --- | --- |
| `current_ticket` | The ticket this checkout's branch is on, with status, wait and summary |
| `start_ticket` | Record work on a ticket when the branch has no key |
| `update_ticket_status` | Move to another status with a note. Done statuses need `summary` |
| `set_work_summary` | Save or replace the summary of the work done |
| `add_ticket_note` | Progress note without a status change |
| `my_tickets` / `team_tickets` | The person's tickets, or anyone's |
| `get_ticket` | Title, description, status, summary, history and time in each status |
| `list_statuses` | The current statuses, in order |
| `set_ticket_details` | Title and description from Jira, when the server can't read Jira itself |

## Statuses

Statuses belong to the tracker, not Jira, and are fully customisable under **Statuses**.

- **New tickets** start in the first **Active** status the first time someone works on them in Claude Code. That starts the clock.
- **Parked tickets**: a ticket parked in a **To do** status moves back to that first active status when work resumes.
- **Blocked** statuses count toward each person's blocked total.
- **Done** statuses close the ticket. Claude must include a work summary, and done tickets are left out of waiting times.
- **Stuck after (days)**: a ticket that sits in a status longer than this turns red. Leave it empty to use the default (3 days); set it to 0 to never flag that status.
- **Renaming and archiving.** Renaming keeps all past history. Archiving asks where to move any tickets still in that status.

The dashboard never changes a ticket's status. Status comes only from Claude, so the history shows real work. A manager can remove a wrongly detected ticket; Jira is not affected.

## How waiting time is measured

A ticket's history starts with a "started" entry when it is first worked on, and each status change adds an entry. A **stint** is the time between one entry and the next. For the current status, the stint runs up to now.

- **Waiting now**: open tickets in the status today, and how long each has been there.
- **Average time spent / Median**: every stint in that status that ended inside the selected window.
- **Start to done**: from first activity in Claude Code to entering a done status.
- **Working now**: someone's Claude Code reported activity on the ticket within the last 30 minutes. The window is changeable on Connect.

## Things to know

- **A parked ticket stays parked.** If Claude moves a ticket to a to-do status, it stays there for the rest of that session. It restarts when a new Claude Code session begins on the ticket's branch.
- **The team key is shared.** Anyone who has it can report work under any git email. Share it only with the team. **Make a new key** on Connect if it leaks; everyone then reinstalls with the new key.
- **App names are best effort.** Claude Code doesn't document a way to tell its apps apart. The tracker reads the environment the plugin runs in, and keeps the raw values on each session in the ticket's details. In testing, the desktop app reported correctly. VS Code and Cursor haven't been checked yet.
- **People are matched by exact git email.** Someone who commits with two emails shows up as two people. You can rename people, but not merge them.
- **When someone else picks up a ticket**, for example a reviewer working on the same branch, the ticket moves to their lane, and the history records the hand-over.

## Running it for the team

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | Port to listen on |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` so teammates' Claude Code can reach it |
| `PUBLIC_URL` | `http://HOST:PORT` | The address teammates use. It goes into the commands on Connect. When it starts with `https://`, the sign-in cookie is marked secure |
| `PLUGIN_SOURCE` | none | Git address or path of this repo, shown in the Connect commands |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | none | Read-only Jira access for titles and descriptions |
| `DB_FILE` | `data/tracker.db` | SQLite database file |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin@localhost`, random | First manager login, used only when no manager can sign in |

For a shared install:

- Run it on a machine everyone can reach, with `HOST=0.0.0.0` and `PUBLIC_URL` set to that machine's address.
- Keep it running with a process manager: systemd, pm2, or a Windows service.
- Put it behind HTTPS (nginx, Caddy or IIS) so the team key and passwords aren't sent in plain text.

**Backups.** All data lives in one SQLite file. To take a live copy:

```bash
sqlite3 data/tracker.db ".backup data/backup.db"
```

**Locked out?** Reset a manager password from the server machine:

```bash
npm run admin -- reset-password you@company.com 'new-password'
```

**Plugin not reporting?** Each developer's plugin writes a short log to `~/.claude/plugins/data/work-tracker-work-tracker/work-tracker.log`. It shows the tracker address it is using, whether the key is set, and any errors such as a wrong team key or an unreachable server.

## Development

```bash
npm test
```

```bash
npm run dev
```

`npm run dev` restarts the server on file changes.

The tests cover:

- time-in-status maths, the summary rule, custom statuses, project-key filtering and auth
- the real plugin scripts end to end:
  - the hook and tool server run against a live tracker and a fake read-only Jira
  - inside a throwaway git repo on a ticket branch
  - driven by the official MCP client

To check the plugin on the Python that ships with macOS:

```bash
PYTHON=/usr/bin/python3 npm test
```

```
src/service.js     tickets, statuses, people, history and reports
src/claudeApi.js   API the plugin calls (team key + git identity)
src/api.js         dashboard API (manager sessions)
src/jira.js        read-only Jira lookup
src/db.js          schema and default statuses
public/            dashboard (plain HTML, CSS and JS; no build step)
plugin/            the Claude Code plugin: hooks, MCP tool server, manifest
.claude-plugin/    marketplace file, so this repo can be added with `claude plugin marketplace add`
scripts/           demo data and admin commands
```
