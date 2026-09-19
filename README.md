# Azure Cursor Bridge

Cross-platform desktop app (Windows / macOS / Linux) that routes Cursor and Codex requests to your Azure deployments:

## Download

Grab the latest installer from the [Releases page](https://github.com/michaelegbo/azure-cursor-bridge/releases):

- **Windows**: `Azure-Cursor-Bridge-<version>-win-x64.exe`
- **macOS**: `Azure-Cursor-Bridge-<version>-mac-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel) — unsigned: right-click → Open on first launch
- **Linux**: `Azure-Cursor-Bridge-<version>-linux-x86_64.AppImage` (`chmod +x` and run) or the `.deb`

On first launch a setup wizard asks for your Azure endpoint and API key — that's all the configuration needed.

- `azure-astra`: `gpt-6-astra`, using Azure Responses.
- `azure-opus`: `claude-opus-5`, using Azure Anthropic Messages.

Everything ships in one installer: the desktop app, the proxy backend (runs on Electron's bundled Node — no separate Node installation), an embedded SQLite database (`node:sqlite` — no separate database installation), and a bundled `cloudflared` for the public tunnel.

The bridge accepts Chat Completions and stateless Responses requests, including streaming, image inputs, tool calls and tool results. It does not run tools itself; the client executes tools. Unknown models fail closed; no fallback billing.

## Architecture

- `electron/` — desktop app: UI, lifecycle (`runtime.mjs`), secrets (`secrets.mjs` via Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret on Linux).
- `src/` — the proxy server. Runs as a child of the app via `ELECTRON_RUN_AS_NODE`; the Azure key is injected through the environment and never stored by the server.
- `src/db.mjs` — embedded SQLite (WAL) holding requests, request breakdowns, guest keys, usage totals, and settings. Older JSON state files are imported automatically on first run and left untouched.
- State directory: `%LOCALAPPDATA%\CodexCursorProxy` (Windows), `~/Library/Application Support/CodexCursorProxy` (macOS), `~/.config/CodexCursorProxy` (Linux).

## Features

- Permanent public URL via a named Cloudflare tunnel (falls back to a random trycloudflare quick tunnel when no named tunnel is configured).
- Owner key plus guest API keys with expiry, on/off, reset, delete — enforced on the next request.
- Versioned Azure upstream key: reveal, test against Azure, replace, revert to any version.
- Per-request breakdowns (scaffolding vs conversation, cache hits) with AI analysis.
- Usage totals and cost estimation from your own Azure rates.
- Reasoning effort: per-model defaults in the app, client-sent settings honored, and effort-suffixed model aliases (`azure-astra-high`, `azure-opus-max`, …).

## Build

```
npm ci
npm test
npm run vendor        # downloads cloudflared for this platform
npm run dist:win      # or dist:mac / dist:linux (run on that OS)
```

CI: `.github/workflows/build.yml` builds all three platforms (tag a release `v*` or run manually) and uploads the installers as artifacts. macOS artifacts are unsigned — right-click → Open on first launch.

## First run on a new machine

1. Install and launch; a fresh owner key and local config are generated.
2. Under **Azure upstream key**, save your Azure resource endpoint and paste your Azure API key.
3. Copy the base URL and bridge key into Cursor (OpenAI override) or Codex (`model_providers` + `AZURE_CURSOR_BRIDGE_API_KEY`).

Full conversation history must be supplied; `previous_response_id` is rejected. The newest 500 request records and 60 breakdowns are retained in the local database.
