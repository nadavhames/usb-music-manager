import { Electroview } from 'electrobun/view';
import type {
  AppRPC, UsbStatus, QueueItem, QueueStatus, BackupSong, YoutubeSearchResult,
} from '../shared/types';

// ============================================================
// 1. RPC SETUP
// ============================================================

const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 60_000,
  handlers: {
    requests: {},
    messages: {
      queueUpdated({ items }: { items: QueueItem[] }) {
        state.queue = items;
        scheduleRender('queue');
        scheduleQueueBadge();
      },
      usbStatusChanged({ status }: { status: UsbStatus }) {
        const wasConnected = state.usb.connected;
        state.usb = status;
        scheduleUsbBar();
        if (state.currentView === 'library') scheduleRender('library');
        if (state.currentView === 'queue')   scheduleRender('queue');
        // Auto-play queue was triggered in main; nothing to do here
        void wasConnected;
      },
      downloadProgress({ id, progress, status }: { id: string; progress: number; status: QueueStatus }) {
        const item = state.queue.find(i => i.id === id);
        if (item) { item.progress = progress; item.status = status; }
        if (state.currentView === 'queue') scheduleRender('queue');
      },
      updateAvailable({ version }: { version: string }) {
        el('update-banner-text').textContent = `🚀 Version ${version} is available!`;
        showEl('update-banner', 'flex');
      },
      // yt-dlp version fetched by main process at startup; pushed here so
      // settings view doesn't need to trigger a slow child-process spawn.
      ytdlpVersionReady({ version }: { version: string }) {
        state.ytdlpVersion = version;
        if (state.currentView === 'settings') {
          el('ytdlp-version').textContent = version || 'not installed';
        }
      },
    },
  },
});

const ev = new Electroview({ rpc });

// Safe wrappers — ev.rpc can be undefined before RPC handshake completes
function request<T>(fn: (r: NonNullable<typeof ev.rpc>) => Promise<T>): Promise<T> {
  if (!ev.rpc) return Promise.reject(new Error('RPC not ready'));
  return fn(ev.rpc);
}
function send(fn: (r: NonNullable<typeof ev.rpc>) => void): void {
  if (ev.rpc) fn(ev.rpc);
}

const api = {
  getUsbStatus:         ()                                        => request(r => r.request.getUsbStatus({})),
  deleteSong:           (path: string)                           => request(r => r.request.deleteSong({ path })),
  searchYoutube:        (query: string)                          => request(r => r.request.searchYoutube({ query })),
  getYoutubePreviewUrl: (url: string)                            => request(r => r.request.getYoutubePreviewUrl({ youtubeUrl: url })),
  addToQueue:           (url: string, title: string, thumb?: string) => request(r => r.request.addToQueue({ url, title, thumbnail: thumb })),
  cancelQueueItem:      (id: string)                             => request(r => r.request.cancelQueueItem({ id })),
  removeQueueItem:      (id: string)                             => request(r => r.request.removeQueueItem({ id })),
  getQueue:             ()                                        => request(r => r.request.getQueue({})),
  processQueue:         ()                                        => request(r => r.request.processQueue({})),
  getBackupList:        ()                                        => request(r => r.request.getBackupList({})),
  removeFromBackup:     (id: string)                             => request(r => r.request.removeFromBackup({ id })),
  redownloadFromBackup: (id: string)                             => request(r => r.request.redownloadFromBackup({ id })),
  getSettings:          ()                                        => request(r => r.request.getSettings({})),
  updateYtdlp:          ()                                        => request(r => r.request.updateYtdlp({})),
  setTheme:             (theme: 'dark' | 'light')                => request(r => r.request.setTheme({ theme })),
  applyUpdate:          ()                                        => request(r => r.request.applyUpdate({})),
  log:                  (msg: string)                             => send(r => r.send.log({ msg })),
};

// ============================================================
// 2. STATE
// ============================================================

interface AppState {
  currentView: string;
  usb: UsbStatus;
  queue: QueueItem[];
  backupList: BackupSong[];
  searchResults: YoutubeSearchResult[];
  searchHistory: string[];
  playingSongPath: string | null;
  previewingUrl: string | null;
  theme: 'dark' | 'light';
  ytdlpVersion: string;
  fileServerPort: number;
  // Per-view loading flags — never block navigation
  loading: Record<string, boolean>;
  searchLoading: boolean;
}

const state: AppState = {
  currentView:    'library',
  usb:            { connected: false },
  queue:          [],
  backupList:     [],
  searchResults:  [],
  searchHistory:  [],
  playingSongPath: null,
  previewingUrl:  null,
  theme:          'dark',
  ytdlpVersion:   'checking…',
  fileServerPort: 0,
  loading:        {},
  searchLoading: false,
};

// ============================================================
// 3. RENDER SCHEDULER
//
// All renders go through requestAnimationFrame so multiple state
// updates in the same tick are batched into one DOM pass.
// ============================================================

const pendingRenders = new Set<string>();

function scheduleRender(view: string): void {
  if (pendingRenders.has(view)) return;   // already queued
  pendingRenders.add(view);
  requestAnimationFrame(() => {
    pendingRenders.delete(view);
    if (view === 'library')  renderLibraryView();
    if (view === 'queue')    renderQueueView();
    if (view === 'backup')   renderBackupView();
    if (view === 'settings') renderSettingsView();
    if (view === 'search')   renderSearchResults();
  });
}

let usbBarPending = false;
function scheduleUsbBar(): void {
  if (usbBarPending) return;
  usbBarPending = true;
  requestAnimationFrame(() => { usbBarPending = false; updateUsbStatusBar(); });
}

let badgePending = false;
function scheduleQueueBadge(): void {
  if (badgePending) return;
  badgePending = true;
  requestAnimationFrame(() => { badgePending = false; updateQueueBadge(); });
}

// ============================================================
// 4. DOM HELPERS
// ============================================================

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function qs<T extends Element>(selector: string, root: Element | Document = document): T | null {
  return root.querySelector<T>(selector);
}

function showEl(id: string, display = 'block'): void {
  const e = el(id); if (e) e.style.display = display;
}
function hideEl(id: string): void {
  const e = el(id); if (e) e.style.display = 'none';
}
function showBar(id: string): void { showEl(id, 'flex'); }
function hideBar(id: string): void { hideEl(id); }

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(n: number): string {
  if (n < 1024)       return `${n} B`;
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3)  return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// Quick non-blocking toast — avoids alert() which freezes JS
function toast(msg: string, type: 'info' | 'error' = 'info'): void {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast-show'));
  setTimeout(() => {
    t.classList.remove('toast-show');
    setTimeout(() => t.remove(), 300);
  }, 3000);
}

// ============================================================
// 5A. LIBRARY VIEW
// ============================================================

function renderLibraryView(): void {
  const { usb } = state;

  if (usb.connected && usb.totalBytes && usb.freeBytes !== undefined) {
    showEl('space-card', 'block');
    const pct = ((usb.totalBytes - usb.freeBytes) / usb.totalBytes) * 100;
    el('space-bar').style.width = `${pct.toFixed(1)}%`;
    el('space-bar').classList.toggle('full', !!usb.isFull);
    el('space-free').textContent = `${formatBytes(usb.freeBytes)} free`;
    el('space-fits-count').textContent = String(usb.estimatedSongsFit ?? 0);
  } else {
    hideEl('space-card');
  }

  const listEl = el('song-list');

  if (state.loading['library']) {
    listEl.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading…</div>`;
    return;
  }

  if (!usb.connected || !usb.songs?.length) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${usb.connected ? '🎵' : '🔌'}</div>
        <p>${usb.connected ? 'No audio files found on USB.' : 'Connect your USB device to see songs.'}</p>
      </div>`;
    return;
  }

  const sorted = [...usb.songs].sort((a, b) => a.title.localeCompare(b.title));

  listEl.innerHTML = sorted.map(song => {
    const playing = state.playingSongPath === song.path;
    return `
      <div class="song-card${playing ? ' playing' : ''}">
        <span class="song-icon">${playing ? '🔊' : '🎵'}</span>
        <div class="song-info">
          <div class="song-title">${escHtml(song.title)}</div>
          <div class="song-meta">${formatBytes(song.size)}</div>
        </div>
        <div class="song-actions">
          <button class="btn-icon play-song-btn" title="Play"
            data-path="${escHtml(song.path)}" data-title="${escHtml(song.title)}">▶</button>
          <button class="btn-icon btn-danger delete-song-btn" title="Delete"
            data-path="${escHtml(song.path)}">🗑</button>
        </div>
      </div>`;
  }).join('');

  // Attach listeners after innerHTML (one pass)
  listEl.querySelectorAll<HTMLButtonElement>('.play-song-btn').forEach(btn => {
    btn.addEventListener('click', () => handlePlaySong(btn.dataset['path']!, btn.dataset['title']!));
  });
  listEl.querySelectorAll<HTMLButtonElement>('.delete-song-btn').forEach(btn => {
    btn.addEventListener('click', () => handleDeleteSong(btn.dataset['path']!));
  });
}

// Non-blocking: button clicks return immediately; audio loads asynchronously.
function handlePlaySong(path: string, title: string): void {
  const player = el<HTMLAudioElement>('audio-player');
  // Build the localhost stream URL from the file server — zero RPC cost
  const url = `http://localhost:${state.fileServerPort}/${encodeURIComponent(path)}`;
  player.src = url;
  state.playingSongPath = path;
  el('now-playing-title').textContent = title;
  showBar('playback-bar');
  // play() returns a promise; catch any autoplay-policy rejection
  player.play().catch(e => {
    api.log(`play() rejected: ${e}`);
    toast('Playback blocked by browser policy — click play on the audio bar', 'error');
  });
  scheduleRender('library');
}

function handleDeleteSong(path: string): void {
  if (!confirm('Delete this song from the USB?')) return;

  // Disable all delete buttons optimistically to prevent double-click
  document.querySelectorAll<HTMLButtonElement>('.delete-song-btn').forEach(b => { b.disabled = true; });

  api.deleteSong(path)
    .then(({ success, error }) => {
      if (!success) { toast(`Delete failed: ${error}`, 'error'); return; }
      if (state.playingSongPath === path) {
        el<HTMLAudioElement>('audio-player').pause();
        state.playingSongPath = null;
        hideBar('playback-bar');
      }
      // Refresh USB state — then render
      return api.getUsbStatus().then(usb => {
        state.usb = usb;
        scheduleRender('library');
        scheduleUsbBar();
      });
    })
    .catch(e => toast(`Error: ${e}`, 'error'));
}

// ============================================================
// 5B. SEARCH VIEW
// ============================================================

// AbortController lets us abandon a slow yt-dlp call when the user
// navigates away or starts a new search. The RPC call still runs in the
// main process, but we ignore the result and re-enable the UI immediately.
let searchAbort: AbortController | null = null;

function handleSearch(query: string): void {
  if (!query.trim()) return;

  // Cancel any in-flight search
  searchAbort?.abort();
  searchAbort = new AbortController();
  const sig = searchAbort.signal;

  state.searchLoading = true;
  scheduleRender('search');

  api.searchYoutube(query)
    .then(results => {
      if (sig.aborted) return;    // navigated away or new search started
      state.searchResults = results;
      pushSearchHistory(query);
    })
    .catch(e => {
      if (sig.aborted) return;
      api.log(`Search error: ${e}`);
      state.searchResults = [];
    })
    .finally(() => {
      if (sig.aborted) return;
      state.searchLoading = false;
      scheduleRender('search');
    });
}

// Augment AppState with searchLoading (was in state already but not typed above)
declare module './index' {}
Object.assign(state, { searchLoading: false });

function pushSearchHistory(query: string): void {
  state.searchHistory = [query, ...state.searchHistory.filter(q => q !== query)].slice(0, 8);
  renderSearchHistory();
}

function renderSearchHistory(): void {
  const chips = el('search-history-chips');
  if (!state.searchHistory.length) { hideEl('search-history'); return; }
  showEl('search-history', 'flex');
  chips.innerHTML = state.searchHistory
    .map(q => `<button class="history-chip" data-query="${escHtml(q)}">${escHtml(q)}</button>`)
    .join('');
  chips.querySelectorAll<HTMLButtonElement>('.history-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      el<HTMLInputElement>('search-input').value = chip.dataset['query']!;
      handleSearch(chip.dataset['query']!);
    });
  });
}

function renderSearchResults(): void {
  const container = el('search-results');
  const loading   = (state as AppState & { searchLoading: boolean }).searchLoading;

  if (loading) {
    container.innerHTML = `<div class="loading-state"><div class="spinner"></div>Searching YouTube…</div>`;
    return;
  }
  if (!state.searchResults.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎧</div>
        <p>Search for songs to preview and download.</p>
      </div>`;
    return;
  }

  container.innerHTML = state.searchResults.map(r => `
    <div class="result-card">
      <img class="result-thumb" src="${escHtml(r.thumbnail)}" alt="" loading="lazy"
        onerror="this.style.display='none'" />
      <div class="result-info">
        <div class="result-title">${escHtml(r.title)}</div>
        <div class="result-meta">${escHtml(r.channelName)} · ${escHtml(r.duration)}</div>
      </div>
      <div class="result-actions">
        <button class="btn btn-ghost preview-btn"
          data-url="${escHtml(r.url)}" data-title="${escHtml(r.title)}">▶ Preview</button>
        <button class="btn btn-primary enqueue-btn"
          data-url="${escHtml(r.url)}" data-title="${escHtml(r.title)}"
          data-thumb="${escHtml(r.thumbnail)}">⬇ Add</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll<HTMLButtonElement>('.preview-btn').forEach(btn => {
    btn.addEventListener('click', () => handlePreview(btn.dataset['url']!, btn.dataset['title']!));
  });
  container.querySelectorAll<HTMLButtonElement>('.enqueue-btn').forEach(btn => {
    btn.addEventListener('click', () => handleEnqueue(btn.dataset['url']!, btn.dataset['title']!, btn.dataset['thumb']));
  });
}

function handlePreview(youtubeUrl: string, title: string): void {
  const player = el<HTMLAudioElement>('preview-player');
  el('preview-title').textContent = 'Loading…';
  showBar('preview-bar');

  api.getYoutubePreviewUrl(youtubeUrl)
    .then(({ url, error }) => {
      if (!url || error) {
        el('preview-title').textContent = 'Preview unavailable';
        return;
      }
      player.src = url;
      player.play().catch(() => {});
      el('preview-title').textContent = title;
      state.previewingUrl = youtubeUrl;
    })
    .catch(() => { el('preview-title').textContent = 'Preview failed'; });
}

function handleEnqueue(url: string, title: string, thumbnail?: string): void {
  // Disable all enqueue buttons to avoid double-add
  document.querySelectorAll<HTMLButtonElement>('.enqueue-btn').forEach(b => { b.disabled = true; });

  api.addToQueue(url, title, thumbnail)
    .then(() => api.getQueue())
    .then(queue => {
      state.queue = queue;
      scheduleQueueBadge();
      toast(`"${title}" added to queue`);
    })
    .catch(e => toast(`Add failed: ${e}`, 'error'))
    .finally(() => {
      document.querySelectorAll<HTMLButtonElement>('.enqueue-btn').forEach(b => { b.disabled = false; });
    });
}

// ============================================================
// 5C. QUEUE VIEW
// ============================================================

function renderQueueView(): void {
  const container = el('queue-list');
  const { queue }  = state;

  const fullWarning = el('usb-full-warning');
  if (fullWarning) fullWarning.style.display = state.usb.isFull ? 'block' : 'none';

  if (!queue.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <p>Queue is empty. Search for songs to add.</p>
      </div>`;
    return;
  }

  container.innerHTML = queue.map(item => {
    const isDownloading = item.status === 'downloading';
    const statusLabel   = isDownloading
      ? `<span class="spinner"></span>${item.progress}%`
      : item.status;
    const canCancel = item.status === 'pending' || item.status === 'downloading';
    const canRemove = item.status === 'cancelled' || item.status === 'error';

    return `
      <div class="queue-item" data-id="${escHtml(item.id)}">
        ${item.thumbnail
          ? `<img class="queue-thumb" src="${escHtml(item.thumbnail)}" alt="" onerror="this.style.display='none'" />`
          : '<div class="queue-thumb"></div>'}
        <div class="queue-body">
          <div class="queue-title">${escHtml(item.title)}</div>
          <div class="queue-status ${item.status}">${statusLabel}</div>
          ${isDownloading
            ? `<div class="progress-bar-wrap"><div class="progress-bar" style="width:${item.progress}%"></div></div>`
            : ''}
          ${item.error ? `<div class="queue-status error" style="font-size:11px">${escHtml(item.error)}</div>` : ''}
        </div>
        <div class="queue-actions">
          ${canCancel ? `<button class="btn-icon cancel-btn" data-id="${escHtml(item.id)}" title="Cancel">✕</button>` : ''}
          ${canRemove ? `<button class="btn-icon btn-danger remove-queue-btn" data-id="${escHtml(item.id)}" title="Remove">🗑</button>` : ''}
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll<HTMLButtonElement>('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      api.cancelQueueItem(btn.dataset['id']!)
        .then(() => api.getQueue())
        .then(q => { state.queue = q; scheduleRender('queue'); scheduleQueueBadge(); })
        .catch(e => toast(`Cancel failed: ${e}`, 'error'));
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.remove-queue-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      api.removeQueueItem(btn.dataset['id']!)
        .then(() => api.getQueue())
        .then(q => { state.queue = q; scheduleRender('queue'); scheduleQueueBadge(); })
        .catch(e => toast(`Remove failed: ${e}`, 'error'));
    });
  });
}

function updateQueueBadge(): void {
  const active = state.queue.filter(i => i.status === 'pending' || i.status === 'downloading').length;
  const badge  = el('queue-badge');
  badge.textContent     = String(active);
  badge.style.display   = active > 0 ? 'inline-block' : 'none';
}

// ============================================================
// 5D. BACKUP VIEW
// ============================================================

function loadBackupAsync(): void {
  state.loading['backup'] = true;
  scheduleRender('backup');
  api.getBackupList()
    .then(list => { state.backupList = list; })
    .catch(e => { api.log(`backup load error: ${e}`); state.backupList = []; })
    .finally(() => { state.loading['backup'] = false; scheduleRender('backup'); });
}

function renderBackupView(): void {
  const container = el('backup-list');

  if (state.loading['backup']) {
    container.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading…</div>`;
    return;
  }

  if (!state.backupList.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📂</div>
        <p>No songs downloaded yet.</p>
      </div>`;
    return;
  }

  container.innerHTML = state.backupList.map(song => `
    <div class="backup-item" data-id="${escHtml(song.id)}">
      <div class="backup-info">
        <div class="backup-title">${escHtml(song.title)}</div>
        <div class="backup-meta">Downloaded ${new Date(song.downloadedAt).toLocaleDateString()}</div>
        <div class="backup-url" title="${escHtml(song.youtubeUrl)}">${escHtml(song.youtubeUrl)}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-ghost re-enqueue-btn" data-id="${escHtml(song.id)}">⬇ Re-add</button>
        <button class="btn-icon btn-danger remove-backup-btn" data-id="${escHtml(song.id)}" title="Remove">🗑</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll<HTMLButtonElement>('.re-enqueue-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      api.redownloadFromBackup(btn.dataset['id']!)
        .then(({ id }) => {
          if (id) return api.getQueue().then(q => { state.queue = q; scheduleQueueBadge(); toast('Added to download queue'); });
        })
        .catch(e => toast(`Re-add failed: ${e}`, 'error'))
        .finally(() => { btn.disabled = false; });
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.remove-backup-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Remove from backup list?')) return;
      btn.disabled = true;
      api.removeFromBackup(btn.dataset['id']!)
        .then(() => loadBackupAsync())
        .catch(e => { toast(`Remove failed: ${e}`, 'error'); btn.disabled = false; });
    });
  });
}

// ============================================================
// 5E. SETTINGS VIEW
// ============================================================

function renderSettingsView(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-theme-btn]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset['themeBtn'] === state.theme);
  });

  const v = state.ytdlpVersion;
  el('ytdlp-version').textContent =
    !v || v === 'checking…'  ? 'checking…'     :
    v === 'not found'        ? 'not installed' : v;
}

function loadSettingsAsync(): void {
  // getSettings is now fast (no child process), but we still do it async
  // so navigation is never blocked
  api.getSettings()
    .then(s => {
      state.ytdlpVersion   = s.ytdlpVersion;
      state.fileServerPort = s.fileServerPort;
      scheduleRender('settings');
    })
    .catch(() => {});
}

// ============================================================
// 6. NAVIGATION — always synchronous, data loads asynchronously
// ============================================================

function showView(name: string): void {
  // 1. Instant CSS swap — never blocked
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${name}`);
  const navBtn = document.querySelector<HTMLElement>(`.nav-item[data-view="${name}"]`);
  if (viewEl) viewEl.classList.add('active');
  if (navBtn) navBtn.classList.add('active');

  state.currentView = name;

  // 2. Cancel any in-flight search when leaving search view
  if (name !== 'search') {
    searchAbort?.abort();
    searchAbort = null;
    (state as AppState & { searchLoading: boolean }).searchLoading = false;
  }

  // 3. Schedule a render with current state (renders immediately if data is
  //    already available, shows loading skeleton if not)
  scheduleRender(name);

  // 4. Kick off data fetch asynchronously — render will update when done
  if (name === 'library') {
    // Library renders from state.usb which is kept fresh by USB polling.
    // No explicit fetch needed unless USB state is stale.
  }
  if (name === 'queue') {
    // Queue is kept fresh via push messages; refresh once on nav
    api.getQueue()
      .then(q => { state.queue = q; scheduleRender('queue'); scheduleQueueBadge(); })
      .catch(() => {});
  }
  if (name === 'backup')   loadBackupAsync();
  if (name === 'settings') loadSettingsAsync();
}

function bindNavigation(): void {
  document.querySelectorAll<HTMLElement>('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset['view']!));
  });
}

// ============================================================
// 7. USB STATUS BAR
// ============================================================

function updateUsbStatusBar(): void {
  const { usb } = state;
  el('usb-indicator').className = `usb-indicator ${usb.connected ? 'connected' : 'disconnected'}`;
  el('usb-info').textContent = usb.connected
    ? (usb.freeBytes !== undefined ? `USB · ${formatBytes(usb.freeBytes)} free` : 'USB connected')
    : 'No USB';
}

// ============================================================
// 8. GLOBAL EVENT BINDINGS
// ============================================================

function bindGlobalEvents(): void {
  // Search form — fire-and-forget, never await
  el('search-form').addEventListener('submit', e => {
    e.preventDefault();
    const query = el<HTMLInputElement>('search-input').value.trim();
    if (query) handleSearch(query);
  });

  // Stop library playback
  el('stop-playback').addEventListener('click', () => {
    el<HTMLAudioElement>('audio-player').pause();
    state.playingSongPath = null;
    hideBar('playback-bar');
    scheduleRender('library');
  });

  // Stop preview
  el('stop-preview').addEventListener('click', () => {
    el<HTMLAudioElement>('preview-player').pause();
    state.previewingUrl = null;
    hideBar('preview-bar');
  });

  // Process queue
  el('process-queue-btn').addEventListener('click', () => {
    const btn = el<HTMLButtonElement>('process-queue-btn');
    btn.disabled    = true;
    btn.textContent = 'Starting…';
    api.processQueue()
      .then(({ started }) => {
        if (!started) toast('No USB connected — plug in your USB first', 'error');
      })
      .catch(e => toast(`Error: ${e}`, 'error'))
      .finally(() => {
        btn.disabled    = false;
        btn.textContent = '▶ Download to USB';
      });
  });

  // Theme toggle
  document.querySelectorAll<HTMLButtonElement>('[data-theme-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset['themeBtn'] as 'dark' | 'light';
      state.theme = theme;
      document.documentElement.dataset['theme'] = theme;
      document.querySelectorAll('[data-theme-btn]').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      // setTheme is fast (just writes JSON) — still fire-and-forget
      api.setTheme(theme).catch(() => {});
    });
  });

  // Update yt-dlp — can take 30+ seconds; never blocks UI
  el('update-ytdlp-btn').addEventListener('click', () => {
    const btn      = el<HTMLButtonElement>('update-ytdlp-btn');
    const resultEl = el('update-result');
    btn.disabled    = true;
    btn.textContent = 'Updating…';
    hideEl('update-result');

    api.updateYtdlp()
      .then(res => {
        showEl('update-result', 'block');
        if (res.success) {
          resultEl.className   = 'update-result success';
          resultEl.textContent = `✓ Updated to ${res.version ?? '(unknown)'}`;
          state.ytdlpVersion   = res.version ?? 'updated';
          el('ytdlp-version').textContent = res.version ?? 'updated';
        } else {
          resultEl.className   = 'update-result error';
          resultEl.textContent = `✗ Failed: ${res.error ?? 'unknown error'}`;
        }
      })
      .catch(e => {
        showEl('update-result', 'block');
        resultEl.className   = 'update-result error';
        resultEl.textContent = `✗ Error: ${e}`;
      })
      .finally(() => {
        btn.disabled    = false;
        btn.textContent = 'Update yt-dlp';
      });
  });

  // App update banner
  el('update-install-btn').addEventListener('click', () => {
    const btn = el<HTMLButtonElement>('update-install-btn');
    btn.disabled    = true;
    btn.textContent = 'Downloading…';
    api.applyUpdate()
      .then(res => {
        if (!res.success) {
          toast(`Update failed: ${res.error}`, 'error');
          btn.disabled    = false;
          btn.textContent = 'Update & Restart';
        }
        // If success the app restarts — nothing more to do
      })
      .catch(e => {
        toast(`Update error: ${e}`, 'error');
        btn.disabled    = false;
        btn.textContent = 'Update & Restart';
      });
  });

  el('update-dismiss-btn').addEventListener('click', () => hideEl('update-banner'));
}

// ============================================================
// 9. BOOT — minimal blocking work, everything else async
// ============================================================

async function boot(): Promise<void> {
  // Only ONE await at boot: get settings for theme + file server port.
  // Everything else is kicked off async and renders when ready.
  try {
    const settings = await api.getSettings();
    state.theme          = settings.theme ?? 'dark';
    state.fileServerPort = settings.fileServerPort;
    state.ytdlpVersion   = settings.ytdlpVersion;
    document.documentElement.dataset['theme'] = state.theme;
  } catch {
    // Continue with defaults if settings fails
  }

  bindNavigation();
  bindGlobalEvents();

  // Show library immediately — renders with empty state while USB polls
  showView('library');

  // Fetch queue in background
  api.getQueue().then(q => { state.queue = q; scheduleQueueBadge(); }).catch(() => {});
}

// Add toast CSS injection (lightweight, avoids adding to main stylesheet)
(function injectToastStyles() {
  const s = document.createElement('style');
  s.textContent = `
    .toast {
      position: fixed; bottom: 24px; right: 24px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 18px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.2s, transform 0.2s;
      z-index: 9999;
      pointer-events: none;
      max-width: 340px;
    }
    .toast.toast-error { border-color: var(--danger); color: var(--danger); }
    .toast.toast-show  { opacity: 1; transform: translateY(0); }
  `;
  document.head.appendChild(s);
})();

boot();
