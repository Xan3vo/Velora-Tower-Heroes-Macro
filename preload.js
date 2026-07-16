const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_, action) => cb(action)),
  runScript: (action, map, difficulty, resolution) => ipcRenderer.send('run-script', action, map, difficulty, resolution),
  onStatus: (cb) => ipcRenderer.on('status-update', (_, status) => cb(status)),
  onStats: (cb) => ipcRenderer.on('stats-update', (_, stats) => cb(stats)),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  launchInspector: () => ipcRenderer.send('launch-inspector'),
  testWebhook: (url) => ipcRenderer.invoke('test-webhook', url),
  getLifetimeStats: () => ipcRenderer.invoke('get-lifetime-stats'),
  getOcrDefaults: () => ipcRenderer.invoke('get-ocr-defaults'),
  testOcrRegion: (region) => ipcRenderer.invoke('test-ocr-region', region),
});