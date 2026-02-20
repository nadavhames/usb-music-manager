/**
 * yt-dlp wrapper.
 *
 * If yt-dlp is not found, the "Update yt-dlp" flow downloads the latest
 * release binary from GitHub into the app's managed bin directory.
 *
 * Key design decision: we resolve the binary to a full absolute path before
 * every Bun.spawn call. This avoids any reliance on PATH manipulation, which
 * is unreliable in Bun because the spawner may cache PATH at process start.
 */

import { join } from 'path';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import type { YoutubeSearchResult } from '../shared/types';

// --------------------------------------------------------------------------
// Platform constants
// --------------------------------------------------------------------------

const IS_WIN   = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';

// --------------------------------------------------------------------------
// Managed bin directory (app-owned, persists across sessions)
// --------------------------------------------------------------------------

function getManagedBinDir(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  return IS_WIN
    ? join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'usb-music-manager', 'bin')
    : join(home, '.local', 'share', 'usb-music-manager', 'bin');
}

const MANAGED_BIN_DIR  = getManagedBinDir();
const MANAGED_BIN_PATH = join(MANAGED_BIN_DIR, BIN_NAME);

// --------------------------------------------------------------------------
// Binary resolution
//
// Always returns a full absolute path so Bun.spawn never has to search PATH.
// Resolution order:
//   1. App-managed copy  (~/.local/share/usb-music-manager/bin/yt-dlp)
//   2. System PATH       (which yt-dlp / where yt-dlp)
//   3. null              (not installed anywhere)
// --------------------------------------------------------------------------

async function resolvebin(): Promise<string | null> {
  // 1. Managed copy (preferred — always use absolute path)
  if (existsSync(MANAGED_BIN_PATH)) return MANAGED_BIN_PATH;

  // 2. System installation — ask the shell where it is
  try {
    const whichCmd = IS_WIN ? ['where', BIN_NAME] : ['which', BIN_NAME];
    const proc = Bun.spawn(whichCmd, { stdout: 'pipe', stderr: 'pipe' });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code === 0) {
      // `where` may return multiple lines; take the first
      const resolved = out.trim().split('\n')[0].trim();
      if (resolved) return resolved;
    }
  } catch { /* which/where not available — fall through */ }

  return null;
}

// --------------------------------------------------------------------------
// GitHub release download
// --------------------------------------------------------------------------

const GITHUB_RELEASE_BASE =
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

function getGithubAssetUrl(): string {
  if (IS_WIN) return `${GITHUB_RELEASE_BASE}/yt-dlp.exe`;
  return `${GITHUB_RELEASE_BASE}/yt-dlp`;
}

/**
 * Download the latest yt-dlp binary from GitHub into the app's managed dir.
 * Returns the full absolute path to the installed binary.
 */
async function installYtdlp(): Promise<string> {
  const url = getGithubAssetUrl();
  console.log(`[ytdlp] Downloading from ${url} …`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `GitHub download failed: HTTP ${response.status} ${response.statusText}\nURL: ${url}`
    );
  }

  mkdirSync(MANAGED_BIN_DIR, { recursive: true });
  const buffer = await response.arrayBuffer();
  await Bun.write(MANAGED_BIN_PATH, buffer);

  if (!IS_WIN) {
    chmodSync(MANAGED_BIN_PATH, 0o755);
  }

  console.log(`[ytdlp] Installed → ${MANAGED_BIN_PATH}`);
  return MANAGED_BIN_PATH;
}

// --------------------------------------------------------------------------
// Core runner — always uses the full resolved path, never a bare name
// --------------------------------------------------------------------------

async function run(binPath: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([binPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  
  if (code !== 0) throw new Error(err.trim() || `yt-dlp exited with code ${code}`);
  return out;
}

/**
 * Resolve the binary (or throw a clear "not installed" error) then run it.
 * Used by all public helpers except downloadToUsb which needs the AbortSignal.
 */
async function runAuto(args: string[]): Promise<string> {
  const binPath = await resolvebin();
  if (!binPath) {
    throw new Error(
      'yt-dlp is not installed. Open Settings and click "Update yt-dlp" to install it automatically.'
    );
  }
  return run(binPath, args);
}

// --------------------------------------------------------------------------
// Sanitize filenames
// --------------------------------------------------------------------------

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// --------------------------------------------------------------------------
// Search
// --------------------------------------------------------------------------

export async function searchYoutube(query: string): Promise<YoutubeSearchResult[]> {
    console.log("hohohoho");
    
  const raw = await runAuto([
    `ytsearch8:${query}`,
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--skip-download',
  ]);

  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        const d = JSON.parse(line);
        return {
          id:          d.id ?? '',
          title:       d.title ?? 'Unknown',
          url:         d.url ?? `https://www.youtube.com/watch?v=${d.id}`,
          thumbnail:   d.thumbnail ?? d.thumbnails?.[0]?.url ?? '',
          duration:    formatDuration(d.duration),
          channelName: d.uploader ?? d.channel ?? '',
        } satisfies YoutubeSearchResult;
      } catch {
        return null;
      }
    })
    .filter((r): r is YoutubeSearchResult => r !== null);
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// --------------------------------------------------------------------------
// Preview URL
// --------------------------------------------------------------------------

export async function getPreviewUrl(youtubeUrl: string): Promise<string> {
  const url = await runAuto([
    youtubeUrl,
    '--get-url',
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-warnings',
  ]);
  return url.trim();
}

// --------------------------------------------------------------------------
// Download with progress callback
// --------------------------------------------------------------------------

export interface DownloadOptions {
  youtubeUrl: string;
  outputDir: string;
  title: string;
  onProgress: (progress: number) => void;
  signal?: AbortSignal;
}

export async function downloadToUsb(opts: DownloadOptions): Promise<string> {
  const { youtubeUrl, outputDir, title, onProgress, signal } = opts;

  const binPath = await resolvebin();
  if (!binPath) {
    throw new Error(
      'yt-dlp is not installed. Open Settings and click "Update yt-dlp" to install it.'
    );
  }

  const safeTitle      = sanitizeFilename(title);
  const outputTemplate = join(outputDir, `${safeTitle}.%(ext)s`);

  const proc = Bun.spawn(
    [
      binPath,
      youtubeUrl,
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-thumbnail',
      '--add-metadata',
      '--output', outputTemplate,
      '--no-warnings',
      '--newline',
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );

  signal?.addEventListener('abort', () => proc.kill());

  const reader  = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const pct = parseYtdlpProgress(line);
      if (pct !== null) onProgress(pct);
    }
  }

  onProgress(100);

  const code = await proc.exited;
  if (code !== 0 && !signal?.aborted) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(errText.trim() || `yt-dlp exited with code ${code}`);
  }

  return `${join(outputDir, safeTitle)}.mp3`;
}

function parseYtdlpProgress(line: string): number | null {
  const m = line.match(/\[download\]\s+([\d.]+)%/);
  if (!m) return null;
  return Math.min(100, parseFloat(m[1]));
}

// --------------------------------------------------------------------------
// Version & update/install
// --------------------------------------------------------------------------

export async function getYtdlpVersion(): Promise<string> {
  try {
    const v = await runAuto(['--version']);
    return v.trim();
  } catch {
    return 'not found';
  }
}

/**
 * Update yt-dlp or install it for the first time.
 *
 * Decision tree:
 *   Binary found  → run `yt-dlp -U` (self-update built into yt-dlp)
 *   Binary absent → download latest release from GitHub into managed bin dir
 */
export async function updateYtdlp(): Promise<{ success: boolean; version?: string; error?: string }> {
  try {
    const binPath = await resolvebin();

    if (!binPath) {
      // ── Fresh install from GitHub ─────────────────────────────────────────
      console.log('[ytdlp] Not found — downloading from GitHub …');
      await installYtdlp();
    } else {
      // ── Self-update existing binary ───────────────────────────────────────
      console.log(`[ytdlp] Found at ${binPath} — running self-update …`);
      try {
        await run(binPath, ['-U']);
      } catch (e) {
        // Some yt-dlp versions exit non-zero when already up to date
        const msg = String(e);
        if (!msg.includes('up to date') && !msg.includes('up-to-date')) throw e;
      }
    }

    const version = await getYtdlpVersion();
    return { success: true, version };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('[ytdlp] Update/install failed:', error);
    return { success: false, error };
  }
}
