/**
 * Persistent local backup of all songs ever downloaded.
 */

import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { BackupSong } from '../shared/types';

function getDataDir(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'usb-music-manager');
  }
  return join(home, '.local', 'share', 'usb-music-manager');
}

const DATA_DIR    = getDataDir();
const BACKUP_FILE = join(DATA_DIR, 'backup.json');

function readBackup(): BackupSong[] {
  try {
    if (!existsSync(BACKUP_FILE)) return [];
    const content = require('fs').readFileSync(BACKUP_FILE, 'utf-8');
    return JSON.parse(content) as BackupSong[];
  } catch {
    return [];
  }
}

function writeBackup(songs: BackupSong[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  require('fs').writeFileSync(BACKUP_FILE, JSON.stringify(songs, null, 2), 'utf-8');
}

export function getBackupList(): BackupSong[] {
  // Always return sorted newest-first
  return readBackup().sort(
    (a, b) => new Date(b.downloadedAt).getTime() - new Date(a.downloadedAt).getTime()
  );
}

export function addToBackup(song: Omit<BackupSong, 'id' | 'downloadedAt'>): BackupSong {
  const songs = readBackup();

  // Fix #1: prevent duplicates by YouTube URL
  const existing = songs.find(s => s.youtubeUrl === song.youtubeUrl);
  if (existing) {
    // Update timestamp so it floats to the top of the sorted list
    existing.downloadedAt = new Date().toISOString();
    writeBackup(songs);
    return existing;
  }

  const entry: BackupSong = {
    ...song,
    id: crypto.randomUUID(),
    downloadedAt: new Date().toISOString(),
  };
  songs.unshift(entry);
  writeBackup(songs);
  return entry;
}

export function removeFromBackup(id: string): void {
  const songs = readBackup().filter(s => s.id !== id);
  writeBackup(songs);
}

export function findBackupById(id: string): BackupSong | undefined {
  return readBackup().find(s => s.id === id);
}

// ---------- Settings ----------

export interface PersistedSettings {
  theme: 'dark' | 'light';
}

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

export function readSettings(): PersistedSettings {
  try {
    const content = require('fs').readFileSync(SETTINGS_FILE, 'utf-8');
    return JSON.parse(content) as PersistedSettings;
  } catch {
    return { theme: 'dark' };
  }
}

export function writeSettings(s: PersistedSettings): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  require('fs').writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}
