import { apiFetch } from './client';

export type DashboardPeriodKey =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'this_month'
  | 'last_month'
  | 'last_6_months'
  | 'custom';

export type DashboardGranularity = 'day' | 'week' | 'month';

/** Data-quality policy states (redesign brief §12). */
export type DataState = 'available' | 'limited' | 'insufficient' | 'unverified' | 'no_records';

export interface DashboardDataQualityItem {
  key: string;
  label: string;
  state: DataState;
  detail: string;
}

export interface OccupancyPoint {
  bucket: string;
  label: string;
  date?: string;
  occupied_rooms: number;
  total_rooms: number;
  occupancy_pct: number | null;
  peak_occupied_rooms?: number;
  days?: number;
}

export interface OccupancyTrend {
  granularity: 'hour' | 'day' | 'week' | 'month';
  points: OccupancyPoint[];
  reliable: boolean;
  reason: string | null;
  first_record_date: string | null;
  average_occupied_rooms: number | null;
  peak: { date: string; occupied_rooms: number } | null;
  low: { date: string; occupied_rooms: number } | null;
  days_with_records: number;
}

export interface AttendancePoint {
  date: string;
  label: string;
  state: 'available' | 'no_records';
  expected: number;
  present: number | null;
  absent: number | null;
  on_leave: number;
  not_marked: number | null;
  attendance_pct: number | null;
}

export interface ZoneRow {
  zone_name: string;
  rooms: number;
  occupied: number;
  vacant: number;
  occupancy_pct: number | null;
  unverified_cleaning: number;
  open_maintenance?: number;
  cleaning_verified?: number;
  cleaning_unverified?: number;
}

export interface DepartmentRow {
  department_name: string;
  department_uid: string;
  status: 'active' | 'inactive';
  employees: number;
  present_today: number;
  on_leave_today: number;
  tasks_created: number;
  tasks_completed: number;
  open_now: number;
  completion_pct: number | null;
}

export interface ActivityItem {
  kind: 'task' | 'maintenance' | 'occupancy' | 'allocation';
  label: string;
  detail: string | null;
  at: string | null;
  actor: string | null;
  href: string;
}

export interface MaintenanceRow {
  ticket_number: string;
  unit: string;
  zone: string;
  issue: string;
  status: string;
  created: string | null;
  duration_hours: number;
}

export interface PropertyDashboard {
  property: { property_uid: string; name: string };
  period: { key: DashboardPeriodKey; label: string; from: string; to: string; days: number; granularity: string; compares_previous: boolean };
  generated_at: string;
  current: { as_of_operational_date: string; operational_day_start: string };
  occupancy: {
    rooms: {
      total: number;
      occupied: number;
      vacant: number;
      maintenance: number;
      unavailable_cleaning: number;
      cleaning_verified: number;
      cleaning_unverified: number;
      other_state: number;
      occupancy_pct: number | null;
      state_ledger_mismatch: number;
    };
    beds: {
      total: number;
      occupied: number;
      available: number;
      maintenance: number;
      cleaning_verified: number;
      cleaning_unverified: number;
      occupancy_pct: number | null;
    };
    dorms: {
      total: number;
      occupied: number;
      vacant: number;
      maintenance: number;
      cleaning_verified: number;
      cleaning_unverified: number;
      occupancy_pct: number | null;
    };
    by_dorm_type: { type: string; dorms: number; dorms_occupied: number; beds: number; beds_occupied: number; occupancy_pct: number | null }[];
    by_dorm: { dorm_name: string; dorm_type: string; status: string; beds_occupied: number; beds_total: number; occupancy_pct: number | null }[];
    segments: { key: string; label: string; count: number; pct: number | null; drill: string; unverified?: number }[];
    trend: OccupancyTrend;
    period_activity: { check_ins: number; check_outs: number };
    stay: { closed_stays: number; avg_nights: number | null; reliable: boolean };
    by_zone: ZoneRow[];
    by_room_type: { type: string; rooms: number; occupied: number; occupancy_pct: number | null }[];
  };
  conditions: {
    units_under_maintenance_now: number;
    cleaning_verified: number;
    cleaning_unverified: number;
    ready_for_occupancy: number;
    rooms_unavailable: number;
  };
  workforce: {
    active: number;
    inactive: number;
    present_today: number;
    absent_today: number;
    on_leave_today: number;
    not_yet_marked_today: number;
    unallocated: number;
    assigned_to_department: number;
    assigned_to_operational_work: number;
    attendance_period: {
      status_counts: Record<string, number>;
      recorded_days: number;
      period_days: number;
      attendance_pct: number | null;
      late_arrivals: number | null;
      late_reason: string;
      trend_reliable: boolean;
    };
    attendance_series: { points: AttendancePoint[]; recorded_days: number; period_days: number; denominator_note: string };
  };
  departments: DepartmentRow[];
  tasks: {
    created_in_period: number;
    completed_in_period: number;
    open_now: number;
    open_by_status: Record<string, number>;
    carried_over: number;
    awaiting_review: number;
    abandoned_expiry_by_design: number;
    abandoned_other: number;
    abandoned_reasons: { reason: string; count: number; class: 'expiry' | 'other' }[];
    completion_rate_pct: number | null;
    completion_rate_base: number;
    median_completion_minutes: number | null;
    median_review_minutes: number | null;
    reviewed_in_period: number;
    approved_in_period: number;
    rejected_in_period: number;
    generated_trend: { bucket: string; generated: number }[];
    completion_trend: { bucket: string; completed: number }[];
    by_status: { status: string; count: number }[];
    by_zone: { zone_name: string; created: number; completed: number; open: number }[];
    workload_top: { employee_uid: string | null; open: number }[];
  };
  cleaning: {
    created_in_period: number;
    by_status: Record<string, number>;
    completed_in_period: number;
    pending_now: number;
    median_turnaround_minutes: number | null;
    by_zone: { zone_name: string; pending: number }[];
    note: string;
  };
  maintenance: {
    table: MaintenanceRow[];
    open_now: number;
    critical_open: number;
    ageing: { under_1d: number; '1_to_3d': number; '3_to_7d': number; over_7d: number };
    created_in_period: number;
    resolved_in_period: number;
    median_resolution_hours: number | null;
    by_status: Record<string, number>;
    by_zone: { zone_name: string; open: number }[];
    by_category: { category: string; count: number }[];
    last_ticket_created: string | null;
  };
  zones: ZoneRow[];
  activity: ActivityItem[];
  data_quality: DashboardDataQualityItem[];
}

export function getPropertyDashboard(
  propertyUid: string,
  query: { period: DashboardPeriodKey; granularity?: DashboardGranularity; from?: string; to?: string },
  options?: { signal?: AbortSignal },
): Promise<PropertyDashboard> {
  const params = new URLSearchParams({ period: query.period, granularity: query.granularity ?? 'day' });
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  return apiFetch<PropertyDashboard>(`/properties/${propertyUid}/dashboard?${params.toString()}`, { signal: options?.signal });
}
