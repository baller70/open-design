# Open Design WebUI

Cross-platform, terminal-launched Open Design web runtime (no Electron).

## Prerequisites
- Node.js 24+ installed (`node --version`).

## Start / stop
- macOS/Linux: `./open-design.sh start`, stop with `./open-design.sh stop`
- Windows: `open-design.cmd start`, stop with `open-design.cmd stop`
- Double-click: macOS `Open Design WebUI.command`, Windows `Open Design WebUI.bat`, Linux `open-design-webui.desktop`

`start` **runs in the background by default**: it prints the access URL and returns; closing the terminal or pressing Ctrl+C does not stop the service — use `stop` to stop it. To run in the foreground instead (systemd / Docker / debugging, Ctrl+C to stop), pass `--foreground`. The browser opens automatically when a display is detected; on a headless machine (server) it only prints the URL.

Startup output is localized: it follows the system `LANG`/`LC_*` by default, and can be forced with `--lang en|zh-CN` or the config file's `lang` key.

## Architecture: why there is only one address
This distribution is two processes (web + daemon), but you only need the **web address** — the one printed in the terminal. `/api` is not a separate port: the web server **reverse-proxies** `/api/*` to the internal daemon, so the browser/UI uses the same address and needs **no token**. The token is only for **programmatic, direct access to the daemon API**. The startup output explains these three points.

The daemon listens on a fixed port `7457` by default (paired with web's `7456`, stable across restarts), bound to the same host as web; you only need its address if you call the daemon API directly.

## Configuration (precedence: CLI flags > webui.config.json > environment > defaults)
- `--port <N>` (default 7456): browser-facing web port
- `--daemon-port <N>` (default 7457): daemon listen port; `0` switches to a random loopback port
- `--host <ADDR>` (default 127.0.0.1; use `0.0.0.0` to enable remote access — the startup output then shows the reachable LAN IP)
- `--token <T>`: protect **direct** daemon `/api` access (programmatic clients send `Authorization: Bearer <T>`); on a remote host with no token set, one is generated and written back to `webui.config.json`, then reused across restarts
- `--no-open`: do not open the browser automatically
- `--foreground`: run in the foreground (background is the default), Ctrl+C to stop
- `--lang <en|zh-CN>`: startup output language (defaults to the system locale)
- `--config <PATH>`: use a specific config file (it must already exist — only the default `webui.config.json` is auto-created; a missing explicit path is a hard error so `start`/`stop`/`status` never silently fall back to the default instance)

**The first `start` auto-creates `webui.config.json` next to the scripts** (seeded from the field values in `webui.config.example.json`, with the example's `//`-prefixed documentation keys stripped, so the generated file is pure data with no comments; if no example is present, built-in defaults are written); an existing file is never overwritten. Edit it to persist configuration. Every config key is documented inline in `webui.config.example.json`: `port` (web port), `daemonPort` (daemon port, `0` = random loopback), `host`, `token`, `openBrowser`, `lang` (startup output language), plus two optional keys `namespace` (runtime namespace, for isolating multiple instances) and `dataDir` (override the data directory, equivalent to `OD_DATA_DIR`).

## Security note
When remote access is enabled (`host=0.0.0.0`), the token only protects programmatic clients of the direct daemon API; **the Web UI itself has no application-layer authentication**. To protect a remote Web UI, put a reverse proxy in front (nginx/caddy basic-auth) or use a VPN / network isolation.
