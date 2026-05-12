'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');

const MAX_LOG_LINES = 800;
const PORT_POLL_INTERVAL = 4000;   // ms between port health checks
const VSCODE_BRIDGE_PORT = 9998;

class ProcessManager extends EventEmitter {
  constructor(serviceConfigs, projectsDir) {
    super();
    this._projectsDir = projectsDir;
    this._services = {};
    this._logSubs = {};
    this._logBuf = {};
    this._restartTimers = {};
    this._startingTimers = {};   // guards against infinite "starting" state
    this._portPollTimer = null;
    this._vscodeAvailable = false;

    for (const cfg of serviceConfigs) {
      this._services[cfg.id] = {
        id: cfg.id,
        name: cfg.name,
        type: cfg.type,
        port: cfg.port,
        cmd: cfg.cmd,
        args: cfg.args,
        note: cfg.note || null,
        // spawn-mode state
        status: 'stopped',
        pid: null,
        proc: null,
        startTime: null,
        exitCode: null,
        errorMsg: null,
        // tracking mode: 'spawn' | 'vscode' | 'external'
        mode: 'spawn',
      };
      this._logSubs[cfg.id] = new Set();
      this._logBuf[cfg.id] = [];
    }

    this._startPortPoller();
    this._probeVSCode();
    setInterval(() => this._probeVSCode(), 8000);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getAll() {
    return Object.values(this._services).map(s => this._pub(s));
  }

  getVSCodeStatus() {
    return this._vscodeAvailable;
  }

  start(id) {
    const svc = this._services[id];
    if (!svc) return;
    if (svc.status === 'running' || svc.status === 'starting') return;

    if (!svc.cmd) {
      this._addLog(id, svc.note || 'No start command configured.', 'warn');
      this._setStatus(id, 'unconfigured');
      return;
    }

    // Always do a fresh live probe so we don't rely on a stale cached value
    this._liveProbeVSCode().then(available => {
      if (available) {
        this._startVSCode(id);
      } else {
        this._launchVSCodeAndStart(id);
      }
    });
  }

  stop(id) {
    const svc = this._services[id];
    if (!svc) return;

    if (svc.mode === 'vscode' || svc.mode === 'external') {
      this._stopVSCode(id);
    } else {
      this._stopSpawn(id);
    }
  }

  restart(id) {
    const svc = this._services[id];
    if (!svc) return;

    if (this._restartTimers[id]) {
      clearTimeout(this._restartTimers[id]);
      delete this._restartTimers[id];
    }

    if (svc.mode === 'vscode' || svc.mode === 'external') {
      this._stopVSCode(id);
      this._restartTimers[id] = setTimeout(() => this.start(id), 800);
    } else if (svc.proc) {
      svc.proc.once('close', () => {
        this._restartTimers[id] = setTimeout(() => this.start(id), 600);
      });
      this._stopSpawn(id);
    } else {
      this.start(id);
    }
  }

  /** Called by server.js when VS Code extension posts an event */
  handleVSCodeEvent(event) {
    const { type, id } = event;
    const svc = this._services[id];
    if (!svc) {
      // Worker terminals use composite ids like "workers--csv-imports--index"
      const workerId = id && id.split('--')[0];
      const workerSvc = workerId && this._services[workerId];
      if (workerSvc && workerSvc.type === 'worker') {
        if (type === 'terminal_closed' || type === 'cmd_ended') {
          this.emit('worker_stopped', workerId, id);
        }
      }
      return;
    }

    switch (type) {
      case 'terminal_closed':
        this._setStatus(id, 'stopped', { mode: 'spawn', pid: null });
        this._addLog(id, 'VS Code terminal was closed.', 'sys');
        break;

      case 'cmd_started':
        this._setStatus(id, 'starting');
        this._addLog(id, `$ ${event.cmd || ''}`, 'sys');
        // No-port services can't be detected via port polling — the starting
        // timer will transition to 'running' after the grace period.
        break;

      case 'cmd_ended':
        // For no-port services the process exiting IS the definitive signal.
        // For port-based services the port poller will pick up the disappearance.
        if (event.exitCode === 0 || event.exitCode == null) {
          this._setStatus(id, 'stopped');
        } else {
          this._setStatus(id, 'error', { exitCode: event.exitCode, errorMsg: `Exited with code ${event.exitCode}` });
        }
        break;

      case 'logs':
        if (Array.isArray(event.lines)) {
          event.lines.forEach(line => {
            // Heuristic: treat lines containing 'error' or 'ERR' as error level
            const level = /error|ERR|\bfail/i.test(line) ? 'err' : 'out';
            this._addLog(id, line.trimEnd(), level);
          });
        }
        break;
    }
  }

  subscribeLogs(id, ws) {
    if (!this._logSubs[id]) return;
    this._logSubs[id].add(ws);
    const history = this._logBuf[id] || [];
    if (history.length > 0) {
      try { ws.send(JSON.stringify({ type: 'log_history', id, lines: history })); } catch (_) {}
    }
  }

  unsubscribeLogs(id, ws) {
    this._logSubs[id]?.delete(ws);
  }

  unsubscribeAll(ws) {
    Object.values(this._logSubs).forEach(set => set.delete(ws));
  }

  hasService(id) {
    return !!this._services[id];
  }

  addService(cfg) {
    if (this._services[cfg.id]) return false;
    this._services[cfg.id] = {
      id: cfg.id,
      name: cfg.name,
      type: cfg.type,
      port: cfg.port,
      cmd: cfg.cmd,
      args: cfg.args,
      note: cfg.note || null,
      status: 'stopped',
      pid: null,
      proc: null,
      startTime: null,
      exitCode: null,
      errorMsg: null,
      mode: 'spawn',
    };
    this._logSubs[cfg.id] = new Set();
    this._logBuf[cfg.id]  = [];
    this.emit('service_added', this._pub(this._services[cfg.id]));
    return true;
  }

  stopAll() {
    Object.keys(this._services).forEach(id => {
      const s = this._services[id];
      if (s.status === 'running' || s.status === 'starting') this.stop(id);
    });
  }

  // ── VS Code mode ────────────────────────────────────────────────────────────

  _launchVSCodeAndStart(id) {
    const { exec } = require('child_process');
    const workspaceFile = path.join(this._projectsDir, 'sociolla.code-workspace');
    const target = fs.existsSync(workspaceFile) ? `"${workspaceFile}"` : '';

    this._setStatus(id, 'starting', { mode: 'vscode' });
    this._addLog(id, 'VS Code not connected — launching VS Code…', 'sys');

    let resolved = false;
    let pollTimer = null;

    const succeed = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(pollTimer);
      this._addLog(id, 'VS Code connected — starting service in terminal.', 'sys');
      this._startVSCode(id);
    };

    const fallback = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(pollTimer);
      this._addLog(id, 'VS Code did not connect — falling back to spawn mode.', 'warn');
      this._startSpawn(id);
    };

    exec(`code ${target}`, (err) => {
      if (err) {
        exec(`open -a "Visual Studio Code" ${target || '.'}`, (err2) => {
          if (err2) {
            this._addLog(id, 'Could not launch VS Code.', 'warn');
            fallback();
          }
        });
      }
    });

    // Poll for VSCode bridge connection (max 20s)
    let attempts = 0;
    const maxAttempts = 40; // 40 × 500ms = 20s
    pollTimer = setInterval(() => {
      if (resolved) { clearInterval(pollTimer); return; }
      const svc = this._services[id];
      if (!svc || svc.status !== 'starting') { resolved = true; clearInterval(pollTimer); return; }
      attempts++;
      this._liveProbeVSCode().then(available => {
        if (available) {
          succeed();
        } else if (attempts >= maxAttempts) {
          this._addLog(id, 'VS Code did not connect within 20s.', 'warn');
          fallback();
        }
      });
    }, 500);
  }

  _startVSCode(id) {
    const svc = this._services[id];
    const cwd = path.join(this._projectsDir, id);

    if (!fs.existsSync(cwd)) {
      this._addLog(id, `Directory not found: ${cwd}`, 'err');
      this._setStatus(id, 'error', { errorMsg: 'Directory not found' });
      return;
    }

    const cmd = svc.cmd + ' ' + svc.args.join(' ');
    this._setStatus(id, 'starting', { mode: 'vscode' });
    this._addLog(id, `Opening VS Code terminal — ${cmd}`, 'sys');

    this._callVSCode('POST', '/terminal/open', {
      id,
      name: id,    // use service ID so tab shows e.g. "ms-sso-broker" not "SSO Broker"
      cwd,
      cmd,
    }).catch(() => {
      // VS Code went away — fall back to spawn
      this._vscodeAvailable = false;
      this._addLog(id, 'VS Code not reachable, falling back to spawn mode.', 'warn');
      this._startSpawn(id);
    });
  }

  _stopVSCode(id) {
    const svc = this._services[id];
    this._addLog(id, 'Sending stop signal to VS Code terminal…', 'sys');
    this._setStatus(id, 'stopping');

    this._callVSCode('POST', '/terminal/stop', { id }).catch(() => {});

    // Fallback: if the service is still on the port after 4s, kill it by port
    if (svc.port) {
      setTimeout(async () => {
        if (svc.status !== 'stopping') return;
        const alive = await checkPort(svc.port);
        if (alive) {
          const { exec } = require('child_process');
          exec(`lsof -ti :${svc.port} | xargs kill -9 2>/dev/null`, () => {});
          this._addLog(id, `Force-killed process on port ${svc.port}.`, 'warn');
        }
      }, 4000);
    }

    // Safety: if still stopping after 8s, force-clear status
    setTimeout(() => {
      if (svc.status === 'stopping') {
        this._setStatus(id, 'stopped', { mode: 'spawn', pid: null });
        this._addLog(id, 'Stop timed out — status force-cleared.', 'warn');
      }
    }, 8000);
  }

  focusVSCode(id) {
    this._callVSCode('POST', '/terminal/focus', { id }).catch(() => {});
  }

  /** Send Ctrl+C to a worker terminal opened by runWorkerScript */
  stopWorkerScript(termId) {
    if (!termId) return;
    this._callVSCode('POST', '/terminal/stop', { id: termId }).catch(() => {});
  }

  /** Open a VS Code terminal and run a worker script. script is optional — omit to run the folder directly. */
  runWorkerScript(workerId, folder, script) {
    const svc = this._services[workerId];
    if (!svc || !folder) return;

    const cwd    = path.join(this._projectsDir, workerId);
    const target = script ? `${folder}/${script}` : folder;
    const needsInstall = !fs.existsSync(path.join(cwd, 'node_modules'));
    const cmd    = (needsInstall ? 'npm install && ' : '') + `node ${target}`;
    const termId = script
      ? `${workerId}--${folder}--${script.replace(/\.js$/, '')}`
      : `${workerId}--${folder}`;

    this._liveProbeVSCode().then(available => {
      if (available) {
        this._callVSCode('POST', '/terminal/open', { id: termId, name: termId, cwd, cmd }).catch(() => {});
      } else {
        this._addLog(workerId, `VS Code not available. Run manually: cd ${cwd} && ${cmd}`, 'warn');
      }
    });
  }

  _callVSCode(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port: VSCODE_BRIDGE_PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 2000,
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });
  }

  _probeVSCode() {
    http.get({ hostname: '127.0.0.1', port: VSCODE_BRIDGE_PORT, path: '/status', timeout: 1500 }, (res) => {
      const was = this._vscodeAvailable;
      this._vscodeAvailable = res.statusCode === 200;
      if (!was && this._vscodeAvailable) this.emit('vscode_connected');
      if (was && !this._vscodeAvailable) this.emit('vscode_disconnected');
    }).on('error', () => {
      const was = this._vscodeAvailable;
      this._vscodeAvailable = false;
      if (was) this.emit('vscode_disconnected');
    });
  }

  /** Fresh synchronous-style probe used right before start() decides mode. */
  _liveProbeVSCode() {
    return new Promise(resolve => {
      const req = http.get(
        { hostname: '127.0.0.1', port: VSCODE_BRIDGE_PORT, path: '/status', timeout: 1500 },
        (res) => {
          const ok = res.statusCode === 200;
          this._vscodeAvailable = ok;
          resolve(ok);
        }
      );
      req.on('error', () => { this._vscodeAvailable = false; resolve(false); });
      req.on('timeout', () => { req.destroy(); this._vscodeAvailable = false; resolve(false); });
    });
  }

  // ── Spawn mode ──────────────────────────────────────────────────────────────

  _startSpawn(id) {
    const svc = this._services[id];
    const cwd = path.join(this._projectsDir, id);

    if (!fs.existsSync(cwd)) {
      this._addLog(id, `Directory not found: ${cwd}`, 'err');
      this._setStatus(id, 'error', { errorMsg: 'Directory not found' });
      return;
    }

    this._setStatus(id, 'starting', { mode: 'spawn' });
    this._addLog(id, `Starting: ${svc.cmd} ${svc.args.join(' ')} (PORT=${svc.port || 'default'})`, 'sys');

    const env = {
      ...process.env,
      ...(svc.port ? { PORT: String(svc.port) } : {}),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    };

    let proc;
    try {
      // detached: true creates a new process group so we can kill npm + nodemon + node together
      proc = spawn(svc.cmd, svc.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      this._addLog(id, `Spawn failed: ${err.message}`, 'err');
      this._setStatus(id, 'error', { errorMsg: err.message });
      return;
    }

    svc.proc = proc;
    svc.pid = proc.pid;
    svc.startTime = Date.now();
    svc.exitCode = null;
    svc.errorMsg = null;

    const onData = (level) => (data) =>
      data.toString().split('\n').forEach(line => {
        line = line.trim();
        if (line) this._addLog(id, line, level);
      });

    proc.stdout.on('data', onData('out'));
    proc.stderr.on('data', onData('err'));

    proc.on('spawn', () => {
      this._setStatus(id, 'running');
      this._addLog(id, `Process started (PID ${proc.pid})`, 'sys');
    });

    proc.on('error', (err) => {
      this._addLog(id, `Process error: ${err.message}`, 'err');
      this._setStatus(id, 'error', { pid: null, proc: null, errorMsg: err.message });
      svc.proc = null;
      svc.pid = null;
    });

    proc.on('close', (code, signal) => {
      svc.proc = null;
      svc.pid = null;
      svc.exitCode = code;
      const msg = signal ? `Killed by signal ${signal}` : `Exited with code ${code}`;
      this._addLog(id, msg, code === 0 || signal === 'SIGTERM' ? 'sys' : 'err');
      this._setStatus(id, code === 0 || code === null ? 'stopped' : 'error', {
        exitCode: code,
        errorMsg: code !== 0 && code !== null ? `Exited with code ${code}` : null,
      });
    });
  }

  _stopSpawn(id) {
    const svc = this._services[id];
    if (!svc?.proc) return;

    this._addLog(id, 'Stopping…', 'sys');
    this._setStatus(id, 'stopping');

    const proc = svc.proc;
    const pgid = proc.pid;

    // Kill the entire process group (npm + nodemon + node). This is critical because
    // nodemon/node inherit npm's pipe FDs; killing only npm leaves them alive and the
    // 'close' event never fires, causing the eternal "stopping" state.
    const killGroup = (signal) => {
      try { process.kill(-pgid, signal); } catch (_) {
        try { proc.kill(signal); } catch (_) {}
      }
    };

    killGroup('SIGTERM');

    // Force-kill the group after 5s if still alive
    const forceTimer = setTimeout(() => killGroup('SIGKILL'), 5000);

    // Safety: force-clear the stopping status after 8s even if close never fires
    const safetyTimer = setTimeout(() => {
      if (svc.status === 'stopping') {
        svc.proc = null;
        svc.pid  = null;
        this._setStatus(id, 'stopped');
        this._addLog(id, 'Stop timed out — status force-cleared.', 'warn');
      }
    }, 8000);

    proc.once('close', () => {
      clearTimeout(forceTimer);
      clearTimeout(safetyTimer);
    });
  }

  // ── Port health poller (detects externally-started services) ───────────────

  _startPortPoller() {
    const poll = async () => {
      for (const svc of Object.values(this._services)) {
        if (!svc.port) continue;

        const alive = await checkPort(svc.port);

        if (alive && svc.status === 'stopped') {
          // Service appeared without being started by us — e.g. started in VS Code terminal
          this._setStatus(svc.id, 'running', { mode: 'external', startTime: Date.now() });
          this._addLog(svc.id, `Detected running on port ${svc.port} (external).`, 'sys');
        } else if (alive && (svc.status === 'starting' || svc.status === 'error')) {
          // Port came up — covers vscode mode, spawn mode, and recovery after error/timeout
          this._setStatus(svc.id, 'running');
        } else if (!alive && svc.status === 'running' && svc.mode === 'external') {
          // Externally-started service stopped
          this._setStatus(svc.id, 'stopped', { mode: 'spawn' });
          this._addLog(svc.id, `No longer reachable on port ${svc.port}.`, 'sys');
        }
      }
    };

    this._portPollTimer = setInterval(poll, PORT_POLL_INTERVAL);
    poll(); // initial check on boot
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _pub(svc) {
    return {
      id: svc.id,
      name: svc.name,
      type: svc.type,
      port: svc.port,
      status: svc.status,
      mode: svc.mode,
      pid: svc.pid,
      uptime: svc.startTime && svc.status === 'running' ? Date.now() - svc.startTime : null,
      exitCode: svc.exitCode,
      errorMsg: svc.errorMsg,
      note: svc.note,
    };
  }

  _setStatus(id, status, extra = {}) {
    const svc = this._services[id];
    if (!svc) return;
    Object.assign(svc, { status }, extra);

    // Arm a watchdog when entering 'starting'; disarm when leaving it
    if (status === 'starting') {
      this._armStartingTimer(id);
    } else if (this._startingTimers[id]) {
      clearTimeout(this._startingTimers[id]);
      delete this._startingTimers[id];
    }

    this.emit('status', id, this._pub(svc));
  }

  // If a service stays in 'starting' for more than 60s, transition to 'error'.
  // Exception: no-port services can't be detected via port polling, so assume
  // they're running after a short grace period instead of timing out.
  _armStartingTimer(id) {
    if (this._startingTimers[id]) clearTimeout(this._startingTimers[id]);
    const svc = this._services[id];
    if (svc && !svc.port) {
      // Give 10s for the process to crash; if still starting, assume it's running
      this._startingTimers[id] = setTimeout(() => {
        if (svc.status === 'starting') {
          this._setStatus(id, 'running');
          this._addLog(id, 'No port configured — assumed running.', 'sys');
        }
      }, 10000);
      return;
    }
    this._startingTimers[id] = setTimeout(() => {
      if (svc && svc.status === 'starting') {
        this._addLog(id, 'Service did not start within 60s — check logs in VS Code terminal.', 'err');
        this._setStatus(id, 'error', { errorMsg: 'Start timed out after 60s' });
      }
    }, 60000);
  }

  _addLog(id, text, level = 'out') {
    const entry = { ts: Date.now(), text, level };
    const buf = this._logBuf[id];
    if (buf) {
      buf.push(entry);
      if (buf.length > MAX_LOG_LINES) buf.shift();
    }
    this._logSubs[id]?.forEach(ws => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'log', id, ...entry })); } catch (_) {}
      }
    });
  }
}

function checkPort(port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(1200);
    socket.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

module.exports = ProcessManager;
