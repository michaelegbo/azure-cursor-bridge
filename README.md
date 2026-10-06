# Azure Cursor Bridge

Cross-platform desktop app (Windows / macOS / Linux) that routes Cursor and Codex requests to your Azure deployments:

## Download

Grab the latest installer from the [Releases page](https://github.com/michaelegbo/azure-cursor-bridge/releases):

- **Windows**: `Azure-Cursor-Bridge-<version>-win-x64.exe`
- **macOS**: `Azure-Cursor-Bridge-<version>-mac-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel) — unsigned: right-click → Open on first launch
- **Linux**: `Azure-Cursor-Bridge-<version>-linux-x86_64.AppImage` (`chmod +x` and run) or the `.deb`

On first launch a setup wizard asks for your Azure endpoint and API key. Azure is optional: skip the wizard and the Claude and ChatGPT models work with just a Claude or ChatGPT login, and a public URL is set up automatically.

Models out of the box:

- `azure-astra` / `azure-sol` / `azure-opus`: your Azure deployments `gpt-6-astra`, `gpt-6-sol` (Responses) and `claude-opus-5` (Anthropic Messages).
- `bridge-claude-fable` / `-opus` / `-sonnet` / `-haiku`: your Claude subscription through the Claude Code CLI.
- `bridge-chatgpt-astra` / `-sol` / `-luna` / `-5-6-sol` / `-5-6-terra` / `-5-6-luna` / `-5-5`: your ChatGPT plan through the Codex CLI (owner key only).
- Any other Azure deployment you add under **Azure and custom models**.

Everything ships in one installer: the desktop app, the proxy backend (runs on Electron's bundled Node — no separate Node installation), an embedded SQLite database (`node:sqlite` — no separate database installation), and a bundled `cloudflared` for the public tunnel.

The bridge accepts Chat Completions and stateless Responses requests, including streaming, image inputs, tool calls and tool results. It does not run tools itself; the client executes tools. Unknown models fail closed; no fallback billing.

## Architecture

- `electron/` — desktop app: UI, lifecycle (`runtime.mjs`), secrets (`secrets.mjs` via Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret on Linux).
- `src/` — the proxy server. Runs as a child of the app via `ELECTRON_RUN_AS_NODE`; the Azure key is injected through the environment and never stored by the server.
- `src/db.mjs` — embedded SQLite (WAL) holding requests, request breakdowns, guest keys, usage totals, and settings. Older JSON state files are imported automatically on first run and left untouched.
- State directory: `%LOCALAPPDATA%\CodexCursorProxy` (Windows), `~/Library/Application Support/CodexCursorProxy` (macOS), `~/.config/CodexCursorProxy` (Linux).

## Features

- Public URL via Cloudflare, configured in **Settings → Public URL**: your own Cloudflare tunnel (permanent hostname; paste its hostname and token), a temporary trycloudflare URL (no account needed — the default when no tunnel is set up, and the fallback if yours fails), or off (local only).
- **Settings** page: local port, start at sign-in (Windows/macOS), Claude/Codex CLI locations (auto-detected), the model that analyzes requests, how much request history to keep, and the local database — location, size, and clear/reset-to-defaults for each part (history, usage, preferences, models, guest keys, saved accounts, Azure keys, Cloudflare tunnel).
- Claude and ChatGPT plans: see the exact signed-in account and plan, sign in to another plan once (e.g. personal next to Team) and switch between them from a single list; extra plans never sign Claude Code or the Codex app out.
- **Bloat remover** (Settings): off / small / medium / high / aggressive / deep. Trims old tool output and history that clients resend every turn; deep also summarizes the early conversation with a model you choose (cached per block). Never touches the system prompt, tool definitions or the newest turns.
- Owner key plus guest API keys with expiry, on/off, reset, delete — enforced on the next request.
- Versioned Azure upstream key: reveal, test against Azure, replace, revert to any version.
- Per-request breakdowns (scaffolding vs conversation, cache hits) with AI analysis.
- Usage totals and cost estimation from your own Azure rates.
- Reasoning effort: per-model defaults in the app, client-sent settings honored, and effort-suffixed model aliases (`azure-astra-high`, `azure-sol-high`, `azure-opus-max`, …).
- **Codex model source** switch (Windows): turn it on to use every configured bridge model in local Codex, or off to restore the prior OpenAI model settings. The app writes a local-only provider and model catalog, reads the existing owner key through a short-lived PowerShell auth command, and restarts Codex. Switching interrupts active Codex tasks; a conflict with manually changed Codex settings stops restoration instead of overwriting those changes. Cloud Codex tasks cannot call a bridge on this computer through localhost.

## Build

```
npm ci
npm test
npm run vendor        # downloads cloudflared for this platform
npm run dist:win      # or dist:mac / dist:linux (run on that OS)
```

CI: `.github/workflows/build.yml` builds all three platforms (tag a release `v*` or run manually) and uploads the installers as artifacts. macOS artifacts are unsigned — right-click → Open on first launch.

## First run on a new machine

1. Install and launch; a fresh owner key and local config are generated and the bridge starts with a temporary public URL.
2. Optional: in the wizard (or **Azure**), save your Azure resource endpoint and API key. For Claude or ChatGPT models, log in under **Overview → Claude account / ChatGPT account** (needs the Claude Code CLI or the Codex app installed).
3. Optional: for a permanent URL, create a Cloudflare tunnel and enter its hostname and token in **Settings → Public URL** (the page explains the steps).
4. Copy the base URL and bridge key into Cursor (OpenAI override) or Codex (`model_providers` + `AZURE_CURSOR_BRIDGE_API_KEY`).

Full conversation history must be supplied; `previous_response_id` is rejected. The newest 500 request records and 60 breakdowns are kept by default (configurable under **Settings → Local database**).
