'use strict';

const path = require('path');
const fs   = require('fs');

const PROJECTS_DIR = path.resolve(__dirname, '..');

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

// ── Port detection (vite config → script --port flag) ──────────────────────────
// Skips .env PORT= — commonly a shared template value and unreliable.
// Set the real port in vite.config, the npm script, or .ssm.json.
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

  return null;
}

// ── Per-project overrides via .ssm.json ────────────────────────────────────────
// Place a .ssm.json in a project folder to override any auto-detected value.
// Example:  { "port": 3001, "name": "Soco Public API" }
// Supported keys: port, name, type, cmd, args, note
function loadOverrides(dir) {
  const file = path.join(dir, '.ssm.json');
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return {}; }
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

      const overrides = loadOverrides(dir);
      const type      = overrides.type || inferType(id);
      const isWorker  = type === 'worker';

      const { cmd, args } = isWorker
        ? { cmd: null, args: [] }
        : (() => {
            if (overrides.cmd) return { cmd: overrides.cmd, args: overrides.args || [] };
            return inferCmd(pkg.scripts);
          })();

      // Skip library/utility packages with no runnable command and no override
      if (!isWorker && !cmd) return null;

      const port = isWorker ? null : (overrides.port ?? inferPort(dir, pkg.scripts));

      return {
        id,
        name: overrides.name || formatName(id, pkg),
        type,
        port,
        cmd,
        args,
        ...(overrides.note != null
          ? { note: overrides.note }
          : isWorker
            ? { note: 'No unified entry point — launch individual worker scripts manually.' }
            : {}),
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

  const overrides = loadOverrides(dir);
  const type      = overrides.type || inferType(id);
  const isWorker  = type === 'worker';

  const { cmd, args } = isWorker
    ? { cmd: null, args: [] }
    : (() => {
        if (overrides.cmd) return { cmd: overrides.cmd, args: overrides.args || [] };
        return inferCmd(pkg.scripts);
      })();

  if (!isWorker && !cmd) return null;

  const port = isWorker ? null : (overrides.port ?? inferPort(dir, pkg.scripts));

  return {
    id,
    name: overrides.name || formatName(id, pkg),
    type,
    port,
    cmd,
    args,
    ...(overrides.note != null
      ? { note: overrides.note }
      : isWorker
        ? { note: 'No unified entry point — launch individual worker scripts manually.' }
        : {}),
  };
}

module.exports = { SERVICES, PROJECTS_DIR, discoverOne };
