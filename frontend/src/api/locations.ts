/**
 * Employee live locations & route history — proxied through the SA backend.
 *
 * The browser calls only our own /live-locations routes; the backend holds
 * LOCATION_SERVICE_API_KEY and talks to the Employee Backend server-side
 * (X-Location-Service-Key). Coordinates are transient — rendered on the
 * map, never persisted.
 */

import { apiFetch } from './client';

/** GPS data-quality flag — an indicator, not a misconduct verdict. */
export type LocationQuality =
  | 'valid'
  | 'low_accuracy'
  | 'delayed'
  | 'suspicious_speed'
  | string;

/**
 * Attendance-derived duty state — joined by the SA backend from the shared
 * attendance day/break rows. GPS activity alone never implies "working";
 * unresolved employees stay "unknown".
 */
export interface WorkStatus {
  state: 'working' | 'on_break' | 'off_duty' | 'unknown' | string;
  label: string;
  /** ISO datetime the state began (clock-in / break start / clock-out). */
  since?: string | null;
  /** IST operational-day key of the attendance record, when one exists. */
  attendance_date?: string | null;
  /** Raw attendance_days status (present/absent/leave/week_off). */
  attendance_status?: string | null;
}

export interface LiveLocationEmployee {
  employee_id: string;
  /** Null when the entry is stale (fix expired, is_stale=true). */
  latitude: number | null;
  longitude: number | null;
  /** Attendance-derived duty state, attached server-side. */
  work_status?: WorkStatus;
  /** GPS accuracy radius in metres (lower = better). */
  accuracy_m?: number;
  speed_mps?: number;
  bearing_deg?: number;
  altitude_m?: number;
  /** When the device captured the fix — authoritative time. */
  captured_at?: string;
  /** When the server ingested the fix. */
  received_at?: string;
  /** Epoch-second aliases of captured_at/received_at. */
  device_timestamp?: number;
  server_timestamp?: number;
  tracking_session_id?: string;
  sequence_number?: number;
  quality?: LocationQuality;
  source?: string;
  is_live: boolean;
  is_stale: boolean;
}

export interface LiveLocationsResponse {
  locations: LiveLocationEmployee[];
}

export interface LiveLocationResponse {
  location: LiveLocationEmployee | null;
}

export interface LiveLocationsQuery {
  employee_id?: string;
  property_id?: string;
  zone_id?: string;
  /** false = include stale entry; requires employee_id upstream. */
  is_active?: boolean;
}

export interface LocationHistoryPoint {
  latitude: number;
  longitude: number;
  accuracy_m?: number;
  speed_mps?: number;
  bearing_deg?: number;
  altitude_m?: number;
  captured_at?: string;
  received_at?: string;
  tracking_session_id?: string;
  sequence_number?: number;
  quality?: LocationQuality;
}

export interface LocationHistoryResponse {
  employee_id: string;
  from: string;
  to: string;
  total_points: number;
  returned_points: number;
  /** true → points were stride-downsampled; not every fix is shown. */
  downsampled: boolean;
  points: LocationHistoryPoint[];
}

export interface LocationHistoryQuery {
  /** ISO-8601 UTC datetimes; span must be <= 31 days. */
  from: string;
  to: string;
  tracking_session_id?: string;
  max_points?: number;
}

export const locationsApi = {
  liveLocations: (params?: LiveLocationsQuery) =>
    apiFetch<LiveLocationsResponse>('/live-locations', { query: params }),

  /** One employee's latest entry — live or stale (null when never reported). */
  liveLocation: (employeeUid: string) =>
    apiFetch<LiveLocationResponse>(`/live-locations/${employeeUid}`),

  locationHistory: (employeeUid: string, params: LocationHistoryQuery) =>
    apiFetch<LocationHistoryResponse>(
      `/live-locations/${employeeUid}/history`,
      { query: params }
    ),
};
