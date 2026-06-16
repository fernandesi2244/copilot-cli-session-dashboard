# Session Dashboard — Agent Instructions

This file is read by AI assistants working on the session-dashboard extension.

## Mandatory behavior

### Always report the dashboard port and freshness after any edit

After making **any** change to `extension.mjs`, the assistant **must** include in its reply:

1. The current dashboard port (from `~/.copilot/session-dashboard-port`)
2. Whether the running process is up-to-date relative to the file mtime (so the user knows if a restart is needed)
3. The URL to the relevant page (e.g., `http://127.0.0.1:<port>/todos`)

PowerShell snippet to gather this on Windows:

```powershell
$port = Get-Content $HOME\.copilot\session-dashboard-port
$conn = Get-NetTCPConnection -LocalPort $port -EA SilentlyContinue | ? State -eq Listen | Select -First 1
$p = if ($conn) { Get-Process -Id $conn.OwningProcess -EA SilentlyContinue }
$fileMtime = (Get-Item $HOME\.copilot\extensions\session-dashboard\extension.mjs).LastWriteTime
"Port: $port; PID: $($conn.OwningProcess); proc started: $($p.StartTime); file modified: $fileMtime"
```

Format the answer like:

> **Dashboard:** http://127.0.0.1:<PORT> — process started <TIME>, file last modified <TIME>. **Restart required: YES/NO.**

The port file changes every time the dashboard restarts, so always re-read it; don't reuse a stale value from earlier in the conversation.

### Restart implications

The dashboard does NOT hot-reload `extension.mjs`. Any code change requires the user to restart the host Copilot CLI session. Always remind the user to restart, and note the port will change.

### LLM model fallback chain

These models are typically accessible via `https://api.githubcopilot.com/chat/completions` with `gh auth token`. Availability varies by account/subscription — verify with a quick request before relying on a new model:

- `gpt-4.1` — fast (~1s), reliable, supports `response_format: json_object`
- `gpt-4o-mini` — fast (~1.5s), supports JSON mode
- `claude-haiku-4.5` — fast (~1.5s)
- `claude-sonnet-4.6` — slower, can timeout on large outputs

Default model for the todos parser: **`gpt-4.1`**. Fallback chain: `gpt-4.1 → gpt-4o-mini → claude-haiku-4.5 → claude-sonnet-4.6`.

Some models may be inaccessible per-account (HTTP 403 / 400). If a model fails consistently with `not accessible via /chat/completions` or similar, drop it from the chain rather than retrying.

### Branch naming convention

All branches the dashboard creates are prefixed with the resolved `USER_ALIAS`. Resolution order (first non-empty wins):

1. `COPILOT_DASHBOARD_USER_ALIAS` environment variable
2. `userAlias` field in `~/.copilot/session-dashboard-config.json`
3. Local part of `git config --global user.email`
4. Literal `"user"`

### Copilot CLI command override

New tabs are launched with `${COPILOT_CMD} --resume=<id>`. `COPILOT_CMD` resolves from (in order):

1. `COPILOT_DASHBOARD_CLI_COMMAND` env var
2. `copilotCommand` field in `~/.copilot/session-dashboard-config.json`
3. Literal `"copilot"`

Do **not** hard-code `agency copilot` or any internal wrapper — that breaks external users.

### Files written by the extension

- `~/.copilot/session-dashboard-port` — current dashboard HTTP port
- `~/.copilot/session-dashboard-notes.json` — per-session notes
- `~/.copilot/session-dashboard-todos.json` — todos data
- `~/.copilot/session-dashboard-config.json` — optional user config (`userAlias`, `repoScanDirs`)
- `~/.copilot/saved-workspace.json` — auto-saved workspace state
- `~/.copilot/activity/reports/` — weekly/monthly report JSON

### Event types in `~/.copilot/session-state/<id>/events.jsonl`

Modern type names (use these, NOT the old `assistant_response` etc.):

- `assistant.turn_end` — counted as a turn
- `tool.execution_start` — counted as a tool call
- `session.task_complete` — counted as a completion
- `session.error` — counted as an error
