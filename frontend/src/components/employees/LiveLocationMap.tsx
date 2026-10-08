import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin, RefreshCw, Signal, SignalZero } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useApp } from '../../context/AppContext';
import { ApiError } from '../../api/client';
import {
  locationsApi,
  type LiveLocationEmployee,
} from '../../api/locations';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

const POLL_MS = 7_000;
/** Employee-backend Redis TTL is 60s — beyond this, a fix is stale. */
const STALE_AFTER_SECONDS = 75;

const ageSeconds = (e: LiveLocationEmployee, nowSec: number): number | null =>
  typeof e.server_timestamp === 'number'
    ? Math.max(0, Math.round(nowSec - e.server_timestamp))
    : null;

const isStale = (e: LiveLocationEmployee, nowSec: number): boolean => {
  const age = ageSeconds(e, nowSec);
  return age !== null && age > STALE_AFTER_SECONDS;
};

export const formatAge = (e: LiveLocationEmployee, nowSec: number): string => {
  const age = ageSeconds(e, nowSec);
  if (age === null) return '—';
  if (age < 60) return `${age}s ago`;
  return `${Math.floor(age / 60)}m ${age % 60}s ago`;
};

// ---------------------------------------------------------------------------
// Marker registry — pure logic, decoupled from Leaflet for tests
// ---------------------------------------------------------------------------

export interface MarkerHandle {
  setPosition(latitude: number, longitude: number): void;
  setLabel(html: string): void;
  remove(): void;
}

/**
 * Diff the latest payload into the marker map keyed by employee UUID:
 * create markers for new live employees, move existing ones, drop anyone
 * who vanished or went offline. Markers are never needlessly recreated.
 */
export function syncLiveMarkers(
  markers: Map<string, MarkerHandle>,
  employees: LiveLocationEmployee[],
  label: (e: LiveLocationEmployee) => string,
  createMarker: (e: LiveLocationEmployee, label: string) => MarkerHandle
): void {
  const liveIds = new Set<string>();
  for (const e of employees) {
    if (!e.is_live) continue;
    liveIds.add(e.employee_id);
    const existing = markers.get(e.employee_id);
    if (existing) {
      existing.setPosition(e.latitude, e.longitude);
      existing.setLabel(label(e));
    } else {
      markers.set(e.employee_id, createMarker(e, label(e)));
    }
  }
  for (const [id, marker] of markers) {
    if (!liveIds.has(id)) {
      marker.remove();
      markers.delete(id);
    }
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );

const liveIcon = () =>
  L.divIcon({
    className: '',
    html: `<div style="
      width:14px;height:14px;border-radius:9999px;background:#2F6B45;
      border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

const DEFAULT_CENTER: [number, number] = [20.5937, 78.9629]; // India centroid
const DEFAULT_ZOOM = 5;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const LiveLocationMap: React.FC = () => {
  const { currentPropertyEmployees, currentPropertyZones } = useApp();
  const employeesRef = useRef(currentPropertyEmployees);
  employeesRef.current = currentPropertyEmployees;
  const zonesRef = useRef(currentPropertyZones);
  zonesRef.current = currentPropertyZones;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, MarkerHandle>>(new Map());
  const hadLiveRef = useRef(false);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveLocationEmployee[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const nameFor = useCallback(
    (employeeId: string) =>
      employeesRef.current.find((e) => e.employee_uid === employeeId)?.name ??
      'Unknown employee',
    []
  );
  const zoneFor = useCallback((employeeId: string) => {
    const emp = employeesRef.current.find(
      (e) => e.employee_uid === employeeId
    );
    return (
      zonesRef.current.find((z) => z.zone_uid === emp?.zone_uid)?.name ?? null
    );
  }, []);

  const tooltipFor = useCallback(
    (e: LiveLocationEmployee) => {
      const now = Math.floor(Date.now() / 1000);
      const zone = zoneFor(e.employee_id);
      return `<strong>${escapeHtml(nameFor(e.employee_id))}</strong>` +
        (zone ? `<br/>${escapeHtml(zone)}` : '') +
        `<br/>${formatAge(e, now)}${isStale(e, now) ? ' (stale)' : ''}`;
    },
    [nameFor, zoneFor]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = L.map(container, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    const markers = markersRef.current;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const createMarker = (e: LiveLocationEmployee, html: string) => {
      const marker = L.marker([e.latitude, e.longitude], {
        icon: liveIcon(),
      })
        .addTo(map)
        .bindTooltip(html, { direction: 'top', offset: [0, -12] });
      return {
        setPosition: (lat: number, lng: number) => marker.setLatLng([lat, lng]),
        setLabel: (h: string) => marker.setTooltipContent(h),
        remove: () => marker.remove(),
      };
    };

    const poll = async () => {
      try {
        const res = await locationsApi.liveLocations();
        if (cancelled) return;
        const list = res?.employees ?? [];
        setLive(list);
        setError(null);
        setStatus('ready');
        setLastSyncAt(Date.now());
        syncLiveMarkers(markers, list, tooltipFor, createMarker);
        const hasLive = list.some((e) => e.is_live);
        // Re-frame when the live set appears/empties — not on every tick.
        if (hasLive !== hadLiveRef.current) {
          hadLiveRef.current = hasLive;
          if (hasLive) {
            const points = list
              .filter((e) => e.is_live)
              .map((e) => [e.latitude, e.longitude] as [number, number]);
            map.fitBounds(L.latLngBounds(points), {
              padding: [48, 48],
              maxZoom: 15,
            });
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load live locations.'
        );
        setStatus((s) => (s === 'loading' ? 'error' : s));
      }
    };

    void poll();
    timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
      void poll();
    }, POLL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      map.remove();
      mapRef.current = null;
      hadLiveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveEmployees = live.filter((e) => e.is_live);

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#EDEAE2]">
        <div className="flex items-center gap-2">
          <Signal className="w-4 h-4 text-[#2F6B45]" />
          <h3 className="font-display font-semibold text-sm text-[#17221B]">
            Live Locations
          </h3>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] bg-[#E7F0E9] text-[#2F6B45]">
            {liveEmployees.length} live
          </span>
        </div>
        {lastSyncAt && (
          <span className="text-[10px] text-[#8A918C]">
            Updated {new Date(lastSyncAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="grid lg:grid-cols-[1fr_240px]">
        <div className="relative">
          <div ref={containerRef} className="h-[380px] w-full" />
          {status === 'loading' && (
            <div className="absolute inset-0 bg-[#FAF8F5]/80 flex items-center justify-center z-[500]">
              <RefreshCw className="w-5 h-5 animate-spin text-[#8A918C]" />
            </div>
          )}
          {status === 'error' && (
            <div className="absolute inset-0 bg-[#FAF8F5]/90 flex flex-col items-center justify-center gap-2 z-[500] px-6 text-center">
              <SignalZero className="w-6 h-6 text-[#B33A3A]" />
              <p className="text-xs text-[#66706A]">{error}</p>
            </div>
          )}
          {status === 'ready' && !error && liveEmployees.length === 0 && (
            <div className="absolute inset-x-0 bottom-3 flex justify-center z-[500] pointer-events-none">
              <div className="bg-white/95 border border-[#EDEAE2] rounded-[10px] px-4 py-2 text-xs text-[#66706A] flex items-center gap-2 shadow-sm">
                <MapPin className="w-3.5 h-3.5" />
                No staff are sharing their location right now.
              </div>
            </div>
          )}
          {error && status === 'ready' && (
            <div className="absolute top-3 inset-x-3 z-[500] bg-[#FFF3E4] border border-[#F0D9B5] rounded-[8px] px-3 py-2 text-[11px] text-[#8A5A1E]">
              {error} — showing the last known positions.
            </div>
          )}
        </div>

        <div className="border-t lg:border-t-0 lg:border-l border-[#EDEAE2] max-h-[380px] overflow-y-auto">
          {liveEmployees.length === 0 ? (
            <p className="px-4 py-6 text-xs text-[#8A918C] text-center">
              No live staff
            </p>
          ) : (
            liveEmployees.map((e) => (
              <div
                key={e.employee_id}
                className="px-4 py-2.5 border-b border-[#F4F1EA] last:border-0"
              >
                <p className="text-xs font-semibold text-[#17221B]">
                  {nameFor(e.employee_id)}
                </p>
                <p className="text-[10px] text-[#8A918C]">
                  {zoneFor(e.employee_id) ?? 'Unallocated'}
                  {' · '}
                  {formatAge(e, nowSec)}
                  {isStale(e, nowSec) && (
                    <span className="text-[#C98232] font-medium"> · stale</span>
                  )}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </Card>
  );
};
