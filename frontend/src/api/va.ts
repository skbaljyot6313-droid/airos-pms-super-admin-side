/**
 * VA (Video Analytics) API client — camera + section CRUD, stream sessions.
 *
 * Camera RTSP URLs are never returned by the API — responses carry a masked
 * form (`rtsp://host/***`); credentials are write-only. Stream playback uses
 * short-lived JWTs embedded in the returned WebRTC/HLS URLs.
 */
import { apiFetch } from './client';

export interface VaCamera {
  camera_uid: string;
  property_uid: string;
  zone_uid: string | null;
  zone_name: string | null;
  area_uid: string | null;
  area_name: string | null;
  name: string;
  description: string | null;
  location: string | null;
  rtsp_url_masked: string;
  sub_rtsp_url_masked: string | null;
  /** null → global default; explicit true/false → per-camera override. */
  transcode: boolean | null;
  /** Keep the upstream camera connection hot for fast first-frame. */
  warm?: boolean;
  username: string | null;
  has_credentials: boolean;
  transport: 'tcp' | 'udp';
  resolution: string | null;
  fps: number | null;
  is_enabled: boolean;
  connection_status: 'unknown' | 'online' | 'offline' | 'error';
  last_checked_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface VaStreamSession {
  session_uid: string;
  camera_uid: string;
  camera_name?: string;
  status: 'active' | 'ended';
  protocol: string;
  quality?: 'main' | 'sub';
  webrtc_url?: string;
  hls_url?: string;
  stream_token?: string;
  expires_at?: string;
  started_at: string | null;
  ended_at: string | null;
  /** true when an existing active session was reused (idempotent create). */
  reused?: boolean;
  /** camera is warm — upstream held hot for fast first-frame. */
  warm?: boolean;
  /** backend processing time for the session request, milliseconds. */
  server_ms?: number;
}

export interface VaCameraPayload {
  name: string;
  description?: string | null;
  zone_uid?: string | null;
  area_uid?: string | null;
  rtsp_url?: string;
  sub_rtsp_url?: string | null;
  transcode?: boolean | null;
  warm?: boolean;
  location?: string | null;
  username?: string | null;
  password?: string | null;
  transport?: 'tcp' | 'udp';
  resolution?: string | null;
  fps?: number | null;
  is_enabled?: boolean;
}

export interface VaTestResult {
  camera_uid: string;
  tcp_reachable: boolean | null;
  media_server_ready: boolean | null;
  connection_status: VaCamera['connection_status'];
  last_checked_at: string;
}

const base = (propertyUid: string) => `/va/properties/${propertyUid}`;

export const listVaCameras = (
  propertyUid: string,
  opts: {
    zoneUid?: string;
    areaUid?: string;
    status?: string;
    search?: string;
  } = {}
) =>
  apiFetch<VaCamera[]>(`${base(propertyUid)}/cameras`, {
    query: {
      zone_uid: opts.zoneUid,
      area_uid: opts.areaUid,
      status: opts.status,
      search: opts.search,
    },
  });

export const createVaCamera = (propertyUid: string, body: VaCameraPayload) =>
  apiFetch<VaCamera>(`${base(propertyUid)}/cameras`, { method: 'POST', body });

export const updateVaCamera = (
  propertyUid: string,
  cameraUid: string,
  body: VaCameraPayload
) =>
  apiFetch<VaCamera>(`${base(propertyUid)}/cameras/${cameraUid}`, {
    method: 'PATCH',
    body,
  });

export const deleteVaCamera = (propertyUid: string, cameraUid: string) =>
  apiFetch<void>(`${base(propertyUid)}/cameras/${cameraUid}`, {
    method: 'DELETE',
  });

export const bulkMoveVaCameras = (
  propertyUid: string,
  cameraUids: string[],
  target: { zoneUid?: string | null; areaUid?: string | null }
) =>
  apiFetch<{ moved: number; zone_uid: string | null; area_uid: string | null }>(
    `${base(propertyUid)}/cameras/bulk-move`,
    {
      method: 'POST',
      body: {
        camera_uids: cameraUids,
        zone_uid: target.zoneUid ?? null,
        area_uid: target.areaUid ?? null,
      },
    }
  );

export const testVaCameraConnection = (propertyUid: string, cameraUid: string) =>
  apiFetch<VaTestResult>(
    `${base(propertyUid)}/cameras/${cameraUid}/test-connection`,
    { method: 'POST' }
  );

export const createVaStreamSession = (
  propertyUid: string,
  cameraUid: string,
  protocol: 'webrtc' | 'hls' = 'webrtc',
  quality: 'main' | 'sub' = 'main'
) =>
  apiFetch<VaStreamSession>(
    `${base(propertyUid)}/cameras/${cameraUid}/stream-session`,
    { method: 'POST', query: { protocol, quality } }
  );

export const getVaStreamSession = (sessionUid: string) =>
  apiFetch<VaStreamSession>(`/va/stream-sessions/${sessionUid}`);

export const endVaStreamSession = (sessionUid: string) =>
  apiFetch<void>(`/va/stream-sessions/${sessionUid}`, { method: 'DELETE' });
