/**
 * Live-location map tests.
 *
 * Two layers:
 *  1. `syncLiveMarkers` — the pure marker-diff logic (create/move/remove,
 *     live/stale + null-coordinate filtering) against a fake MarkerHandle.
 *  2. The component — polling, marker creation through the Leaflet
 *     boundary (mocked), filters, detail panel, route history, and
 *     empty/error states plus cleanup on unmount.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LiveLocationMap,
  syncLiveMarkers,
  type MarkerHandle,
} from './LiveLocationMap';
import type { LiveLocationEmployee } from '../../api/locations';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const liveLocations = vi.fn();
const liveLocation = vi.fn();
const locationHistory = vi.fn();
vi.mock('../../api/locations', () => ({
  locationsApi: {
    liveLocations: (...a: unknown[]) => liveLocations(...a),
    liveLocation: (...a: unknown[]) => liveLocation(...a),
    locationHistory: (...a: unknown[]) => locationHistory(...a),
  },
}));

vi.mock('../../context/AppContext', () => ({
  useApp: () => ({
    currentPropertyEmployees: [
      {
        employee_uid: 'e1',
        name: 'Baldev Shokhar',
        zone_uid: 'z1',
        job_title: 'Housekeeper',
        status: 'Active',
      },
      { employee_uid: 'e2', name: 'Airco HK', zone_uid: null, status: 'Active' },
    ],
    currentPropertyZones: [{ zone_uid: 'z1', name: 'dorms' }],
    activeProperty: { property_uid: 'p1', name: 'Airco Suites' },
  }),
}));

const markerRemove = vi.fn();
const markerSetLatLng = vi.fn();
const markerSetTooltip = vi.fn();
const markerOn = vi.fn();
const markerFactory = vi.fn();
const mapRemove = vi.fn();
const mapFitBounds = vi.fn();
const mapSetView = vi.fn();
const mapOn = vi.fn();
const mapOnce = vi.fn();
const mapRemoveLayer = vi.fn();
const clusterAddLayer = vi.fn();
const clusterRemoveLayer = vi.fn();
const polylineAddTo = vi.fn();
const layerGroupClear = vi.fn();

vi.mock('leaflet', () => {
  const makeMarker = () => {
    const m = {
      addTo: () => m,
      bindTooltip: () => m,
      on: markerOn,
      setLatLng: markerSetLatLng,
      setTooltipContent: markerSetTooltip,
      remove: markerRemove,
    };
    markerFactory(m);
    return m;
  };
  const layerGroupApi = {
    clearLayers: (...a: unknown[]) => layerGroupClear(...a),
  };
  const layerGroup = () => ({
    addTo: () => layerGroupApi,
    clearLayers: (...a: unknown[]) => layerGroupClear(...a),
  });
  return {
    default: {
      map: () => ({
        fitBounds: mapFitBounds,
        remove: mapRemove,
        setView: mapSetView,
        getZoom: () => 12,
        getBounds: () => ({ contains: () => true }),
        on: mapOn,
        once: mapOnce,
        addLayer: () => ({}),
        removeLayer: mapRemoveLayer,
      }),
      tileLayer: () => ({ addTo: () => ({}) }),
      marker: () => makeMarker(),
      markerClusterGroup: () => ({
        addLayer: clusterAddLayer,
        removeLayer: clusterRemoveLayer,
        clearLayers: () => {},
      }),
      divIcon: (o: unknown) => o,
      latLngBounds: (p: unknown) => ({ points: p }),
      layerGroup,
      polyline: () => ({ addTo: polylineAddTo }),
      circleMarker: () => ({ addTo: () => ({}) }),
      popup: () => ({
        setLatLng: function (this: unknown) {
          return this;
        },
        setContent: function (this: unknown) {
          return this;
        },
        openOn: () => ({}),
      }),
    },
  };
});

vi.mock('leaflet.markercluster', () => ({}));
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('leaflet.markercluster/dist/MarkerCluster.css', () => ({}));
vi.mock('leaflet.markercluster/dist/MarkerCluster.Default.css', () => ({}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emp = (id: string, over: Partial<LiveLocationEmployee> = {}) => ({
  employee_id: id,
  latitude: 19.076,
  longitude: 72.8777,
  server_timestamp: 1_791_283_212,
  captured_at: '2026-10-08T11:00:00+00:00',
  received_at: '2026-10-08T11:00:01+00:00',
  quality: 'valid',
  is_live: true,
  is_stale: false,
  ...over,
});

const staleEmp = (id: string) =>
  emp(id, {
    latitude: null,
    longitude: null,
    is_live: false,
    is_stale: true,
  });

const fakeMarker = () => {
  const h: MarkerHandle & { setPosition: ReturnType<typeof vi.fn> } = {
    setPosition: vi.fn(),
    setLabel: vi.fn(),
    remove: vi.fn(),
  };
  return h;
};

const flushPoll = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

// ---------------------------------------------------------------------------
// syncLiveMarkers — unit level
// ---------------------------------------------------------------------------

describe('syncLiveMarkers', () => {
  const label = (e: LiveLocationEmployee) => e.employee_id;
  const create = () => fakeMarker();

  it('creates a marker per live employee', () => {
    const markers = new Map<string, MarkerHandle>();
    syncLiveMarkers(markers, [emp('a'), emp('b')], label, create);
    expect([...markers.keys()]).toEqual(['a', 'b']);
  });

  it('skips non-live and stale employees entirely', () => {
    const markers = new Map<string, MarkerHandle>();
    syncLiveMarkers(
      markers,
      [emp('a', { is_live: false }), staleEmp('s'), emp('b')],
      label,
      create
    );
    expect([...markers.keys()]).toEqual(['b']);
  });

  it('never renders a marker when coordinates are null', () => {
    const markers = new Map<string, MarkerHandle>();
    syncLiveMarkers(
      markers,
      [emp('a', { latitude: null, longitude: null })],
      label,
      create
    );
    expect(markers.size).toBe(0);
  });

  it('moves an existing marker instead of recreating it', () => {
    const markers = new Map<string, MarkerHandle>();
    syncLiveMarkers(markers, [emp('a')], label, create);
    const first = markers.get('a')!;
    syncLiveMarkers(
      markers,
      [emp('a', { latitude: 20.0, longitude: 80.0 })],
      label,
      create
    );
    expect(markers.get('a')).toBe(first);
    expect(first.setPosition).toHaveBeenCalledWith(20.0, 80.0);
  });

  it('removes markers for employees who disappear or go offline', () => {
    const markers = new Map<string, MarkerHandle>();
    syncLiveMarkers(markers, [emp('a'), emp('b')], label, create);
    syncLiveMarkers(
      markers,
      [emp('a'), emp('b', { is_live: false })],
      label,
      create
    );
    expect(markers.has('b')).toBe(false);
    syncLiveMarkers(markers, [], label, create);
    expect(markers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Component — polling + Leaflet boundary (mocked)
// ---------------------------------------------------------------------------

describe('LiveLocationMap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    liveLocations.mockReset();
    liveLocation.mockReset();
    locationHistory.mockReset();
    markerRemove.mockClear();
    markerSetLatLng.mockClear();
    markerSetTooltip.mockClear();
    markerOn.mockClear();
    markerFactory.mockClear();
    mapRemove.mockClear();
    mapFitBounds.mockClear();
    mapSetView.mockClear();
    mapOn.mockClear();
    mapOnce.mockClear();
    mapRemoveLayer.mockClear();
    clusterAddLayer.mockClear();
    clusterRemoveLayer.mockClear();
    polylineAddTo.mockClear();
    layerGroupClear.mockClear();
    liveLocation.mockResolvedValue({ location: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders markers for live employees and shows the sidebar', async () => {
    liveLocations.mockResolvedValue({ locations: [emp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(markerFactory).toHaveBeenCalledTimes(1);
    // The marker goes into the cluster group, not directly on the map.
    expect(clusterAddLayer).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: /Baldev Shokhar/ })
    ).toBeTruthy();
    expect(screen.getByText('1 live')).toBeTruthy();
    // A lone fix zooms close (not a broad fitBounds).
    expect(mapSetView).toHaveBeenCalledWith(
      [19.076, 72.8777],
      expect.any(Number)
    );
    const zoom = mapSetView.mock.calls[0][1] as number;
    expect(zoom).toBeGreaterThanOrEqual(16);
    expect(zoom).toBeLessThanOrEqual(19);
  });

  it('fits bounds when staff are spread across locations', async () => {
    liveLocations.mockResolvedValue({
      locations: [emp('e1'), emp('e2', { latitude: 28.6, longitude: 77.2 })],
    });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(markerFactory).toHaveBeenCalledTimes(2);
    expect(mapFitBounds).toHaveBeenCalled();
    expect(mapSetView).not.toHaveBeenCalled();
  });

  it('yields to manual pan/zoom until Recenter is clicked', async () => {
    liveLocations.mockResolvedValue({ locations: [emp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(mapSetView).toHaveBeenCalledTimes(1);
    // Let the programmatic-move guard settle (the mock never fires
    // moveend, so the 600 ms fallback releases it).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    // Admin drags the map — the registered dragstart/zoomstart handler.
    const navHandler = mapOn.mock.calls.find(
      ([ev]) => typeof ev === 'string' && ev.includes('dragstart')
    )?.[1] as (() => void) | undefined;
    expect(navHandler).toBeTruthy();
    act(() => navHandler!());

    // A membership change would normally refit — suppressed while manual.
    liveLocations.mockResolvedValue({
      locations: [emp('e1'), emp('e2', { latitude: 28.6, longitude: 77.2 })],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mapFitBounds).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Re-center on staff'));
    await flushPoll();
    expect(mapFitBounds).toHaveBeenCalled();
  });

  it('renders the attendance-derived work status badge', async () => {
    liveLocations.mockResolvedValue({
      locations: [
        emp('e1', {
          work_status: {
            state: 'on_break',
            label: 'On break',
            since: '2026-10-08T08:00:00+00:00',
          },
        }),
      ],
    });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(screen.getByText('On break')).toBeTruthy();
  });

  it('shows Unknown when no work status is attached', async () => {
    liveLocations.mockResolvedValue({ locations: [emp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('scopes the poll to the active property', async () => {
    liveLocations.mockResolvedValue({ locations: [] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(liveLocations).toHaveBeenCalledWith(
      expect.objectContaining({ property_id: 'p1' })
    );
  });

  it('updates positions on later polls without recreating markers', async () => {
    liveLocations.mockResolvedValue({ locations: [emp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(markerFactory).toHaveBeenCalledTimes(1);

    liveLocations.mockResolvedValue({
      locations: [emp('e1', { latitude: 21.5, longitude: 88.1 })],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(markerFactory).toHaveBeenCalledTimes(1);
    expect(markerSetLatLng).toHaveBeenCalledWith([21.5, 88.1]);
  });

  it('removes the marker when an employee drops out of the payload', async () => {
    liveLocations.mockResolvedValue({ locations: [emp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();

    liveLocations.mockResolvedValue({ locations: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clusterRemoveLayer).toHaveBeenCalled();
    expect(
      screen.getByText(/No clocked-in staff are sharing their location/)
    ).toBeTruthy();
  });

  it('shows the empty state when nobody is live', async () => {
    liveLocations.mockResolvedValue({ locations: [] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(
      screen.getByText(/No clocked-in staff are sharing their location/)
    ).toBeTruthy();
    expect(markerFactory).not.toHaveBeenCalled();
  });

  it('shows a stale entry in the list without a marker', async () => {
    liveLocations.mockResolvedValue({ locations: [staleEmp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(markerFactory).not.toHaveBeenCalled();
    expect(
      screen.getAllByText(/offline — last seen/).length
    ).toBeGreaterThan(0);
  });

  it('shows the error state when the API fails', async () => {
    liveLocations.mockRejectedValue(new Error('boom'));
    render(<LiveLocationMap />);
    await flushPoll();
    expect(screen.getByText('Could not load live locations.')).toBeTruthy();
  });

  it('stops polling and tears down the map on unmount', async () => {
    liveLocations.mockResolvedValue({ locations: [emp('e1')] });
    const { unmount } = render(<LiveLocationMap />);
    await flushPoll();
    unmount();
    expect(mapRemove).toHaveBeenCalled();

    liveLocations.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(liveLocations).not.toHaveBeenCalled();
  });

  it('sends employee + zone filters and re-polls on change', async () => {
    liveLocations.mockResolvedValue({ locations: [] });
    render(<LiveLocationMap />);
    await flushPoll();
    liveLocations.mockClear();

    fireEvent.change(screen.getByLabelText('Filter by zone'), {
      target: { value: 'z1' },
    });
    await flushPoll();
    expect(liveLocations).toHaveBeenCalledWith(
      expect.objectContaining({ zone_id: 'z1' })
    );

    fireEvent.change(screen.getByLabelText('Filter by employee'), {
      target: { value: 'e1' },
    });
    await flushPoll();
    expect(liveLocations).toHaveBeenLastCalledWith(
      expect.objectContaining({
        employee_id: 'e1',
        zone_id: 'z1',
        is_active: false,
      })
    );
  });

  it('opens the detail panel with fix fields and quality flag', async () => {
    liveLocations.mockResolvedValue({
      locations: [
        emp('e1', {
          accuracy_m: 8.5,
          speed_mps: 1.4,
          bearing_deg: 182,
          altitude_m: 900,
          quality: 'low_accuracy',
          tracking_session_id: 'sess-1',
          sequence_number: 17,
        }),
      ],
    });
    render(<LiveLocationMap />);
    await flushPoll();

    fireEvent.click(screen.getByRole('button', { name: /Baldev Shokhar/ }));
    await flushPoll();

    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('Low accuracy')).toBeTruthy();
    expect(screen.getByText('±9 m')).toBeTruthy();
    expect(screen.getByText('1.4 m/s (5.0 km/h)')).toBeTruthy();
    expect(screen.getByText('182°')).toBeTruthy();
    expect(screen.getByText('sess-1')).toBeTruthy();
    expect(screen.getByText('17')).toBeTruthy();
  });

  it('fetches a stale-capable lookup when the filtered employee is offline', async () => {
    liveLocations.mockResolvedValue({ locations: [staleEmp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();

    fireEvent.change(screen.getByLabelText('Filter by employee'), {
      target: { value: 'e1' },
    });
    await flushPoll();
    expect(liveLocations).toHaveBeenLastCalledWith(
      expect.objectContaining({ employee_id: 'e1', is_active: false })
    );

    // The stale entry opens the detail panel as "Not reporting".
    fireEvent.click(screen.getByRole('button', { name: /Baldev Shokhar/ }));
    await flushPoll();
    expect(screen.getByText('Not reporting')).toBeTruthy();
  });

  it('loads route history and draws the polyline', async () => {
    liveLocations.mockResolvedValue({ locations: [emp('e1')] });
    locationHistory.mockResolvedValue({
      employee_id: 'e1',
      from: '2026-10-09T00:00:00Z',
      to: '2026-10-09T12:00:00Z',
      total_points: 3,
      returned_points: 3,
      downsampled: true,
      points: [
        { latitude: 19, longitude: 72, captured_at: '2026-10-09T01:00:00Z', quality: 'valid', sequence_number: 1 },
        { latitude: 19.1, longitude: 72.1, captured_at: '2026-10-09T02:00:00Z', quality: 'delayed', sequence_number: 2 },
        { latitude: 19.2, longitude: 72.2, captured_at: '2026-10-09T03:00:00Z', quality: 'valid', sequence_number: 3 },
      ],
    });
    render(<LiveLocationMap />);
    await flushPoll();

    fireEvent.click(screen.getByRole('button', { name: /Baldev Shokhar/ }));
    await flushPoll();
    fireEvent.click(screen.getByText('Load route'));
    await flushPoll();

    expect(locationHistory).toHaveBeenCalledWith(
      'e1',
      expect.objectContaining({ max_points: 10_000 })
    );
    expect(polylineAddTo).toHaveBeenCalled();
    expect(screen.getByText(/3 of 3 points/)).toBeTruthy();
    expect(screen.getAllByText(/downsampled/).length).toBeGreaterThan(0);
    expect(screen.getByText('Delayed')).toBeTruthy();
  });

  it('rejects an invalid history range without calling the API', async () => {
    liveLocations.mockResolvedValue({ locations: [emp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();

    fireEvent.click(screen.getByRole('button', { name: /Baldev Shokhar/ }));
    await flushPoll();

    fireEvent.change(screen.getByLabelText('History to'), {
      target: { value: '2020-01-01T00:00' },
    });
    fireEvent.click(screen.getByText('Load route'));
    await flushPoll();

    expect(locationHistory).not.toHaveBeenCalled();
    expect(
      screen.getByText('End time must be after the start time.')
    ).toBeTruthy();
  });
});
