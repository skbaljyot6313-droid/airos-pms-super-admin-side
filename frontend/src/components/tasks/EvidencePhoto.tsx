import React, { useEffect, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { apiFetch, BASE_URL, mediaUrl } from '../../api/client';

const pending = new Map<string, { promise: Promise<string>; users: number; url?: string }>();

export function evidencePath(src: string): string | null {
  try {
    const resolved = new URL(mediaUrl(src), window.location.origin);
    const origin = new URL(BASE_URL || window.location.origin).origin;
    if (resolved.origin !== origin) return null;
    const match = resolved.pathname.match(/^\/(?:api\/v\d+\/media\/file|uploads)\/([a-f0-9]{32}\.[a-z0-9]{2,5})$/);
    return match ? `/media/file/${match[1]}` : null;
  } catch {
    return null;
  }
}

export const EvidencePhoto: React.FC<{
  src: string;
  alt: string;
  className?: string;
  onError?: () => void;
}> = ({ src, alt, className = '', onError }) => {
  const [state, setState] = useState<{ source: string; url?: string; error?: boolean; loaded?: boolean }>({ source: src });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ source: src });
    if (!src) {
      setState({ source: src, error: true });
      return;
    }
    const path = evidencePath(src);
    if (!path) {
      setState({ source: src, url: mediaUrl(src) });
      return;
    }
    let entry = pending.get(path);
    if (!entry) {
      const resource = { users: 0, promise: Promise.resolve(''), url: undefined as string | undefined };
      resource.promise = apiFetch<Blob>(path, { responseType: 'blob' }).then((blob) => {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) throw new Error('Unsupported evidence image format');
        resource.url = URL.createObjectURL(blob);
        return resource.url;
      });
      entry = resource;
      pending.set(path, entry);
    }
    entry.users++;
    entry.promise.then(
      (url) => { if (active) setState({ source: src, url }); },
      () => { if (active) setState({ source: src, error: true }); },
    );
    return () => {
      active = false;
      const resource = entry;
      resource.users--;
      setTimeout(() => {
        if (resource.users !== 0) return;
        if (pending.get(path) === resource) pending.delete(path);
        void resource.promise.then((url) => URL.revokeObjectURL(url), () => {});
      }, 0);
    };
  }, [src, attempt]);

  const ready = state.source === src;
  const failed = ready && state.error;
  return (
    <span className={`relative flex items-center justify-center bg-black/5 overflow-hidden ${className}`}>
      {failed ? (
        <span role="alert" className="flex flex-col items-center justify-center gap-1 p-2 text-center text-xs">
          <ImageOff className="w-5 h-5" />
          <span>Image unavailable</span>
          <span role="button" tabIndex={0} className="underline cursor-pointer" onClick={(e) => {
            e.stopPropagation();
            const path = evidencePath(src);
            if (path) pending.delete(path);
            setAttempt((value) => value + 1);
          }} onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); e.currentTarget.click(); }
          }}>Retry image</span>
        </span>
      ) : ready && state.url ? (
        <><img src={state.url} alt={alt} style={{ opacity: state.loaded ? 1 : 0 }}
          onLoad={() => setState((previous) => ({ ...previous, loaded: true }))}
          onError={() => {
            const path = evidencePath(src);
            if (path) pending.delete(path);
            setState({ source: src, error: true });
            onError?.();
          }}
          className="w-full h-full object-contain transition-opacity" />
          {!state.loaded && <span role="status" aria-label="Loading evidence image" className="absolute inset-0 flex items-center justify-center animate-pulse bg-black/5"><Loader2 className="w-5 h-5 animate-spin" /></span>}</>
      ) : <span role="status" aria-label="Loading evidence image" className="animate-pulse"><Loader2 className="w-5 h-5 animate-spin" /></span>}
    </span>
  );
};
