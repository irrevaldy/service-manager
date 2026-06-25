'use strict';

const path = require('path');
const fs   = require('fs');

const PROJECTS_DIR = process.env.SSM_PROJECTS_DIR || path.resolve(__dirname, '..');

// Directories to never treat as services
const SKIP = new Set(['service-manager', 'node_modules', '.git', '.github']);

// ── Type inference from folder name ────────────────────────────────────────────
function inferType(id) {
  if (/workers$/.test(id))      return 'worker';    // workers, catalog-workers, b2b-workers
  if (/^analytics-/.test(id))   return 'analytics'; // analytics-api
  if (/-web$|-admin$/.test(id)) return 'frontend';  // *-web, *-admin
  if (/^soco-/.test(id))        return 'frontend';  // soco-central-login
  if (/^b2b-/.test(id))         return 'b2b';       // b2b-api, b2b-ms-*
  return 'api';                                      // everything else
}

// ── Start command from package.json scripts (dev → serve → start) ──────────────
function inferCmd(scripts) {
  for (const s of ['dev', 'serve', 'start']) {
    if (scripts?.[s]) return { cmd: 'npm', args: ['run', s] };
  }
  return { cmd: null, args: [] };
}

// ── Port detection (vite config → script --port flag → env var) ────────────────
function inferPort(dir, scripts) {
  // 1. vite.config.js / vite.config.ts server.port
  for (const name of ['vite.config.js', 'vite.config.ts']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      const m = fs.readFileSync(file, 'utf8').match(/\bport\s*:\s*(\d+)/);
      if (m) return parseInt(m[1]);
    }
  }

  // 2. --port flag in any package.json script
  for (const val of Object.values(scripts || {})) {
    const m = val?.match(/--port[= ](\d+)/i);
    if (m) return parseInt(m[1]);
  }

  // 3. process.env.SOMETHING_PORT referenced in service code → read from shared .env
  const envPort = inferPortFromEnvVar(dir);
  if (envPort) return envPort;

  return null;
}

// Finds which env var the service uses for its port, then reads it from the shared .env.
function inferPortFromEnvVar(dir) {
  // Config files first (dedicated port config), server files last (may reference infra ports like REDIS)
  const candidates = [
    path.join(dir, 'app', 'config', 'secret.js'),
    path.join(dir, 'src', 'config', 'secret.js'),
    path.join(dir, 'config', 'secret.js'),
    path.join(dir, 'src', 'server.ts'),
    path.join(dir, 'src', 'server.js'),
    path.join(dir, 'server.js'),
  ];

  // Infrastructure port vars that appear in service code but aren't the service's own port
  const INFRA_PORT_RE = /^(REDIS|DB|DWH|ODOO|SMTP|MONGO)_/;

  const envFile = path.join(path.dirname(dir), '.env');
  let envContent = null;
  if (fs.existsSync(envFile)) {
    try { envContent = fs.readFileSync(envFile, 'utf8'); } catch (_) {}
  }

  // Strategy A: find process.env.*_PORT in service code, look it up in shared .env
  if (envContent) {
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const content = fs.readFileSync(file, 'utf8');
        const m = content.match(/process\.env\.([A-Z][A-Z0-9_]*_PORT\b)/);
        if (!m) continue;
        const varName = m[1];
        if (INFRA_PORT_RE.test(varName)) continue;
        const pm = envContent.match(new RegExp(`^${varName}\\s*=\\s*(\\d+)`, 'm'));
        if (pm) return parseInt(pm[1]);
      } catch (_) {}
    }
  }

  // Strategy B: slug-based substring match against shared .env (fallback for hardcoded configs)
  if (envContent) {
    const slug = path.basename(dir).toUpperCase().replace(/-/g, '_');
    const pm = envContent.match(new RegExp(`^[A-Z_]*${slug}[A-Z_]*_PORT\\s*=\\s*(\\d+)`, 'm'));
    if (pm) return parseInt(pm[1]);
  }

  return null;
}

// ── Human-readable name ────────────────────────────────────────────────────────
// Prefer package.json "description" if it looks like a real one,
// then strip scope from "name", then fall back to folder id.
function formatName(id, pkg) {
  const desc = pkg.description;
  const usable = desc && desc.length <= 60 && !/this readme/i.test(desc);
  if (usable) return desc;
  const pkgName = (pkg.name || id).replace(/^@[^/]+\//, ''); // strip @scope/
  return pkgName.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Per-service overrides ──────────────────────────────────────────────────────
// afterStartTrigger: when a log line matches `match`, send `keys` to the terminal.
// Expo (b2b-apps) shows an interactive menu — we auto-press 'w' to open the web build.
// afterStartKeys: keys sent to the terminal once the service transitions to 'running'.
// For no-port services (Expo) this fires after the 10s assumed-running timer.
// For port-based services it fires when the port comes up.
const OVERRIDES = {
  'b2b-apps': {
    afterStartKeys: ['w'],
  },
  // AdonisJS v4 project — `adonis` CLI is not installed globally/locally,
  // so `npm run dev` (adonis serve --dev) always fails. Use npm start instead.
  'wms-api': {
    cmd: 'npm',
    args: ['start'],
  },
  // node_modules not installed — auto-install before serving.
  // Moved off 8081 (conflicts with b2b-apps Metro bundler).
  'hrms-web': {
    cmd: 'npm install && node_modules/.bin/vue-cli-service serve --port 8084',
    args: [],
    port: 8084,
  },
  // Moved off 8081 (conflicts with b2b-apps Metro bundler and hrms-web).
  // 8083 is SSO server, 8085 is planogram-web — using 8086 instead.
  // Call vue-cli-service directly to avoid duplicate --port flags from the script.
  'sociolla-admin': {
    cmd: 'node_modules/.bin/vue-cli-service serve --port 8086',
    args: [],
    port: 8086,
  },
};

// ── Discovery ──────────────────────────────────────────────────────────────────
const TYPE_ORDER = { api: 0, analytics: 1, b2b: 2, worker: 3, frontend: 4 };

function discover() {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
    .map(e => {
      const id  = e.name;
      const dir = path.join(PROJECTS_DIR, id);

      const pkgFile = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgFile)) return null;

      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); }
      catch (_) { return null; }

      const type     = inferType(id);
      const isWorker = type === 'worker';

      const { cmd, args } = isWorker ? { cmd: null, args: [] } : inferCmd(pkg.scripts);

      // Skip library/utility packages with no runnable command
      if (!isWorker && !cmd) return null;

      const port = isWorker ? null : inferPort(dir, pkg.scripts);

      return {
        id,
        name: formatName(id, pkg),
        type,
        port,
        cmd,
        args,
        ...(isWorker ? { note: 'No unified entry point — launch individual worker scripts manually.' } : {}),
        ...(OVERRIDES[id] || {}),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const td = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99);
      return td !== 0 ? td : a.id.localeCompare(b.id);
    });
}

const SERVICES = discover();

// Discover a single directory by name — used for hot-adding newly cloned repos.
function discoverOne(id) {
  if (SKIP.has(id) || id.startsWith('.')) return null;
  const dir = path.join(PROJECTS_DIR, id);

  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) return null;

  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); }
  catch (_) { return null; }

  const type     = inferType(id);
  const isWorker = type === 'worker';

  const { cmd, args } = isWorker ? { cmd: null, args: [] } : inferCmd(pkg.scripts);

  if (!isWorker && !cmd) return null;

  const port = isWorker ? null : inferPort(dir, pkg.scripts);

  return {
    id,
    name: formatName(id, pkg),
    type,
    port,
    cmd,
    args,
    ...(isWorker ? { note: 'No unified entry point — launch individual worker scripts manually.' } : {}),
    ...(OVERRIDES[id] || {}),
  };
}

module.exports = { SERVICES, PROJECTS_DIR, discoverOne };
