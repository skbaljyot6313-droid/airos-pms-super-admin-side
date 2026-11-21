/**
 * Evidence photo pipeline hook.
 *
 * Each added file flows: compressing → uploading → ready | error.
 * Compression starts immediately on selection (async, non-blocking) and the
 * upload fires right after — by the time the user finishes the form the
 * network work is usually done, so "submit" is just the final API call.
 * Controlled concurrency keeps at most MAX_UPLOAD_CONCURRENCY requests live.
 */
import { useCallback, useMemo, useRef, useState } from 'react';

import { optimizeImage } from '../lib/imageOptimize';
import { runUploads } from '../lib/uploadQueue';
import { uploadPhoto } from '../api/media';

export const MAX_UPLOAD_CONCURRENCY = 3;

export type EvidenceStatus = 'compressing' | 'uploading' | 'ready' | 'error';

export interface EvidenceItem {
  id: string;
  file: File;
  previewUrl: string;
  status: EvidenceStatus;
  /** Set once uploaded — the URL the backend expects on submit. */
  url?: string;
  error?: string;
  originalBytes: number;
  resultBytes: number;
  attempts: number;
}

interface Options {
  propertyUid?: string;
  maxCount: number;
  allowedTypes: ReadonlySet<string>;
  maxBytes: number;
  onToast?: (t: { type: 'error' | 'info'; title: string; description?: string }) => void;
}

let _seq = 0;
const nextId = () => `ev-${Date.now()}-${++_seq}`;

export function useEvidenceUploads({ propertyUid, maxCount, allowedTypes, maxBytes, onToast }: Options) {
  const [items, setItems] = useState<EvidenceItem[]>([]);
  // serializes the optimize→upload steps across the pool — compression is
  // main-thread work so we intentionally pipeline one-at-a-time here while
  // the network stage itself runs through runUploads' concurrency pool.
  const queueRef = useRef(Promise.resolve());

  const patch = useCallback((id: string, p: Partial<EvidenceItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }, []);

  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      setItems((prev) => {
        const room = Math.max(maxCount - prev.length, 0);
        const accepted = files.slice(0, room);
        if (files.length > room) {
          onToast?.({
            type: 'error',
            title: 'Too many photos',
            description: `A submission can include at most ${maxCount} images.`,
          });
        }
        const fresh: EvidenceItem[] = [];
        for (const file of accepted) {
          if (!allowedTypes.has(file.type)) {
            onToast?.({ type: 'error', title: 'Photo rejected', description: `${file.name} must be a JPEG, PNG, WebP, or HEIC image.` });
            continue;
          }
          if (file.size > maxBytes) {
            onToast?.({ type: 'error', title: 'Photo rejected', description: `${file.name} exceeds the 10 MB limit.` });
            continue;
          }
          // dedupe — same name+size+modified already queued means the user
          // re-picked an identical file; don't compress/upload it twice.
          if (prev.some((it) => it.file.name === file.name && it.file.size === file.size && it.file.lastModified === file.lastModified)
              || fresh.some((it) => it.file.name === file.name && it.file.size === file.size && it.file.lastModified === file.lastModified)) {
            continue;
          }
          fresh.push({
            id: nextId(), file, previewUrl: URL.createObjectURL(file),
            status: 'compressing', originalBytes: file.size,
            resultBytes: file.size, attempts: 0,
          });
        }
        if (!fresh.length) return prev;

        // chain the pipeline — each item optimizes then uploads; items run
        // through in order but uploads inside overlap via the worker below.
        for (const item of fresh) {
          queueRef.current = queueRef.current.then(async () => {
            const opt = await optimizeImage(item.file);
            const outFile = opt.file;
            patch(item.id, { status: 'uploading', resultBytes: outFile.size, file: outFile });
            const results = await runUploads(
              [outFile],
              async (f, _i, signal) => uploadPhoto(f, propertyUid, signal),
              { concurrency: MAX_UPLOAD_CONCURRENCY, maxRetries: 2 }
            );
            const r = results[0];
            if (r.error) {
              patch(item.id, {
                status: 'error', attempts: r.attempts,
                error: r.error instanceof Error ? r.error.message : 'Upload failed',
              });
            } else {
              patch(item.id, { status: 'ready', url: r.value!.url, attempts: r.attempts });
            }
          });
        }
        return [...prev, ...fresh];
      });
    },
    [maxCount, allowedTypes, maxBytes, onToast, propertyUid, patch]
  );

  const retry = useCallback((id: string) => {
    patch(id, { status: 'uploading', error: undefined, attempts: 0 });
    queueRef.current = queueRef.current.then(async () => {
      setItems((prev) => {
        const it = prev.find((x) => x.id === id);
        if (!it) return prev;
        uploadPhoto(it.file, propertyUid)
          .then((res) => patch(id, { status: 'ready', url: res.url }))
          .catch((e) => patch(id, { status: 'error', error: e instanceof Error ? e.message : 'Upload failed' }));
        return prev;
      });
    });
  }, [patch, propertyUid]);

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const it = prev.find((x) => x.id === id);
      if (it) URL.revokeObjectURL(it.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  const reset = useCallback(() => {
    setItems((prev) => {
      prev.forEach((it) => URL.revokeObjectURL(it.previewUrl));
      return [];
    });
  }, []);

  const readyUrls = useMemo(() => items.filter((i) => i.status === 'ready' && i.url).map((i) => i.url as string), [items]);
  const busy = useMemo(() => items.some((i) => i.status === 'compressing' || i.status === 'uploading'), [items]);
  const hasError = useMemo(() => items.some((i) => i.status === 'error'), [items]);
  const progress = useMemo(
    () => ({ total: items.length, done: items.filter((i) => i.status === 'ready').length }),
    [items]
  );

  return { items, add, remove, retry, reset, readyUrls, busy, hasError, progress };
}
