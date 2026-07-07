const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // control window
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  getWindows: () => ipcRenderer.invoke('get-windows'),
  connect: (cfg) => ipcRenderer.send('connect', cfg),

  // overlay window
  disconnect: () => ipcRenderer.send('disconnect'),
  wsSend: (obj) => ipcRenderer.send('ws-send', obj),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  overlayReady: () => ipcRenderer.send('overlay-ready'),

  onWsMessage: (cb) => ipcRenderer.on('ws-message', (_e, data) => cb(data)),
  onConn: (cb) => ipcRenderer.on('conn', (_e, data) => cb(data)),
  onRegionUpdate: (cb) => ipcRenderer.on('region-update', (_e, data) => cb(data)),
});
