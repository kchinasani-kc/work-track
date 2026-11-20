# Work Tracker

A small web app that shows a manager which Jira tickets each person is working on in Claude Code, what status each ticket is in, and how long it has been waiting there. Nobody types updates into it:

- **Jira is only read.** The tracker takes each ticket's key, title and description from Jira and never changes anything there.
- **People come from git.** A person is their `git config user.name` and `user.email`.
- **Claude Code reports the work.** A small Claude Code plugin notices the Jira ticket from the git branch, such as `feature/PROJ-123`. When Claude loads the ticket from Jira (for example with your `jira-pickup` skill), the plugin saves its title and description, and Claude writes a short starting summary. Claude then moves the ticket through the tracker's own statuses and replaces the summary with what was done at the end. It works in the terminal, the Claude desktop app, and the VS Code and Cursor extensions.

The manager sees five pages:

- **Board**: one column per status. Each card shows how long the ticket has been in that status, a bar that fills toward the status's "stuck" limit, and the work summary.
- **Team**: one lane per person, with their open tickets, the wait on each, and what they finished in the last 7 days, with summaries.
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
   hook (session start, once) ───── who / ticket ──────────▶  first time: adds PROJ-123
                                                                  in the first Active status
                                                                         │
                                                                         ▼
                                                                  Jira (read-only GET)
                                                                  title + description
   tools: update_ticket_status,  ─── status / note / summary ──▶  history log ──▶ dashboard
          set_work_summary, ...
```

- **Hooks.** When a Claude Code session starts on a ticket branch, the plugin tells the tracker once, in the background: the person's git name and email and the ticket key. It also tells Claude which ticket the session is on. Outside a ticket branch it does nothing.
- **Ticket details from your Jira skill.** Whenever Claude loads a ticket with an Atlassian connector's `getJiraIssue` tool, as the `jira-pickup` skill does, a plugin hook reads the key, title and description from the response and sends them to the tracker.
  - This happens even before the ticket's branch exists; the details are kept and shown as soon as work on it starts.
  - The title the skill writes to `.claude/jira-state/active.json` is used as a backup.
  - The hook also asks Claude to call `start_ticket` with a 1–2 sentence starting summary: what the ticket asks for and the plan.
- **Tools.** The plugin's tools let Claude update the ticket. The server instructions tell Claude to do this on its own: move the ticket to review, blocked or done as the work goes, with a one-line note. Moving to a done status needs a new summary of what was actually done, which replaces the starting one.
- **Attribution.** Every change is kept in an append-only history: who made it (their git identity), when, the note, and whether it came from Claude, from automatic detection, or from the dashboard. Waiting times are calculated from that history.

## Quick start (on your own computer)

Requires Node.js 20 or newer. The plugin needs `python3` and `git` on each developer's machine; the Python that ships with macOS is enough.

The tracker stores its data in Postgres. In production that's Supabase, covered in the next section. On your own computer, without a `DATABASE_URL`, it uses an embedded Postgres kept in `data/pgdata`, with nothing to install or run:

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

This builds a separate database in `data/demo-pg` with four developers and two weeks of history, then starts the server. Sign in with `admin@localhost` / `demo-password`. Your other data is not touched.

## Deploying on Vercel with Supabase

Vercel runs the app as a serverless function, so its data must live in a hosted database. Use Supabase's Postgres.

1. **Create a Supabase project** in a region near your team. The app's functions must run in the same region, because every page makes several database trips. `vercel.json` pins them to Seoul (`icn1`) to match this project's Supabase region (`ap-northeast-2`). If your Supabase project is elsewhere, change `regions` in `vercel.json` to the matching [Vercel region](https://vercel.com/docs/edge-network/regions).
2. **Copy the connection string.** In Supabase, click **Connect** and copy the **Transaction pooler** string. It looks like this, with your database password filled in:

   ```
   postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```

   Use the transaction pooler (port 6543), not the direct connection; it's the one meant for serverless. If the database password contains `@`, `#`, `/`, `?` or `%`, URL-encode it (for example `@` becomes `%40`), or reset it in Supabase to letters and digits.
3. **Add environment variables in Vercel** (Project → Settings → Environment Variables), then redeploy:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | the pooler string from step 2 |
   | `ADMIN_EMAIL`, `ADMIN_PASSWORD` | the first manager login (8+ character password). Required on Vercel, where a generated password couldn't be shown to you |
   | `PLUGIN_SOURCE` | `kchinasani-kc/work-track`, shown in the Connect page's commands |
   | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | optional, read-only Jira access |

4. **Sign in.** Open the site and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Change the password under **People** if you like; the environment variable is only used while no manager exists.

On the first request, the app creates its tables in a separate `wt` schema, so they can't clash with anything else in the Supabase project. Supabase's public data API can't reach them, and row-level security is on. If something is misconfigured, `/healthz` and the dashboard show the reason, for example a missing `DATABASE_URL` or a wrong password in it.

The site's address goes into each person's plugin. Vercel's production URL is picked up automatically; set `PUBLIC_URL` to use a custom domain instead.

## Reading Jira (optional, read-only)

To load titles and descriptions on the server, set three variables before starting it:

```bash
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=tracker-bot@yourcompany.com
JIRA_API_TOKEN=...
```

The account only needs permission to browse the tracked projects. The tracker only sends `GET /rest/api/3/issue/{key}?fields=summary,description`. In Jira, "summary" is the ticket's title.

Titles are fetched the first time a ticket appears and refreshed at most every 6 hours. There is also a **Reload from Jira** button on each ticket.

Without these variables, titles and descriptions come from Claude Code: the plugin saves them whenever Claude loads the ticket from Jira (see **How it works**), and falls back to the title in the pickup skill's `active.json`. A ticket nobody has loaded from Jira shows only its key.

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
| `start_ticket` | Record that work on a ticket is starting, with a starting summary (also for branches without the key) |
| `update_ticket_status` | Move to another status with a note. Done statuses need `summary` |
| `set_work_summary` | Save or replace the summary of the work done |
| `add_ticket_note` | Progress note without a status change |
| `my_tickets` / `team_tickets` | The person's tickets, or anyone's |
| `get_ticket` | Title, description, status, summary, history and time in each status |
| `list_statuses` | The current statuses, in order |
| `set_ticket_details` | Title and description from Jira, when the server can't read Jira itself |

## What is and isn't tracked

This is a status board, not a monitoring tool. The tracker stores:

- the tickets someone has started, with their Jira key, title and description
- who is working on each ticket (git name and email)
- each status change, with Claude's one-line note
- the work summary: a starting one at pickup, replaced with what was done at the end

It doesn't store prompts, sessions, which app someone uses, how often they use Claude, or when they were last active. Times are shown in days, and history shows dates, not times of day. Upgrading from an earlier version deletes any of that data the tracker had collected.

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

## Things to know

- **A parked ticket stays parked.** If Claude moves a ticket to a to-do status, it stays there for the rest of that session. It restarts when a new Claude Code session begins on the ticket's branch.
- **Supabase's free tier pauses idle projects.** After about a week with no activity, the dashboard shows a "can't start" error until you restore the project in Supabase. Daily use keeps it awake; a paid plan never pauses.
- **The team key is shared.** Anyone who has it can report work under any git email. Share it only with the team. **Make a new key** on Connect if it leaks; everyone then reinstalls with the new key.
- **People are matched by exact git email.** Someone who commits with two emails shows up as two people. You can rename people, but not merge them.
- **When someone else picks up a ticket**, for example a reviewer working on the same branch, the ticket moves to their lane, and the history records the hand-over.

## Settings reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | none | Postgres connection string (Supabase transaction pooler). Without it, a local run uses the embedded database; on Vercel it's required |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin@localhost`, random (local only) | First manager login, used only while no manager can sign in |
| `PUBLIC_URL` | Vercel's production URL, or `http://HOST:PORT` | The address teammates use. It goes into the commands on Connect |
| `PLUGIN_SOURCE` | none | Git address of this repo, shown in the Connect commands |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | none | Read-only Jira access for titles and descriptions |
| `PORT`, `HOST` | `4000`, `127.0.0.1` | Local runs only. Set `HOST=0.0.0.0` to let others on the network reach it |
| `LOCAL_DB_DIR` | `data/pgdata` | Folder for the embedded database (local runs only) |
| `DB_POOL_MAX` | `3` | Connections per server instance to `DATABASE_URL` |

**Backups.** On Supabase, use its built-in daily backups (Project → Database → Backups), or `pg_dump` with the direct connection string. Locally, copy `data/pgdata` while the server is stopped.

**Locked out?** Reset or create a manager login from any machine:

```bash
DATABASE_URL='<your connection string>' npm run admin -- reset-password you@company.com 'new-password'
```

Without `DATABASE_URL` it works on the local embedded database; stop the local server first.

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

- time-in-status maths, the summary rule, custom statuses, project-key filtering, search and auth
- ticket details captured before a ticket is tracked, then applied when work starts
- two simultaneous first reports for a new ticket creating it exactly once
- the HTTP auth guards: wrong team key, no session and wrong password are refused
- the production database driver (postgres.js, as used with Supabase), run over the Postgres network protocol against an embedded Postgres
- the real plugin scripts end to end:
  - the hook and tool server run against a live tracker and a fake read-only Jira
  - inside a throwaway git repo on a ticket branch
  - driven by the official MCP client
  - the Jira-capture hook on the response shapes an Atlassian connector may return (JSON text, content blocks, rich-text or markdown descriptions, errors)

To check the plugin on the Python that ships with macOS:

```bash
PYTHON=/usr/bin/python3 npm test
```

```
src/service.js     tickets, statuses, people, history and reports
src/claudeApi.js   API the plugin calls (team key + git identity)
src/api.js         dashboard API (manager sessions)
src/jira.js        read-only Jira lookup
src/db.js          Postgres connection (Supabase or embedded), schema and default statuses
src/server.js      entry point for `npm start` and for Vercel (default-exported app)
public/            dashboard (plain HTML, CSS and JS; no build step)
plugin/            the Claude Code plugin: hooks, MCP tool server, manifest
.claude-plugin/    marketplace file, so this repo can be added with `claude plugin marketplace add`
scripts/           demo data and admin commands
```
