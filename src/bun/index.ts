/**
 * Main process (Bun).
 */

import { BrowserWindow, BrowserView, Updater } from 'electrobun/bun';
import type { AppRPC, QueueItem, QueueStatus, UsbStatus } from '../shared/types';

import { getUsbStatus, deleteSongFromUsb } from './usb';
import { searchYoutube, getPreviewUrl, getYtdlpVersion, updateYtdlp } from './ytdlp';
import {
  getBackupList, removeFromBackup, findBackupById, readSettings, writeSettings,
} from './backup';
import {
  getQueue, addToQueue, cancelQueueItem, removeQueueItem, processQueue, setQueueListeners,
} from './queue';

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

let lastUsbConnected: boolean | null = null;
let currentUsbPath: string | undefined;

// --------------------------------------------------------------------------
// RPC definition
// --------------------------------------------------------------------------

const appRpc = BrowserView.defineRPC<AppRPC>({
  maxRequestTime: 60_000,
  handlers: {
    requests: {

      // ── USB ──────────────────────────────────────────────────────────────
      async getUsbStatus() { return await getUsbStatus(); },

      async deleteSong({ path }) {
        try { await deleteSongFromUsb(path); return { success: true }; }
        catch (e) { return { success: false, error: String(e) }; }
      },

      // Fix #4: read file bytes in main process → return base64 data URL
      // so the webview audio element doesn't need file:// access permissions.
      async getSongFileUrl({ path }) {
        try {
          const file = Bun.file(path);
          const buffer = await file.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          const ext = path.split('.').pop()?.toLowerCase() ?? 'mp3';
          const mimes: Record<string, string> = {
            mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav',
            ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
            opus: 'audio/opus', wma: 'audio/x-ms-wma',
          };
          const mime = mimes[ext] ?? 'audio/mpeg';
          return { url: `data:${mime};base64,${base64}` };
        } catch (e) {
          return { url: '', error: String(e) };
        }
      },

      // ── YouTube ───────────────────────────────────────────────────────────
      async searchYoutube({ query }) { return await searchYoutube(query); },

      async getYoutubePreviewUrl({ youtubeUrl }) {
        try { return { url: await getPreviewUrl(youtubeUrl) }; }
        catch (e) { return { url: '', error: String(e) }; }
      },

      // ── Queue ─────────────────────────────────────────────────────────────
      addToQueue({ url, title, thumbnail }) {
        return { id: addToQueue({ url, title, thumbnail }) };
      },

      cancelQueueItem({ id }) { cancelQueueItem(id); return { success: true }; },

      // Fix #2: allow removal of cancelled/error items
      removeQueueItem({ id }) { removeQueueItem(id); return { success: true }; },

      getQueue() { return getQueue(); },

      async processQueue() {
        if (!currentUsbPath) return { started: false };
        processQueue(currentUsbPath);
        return { started: true };
      },

      // ── Backup ────────────────────────────────────────────────────────────
      getBackupList() { return getBackupList(); },

      removeFromBackup({ id }) { removeFromBackup(id); return { success: true }; },

      redownloadFromBackup({ id }) {
        const song = findBackupById(id);
        if (!song) return { id: '' };
        return { id: addToQueue({ url: song.youtubeUrl, title: song.title }) };
      },

      // ── Settings ──────────────────────────────────────────────────────────
      // Fix #3: actually call getYtdlpVersion() so the settings page shows real info
      async getSettings() {
        const s = readSettings();
        const ytdlpVersion = await getYtdlpVersion();
        return { theme: s.theme, ytdlpVersion };
      },

      async updateYtdlp() { return await updateYtdlp(); },

      setTheme({ theme }) { writeSettings({ ...readSettings(), theme }); return {}; },

      // ── App Updater ───────────────────────────────────────────────────────
      // Fix #9: download then apply the update
      async applyUpdate() {
        try {
          await Updater.downloadUpdate();
          if (Updater.updateInfo()?.updateReady) {
            await Updater.applyUpdate();
          }
          return { success: true };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    },

    messages: {
      log({ msg }) { console.log('[renderer]', msg); },
    },
  },
});

// --------------------------------------------------------------------------
// Window
// --------------------------------------------------------------------------

const win = new BrowserWindow({
  title: 'USB Music Manager',
  url: 'views://mainview/index.html',
  frame: { width: 1100, height: 720, x: 200, y: 200 },
  rpc: appRpc,
});

// --------------------------------------------------------------------------
// Push helpers
// --------------------------------------------------------------------------

function pushQueueUpdated(items: QueueItem[]): void {
  win.webview.rpc?.proxy.send.queueUpdated({ items });
}

function pushDownloadProgress(id: string, progress: number, status: QueueStatus, error?: string): void {
  win.webview.rpc?.proxy.send.downloadProgress({ id, progress, status, error });
}

function pushUsbStatusChanged(status: UsbStatus): void {
  win.webview.rpc?.proxy.send.usbStatusChanged({ status });
}

function pushUpdateAvailable(version: string): void {
  win.webview.rpc?.proxy.send.updateAvailable({ version });
}

// --------------------------------------------------------------------------
// Queue listeners
// --------------------------------------------------------------------------

setQueueListeners(
  (items) => pushQueueUpdated(items),
  (id, progress, status, error) => pushDownloadProgress(id, progress, status, error),
);

// --------------------------------------------------------------------------
// USB polling
// --------------------------------------------------------------------------

async function pollUsb(): Promise<void> {
  try {
    const status = await getUsbStatus();
    currentUsbPath = status.path;
    pushUsbStatusChanged(status);
    if (status.connected && lastUsbConnected === false && currentUsbPath) {
      processQueue(currentUsbPath);
    }
    lastUsbConnected = status.connected;
  } catch (e) {
    console.error('[poll] USB poll error:', e);
  }
}

pollUsb();
setInterval(pollUsb, 4_000);

// --------------------------------------------------------------------------
// yt-dlp version (log at startup)
// --------------------------------------------------------------------------

getYtdlpVersion().then(v => console.log('[main] yt-dlp version:', v));

// --------------------------------------------------------------------------
// Fix #9: App update check — runs 5s after launch so it doesn't delay boot
// Only fires if release.baseUrl is configured in electrobun.config.ts
// --------------------------------------------------------------------------

setTimeout(async () => {
  try {
    const localInfo = await Updater.getLocallocalInfo();
    if (!localInfo?.baseUrl) return; // no release URL configured — skip

    const info = await Updater.checkForUpdate();
    if (info?.updateAvailable) {
      console.log(`[updater] Update available: ${info.version}`);
      pushUpdateAvailable(info.version ?? 'new version');
    }
  } catch (e) {
    // Silently ignore — updater requires a packaged build with baseUrl set
    console.log('[updater] Update check skipped:', String(e));
  }
}, 5_000);
