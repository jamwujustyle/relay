const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', Object.freeze({
  loadWorkspace: () => ipcRenderer.invoke('relay:load-workspace'),
  saveWorkspace: workspace => ipcRenderer.invoke('relay:save-workspace', workspace),
  getSettings: () => ipcRenderer.invoke('relay:get-settings'),
  saveSettings: settings => ipcRenderer.invoke('relay:save-settings', settings),
  runAI: request => ipcRenderer.invoke('relay:run-ai', request),
  readClipboard: () => ipcRenderer.invoke('relay:read-clipboard'),
  writeClipboard: text => ipcRenderer.invoke('relay:write-clipboard', text),
  openExternal: url => ipcRenderer.invoke('relay:open-external', url),
  onAction: callback => {
    if (typeof callback !== 'function') throw new TypeError('Action callback must be a function.');
    const listener = (_event, action) => { if (action === 'capture' || action === 'next') callback(action); };
    ipcRenderer.on('relay:action', listener);
    ipcRenderer.send('relay:action-ready');
    return () => ipcRenderer.removeListener('relay:action', listener);
  },
}));
