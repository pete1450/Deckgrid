'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // OBS connection
  obsConnect: (settings) => ipcRenderer.invoke('obs:connect', settings),
  obsDisconnect: () => ipcRenderer.invoke('obs:disconnect'),

  // OBS scene operations
  obsGetScenes: () => ipcRenderer.invoke('obs:getScenes'),
  obsGetCurrentScene: () => ipcRenderer.invoke('obs:getCurrentScene'),
  obsSetCurrentScene: (sceneName) => ipcRenderer.invoke('obs:setCurrentScene', { sceneName }),
  obsSetCurrentPreviewScene: (sceneName) => ipcRenderer.invoke('obs:setCurrentPreviewScene', { sceneName }),

  // OBS source operations
  obsGetSourcesForScene: (sceneName) => ipcRenderer.invoke('obs:getSourcesForScene', sceneName),
  obsToggleSceneItem: (data) => ipcRenderer.invoke('obs:toggleSceneItem', data),
  obsGetSceneItemEnabled: (data) => ipcRenderer.invoke('obs:getSceneItemEnabled', data),

  // OBS studio mode
  obsTriggerStudioModeTransition: () => ipcRenderer.invoke('obs:triggerStudioModeTransition'),
  obsGetStudioModeEnabled: () => ipcRenderer.invoke('obs:getStudioModeEnabled'),

  // File picker
  selectImage: () => ipcRenderer.invoke('dialog:selectImage'),

  // Config store
  storeGet: (key) => ipcRenderer.invoke('store:get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),

  // OBS event subscriptions — each returns an unsubscribe function
  onObsCurrentSceneChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('obs:currentSceneChanged', handler);
    return () => ipcRenderer.removeListener('obs:currentSceneChanged', handler);
  },
  onObsSceneItemEnableStateChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('obs:sceneItemEnableStateChanged', handler);
    return () => ipcRenderer.removeListener('obs:sceneItemEnableStateChanged', handler);
  },
  onObsStudioModeStateChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('obs:studioModeStateChanged', handler);
    return () => ipcRenderer.removeListener('obs:studioModeStateChanged', handler);
  },
  onObsConnectionClosed: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('obs:connectionClosed', handler);
    return () => ipcRenderer.removeListener('obs:connectionClosed', handler);
  },

  // Remote control WebSocket server
  remoteStartServer: (port) => ipcRenderer.invoke('remote:startServer', port),
  remoteStopServer: () => ipcRenderer.invoke('remote:stopServer'),
  remoteGetStatus: () => ipcRenderer.invoke('remote:getStatus'),
  remotePushConfig: (config) => ipcRenderer.invoke('remote:pushConfig', config),

  // Remote control event subscriptions — each returns an unsubscribe function
  onRemoteClientConnected: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('remote:clientConnected', handler);
    return () => ipcRenderer.removeListener('remote:clientConnected', handler);
  },
  onRemoteClientDisconnected: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('remote:clientDisconnected', handler);
    return () => ipcRenderer.removeListener('remote:clientDisconnected', handler);
  },
  onRemoteButtonPressed: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('remote:buttonPressed', handler);
    return () => ipcRenderer.removeListener('remote:buttonPressed', handler);
  },
  onRemoteServerStopped: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('remote:serverStopped', handler);
    return () => ipcRenderer.removeListener('remote:serverStopped', handler);
  },
});
