'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { OBSWebSocket } = require('obs-websocket-js');
const Store = require('electron-store').default;

const store = new Store();
const { WebSocketServer, WebSocket } = require('ws');

let mainWindow = null;
let obs = null;
let obsConnected = false;

// ─── Remote Control WebSocket Server state ────────────────────────────────────

let wss = null;
let wsPort = 8765;
let wsCurrentScene = null;
let wsStudioModeEnabled = false;
let wsConfig = null;

function _wsGetLocalIPs() {
  const ips = ['127.0.0.1'];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

function _wsBroadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function _wsCurrentState() {
  return {
    type: 'stateUpdate',
    obsConnected,
    currentScene: wsCurrentScene,
    studioModeEnabled: wsStudioModeEnabled,
  };
}

function _wsHandleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'getState':
      ws.send(JSON.stringify(_wsCurrentState()));
      break;
    case 'getConfig':
      ws.send(JSON.stringify({ type: 'configUpdate', config: wsConfig }));
      break;
    case 'pressButton':
      if (msg.key && mainWindow) {
        mainWindow.webContents.send('remote:buttonPressed', { key: msg.key });
      }
      break;
    default:
      break;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0f0f1a',
    title: 'Deckgrid',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (obs) {
      obs.disconnect().catch(() => {});
      obs = null;
    }
    if (wss) {
      wss.close();
      wss = null;
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (wss) { wss.close(); wss = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── OBS IPC Handlers ────────────────────────────────────────────────────────

ipcMain.handle('obs:connect', async (_event, { host, port, password }) => {
  try {
    if (obs) {
      await obs.disconnect().catch(() => {});
      obs = null;
    }

    obs = new OBSWebSocket();

    obs.on('CurrentProgramSceneChanged', (data) => {
      wsCurrentScene = data.sceneName;
      if (mainWindow) mainWindow.webContents.send('obs:currentSceneChanged', data);
      _wsBroadcast({ type: 'currentSceneChanged', sceneName: data.sceneName });
    });

    obs.on('SceneItemEnableStateChanged', (data) => {
      if (mainWindow) mainWindow.webContents.send('obs:sceneItemEnableStateChanged', data);
      _wsBroadcast({ type: 'sceneItemStateChanged', ...data });
    });

    obs.on('StudioModeStateChanged', (data) => {
      wsStudioModeEnabled = data.studioModeEnabled;
      if (mainWindow) mainWindow.webContents.send('obs:studioModeStateChanged', data);
      _wsBroadcast({ type: 'studioModeChanged', enabled: data.studioModeEnabled });
    });

    obs.on('ConnectionClosed', () => {
      obsConnected = false;
      if (mainWindow) mainWindow.webContents.send('obs:connectionClosed');
      _wsBroadcast({ type: 'obsConnectionChanged', connected: false });
    });

    const url = `ws://${host}:${port}`;
    await obs.connect(url, password || undefined);
    obsConnected = true;

    // Populate initial OBS state for WebSocket clients; failures are acceptable
    // here because state will be updated via events once available.
    try {
      const sceneRes = await obs.call('GetCurrentProgramScene');
      wsCurrentScene = sceneRes.currentProgramSceneName;
    } catch (_) {}
    try {
      const studioRes = await obs.call('GetStudioModeEnabled');
      wsStudioModeEnabled = studioRes.studioModeEnabled;
    } catch (_) {}

    _wsBroadcast({ type: 'obsConnectionChanged', connected: true });

    return { success: true };
  } catch (error) {
    obsConnected = false;
    if (obs) {
      obs.disconnect().catch(() => {});
      obs = null;
    }
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:disconnect', async () => {
  try {
    if (obs) {
      await obs.disconnect();
      obs = null;
      obsConnected = false;
      wsCurrentScene = null;
      wsStudioModeEnabled = false;
    }
    _wsBroadcast({ type: 'obsConnectionChanged', connected: false });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:getScenes', async () => {
  if (!obs || !obsConnected) return { success: false, error: 'Not connected' };
  try {
    const response = await obs.call('GetSceneList');
    return { success: true, scenes: response.scenes };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:getCurrentScene', async () => {
  if (!obs || !obsConnected) return { success: false, error: 'Not connected' };
  try {
    const response = await obs.call('GetCurrentProgramScene');
    return { success: true, sceneName: response.currentProgramSceneName };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:getSourcesForScene', async (_event, sceneName) => {
  if (!obs || !obsConnected) return { success: false, error: 'Not connected' };
  try {
    const response = await obs.call('GetSceneItemList', { sceneName });
    return { success: true, items: response.sceneItems };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:setCurrentScene', async (_event, { sceneName }) => {
  if (!obs || !obsConnected) return { success: false, error: 'Not connected' };
  try {
    await obs.call('SetCurrentProgramScene', { sceneName });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:setCurrentPreviewScene', async (_event, { sceneName }) => {
  if (!obs || !obsConnected) return { success: false, error: 'Not connected' };
  try {
    await obs.call('SetCurrentPreviewScene', { sceneName });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:toggleSceneItem', async (_event, { sceneName, sceneItemId }) => {
  if (!obs || !obsConnected) return { success: false, error: 'Not connected' };
  try {
    const current = await obs.call('GetSceneItemEnabled', { sceneName, sceneItemId });
    const newState = !current.sceneItemEnabled;
    await obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: newState });
    return { success: true, enabled: newState };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:getSceneItemEnabled', async (_event, { sceneName, sceneItemId }) => {
  if (!obs || !obsConnected) return { success: false, error: 'Not connected' };
  try {
    const response = await obs.call('GetSceneItemEnabled', { sceneName, sceneItemId });
    return { success: true, enabled: response.sceneItemEnabled };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:triggerStudioModeTransition', async () => {
  if (!obs || !obsConnected) return { success: false, error: 'Not connected' };
  try {
    await obs.call('TriggerStudioModeTransition');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('obs:getStudioModeEnabled', async () => {
  if (!obs || !obsConnected) return { success: false, error: 'Not connected' };
  try {
    const response = await obs.call('GetStudioModeEnabled');
    return { success: true, enabled: response.studioModeEnabled };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ─── Remote Control IPC Handlers ─────────────────────────────────────────────

ipcMain.handle('remote:startServer', async (_event, port) => {
  if (wss) return { success: false, error: 'Server already running' };
  try {
    wsPort = (port && port > 0) ? port : 8765;
    wss = new WebSocketServer({ port: wsPort });

    wss.on('connection', (ws) => {
      ws.send(JSON.stringify(_wsCurrentState()));
      if (wsConfig) {
        ws.send(JSON.stringify({ type: 'configUpdate', config: wsConfig }));
      }
      if (mainWindow) {
        mainWindow.webContents.send('remote:clientConnected', { clientCount: wss.clients.size });
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          _wsHandleClientMessage(ws, msg);
        } catch (_) {
          // Ignore malformed messages from remote clients
        }
      });

      ws.on('close', () => {
        if (mainWindow) {
          mainWindow.webContents.send('remote:clientDisconnected', { clientCount: wss ? wss.clients.size : 0 });
        }
      });

      ws.on('error', () => {
        // Individual client errors are handled by the close event
      });
    });

    wss.on('error', (err) => {
      wss = null;
      if (mainWindow) mainWindow.webContents.send('remote:serverStopped', { error: err.message });
    });

    return { success: true, port: wsPort, ips: _wsGetLocalIPs() };
  } catch (error) {
    wss = null;
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remote:stopServer', async () => {
  if (!wss) return { success: true };
  try {
    await new Promise((resolve) => wss.close(resolve));
    wss = null;
    return { success: true };
  } catch (error) {
    wss = null;
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remote:getStatus', async () => {
  return {
    success: true,
    running: !!wss,
    port: wsPort,
    clientCount: wss ? wss.clients.size : 0,
    ips: _wsGetLocalIPs(),
  };
});

ipcMain.handle('remote:pushConfig', async (_event, config) => {
  wsConfig = config;
  _wsBroadcast({ type: 'configUpdate', config: wsConfig });
  return { success: true };
});

// ─── File Dialog IPC Handler ──────────────────────────────────────────────────

ipcMain.handle('dialog:selectImage', async () => {
  if (!mainWindow) return { success: false, error: 'No window' };
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, data: null };
    }

    const filePath = result.filePaths[0];
    const fileData = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'svg' ? 'image/svg+xml'
      : ext === 'jpg' ? 'image/jpeg'
      : `image/${ext}`;
    const dataUrl = `data:${mime};base64,${fileData.toString('base64')}`;
    return { success: true, data: dataUrl };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ─── Config Store IPC Handlers ────────────────────────────────────────────────

ipcMain.handle('store:get', (_event, key) => {
  try {
    return { success: true, data: store.get(key) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('store:set', (_event, key, value) => {
  try {
    store.set(key, value);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
