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

// Cached yt-dlp version — fetched once, never blocks a request handler.
let cachedYtdlpVersion = 'checking…';

// --------------------------------------------------------------------------
// Local audio file server
//
// Serves audio files from the USB (or anywhere on disk) directly to the
// webview's <audio> element. This avoids passing large binary blobs through
// Electrobun's RPC layer, which would stall the IPC queue and freeze the UI.
//
// Security: only serves files whose paths are registered in the allowed set
// after the user clicks "Play". Requests for unregistered paths get 403.
// --------------------------------------------------------------------------

const allowedPaths = new Set<string>();

const fileServer = Bun.serve({
  port: 0, // OS picks a free port
  async fetch(req) {
    try {
      const url      = new URL(req.url);
      const filePath = decodeURIComponent(url.pathname.slice(1)); // strip leading /

      if (!allowedPaths.has(filePath)) {
        return new Response('Forbidden', { status: 403 });
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response('Not Found', { status: 404 });
      }

      // Detect MIME type from extension
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'mp3';
      const mimes: Record<string, string> = {
        mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav',
        ogg: 'audio/ogg', m4a: 'audio/mp4',  aac: 'audio/aac',
        opus: 'audio/opus', wma: 'audio/x-ms-wma',
      };

      return new Response(file, {
        headers: {
          'Content-Type': mimes[ext] ?? 'audio/mpeg',
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (e) {
      return new Response('Server Error', { status: 500 });
    }
  },
});

const FILE_SERVER_PORT = fileServer.port;
console.log(`[fileserver] Listening on port ${FILE_SERVER_PORT}`);

// --------------------------------------------------------------------------
// RPC definition
// --------------------------------------------------------------------------

const appRpc = BrowserView.defineRPC<AppRPC>({
  // 60s covers slow yt-dlp search; individual handlers that are fast return
  // immediately so this ceiling rarely matters.
  maxRequestTime: 60_000,
  handlers: {
    requests: {

      // ── USB ──────────────────────────────────────────────────────────────
      async getUsbStatus() { return await getUsbStatus(); },

      async deleteSong({ path }) {
        try { await deleteSongFromUsb(path); return { success: true }; }
        catch (e) { return { success: false, error: String(e) }; }
      },

      // ── YouTube ───────────────────────────────────────────────────────────
      // Note: this can take 5-15s on a slow laptop. The renderer fires it
      // without awaiting in the event handler, so the UI stays responsive.
      async searchYoutube({ query }) {
        return await searchYoutube(query);
      },

      async getYoutubePreviewUrl({ youtubeUrl }) {
        try { return { url: await getPreviewUrl(youtubeUrl) }; }
        catch (e) { return { url: '', error: String(e) }; }
      },

      // ── Queue ─────────────────────────────────────────────────────────────
      addToQueue({ url, title, thumbnail }) {
        return { id: addToQueue({ url, title, thumbnail }) };
      },
      cancelQueueItem({ id }) { cancelQueueItem(id); return { success: true }; },
      removeQueueItem({ id })  { removeQueueItem(id);  return { success: true }; },
      getQueue()               { return getQueue(); },

      async processQueue() {
        if (!currentUsbPath) return { started: false };
        processQueue(currentUsbPath);
        return { started: true };
      },

      // ── Backup ────────────────────────────────────────────────────────────
      getBackupList()       { return getBackupList(); },
      removeFromBackup({ id }) { removeFromBackup(id); return { success: true }; },
      redownloadFromBackup({ id }) {
        const song = findBackupById(id);
        if (!song) return { id: '' };
        return { id: addToQueue({ url: song.youtubeUrl, title: song.title }) };
      },

      // ── Settings ──────────────────────────────────────────────────────────
      // Returns immediately from cache — never spawns a child process.
      getSettings() {
        const s = readSettings();
        return {
          theme:          s.theme,
          ytdlpVersion:   cachedYtdlpVersion,
          fileServerPort: FILE_SERVER_PORT,
        };
      },

      // updateYtdlp CAN be slow (download from GitHub). The renderer fires
      // this without await (fire-and-forget) and disables the button.
      async updateYtdlp() {
        const result = await updateYtdlp();
        if (result.success && result.version) {
          cachedYtdlpVersion = result.version;
          // Push fresh version to renderer so settings page updates
          win.webview.rpc?.proxy.send.ytdlpVersionReady({ version: result.version });
        }
        return result;
      },

      setTheme({ theme }) {
        writeSettings({ ...readSettings(), theme });
        return {};
      },

      // ── File URL for audio playback ───────────────────────────────────────
      // Register the path in the allow-list and return a localhost URL.
      // The renderer's <audio> element streams from the file server — no
      // base64 encoding, no copying through RPC.
      // (Kept for backwards compat but now returns a streaming HTTP URL)

      // ── App update ────────────────────────────────────────────────────────
      async applyUpdate() {
        try {
          await Updater.downloadUpdate();
          if (Updater.updateInfo()?.updateReady) await Updater.applyUpdate();
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
  url:   'views://mainview/index.html',
  frame: { width: 1100, height: 720, x: 200, y: 200 },
  rpc:   appRpc,
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
  items => pushQueueUpdated(items),
  (id, progress, status, error) => pushDownloadProgress(id, progress, status, error),
);

// --------------------------------------------------------------------------
// USB polling — every 4 s, lightweight
// --------------------------------------------------------------------------

async function pollUsb(): Promise<void> {
  try {
    const status = await getUsbStatus();
    currentUsbPath = status.path;
    pushUsbStatusChanged(status);
    if (status.connected && lastUsbConnected === false && currentUsbPath) {
      processQueue(currentUsbPath);
    }
    // Register all USB audio files in the allow-list so playback works
    if (status.songs) {
      for (const s of status.songs) allowedPaths.add(s.path);
    }
    lastUsbConnected = status.connected;
  } catch (e) {
    console.error('[poll] USB poll error:', e);
  }
}

pollUsb();
setInterval(pollUsb, 4_000);

// --------------------------------------------------------------------------
// yt-dlp version — fetched once at startup, result cached + pushed
// --------------------------------------------------------------------------

getYtdlpVersion().then(version => {
  cachedYtdlpVersion = version;
  console.log('[main] yt-dlp version:', version);
  // Push to renderer so settings page can update without polling
  win.webview.rpc?.proxy.send.ytdlpVersionReady({ version });
});

// --------------------------------------------------------------------------
// App update check — 5 s after launch, silent if no baseUrl configured
// --------------------------------------------------------------------------

setTimeout(async () => {
  try {
    const localInfo = await Updater.getLocallocalInfo();
    if (!localInfo?.baseUrl) return;
    const info = await Updater.checkForUpdate();
    if (info?.updateAvailable) pushUpdateAvailable(info.version ?? 'new version');
  } catch {
    // No-op — updater requires a packaged build with baseUrl set
  }
}, 5_000);

// --------------------------------------------------------------------------
// Expose file server port and allow-list helper for playback
// Renderer calls: http://localhost:{port}/{encodedPath}
// --------------------------------------------------------------------------

export { FILE_SERVER_PORT, allowedPaths };
