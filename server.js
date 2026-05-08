'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SERVICES, PROJECTS_DIR, discoverOne } = require('./services.config');
const ProcessManager = require('./process-manager');
const VpnManager = require('./vpn-manager');

const PORT = 9999;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const pm = new ProcessManager(SERVICES, PROJECTS_DIR);
const vm = new VpnManager(path.join(__dirname, 'vpn.config.json'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── REST ──────────────────────────────────────────────────────────────────────
app.get('/api/services', (_req, res) => res.json(pm.getAll()));

app.get('/api/vscode-status', (_req, res) =>
  res.json({ connected: pm.getVSCodeStatus() })
);

/** Receives events pushed by the VS Code extension */
app.post('/api/vscode-event', (req, res) => {
  pm.handleVSCodeEvent(req.body);
  res.json({ ok: true });
});

// ── VPN ───────────────────────────────────────────────────────────────────────

app.get('/api/vpn', (_req, res) => res.json({
  environments: vm.getAll(),
  openvpnPath: vm.getOpenvpnBin(),
  setupUser: process.env.USER || os.userInfo().username,
}));

app.post('/api/vpn/connect', (req, res) => {
  const { id, totp } = req.body || {};
  res.json(vm.connect(id, totp || ''));
});

app.post('/api/vpn/disconnect', (req, res) => {
  const { id } = req.body || {};
  vm.disconnect(id);
  res.json({ ok: true });
});

app.post('/api/vpn/credentials', (req, res) => {
  const { id, username, password } = req.body || {};
  const ok = vm.saveCredentials(id, username, password);
  res.json({ ok });
});

/** Focus a service's VS Code terminal from the dashboard */
app.post('/api/focus-terminal', (req, res) => {
  const { id } = req.body || {};
  if (id) pm.focusVSCode(id);
  res.json({ ok: true });
});

/** List runnable scripts inside a worker service's subdirectories */
app.get('/api/workers/:id/scripts', (req, res) => {
  const svc = pm.getAll().find(s => s.id === req.params.id);
  if (!svc || svc.type !== 'worker') return res.status(404).json({ error: 'Not a worker service' });

  const workerDir = path.join(PROJECTS_DIR, req.params.id);
  if (!fs.existsSync(workerDir)) return res.status(404).json({ error: 'Directory not found' });

  const SKIP = new Set(['make-trigger.js', 'helper.js', 'utlis.js', 'utils.js']);

  const folders = [];
  try {
    const entries = fs.readdirSync(workerDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'class') continue;

      const scripts = fs.readdirSync(path.join(workerDir, entry.name))
        .filter(f => f.endsWith('.js') && !f.startsWith('.') && !SKIP.has(f))
        .sort();

      if (scripts.length > 0) folders.push({ name: entry.name, scripts });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ id: req.params.id, folders });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
pm.on('status', (id, data) => broadcast({ type: 'status', id, data }));
pm.on('service_added', (data) => broadcast({ type: 'service_added', data }));

// ── Hot-add newly cloned repos ────────────────────────────────────────────────
// Debounce per directory name — git clone creates many events before package.json
// is fully written, so we wait 3s after the last event for that name.
const _pendingAdds = {};
fs.watch(PROJECTS_DIR, (eventType, filename) => {
  if (!filename || pm.hasService(filename)) return;
  clearTimeout(_pendingAdds[filename]);
  _pendingAdds[filename] = setTimeout(() => {
    delete _pendingAdds[filename];
    if (pm.hasService(filename)) return;
    const cfg = discoverOne(filename);
    if (cfg) {
      pm.addService(cfg);
      console.log(`  + auto-detected new service: ${filename}`);
    }
  }, 3000);
});

vm.on('status',     (id, data)  => broadcast({ type: 'vpn_status',     id, data }));
vm.on('log',        (id, entry) => broadcast({ type: 'vpn_log',        id, entry }));
vm.on('auth_failed', id         => broadcast({ type: 'vpn_auth_failed', id }));
vm.on('needs_setup', id         => broadcast({ type: 'vpn_needs_setup', id }));

pm.on('vscode_connected',    () => broadcast({ type: 'vscode_status', connected: true }));
pm.on('vscode_disconnected', () => broadcast({ type: 'vscode_status', connected: false }));
pm.on('worker_stopped', (workerId, termId) => broadcast({ type: 'worker_stopped', workerId, termId }));

wss.on('connection', (ws) => {
  try {
    ws.send(JSON.stringify({
      type: 'init',
      data: pm.getAll(),
      vscodeConnected: pm.getVSCodeStatus(),
      vpnData: vm.getAll(),
      openvpnPath: vm.getOpenvpnBin(),
      setupUser: process.env.USER || os.userInfo().username,
    }));
  } catch (_) {}

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    switch (msg.type) {
      case 'start':            pm.start(msg.id); break;
      case 'stop':             pm.stop(msg.id); break;
      case 'restart':          pm.restart(msg.id); break;
      case 'focus_terminal':   pm.focusVSCode(msg.id); break;
      case 'run_worker_script': pm.runWorkerScript(msg.id, msg.folder, msg.script); break;
      case 'stop_worker':       pm.stopWorkerScript(msg.termId); break;
      case 'subscribe_logs':   pm.subscribeLogs(msg.id, ws); break;
      case 'unsubscribe_logs': pm.unsubscribeLogs(msg.id, ws); break;
    }
  });

  ws.on('close', () => pm.unsubscribeAll(ws));
  ws.on('error', () => pm.unsubscribeAll(ws));
});

// Uptime ticker every 5s
setInterval(() => {
  const running = pm.getAll().filter(s => s.status === 'running');
  if (running.length > 0) {
    broadcast({ type: 'uptime_tick', data: running.map(s => ({ id: s.id, uptime: s.uptime })) });
  }
}, 5000);

function broadcast(msg) {
  const json = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { try { client.send(json); } catch (_) {} }
  });
}

server.listen(PORT, () => {
  console.log(`\n  Service Manager`);
  console.log(`  http://localhost:${PORT}\n`);
});

const shutdown = () => {
  console.log('\nShutting down…');
  pm.stopAll();
  setTimeout(() => process.exit(0), 2000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
