// Electron main process.
//
// Owns the single shared WebSocket connection and both windows:
//   • control window  - normal, interactive setup dialog (server/room/role/monitor)
//   • overlay window   - transparent, always-on-top, click-through annotation surface
//
// The overlay is a "dumb" renderer: it draws shapes and emits local draw events.
// Main is the pipe between the overlay and the sync server.

const { app, BrowserWindow, ipcMain, screen, Menu, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { autoUpdater } = require('electron-updater');

// In a packaged build the app is inside app.asar; child_process can't execute a
// script from within the archive, so these are unpacked (asarUnpack) and we
// point at app.asar.unpacked. In dev the path has no "app.asar", so it's a no-op.
const WIN_DIR = path.join(__dirname, 'win').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

app.setName('Screenshare Annotate');
Menu.setApplicationMenu(null); // no File/Edit/View menu bar

// Give each named profile its own user-data dir so multiple instances (e.g. a
// sharer and a viewer on one machine for testing) don't fight over the cache.
// `npm run share` / `npm run view` pass --profile=...
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1] : null;
if (profile) {
  app.setPath('userData', path.join(app.getPath('appData'), `discord-annotate-${profile}`));
}

let controlWin = null;
let overlayWin = null;
let ws = null;
let cfg = null; // last connect config
let tracker = null; // child process streaming the shared window's bounds
let lastPhysRegion = null; // most recent physical window rect (for re-push on ready)

function createControl() {
  controlWin = new BrowserWindow({
    width: 480,
    height: 640,
    resizable: false,
    title: 'Screenshare Annotate',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  controlWin.loadFile(path.join(__dirname, 'control', 'control.html'));
  controlWin.on('closed', () => { controlWin = null; });
}

function findDisplay(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
}

function createOverlay(display, search) {
  const b = display.bounds;
  overlayWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // "screen-saver" level keeps it above most things incl. fullscreen apps.
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true, { forward: true }); // start click-through
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'overlay.html'), { search });
  overlayWin.on('closed', () => { overlayWin = null; stopTracker(); });
}

function runPowerShell(scriptFile, args = []) {
  return spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(WIN_DIR, scriptFile), ...args,
  ], { windowsHide: true });
}

// Convert a physical-pixel window rect into an overlay-relative DIP region and
// push it to the overlay, moving the overlay to the window's display if needed.
function pushWindowRegion(phys) {
  lastPhysRegion = phys;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const dip = screen.screenToDipRect(null, {
    x: phys.x, y: phys.y, width: phys.w, height: phys.h,
  });
  const display = screen.getDisplayMatching(dip);
  const cur = overlayWin.getBounds();
  if (cur.x !== display.bounds.x || cur.y !== display.bounds.y ||
      cur.width !== display.bounds.width || cur.height !== display.bounds.height) {
    overlayWin.setBounds(display.bounds);
  }
  toOverlay('region-update', {
    x: dip.x - display.bounds.x,
    y: dip.y - display.bounds.y,
    w: dip.width,
    h: dip.height,
    visible: phys.visible,
  });
}

function startTracker(hwnd) {
  stopTracker();
  lastPhysRegion = null;
  tracker = runPowerShell('track.ps1', ['-Hwnd', String(hwnd)]);
  let buf = '';
  tracker.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      if (line === 'GONE') { toOverlay('region-update', { gone: true }); continue; }
      const p = line.split(/\s+/).map(Number);
      if (p.length >= 4 && p.every((n) => !Number.isNaN(n))) {
        pushWindowRegion({ x: p[0], y: p[1], w: p[2], h: p[3], visible: p[4] !== 0 });
      }
    }
  });
}

function stopTracker() {
  if (tracker) { try { tracker.kill(); } catch {} tracker = null; }
}

function toOverlay(channel, payload) {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, payload);
}

function connectWS() {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  ws = new WebSocket(cfg.serverUrl);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', room: cfg.room, role: cfg.role, name: cfg.name }));
    toOverlay('conn', { status: 'connected' });
  });
  ws.on('message', (data) => toOverlay('ws-message', data.toString()));
  ws.on('close', () => toOverlay('conn', { status: 'disconnected' }));
  ws.on('error', (err) => toOverlay('conn', { status: 'error', message: String(err.message || err) }));
}

// ---- IPC ----

ipcMain.handle('get-displays', () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `Monitor ${i + 1} - ${d.bounds.width}×${d.bounds.height}${d.id === primaryId ? ' (primary)' : ''}`,
  }));
});

// List selectable application windows (physical-pixel bounds).
ipcMain.handle('get-windows', () => new Promise((resolve) => {
  const ps = runPowerShell('enumerate.ps1');
  let out = '';
  ps.stdout.on('data', (d) => { out += d.toString(); });
  ps.on('close', () => {
    try { resolve(JSON.parse(out.trim() || '[]')); }
    catch { resolve([]); }
  });
  ps.on('error', () => resolve([]));
}));

ipcMain.on('connect', (_e, config) => {
  cfg = config;
  stopTracker();          // ensure no old tracker survives
  lastPhysRegion = null;  // and no stale window bounds leak into a new session
  if (controlWin) controlWin.hide();

  const nameParam = `name=${encodeURIComponent(config.name)}`;
  if (config.role === 'share' && config.shareType === 'window') {
    // Overlay is placed on whichever display the window is currently on; the
    // tracker keeps the region glued to the window as it moves/resizes.
    const win = config.window;
    const dip = screen.screenToDipRect(null, { x: win.x, y: win.y, width: win.w, height: win.h });
    const display = screen.getDisplayMatching(dip);
    createOverlay(display, `role=share&shareType=window&${nameParam}`);
    startTracker(win.handle);
  } else {
    const display = findDisplay(config.displayId);
    const shareType = config.role === 'share' ? 'screen' : 'view';
    createOverlay(display, `role=${config.role}&shareType=${shareType}&inset=${config.inset || 0}&${nameParam}`);
  }
  // ws connect happens once the overlay signals it is ready (see 'overlay-ready').
});

ipcMain.on('overlay-ready', () => {
  connectWS();
  // Re-push the window region now that the overlay's listener is live (the very
  // first tracker emit may have arrived before the page finished loading).
  // Only for window shares - a screen share must never adopt a tracked region.
  if (cfg && cfg.role === 'share' && cfg.shareType === 'window' && lastPhysRegion) {
    pushWindowRegion(lastPhysRegion);
  }
});

ipcMain.on('disconnect', () => {
  stopTracker();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  if (!controlWin) createControl();
  else controlWin.show();
});

ipcMain.on('ws-send', (_e, obj) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
});

ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

// ---- auto-update (packaged builds only) ----

function setupAutoUpdate() {
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      title: 'Update ready',
      message: `Screenshare Annotate ${info.version} is ready.`,
      detail: 'Restart to finish updating.',
    }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', (e) => console.error('auto-update error:', e == null ? 'unknown' : e.message));
  autoUpdater.checkForUpdates().catch(() => {});
}

// ---- lifecycle ----

app.whenReady().then(() => {
  createControl();
  if (app.isPackaged) setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControl();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
