/**
 * USB detection and audio file scanning.
 * Handles Windows (wmic/PowerShell) and Linux (lsblk) transparently.
 */

import { readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import type { Song, UsbStatus } from '../shared/types';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma', '.opus']);
const DEFAULT_AVG_SONG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// --------------------------------------------------------------------------
// Internal drive info
// --------------------------------------------------------------------------

interface DriveInfo {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

// --------------------------------------------------------------------------
// Platform-specific USB detection
// --------------------------------------------------------------------------

async function detectWindowsDrive(): Promise<DriveInfo | null> {
  try {
    const proc = Bun.spawn(
      ['wmic', 'logicaldisk', 'where', 'DriveType=2', 'get', 'Caption,FreeSpace,Size', '/format:csv'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const raw = await new Response(proc.stdout).text();

    for (const line of raw.split('\n')) {
      const parts = line.trim().split(',');
      // CSV columns: Node, Caption, FreeSpace, Size
      if (parts.length < 4) continue;
      const caption = parts[1]?.trim();
      const free    = Number(parts[2]?.trim());
      const size    = Number(parts[3]?.trim());
      if (caption && !isNaN(free) && !isNaN(size) && size > 0) {
        return { path: caption + '\\', totalBytes: size, freeBytes: free };
      }
    }
  } catch (e) {
    console.error('[usb] Windows detection error:', e);
  }
  return null;
}

async function detectLinuxDrive(): Promise<DriveInfo | null> {
  try {
    const proc = Bun.spawn(
      ['lsblk', '-J', '-b', '-o', 'NAME,MOUNTPOINT,HOTPLUG,FSAVAIL,FSSIZE'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const raw = await new Response(proc.stdout).text();
    const data = JSON.parse(raw) as {
      blockdevices: Array<{ hotplug: string; mountpoint: string | null; fsavail: string | null; fssize: string | null; children?: unknown[] }>;
    };

    const find = (devices: typeof data.blockdevices): DriveInfo | null => {
      for (const dev of devices) {
        if (dev.hotplug === '1' && dev.mountpoint) {
          const freeBytes  = Number(dev.fsavail ?? 0);
          const totalBytes = Number(dev.fssize  ?? 0);
          if (totalBytes > 0) {
            return { path: dev.mountpoint, totalBytes, freeBytes };
          }
        }
        if (dev.children) {
          const found = find(dev.children as typeof data.blockdevices);
          if (found) return found;
        }
      }
      return null;
    };

    return find(data.blockdevices ?? []);
  } catch (e) {
    console.error('[usb] Linux detection error:', e);
  }
  return null;
}

// --------------------------------------------------------------------------
// Audio file scanning
// --------------------------------------------------------------------------

function scanAudioFiles(dir: string, depth = 0): Song[] {
  if (depth > 2) return []; // limit recursion to avoid scanning entire drive
  const songs: Song[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) {
        songs.push(...scanAudioFiles(fullPath, depth + 1));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          try {
            const stat = statSync(fullPath);
            songs.push({
              id: Buffer.from(fullPath).toString('base64url'),
              filename: entry.name,
              path: fullPath,
              size: stat.size,
              title: basename(entry.name, ext),
            });
          } catch { /* skip unreadable files */ }
        }
      }
    }
  } catch { /* skip unreadable directories */ }
  return songs;
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export async function getUsbStatus(): Promise<UsbStatus> {
  const drive = process.platform === 'win32'
    ? await detectWindowsDrive()
    : await detectLinuxDrive();

  if (!drive) {
    return { connected: false };
  }

  const songs = scanAudioFiles(drive.path);

  const avgSongSizeBytes = songs.length > 0
    ? songs.reduce((sum, s) => sum + s.size, 0) / songs.length
    : DEFAULT_AVG_SONG_SIZE_BYTES;

  const estimatedSongsFit = Math.floor(drive.freeBytes / avgSongSizeBytes);
  const isFull = drive.freeBytes < avgSongSizeBytes;

  return {
    connected: true,
    path: drive.path,
    totalBytes: drive.totalBytes,
    freeBytes: drive.freeBytes,
    songs,
    avgSongSizeBytes,
    estimatedSongsFit,
    isFull,
  };
}

export async function deleteSongFromUsb(songPath: string): Promise<void> {
  await Bun.file(songPath).exists(); // verify file exists before unlinking
  const { unlink } = await import('fs/promises');
  await unlink(songPath);
}
