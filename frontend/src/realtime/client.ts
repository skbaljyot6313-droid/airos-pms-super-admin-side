/**
 * Centrifugo realtime client — one shared connection per SPA session.
 *
 * Tokens come from OUR backend, never embedded: GET /realtime/token
 * mints a short-lived connection JWT; POST /realtime/subscribe mints a
 * per-channel JWT after server-side scope checks (all channels live in
 * the private `priv` namespace).
 *
 * Everything degrades silently: when the backend reports realtime as
 * unconfigured (503) or Centrifugo is unreachable, subscribers simply
 * receive no events and the existing reconciliation polls keep the UI
 * correct — realtime is an accelerator, not the source of truth.
 */
import { Centrifuge, type Subscription } from 'centrifuge';
import { apiFetch, ApiError } from '../api/client';
import { perfLog } from '../dev/perf';

interface TokenResponse {
  token: string;
  expires_at: number;
  ws_url: string;
}

interface SubscribeResponse {
  tokens: Record<string, string>;
  expires_at: number;
}

let centrifuge: Centrifuge | null = null;
let connectPromise: Promise<Centrifuge | null> | null = null;
let unavailable = false; // backend says realtime isn't configured

async function fetchToken(): Promise<TokenResponse> {
  return apiFetch<TokenResponse>('/realtime/token');
}

async function ensureClient(): Promise<Centrifuge | null> {
  if (unavailable) return null;
  if (centrifuge) return centrifuge;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const { token, ws_url } = await fetchToken();
      centrifuge = new Centrifuge(ws_url, {
        token,
        // Token is short-lived — the client asks us for a fresh one at
        // expiry; we simply mint another via the same endpoint.
        getToken: async () => (await fetchToken()).token,
      });
      centrifuge.on('disconnected', () => {
        perfLog('[RT] disconnected — reconciliation polls cover the gap');
      });
      centrifuge.connect();
      return centrifuge;
    } catch (err) {
      // 503 = REALTIME_UNAVAILABLE → never retry this session; other
      // failures retry on the next subscribe attempt.
      if (err instanceof ApiError && err.status === 503) {
        unavailable = true;
        perfLog('[RT] realtime unavailable on server — polling only');
      }
      return null;
    } finally {
      connectPromise = null;
    }
  })();
  return connectPromise;
}

export interface ChannelHandle {
  unsubscribe: () => void;
}

/**
 * Subscribe to a private channel. Returns null-ish handle when realtime
 * is unavailable — callers just get no events. `onEvent` receives the
 * event envelope `{v, id, type, ts, data}`.
 */
export async function subscribeChannel(
  channel: string,
  onEvent: (event: { type?: string; data?: unknown }) => void,
): Promise<ChannelHandle> {
  const client = await ensureClient();
  if (!client) return { unsubscribe: () => {} };

  const fetchSubToken = async () => {
    const res = await apiFetch<SubscribeResponse>('/realtime/subscribe', {
      method: 'POST',
      body: { channels: [channel] },
    });
    return res.tokens[channel];
  };
  let initialToken: string | undefined;
  try {
    initialToken = await fetchSubToken();
  } catch (err) {
    perfLog(`[RT] subscribe token denied for ${channel}`);
    if (err instanceof ApiError && (err.status === 403 || err.status === 503)) {
      return { unsubscribe: () => {} };
    }
  }
  const sub: Subscription = client.newSubscription(channel, {
    token: initialToken,
    getToken: fetchSubToken,
  });
  sub.on('publication', (ctx) => onEvent(ctx.data ?? {}));
  sub.on('error', (ctx) => {
    perfLog(`[RT] subscription error ${channel}: ${ctx.error?.message}`);
  });
  sub.subscribe();
  return {
    unsubscribe: () => {
      try {
        sub.unsubscribe();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Full teardown on logout — tokens/scopes belong to the session. */
export function disconnectRealtime(): void {
  const c = centrifuge;
  centrifuge = null;
  unavailable = false;
  if (c) {
    try {
      c.disconnect();
    } catch {
      /* noop */
    }
  }
}
