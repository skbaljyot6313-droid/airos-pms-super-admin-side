import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cctv,
  Grid2x2,
  LayoutGrid,
  Loader2,
  Maximize,
  RefreshCw,
  Search,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import {
  VaCamera,
  VaStreamSession,
  createVaStreamSession,
  endVaStreamSession,
  getVaStreamSession,
  listVaCameras,
} from '../../api/va';
import { useApp } from '../../context/AppContext';
import { mediaUrl } from '../../api/client';
import { Go2rtcPlayer, attachHls } from '../../lib/webrtc';

type GridSize = 1 | 4 | 9 | 16;

/** Bounded concurrency for stream-session requests — a 4x4 grid fires 16
 * tiles at once; queuing above this keeps the backend pool and camera
 * network from being hit by an unbounded burst while still parallel. */
const MAX_CONCURRENT_SESSIONS = 8;
let sessionsInFlight = 0;
const sessionQueue: Array<() => void> = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (sessionsInFlight >= MAX_CONCURRENT_SESSIONS) {
    await new Promise<void>((resolve) => sessionQueue.push(resolve));
  }
  sessionsInFlight++;
  try {
    return await fn();
  } finally {
    sessionsInFlight--;
    sessionQueue.shift()?.();
  }
}

const SESSION_HEARTBEAT_MS = 60_000; // keep last_activity fresh while watching
const FIRST_FRAME_WATCHDOG_MS = 15_000; // SDP ok but no decoded frame → error

const GRID_COLS: Record<GridSize, string> = {
  1: 'grid-cols-1',
  4: 'grid-cols-2',
  9: 'grid-cols-3',
  16: 'grid-cols-4',
};

const STATUS_DOT: Record<VaCamera['connection_status'], string> = {
  online: 'bg-emerald-500',
  offline: 'bg-red-500',
  error: 'bg-amber-500',
  unknown: 'bg-[#B7B0A4]',
};

/** One grid cell — owns its session + player lifecycle independently. */
const CameraTile: React.FC<{
  propertyUid: string;
  camera: VaCamera;
  /** 'sub' = camera substream for dense grids; 'main' = primary/fullscreen. */
  quality: 'main' | 'sub';
  onRemove?: () => void;
  onSwap?: () => void;
}> = ({ propertyUid, camera, quality, onRemove }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Go2rtcPlayer | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<string | null>(null);
  // Generation counter + mounted flag — stale async work (unmount, quality
  // switch, manual refresh) can never touch state or the video element.
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  const heartbeatRef = useRef<number | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const timingsRef = useRef<Record<string, number>>({});
  const [state, setState] = useState<'idle' | 'connecting' | 'live' | 'error'>(
    'idle'
  );
  const [errMsg, setErrMsg] = useState('');
  const [fullscreen, setFullscreen] = useState(false);

  // Fullscreen always uses the primary stream; grid uses the layout quality.
  const effectiveQuality = fullscreen ? 'main' : quality;

  const connect = useCallback(async () => {
    const gen = ++genRef.current;
    const alive = () => mountedRef.current && gen === genRef.current;
    if (!camera.is_enabled) {
      setState('error');
      setErrMsg('Camera disabled');
      return;
    }
    setState('connecting');
    setErrMsg('');
    timingsRef.current = {};
    const t0 = performance.now();
    const logPerf = () => {
      // Structured per-camera startup timing — correlation id = session_uid.
      console.debug('[va-perf]', {
        camera: camera.camera_uid,
        name: camera.name,
        session: sessionRef.current,
        quality: effectiveQuality,
        total_ms: Math.round(performance.now() - t0),
        ...timingsRef.current,
      });
    };
    const clearTimers = () => {
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      if (watchdogRef.current) window.clearTimeout(watchdogRef.current);
      heartbeatRef.current = watchdogRef.current = null;
    };
    clearTimers();
    try {
      const sess: VaStreamSession = await limited(() =>
        createVaStreamSession(
          propertyUid,
          camera.camera_uid,
          'webrtc',
          effectiveQuality
        )
      );
      if (!alive()) return;
      timingsRef.current.session_ms = sess.server_ms ?? Math.round(performance.now() - t0);
      timingsRef.current.reused = sess.reused ? 1 : 0;
      sessionRef.current = sess.session_uid;
      // Session keepalive — touches last_activity so the idle sweep never
      // retires a session someone is actively watching.
      heartbeatRef.current = window.setInterval(() => {
        const uid = sessionRef.current;
        if (uid) getVaStreamSession(uid).catch(() => undefined);
      }, SESSION_HEARTBEAT_MS);
      const video = videoRef.current;
      if (sess.webrtc_url && sess.stream_token) {
        const p = new Go2rtcPlayer();
        playerRef.current = p;
        // SDP complete but no decoded frame within the watchdog → error.
        watchdogRef.current = window.setTimeout(() => {
          if (alive()) {
            setState('error');
            setErrMsg('No video — press retry');
          }
        }, FIRST_FRAME_WATCHDOG_MS);
        await p.start(
          mediaUrl(sess.webrtc_url),
          () => videoRef.current, // lazy — element may remount mid-negotiation
          sess.stream_token,
          {
            onIceFailed: () => {
              if (!alive()) return;
              playerRef.current?.stop();
              setState('error');
              setErrMsg('Connection lost — press retry');
            },
            onFirstFrame: () => {
              if (!alive()) return;
              if (watchdogRef.current) window.clearTimeout(watchdogRef.current);
              logPerf();
              setState('live');
            },
            onStage: (stage, ms) => {
              timingsRef.current[stage] = ms;
            },
          }
        );
      } else if (sess.hls_url && video) {
        cleanupRef.current = await attachHls(sess.hls_url, video);
        if (!alive()) return;
        video.addEventListener(
          'loadeddata',
          () => {
            if (!alive()) return;
            if (watchdogRef.current) window.clearTimeout(watchdogRef.current);
            logPerf();
            setState('live');
          },
          { once: true }
        );
      } else {
        throw new Error('No playback URL returned');
      }
    } catch (e) {
      if (!alive()) return;
      clearTimers();
      setState('error');
      setErrMsg(e instanceof Error ? e.message : 'Stream failed');
    }
  }, [propertyUid, camera, effectiveQuality]);

  // Track element fullscreen — reconnect at 'main' quality on the way in.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      genRef.current++;
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      if (watchdogRef.current) window.clearTimeout(watchdogRef.current);
      heartbeatRef.current = watchdogRef.current = null;
      playerRef.current?.stop();
      playerRef.current = null;
      cleanupRef.current?.();
      cleanupRef.current = null;
      const uid = sessionRef.current;
      sessionRef.current = null;
      if (uid) endVaStreamSession(uid).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.camera_uid, effectiveQuality]);

  return (
    <div className="group relative bg-[#17150F] rounded-lg overflow-hidden border border-[#3A362E] aspect-video">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-contain"
      />
      {state !== 'live' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#8C867C]">
          {state === 'connecting' ? (
            <>
              <Loader2 className="w-6 h-6 animate-spin" />
              <span className="text-[12px]">Connecting…</span>
            </>
          ) : (
            <>
              <VideoOff className="w-6 h-6" />
              <span className="text-[12px]">{errMsg || 'Stream unavailable'}</span>
              <button
                onClick={connect}
                className="mt-1 flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#2B2820] text-[11px] text-[#D8D2C6] hover:bg-[#38342A]"
              >
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            </>
          )}
        </div>
      )}
      {/* Overlay: name + status */}
      <div className="absolute top-0 inset-x-0 px-2.5 py-1.5 flex items-center justify-between bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`w-1.5 h-1.5 rounded-full flex-none ${STATUS_DOT[camera.connection_status]}`}
          />
          <span className="text-[11.5px] font-medium text-white/95 truncate">
            {camera.name}
          </span>
          {(camera.zone_name || camera.area_name) && (
            <span className="text-[10px] text-white/60 flex-none">
              · {camera.zone_name ?? camera.area_name}
            </span>
          )}
        </div>
      </div>
      {/* Hover controls */}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={connect}
          title="Refresh stream"
          className="p-1.5 rounded-md bg-black/55 text-white/80 hover:text-white"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => videoRef.current?.requestFullscreen?.()}
          title="Fullscreen"
          className="p-1.5 rounded-md bg-black/55 text-white/80 hover:text-white"
        >
          <Maximize className="w-3.5 h-3.5" />
        </button>
        {onRemove && (
          <button
            onClick={onRemove}
            title="Remove from view"
            className="p-1.5 rounded-md bg-black/55 text-white/80 hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};

export const VaVms: React.FC<{ propertyUid: string }> = ({ propertyUid }) => {
  const { addToast, areas, zones } = useApp();
  const [cameras, setCameras] = useState<VaCamera[]>([]);
  const [sel, setSel] = useState<string>('all');
  const [grid, setGrid] = useState<GridSize>(4);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCameras(await listVaCameras(propertyUid));
    } catch (e) {
      addToast({ type: 'error', title: e instanceof Error ? e.message : 'Failed to load cameras' });
    } finally {
      setLoading(false);
    }
  }, [propertyUid, addToast]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = cameras.filter((c) => {
    if (hidden.has(c.camera_uid)) return false;
    if (sel === 'unassigned' && (c.zone_uid || c.area_uid)) return false;
    if (sel.startsWith('zone:') && c.zone_uid !== sel.slice(5)) return false;
    if (sel.startsWith('area:') && c.area_uid !== sel.slice(5)) return false;
    if (search && !c.name.toLowerCase().includes(search.toLowerCase()))
      return false;
    return true;
  });

  const pages = Math.max(1, Math.ceil(filtered.length / grid));
  const pageClamped = Math.min(page, pages - 1);
  const visible = filtered.slice(pageClamped * grid, pageClamped * grid + grid);
  const onlineCount = cameras.filter(
    (c) => c.connection_status === 'online'
  ).length;

  const sectionBtn = (
    key: string,
    label: string,
    count: number,
    online: number
  ) => (
    <button
      key={key}
      onClick={() => {
        setSel(key);
        setPage(0);
      }}
      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-[12.5px] transition-colors ${
        sel === key
          ? 'bg-[#E7EFE7] text-[#386641] font-semibold'
          : 'text-[#58534C] hover:bg-[#EFECE5]'
      }`}
    >
      <span className="truncate">{label}</span>
      <span className="flex items-center gap-1.5 flex-none text-[11px]">
        {online > 0 && (
          <span className="text-emerald-600 font-medium">{online}</span>
        )}
        <span className="text-[#A39D92]">{count}</span>
      </span>
    </button>
  );

  return (
    <div className="flex-1 flex min-h-0">
      {/* Sidebar */}
      <aside className="w-52 flex-none border-r border-[#EAE5DC] bg-[#FBFAF7] p-3 flex flex-col gap-1 overflow-y-auto">
        <div className="text-[10.5px] font-semibold tracking-wide text-[#A39D92] uppercase px-3 pb-1">
          Cameras
        </div>
        {sectionBtn(
          'all',
          'All cameras',
          cameras.length,
          cameras.filter((c) => c.connection_status === 'online').length
        )}
        <div className="text-[10.5px] font-semibold tracking-wide text-[#A39D92] uppercase px-3 pt-3 pb-1">
          Areas &amp; zones
        </div>
        {areas.map((a) => {
          const az = zones.filter((z) => z.area_uid === a.area_uid);
          const areaCams = cameras.filter((c) => c.area_uid === a.area_uid);
          return (
            <div key={a.area_uid}>
              {sectionBtn(
                `area:${a.area_uid}`,
                a.name,
                areaCams.length,
                areaCams.filter((c) => c.connection_status === 'online').length
              )}
              <div className="pl-3">
                {az.map((z) =>
                  sectionBtn(
                    `zone:${z.zone_uid}`,
                    z.name,
                    cameras.filter((c) => c.zone_uid === z.zone_uid).length,
                    0
                  )
                )}
              </div>
            </div>
          );
        })}
        {zones.filter((z) => !z.area_uid).length > 0 && (
          <div className="pl-1">
            {zones
              .filter((z) => !z.area_uid)
              .map((z) =>
                sectionBtn(
                  `zone:${z.zone_uid}`,
                  z.name,
                  cameras.filter((c) => c.zone_uid === z.zone_uid).length,
                  0
                )
              )}
          </div>
        )}
        {sectionBtn(
          'unassigned',
          'Unassigned',
          cameras.filter((c) => !c.zone_uid && !c.area_uid).length,
          0
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 p-4">
        {/* Toolbar */}
        <div className="flex items-center gap-2 pb-3">
          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[#386641]">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            LIVE
          </span>
          <span className="text-[12px] text-[#8C867C]">
            {filtered.length} camera{filtered.length === 1 ? '' : 's'} ·{' '}
            {onlineCount} online
          </span>
          <div className="flex-1" />
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#A39D92]" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Search cameras…"
              className="pl-8 pr-3 py-1.5 rounded-lg border border-[#EAE5DC] bg-white text-[12.5px] w-44 outline-none focus:border-[#386641]"
            />
          </div>
          {([1, 4, 9, 16] as GridSize[]).map((n) => (
            <button
              key={n}
              onClick={() => {
                setGrid(n);
                setPage(0);
              }}
              title={`${Math.sqrt(n)}×${Math.sqrt(n)}`}
              className={`p-2 rounded-lg border text-[11px] font-medium ${
                grid === n
                  ? 'border-[#386641] bg-[#E7EFE7] text-[#386641]'
                  : 'border-[#EAE5DC] text-[#8C867C] hover:text-[#58534C]'
              }`}
            >
              {n === 1 ? <Video className="w-4 h-4" /> : n === 4 ? <Grid2x2 className="w-4 h-4" /> : <LayoutGrid className="w-4 h-4" />}
            </button>
          ))}
          <button
            onClick={load}
            title="Refresh"
            className="p-2 rounded-lg border border-[#EAE5DC] text-[#8C867C] hover:text-[#58534C]"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Grid */}
        {loading && cameras.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-[#A39D92]">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[#A39D92]">
            <Cctv className="w-8 h-8" />
            <span className="text-[13px]">
              No cameras here — add them in Camera Settings.
            </span>
          </div>
        ) : (
          <div className={`flex-1 grid ${GRID_COLS[grid]} gap-2 auto-rows-min`}>
            {visible.map((c) => (
              <CameraTile
                key={c.camera_uid}
                propertyUid={propertyUid}
                camera={c}
                quality={grid >= 9 ? 'sub' : 'main'}
                onRemove={() =>
                  setHidden((h) => new Set(h).add(c.camera_uid))
                }
              />
            ))}
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-3">
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                onClick={() => setPage(i)}
                className={`w-2 h-2 rounded-full ${
                  i === pageClamped ? 'bg-[#386641]' : 'bg-[#D8D2C6]'
                }`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
