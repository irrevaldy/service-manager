'use strict';

const vscode = require('vscode');
const http = require('http');

const BRIDGE_PORT = 9998;       // this extension's server (service manager calls us)
const SM_PORT = 9999;           // service manager server (we call it)

// serviceId → { terminal, logBuffer, flushTimer, pendingClose }
// pendingClose: setTimeout handle — cancelled if the terminal is reused (restart flow)
const managed = new Map();

/** Called by VS Code when the extension is first activated */
function activate(context) {
  const server = http.createServer(handleRequest);

  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`[SM Bridge] listening on ${BRIDGE_PORT}`);
  });

  // ── Terminal output capture ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.onDidWriteTerminalData(({ terminal, data }) => {
      for (const [id, entry] of managed) {
        if (entry.terminal === terminal) {
          // Fallback cmd_ended: detect VS Code shell integration OSC 633;D sequence in
          // raw data before stripAnsi removes it. This fires when the shell regains
          // control after a process exits, covering cases where onDidEndTerminalShellExecution
          // doesn't trigger (Expo/Metro interactive mode, old VS Code, broken shell integration).
          // Dedup within 5s to avoid double-firing when the API event also triggers.
          if (/\x1b]633;D/.test(data)) {
            const now = Date.now();
            if (now - entry.lastCmdEnd > 5000) {
              entry.lastCmdEnd = now;
              const m = data.match(/\x1b]633;D(?:;(\d+))?/);
              const exitCode = m?.[1] !== undefined ? parseInt(m[1]) : undefined;
              postToSM('/api/vscode-event', { type: 'cmd_ended', id, exitCode });
            }
          }

          const clean = stripAnsi(data);
          if (!clean.trim()) return;
          entry.logBuffer.push(clean);
          scheduleFlush(id, entry);
          break;
        }
      }
    })
  );

  // ── Terminal close → notify service manager ─────────────────────────────
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(async (terminal) => {
      // Fast path: terminal is in the managed map
      for (const [id, entry] of managed) {
        if (entry.terminal === terminal) {
          if (entry.pendingClose) clearTimeout(entry.pendingClose);
          managed.delete(id);
          postToSM('/api/vscode-event', { type: 'terminal_closed', id });
          return;
        }
      }
      // Fallback: terminal was created by SM (has SM_SERVICE_ID) but isn't in
      // managed yet — e.g. user closes the tab before reattach completes after
      // an extension host reload. Read the id directly from creationOptions.
      const serviceId = terminal.creationOptions?.env?.SM_SERVICE_ID;
      if (serviceId) {
        postToSM('/api/vscode-event', { type: 'terminal_closed', id: serviceId });
      }
    })
  );

  // ── Shell integration: detect command execution ─────────────────────────
  if (vscode.window.onDidStartTerminalShellExecution) {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
        for (const [id, entry] of managed) {
          if (entry.terminal === terminal) {
            entry.lastCmdEnd = 0; // reset so the next stop is detectable
            postToSM('/api/vscode-event', { type: 'cmd_started', id, cmd: execution.commandLine?.value });
            break;
          }
        }
      })
    );

    context.subscriptions.push(
      vscode.window.onDidEndTerminalShellExecution(({ terminal, exitCode }) => {
        for (const [id, entry] of managed) {
          if (entry.terminal === terminal) {
            postToSM('/api/vscode-event', { type: 'cmd_ended', id, exitCode });
            return;
          }
        }
        // Fallback: not in managed map — read SM_SERVICE_ID from creationOptions
        const serviceId = terminal.creationOptions?.env?.SM_SERVICE_ID;
        if (serviceId) {
          postToSM('/api/vscode-event', { type: 'cmd_ended', id: serviceId, exitCode });
        }
      })
    );
  }

  context.subscriptions.push({ dispose: () => server.close() });
}

// ── HTTP handler ────────────────────────────────────────────────────────────
function handleRequest(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    const data = body ? tryParse(body) : {};

    // Health + list of active terminals
    if (req.method === 'GET' && req.url === '/status') {
      return json(res, 200, {
        ok: true,
        terminals: [...managed.keys()],
      });
    }

    // Open (or focus) a terminal for a service
    if (req.method === 'POST' && req.url === '/terminal/open') {
      const { id, cwd, cmd, forceNew } = data;
      if (!id || !cwd) return json(res, 400, { error: 'id and cwd required' });

      // forceNew: the service was in error state — dispose the stale terminal so
      // the code falls through to creating a fresh one below.
      if (forceNew) {
        const prev = managed.get(id);
        if (prev) {
          if (prev.pendingClose) clearTimeout(prev.pendingClose);
          prev.terminal.dispose();
          managed.delete(id);
        } else {
          const byEnv = findByServiceId(id);
          if (byEnv) byEnv.dispose();
        }
      }

      // 1. Check managed map first (fastest path)
      const existing = managed.get(id);
      if (existing && vscode.window.terminals.includes(existing.terminal)) {
        // Cancel any pending auto-close — terminal is being reused (restart flow)
        if (existing.pendingClose) {
          clearTimeout(existing.pendingClose);
          existing.pendingClose = null;
        }
        existing.terminal.show(false);
        if (cmd) { await delay(300); existing.terminal.sendText(cmd, true); }
        return json(res, 200, { ok: true, reused: true });
      }

      // 2. Search by SM_SERVICE_ID env var — survives extension host restarts
      const byEnv = findByServiceId(id);
      if (byEnv) {
        managed.set(id, mkEntry(byEnv));
        byEnv.show(false);
        if (cmd) { await delay(300); byEnv.sendText(cmd, true); }
        return json(res, 200, { ok: true, reused: true });
      }

      // 3. cwd fallback — for terminals opened before the env-var scheme
      const byCwd = vscode.window.terminals.find(t => {
        const tc = t.creationOptions?.cwd;
        return (typeof tc === 'string' ? tc : tc?.fsPath) === cwd;
      });
      if (byCwd) {
        managed.set(id, mkEntry(byCwd));
        byCwd.show(false);
        if (cmd) { await delay(300); byCwd.sendText(cmd, true); }
        return json(res, 200, { ok: true, reused: true });
      }

      // 4. Create a fresh terminal. No explicit name → VS Code shows the default
      //    "zsh (folder)" format. SM_SERVICE_ID lets us re-find it after restarts.
      const terminal = vscode.window.createTerminal({ cwd, env: { SM_SERVICE_ID: id } });
      managed.set(id, mkEntry(terminal));
      terminal.show(false);
      if (cmd) { await delay(700); terminal.sendText(cmd, true); }

      return json(res, 200, { ok: true, reused: false });
    }

    // Focus an existing terminal (e.g. when clicking "Logs" in dashboard)
    if (req.method === 'POST' && req.url === '/terminal/focus') {
      const { id } = data;
      const entry = managed.get(id);
      if (entry && vscode.window.terminals.includes(entry.terminal)) {
        entry.terminal.show(true);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Terminal not found' });
    }

    // Send raw key(s) to a terminal — used for interactive CLIs like Expo
    // that read single characters (raw mode). No newline appended.
    if (req.method === 'POST' && req.url === '/terminal/keys') {
      const { id, keys } = data;
      let terminal = null;
      const existing = managed.get(id);
      if (existing && vscode.window.terminals.includes(existing.terminal)) {
        terminal = existing.terminal;
      } else {
        terminal = findByServiceId(id);
      }
      if (terminal && Array.isArray(keys)) {
        keys.forEach(k => terminal.sendText(k, false));
      }
      return json(res, 200, { ok: true });
    }

    // Stop the process running inside the terminal.
    // If the terminal was created by us (has SM_SERVICE_ID), the tab is also
    // auto-closed after the process exits — no flag needed from the server.
    if (req.method === 'POST' && req.url === '/terminal/stop') {
      const { id, cwd } = data;

      // Resolve: managed → env-var → cwd fallback
      let entry = null;
      const existing = managed.get(id);
      if (existing && vscode.window.terminals.includes(existing.terminal)) {
        entry = existing;
      } else {
        const byEnv = findByServiceId(id);
        if (byEnv) {
          entry = mkEntry(byEnv);
          managed.set(id, entry);
        } else if (cwd) {
          const byCwd = vscode.window.terminals.find(t => {
            const tc = t.creationOptions?.cwd;
            return (typeof tc === 'string' ? tc : tc?.fsPath) === cwd;
          });
          if (byCwd) {
            entry = mkEntry(byCwd);
            managed.set(id, entry);
          }
        }
      }

      if (entry) {
        const terminal = entry.terminal;

        // Ctrl+C x2: first stops the process, second exits nodemon's watch loop
        terminal.sendText('\x03');
        setTimeout(() => terminal.sendText('\x03'), 400);

        // Auto-close the tab if this is a terminal we own (SM_SERVICE_ID present).
        // Cancel any previous close timer first (defensive).
        if (entry.pendingClose) clearTimeout(entry.pendingClose);

        const isOwned = terminal.creationOptions?.env?.SM_SERVICE_ID === id;
        if (isOwned) {
          entry.pendingClose = setTimeout(() => {
            const e = managed.get(id);
            // Only dispose if the timer wasn't cancelled by a restart (/terminal/open)
            if (e && e.pendingClose !== null) {
              e.pendingClose = null;
              e.terminal.dispose();
            }
          }, 2500);
        }

        return json(res, 200, { ok: true });
      }

      return json(res, 200, { ok: true, note: 'terminal not found' });
    }

    json(res, 404, { error: 'Not found' });
  });
}

// ── Terminal lookup ──────────────────────────────────────────────────────────

function findByServiceId(id) {
  return vscode.window.terminals.find(
    t => t.creationOptions?.env?.SM_SERVICE_ID === id
  ) || null;
}

function mkEntry(terminal) {
  return { terminal, logBuffer: [], flushTimer: null, pendingClose: null, lastCmdEnd: 0 };
}

// ── Log batching ────────────────────────────────────────────────────────────
function scheduleFlush(id, entry) {
  if (entry.flushTimer) return;
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    const lines = entry.logBuffer.splice(0);
    if (lines.length === 0) return;
    postToSM('/api/vscode-event', { type: 'logs', id, lines });
  }, 400);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function postToSM(path, body) {
  const payload = JSON.stringify(body);
  const req = http.request({
    hostname: '127.0.0.1',
    port: SM_PORT,
    path,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  });
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function tryParse(str) {
  try { return JSON.parse(str); } catch (_) { return {}; }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
}

function deactivate() {}

module.exports = { activate, deactivate };
