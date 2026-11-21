import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useNavDestinations } from './Sidebar';
import { cn } from '../../lib/utils';

/**
 * Ctrl/⌘+K command palette — client-side route search + property switching.
 * No backend search exists; this only navigates.
 */
export const CommandMenu: React.FC = () => {
  const { navigate, setActivePropertyUid } = useApp();
  const destinations = useNavDestinations();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return destinations;
    return destinations.filter((d) => d.label.toLowerCase().includes(q));
  }, [destinations, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof results>();
    for (const r of results) {
      const arr = map.get(r.group) ?? [];
      arr.push(r);
      map.set(r.group, arr);
    }
    return [...map.entries()];
  }, [results]);

  const flat = results;
  const pick = (index: number) => {
    const item = flat[index];
    if (!item) return;
    if (item.label.startsWith('Switch to ')) {
      const uid = item.path.split('/')[2];
      setActivePropertyUid(uid);
    }
    navigate(item.path);
    setOpen(false);
  };

  if (!open) return null;

  let idx = -1;
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]">
      <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="h-4 w-4 shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, flat.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                pick(cursor);
              }
            }}
            placeholder="Go to page, or switch property…"
            className="h-11 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
            ESC
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1.5">
          {flat.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-ink-3">No matching destination.</p>
          )}
          {grouped.map(([group, items]) => (
            <div key={group}>
              <p className="px-4 pb-1 pt-2.5 text-micro font-semibold uppercase tracking-[0.08em] text-ink-3">
                {group}
              </p>
              {items.map((item) => {
                idx += 1;
                const i = idx;
                return (
                  <button
                    key={item.path + item.label}
                    onClick={() => pick(i)}
                    onMouseEnter={() => setCursor(i)}
                    className={cn(
                      'block w-full px-4 py-2 text-left text-[13px]',
                      i === cursor ? 'bg-brand-soft text-brand-ink' : 'text-ink-2'
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
