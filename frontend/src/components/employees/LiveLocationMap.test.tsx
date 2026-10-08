/**
 * Live-location map tests.
 *
 * Two layers:
 *  1. `syncLiveMarkers` — the pure marker-diff logic (create/move/remove,
 *     is_live filtering) against a fake MarkerHandle.
 *  2. The component — polling, marker creation through the Leaflet
 *     boundary (mocked), empty/error states, and cleanup on unmount.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
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
vi.mock('../../api/locations', () => ({
  locationsApi: { liveLocations: (...a: unknown[]) => liveLocations(...a) },
}));

vi.mock('../../context/AppContext', () => ({
  useApp: () => ({
    currentPropertyEmployees: [
      {
        employee_uid: 'e1',
        name: 'Baldev Shokhar',
        zone_uid: 'z1',
      },
      { employee_uid: 'e2', name: 'Airco HK', zone_uid: null },
    ],
    currentPropertyZones: [{ zone_uid: 'z1', name: 'dorms' }],
  }),
}));

const markerRemove = vi.fn();
const markerSetLatLng = vi.fn();
const markerSetTooltip = vi.fn();
const markerFactory = vi.fn();
const mapRemove = vi.fn();
const mapFitBounds = vi.fn();

vi.mock('leaflet', () => {
  const makeMarker = () => {
    const m = {
      addTo: () => m,
      bindTooltip: () => m,
      setLatLng: markerSetLatLng,
      setTooltipContent: markerSetTooltip,
      remove: markerRemove,
    };
    markerFactory(m);
    return m;
  };
  return {
    default: {
      map: () => ({
        fitBounds: mapFitBounds,
        remove: mapRemove,
      }),
      tileLayer: () => ({ addTo: () => ({}) }),
      marker: () => makeMarker(),
      divIcon: (o: unknown) => o,
      latLngBounds: (p: unknown) => ({ points: p }),
    },
  };
});

vi.mock('leaflet/dist/leaflet.css', () => ({}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emp = (id: string, over: Partial<LiveLocationEmployee> = {}) => ({
  employee_id: id,
  latitude: 19.076,
  longitude: 72.8777,
  server_timestamp: 1_791_283_212,
  is_live: true,
  ...over,
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

  it('skips non-live employees entirely', () => {
    const markers = new Map<string, MarkerHandle>();
    syncLiveMarkers(
      markers,
      [emp('a', { is_live: false }), emp('b')],
      label,
      create
    );
    expect([...markers.keys()]).toEqual(['b']);
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
    markerRemove.mockClear();
    markerSetLatLng.mockClear();
    markerSetTooltip.mockClear();
    markerFactory.mockClear();
    mapRemove.mockClear();
    mapFitBounds.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders markers for live employees and shows the sidebar', async () => {
    liveLocations.mockResolvedValue({ employees: [emp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(markerFactory).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Baldev Shokhar')).toBeTruthy();
    expect(screen.getByText('1 live')).toBeTruthy();
    expect(mapFitBounds).toHaveBeenCalled();
  });

  it('updates positions on later polls without recreating markers', async () => {
    liveLocations.mockResolvedValue({ employees: [emp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(markerFactory).toHaveBeenCalledTimes(1);

    liveLocations.mockResolvedValue({
      employees: [emp('e1', { latitude: 21.5, longitude: 88.1 })],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    expect(markerFactory).toHaveBeenCalledTimes(1);
    expect(markerSetLatLng).toHaveBeenCalledWith([21.5, 88.1]);
  });

  it('removes the marker when an employee drops out of the payload', async () => {
    liveLocations.mockResolvedValue({ employees: [emp('e1')] });
    render(<LiveLocationMap />);
    await flushPoll();

    liveLocations.mockResolvedValue({ employees: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    expect(markerRemove).toHaveBeenCalled();
    expect(
      screen.getByText(/No staff are sharing their location/)
    ).toBeTruthy();
  });

  it('shows the empty state when nobody is live', async () => {
    liveLocations.mockResolvedValue({ employees: [] });
    render(<LiveLocationMap />);
    await flushPoll();
    expect(
      screen.getByText(/No staff are sharing their location/)
    ).toBeTruthy();
    expect(markerFactory).not.toHaveBeenCalled();
  });

  it('shows the error state when the API fails', async () => {
    liveLocations.mockRejectedValue(new Error('boom'));
    render(<LiveLocationMap />);
    await flushPoll();
    expect(screen.getByText('Could not load live locations.')).toBeTruthy();
  });

  it('stops polling and tears down the map on unmount', async () => {
    liveLocations.mockResolvedValue({ employees: [emp('e1')] });
    const { unmount } = render(<LiveLocationMap />);
    await flushPoll();
    unmount();
    expect(mapRemove).toHaveBeenCalled();

    liveLocations.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(liveLocations).not.toHaveBeenCalled();
  });
});
