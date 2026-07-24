const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // control window
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  getWindows: () => ipcRenderer.invoke('get-windows'),
  setControlHeight: (h) => ipcRenderer.send('set-control-height', h),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (partial) => ipcRenderer.send('set-config', partial),
  chooseScreenshotDir: () => ipcRenderer.invoke('choose-screenshot-dir'),
  connect: (cfg) => ipcRenderer.send('connect', cfg),

  // overlay window
  disconnect: () => ipcRenderer.send('disconnect'),
  wsSend: (obj) => ipcRenderer.send('ws-send', obj),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  setFocusable: (f) => ipcRenderer.send('set-focusable', f),
  captureScreenshot: (region) => ipcRenderer.invoke('capture-screenshot', region),
  copyText: (text) => ipcRenderer.send('copy-text', text),
  overlayReady: () => ipcRenderer.send('overlay-ready'),

  onWsMessage: (cb) => ipcRenderer.on('ws-message', (_e, data) => cb(data)),
  onConn: (cb) => ipcRenderer.on('conn', (_e, data) => cb(data)),
  onRegionUpdate: (cb) => ipcRenderer.on('region-update', (_e, data) => cb(data)),
});
