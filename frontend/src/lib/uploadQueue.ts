/**
 * Bounded-concurrency upload runner with retry + cancellation.
 *
 * Each item flows through one upload fn; a fixed-size pool keeps at most
 * `concurrency` requests in flight. Failures retry with exponential
 * backoff (per-item attempt budget) — a sibling item failing never
 * re-uploads items that already succeeded.
 */

export interface UploadTaskOptions {
  /** Max simultaneous uploads — 3 balances speed vs. saturating the API. */
  concurrency?: number;
  /** Retries per item after the first attempt (default 2 → 3 attempts). */
  maxRetries?: number;
  /** Backoff base ms — attempt n sleeps base * 2^(n-1) + jitter. */
  backoffMs?: number;
  /** External cancellation — aborts all in-flight + pending items. */
  signal?: AbortSignal;
}

export interface UploadResult<T> {
  index: number;
  value?: T;
  error?: unknown;
  /** 1-based attempt count this item needed. */
  attempts: number;
}

export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelled';
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadCancelled());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new UploadCancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Run `upload` over `items` with bounded concurrency. Resolves when every
 * item settles — check each result's `error`; this never throws for item
 * failures (only for cancellation, when `failFast` items still settle).
 */
export async function runUploads<I, T>(
  items: I[],
  upload: (item: I, index: number, signal: AbortSignal) => Promise<T>,
  options: UploadTaskOptions = {},
  onProgress?: (done: number, total: number, result: UploadResult<T>) => void
): Promise<UploadResult<T>[]> {
  const { concurrency = 3, maxRetries = 2, backoffMs = 300, signal } = options;
  const results: UploadResult<T>[] = new Array(items.length);
  let next = 0;
  let done = 0;

  const attempt = async (index: number): Promise<void> => {
    let tries = 0;
    const ctl = new AbortController();
    const onExternalAbort = () => ctl.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      for (;;) {
        tries += 1;
        try {
          if (signal?.aborted) throw new UploadCancelled();
          results[index] = {
            index,
            value: await upload(items[index], index, ctl.signal),
            attempts: tries,
          };
          return;
        } catch (err) {
          if (err instanceof UploadCancelled || signal?.aborted || ctl.signal.aborted) {
            throw new UploadCancelled();
          }
          if (tries > maxRetries) {
            results[index] = { index, error: err, attempts: tries };
            return;
          }
          await sleep(backoffMs * 2 ** (tries - 1) + Math.random() * backoffMs, signal);
        }
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      done += 1;
      onProgress?.(done, items.length, results[index]);
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        if (signal?.aborted) return;
        const index = next++;
        await attempt(index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
