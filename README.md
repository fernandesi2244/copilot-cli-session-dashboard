# Copilot CLI Session Dashboard

A single-file [GitHub Copilot CLI extension](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) that runs a local web dashboard for monitoring and managing all your concurrent Copilot CLI sessions.

> ⚠️ **Status:** Personal project, shared in case it's useful. Windows-first (uses Windows Terminal `wt` for tab launching and PowerShell for some helpers). PRs to broaden platform support are welcome.

## What it does

When loaded as a Copilot CLI extension, the dashboard starts a small HTTP server on `127.0.0.1:<random port>` and gives you:

- **Live multi-session view** — every running and recent CLI session, with status, turn count, tool calls, errors, and last activity.
- **Resume / re-open** — one click opens a new Windows Terminal tab and resumes a session by id.
- **Per-session notes** — free-form notes pinned to a session id, persisted across restarts.
- **Workspace save/restore** — snapshot the set of open sessions and re-open them later. The 📜 button browses all rolling backups (`.1`–`.10`) and lets you promote any snapshot back to active.
- **Todos with AI parsing + worktree launcher** — paste a brain-dump, let an LLM organize it into categorized todos, then click 🚀 on any todo to:
  1. Create a sibling `git worktree` for the repo on a `<alias>/<slug>` branch
  2. Drop a `.copilot-todo.md` context file into it
  3. Open a new terminal tab running `copilot` in that worktree
- **Activity reports** — weekly / monthly rollups of sessions, tool calls, completions.

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

## Development

The dashboard does **not** hot-reload. After editing `extension.mjs` you must restart your Copilot CLI host process. The chosen port also changes on every restart, so re-read `~/.copilot/session-dashboard-port` after restarting.

See [`AGENTS.md`](./AGENTS.md) for instructions to AI assistants contributing to this code.

## License

MIT — see [LICENSE](./LICENSE).
