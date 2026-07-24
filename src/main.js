// Electron main process.
//
// Owns the single shared WebSocket connection and both windows:
//   • control window  - normal, interactive setup dialog (server/room/role/monitor)
//   • overlay window   - transparent, always-on-top, click-through annotation surface
//
// The overlay is a "dumb" renderer: it draws shapes and emits local draw events.
// Main is the pipe between the overlay and the sync server.

const { app, BrowserWindow, ipcMain, screen, Menu, dialog, desktopCapturer, nativeImage, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
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
let controlContentWidth = null; // locked so repeated auto-fits can't drift the width
let overlayWin = null;
let ws = null;
let cfg = null; // last connect config
let tracker = null; // child process streaming the shared window's bounds
let lastPhysRegion = null; // most recent physical window rect (for re-push on ready)

// ---- persisted settings (e.g. custom screenshot folder) ----
let appConfig = {};
function configFile() { return path.join(app.getPath('userData'), 'config.json'); }
function loadConfig() { try { appConfig = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { appConfig = {}; } }
function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(appConfig));
  } catch {}
}
const DEFAULT_SERVER = 'ws://localhost:4321';
function screenshotDir() {
  return appConfig.screenshotDir || path.join(app.getPath('pictures'), 'Screenshare Annotate');
}
function serverUrl() { return appConfig.serverUrl || DEFAULT_SERVER; }

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
  controlContentWidth = null; // re-measure once for this window
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
    // Non-activating (WS_EX_NOACTIVATE): the overlay receives mouse input for
    // drawing/aligning but never steals foreground focus - so the app underneath
    // (Discord) stays focused and doesn't pause its stream preview.
    focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // "screen-saver" level keeps it above most things incl. fullscreen apps.
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true, { forward: true }); // start click-through

  // Windows multi-monitor DPI fix: at construction Electron sizes the window
  // using the PRIMARY display's scale factor, so on a secondary monitor with a
  // different DPI the overlay ends up smaller/larger than the screen (dead
  // strips you can't draw on). Re-applying the bounds once the window is parented
  // to the target monitor forces the correct per-monitor conversion.
  const coverDisplay = () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setBounds(b);
  };
  coverDisplay();
  overlayWin.once('ready-to-show', coverDisplay);
  overlayWin.webContents.once('did-finish-load', coverDisplay);

  overlayWin.loadFile(path.join(__dirname, 'overlay', 'overlay.html'), { search });
  // Guard against a replaced session: when we switch sessions we close the old
  // overlay and immediately open a new one. The OLD window's 'closed' fires
  // afterwards, so only clear the reference if it still points at THIS window
  // (otherwise it would null out the new overlay and leave it uncontrollable).
  const thisWin = overlayWin;
  overlayWin.on('closed', () => {
    if (overlayWin === thisWin) overlayWin = null;
    stopTracker();
  });
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
// Capture a region of the overlay's display (which shows the shared content +
// our annotations) and save it as a PNG in Pictures/Screenshare Annotate.
// `region` is in DIP relative to the overlay window (= its display's top-left).
ipcMain.handle('capture-screenshot', async (_e, region) => {
  try {
    if (!overlayWin || overlayWin.isDestroyed()) return { error: 'no overlay' };
    const display = screen.getDisplayMatching(overlayWin.getBounds());
    const sf = display.scaleFactor || 1;
    const full = {
      width: Math.round(display.size.width * sf),
      height: Math.round(display.size.height * sf),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src) return { error: 'no screen source' };

    let img = src.thumbnail; // NativeImage at physical resolution of the display
    const crop = {
      x: Math.max(0, Math.round(region.x * sf)),
      y: Math.max(0, Math.round(region.y * sf)),
      width: Math.round(region.w * sf),
      height: Math.round(region.h * sf),
    };
    if (crop.width > 0 && crop.height > 0) img = img.crop(crop);
    if (img.isEmpty()) return { error: 'empty capture' };
    const png = img.toPNG();
    if (!png || png.length === 0) return { error: 'encode failed' };

    const dir = screenshotDir();
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
    const file = path.join(dir, `screenshare-annotate-${ts}.png`);
    // Write to a temp file then rename - an atomic swap, so Explorer / OneDrive /
    // antivirus never see a half-written file (a real cause of "no thumbnail").
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, file);
    return { path: file, dir };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

ipcMain.on('open-path', (_e, p) => { if (p) shell.showItemInFolder(p); });

ipcMain.handle('get-screenshot-dir', () => ({ dir: screenshotDir() }));
ipcMain.handle('choose-screenshot-dir', async () => {
  const parent = controlWin && !controlWin.isDestroyed() ? controlWin : null;
  const res = await dialog.showOpenDialog(parent, {
    title: 'Choose screenshot folder',
    defaultPath: screenshotDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { dir: screenshotDir() };
  appConfig.screenshotDir = res.filePaths[0];
  saveConfig();
  return { dir: appConfig.screenshotDir };
});

ipcMain.on('set-control-height', (_e, h) => {
  if (controlWin && !controlWin.isDestroyed()) {
    // Measure the width ONCE and reuse it - reading getContentSize each time and
    // writing it back drifts wider by a sub-pixel per call on high-DPI displays.
    if (controlContentWidth == null) controlContentWidth = controlWin.getContentSize()[0];
    controlWin.setContentSize(controlContentWidth, Math.max(200, Math.round(h)));
  }
});

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

function startSession(config) {
  cfg = config;
  stopTracker();          // ensure no old tracker survives
  lastPhysRegion = null;  // and no stale window bounds leak into a new session
  if (controlWin && !controlWin.isDestroyed()) controlWin.hide();
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close(); // replace any prior session

  const common = `name=${encodeURIComponent(config.name || '')}` +
    `&room=${encodeURIComponent(config.room || '')}` +
    `&server=${encodeURIComponent(config.serverUrl || serverUrl())}`;

  if (config.role === 'share' && config.shareType === 'window') {
    // Overlay is placed on whichever display the window is currently on; the
    // tracker keeps the region glued to the window as it moves/resizes.
    const win = config.window;
    const dip = screen.screenToDipRect(null, { x: win.x, y: win.y, width: win.w, height: win.h });
    const display = screen.getDisplayMatching(dip);
    createOverlay(display, `role=share&shareType=window&${common}`);
    startTracker(win.handle);
  } else {
    const display = findDisplay(config.displayId);
    const shareType = config.role === 'share' ? 'screen' : 'view';
    createOverlay(display, `role=${config.role}&shareType=${shareType}&inset=${config.inset || 0}&${common}`);
  }
  // ws connect happens once the overlay signals it is ready (see 'overlay-ready').
}
ipcMain.on('connect', (_e, config) => startSession(config));

ipcMain.handle('get-config', () => ({
  username: appConfig.username || '',
  serverUrl: serverUrl(),
  screenshotDir: screenshotDir(),
}));
ipcMain.on('set-config', (_e, partial) => {
  if (!partial || typeof partial !== 'object') return;
  if ('username' in partial) appConfig.username = partial.username;
  if ('serverUrl' in partial) appConfig.serverUrl = partial.serverUrl;
  saveConfig();
});

ipcMain.on('copy-text', (_e, text) => { if (text) clipboard.writeText(String(text)); });

// screenshare-annotate://join?room=NAME  -> join that room as a viewer, default monitor.
function handleDeepLink(url) {
  let room = null;
  try { room = new URL(url).searchParams.get('room'); } catch {}
  if (!room) return;
  startSession({
    serverUrl: serverUrl(),
    room,
    name: appConfig.username || 'anon',
    role: 'view',
    displayId: screen.getPrimaryDisplay().id,
  });
}

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
    // Capturing the mouse drops WS_EX_TRANSPARENT, which makes Chromium (Discord)
    // treat the overlay as occluding and pause the stream preview. Sub-1.0 opacity
    // makes the window "not fully opaque," which Chromium's occlusion tracker
    // skips - keeping Discord's preview live while drawing. (Verified fix.)
    overlayWin.setOpacity(ignore ? 1 : 0.99);
  }
});

// The overlay is normally non-focusable (so it never steals Discord's focus).
// The text tool needs the keyboard, so we briefly re-enable focus while typing,
// then drop it again - releasing focus back toward whatever was underneath.
ipcMain.on('set-focusable', (_e, focusable) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setFocusable(focusable);
  if (focusable) overlayWin.focus();
  else overlayWin.blur();
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

// ---- deep links (screenshare-annotate://) + single instance ----

const PROTOCOL = 'screenshare-annotate';
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// One instance per user-data dir (profiles keep dev share+view separate). A
// second launch (e.g. clicking a join link) routes its URL to the running one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', (_e, argv) => {
  const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (url) { handleDeepLink(url); return; }
  if (controlWin && !controlWin.isDestroyed()) {
    if (controlWin.isMinimized()) controlWin.restore();
    controlWin.show(); controlWin.focus();
  }
});

// ---- lifecycle ----

app.whenReady().then(() => {
  if (!gotLock) return;
  loadConfig();
  const launchUrl = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (launchUrl) handleDeepLink(launchUrl); // launched by clicking a join link
  else createControl();
  if (app.isPackaged) setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControl();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
