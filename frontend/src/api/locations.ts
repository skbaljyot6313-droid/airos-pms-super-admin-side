/**
 * Live employee locations — proxied through the SA backend.
 *
 * The browser calls only our own GET /live-locations; the backend holds
 * LOCATION_SERVICE_API_KEY and talks to the Employee Backend server-side.
 * Coordinates are transient — rendered on the map, never persisted.
 */

import { apiFetch } from './client';

export interface LiveLocationEmployee {
  employee_id: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  device_timestamp?: number;
  /** Server-side fix time (epoch seconds) — authoritative freshness. */
  server_timestamp?: number;
  speed?: number;
  heading?: number;
  is_live: boolean;
}

export interface LiveLocationsResponse {
  employees: LiveLocationEmployee[];
}

export const locationsApi = {
  liveLocations: () =>
    apiFetch<LiveLocationsResponse>('/live-locations'),
};
