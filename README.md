# Copilot CLI Session Dashboard

A single-file [GitHub Copilot CLI extension](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) that runs a local web dashboard for monitoring and managing all your concurrent Copilot CLI sessions.

> ⚠️ **Note:** This is a personal project I built before the official GitHub Copilot desktop app shipped its own session management UI. It is **not** intended to replicate or compete with the Copilot app — it just scratches some different itches I had around multi-session workflows, workspace persistence, and AI-organized todos. Sharing in case any of it is useful to others.

> 🪟 **Platform:** Windows-first (uses Windows Terminal `wt` for tab launching and PowerShell for some helpers). The web dashboard itself works cross-platform, but tab-launching features require Windows Terminal. PRs to broaden platform support are welcome.

## Features

### 🖥️ Live Multi-Session Monitor (main page)

- Real-time view of **every running and recent CLI session** — status, turn count, tool calls, errors, last activity, summary, branch, repository.
- **Auto-refreshing** via Server-Sent Events (SSE) — no manual reload needed.
- **Search & filter** — type to instantly filter sessions by title, goal, repo, branch, or any text.
- **Group by** — organize session cards by status, repository, or branch.
- **Pin sessions** — pin important sessions to the top.
- **Per-session notes** — free-form notes attached to a session id, persisted to disk across restarts.
- **Timeline view** — expand any session card to see its full event history (turns, tool calls, errors).
- **Attention alerts** — sessions waiting for user input flash and trigger an optional sound alert (🔔 toggle).
- **Quick respond** — tooltip showing the question a waiting session is asking, so you can context-switch quickly.
- **Light/dark theme** — toggle with 🌙 button; remembered in localStorage.

### ▶️ Session Management

- **Resume** — one click opens a new Windows Terminal tab and resumes a session by id (`--resume`).
- **Focus** — click to bring an already-running session's terminal tab to the foreground (uses a warm PowerShell process for fast tab switching).
- **Kill** — terminate a running session from the dashboard.
- **Cleanup stale sessions** — 🧹 button finds sessions older than 30 days and lets you delete their state directories.

### 💾 Workspace Save / Restore

- **Auto-save** — the extension snapshots all active sessions to `saved-workspace.json` every 60 seconds.
- **Startup guard** — refuses to shrink the saved set during the first 3 minutes after startup (prevents a fresh terminal with 0 visible sessions from clobbering a good save).
- **Rolling backups** — keeps 10 numbered backup snapshots (`.1` = newest, `.10` = oldest), rotated only when the session list actually changes.
- **Manual save** (💾 button) — force a snapshot of the current session set.
- **Restore** (🔄 button) — re-open all saved sessions in new Windows Terminal tabs. Deduplicates against already-running sessions.
- **📜 Snapshot browser** — browse all backup snapshots in a modal, inspect which sessions each contains, and **promote** any backup to the active save file (safely rotating the current one into the backup chain first).

### 📝 AI-Organized Todos (with worktree launcher)

Accessible at `/todos`. Paste a brain-dump of tasks and let an LLM (via the Copilot chat API) parse and categorize them:

- **AI parsing** — sends your raw text to `gpt-4.1` (with fallback chain) to produce structured, categorized todos.
- **Drag & drop reordering** — within and across categories.
- **Mark complete / delete / edit** inline.
- **🚀 Worktree launcher** — click 🚀 on any todo to:
  1. Create a sibling `git worktree` for the selected repo on a `<alias>/<slug>` branch.
  2. Drop a `.copilot-todo.md` context file into it with the todo's description.
  3. Open a new terminal tab running `copilot` in that worktree.
- **Repo picker** — auto-discovers git repos from configurable scan directories.

### 📊 Session Analytics

Accessible at `/analytics`. Shows aggregate stats across all sessions:

- Total sessions, total turns, total tool calls, total completions, total errors.
- Per-session breakdown table.

### 📋 Activity Reports

Accessible at `/reports`. Generates weekly and monthly rollup reports:

- Sessions started, turns, tool calls, completions, errors per time period.
- Persisted as JSON in `~/.copilot/activity/reports/` for historical reference.

### 📂 Repo Opener

A dropdown in the header bar lets you quickly open any discovered repo in VS Code or Visual Studio.

### 🖥️ Screen Blank + Intrusion Detection (security/privacy)

- **Screen blank** — blacks out all monitors (click/key/mouse to dismiss). Useful when you step away.
- **Lock countdown** — after the blank is dismissed (someone touched your machine), a 3-second countdown starts before `LockWorkStation` fires. Cancel button in the dashboard UI.
- **Webcam capture** — on dismiss, captures a photo via webcam (requires Python + OpenCV) and saves to `~/.copilot/intrusion-photos/`.
- **Intrusion alert banner** — the dashboard shows a red flashing alert with the captured photo if someone triggered the blank while you were away.

## Installation

The extension is a single `extension.mjs` file with no build step or `npm install`.

### Prerequisites

- **GitHub Copilot CLI** installed and signed in (this is what loads the extension)
- **Git** on `PATH` (used for repo discovery and worktree creation)
- **[GitHub CLI (`gh`)](https://cli.github.com/)** signed in (`gh auth login`) — used by the todos page to call the Copilot LLM for parsing your brain-dump
- **Windows Terminal (`wt`)** on `PATH` — required for any feature that opens a new terminal tab (Resume, Restore Workspace, Todos 🚀 launcher). Comes built-in on Windows 11; install from the Microsoft Store on Windows 10.

### Clone into the extensions directory

The extension must live in `<USER_PROFILE>/.copilot/extensions/session-dashboard`.

**Windows (PowerShell):**

```powershell
git clone https://github.com/fernandesi2244/copilot-cli-session-dashboard.git `
  "$env:USERPROFILE\.copilot\extensions\session-dashboard"
```

**macOS / Linux (bash):**

```bash
git clone https://github.com/fernandesi2244/copilot-cli-session-dashboard.git \
  ~/.copilot/extensions/session-dashboard
```

### Start it

The Copilot CLI auto-discovers extensions in `~/.copilot/extensions/` on next startup — no registration needed. Just launch Copilot CLI as usual:

```
copilot
```

On startup the extension picks a random free port and writes it to `~/.copilot/session-dashboard-port`. Open it in a browser:

```powershell
# Windows
Start-Process ("http://127.0.0.1:" + (Get-Content $HOME\.copilot\session-dashboard-port))
```

```bash
# macOS / Linux
open "http://127.0.0.1:$(cat ~/.copilot/session-dashboard-port)"   # macOS
xdg-open "http://127.0.0.1:$(cat ~/.copilot/session-dashboard-port)" # Linux
```

### Updating

The repo is just a git clone, so updating is a `git pull`:

```powershell
cd "$env:USERPROFILE\.copilot\extensions\session-dashboard"
git pull
```

You must then restart any running Copilot CLI host — the extension does not hot-reload.

## Configuration

Everything works out of the box, but you can tune two things:

### User alias (branch prefix)

Every branch the todos launcher creates is prefixed with your alias. Resolution order:

1. `COPILOT_DASHBOARD_USER_ALIAS` env var
2. `userAlias` in `~/.copilot/session-dashboard-config.json`
3. Local part of `git config --global user.email`
4. Literal `"user"`

### Copilot CLI command (for non-standard installs)

The dashboard launches new terminal tabs with `copilot --resume=<id>`. If your Copilot CLI is invoked via a wrapper (e.g. `agency copilot` on internal Microsoft builds), override the command:

1. `COPILOT_DASHBOARD_CLI_COMMAND` env var, **or**
2. `copilotCommand` in `~/.copilot/session-dashboard-config.json`

### Repo scan directories

The dashboard auto-discovers git repos in these directories so you can pick one in the todos UI. Defaults (each only used if it exists):

- `~/source/repos`
- `~/source`
- `~/Documents`
- `~/code`
- `~/projects`
- `~/git`

Extend via either:

- `COPILOT_DASHBOARD_REPO_DIRS` env var (`;` or `,` separated)
- `repoScanDirs: ["C:\\\\path\\\\one", "/home/me/other"]` in `~/.copilot/session-dashboard-config.json`

### Config file example

`~/.copilot/session-dashboard-config.json`:

```json
{
  "userAlias": "jane",
  "copilotCommand": "copilot",
  "repoScanDirs": ["D:\\\\repos", "C:\\\\work"]
}
```

## Files written

| Path | Purpose |
|---|---|
| `~/.copilot/session-dashboard-port` | Current HTTP port (overwritten on each start) |
| `~/.copilot/session-dashboard-notes.json` | Per-session notes |
| `~/.copilot/session-dashboard-todos.json` | Todos data |
| `~/.copilot/session-dashboard-config.json` | Optional user config |
| `~/.copilot/saved-workspace.json` | Auto-saved workspace state |
| `~/.copilot/activity/reports/` | Weekly/monthly report JSON |

## Platform notes

- **Windows:** Fully supported. Uses Windows Terminal (`wt`) for tab launching and PowerShell for screen-lock / focus helpers.
- **macOS / Linux:** The HTTP dashboard and most monitoring features will work, but anything that shells out to `wt` or PowerShell will be a no-op or fail. Pull requests adding cross-platform terminal-launch backends are welcome.
- **Intrusion detection:** Requires Python 3 (`py` on PATH) and OpenCV (`pip install opencv-python`) for webcam capture. If unavailable, everything else still works — you just won't get the photo.

## Development

The dashboard does **not** hot-reload. After editing `extension.mjs` you must restart your Copilot CLI host process. The chosen port also changes on every restart, so re-read `~/.copilot/session-dashboard-port` after restarting.

See [`AGENTS.md`](./AGENTS.md) for instructions to AI assistants contributing to this code.

## License

MIT — see [LICENSE](./LICENSE).
