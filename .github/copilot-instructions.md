# Deckgrid – Copilot Instructions

## Architecture Overview

Deckgrid is an **Electron desktop app** with a strict three-layer process boundary:

```
main.js (Node/Electron main process)
  └─ preload.js  (context bridge — the ONLY channel between processes)
       └─ renderer/app.js  (browser renderer — no Node access)
```

- **`main.js`** — owns the `OBSWebSocket` instance, all `ipcMain.handle` IPC handlers, and the Electron window. All OBS API calls happen here via `obs-websocket-js`.
- **`preload.js`** — exposes a typed `window.electronAPI` surface using `contextBridge`. Every new IPC call requires an entry here AND a handler in `main.js`.
- **`renderer/app.js`** — single `DeckGrid` class, no framework. All UI state lives in `this.*` properties. Talks to main exclusively via `window.electronAPI`.

## Key Data Structures

**Config** (persisted to `localStorage` as `deckgrid-config`):
```js
{
  rows: 3, columns: 4, zoom: 100,
  obs: { host, port, password },
  buttons: {
    "0_0": {
      action: 'scene' | 'toggleSource' | 'studioModeTransition' | null,
      actionData: { sceneName, sceneItemId, sourceName },
      inactive: { text, backgroundColor, borderColor, textColor, textPosition, icon, image },
      active:   { /* same shape */ }
    }
  }
}
```

Button grid positions are keyed `"row_col"` (e.g. `"0_2"`). Images are stored as **base64 data URLs** directly in the config.

**Runtime OBS state** (in-memory only, never persisted):
- `this.currentScene` — live program scene name
- `this.sceneItemStates` — `Map<"sceneName::sceneItemId", boolean>`
- `this.studioModeEnabled` — boolean

## Adding a New Button Action

1. Add an `ipcMain.handle('obs:yourAction', ...)` in **`main.js`**
2. Expose it in **`preload.js`** under `window.electronAPI`
3. Handle it in the `switch` in `_triggerButton()` in **`renderer/app.js`**
4. Add active-state detection in `_isButtonActive()` if applicable
5. Add a `<option>` for it in the `#action-type` select in **`renderer/index.html`**

## IPC Contract

All IPC handlers return `{ success: true, ...data }` or `{ success: false, error: string }`. Always check `res.success` before using the result. OBS events are pushed from main → renderer via `mainWindow.webContents.send(channel, data)` and subscribed in `_subscribeOBSEvents()`.

## Studio Mode Awareness

Scene buttons must respect Studio Mode: when `this.studioModeEnabled` is `true`, pressing a scene button calls `obsSetCurrentPreviewScene` (sets preview only); otherwise it calls `obsSetCurrentScene` (cuts directly to program). The `studioModeTransition` button does the actual cut.

## OBS Connection Lifecycle

- On startup, `_autoConnectOBS()` silently retries every 5 s using saved `config.obs` settings.
- On unexpected disconnect, `onObsConnectionClosed` schedules a 3 s auto-reconnect unless `_manualDisconnect` is set.
- Manual disconnect sets `_manualDisconnect = true` and clears `_reconnectTimer` before calling `obsDisconnect`.
- `_connectOBS(settings, { silent: true })` suppresses the "Connecting…" UI — use this for background retries.

## UI Patterns

- **Re-render strategy**: `_renderGrid()` rebuilds all cells from scratch; `_refreshButton(key)` rebuilds a single cell in-place. Prefer `_refreshButton` for live OBS state updates to avoid full re-renders.
- **Editor draft**: The button editor works on `this.editorDraft` (a deep copy). `_saveCurrentVisualState()` must be called before switching tabs or saving, as form fields are not stored continuously.
- **Visibility**: elements are shown/hidden with the `hidden` CSS class, not `display` style.
- **Modals**: all share the same pattern — clicking the backdrop (`e.target === e.currentTarget`) closes the modal.

## Running the App

```bash
npm start   # electron .
```

No build step. No bundler. Files are loaded directly by Electron. Restart the app to pick up changes to `main.js` or `preload.js`; renderer changes (`app.js`, `style.css`, `index.html`) can be reloaded with `Ctrl+R` in the DevTools window.

## Distribution

Installers are built and published as GitHub Releases via a GitHub Actions workflow. No manual packaging step exists locally.

## Config Persistence

Config is currently stored in `localStorage` (`deckgrid-config`). The `electron-store` package is already a dependency and is the intended replacement — migration has not been done yet. When implementing it, all reads/writes are in `_loadConfig()` and `_saveConfig()` in `renderer/app.js`, but since the renderer has no Node access, the store will need to be accessed via IPC (new `ipcMain.handle` entries in `main.js` + `preload.js` bridge methods).

## Planned Features (design with these in mind)

- **Hotkeys** — global keyboard shortcuts that trigger button actions without clicking.
- **Multi-page decks** — multiple named pages of button grids, with a dedicated button action type (`navigatePage`) for switching between them. Config will need a `pages` structure rather than a flat `buttons` map. The current `buttons` object on `config` is effectively page 1.
- **Remote control WebSocket server** — a server running in `main.js` that lets external devices/apps (e.g. a phone, a companion app) trigger button actions and receive state updates. This mirrors the OBS WebSocket pattern already in place: events flow main → renderer via `webContents.send`, and commands flow renderer → main via `ipcMain.handle`.
