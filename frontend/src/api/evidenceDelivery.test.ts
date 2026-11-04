import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, setAuthToken, setRefreshToken, setUnauthorizedHandler } from './client';

beforeEach(() => {
  const tokens = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => tokens.get(key) ?? null,
    setItem: (key: string, value: string) => tokens.set(key, value),
    removeItem: (key: string) => tokens.delete(key),
  });
});
afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('authenticated evidence requests', () => {
  it('sends the bearer token and avoids previously public browser cache entries', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([255, 216, 255]), { headers: { 'Content-Type': 'image/jpeg' } }));
    vi.stubGlobal('fetch', fetcher);
    setAuthToken('controlled-test-access');
    const image = await apiFetch<Blob>('/media/file/' + 'a'.repeat(32) + '.jpg', { responseType: 'blob' });
    expect(image.type).toBe('image/jpeg');
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer controlled-test-access' }, cache: 'no-store',
    });
  });

  it('refreshes an expired access token once before retrying image retrieval', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'controlled-new-access' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetcher);
    setAuthToken('controlled-expired-access');
    setRefreshToken('controlled-refresh');
    const image = await apiFetch<Blob>('/media/file/' + 'a'.repeat(32) + '.png', { responseType: 'blob' });
    expect(image.type).toBe('image/png');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2][1].headers.Authorization).toBe('Bearer controlled-new-access');
  });

  it('does not loop when refreshed credentials are rejected', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'controlled-new-access' })))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    setRefreshToken('controlled-refresh');
    await expect(apiFetch('/media/file/' + 'a'.repeat(32) + '.jpg', { responseType: 'blob' })).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
