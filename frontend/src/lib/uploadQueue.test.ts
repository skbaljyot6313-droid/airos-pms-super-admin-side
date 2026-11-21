import { describe, expect, it, vi } from 'vitest';

import { runUploads, UploadCancelled } from './uploadQueue';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runUploads', () => {
  it('runs every item and preserves result order', async () => {
    const items = [1, 2, 3, 4, 5];
    const res = await runUploads(items, async (n) => n * 10, { concurrency: 3 });
    expect(res.map((r) => r.value)).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit', async () => {
    let live = 0;
    let peak = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    await runUploads(
      items,
      async () => {
        live += 1;
        peak = Math.max(peak, live);
        await settle(10);
        live -= 1;
      },
      { concurrency: 3 }
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('retries transient failures with a bounded attempt count', async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValue('ok');
    const res = await runUploads([0], upload, { maxRetries: 2, backoffMs: 1 });
    expect(res[0].value).toBe('ok');
    expect(upload).toHaveBeenCalledTimes(2);
    expect(res[0].attempts).toBe(2);
  });

  it('marks an item failed after exhausting retries without losing siblings', async () => {
    const upload = vi.fn(async (i: number) => {
      if (i === 1) throw new Error('always-fails');
      return `ok-${i}`;
    });
    const res = await runUploads([0, 1, 2], upload, { maxRetries: 1, backoffMs: 1 });
    expect(res[0].value).toBe('ok-0');
    expect(res[1].error).toBeInstanceOf(Error);
    expect(res[1].attempts).toBe(2); // 1 try + 1 retry
    expect(res[2].value).toBe('ok-2');
    // failed item's sibling never re-uploads
    expect(upload).toHaveBeenCalledTimes(4); // 0,1,1,2
  });

  it('reports progress as items settle', async () => {
    const progress = vi.fn();
    await runUploads([1, 2], async (n) => n, {}, progress);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith(2, 2, expect.objectContaining({ value: 2 }));
  });

  it('cancels in-flight + pending work on abort', async () => {
    const ctl = new AbortController();
    const upload = vi.fn(async (_i: number, _idx: number, signal: AbortSignal) => {
      await new Promise((_r, rej) => {
        signal.addEventListener('abort', () => rej(new UploadCancelled()), { once: true });
      });
      return 'never';
    });
    const pending = runUploads([1, 2, 3], upload, { concurrency: 1, signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toBeInstanceOf(UploadCancelled);
  });
});
