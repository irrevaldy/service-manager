# Service Manager

A local development dashboard for running, stopping, and monitoring microservices and frontend apps from a single browser UI. Services run inside VS Code integrated terminal tabs and their status is reflected in real-time in the dashboard.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [File Structure](#file-structure)
4. [Getting Started](#getting-started)
5. [Dashboard Usage](#dashboard-usage)
6. [VS Code Integration](#vs-code-integration)
7. [Service Configuration](#service-configuration)
8. [HTTP API Reference](#http-api-reference)
9. [WebSocket Protocol](#websocket-protocol)
10. [Process Management](#process-management)
11. [Port Health Checker](#port-health-checker)
12. [Adding or Modifying Services](#adding-or-modifying-services)
13. [Troubleshooting](#troubleshooting)

---

## Overview

| | |
|---|---|
| Dashboard URL | `http://localhost:9999` |
| VS Code bridge port | `9998` (localhost only) |
| Start command | `node server.js` inside `service-manager/` |

**How it works in one sentence:** clicking **Start** in the dashboard either opens a VS Code terminal tab that runs the service (when VS Code is open), or spawns a child process directly (fallback) — either way the dashboard shows live status, logs, and uptime.

---

## Architecture

```
Browser (http://localhost:9999)
        │  WebSocket (ws://localhost:9999)
        ▼
┌─────────────────────────────────┐
│         server.js               │  Express HTTP + WebSocket server
│  - serves public/index.html     │
│  - /api/services                │
│  - /api/vscode-status           │
│  - /api/vscode-event  (POST)    │  ◄── receives events from VS Code extension
│  - /api/focus-terminal (POST)   │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│       process-manager.js        │  Core logic
│                                 │
│  Two operating modes per svc:   │
│  ┌──────────┐  ┌─────────────┐  │
│  │ VS Code  │  │    Spawn    │  │
│  │  mode    │  │    mode     │  │
│  └────┬─────┘  └──────┬──────┘  │
│       │               │         │
│  calls VS Code    child_process  │
│  extension HTTP   .spawn()      │
│  → terminal runs  → captures    │
│    the service      stdout/err  │
│                                 │
│  Port health checker (4s poll)  │  ◄── detects externally-started services
└─────────────────────────────────┘
              │  HTTP (127.0.0.1:9998)
              ▼
┌─────────────────────────────────┐
│   VS Code Extension             │  ~/.vscode/extensions/local.service-manager-0.0.1/
│   (local.service-manager)       │
│                                 │
│  - HTTP server on port 9998     │
│  - createTerminal({ name, cwd })│
│  - sendText(cmd)                │
│  - captures onDidWriteTerminal  │  → POSTs log batches to /api/vscode-event
│  - onDidCloseTerminal           │  → POSTs terminal_closed to /api/vscode-event
└─────────────────────────────────┘
              │
              ▼
     VS Code Integrated Terminal
     (one tab per service, named)
```

### Status flow

```
User clicks Start
       │
       ├─ live probe 127.0.0.1:9998
       │
       ├─ VS Code available? ──YES──► extension opens terminal tab
       │                              tab runs: npm run dev (or serve/start)
       │                              port health checker polls every 4s
       │                              port responds ──► status = Running
       │
       └─ VS Code NOT available? ──► spawn child process (detached process group)
                                     proc.on('spawn') ──► status = Running
                                     proc.on('close') ──► status = Stopped / Error
```

### Stop flow

```
User clicks Stop
       │
       ├─ mode = vscode/external?
       │    ├─ POST /terminal/stop → extension sends Ctrl+C (×2, 400ms apart)
       │    ├─ after 4s: if port still open → lsof | kill -9
       │    └─ after 8s: force status = stopped (safety timeout)
       │
       └─ mode = spawn?
            ├─ process.kill(-pgid, 'SIGTERM')  [kills entire process group]
            ├─ after 5s: process.kill(-pgid, 'SIGKILL')
            └─ after 8s: force status = stopped (safety timeout)
```

---

## File Structure

```
service-manager/
├── server.js              # Express + WebSocket server (port 9999)
├── process-manager.js     # Process spawning, VS Code IPC, port polling
├── services.config.js     # Auto-discovers services from the parent directory
├── package.json
├── public/
│   └── index.html         # Single-page dashboard (Tailwind CSS, vanilla JS)
├── vscode-extension/
│   ├── package.json       # VS Code extension manifest
│   └── extension.js       # Bridge HTTP server + terminal management
└── README.md              # This file

~/.vscode/extensions/
└── local.service-manager-0.0.1 -> <path-to>/service-manager/vscode-extension/
    (symlink — see VS Code extension setup below)
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- VS Code (optional but recommended — enables terminal integration)
- All your service repos checked out as siblings of `service-manager/` in the same parent directory

### Run the dashboard

```bash
cd /path/to/service-manager
npm install
node server.js
```

Open `http://localhost:9999` in your browser.

### VS Code extension (first-time setup)

The extension lives inside `service-manager/vscode-extension/`. Install it by creating a symlink:

```bash
ln -s /absolute/path/to/service-manager/vscode-extension \
      ~/.vscode/extensions/local.service-manager-0.0.1
```

Then reload VS Code (`⌘⇧P` → **Developer: Reload Window**). The extension activates automatically on startup.

**Verify it is running:**
```bash
curl http://127.0.0.1:9998/status
# expected: {"ok":true,"terminals":[...]}
```

If the request fails, reload the VS Code window: `⌘⇧P` → **Developer: Reload Window**.

**If it is still not working after a reload**, the extension may have been flagged as obsolete by VS Code. Fix it:
```bash
echo '{}' > ~/.vscode/extensions/.obsolete
```
Then reload VS Code again.

---

## Dashboard Usage

### Service cards

Each card shows:

| Element | Meaning |
|---|---|
| **Green pulsing dot** | Service is running |
| **Yellow pulsing dot** | Starting or stopping |
| **Red dot** | Exited with non-zero code |
| **Grey dot** | Stopped |
| `:3001` (blue) | Listening port |
| `↑ 2h 15m` | Uptime since last start |
| `via VS Code` pill (blue) | Running inside a VS Code terminal tab |
| `external` pill (amber) | Running but not started by SSM (detected via port) |

### Buttons

| Button | Action |
|---|---|
| **Start** | Start the service |
| **Stop** | Stop the service |
| **↺** | Restart (stop then start) |
| **⎋** | Focus the service's terminal tab in VS Code |
| **≡** | Open the log panel for this service |

### Global controls

| Control | Action |
|---|---|
| **Start All** | Start all stopped/errored services in the current filter |
| **Stop All** | Stop all running services in the current filter (with confirmation) |
| Filter tabs | Show only services of a given type (API / B2B / Analytics / Workers / Frontend) |

### Log panel

Click **≡** on any card to open a bottom log panel. Logs are buffered (last 800 lines). When VS Code mode is active the logs are forwarded from the terminal via `onDidWriteTerminalData`. In spawn mode they are captured directly from `stdout`/`stderr`. The **Open in VS Code** button inside the log panel focuses the service's terminal tab.

---

## VS Code Integration

### How it works

The VS Code extension (`local.service-manager`) runs a local HTTP server on `127.0.0.1:9998`. When the dashboard's **Start** button is clicked, the service manager probes port 9998 first:

- **Extension reachable** → service manager calls `POST /terminal/open`. The extension creates a named terminal tab with `cwd` set to the service directory and runs the service's start command. Logs flow back via `onDidWriteTerminalData`.
- **Extension not reachable** → service manager falls back to `child_process.spawn`. Full stdout/stderr capture in the log panel.

### External start detection

If you manually run a service inside a VS Code terminal (or any other way), the port health checker detects that the port became active and sets the service status to **Running (external)** in the dashboard automatically.

### Extension endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/status` | — | Health check + list of open terminal IDs |
| POST | `/terminal/open` | `{ id, name, cwd, cmd }` | Create or focus a named terminal |
| POST | `/terminal/stop` | `{ id }` | Send Ctrl+C (×2) to the terminal |
| POST | `/terminal/focus` | `{ id }` | Bring the terminal tab to focus |

### Events the extension pushes to the service manager (`POST /api/vscode-event`)

| `type` | Additional fields | Meaning |
|---|---|---|
| `terminal_closed` | `id` | Terminal tab was manually closed |
| `cmd_started` | `id`, `cmd` | Shell integration detected a command started |
| `cmd_ended` | `id`, `exitCode` | Command finished |
| `logs` | `id`, `lines: string[]` | Batched terminal output (every 400 ms) |

---

## Service Configuration

Services are **auto-discovered** from sibling directories at startup. Any folder in the parent directory that contains a `package.json` with a runnable script (`dev`, `serve`, or `start`) is included automatically.

### Type inference

| Folder pattern | Type assigned |
|---|---|
| ends with `workers` | `worker` |
| starts with `analytics-` | `analytics` |
| ends with `-web` or `-admin` | `frontend` |
| starts with `soco-` | `frontend` |
| starts with `b2b-` | `b2b` |
| everything else | `api` |

### Port detection (in priority order)

1. `vite.config.js` / `vite.config.ts` → `server.port`
2. `--port` flag in any `package.json` script
3. `.ssm.json` override file (see below)

### Per-project overrides (`.ssm.json`)

Place a `.ssm.json` file in any project folder to override auto-detected values:

```json
{ "port": 3001, "name": "My Service", "type": "api" }
```

Supported keys: `port`, `name`, `type`, `cmd`, `args`, `note`

Use `.ssm.json` to set ports for services that don't use Vite and don't have a `--port` flag in their npm scripts.

### Service object shape

```json
{
  "id": "my-service",
  "name": "My Service",
  "type": "api",
  "port": 3001,
  "status": "running",
  "mode": "vscode",
  "pid": 12345,
  "uptime": 7320000,
  "exitCode": null,
  "errorMsg": null,
  "note": null
}
```

**`status`** values: `stopped` | `starting` | `running` | `stopping` | `error`

**`mode`** values:
- `spawn` — managed by SSM's child process
- `vscode` — running inside a VS Code terminal tab opened by SSM
- `external` — detected running via port health check (started outside SSM)

---

## HTTP API Reference

Base URL: `http://localhost:9999`

| Method | Path | Description |
|---|---|---|
| GET | `/api/services` | Returns full state of all discovered services as JSON array |
| GET | `/api/vscode-status` | Returns `{ connected: boolean }` |
| POST | `/api/vscode-event` | Receives events pushed by the VS Code extension |
| POST | `/api/focus-terminal` | Body: `{ id }` — tells extension to focus that terminal |
| GET | `/api/workers/:id/scripts` | Lists runnable scripts inside a worker service's subdirectories |

---

## WebSocket Protocol

Connect to `ws://localhost:9999`. All messages are JSON.

### Server → Client messages

| `type` | Fields | When sent |
|---|---|---|
| `init` | `data: Service[]`, `vscodeConnected: boolean` | Immediately on connect |
| `status` | `id`, `data: Service` | Any time a service's status changes |
| `vscode_status` | `connected: boolean` | VS Code bridge connects or disconnects |
| `uptime_tick` | `data: [{ id, uptime }]` | Every 5 seconds for running services |
| `log_history` | `id`, `lines: LogEntry[]` | After client subscribes to a service's logs |
| `log` | `id`, `text`, `level`, `ts` | Each new log line for subscribed services |
| `worker_stopped` | `workerId`, `termId` | A worker script terminal was closed |

### Client → Server messages

| `type` | Fields | Action |
|---|---|---|
| `start` | `id` | Start the service |
| `stop` | `id` | Stop the service |
| `restart` | `id` | Restart the service |
| `focus_terminal` | `id` | Focus VS Code terminal tab |
| `subscribe_logs` | `id` | Start receiving log events for this service |
| `unsubscribe_logs` | `id` | Stop receiving log events |
| `run_worker_script` | `id`, `folder`, `script` | Run a worker script in a VS Code terminal |
| `stop_worker` | `termId` | Stop a running worker terminal |

---

## Process Management

### Spawn mode (VS Code not connected)

Uses `child_process.spawn` with `detached: true`. The `detached` flag creates a new OS process group, which is critical for `npm run dev` because:

```
npm (our spawned process, group leader)
 └── sh -c nodemon server.js
      └── nodemon
           └── node server.js
```

When only `npm` is killed (without `detached: true`), `nodemon` and `node` become orphans that hold the pipe file descriptors open, so the `close` event on the ChildProcess never fires — status stays stuck as `stopping` forever.

With `detached: true`, stopping sends `process.kill(-pgid, 'SIGTERM')` which delivers SIGTERM to every process in the group simultaneously. All three exit, pipes close, `close` event fires normally.

### VS Code mode

The service runs entirely inside a VS Code terminal. The service manager never spawns a child process. Status is tracked via:
1. Port health check (4-second poll) — detects when the service is up or down
2. Terminal close events from the extension — immediate notification when the terminal is closed
3. Shell integration events (`onDidEndTerminalShellExecution`) — exit code reporting

### Log capture

| Mode | Log source |
|---|---|
| Spawn | `proc.stdout` / `proc.stderr` piped directly |
| VS Code | `vscode.window.onDidWriteTerminalData` → ANSI-stripped → batched every 400 ms → POSTed to `/api/vscode-event` |
| External | No log capture (service wasn't started by SSM) |

Up to **800 lines** are kept in memory per service. Logs are replayed to new subscribers via the `log_history` WebSocket message.

---

## Port Health Checker

Runs every **4 seconds** and checks each service's configured port with a 1.2-second TCP connect timeout.

| Condition | Action |
|---|---|
| Port responds and status is `stopped` | Mark as `running (external)` — detected a manually-started service |
| Port stops responding and mode is `external` | Mark as `stopped` — externally-started service went down |
| Port responds and status is `starting` or `error` | Mark as `running` — service finished booting |

> **Vite on macOS:** Vite defaults to binding on IPv6 (`::1`). The port checker connects to `127.0.0.1` (IPv4), so it will miss the service unless you add `host: '0.0.0.0'` to `server` in `vite.config.js`.

---

## Adding or Modifying Services

Services are discovered automatically — just create a sibling directory with a `package.json` containing a `dev`, `serve`, or `start` script. No changes to `service-manager` are needed.

To customize a service's name, port, type, or start command without changing its `package.json`, add a `.ssm.json` file to its root:

```json
{
  "port": 3200,
  "name": "My Custom Name",
  "type": "api",
  "cmd": "npm",
  "args": ["run", "start:local"]
}
```

The service manager must be **restarted** (`node server.js`) for discovery changes to take effect.

---

## Troubleshooting

### VS Code badge shows "disconnected"

The VS Code extension bridge is not running. Check:
1. Is VS Code open?
2. Run `curl http://127.0.0.1:9998/status` in terminal
3. If no response, reload VS Code window: `⌘⇧P` → **Developer: Reload Window**
4. If still failing, run: `echo '{}' > ~/.vscode/extensions/.obsolete` then reload again

### Service stuck in "Starting"

SSM has a 60-second watchdog on the `starting` state. If the service never confirms (port doesn't respond / VS Code mode), SSM transitions it to `error` automatically with the message *"Start timed out after 60s"*. Open the log panel to see what went wrong.

Common causes:
- **Service binds to IPv6 only (Vite on macOS)** — add `host: '0.0.0.0'` to `server` in `vite.config.js` so the TCP health check can reach it on `127.0.0.1`.
- **Wrong port configured** — verify the port in `.ssm.json` or `vite.config.js` matches what the service actually listens on.
- **TypeScript compilation error** — check the VS Code terminal for compile errors.

### Service stuck in "Stopping"

The 8-second safety timeout will force the status to `stopped` automatically. If it happens repeatedly:
- The service may be ignoring SIGTERM. Stop it manually in the VS Code terminal with `Ctrl+C`.
- Check if something else is holding the port open: `lsof -i :PORT`

### Service shows "Error (code: 1)" immediately after start

The start script failed. Check the log panel (click **≡**) for the actual error. Common causes:
- Missing `.env` file
- Database / cache not reachable
- Port already in use from a previous run: `lsof -ti :PORT | xargs kill -9`

### Port conflict on startup

If the port health checker marks a service as **external** on dashboard load, a previous process is still holding that port:
```bash
lsof -ti :PORT | xargs kill -9
```

### Dashboard shows wrong status after manual terminal close

Status reconciliation happens on the next port poll (within 4 seconds) or immediately if the VS Code extension detects the terminal close and pushes a `terminal_closed` event.

### Worker scripts fail with "Cannot find module"

The worker's `node_modules` may not be installed. SSM will automatically prepend `npm install && ` to the command if `node_modules` is missing, but you can also run `npm install` manually in the worker directory.
