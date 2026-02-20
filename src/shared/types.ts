import type { RPCSchema } from 'electrobun/bun';

// --------------------------------------------------------------------------
// Domain models
// --------------------------------------------------------------------------

export interface Song {
  id: string;
  filename: string;
  path: string;
  size: number;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
}

export type QueueStatus = 'pending' | 'downloading' | 'complete' | 'error' | 'cancelled';

export interface QueueItem {
  id: string;
  youtubeUrl: string;
  title: string;
  thumbnail?: string;
  status: QueueStatus;
  progress: number;
  error?: string;
}

export interface BackupSong {
  id: string;
  title: string;
  artist?: string;
  youtubeUrl: string;
  filename: string;
  downloadedAt: string;
}

export interface YoutubeSearchResult {
  id: string;
  title: string;
  url: string;
  thumbnail: string;
  duration: string;
  channelName: string;
}

export interface UsbStatus {
  connected: boolean;
  path?: string;
  totalBytes?: number;
  freeBytes?: number;
  songs?: Song[];
  avgSongSizeBytes?: number;
  estimatedSongsFit?: number;
  isFull?: boolean;
}

export interface AppSettings {
  ytdlpVersion: string;
  theme: 'dark' | 'light';
}

// --------------------------------------------------------------------------
// RPC contract
// --------------------------------------------------------------------------

export type AppRPC = {
  bun: RPCSchema<{
    requests: {
      // USB
      getUsbStatus:           { params: Record<string, never>; response: UsbStatus };
      deleteSong:             { params: { path: string }; response: { success: boolean; error?: string } };
      getSongFileUrl:         { params: { path: string }; response: { url: string; error?: string } };
      // YouTube
      searchYoutube:          { params: { query: string }; response: YoutubeSearchResult[] };
      getYoutubePreviewUrl:   { params: { youtubeUrl: string }; response: { url: string; error?: string } };
      // Queue
      addToQueue:             { params: { url: string; title: string; thumbnail?: string }; response: { id: string } };
      cancelQueueItem:        { params: { id: string }; response: { success: boolean } };
      removeQueueItem:        { params: { id: string }; response: { success: boolean } };
      getQueue:               { params: Record<string, never>; response: QueueItem[] };
      processQueue:           { params: Record<string, never>; response: { started: boolean } };
      // Backup
      getBackupList:          { params: Record<string, never>; response: BackupSong[] };
      removeFromBackup:       { params: { id: string }; response: { success: boolean } };
      redownloadFromBackup:   { params: { id: string }; response: { id: string } };
      // Settings
      getSettings:            { params: Record<string, never>; response: AppSettings };
      updateYtdlp:            { params: Record<string, never>; response: { success: boolean; version?: string; error?: string } };
      setTheme:               { params: { theme: 'dark' | 'light' }; response: Record<string, never> };
      // App update
      applyUpdate:            { params: Record<string, never>; response: { success: boolean; error?: string } };
    };
    messages: {
      log: { msg: string };
    };
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      queueUpdated:     { items: QueueItem[] };
      usbStatusChanged: { status: UsbStatus };
      downloadProgress: { id: string; progress: number; status: QueueStatus; error?: string };
      updateAvailable:  { version: string };
    };
  }>;
};
