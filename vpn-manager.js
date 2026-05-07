'use strict';

const { spawn } = require('child_process');
const net = require('net');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OPENVPN_PATHS = [
  '/opt/homebrew/sbin/openvpn', // Apple Silicon (brew)
  '/usr/local/sbin/openvpn',    // Intel (brew)
];

// Management interface ports — one per environment
const MGMT_BASE_PORT = 11940;

class VpnManager extends EventEmitter {
  constructor(configPath) {
    super();
    this._configPath = configPath;
    this._config = this._loadConfig();
    this._conns = {};

    let portIdx = 0;
    for (const env of this._config.environments || []) {
      this._conns[env.id] = {
        status: 'disconnected',
        proc: null,
        mgmtSocket: null,
        mgmtPort: MGMT_BASE_PORT + portIdx++,
        mgmtBuf: '',
        authToken: null,
        needsTotp: true,  // cleared once we successfully connect and get a token
        logs: [],
      };
    }
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  _loadConfig() {
    try {
      if (fs.existsSync(this._configPath))
        return JSON.parse(fs.readFileSync(this._configPath, 'utf8'));
    } catch (_) {}
    return { environments: [] };
  }

  _saveConfig() {
    try { fs.writeFileSync(this._configPath, JSON.stringify(this._config, null, 2)); }
    catch (_) {}
  }

  getOpenvpnBin() {
    for (const p of OPENVPN_PATHS) if (fs.existsSync(p)) return p;
    return null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getAll() {
    return (this._config.environments || []).map(e => this._pub(e.id));
  }

  saveCredentials(id, username, password) {
    const env = this._config.environments.find(e => e.id === id);
    if (!env) return false;
    env.username = username;
    env.password = password;
    this._saveConfig();
    return true;
  }

  connect(id, totp) {
    const env  = this._config.environments.find(e => e.id === id);
    const conn = this._conns[id];
    if (!env || !conn) return { error: 'not_found' };
    if (!env.username || !env.password) return { error: 'no_credentials' };
    if (conn.status === 'connecting' || conn.status === 'connected')
      return { error: 'already_active' };

    const bin = this.getOpenvpnBin();
    if (!bin) return { error: 'openvpn_not_installed' };

    if (!fs.existsSync(env.configFile))
      return { error: `Config file not found: ${env.configFile}` };

    // Build the password line: use cached auth-token when reconnecting without TOTP.
    // This server expects password+TOTP concatenated (no challenge-response).
    let passwordLine;
    conn.pendingTotp = totp || null;
    if (conn.authToken && !totp) {
      passwordLine = conn.authToken;
      this._log(id, 'Reconnecting with cached session token (no TOTP needed)…', 'sys');
    } else if (totp) {
      passwordLine = env.password + totp;
      conn.authToken = null;
      this._log(id, 'Connecting with password + TOTP…', 'sys');
    } else {
      passwordLine = env.password;
      this._log(id, 'Connecting…', 'sys');
    }

    // Write temp credentials file (chmod 600 — openvpn requires it)
    const tmpFile = path.join(os.tmpdir(), `ssm-vpn-${id}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmpFile, `${env.username}\n${passwordLine}\n`, { mode: 0o600 });
    } catch (err) {
      return { error: err.message };
    }

    this._setStatus(id, 'connecting');

    const proc = spawn('sudo', [
      '-n', bin,
      '--config', env.configFile,
      '--auth-user-pass', tmpFile,
      '--management', '127.0.0.1', String(conn.mgmtPort),
      '--management-hold',    // hold before connecting so mgmt socket is ready for CR_TEXT
      '--auth-retry', 'none', // exit on auth failure instead of retrying with stale TOTP
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    conn.proc = proc;
    conn.tmpFile = tmpFile; // cleaned up on process exit

    // Connect to the management socket after openvpn binds it
    let mgmtRetries = 0;
    const tryMgmt = () => {
      if (!conn.proc) return;
      if (mgmtRetries++ > 10) return;
      this._connectMgmt(id).catch(() => setTimeout(tryMgmt, 1500));
    };
    setTimeout(tryMgmt, 1500);

    const onLine = line => {
      line = line.trim();
      if (!line) return;
      // Mask the password line in logs
      if (/Enter Password:|password:/i.test(line)) return;
      this._log(id, line, this._lineLevel(line));
      this._parseStdout(id, line);
    };

    proc.stdout.on('data', d => d.toString().split('\n').forEach(onLine));
    proc.stderr.on('data', d => d.toString().split('\n').forEach(onLine));

    proc.on('close', code => {
      conn.proc = null;
      if (conn.mgmtSocket) { try { conn.mgmtSocket.destroy(); } catch (_) {} }
      conn.mgmtSocket = null;
      try { if (conn.tmpFile) fs.unlinkSync(conn.tmpFile); } catch (_) {}
      conn.tmpFile = null;
      if (conn.status !== 'disconnected') {
        this._setStatus(id, 'disconnected');
        this._log(id, `Process exited (${code ?? 'signal'})`, 'sys');
      }
    });

    proc.on('error', err => {
      conn.proc = null;
      let msg = err.message;
      if (/sudo: a password is required|EPERM/.test(msg))
        msg = 'Permission denied — sudo NOPASSWD not configured. See Setup below.';
      else if (/ENOENT/.test(msg))
        msg = 'openvpn not found. Run: brew install openvpn';
      this._setStatus(id, 'error');
      this._log(id, msg, 'err');
    });

    return { ok: true };
  }

  disconnect(id) {
    const conn = this._conns[id];
    if (!conn) return;

    this._setStatus(id, 'disconnecting');
    this._log(id, 'Disconnecting…', 'sys');

    // Prefer management socket — sends SIGTERM to the openvpn process cleanly
    if (conn.mgmtSocket && !conn.mgmtSocket.destroyed) {
      try { conn.mgmtSocket.write('signal SIGTERM\n'); } catch (_) {}
      // Give openvpn 4s to exit gracefully, then force-clear status
      setTimeout(() => {
        if (conn.status !== 'disconnected') {
          this._forceDisconnect(id);
        }
      }, 4000);
      return;
    }

    this._forceDisconnect(id);
  }

  _forceDisconnect(id) {
    const conn = this._conns[id];
    if (conn.proc) {
      // openvpn runs as root; we can't kill it directly from user space,
      // but the management socket SIGTERM should have handled it.
      // As last resort try kill (will silently fail if we lack permissions).
      try { conn.proc.kill('SIGTERM'); } catch (_) {}
    }
    setTimeout(() => {
      if (conn.status !== 'disconnected') {
        conn.proc = null;
        this._setStatus(id, 'disconnected');
        this._log(id, 'Forcefully disconnected.', 'sys');
      }
    }, 1500);
  }

  // ── Management socket ────────────────────────────────────────────────────────

  _connectMgmt(id) {
    return new Promise((resolve, reject) => {
      const conn = this._conns[id];
      if (!conn || !conn.proc) return reject(new Error('no proc'));

      const sock = net.createConnection(conn.mgmtPort, '127.0.0.1');
      conn.mgmtBuf = '';

      sock.setTimeout(3000);
      sock.on('timeout', () => sock.destroy());

      sock.on('connect', () => {
        conn.mgmtSocket = sock;
        sock.setTimeout(0); // no timeout after connect
        resolve();
      });

      sock.on('data', data => {
        conn.mgmtBuf += data.toString();
        let nl;
        while ((nl = conn.mgmtBuf.indexOf('\n')) !== -1) {
          const line = conn.mgmtBuf.slice(0, nl).trim();
          conn.mgmtBuf = conn.mgmtBuf.slice(nl + 1);
          this._handleMgmtLine(id, line);
        }
      });

      sock.once('connect', () => {
        sock.write('state\n');       // fetch current state
        sock.write('state on\n');    // subscribe to future state changes
        sock.write('hold release\n'); // release --management-hold so openvpn starts connecting
      });

      sock.on('error', err => {
        if (!conn.mgmtSocket) reject(err);
      });

      sock.on('close', () => {
        if (conn.mgmtSocket === sock) conn.mgmtSocket = null;
      });
    });
  }

  _handleMgmtLine(id, line) {
    if (!line || line === 'END' || line.startsWith('>INFO:') || line.startsWith('>LOG:')) return;

    const conn = this._conns[id];

    // Real-time notification: >STATE:timestamp,STATE,desc,...
    if (line.startsWith('>STATE:')) {
      const parts = line.slice(7).split(',');
      this._applyMgmtState(id, parts[1] || '', parts[2] || '');
      return;
    }

    // Dynamic challenge-response (server sends >CR_TEXT:b64flag,b64text)
    if (line.startsWith('>CR_TEXT:')) {
      const payload = line.slice(9);
      const comma   = payload.indexOf(',');
      const b64text = comma !== -1 ? payload.slice(comma + 1) : payload;
      const challenge = Buffer.from(b64text, 'base64').toString('utf8');
      this._log(id, `[mgmt] Challenge received: ${challenge}`, 'sys');
      if (conn && conn.pendingTotp && conn.mgmtSocket) {
        conn.mgmtSocket.write(`cr-response ${conn.pendingTotp}\n`);
        this._log(id, '[mgmt] Sent TOTP as challenge response', 'sys');
        conn.pendingTotp = null;
      } else {
        this._log(id, '[mgmt] Challenge received but no TOTP available — reconnect with TOTP', 'err');
      }
      return;
    }

    // Password request via management socket
    if (line.startsWith('>PASSWORD:')) {
      this._log(id, `[mgmt] ${line}`, 'sys');
      return;
    }

    // Response to `state` command: timestamp,STATE,desc,...  (no >STATE: prefix)
    const m = line.match(/^\d+,([A-Z_]+),(.*)/);
    if (m) {
      this._applyMgmtState(id, m[1], m[2]);
      return;
    }

    // Log anything else unrecognised so we can debug auth flows
    this._log(id, `[mgmt] ${line}`, 'sys');
  }

  _applyMgmtState(id, state, desc) {
    const conn = this._conns[id];
    if (!conn) return;

    switch (state) {
      case 'CONNECTED':
        conn.needsTotp = false;
        this._setStatus(id, 'connected');
        this._log(id, 'VPN connected.', 'sys');
        break;

      case 'CONNECTING':
      case 'WAIT':
      case 'AUTH':
      case 'GET_CONFIG':
      case 'ASSIGN_IP':
      case 'ADD_ROUTES':
      case 'RESOLVE':
        if (conn.status !== 'connecting') this._setStatus(id, 'connecting');
        break;

      case 'RECONNECTING':
        this._setStatus(id, 'connecting');
        this._log(id, `Reconnecting (${desc})…`, 'sys');
        break;

      case 'EXITING':
        // Process will exit — handled by proc 'close' event
        break;
    }
  }

  // ── Stdout parsing ───────────────────────────────────────────────────────────

  _parseStdout(id, line) {
    const conn = this._conns[id];
    if (!conn) return;

    // Capture auth-token from server push so we can reconnect without TOTP
    const tokenMatch = line.match(/auth-token[= ](\S+)/i);
    if (tokenMatch) {
      conn.authToken = tokenMatch[1];
      conn.needsTotp = false;
      this._log(id, '✓ Session token cached — reconnects will not need TOTP', 'sys');
      return;
    }

    // Fallback: detect connected from stdout if management socket missed it
    if (/Initialization Sequence Completed/.test(line)) {
      conn.needsTotp = false;
      if (conn.status !== 'connected') {
        this._setStatus(id, 'connected');
        this._log(id, 'VPN connected.', 'sys');
      }
    }

    // Auth failure
    if (/AUTH_FAILED|AUTH: Received AUTH_FAILED|auth-failure/.test(line)) {
      conn.authToken = null;
      conn.needsTotp = true;
      this._setStatus(id, 'error');
      this._log(id, 'Authentication failed — enter TOTP and reconnect.', 'err');
      this.emit('auth_failed', id);
    }

    // sudo not configured
    if (/sudo: a password is required/.test(line)) {
      this._setStatus(id, 'error');
      this._log(id, 'sudo NOPASSWD not configured — run the Setup command below.', 'err');
      this.emit('needs_setup', id);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  _lineLevel(line) {
    if (/error|failed|fatal/i.test(line)) return 'err';
    if (/warn|WARNING/i.test(line)) return 'warn';
    if (/Initialization Sequence Completed|VPN connected|Session token/.test(line)) return 'sys';
    return 'out';
  }

  _setStatus(id, status) {
    const conn = this._conns[id];
    if (!conn || conn.status === status) return;
    conn.status = status;
    this.emit('status', id, this._pub(id));
  }

  _log(id, text, level = 'out') {
    const conn = this._conns[id];
    if (!conn) return;
    const entry = { ts: Date.now(), text, level };
    conn.logs.push(entry);
    if (conn.logs.length > 300) conn.logs.shift();
    this.emit('log', id, entry);
  }

  _pub(id) {
    const env  = this._config.environments.find(e => e.id === id);
    const conn = this._conns[id];
    return {
      id,
      name:           env?.name    || id,
      configFile:     env?.configFile || '',
      hasCredentials: !!(env?.username && env?.password),
      status:         conn?.status  || 'disconnected',
      needsTotp:      conn?.needsTotp ?? true,
    };
  }
}

module.exports = VpnManager;
