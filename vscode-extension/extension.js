'use strict';

const vscode = require('vscode');
const http = require('http');

const BRIDGE_PORT = 9998;       // this extension's server (service manager calls us)
const SM_PORT = 9999;           // service manager server (we call it)

// serviceId → { terminal: vscode.Terminal, logBuffer: string[], flushTimer }
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
      for (const [id, entry] of managed) {
        if (entry.terminal === terminal) {
          managed.delete(id);
          postToSM('/api/vscode-event', { type: 'terminal_closed', id });
          break;
        }
      }
    })
  );

  // ── Shell integration: detect command execution ─────────────────────────
  if (vscode.window.onDidStartTerminalShellExecution) {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
        for (const [id, entry] of managed) {
          if (entry.terminal === terminal) {
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
            break;
          }
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
      const { id, name, cwd, cmd } = data;
      if (!id || !cwd) return json(res, 400, { error: 'id and cwd required' });

      // 1. Check our managed map first (fastest path)
      const existing = managed.get(id);
      if (existing && vscode.window.terminals.includes(existing.terminal)) {
        existing.terminal.show(false);
        if (cmd) { await delay(300); existing.terminal.sendText(cmd, true); }
        return json(res, 200, { ok: true, reused: true });
      }

      // 2. Search open terminals by cwd — catches the case where SSM restarted
      //    and the managed map was reset but the tab is still open.
      const byCwd = vscode.window.terminals.find(t => {
        const tc = t.creationOptions?.cwd;
        return (typeof tc === 'string' ? tc : tc?.fsPath) === cwd;
      });
      if (byCwd) {
        managed.set(id, { terminal: byCwd, logBuffer: [], flushTimer: null });
        byCwd.show(false);
        if (cmd) { await delay(300); byCwd.sendText(cmd, true); }
        return json(res, 200, { ok: true, reused: true });
      }

      // 3. Nothing found — create a fresh terminal without an explicit name so
      //    VS Code shows the default "zsh <folder>" format in the tab.
      const terminal = vscode.window.createTerminal({ cwd });
      managed.set(id, { terminal, logBuffer: [], flushTimer: null });
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

    // Send Ctrl+C to stop the running process inside the terminal
    if (req.method === 'POST' && req.url === '/terminal/stop') {
      const { id } = data;
      const entry = managed.get(id);
      if (entry && vscode.window.terminals.includes(entry.terminal)) {
        // First Ctrl+C stops the process; second exits nodemon's watch loop
        entry.terminal.sendText('\x03');
        setTimeout(() => entry.terminal.sendText('\x03'), 400);
        return json(res, 200, { ok: true });
      }
      // Terminal already gone — that's fine, just report ok
      return json(res, 200, { ok: true, note: 'terminal already closed' });
    }

    json(res, 404, { error: 'Not found' });
  });
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
  req.on('error', () => {}); // silently ignore if SM is not running
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

// Strips ANSI escape sequences and carriage returns from terminal output
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')  // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[()][AB012]/g, '')           // charset designators
    .replace(/\x1b[=>]/g, '')                  // keypad modes
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, ''); // other control chars
}

function deactivate() {}

module.exports = { activate, deactivate };
