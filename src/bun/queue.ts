/**
 * Download queue manager.
 */

import { randomUUID } from 'crypto';
import type { QueueItem, QueueStatus } from '../shared/types';
import { downloadToUsb } from './ytdlp';
import { addToBackup } from './backup';

type QueueListener    = (items: QueueItem[]) => void;
type ProgressListener = (id: string, progress: number, status: QueueStatus, error?: string) => void;

let onQueueChange: QueueListener    = () => {};
let onProgress:    ProgressListener = () => {};

export function setQueueListeners(q: QueueListener, p: ProgressListener): void {
  onQueueChange = q;
  onProgress    = p;
}

const queue: QueueItem[] = [];
let isProcessing = false;

function notify(): void { onQueueChange([...queue]); }

function updateItem(id: string, patch: Partial<QueueItem>): void {
  const item = queue.find(i => i.id === id);
  if (!item) return;
  Object.assign(item, patch);
  notify();
}

export function getQueue(): QueueItem[] { return [...queue]; }

export function addToQueue(params: { url: string; title: string; thumbnail?: string }): string {
  const id = randomUUID();
  queue.push({ id, youtubeUrl: params.url, title: params.title, thumbnail: params.thumbnail, status: 'pending', progress: 0 });
  notify();
  return id;
}

export function cancelQueueItem(id: string): void {
  const item = queue.find(i => i.id === id);
  if (!item) return;
  if (item.status === 'pending') { item.status = 'cancelled'; notify(); }
  else if (item.status === 'downloading') {
    (item as QueueItem & { _abort?: AbortController })._abort?.abort();
    item.status = 'cancelled';
    notify();
  }
}

// Fix #2: remove a finished/cancelled/error item from the queue
export function removeQueueItem(id: string): void {
  const idx = queue.findIndex(i => i.id === id);
  if (idx === -1) return;
  const item = queue[idx];
  // Only allow removal of terminal states
  if (['cancelled', 'error', 'complete'].includes(item.status)) {
    queue.splice(idx, 1);
    notify();
  }
}

export function processQueue(usbPath: string): void {
  if (isProcessing) return;
  _runQueue(usbPath);
}

async function _runQueue(usbPath: string): Promise<void> {
  isProcessing = true;
  try {
    while (true) {
      const next = queue.find(i => i.status === 'pending');
      if (!next) break;

      const controller = new AbortController();
      (next as QueueItem & { _abort?: AbortController })._abort = controller;
      updateItem(next.id, { status: 'downloading', progress: 0 });
      onProgress(next.id, 0, 'downloading');

      try {
        await downloadToUsb({
          youtubeUrl: next.youtubeUrl, outputDir: usbPath, title: next.title,
          signal: controller.signal,
          onProgress: (pct) => { updateItem(next.id, { progress: pct }); onProgress(next.id, pct, 'downloading'); },
        });

        if (!controller.signal.aborted) {
          addToBackup({ title: next.title, youtubeUrl: next.youtubeUrl, filename: next.title + '.mp3' });
          // Mark complete then remove
          updateItem(next.id, { status: 'complete', progress: 100 });
          onProgress(next.id, 100, 'complete');
          // Auto-remove completed items after a short grace period so the
          // user can see the "complete" flash, then the item disappears.
          setTimeout(() => {
            const idx = queue.findIndex(i => i.id === next.id);
            if (idx !== -1 && queue[idx].status === 'complete') { queue.splice(idx, 1); notify(); }
          }, 3000);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          updateItem(next.id, { status: 'error', error: message });
          onProgress(next.id, 0, 'error', message);
        }
      }
    }
  } finally {
    isProcessing = false;
  }
}
