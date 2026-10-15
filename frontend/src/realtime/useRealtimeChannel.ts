/**
 * useRealtimeChannel — subscribe to a private Centrifugo channel while
 * `enabled`; events flow to `onEvent`. No-ops when realtime is
 * unconfigured — reconciliation polls remain the correctness backstop,
 * so callers pair this with usePolling at a longer interval.
 */
import { useEffect, useRef } from 'react';
import { subscribeChannel } from './client';

export function useRealtimeChannel(
  channel: string | null,
  enabled: boolean,
  onEvent: (event: { type?: string; data?: unknown }) => void,
): void {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    if (!enabled || !channel) return;
    let disposed = false;
    let handle: { unsubscribe: () => void } | null = null;
    void subscribeChannel(channel, (ev) => cbRef.current(ev)).then((h) => {
      if (disposed) {
        h.unsubscribe();
      } else {
        handle = h;
      }
    });
    return () => {
      disposed = true;
      handle?.unsubscribe();
    };
  }, [channel, enabled]);
}

/** priv:prop:{uid}:{topic} — SA property-scoped channels. */
export function propChannel(propertyUid: string, topic: string): string {
  return `priv:prop:${propertyUid}:${topic}`;
}
