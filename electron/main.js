'use strict';

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow = null;
let serverShutdown = null;

// ── Config ────────────────────────────────────────────────────────────────────

function getUserDataDir() {
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadAppConfig(userDataDir) {
  const configPath = path.join(userDataDir, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    const config = {
      projectsDir: path.join(os.homedir(), 'Documents', 'Sociolla', 'Projects'),
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return config;
  }
}

function resolveVpnConfig(userDataDir, projectsDir) {
  // Prefer the original vpn.config.json already in the service-manager project dir
  const original = path.join(projectsDir, 'service-manager', 'vpn.config.json');
  if (fs.existsSync(original)) return original;

  // Fall back to userData (create empty if missing)
  const userData = path.join(userDataDir, 'vpn.config.json');
  if (!fs.existsSync(userData)) {
    fs.writeFileSync(userData, JSON.stringify({ environments: [] }, null, 2));
  }
  return userData;
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'Service Manager',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL('http://localhost:9999');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open <a target="_blank"> links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

function showPortConflictDialog() {
  dialog.showMessageBox({
    type: 'warning',
    title: 'Service Manager Already Running',
    message: 'Service Manager is already running in a terminal.',
    detail: 'Please stop the terminal process first by pressing Ctrl+C where "node server.js" is running, then reopen the app.',
    buttons: ['OK'],
  }).then(() => app.quit()).catch(() => app.quit());
}

// Catch EADDRINUSE before Electron shows its crash dialog
process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    showPortConflictDialog();
  } else {
    dialog.showErrorBox('Unexpected Error', err.stack || err.message || String(err));
    app.quit();
  }
});

app.whenReady().then(() => {
  const userDataDir = getUserDataDir();
  const appConfig = loadAppConfig(userDataDir);

  if (!fs.existsSync(appConfig.projectsDir)) {
    console.warn(`[service-manager] projectsDir not found: ${appConfig.projectsDir}`);
    console.warn(`[service-manager] Edit ${path.join(userDataDir, 'config.json')} to fix this.`);
  }

  // Must be set before requiring server.js — services.config.js reads it at require time
  process.env.SSM_PROJECTS_DIR = appConfig.projectsDir;

  const vpnConfigPath = resolveVpnConfig(userDataDir, appConfig.projectsDir);

  buildMenu();

  const { startServer } = require('../server');
  const { shutdown } = startServer({
    vpnConfigPath,
    onListening: createWindow,
    onPortConflict: showPortConflictDialog,
  });
  serverShutdown = shutdown;
});

// On macOS keep the app running when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('before-quit', () => {
  if (serverShutdown) serverShutdown();
});
