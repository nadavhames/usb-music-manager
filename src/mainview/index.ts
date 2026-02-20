/**
 * Renderer script (runs in the webview / browser context).
 *
 * Electrobun renderer RPC API (from official docs):
 *   Call bun requests:  electroview.rpc.request.methodName(params) → Promise
 *   Send bun messages:  electroview.rpc.send.methodName(params)
 *   Receive from bun:   handled in Electroview.defineRPC({ handlers: { messages: {...} } })
 *
 * Structure:
 *  1.  Electroview RPC setup
 *  2.  App state
 *  3.  Utility helpers
 *  4.  View renderers (Library, Search, Queue, Backup, Settings)
 *  5.  Navigation
 *  6.  USB status bar update
 *  7.  Boot
 */

import { Electroview } from 'electrobun/view';
import type {
  AppRPC, UsbStatus, QueueItem, QueueStatus, BackupSong, YoutubeSearchResult,
} from '../shared/types';

// ============================================================
// 1. ELECTROVIEW RPC SETUP
// ============================================================

const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 6000,
  handlers: {
    requests: {},
    messages: {
      queueUpdated({ items }: { items: QueueItem[] }) {
        state.queue = items;
        renderQueueView();
        updateQueueBadge();
      },

      usbStatusChanged({ status }: { status: UsbStatus }) {
        state.usb = status;
        updateUsbStatusBar();
        if (state.currentView === 'library') renderLibraryView();
        if (state.currentView === 'queue') {
          const w = el('usb-full-warning');
          if (w) w.style.display = status.isFull ? 'block' : 'none';
        }
      },

      downloadProgress({ id, progress, status }: { id: string; progress: number; status: QueueStatus; error?: string }) {
        const item = state.queue.find(i => i.id === id);
        if (item) { item.progress = progress; item.status = status; }
        if (state.currentView === 'queue') renderQueueView();
      },

      updateAvailable({ version }: { version: string }) {
        const banner = el('update-banner');
        const text   = el('update-banner-text');
        if (banner) {
          text.textContent = `🚀 Version ${version} is available!`;
          banner.style.display = 'flex';
        }
      },
    },
  },
});

const ev = new Electroview({ rpc });

// Safe RPC wrappers (ev.rpc can be undefined)
function request<T>(fn: (rpc: NonNullable<typeof ev.rpc>) => Promise<T>): Promise<T> {
  if (!ev.rpc) return Promise.reject(new Error('RPC not available'));
  return fn(ev.rpc);
}
function send(fn: (rpc: NonNullable<typeof ev.rpc>) => void): void {
  if (!ev.rpc) return;
  fn(ev.rpc);
}

const api = {
  getUsbStatus:         () => request(r => r.request.getUsbStatus({})),
  deleteSong:           (path: string) => request(r => r.request.deleteSong({ path })),
  getSongFileUrl:       (path: string) => request(r => r.request.getSongFileUrl({ path })),
  searchYoutube:        (query: string) => request(r => r.request.searchYoutube({ query })),
  getYoutubePreviewUrl: (url: string) => request(r => r.request.getYoutubePreviewUrl({ youtubeUrl: url })),
  addToQueue:           (url: string, title: string, thumbnail?: string) =>
                          request(r => r.request.addToQueue({ url, title, thumbnail })),
  cancelQueueItem:      (id: string) => request(r => r.request.cancelQueueItem({ id })),
  removeQueueItem:      (id: string) => request(r => r.request.removeQueueItem({ id })),
  getQueue:             () => request(r => r.request.getQueue({})),
  processQueue:         () => request(r => r.request.processQueue({})),
  getBackupList:        () => request(r => r.request.getBackupList({})),
  removeFromBackup:     (id: string) => request(r => r.request.removeFromBackup({ id })),
  redownloadFromBackup: (id: string) => request(r => r.request.redownloadFromBackup({ id })),
  getSettings:          () => request(r => r.request.getSettings({})),
  updateYtdlp:          () => request(r => r.request.updateYtdlp({})),
  setTheme:             (theme: 'dark' | 'light') => request(r => r.request.setTheme({ theme })),
  applyUpdate:          () => request(r => r.request.applyUpdate({})),
  log:                  (msg: string) => send(r => r.send.log({ msg })),
};

// ============================================================
// 2. APP STATE
// ============================================================

interface AppState {
  currentView: string;
  usb: UsbStatus;
  queue: QueueItem[];
  backupList: BackupSong[];
  searchResults: YoutubeSearchResult[];
  searchHistory: string[];   // Fix #8: recent search queries
  playingSongPath: string | null;
  previewingUrl: string | null;
  theme: 'dark' | 'light';
  searchLoading: boolean;
}

const state: AppState = {
  currentView: 'library',
  usb: { connected: false },
  queue: [],
  backupList: [],
  searchResults: [],
  searchHistory: [],
  playingSongPath: null,
  previewingUrl: null,
  theme: 'dark',
  searchLoading: false,
};

// ============================================================
// 3. UTILITY HELPERS
// ============================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Fix #6: use style.display instead of hidden attribute for reliable layout
function showBar(id: string): void {
  const e = el(id);
  if (e) e.style.display = 'flex';
}
function hideBar(id: string): void {
  const e = el(id);
  if (e) e.style.display = 'none';
}
function showEl(id: string, display = 'block'): void {
  const e = el(id);
  if (e) e.style.display = display;
}
function hideEl(id: string): void {
  const e = el(id);
  if (e) e.style.display = 'none';
}

// ============================================================
// 4A. LIBRARY VIEW
// ============================================================

function renderLibraryView(): void {
  const { usb } = state;
  const listEl = el('song-list');

  if (usb.connected && usb.totalBytes && usb.freeBytes !== undefined) {
    showEl('space-card', 'block');
    const usedBytes = usb.totalBytes - usb.freeBytes;
    const pct = (usedBytes / usb.totalBytes) * 100;
    el('space-bar').style.width = `${pct.toFixed(1)}%`;
    el('space-bar').classList.toggle('full', !!usb.isFull);
    el('space-free').textContent = `${formatBytes(usb.freeBytes)} free`;
    el('space-fits-count').textContent = String(usb.estimatedSongsFit ?? 0);
  } else {
    hideEl('space-card');
  }

  if (!usb.connected || !usb.songs?.length) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${usb.connected ? '🎵' : '🔌'}</div>
        <p>${usb.connected ? 'No audio files found on USB.' : 'Connect your USB device to see songs.'}</p>
      </div>`;
    return;
  }

  // Fix #7: sort songs alphabetically by title
  const sorted = [...usb.songs].sort((a, b) => a.title.localeCompare(b.title));

  listEl.innerHTML = sorted.map(song => {
    const isPlaying = state.playingSongPath === song.path;
    return `
      <div class="song-card${isPlaying ? ' playing' : ''}" data-path="${escHtml(song.path)}">
        <span class="song-icon">${isPlaying ? '🔊' : '🎵'}</span>
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

  listEl.querySelectorAll<HTMLButtonElement>('.play-song-btn').forEach(btn => {
    btn.addEventListener('click', () => playSong(btn.dataset['path']!, btn.dataset['title']!));
  });
  listEl.querySelectorAll<HTMLButtonElement>('.delete-song-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteSong(btn.dataset['path']!));
  });
}

// Fix #4: getSongFileUrl now returns a base64 data URL from the main process
// so the webview audio element can play it without file:// permission issues.
async function playSong(path: string, title: string): Promise<void> {
  try {
    const { url, error } = await api.getSongFileUrl(path);
    if (!url || error) {
      api.log(`getSongFileUrl failed: ${error}`);
      alert(`Could not load audio: ${error ?? 'unknown error'}`);
      return;
    }
    const player = el<HTMLAudioElement>('audio-player');
    player.src = url;
    player.play();
    state.playingSongPath = path;
    el('now-playing-title').textContent = title;
    showBar('playback-bar');
    renderLibraryView();
  } catch (e) {
    api.log(`playSong error: ${e}`);
    alert(`Playback error: ${e}`);
  }
}

async function deleteSong(path: string): Promise<void> {
  if (!confirm('Delete this song from the USB?')) return;
  const { success, error } = await api.deleteSong(path);
  if (!success) { alert(`Error deleting song: ${error}`); return; }
  const refreshed = await api.getUsbStatus();
  state.usb = refreshed;
  if (state.playingSongPath === path) {
    el<HTMLAudioElement>('audio-player').pause();
    state.playingSongPath = null;
    hideBar('playback-bar');
  }
  renderLibraryView();
  updateUsbStatusBar();
}

// ============================================================
// 4B. SEARCH VIEW
// ============================================================

// Fix #8: push to history, deduplicate, cap at 8 items
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
      el<HTMLFormElement>('search-form').requestSubmit();
    });
  });
}

function renderSearchResults(): void {
  const container = el('search-results');

  if (state.searchLoading) {
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
      <img class="result-thumb"
        src="${escHtml(r.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none'" />
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
    btn.addEventListener('click', () => previewYoutube(btn.dataset['url']!, btn.dataset['title']!));
  });
  container.querySelectorAll<HTMLButtonElement>('.enqueue-btn').forEach(btn => {
    btn.addEventListener('click', () => enqueueResult(btn.dataset['url']!, btn.dataset['title']!, btn.dataset['thumb']));
  });
}

async function previewYoutube(youtubeUrl: string, title: string): Promise<void> {
  const player = el<HTMLAudioElement>('preview-player');
  el('preview-title').textContent = 'Loading…';
  showBar('preview-bar');

  const { url, error } = await api.getYoutubePreviewUrl(youtubeUrl);
  if (error || !url) {
    el('preview-title').textContent = 'Preview unavailable.';
    api.log(`Preview failed for ${youtubeUrl}: ${error}`);
    return;
  }
  player.src = url;
  player.play();
  el('preview-title').textContent = title;
  state.previewingUrl = youtubeUrl;
}

async function enqueueResult(url: string, title: string, thumbnail?: string): Promise<void> {
  await api.addToQueue(url, title, thumbnail);
  state.queue = await api.getQueue();
  updateQueueBadge();
  alert(`"${title}" added to queue.`);
}

// ============================================================
// 4C. QUEUE VIEW
// ============================================================

function renderQueueView(): void {
  const container = el('queue-list');
  const { queue } = state;

  // USB full warning
  const w = el('usb-full-warning');
  if (w) w.style.display = (state.usb.isFull ? 'block' : 'none');

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
    // Fix #2: show remove button for terminal states
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
          ${canCancel
            ? `<button class="btn-icon cancel-btn" data-id="${escHtml(item.id)}" title="Cancel">✕</button>`
            : ''}
          ${canRemove
            ? `<button class="btn-icon btn-danger remove-queue-btn" data-id="${escHtml(item.id)}" title="Remove">🗑</button>`
            : ''}
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll<HTMLButtonElement>('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api.cancelQueueItem(btn.dataset['id']!);
      state.queue = await api.getQueue();
      renderQueueView();
      updateQueueBadge();
    });
  });

  // Fix #2: wire up remove buttons
  container.querySelectorAll<HTMLButtonElement>('.remove-queue-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api.removeQueueItem(btn.dataset['id']!);
      state.queue = await api.getQueue();
      renderQueueView();
      updateQueueBadge();
    });
  });
}

function updateQueueBadge(): void {
  const active = state.queue.filter(i => i.status === 'pending' || i.status === 'downloading').length;
  const badge  = el('queue-badge');
  if (active > 0) {
    badge.textContent = String(active);
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ============================================================
// 4D. BACKUP VIEW
// ============================================================

async function loadAndRenderBackup(): Promise<void> {
  // Fix #7: backend returns sorted by date desc; Fix #1: backend deduplicates
  state.backupList = await api.getBackupList();
  renderBackupView();
}

function renderBackupView(): void {
  const container = el('backup-list');
  const { backupList } = state;

  if (!backupList.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📂</div>
        <p>No songs downloaded yet.</p>
      </div>`;
    return;
  }

  container.innerHTML = backupList.map(song => `
    <div class="backup-item" data-id="${escHtml(song.id)}">
      <div class="backup-info">
        <div class="backup-title">${escHtml(song.title)}</div>
        <div class="backup-meta">Downloaded ${new Date(song.downloadedAt).toLocaleDateString()}</div>
        <div class="backup-url" title="${escHtml(song.youtubeUrl)}">${escHtml(song.youtubeUrl)}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-ghost re-enqueue-btn"
          data-id="${escHtml(song.id)}" title="Add to queue for re-download">⬇ Re-add</button>
        <button class="btn-icon btn-danger remove-backup-btn"
          data-id="${escHtml(song.id)}" title="Remove from backup">🗑</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll<HTMLButtonElement>('.re-enqueue-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { id } = await api.redownloadFromBackup(btn.dataset['id']!);
      if (id) {
        state.queue = await api.getQueue();
        updateQueueBadge();
        alert('Added to download queue.');
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.remove-backup-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove from backup list?')) return;
      await api.removeFromBackup(btn.dataset['id']!);
      await loadAndRenderBackup();
    });
  });
}

// ============================================================
// 4E. SETTINGS VIEW
// ============================================================

// Fix #3: call getSettings() which now returns the real yt-dlp version
async function loadAndRenderSettings(): Promise<void> {
  el('ytdlp-version').textContent = 'checking…';

  document.querySelectorAll<HTMLButtonElement>('[data-theme-btn]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset['themeBtn'] === state.theme);
  });

  try {
    const settings = await api.getSettings();
    const v = settings.ytdlpVersion;
    if (v && v !== 'not found') {
      el('ytdlp-version').textContent = v;
    } else {
      el('ytdlp-version').textContent = 'not installed';
    }
  } catch {
    el('ytdlp-version').textContent = 'error checking version';
  }
}

// ============================================================
// 5. NAVIGATION
// ============================================================

function showView(name: string): void {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${name}`);
  const navBtn = document.querySelector<HTMLElement>(`.nav-item[data-view="${name}"]`);
  if (viewEl) viewEl.classList.add('active');
  if (navBtn) navBtn.classList.add('active');

  state.currentView = name;

  if (name === 'library')  renderLibraryView();
  if (name === 'queue')    renderQueueView();
  if (name === 'backup')   loadAndRenderBackup();
  if (name === 'settings') loadAndRenderSettings();
}

function bindNavigation(): void {
  document.querySelectorAll<HTMLElement>('.nav-item[data-view]').forEach(btn => {
    console.log("fhfhfhf");
    
    btn.addEventListener('click', () => showView(btn.dataset['view']!));
  });
}

// ============================================================
// 6. USB STATUS BAR
// ============================================================

function updateUsbStatusBar(): void {
  const { usb } = state;
  const indicator = el('usb-indicator');
  const info      = el('usb-info');

  if (usb.connected) {
    indicator.className = 'usb-indicator connected';
    info.textContent = usb.freeBytes !== undefined
      ? `USB · ${formatBytes(usb.freeBytes)} free`
      : 'USB connected';
  } else {
    indicator.className = 'usb-indicator disconnected';
    info.textContent = 'No USB';
  }
}

// ============================================================
// 7. GLOBAL EVENT BINDINGS
// ============================================================

function bindGlobalEvents(): void {
  // Fix #8: Search with history
  el('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = el<HTMLInputElement>('search-input').value.trim();
    if (!query) return;
    state.searchLoading = true;
    renderSearchResults();
    try {
      state.searchResults = await api.searchYoutube(query);
      pushSearchHistory(query);
    } catch (err) {
      api.log(`Search error: ${err}`);
      state.searchResults = [];
    }
    state.searchLoading = false;
    renderSearchResults();
  });

  // Stop library playback
  el('stop-playback').addEventListener('click', () => {
    el<HTMLAudioElement>('audio-player').pause();
    state.playingSongPath = null;
    hideBar('playback-bar');
    renderLibraryView();
  });

  // Stop preview
  el('stop-preview').addEventListener('click', () => {
    el<HTMLAudioElement>('preview-player').pause();
    state.previewingUrl = null;
    hideBar('preview-bar');
  });

  // Process queue
  el('process-queue-btn').addEventListener('click', async () => {
    const btn = el<HTMLButtonElement>('process-queue-btn');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    const { started } = await api.processQueue();
    btn.disabled = false;
    btn.textContent = '▶ Download to USB';
    if (!started) alert('No USB device connected. Connect your USB and try again.');
  });

  // Theme toggle
  document.querySelectorAll<HTMLButtonElement>('[data-theme-btn]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset['themeBtn'] as 'dark' | 'light';
      state.theme = theme;
      document.documentElement.dataset['theme'] = theme;
      document.querySelectorAll('[data-theme-btn]').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      await api.setTheme(theme);
    });
  });

  // Update yt-dlp
  el('update-ytdlp-btn').addEventListener('click', async () => {
    const btn      = el<HTMLButtonElement>('update-ytdlp-btn');
    const resultEl = el('update-result');
    btn.disabled   = true;
    btn.textContent = 'Updating…';
    hideEl('update-result');

    const res = await api.updateYtdlp();

    btn.disabled   = false;
    btn.textContent = 'Update yt-dlp';
    showEl('update-result', 'block');
    if (res.success) {
      resultEl.className   = 'update-result success';
      resultEl.textContent = `✓ Updated to version ${res.version ?? '(unknown)'}`;
      el('ytdlp-version').textContent = res.version ?? 'updated';
    } else {
      resultEl.className   = 'update-result error';
      resultEl.textContent = `✗ Update failed: ${res.error ?? 'unknown error'}`;
    }
  });

  // Fix #9: App update banner buttons
  el('update-install-btn').addEventListener('click', async () => {
    const btn = el<HTMLButtonElement>('update-install-btn');
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    const res = await api.applyUpdate();
    if (!res.success) {
      btn.disabled = false;
      btn.textContent = 'Update & Restart';
      alert(`Update failed: ${res.error}`);
    }
    // If success, the app restarts — no further action needed
  });

  el('update-dismiss-btn').addEventListener('click', () => {
    hideEl('update-banner');
  });
}

// ============================================================
// 8. BOOT
// ============================================================

async function boot(): Promise<void> {
  const settings = await api.getSettings();
  state.theme = settings.theme ?? 'dark';
  document.documentElement.dataset['theme'] = state.theme;

  const [usb, queue] = await Promise.all([api.getUsbStatus(), api.getQueue()]);
  state.usb   = usb;
  state.queue = queue;

  bindNavigation();
  bindGlobalEvents();

  showView('library');
  updateUsbStatusBar();
  updateQueueBadge();
}

boot();
