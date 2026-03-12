'use strict';

// ─── Hotkey helpers ───────────────────────────────────────────────────────────

/** Modifier-only keys that should not be recorded as a hotkey on their own. */
const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta'];

/**
 * Build a canonical hotkey string from a KeyboardEvent.
 * Format: [ctrl+][alt+][shift+][meta+]<key>   (all lowercase)
 * e.g. "ctrl+shift+f1", "alt+a"
 */
function _buildHotkeyString(e) {
  const parts = [];
  if (e.ctrlKey)  parts.push('ctrl');
  if (e.altKey)   parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey)  parts.push('meta');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

/**
 * Format a stored hotkey string for human-readable display.
 * e.g. "ctrl+shift+f1" → "Ctrl+Shift+F1"
 */
function _formatHotkey(combo) {
  if (!combo) return '';
  return combo.split('+').map((p) => {
    if (p === 'ctrl')  return 'Ctrl';
    if (p === 'alt')   return 'Alt';
    if (p === 'shift') return 'Shift';
    if (p === 'meta')  return 'Meta';
    // Capitalise first letter for named keys (f1, arrowleft, enter, …)
    return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
  }).join('+');
}

// ─── Default styles for new buttons ──────────────────────────────────────────
const DEFAULT_INACTIVE = {
  text: '',
  backgroundColor: '#1e2a4a',
  borderColor: '#3a4a6a',
  image: null,
  icon: null,
  textColor: '#ffffff',
  textPosition: 'center',
};

const DEFAULT_ACTIVE = {
  text: '',
  backgroundColor: '#0f3460',
  borderColor: '#4a9eff',
  image: null,
  icon: null,
  textColor: '#ffffff',
  textPosition: 'center',
};

// ─── Main Application Class ───────────────────────────────────────────────────
class DeckGrid {
  constructor() {
    // ── Persisted state (populated async in _init) ───────────────────
    this.config = this._defaultConfig();

    // ── UI state ─────────────────────────────────────────────────────
    this.editMode = false;
    this.currentPageIndex = 0;

    // ── OBS state ────────────────────────────────────────────────────
    this.obsConnected = false;
    this.currentScene = null;        // Currently live scene name
    this.sceneItemStates = new Map(); // "sceneName::itemId" → boolean
    this.studioModeEnabled = false;
    this.obsScenes = [];             // [{sceneName, sceneIndex}, ...]
    this.sourcesCache = new Map();   // sceneName → [{sceneItemId, sourceName, ...}]

    // ── Drag-and-drop state ──────────────────────────────────────────
    this.dragSourceKey = null;

    // ── Editor state ─────────────────────────────────────────────────
    this.editorKey = null;          // Grid position key being edited
    this.editorVisualState = 'inactive'; // 'inactive' | 'active'
    this.editorDraft = {            // Working copy while editor is open
      action: '',
      actionData: {},
      inactive: { ...DEFAULT_INACTIVE },
      active: { ...DEFAULT_ACTIVE },
    };

    // Unsubscribe functions for OBS event listeners
    this._obsUnsubs = [];
    this._reconnectTimer = null;
    this._manualDisconnect = false;

    // Remote control server state
    this.remoteServerRunning = false;
    this.remoteClientCount = 0;

    this._init();
  }

  // ─── Initialise ────────────────────────────────────────────────────────────
  async _init() {
    this.config = await this._loadConfig();
    this._pushConfigToMain();
    this._bindTopBar();
    this._bindProfileControls();
    this._bindObsModal();
    this._bindRemoteModal();
    this._bindEditorModal();
    this._bindGlobalHotkeys();
    this._renderGrid();
    this._applyGridLayout();
    this._applyZoom();
    this._renderPageBar();
    this._renderProfileSelector();
    this._subscribeOBSEvents();
    this._autoConnectOBS();
    this._autoStartRemote();
  }

  async _autoConnectOBS() {
    const obs = this.config.obs;
    if (!obs || !obs.host || this._manualDisconnect) return;
    const res = await this._connectOBS({ host: obs.host, port: obs.port, password: obs.password }, { silent: true });
    if (!res.success) {
      // OBS not running yet — retry quietly
      this._reconnectTimer = setTimeout(() => this._autoConnectOBS(), 5000);
    }
  }

  async _autoStartRemote() {
    if (!window.electronAPI) return;
    const remote = this.config.remote;
    if (!remote || !remote.enabled) return;
    await this._startRemoteServer(remote.port || 8765);
  }

  // ─── Config persistence ────────────────────────────────────────────────────
  async _loadConfig() {
    try {
      const res = await window.electronAPI.storeGet('config');
      if (res.success && res.data) {
        const cfg = res.data;
        return this._migrateToProfiles(cfg, /* save */ true);
      }
      // Migrate from localStorage if present
      const raw = localStorage.getItem('deckgrid-config');
      if (raw) {
        const parsed = JSON.parse(raw);
        const migrated = this._migrateToProfiles(parsed, /* save */ false);
        await window.electronAPI.storeSet('config', migrated);
        localStorage.removeItem('deckgrid-config');
        return migrated;
      }
    } catch (_) {}
    return this._defaultConfig();
  }

  /**
   * Ensure a config object uses the profiles structure.
   * Mutates and returns the object.  If `save` is true, persists the migrated
   * config via IPC (fire-and-forget) so the store stays up to date.
   */
  _migrateToProfiles(cfg, save = false) {
    if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) {
      // Old format: rows/columns/zoom/pages were top-level fields
      let pages = cfg.pages;
      if (!Array.isArray(pages) || pages.length === 0) {
        pages = cfg.buttons
          ? [{ name: 'Page 1', buttons: cfg.buttons }]
          : [{ name: 'Page 1', buttons: {} }];
      }
      const profile = {
        name:    'Default',
        rows:    cfg.rows    ?? 3,
        columns: cfg.columns ?? 4,
        zoom:    cfg.zoom    ?? 100,
        pages,
      };
      cfg.profiles = [profile];
      cfg.activeProfileIndex = 0;
      delete cfg.rows;
      delete cfg.columns;
      delete cfg.zoom;
      delete cfg.pages;
      delete cfg.buttons;
      if (save && window.electronAPI) {
        window.electronAPI.storeSet('config', cfg).catch(() => {});
      }
    }
    // Clamp active index
    if (cfg.activeProfileIndex === null || cfg.activeProfileIndex === undefined || cfg.activeProfileIndex >= cfg.profiles.length) {
      cfg.activeProfileIndex = 0;
    }
    return cfg;
  }

  async _saveConfig() {
    try {
      const res = await window.electronAPI.storeSet('config', this.config);
      if (!res.success) console.error('Failed to save config:', res.error);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
    this._pushConfigToMain();
  }

  _pushConfigToMain() {
    if (window.electronAPI && window.electronAPI.remotePushConfig) {
      window.electronAPI.remotePushConfig(this.config).catch(() => {});
    }
  }

  _defaultConfig() {
    return {
      obs: { host: 'localhost', port: 4455, password: '' },
      remote: { enabled: false, port: 8765 },
      activeProfileIndex: 0,
      profiles: [
        { name: 'Default', rows: 3, columns: 4, zoom: 100, pages: [{ name: 'Page 1', buttons: {} }] },
      ],
    };
  }

  // ─── Active profile accessor ────────────────────────────────────────────────
  _activeProfile() {
    const profiles = this.config.profiles;
    const idx = Math.max(0, Math.min(this.config.activeProfileIndex ?? 0, profiles.length - 1));
    return profiles[idx];
  }

  // ─── Page helpers ──────────────────────────────────────────────────────────
  _currentPage() {
    const pages = this._activeProfile().pages;
    if (!pages || pages.length === 0) {
      this._activeProfile().pages = [{ name: 'Page 1', buttons: {} }];
      return this._activeProfile().pages[0];
    }
    const idx = Math.min(Math.max(0, this.currentPageIndex), pages.length - 1);
    return pages[idx];
  }

  _currentPageButtons() {
    return this._currentPage().buttons;
  }

  // ─── Top Bar ───────────────────────────────────────────────────────────────
  _bindTopBar() {
    // Mode toggle
    document.getElementById('mode-toggle').addEventListener('click', () => {
      this.editMode = !this.editMode;
      this._updateModeUI();
    });

    // Grid size controls
    const colsInput = document.getElementById('grid-cols');
    const rowsInput = document.getElementById('grid-rows');
    const zoomInput = document.getElementById('grid-zoom');

    colsInput.value = this._activeProfile().columns;
    rowsInput.value = this._activeProfile().rows;
    zoomInput.value = this._activeProfile().zoom;
    document.getElementById('zoom-value').textContent = `${this._activeProfile().zoom}%`;

    colsInput.addEventListener('change', () => {
      this._activeProfile().columns = Math.max(1, Math.min(12, parseInt(colsInput.value) || 1));
      colsInput.value = this._activeProfile().columns;
      this._saveConfig();
      this._renderGrid();
      this._applyGridLayout();
    });

    rowsInput.addEventListener('change', () => {
      this._activeProfile().rows = Math.max(1, Math.min(8, parseInt(rowsInput.value) || 1));
      rowsInput.value = this._activeProfile().rows;
      this._saveConfig();
      this._renderGrid();
      this._applyGridLayout();
    });

    zoomInput.addEventListener('input', () => {
      this._activeProfile().zoom = parseInt(zoomInput.value);
      document.getElementById('zoom-value').textContent = `${this._activeProfile().zoom}%`;
      this._applyZoom();
      this._saveConfig();
    });

    // Export / Import
    document.getElementById('export-btn').addEventListener('click', () => this._exportConfig());
    document.getElementById('import-btn').addEventListener('click', () => {
      document.getElementById('import-file-input').value = '';
      document.getElementById('import-file-input').click();
    });
    document.getElementById('import-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this._importConfig(file);
    });

    // Connect button
    document.getElementById('connect-btn').addEventListener('click', () => {
      if (this.obsConnected) {
        this._disconnectOBS();
      } else {
        this._openObsModal();
      }
    });
  }

  _updateModeUI() {
    const btn = document.getElementById('mode-toggle');
    const grid = document.getElementById('grid');
    const controls = document.getElementById('grid-controls');

    if (this.editMode) {
      btn.className = 'btn-mode edit';
      btn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i><span>Edit Mode</span>';
      grid.classList.add('edit-mode');
      controls.classList.remove('hidden');
    } else {
      btn.className = 'btn-mode ops';
      btn.innerHTML = '<i class="fa-solid fa-play"></i><span>Operations</span>';
      grid.classList.remove('edit-mode');
      controls.classList.add('hidden');
    }
    this._renderPageBar();
    this._renderProfileSelector();
  }

  _applyGridLayout() {
    const grid = document.getElementById('grid');
    grid.style.gridTemplateColumns = `repeat(${this._activeProfile().columns}, 110px)`;
    grid.style.gridTemplateRows    = `repeat(${this._activeProfile().rows}, 110px)`;
  }

  _applyZoom() {
    const scaler = document.getElementById('grid-scaler');
    const z = (this._activeProfile().zoom || 100) / 100;
    scaler.style.transform = `scale(${z})`;
  }

  // ─── Page management ───────────────────────────────────────────────────────
  _goToPage(index) {
    const clamped = Math.max(0, Math.min(index, this._activeProfile().pages.length - 1));
    if (clamped === this.currentPageIndex) return;
    this.currentPageIndex = clamped;
    this._renderGrid();
    this._applyGridLayout();
    this._renderPageBar();
  }

  _addPage() {
    // Generate a unique page name
    const pages = this._activeProfile().pages;
    const existingNames = new Set(pages.map((p) => p.name));
    let num = pages.length + 1;
    let name = `Page ${num}`;
    while (existingNames.has(name)) {
      num++;
      name = `Page ${num}`;
    }
    pages.push({ name, buttons: {} });
    this._saveConfig();
    this.currentPageIndex = pages.length - 1;
    this._renderGrid();
    this._applyGridLayout();
    this._renderPageBar();
  }

  _removePage(index) {
    const pages = this._activeProfile().pages;
    if (pages.length <= 1) return; // Cannot remove the last page
    pages.splice(index, 1);
    if (this.currentPageIndex >= pages.length) {
      this.currentPageIndex = pages.length - 1;
    }
    this._saveConfig();
    this._renderGrid();
    this._applyGridLayout();
    this._renderPageBar();
  }

  _renderPageBar() {
    const bar = document.getElementById('page-bar');
    bar.innerHTML = '';
    const pages = this._activeProfile().pages;

    // In ops mode with only one page, hide the bar
    if (!this.editMode && pages.length <= 1) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');

    if (this.editMode) {
      // Edit mode: page tabs + add button
      const tabsContainer = document.createElement('div');
      tabsContainer.className = 'page-tabs';

      pages.forEach((page, idx) => {
        const tab = document.createElement('button');
        tab.className = 'page-tab' + (idx === this.currentPageIndex ? ' active-page' : '');

        const nameSpan = document.createElement('span');
        nameSpan.textContent = page.name;
        tab.appendChild(nameSpan);

        if (pages.length > 1) {
          const del = document.createElement('span');
          del.className = 'page-tab-delete';
          del.title = 'Delete page';
          del.innerHTML = '&times;';
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            this._removePage(idx);
          });
          tab.appendChild(del);
        }

        tab.addEventListener('click', () => {
          if (idx !== this.currentPageIndex) {
            this.currentPageIndex = idx;
            this._renderGrid();
            this._applyGridLayout();
            this._renderPageBar();
          }
        });

        tabsContainer.appendChild(tab);
      });

      bar.appendChild(tabsContainer);

      const addBtn = document.createElement('button');
      addBtn.className = 'page-add-btn';
      addBtn.title = 'Add new page';
      addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Page';
      addBtn.addEventListener('click', () => this._addPage());
      bar.appendChild(addBtn);
    } else {
      // Operations mode: prev arrow + page name + next arrow
      const prevBtn = document.createElement('button');
      prevBtn.className = 'page-nav-btn';
      prevBtn.title = 'Previous page';
      prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
      prevBtn.disabled = this.currentPageIndex === 0;
      prevBtn.addEventListener('click', () => this._goToPage(this.currentPageIndex - 1));
      bar.appendChild(prevBtn);

      const indicator = document.createElement('span');
      indicator.className = 'page-indicator';
      const pageName = pages[this.currentPageIndex]?.name || `Page ${this.currentPageIndex + 1}`;
      indicator.textContent = pageName;
      bar.appendChild(indicator);

      const nextBtn = document.createElement('button');
      nextBtn.className = 'page-nav-btn';
      nextBtn.title = 'Next page';
      nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
      nextBtn.disabled = this.currentPageIndex === pages.length - 1;
      nextBtn.addEventListener('click', () => this._goToPage(this.currentPageIndex + 1));
      bar.appendChild(nextBtn);
    }
  }

  // ─── Profile management ────────────────────────────────────────────────────
  _addProfile() {
    const existingNames = new Set(this.config.profiles.map((p) => p.name));
    let num = this.config.profiles.length + 1;
    let name = `Profile ${num}`;
    while (existingNames.has(name)) {
      num++;
      name = `Profile ${num}`;
    }
    const def = this._defaultConfig().profiles[0];
    this.config.profiles.push({
      name, rows: def.rows, columns: def.columns, zoom: def.zoom,
      pages: [{ name: 'Page 1', buttons: {} }],
    });
    this.config.activeProfileIndex = this.config.profiles.length - 1;
    this.currentPageIndex = 0;
    this._saveConfig();
    this._renderProfileSelector();
    this._renderGrid();
    this._applyGridLayout();
    this._applyZoom();
    this._renderPageBar();
    this._syncGridControls();
  }

  _removeProfile(index) {
    if (this.config.profiles.length <= 1) return; // Cannot remove the last profile
    this.config.profiles.splice(index, 1);
    if (this.config.activeProfileIndex >= this.config.profiles.length) {
      this.config.activeProfileIndex = this.config.profiles.length - 1;
    }
    this.currentPageIndex = 0;
    this._saveConfig();
    this._renderProfileSelector();
    this._renderGrid();
    this._applyGridLayout();
    this._applyZoom();
    this._renderPageBar();
    this._syncGridControls();
  }

  _switchProfile(index) {
    const clamped = Math.max(0, Math.min(index, this.config.profiles.length - 1));
    if (clamped === this.config.activeProfileIndex) return;
    this.config.activeProfileIndex = clamped;
    this.currentPageIndex = 0;
    this._saveConfig();
    this._renderGrid();
    this._applyGridLayout();
    this._applyZoom();
    this._renderPageBar();
    this._renderProfileSelector();
    this._syncGridControls();
  }

  _renameProfile(index, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed) return;
    this.config.profiles[index].name = trimmed;
    this._saveConfig();
    this._renderProfileSelector();
  }

  /** Sync grid-controls inputs to reflect the active profile's values. */
  _syncGridControls() {
    const prof = this._activeProfile();
    document.getElementById('grid-cols').value = prof.columns;
    document.getElementById('grid-rows').value = prof.rows;
    document.getElementById('grid-zoom').value = prof.zoom;
    document.getElementById('zoom-value').textContent = `${prof.zoom}%`;
  }

  /** Rebuild the profile <select> and update edit-mode button states. */
  _renderProfileSelector() {
    const select  = document.getElementById('profile-select');
    const addBtn  = document.getElementById('profile-add-btn');
    const renameBtn = document.getElementById('profile-rename-btn');
    const delBtn  = document.getElementById('profile-delete-btn');
    if (!select) return;

    select.innerHTML = '';
    this.config.profiles.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = p.name;
      if (i === this.config.activeProfileIndex) opt.selected = true;
      select.appendChild(opt);
    });

    const isEdit = this.editMode;
    if (addBtn)    addBtn.classList.toggle('hidden', !isEdit);
    if (renameBtn) renameBtn.classList.toggle('hidden', !isEdit);
    if (delBtn) {
      delBtn.classList.toggle('hidden', !isEdit);
      delBtn.disabled = this.config.profiles.length <= 1;
    }
  }

  _bindProfileControls() {
    const select    = document.getElementById('profile-select');
    const addBtn    = document.getElementById('profile-add-btn');
    const renameBtn = document.getElementById('profile-rename-btn');
    const delBtn    = document.getElementById('profile-delete-btn');
    if (!select) return;

    select.addEventListener('change', () => {
      this._switchProfile(parseInt(select.value, 10));
    });

    if (addBtn) {
      addBtn.addEventListener('click', () => this._addProfile());
    }

    if (renameBtn) {
      renameBtn.addEventListener('click', () => {
        const current = this._activeProfile();
        const newName = window.prompt('Profile name:', current.name);
        if (newName !== null) this._renameProfile(this.config.activeProfileIndex, newName);
      });
    }

    if (delBtn) {
      delBtn.addEventListener('click', () => {
        if (this.config.profiles.length <= 1) return;
        const current = this._activeProfile();
        if (window.confirm(`Delete profile "${current.name}"? This cannot be undone.`)) {
          this._removeProfile(this.config.activeProfileIndex);
        }
      });
    }
  }

  // ─── Grid rendering ────────────────────────────────────────────────────────
  _renderGrid() {
    const grid = document.getElementById('grid');
    grid.innerHTML = '';

    const prof = this._activeProfile();
    for (let r = 0; r < prof.rows; r++) {
      for (let c = 0; c < prof.columns; c++) {
        const key = `${r}_${c}`;
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.key = key;

        const btn = this._currentPageButtons()[key];
        if (btn) {
          cell.appendChild(this._buildDeckButton(key, btn));
        } else {
          cell.appendChild(this._buildEmptyCell(key));
        }

        this._bindCellDrop(cell);
        grid.appendChild(cell);
      }
    }
  }

  _buildEmptyCell(key) {
    const btn = document.createElement('button');
    btn.className = 'empty-cell-btn';
    btn.title = 'Add button';
    btn.setAttribute('aria-label', 'Add button');
    btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
    btn.addEventListener('click', () => {
      if (this.editMode) this._openEditor(key);
    });
    return btn;
  }

  _buildDeckButton(key, btnConfig) {
    const isActive = this._isButtonActive(btnConfig);
    const style = isActive ? btnConfig.active : btnConfig.inactive;

    const el = document.createElement('div');
    el.className = 'deck-button';
    el.dataset.key = key;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', style.text || 'Deck button');
    el.style.backgroundColor = style.backgroundColor || DEFAULT_INACTIVE.backgroundColor;
    el.style.borderColor     = style.borderColor     || DEFAULT_INACTIVE.borderColor;
    el.style.borderWidth     = '2px';
    el.style.borderStyle     = 'solid';

    // Background image layer
    if (style.image) {
      const imgLayer = document.createElement('div');
      imgLayer.className = 'btn-img-layer';
      imgLayer.style.backgroundImage = `url(${style.image})`;
      el.appendChild(imgLayer);
    }

    // Icon (shown when no image, or always)
    const hasText = !!(style.text && style.text.trim());
    const textPos = style.textPosition || 'center';

    if (style.icon) {
      const icon = document.createElement('i');
      icon.className = `fa-solid fa-${style.icon} btn-icon`;
      icon.style.color = style.textColor || '#ffffff';
      // Adjust icon position to make room for text
      if (hasText) {
        el.classList.add(`has-text-${textPos}`);
      } else {
        icon.style.top = '50%';
        icon.style.transform = 'translateY(-50%)';
      }
      el.appendChild(icon);
    }

    // Text
    if (hasText) {
      const span = document.createElement('span');
      span.className = `btn-text pos-${textPos}`;
      span.style.color = style.textColor || '#ffffff';
      span.textContent = style.text;
      el.appendChild(span);
    }

    // Edit overlay
    const overlay = document.createElement('div');
    overlay.className = 'edit-overlay';
    overlay.innerHTML = `
      <button class="edit-overlay-btn" title="Edit" aria-label="Edit button">
        <i class="fa-solid fa-pen"></i> Edit
      </button>`;
    overlay.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      this._openEditor(key);
    });
    el.appendChild(overlay);

    // Hotkey badge
    if (btnConfig.hotkey) {
      const badge = document.createElement('span');
      badge.className = 'hotkey-badge';
      badge.title = `Hotkey: ${_formatHotkey(btnConfig.hotkey)}`;
      badge.textContent = _formatHotkey(btnConfig.hotkey);
      el.appendChild(badge);
    }

    // Interactions
    el.addEventListener('click', () => {
      if (this.editMode) {
        this._openEditor(key);
      } else {
        this._triggerButton(key, btnConfig);
      }
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (this.editMode) {
          this._openEditor(key);
        } else {
          this._triggerButton(key, btnConfig);
        }
      }
    });

    // Drag support in edit mode
    el.setAttribute('draggable', 'true');

    el.addEventListener('dragstart', (e) => {
      if (!this.editMode) { e.preventDefault(); return; }
      this.dragSourceKey = key;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
    });

    return el;
  }

  _bindCellDrop(cell) {
    cell.addEventListener('dragover', (e) => {
      if (!this.editMode || !this.dragSourceKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cell.classList.add('drag-over');
    });

    cell.addEventListener('dragleave', () => {
      cell.classList.remove('drag-over');
    });

    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      const targetKey = cell.dataset.key;
      if (!this.dragSourceKey || targetKey === this.dragSourceKey) return;
      this._moveButton(this.dragSourceKey, targetKey);
      this.dragSourceKey = null;
    });
  }

  _moveButton(fromKey, toKey) {
    const pageButtons = this._currentPageButtons();
    const srcBtn = pageButtons[fromKey];
    const dstBtn = pageButtons[toKey];

    if (dstBtn) {
      pageButtons[fromKey] = dstBtn;
    } else {
      delete pageButtons[fromKey];
    }

    if (srcBtn) {
      pageButtons[toKey] = srcBtn;
    } else {
      delete pageButtons[toKey];
    }

    this._saveConfig();
    this._renderGrid();
    this._applyGridLayout();
  }

  // ─── Active state detection ────────────────────────────────────────────────
  _isButtonActive(btnConfig) {
    // navigatePage active state does not require OBS
    if (btnConfig.action === 'navigatePage') {
      return btnConfig.actionData != null &&
             btnConfig.actionData.pageIndex === this.currentPageIndex;
    }

    if (!this.obsConnected) return false;

    switch (btnConfig.action) {
      case 'scene':
        return btnConfig.actionData &&
               btnConfig.actionData.sceneName === this.currentScene;

      case 'toggleSource': {
        const d = btnConfig.actionData;
        if (!d || !d.sceneName || d.sceneItemId == null) return false;
        const key = `${d.sceneName}::${d.sceneItemId}`;
        return this.sceneItemStates.get(key) === true;
      }

      case 'studioModeTransition':
        return this.studioModeEnabled;

      default:
        return false;
    }
  }

  // ─── OBS button actions ────────────────────────────────────────────────────
  async _triggerButton(key, btnConfig) {
    if (!btnConfig.action) return;

    const d = btnConfig.actionData || {};

    // Non-OBS actions — work regardless of connection state
    if (btnConfig.action === 'navigatePage') {
      if (d.pageIndex !== null && d.pageIndex !== undefined && d.pageIndex >= 0 && d.pageIndex < this._activeProfile().pages.length) {
        this._goToPage(d.pageIndex);
      }
      return;
    }

    if (!this.obsConnected) {
      this._showToast('Not connected to OBS', 'warning');
      return;
    }

    switch (btnConfig.action) {
      case 'scene':
        if (d.sceneName) {
          if (this.studioModeEnabled) {
            await window.electronAPI.obsSetCurrentPreviewScene(d.sceneName);
          } else {
            await window.electronAPI.obsSetCurrentScene(d.sceneName);
          }
        }
        break;

      case 'toggleSource':
        if (d.sceneName && d.sceneItemId != null) {
          const res = await window.electronAPI.obsToggleSceneItem({
            sceneName: d.sceneName,
            sceneItemId: d.sceneItemId,
          });
          if (res.success) {
            const stateKey = `${d.sceneName}::${d.sceneItemId}`;
            this.sceneItemStates.set(stateKey, res.enabled);
            this._refreshButton(key);
          }
        }
        break;

      case 'studioModeTransition':
        await window.electronAPI.obsTriggerStudioModeTransition();
        break;
    }
  }

  // ─── Refresh a single button's visual state ────────────────────────────────
  _refreshButton(key) {
    const btnConfig = this._currentPageButtons()[key];
    const cell = document.querySelector(`.grid-cell[data-key="${key}"]`);
    if (!cell || !btnConfig) return;
    cell.innerHTML = '';
    cell.appendChild(this._buildDeckButton(key, btnConfig));
    this._bindCellDrop(cell);
  }

  _refreshAllButtons() {
    for (const key of Object.keys(this._currentPageButtons())) {
      this._refreshButton(key);
    }
  }

  // ─── OBS event subscriptions ───────────────────────────────────────────────
  _subscribeOBSEvents() {
    if (!window.electronAPI) return;
    const api = window.electronAPI;

    this._obsUnsubs.push(
      api.onObsCurrentSceneChanged((data) => {
        this.currentScene = data.sceneName;
        this._refreshAllButtons();
      }),

      api.onObsSceneItemEnableStateChanged((data) => {
        const stateKey = `${data.sceneName}::${data.sceneItemId}`;
        this.sceneItemStates.set(stateKey, data.sceneItemEnabled);
        // Refresh only matching buttons visible on the current page
        for (const [key, btn] of Object.entries(this._currentPageButtons())) {
          if (btn.action === 'toggleSource' &&
              btn.actionData &&
              btn.actionData.sceneName === data.sceneName &&
              btn.actionData.sceneItemId === data.sceneItemId) {
            this._refreshButton(key);
          }
        }
      }),

      api.onObsStudioModeStateChanged((data) => {
        this.studioModeEnabled = data.studioModeEnabled;
        for (const [key, btn] of Object.entries(this._currentPageButtons())) {
          if (btn.action === 'studioModeTransition') this._refreshButton(key);
        }
      }),

      api.onObsConnectionClosed(() => {
        this._setConnectionStatus(false);
        if (!this._manualDisconnect && this.config.obs && this.config.obs.host) {
          this._reconnectTimer = setTimeout(() => this._autoConnectOBS(), 3000);
        }
        this._manualDisconnect = false;
      }),

      api.onRemoteButtonPressed((data) => {
        const key = data.key;
        const btnConfig = this._currentPageButtons()[key];
        if (btnConfig) this._triggerButton(key, btnConfig);
      }),

      api.onRemoteClientConnected((data) => {
        this.remoteClientCount = data.clientCount;
        this._updateRemoteClientCount();
      }),

      api.onRemoteClientDisconnected((data) => {
        this.remoteClientCount = data.clientCount;
        this._updateRemoteClientCount();
      }),

      api.onRemoteServerStopped(() => {
        this.remoteServerRunning = false;
        this.remoteClientCount = 0;
        this._updateRemoteServerUI(false);
      })
    );
  }

  // ─── Global hotkey handler ────────────────────────────────────────────────
  _bindGlobalHotkeys() {
    document.addEventListener('keydown', (e) => {
      // Skip when in edit mode or a modal is open
      if (this.editMode) return;
      if (!document.getElementById('editor-modal').classList.contains('hidden')) return;
      if (!document.getElementById('obs-modal').classList.contains('hidden')) return;
      // Skip when focused inside an input-like element
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.activeElement && document.activeElement.isContentEditable) return;
      // Skip bare modifier presses
      if (MODIFIER_KEYS.includes(e.key)) return;

      const combo = _buildHotkeyString(e);
      for (const page of (this._activeProfile().pages || [])) {
        for (const [key, btn] of Object.entries(page.buttons || {})) {
          if (btn.hotkey && btn.hotkey === combo) {
            e.preventDefault();
            this._triggerButton(key, btn);
            return;
          }
        }
      }
    });
  }

  // ─── OBS connection / disconnection ───────────────────────────────────────
  async _connectOBS(settings, { silent = false } = {}) {
    if (!window.electronAPI) {
      return { success: false, error: 'electronAPI not available (not running in Electron)' };
    }
    if (!silent) this._setConnectionStatus('connecting');
    const res = await window.electronAPI.obsConnect(settings);

    if (!res.success) {
      if (!silent) this._setConnectionStatus(false);
      return { success: false, error: res.error };
    }

    this._setConnectionStatus(true);

    // Fetch initial state
    const [sceneRes, studioRes] = await Promise.all([
      window.electronAPI.obsGetCurrentScene(),
      window.electronAPI.obsGetStudioModeEnabled(),
    ]);

    if (sceneRes.success)  this.currentScene      = sceneRes.sceneName;
    if (studioRes.success) this.studioModeEnabled  = studioRes.enabled;

    // Fetch scene item states for toggleSource buttons
    await this._refreshToggleSourceStates();

    // Cache scene list for editor
    const scenesRes = await window.electronAPI.obsGetScenes();
    if (scenesRes.success) this.obsScenes = scenesRes.scenes;

    this._refreshAllButtons();
    return { success: true };
  }

  async _disconnectOBS() {
    this._manualDisconnect = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    await window.electronAPI.obsDisconnect();
    this._setConnectionStatus(false);
  }

  async _refreshToggleSourceStates() {
    const seen = new Set();
    for (const page of this._activeProfile().pages) {
      for (const btn of Object.values(page.buttons)) {
        if (btn.action === 'toggleSource' && btn.actionData) {
          const { sceneName, sceneItemId } = btn.actionData;
          const cacheKey = `${sceneName}::${sceneItemId}`;
          if (sceneName && sceneItemId != null && !seen.has(cacheKey)) {
            seen.add(cacheKey);
            const res = await window.electronAPI.obsGetSceneItemEnabled({ sceneName, sceneItemId });
            if (res.success) {
              this.sceneItemStates.set(cacheKey, res.enabled);
            }
          }
        }
      }
    }
  }

  _setConnectionStatus(status) {
    const indicator = document.getElementById('connection-status');
    const text      = document.getElementById('conn-text');
    const connectBtn = document.getElementById('connect-btn');

    if (status === true) {
      this.obsConnected = true;
      indicator.className = 'conn-status connected';
      text.textContent = 'Connected';
      connectBtn.innerHTML = '<i class="fa-solid fa-plug-circle-xmark"></i><span>Disconnect</span>';
    } else if (status === 'connecting') {
      indicator.className = 'conn-status connecting';
      text.textContent = 'Connecting…';
      connectBtn.innerHTML = '<i class="fa-solid fa-plug"></i><span>Connecting…</span>';
      connectBtn.disabled = true;
    } else {
      this.obsConnected = false;
      this.currentScene = null;
      this.studioModeEnabled = false;
      this.sceneItemStates.clear();
      indicator.className = 'conn-status disconnected';
      text.textContent = 'Not Connected';
      connectBtn.innerHTML = '<i class="fa-solid fa-plug"></i><span>Connect to OBS</span>';
      connectBtn.disabled = false;
      this._refreshAllButtons();
    }
  }

  // ─── OBS Connect Modal ─────────────────────────────────────────────────────
  _openObsModal() {
    document.getElementById('obs-error').classList.add('hidden');
    const obs = this.config.obs || {};
    document.getElementById('obs-host').value     = obs.host     || 'localhost';
    document.getElementById('obs-port').value     = obs.port     || 4455;
    document.getElementById('obs-password').value = obs.password || '';
    document.getElementById('obs-modal').classList.remove('hidden');
    document.getElementById('obs-host').focus();
  }

  _closeObsModal() {
    document.getElementById('obs-modal').classList.add('hidden');
  }

  _bindObsModal() {
    document.getElementById('obs-modal-close').addEventListener('click', () => this._closeObsModal());
    document.getElementById('obs-cancel').addEventListener('click',     () => this._closeObsModal());

    document.getElementById('obs-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeObsModal();
    });

    document.getElementById('obs-connect').addEventListener('click', () => this._submitObsConnect());

    document.getElementById('obs-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._submitObsConnect();
    });
  }

  async _submitObsConnect() {
    const host     = document.getElementById('obs-host').value.trim()     || 'localhost';
    const port     = parseInt(document.getElementById('obs-port').value)  || 4455;
    const password = document.getElementById('obs-password').value;

    const connectBtn = document.getElementById('obs-connect');
    connectBtn.disabled = true;
    connectBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting…';

    const errorEl = document.getElementById('obs-error');
    errorEl.classList.add('hidden');

    const res = await this._connectOBS({ host, port, password });

    connectBtn.disabled = false;
    connectBtn.innerHTML = '<i class="fa-solid fa-plug"></i> Connect';

    if (res.success) {
      this.config.obs = { host, port, password };
      this._saveConfig();
      this._closeObsModal();
    } else {
      errorEl.textContent = `Connection failed: ${res.error}`;
      errorEl.classList.remove('hidden');
    }
  }

  // ─── Remote Control Modal ───────────────────────────────────────────────────
  _openRemoteModal() {
    const remote = this.config.remote || {};
    document.getElementById('remote-port').value = remote.port || 8765;
    document.getElementById('remote-error').classList.add('hidden');
    if (this.remoteServerRunning && window.electronAPI) {
      window.electronAPI.remoteGetStatus().then((res) => {
        if (res.success && res.running) {
          this._updateRemoteServerUI(true, res.ips, res.port);
        } else {
          this._updateRemoteServerUI(false);
        }
      });
    } else {
      this._updateRemoteServerUI(false);
    }
    document.getElementById('remote-modal').classList.remove('hidden');
  }

  _closeRemoteModal() {
    document.getElementById('remote-modal').classList.add('hidden');
  }

  _bindRemoteModal() {
    document.getElementById('remote-modal-close').addEventListener('click',     () => this._closeRemoteModal());
    document.getElementById('remote-modal-close-btn').addEventListener('click', () => this._closeRemoteModal());

    document.getElementById('remote-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeRemoteModal();
    });

    document.getElementById('remote-btn').addEventListener('click', () => this._openRemoteModal());

    document.getElementById('remote-start').addEventListener('click', async () => {
      const port = parseInt(document.getElementById('remote-port').value) || 8765;
      await this._startRemoteServer(port);
    });

    document.getElementById('remote-stop').addEventListener('click', async () => {
      await this._stopRemoteServer();
    });
  }

  async _startRemoteServer(port) {
    if (!window.electronAPI) return;

    const startBtn = document.getElementById('remote-start');
    const errorEl  = document.getElementById('remote-error');
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Starting…';
    }
    if (errorEl) errorEl.classList.add('hidden');

    const res = await window.electronAPI.remoteStartServer(port);

    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start Server';
    }

    if (res.success) {
      this.remoteServerRunning = true;
      this.remoteClientCount = 0;
      this.config.remote = { enabled: true, port: res.port };
      this._saveConfig();
      this._updateRemoteServerUI(true, res.ips, res.port);
    } else {
      if (errorEl) {
        errorEl.textContent = `Failed to start server: ${res.error}`;
        errorEl.classList.remove('hidden');
      }
    }
  }

  async _stopRemoteServer() {
    if (!window.electronAPI) return;

    const stopBtn = document.getElementById('remote-stop');
    if (stopBtn) stopBtn.disabled = true;

    const res = await window.electronAPI.remoteStopServer();

    if (stopBtn) stopBtn.disabled = false;

    if (res.success) {
      this.remoteServerRunning = false;
      this.remoteClientCount = 0;
      this.config.remote = { ...(this.config.remote || {}), enabled: false };
      this._saveConfig();
      this._updateRemoteServerUI(false);
    }
  }

  _updateRemoteServerUI(running, ips, port) {
    const startBtn      = document.getElementById('remote-start');
    const stopBtn       = document.getElementById('remote-stop');
    const statusSection = document.getElementById('remote-status-section');
    const portInput     = document.getElementById('remote-port');

    if (!startBtn) return; // Modal not in DOM yet

    if (running) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
      statusSection.classList.remove('hidden');
      portInput.disabled = true;

      if (ips && port) {
        const list = document.getElementById('remote-addresses');
        list.innerHTML = '';
        for (const ip of ips) {
          const li = document.createElement('li');
          li.textContent = `ws://${ip}:${port}`;
          list.appendChild(li);
        }
      }
      this._updateRemoteClientCount();
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      statusSection.classList.add('hidden');
      portInput.disabled = false;
    }
  }

  _updateRemoteClientCount() {
    const el = document.getElementById('remote-client-count');
    if (el) el.textContent = String(this.remoteClientCount);
  }

  // ─── Button Editor Modal ────────────────────────────────────────────────────
  _openEditor(key) {
    this.editorKey = key;
    this.editorVisualState = 'active';

    const existing = this._currentPageButtons()[key];
    if (existing) {
      this.editorDraft = {
        action: existing.action || '',
        actionData: { ...existing.actionData },
        hotkey: existing.hotkey || null,
        inactive: { ...DEFAULT_INACTIVE, ...(existing.inactive || {}) },
        active:   { ...DEFAULT_ACTIVE,   ...(existing.active   || {}) },
      };
    } else {
      this.editorDraft = {
        action: '',
        actionData: {},
        hotkey: null,
        inactive: { ...DEFAULT_INACTIVE },
        active:   { ...DEFAULT_ACTIVE   },
      };
    }

    this._renderEditorAction();
    this._renderEditorVisual();
    this._updateEditorStateTabs();

    const deleteBtn = document.getElementById('editor-delete');
    if (existing) {
      deleteBtn.classList.remove('hidden');
    } else {
      deleteBtn.classList.add('hidden');
    }

    document.getElementById('editor-modal').classList.remove('hidden');
  }

  _closeEditor() {
    document.getElementById('editor-modal').classList.add('hidden');
    this.editorKey = null;
  }

  _bindEditorModal() {
    document.getElementById('editor-close').addEventListener('click',  () => this._closeEditor());
    document.getElementById('editor-cancel').addEventListener('click', () => this._closeEditor());

    document.getElementById('editor-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeEditor();
    });

    document.getElementById('editor-save').addEventListener('click', () => this._saveEditor());

    document.getElementById('editor-delete').addEventListener('click', () => {
      if (this.editorKey) {
        delete this._currentPageButtons()[this.editorKey];
        this._saveConfig();
        this._renderGrid();
        this._applyGridLayout();
        this._closeEditor();
      }
    });

    // State tabs
    document.getElementById('state-inactive-btn').addEventListener('click', () => {
      this._saveCurrentVisualState();
      this.editorVisualState = 'inactive';
      this._renderEditorVisual();
      this._updateEditorStateTabs();
    });

    document.getElementById('state-active-btn').addEventListener('click', () => {
      this._saveCurrentVisualState();
      this.editorVisualState = 'active';
      this._renderEditorVisual();
      this._updateEditorStateTabs();
    });

    // Action type change
    document.getElementById('action-type').addEventListener('change', () => {
      this.editorDraft.action = document.getElementById('action-type').value;
      this._updateActionPickers();
    });

    // Scene picker change
    document.getElementById('action-scene').addEventListener('change', async () => {
      const scene = document.getElementById('action-scene').value;
      this.editorDraft.actionData.sceneName = scene;
      if (this.editorDraft.action === 'toggleSource') {
        await this._populateSourcePicker(scene);
      }
    });

    // Source picker change
    document.getElementById('action-source').addEventListener('change', () => {
      const sel = document.getElementById('action-source');
      const opt = sel.options[sel.selectedIndex];
      this.editorDraft.actionData.sourceName = opt.text;
      this.editorDraft.actionData.sceneItemId = opt.value ? parseInt(opt.value) : null;
    });

    // Page picker change
    document.getElementById('action-target-page').addEventListener('change', () => {
      const val = document.getElementById('action-target-page').value;
      this.editorDraft.actionData.pageIndex = val !== '' ? parseInt(val) : null;
    });

    // Visual form: icon preview
    document.getElementById('vis-icon').addEventListener('input', () => {
      const val = document.getElementById('vis-icon').value.trim();
      const preview = document.getElementById('vis-icon-preview');
      preview.innerHTML = val ? `<i class="fa-solid fa-${val}"></i>` : '';
    });

    // Visual form: image picker
    document.getElementById('vis-image-btn').addEventListener('click', async () => {
      const res = await window.electronAPI.selectImage();
      if (res.success && res.data) {
        this.editorDraft[this.editorVisualState].image = res.data;
        this._showImagePreview(res.data);
      }
    });

    document.getElementById('vis-image-clear').addEventListener('click', () => {
      this.editorDraft[this.editorVisualState].image = null;
      this._hideImagePreview();
    });

    this._bindHotkeyInput();
  }

  _bindHotkeyInput() {
    const input    = document.getElementById('hotkey-input');
    const clearBtn = document.getElementById('hotkey-clear');

    input.addEventListener('focus', () => {
      input.dataset.capturing = 'true';
      input.value = '';
      input.placeholder = 'Press keys…';
      input.classList.add('capturing');
    });

    input.addEventListener('blur', () => {
      input.dataset.capturing = 'false';
      input.classList.remove('capturing');
      // Restore the current draft value if nothing was captured
      if (!input.value) {
        input.value = this.editorDraft.hotkey ? _formatHotkey(this.editorDraft.hotkey) : '';
        input.placeholder = 'Click to set…';
      }
    });

    input.addEventListener('keydown', (e) => {
      if (input.dataset.capturing !== 'true') return;
      e.preventDefault();
      e.stopPropagation();
      // Ignore bare modifier presses
      if (MODIFIER_KEYS.includes(e.key)) return;
      // Escape cancels capture without setting a hotkey
      if (e.key === 'Escape') {
        input.value = this.editorDraft.hotkey ? _formatHotkey(this.editorDraft.hotkey) : '';
        input.placeholder = 'Click to set…';
        input.dataset.capturing = 'false';
        input.classList.remove('capturing');
        input.blur();
        return;
      }
      const combo = _buildHotkeyString(e);
      this.editorDraft.hotkey = combo;
      input.value = _formatHotkey(combo);
      input.placeholder = 'Click to set…';
      input.dataset.capturing = 'false';
      input.classList.remove('capturing');
      clearBtn.classList.remove('hidden');
      input.blur();
    });

    clearBtn.addEventListener('click', () => {
      this.editorDraft.hotkey = null;
      input.value = '';
      input.placeholder = 'Click to set…';
      clearBtn.classList.add('hidden');
    });
  }

  _updateEditorStateTabs() {
    const inactiveBtn = document.getElementById('state-inactive-btn');
    const activeBtn   = document.getElementById('state-active-btn');
    if (this.editorVisualState === 'inactive') {
      inactiveBtn.classList.add('active-tab');
      activeBtn.classList.remove('active-tab');
    } else {
      activeBtn.classList.add('active-tab');
      inactiveBtn.classList.remove('active-tab');
    }
  }

  _renderEditorAction() {
    // Action type
    document.getElementById('action-type').value = this.editorDraft.action || '';
    this._populateScenePicker();
    this._updateActionPickers();

    // Hotkey
    const hotkey    = this.editorDraft.hotkey;
    const hotkeyInput = document.getElementById('hotkey-input');
    const hotkeyClear = document.getElementById('hotkey-clear');
    hotkeyInput.value = hotkey ? _formatHotkey(hotkey) : '';
    hotkeyInput.placeholder = 'Click to set…';
    hotkeyInput.dataset.capturing = 'false';
    hotkeyInput.classList.remove('capturing');
    if (hotkey) {
      hotkeyClear.classList.remove('hidden');
    } else {
      hotkeyClear.classList.add('hidden');
    }
  }

  async _populateScenePicker() {
    const sceneSelect = document.getElementById('action-scene');
    sceneSelect.innerHTML = '<option value="">Select a scene…</option>';

    if (!this.obsConnected) {
      document.getElementById('action-obs-hint').classList.remove('hidden');
      return;
    }

    document.getElementById('action-obs-hint').classList.add('hidden');

    const res = await window.electronAPI.obsGetScenes();
    if (!res.success) return;

    this.obsScenes = res.scenes;
    for (const s of res.scenes) {
      const opt = document.createElement('option');
      opt.value = s.sceneName;
      opt.textContent = s.sceneName;
      if (s.sceneName === this.editorDraft.actionData.sceneName) opt.selected = true;
      sceneSelect.appendChild(opt);
    }

    // If a scene was pre-selected and action is toggleSource, populate sources
    if (this.editorDraft.actionData.sceneName && this.editorDraft.action === 'toggleSource') {
      await this._populateSourcePicker(this.editorDraft.actionData.sceneName);
    }
  }

  async _populateSourcePicker(sceneName) {
    const sourceSelect = document.getElementById('action-source');
    sourceSelect.innerHTML = '<option value="">Select a source…</option>';

    if (!sceneName || !this.obsConnected) return;

    let sources = this.sourcesCache.get(sceneName);
    if (!sources) {
      const res = await window.electronAPI.obsGetSourcesForScene(sceneName);
      if (!res.success) return;
      sources = res.items;
      this.sourcesCache.set(sceneName, sources);
    }

    for (const item of sources) {
      const opt = document.createElement('option');
      opt.value = item.sceneItemId;
      opt.textContent = item.sourceName;
      if (item.sceneItemId === this.editorDraft.actionData.sceneItemId) opt.selected = true;
      sourceSelect.appendChild(opt);
    }
  }

  _updateActionPickers() {
    const action = this.editorDraft.action;
    const scenePicker     = document.getElementById('scene-picker');
    const sourcePicker    = document.getElementById('source-picker');
    const pageIndexPicker = document.getElementById('page-index-picker');

    scenePicker.classList.toggle('hidden', action !== 'scene' && action !== 'toggleSource');
    sourcePicker.classList.toggle('hidden', action !== 'toggleSource');
    pageIndexPicker.classList.toggle('hidden', action !== 'navigatePage');

    if (action === 'navigatePage') {
      // Default pageIndex to 0 when first selecting this action type
      if (this.editorDraft.actionData.pageIndex == null) {
        this.editorDraft.actionData.pageIndex = 0;
      }
      this._populatePagePicker();
    }
  }

  _populatePagePicker() {
    const select = document.getElementById('action-target-page');
    select.innerHTML = '';
    this._activeProfile().pages.forEach((page, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = page.name;
      if (idx === this.editorDraft.actionData.pageIndex) opt.selected = true;
      select.appendChild(opt);
    });
  }

  _renderEditorVisual() {
    const s = this.editorDraft[this.editorVisualState];

    document.getElementById('vis-text').value            = s.text            || '';
    document.getElementById('vis-bg-color').value        = s.backgroundColor || DEFAULT_INACTIVE.backgroundColor;
    document.getElementById('vis-border-color').value    = s.borderColor     || DEFAULT_INACTIVE.borderColor;
    document.getElementById('vis-text-color').value      = s.textColor       || DEFAULT_INACTIVE.textColor;
    document.getElementById('vis-icon').value            = s.icon            || '';
    document.getElementById('vis-icon-preview').innerHTML = s.icon
      ? `<i class="fa-solid fa-${s.icon}"></i>` : '';

    // Text position
    const radios = document.querySelectorAll('input[name="vis-text-pos"]');
    for (const radio of radios) {
      radio.checked = radio.value === (s.textPosition || 'center');
    }

    // Image
    if (s.image) {
      this._showImagePreview(s.image);
    } else {
      this._hideImagePreview();
    }
  }

  _saveCurrentVisualState() {
    const s = this.editorDraft[this.editorVisualState];
    if (!s) return;

    s.text            = document.getElementById('vis-text').value;
    s.backgroundColor = document.getElementById('vis-bg-color').value;
    s.borderColor     = document.getElementById('vis-border-color').value;
    s.textColor       = document.getElementById('vis-text-color').value;
    s.icon            = document.getElementById('vis-icon').value.trim() || null;

    const checked = document.querySelector('input[name="vis-text-pos"]:checked');
    s.textPosition = checked ? checked.value : 'center';
    // image is already set in editorDraft by the picker/clear handlers
  }

  _showImagePreview(dataUrl) {
    const img   = document.getElementById('vis-image-preview');
    const clear = document.getElementById('vis-image-clear');
    img.src = dataUrl;
    img.classList.remove('hidden');
    clear.classList.remove('hidden');
  }

  _hideImagePreview() {
    const img   = document.getElementById('vis-image-preview');
    const clear = document.getElementById('vis-image-clear');
    img.src = '';
    img.classList.add('hidden');
    clear.classList.add('hidden');
  }

  _saveEditor() {
    this._saveCurrentVisualState();

    // Collect action data
    const action = document.getElementById('action-type').value;
    const actionData = {};

    if (action === 'scene' || action === 'toggleSource') {
      actionData.sceneName = document.getElementById('action-scene').value || null;
    }

    if (action === 'toggleSource') {
      const sel = document.getElementById('action-source');
      const opt = sel.options[sel.selectedIndex];
      actionData.sourceName  = opt ? opt.text : null;
      actionData.sceneItemId = opt && opt.value ? parseInt(opt.value) : null;
    }

    if (action === 'navigatePage') {
      const val = document.getElementById('action-target-page').value;
      actionData.pageIndex = val !== '' ? parseInt(val) : null;
    }

    this._currentPageButtons()[this.editorKey] = {
      action: action || null,
      actionData,
      hotkey: this.editorDraft.hotkey || null,
      inactive: { ...this.editorDraft.inactive },
      active:   { ...this.editorDraft.active   },
    };

    this._saveConfig();

    // Fetch source state if it's a new toggleSource button
    if (action === 'toggleSource' && actionData.sceneName && actionData.sceneItemId != null) {
      window.electronAPI.obsGetSceneItemEnabled({
        sceneName: actionData.sceneName,
        sceneItemId: actionData.sceneItemId,
      }).then((res) => {
        if (res.success) {
          const stateKey = `${actionData.sceneName}::${actionData.sceneItemId}`;
          this.sceneItemStates.set(stateKey, res.enabled);
          this._refreshButton(this.editorKey);
        }
      });
    }

    this._renderGrid();
    this._applyGridLayout();
    this._closeEditor();
  }

  // ─── Export / Import ───────────────────────────────────────────────────────
  _exportConfig() {
    const json = JSON.stringify(this.config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href     = url;
    a.download = `deckgrid-config-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this._showToast('Config exported', 'success');
  }

  _importConfig(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        // Basic validation
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error('Invalid config file');
        }

        let profiles;
        let activeProfileIndex = 0;

        if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
          // New multi-profile format — overwrites all profiles
          profiles = parsed.profiles;
          activeProfileIndex = parsed.activeProfileIndex ?? 0;
          if (activeProfileIndex >= profiles.length) activeProfileIndex = 0;
        } else if (Array.isArray(parsed.pages) && parsed.pages.length > 0) {
          // Old multi-page, single-profile format
          const def = this._defaultConfig().profiles[0];
          profiles = [{
            name:    'Default',
            rows:    parsed.rows    ?? def.rows,
            columns: parsed.columns ?? def.columns,
            zoom:    parsed.zoom    ?? def.zoom,
            pages:   parsed.pages,
          }];
        } else if (typeof parsed.buttons === 'object' && parsed.buttons !== null) {
          // Very old single-page format
          const def = this._defaultConfig().profiles[0];
          profiles = [{
            name:    'Default',
            rows:    parsed.rows    ?? def.rows,
            columns: parsed.columns ?? def.columns,
            zoom:    parsed.zoom    ?? def.zoom,
            pages:   [{ name: 'Page 1', buttons: parsed.buttons }],
          }];
        } else {
          throw new Error('Config file must contain a "profiles" array, "pages" array, or "buttons" object');
        }

        this.config = {
          obs:                parsed.obs ?? this.config.obs,
          remote:             this.config.remote,
          activeProfileIndex,
          profiles,
        };
        this.currentPageIndex = 0;
        this._saveConfig();
        this._renderGrid();
        this._applyGridLayout();
        this._applyZoom();
        this._renderPageBar();
        this._renderProfileSelector();
        this._syncGridControls();
        this._showToast('Config imported', 'success');
      } catch (err) {
        this._showToast(`Import failed: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
  }

  // ─── Toast notifications ───────────────────────────────────────────────────
  _showToast(message, type = 'info') {
    const existing = document.getElementById('toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'toast';
    toast.textContent = message;

    const colorMap = { info: '#4a9eff', warning: '#ffa048', error: '#ff4757', success: '#00c87a' };
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: colorMap[type] || colorMap.info,
      color: 'white',
      padding: '10px 20px',
      borderRadius: '8px',
      fontWeight: '600',
      fontSize: '13px',
      zIndex: '9999',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      transition: 'opacity 0.3s ease',
    });

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window.app = new DeckGrid();
});
