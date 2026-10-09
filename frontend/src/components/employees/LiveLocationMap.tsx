import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Crosshair,
  History,
  MapPin,
  RefreshCw,
  Signal,
  SignalZero,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { useApp } from '../../context/AppContext';
import { ApiError } from '../../api/client';
import {
  locationsApi,
  type LiveLocationEmployee,
  type LocationHistoryPoint,
  type LocationHistoryResponse,
  type WorkStatus,
} from '../../api/locations';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { isEmployeeDeactivated } from '../../lib/employeeUtils';

const POLL_MS = 10_000; // matches the ~10s device fix cadence
const HISTORY_MAX_MS = 31 * 24 * 3600 * 1000; // upstream limit

// ---------------------------------------------------------------------------
// Shared helpers — pure logic, decoupled from Leaflet for tests
// ---------------------------------------------------------------------------

const ageSeconds = (e: LiveLocationEmployee, nowSec: number): number | null => {
  if (typeof e.server_timestamp === 'number') {
    return Math.max(0, Math.round(nowSec - e.server_timestamp));
  }
  if (e.received_at) {
    const t = Date.parse(e.received_at) / 1000;
    if (!Number.isNaN(t)) return Math.max(0, Math.round(nowSec - t));
  }
  return null;
};

/** Authoritative staleness comes from the API — is_stale / is_live. */
export const isEntryStale = (e: LiveLocationEmployee): boolean =>
  e.is_stale || !e.is_live;

/** [lat, lng] of every live entry with usable coordinates. */
const livePoints = (
  list: LiveLocationEmployee[]
): [number, number][] =>
  list
    .filter(
      (e) => !isEntryStale(e) && e.latitude != null && e.longitude != null
    )
    .map((e) => [e.latitude!, e.longitude!] as [number, number]);

export const formatAge = (
  e: LiveLocationEmployee,
  nowSec: number
): string => {
  const age = ageSeconds(e, nowSec);
  if (age === null) return '—';
  if (age < 60) return `${age}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ${age % 60}s ago`;
  return `${Math.floor(age / 3600)}h ${Math.floor((age % 3600) / 60)}m ago`;
};

export interface MarkerHandle {
  setPosition(latitude: number, longitude: number): void;
  setLabel(html: string): void;
  remove(): void;
}

/**
 * Diff the latest payload into the marker map keyed by employee UUID:
 * create markers for new live employees, move existing ones, drop anyone
 * who vanished or went offline. Entries without coordinates (stale
 * lookups) never produce a marker. Markers are never needlessly recreated.
 */
export function syncLiveMarkers(
  markers: Map<string, MarkerHandle>,
  employees: LiveLocationEmployee[],
  label: (e: LiveLocationEmployee) => string,
  createMarker: (e: LiveLocationEmployee, label: string) => MarkerHandle
): void {
  const liveIds = new Set<string>();
  for (const e of employees) {
    if (isEntryStale(e) || e.latitude == null || e.longitude == null) continue;
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

const QUALITY_META: Record<string, { label: string; hint: string; cls: string }> = {
  valid: {
    label: 'Valid',
    hint: 'Within accuracy, freshness, and movement bounds.',
    cls: 'bg-[#E7F0E9] text-[#2F6B45]',
  },
  low_accuracy: {
    label: 'Low accuracy',
    hint: 'GPS accuracy worse than 500 m.',
    cls: 'bg-[#FFF3E4] text-[#8A5A1E]',
  },
  delayed: {
    label: 'Delayed',
    hint: 'Uploaded more than 24 h after capture (offline replay).',
    cls: 'bg-[#F1EEE7] text-[#66706A]',
  },
  suspicious_speed: {
    label: 'GPS jump',
    hint: 'Implied movement over 80 m/s — usually a GPS glitch, not proof of spoofing.',
    cls: 'bg-[#FDE8E8] text-[#A82828]',
  },
};

export const QualityBadge: React.FC<{ quality?: string }> = ({ quality }) => {
  const meta = (quality && QUALITY_META[quality]) || {
    label: quality || 'Unknown',
    hint: '',
    cls: 'bg-[#F1EEE7] text-[#66706A]',
  };
  return (
    <span
      title={meta.hint}
      className={`inline-flex items-center px-1.5 py-0.5 rounded-[5px] text-[10px] font-semibold ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
};

const WORK_STATUS_META: Record<string, { label: string; cls: string }> = {
  working: { label: 'Working', cls: 'bg-[#E7F0E9] text-[#2F6B45]' },
  on_break: { label: 'On break', cls: 'bg-[#FFF3E4] text-[#8A5A1E]' },
  off_duty: { label: 'Off duty', cls: 'bg-[#F1EEE7] text-[#66706A]' },
  unknown: { label: 'Unknown', cls: 'bg-[#F1EEE7] text-[#8A918C]' },
};

/** Attendance-derived duty state — never inferred from GPS activity. */
export const WorkStatusBadge: React.FC<{ status?: WorkStatus }> = ({
  status,
}) => {
  const meta = WORK_STATUS_META[status?.state ?? ''] ??
    WORK_STATUS_META.unknown;
  return (
    <span
      title={
        status?.since
          ? `Since ${new Date(status.since).toLocaleString()}`
          : undefined
      }
      className={`inline-flex items-center px-1.5 py-0.5 rounded-[5px] text-[10px] font-semibold ${meta.cls}`}
    >
      {status?.label || meta.label}
    </span>
  );
};

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
// Street-level zoom for tight clusters / a lone fix — below the tile
// provider's 19 max so GPS precision isn't overstated.
const CLOSE_ZOOM = 17;
const FIT_PADDING: [number, number] = [48, 48];

/** datetime-local input value for a Date (local wall time). */
const toLocalInput = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
};

const fmtDateTime = (iso?: string): string =>
  iso ? new Date(iso).toLocaleString() : '—';

const fmtCoord = (v: number | null | undefined): string =>
  typeof v === 'number' ? v.toFixed(6) : '—';

interface RouteApi {
  draw(points: LocationHistoryPoint[]): void;
  clear(): void;
  focus(p: LocationHistoryPoint): void;
}

interface ViewApi {
  /** Re-fit the viewport to the current live set (clears manual control). */
  recenter(): void;
  /** Center on one employee's fix — counts as admin-directed navigation. */
  focus(latitude: number, longitude: number): void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const LiveLocationMap: React.FC = () => {
  const { currentPropertyEmployees, currentPropertyZones, activeProperty } =
    useApp();
  const employeesRef = useRef(currentPropertyEmployees);
  employeesRef.current = currentPropertyEmployees;
  const zonesRef = useRef(currentPropertyZones);
  zonesRef.current = currentPropertyZones;

  const [employeeFilter, setEmployeeFilter] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const filtersRef = useRef({ employeeId: '', zoneId: '', propertyId: '' });
  filtersRef.current = {
    employeeId: employeeFilter,
    zoneId: zoneFilter,
    propertyId: activeProperty?.property_uid ?? '',
  };

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, MarkerHandle>>(new Map());
  const routeApiRef = useRef<RouteApi | null>(null);
  const viewApiRef = useRef<ViewApi | null>(null);
  // Employee UUIDs currently shown as markers — membership changes trigger
  // an auto-refit while a manual pan/zoom suppresses it until recenter.
  const liveIdsRef = useRef<Set<string>>(new Set());
  const manualViewRef = useRef(false);
  const pollRef = useRef<() => Promise<void>>(async () => {});

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveLocationEmployee[]>([]);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const [selected, setSelected] = useState<string | null>(null);
  const [detailOverride, setDetailOverride] =
    useState<LiveLocationEmployee | null>(null);

  const [history, setHistory] = useState<LocationHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [histFrom, setHistFrom] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return toLocalInput(d);
  });
  const [histTo, setHistTo] = useState(() => toLocalInput(new Date()));

  // -- metadata joins --------------------------------------------------------

  const employeeFor = useCallback(
    (employeeId: string) =>
      employeesRef.current.find((e) => e.employee_uid === employeeId),
    []
  );
  const nameFor = useCallback(
    (employeeId: string) => employeeFor(employeeId)?.name ?? 'Unknown employee',
    [employeeFor]
  );
  const zoneFor = useCallback(
    (employeeId: string) => {
      const emp = employeeFor(employeeId);
      return (
        zonesRef.current.find((z) => z.zone_uid === emp?.zone_uid)?.name ?? null
      );
    },
    [employeeFor]
  );

  const tooltipFor = useCallback(
    (e: LiveLocationEmployee) => {
      const now = Math.floor(Date.now() / 1000);
      const zone = zoneFor(e.employee_id);
      return (
        `<strong>${escapeHtml(nameFor(e.employee_id))}</strong>` +
        (zone ? `<br/>${escapeHtml(zone)}` : '') +
        `<br/>${formatAge(e, now)}`
      );
    },
    [nameFor, zoneFor]
  );

  // -- map lifecycle + polling -----------------------------------------------

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
    const routeLayer = L.layerGroup().addTo(map);

    // Co-located staff collapse into a numbered cluster; at max zoom the
    // group spiderfies so every marker stays individually inspectable.
    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: true,
      maxClusterRadius: 42,
    });
    map.addLayer(cluster);

    // Once the admin pans or zooms, the viewport is theirs — our own
    // fit/setView calls are wrapped in `programmatic` so they don't trip
    // the manual flag. Recenter hands control back to auto-fit.
    let programmatic = false;
    const runProgrammatic = (fn: () => void) => {
      programmatic = true;
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          programmatic = false;
        }
      };
      map.once('moveend', finish);
      setTimeout(finish, 600); // fallback if moveend never fires
      fn();
    };
    map.on('dragstart zoomstart', () => {
      if (!programmatic) manualViewRef.current = true;
    });

    const fitToLive = (list: LiveLocationEmployee[]) => {
      const pts = livePoints(list);
      if (!pts.length) return;
      runProgrammatic(() => {
        if (pts.length === 1) {
          map.setView(
            pts[0],
            Math.min(Math.max(map.getZoom(), CLOSE_ZOOM), 19)
          );
        } else {
          map.fitBounds(L.latLngBounds(pts), {
            padding: FIT_PADDING,
            maxZoom: CLOSE_ZOOM,
          });
        }
      });
    };

    viewApiRef.current = {
      recenter() {
        manualViewRef.current = false;
        if (livePoints(liveRef.current).length) {
          fitToLive(liveRef.current);
        } else {
          runProgrammatic(() => map.setView(DEFAULT_CENTER, DEFAULT_ZOOM));
        }
      },
      focus(latitude, longitude) {
        manualViewRef.current = true;
        runProgrammatic(() =>
          map.setView(
            [latitude, longitude],
            Math.min(Math.max(map.getZoom(), CLOSE_ZOOM), 19)
          )
        );
      },
    };

    routeApiRef.current = {
      draw(points) {
        routeLayer.clearLayers();
        const latlngs = points.map(
          (p) => [p.latitude, p.longitude] as [number, number]
        );
        if (!latlngs.length) return;
        L.polyline(latlngs, {
          color: '#2F6B45',
          weight: 3,
          opacity: 0.75,
        }).addTo(routeLayer);
        L.circleMarker(latlngs[0], {
          radius: 6,
          color: '#fff',
          weight: 2,
          fillColor: '#2F6B45',
          fillOpacity: 1,
        }).addTo(routeLayer);
        const last = latlngs[latlngs.length - 1];
        L.circleMarker(last, {
          radius: 6,
          color: '#fff',
          weight: 2,
          fillColor: '#B33A3A',
          fillOpacity: 1,
        }).addTo(routeLayer);
        map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
      },
      clear() {
        routeLayer.clearLayers();
      },
      focus(p) {
        map.setView([p.latitude, p.longitude], Math.max(map.getZoom(), 16));
        const when = p.captured_at
          ? new Date(p.captured_at).toLocaleString()
          : '';
        L.popup({ closeButton: true })
          .setLatLng([p.latitude, p.longitude])
          .setContent(
            `<div style="font-size:11px">${escapeHtml(when)}` +
              (p.quality ? `<br/>${escapeHtml(p.quality)}` : '') +
              `</div>`
          )
          .openOn(map);
      },
    };

    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const createMarker = (e: LiveLocationEmployee, html: string) => {
      const marker = L.marker([e.latitude!, e.longitude!], {
        icon: liveIcon(),
      }).bindTooltip(html, { direction: 'top', offset: [0, -12] });
      cluster.addLayer(marker);
      marker.on('click', () => setSelected(e.employee_id));
      return {
        setPosition: (lat: number, lng: number) => marker.setLatLng([lat, lng]),
        setLabel: (h: string) => marker.setTooltipContent(h),
        remove: () => cluster.removeLayer(marker),
      };
    };

    const poll = async () => {
      if (inFlight) return; // never overlap polls
      inFlight = true;
      try {
        const f = filtersRef.current;
        const res = await locationsApi.liveLocations({
          property_id: f.propertyId || undefined,
          employee_id: f.employeeId || undefined,
          zone_id: f.zoneId || undefined,
          // is_active=false (stale lookup) requires an employee_id upstream
          is_active: f.employeeId ? false : undefined,
        });
        if (cancelled) return;
        const list = res?.locations ?? [];
        setLive(list);
        setError(null);
        setStatus('ready');
        setLastSyncAt(Date.now());
        syncLiveMarkers(markers, list, tooltipFor, createMarker);
        // Auto-refit when the live set's membership changes or a fix
        // drifts out of view — but never yank the map away from an admin
        // who is manually panning/zooming (Recenter restores auto-fit).
        const pts = livePoints(list);
        const ids = new Set(
          list
            .filter(
              (e) =>
                !isEntryStale(e) &&
                e.latitude != null &&
                e.longitude != null
            )
            .map((e) => e.employee_id)
        );
        const prev = liveIdsRef.current;
        const membershipChanged =
          ids.size !== prev.size || [...ids].some((id) => !prev.has(id));
        liveIdsRef.current = ids;
        const bounds = map.getBounds?.();
        const outOfView =
          !membershipChanged &&
          pts.some((p) => !bounds?.contains(p));
        if (
          !manualViewRef.current &&
          (membershipChanged || outOfView)
        ) {
          fitToLive(list);
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load live locations.'
        );
        setStatus((s) => (s === 'loading' ? 'error' : s));
      } finally {
        inFlight = false;
      }
    };
    pollRef.current = poll;

    void poll();
    timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
      void poll();
    }, POLL_MS);

    return () => {
      cancelled = true;
      pollRef.current = async () => {};
      if (timer) clearInterval(timer);
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      routeLayer.clearLayers();
      routeApiRef.current = null;
      viewApiRef.current = null;
      map.removeLayer(cluster);
      map.remove();
      mapRef.current = null;
      liveIdsRef.current = new Set();
      manualViewRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-poll immediately when filters change (interval closure reads the ref).
  const firstFilterRender = useRef(true);
  useEffect(() => {
    if (firstFilterRender.current) {
      firstFilterRender.current = false;
      return;
    }
    void pollRef.current();
  }, [employeeFilter, zoneFilter]);

  // Selection → clear route, fetch a stale-capable single lookup when the
  // employee isn't in the current live payload (offline / filtered out).
  useEffect(() => {
    routeApiRef.current?.clear();
    setHistory(null);
    setHistoryError(null);
    setDetailOverride(null);
    if (!selected) return;
    const entry = liveRef.current.find((e) => e.employee_id === selected);
    if (entry) {
      if (
        !isEntryStale(entry) &&
        entry.latitude != null &&
        entry.longitude != null
      ) {
        viewApiRef.current?.focus(entry.latitude, entry.longitude);
      }
      return;
    }
    let dead = false;
    locationsApi
      .liveLocation(selected)
      .then((r) => {
        if (!dead) setDetailOverride(r.location);
      })
      .catch(() => {
        if (!dead) setDetailOverride(null);
      });
    return () => {
      dead = true;
    };
  }, [selected]);

  // -- history ---------------------------------------------------------------

  const loadHistory = async () => {
    if (!selected) return;
    setHistoryError(null);
    const fromD = histFrom ? new Date(histFrom) : null;
    const toD = histTo ? new Date(histTo) : null;
    if (!fromD || !toD || Number.isNaN(+fromD) || Number.isNaN(+toD)) {
      setHistoryError('Select a start and end time.');
      return;
    }
    if (toD <= fromD) {
      setHistoryError('End time must be after the start time.');
      return;
    }
    if (toD.getTime() - fromD.getTime() > HISTORY_MAX_MS) {
      setHistoryError('The range cannot exceed 31 days.');
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await locationsApi.locationHistory(selected, {
        from: fromD.toISOString(),
        to: toD.toISOString(),
        max_points: 10_000,
      });
      setHistory(res);
      routeApiRef.current?.draw(res.points);
    } catch (err) {
      setHistory(null);
      routeApiRef.current?.clear();
      setHistoryError(
        err instanceof ApiError
          ? err.message
          : 'Could not load route history.'
      );
    } finally {
      setHistoryLoading(false);
    }
  };

  // -- render ----------------------------------------------------------------

  const liveEmployees = live.filter((e) => !isEntryStale(e));
  const selectedEntry =
    live.find((e) => e.employee_id === selected) ?? detailOverride;
  const selectedMeta = selected ? employeeFor(selected) : undefined;

  const selectCls =
    'text-xs bg-white border border-[#EDEAE2] rounded-[8px] px-2 py-1.5 text-[#17221B] focus:outline-none focus:ring-1 focus:ring-[#2F6B45] max-w-[170px]';

  const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({
    label,
    children,
  }) => (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-[10px] uppercase tracking-wider text-[#8A918C] font-medium">
        {label}
      </span>
      <span className="text-xs text-[#17221B] text-right break-all">
        {children}
      </span>
    </div>
  );

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[#EDEAE2]">
        <div className="flex items-center gap-2">
          <Signal className="w-4 h-4 text-[#2F6B45]" />
          <h3 className="font-display font-semibold text-sm text-[#17221B]">
            Live Locations
          </h3>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] bg-[#E7F0E9] text-[#2F6B45]">
            {liveEmployees.length} live
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            aria-label="Filter by employee"
            className={selectCls}
            value={employeeFilter}
            onChange={(e) => setEmployeeFilter(e.target.value)}
          >
            <option value="">All staff</option>
            {currentPropertyEmployees
              .filter((e) => !isEmployeeDeactivated(e))
              .map((e) => (
                <option key={e.employee_uid} value={e.employee_uid}>
                  {e.name}
                </option>
              ))}
          </select>
          <select
            aria-label="Filter by zone"
            className={selectCls}
            value={zoneFilter}
            onChange={(e) => setZoneFilter(e.target.value)}
          >
            <option value="">All zones</option>
            {currentPropertyZones.map((z) => (
              <option key={z.zone_uid} value={z.zone_uid}>
                {z.name}
              </option>
            ))}
          </select>
          {lastSyncAt && (
            <span className="text-[10px] text-[#8A918C]">
              Updated {new Date(lastSyncAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px]">
        <div className="relative">
          <div ref={containerRef} className="h-[440px] w-full" />
          <button
            type="button"
            onClick={() => viewApiRef.current?.recenter()}
            aria-label="Re-center on staff"
            title="Re-center on staff"
            className="absolute bottom-3 right-3 z-[500] inline-flex items-center gap-1.5 bg-white/95 border border-[#EDEAE2] rounded-[8px] px-2.5 py-1.5 text-[11px] font-medium text-[#17221B] shadow-sm hover:bg-white cursor-pointer"
          >
            <Crosshair className="w-3.5 h-3.5 text-[#2F6B45]" />
            Recenter
          </button>
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
                No clocked-in staff are sharing their location right now.
              </div>
            </div>
          )}
          {error && status === 'ready' && (
            <div className="absolute top-3 inset-x-3 z-[500] bg-[#FFF3E4] border border-[#F0D9B5] rounded-[8px] px-3 py-2 text-[11px] text-[#8A5A1E]">
              {error} — showing the last known positions.
            </div>
          )}
        </div>

        <div className="border-t lg:border-t-0 lg:border-l border-[#EDEAE2] max-h-[440px] overflow-y-auto">
          {!selected ? (
            live.length === 0 ? (
              <p className="px-4 py-6 text-xs text-[#8A918C] text-center">
                No live staff
              </p>
            ) : (
              live.map((e) => (
                <button
                  key={e.employee_id}
                  onClick={() => setSelected(e.employee_id)}
                  className="w-full text-left px-4 py-2.5 border-b border-[#F4F1EA] last:border-0 hover:bg-[#FAF8F5] transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-[#17221B]">
                      {nameFor(e.employee_id)}
                    </p>
                    <div className="flex items-center gap-1">
                      <WorkStatusBadge status={e.work_status} />
                      {e.quality && e.quality !== 'valid' && (
                        <QualityBadge quality={e.quality} />
                      )}
                    </div>
                  </div>
                  <p className="text-[10px] text-[#8A918C]">
                    {zoneFor(e.employee_id) ?? 'Unallocated'}
                    {' · '}
                    {isEntryStale(e) ? (
                      <span className="text-[#C98232] font-medium">
                        offline — last seen {formatAge(e, nowSec)}
                      </span>
                    ) : (
                      formatAge(e, nowSec)
                    )}
                  </p>
                </button>
              ))
            )
          ) : (
            <div className="flex flex-col">
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#EDEAE2] sticky top-0 bg-white z-10">
                <button
                  onClick={() => setSelected(null)}
                  className="p-1 rounded-[6px] hover:bg-[#F1EEE7] text-[#66706A] cursor-pointer"
                  aria-label="Back to staff list"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                </button>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[#17221B] truncate">
                    {nameFor(selected)}
                  </p>
                  <p className="text-[10px] text-[#8A918C] truncate">
                    {selectedMeta?.job_title || 'Staff'}
                    {zoneFor(selected) ? ` · ${zoneFor(selected)}` : ''}
                  </p>
                </div>
              </div>

              <div className="px-4 py-3 border-b border-[#F4F1EA] space-y-0.5">
                <div className="flex items-center gap-2 pb-1">
                  {selectedEntry ? (
                    isEntryStale(selectedEntry) ? (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] bg-[#F1EEE7] text-[#66706A]">
                        Not reporting
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] bg-[#E7F0E9] text-[#2F6B45]">
                        Live
                      </span>
                    )
                  ) : (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] bg-[#F1EEE7] text-[#66706A]">
                      No data
                    </span>
                  )}
                  {selectedEntry?.quality && (
                    <QualityBadge quality={selectedEntry.quality} />
                  )}
                </div>
                <DetailRow label="Employee ID">
                  <span className="font-mono text-[10px]">{selected}</span>
                </DetailRow>
                <DetailRow label="Property">
                  {activeProperty?.name ?? '—'}
                </DetailRow>
                <DetailRow label="Zone">
                  {zoneFor(selected) ?? 'Unallocated'}
                </DetailRow>
                <DetailRow label="Duty status">
                  {selectedEntry?.work_status?.label ?? 'Unknown'}
                  {selectedEntry?.work_status?.since
                    ? ` · since ${new Date(
                        selectedEntry.work_status.since
                      ).toLocaleTimeString()}`
                    : ''}
                </DetailRow>
                <DetailRow label="Coordinates">
                  {selectedEntry
                    ? `${fmtCoord(selectedEntry.latitude)}, ${fmtCoord(
                        selectedEntry.longitude
                      )}`
                    : '—'}
                </DetailRow>
                <DetailRow label="Accuracy">
                  {selectedEntry?.accuracy_m != null
                    ? `±${Math.round(selectedEntry.accuracy_m)} m`
                    : '—'}
                </DetailRow>
                <DetailRow label="Speed">
                  {selectedEntry?.speed_mps != null
                    ? `${selectedEntry.speed_mps.toFixed(1)} m/s (${(
                        selectedEntry.speed_mps * 3.6
                      ).toFixed(1)} km/h)`
                    : '—'}
                </DetailRow>
                <DetailRow label="Bearing">
                  {selectedEntry?.bearing_deg != null
                    ? `${Math.round(selectedEntry.bearing_deg)}°`
                    : '—'}
                </DetailRow>
                <DetailRow label="Altitude">
                  {selectedEntry?.altitude_m != null
                    ? `${Math.round(selectedEntry.altitude_m)} m`
                    : '—'}
                </DetailRow>
                <DetailRow label="Captured">
                  {fmtDateTime(selectedEntry?.captured_at)}
                </DetailRow>
                <DetailRow label="Received">
                  {fmtDateTime(selectedEntry?.received_at)}
                </DetailRow>
                <DetailRow label="Session">
                  <span className="font-mono text-[10px]">
                    {selectedEntry?.tracking_session_id ?? '—'}
                  </span>
                </DetailRow>
                <DetailRow label="Sequence">
                  {selectedEntry?.sequence_number ?? '—'}
                </DetailRow>
              </div>

              <div className="px-4 py-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <History className="w-3.5 h-3.5 text-[#2F6B45]" />
                  <p className="text-[11px] font-semibold text-[#17221B]">
                    Route history
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-[10px] uppercase tracking-wider text-[#8A918C] font-medium">
                    From
                    <input
                      type="datetime-local"
                      aria-label="History from"
                      className="mt-0.5 w-full text-xs bg-white border border-[#EDEAE2] rounded-[8px] px-2 py-1.5 text-[#17221B] focus:outline-none focus:ring-1 focus:ring-[#2F6B45]"
                      value={histFrom}
                      onChange={(e) => setHistFrom(e.target.value)}
                    />
                  </label>
                  <label className="block text-[10px] uppercase tracking-wider text-[#8A918C] font-medium">
                    To
                    <input
                      type="datetime-local"
                      aria-label="History to"
                      className="mt-0.5 w-full text-xs bg-white border border-[#EDEAE2] rounded-[8px] px-2 py-1.5 text-[#17221B] focus:outline-none focus:ring-1 focus:ring-[#2F6B45]"
                      value={histTo}
                      onChange={(e) => setHistTo(e.target.value)}
                    />
                  </label>
                  <Button
                    variant="primary"
                    onClick={() => void loadHistory()}
                    disabled={historyLoading}
                    className="w-full gap-2 !bg-[#2F6B45] hover:!bg-[#245538] !rounded-[8px] !py-1.5 text-xs"
                  >
                    {historyLoading ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <History className="w-3.5 h-3.5" />
                    )}
                    {historyLoading ? 'Loading…' : 'Load route'}
                  </Button>
                  {historyError && (
                    <p className="text-[11px] text-[#A82828]">{historyError}</p>
                  )}
                  {history && (
                    <>
                      <p className="text-[10px] text-[#8A918C]">
                        {history.returned_points.toLocaleString()} of{' '}
                        {history.total_points.toLocaleString()} points
                        {history.downsampled && (
                          <span className="text-[#8A5A1E]">
                            {' '}
                            · downsampled — the route keeps its shape but not
                            every fix is shown
                          </span>
                        )}
                      </p>
                      {history.points.length === 0 ? (
                        <p className="text-[11px] text-[#8A918C] py-2">
                          No recorded locations in this window.
                        </p>
                      ) : (
                        <div className="max-h-[180px] overflow-y-auto border border-[#F4F1EA] rounded-[8px]">
                          {history.points.map((p, i) => (
                            <button
                              key={`${p.sequence_number ?? i}-${i}`}
                              onClick={() => routeApiRef.current?.focus(p)}
                              className="w-full text-left px-2.5 py-1.5 border-b border-[#F4F1EA] last:border-0 hover:bg-[#FAF8F5] cursor-pointer"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-[#17221B]">
                                  {fmtDateTime(p.captured_at)}
                                </span>
                                {p.quality && p.quality !== 'valid' && (
                                  <QualityBadge quality={p.quality} />
                                )}
                              </div>
                              <span className="text-[10px] text-[#8A918C] font-mono">
                                {fmtCoord(p.latitude)}, {fmtCoord(p.longitude)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};
