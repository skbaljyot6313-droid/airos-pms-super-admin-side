import type { DashboardGranularity, DashboardPeriodKey } from '../../api/dashboard';

export const PERIOD_OPTIONS: { key: DashboardPeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last_7_days', label: 'Last 7 days' },
  { key: 'last_30_days', label: 'Last 30 days' },
  { key: 'last_90_days', label: 'Last 90 days' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_6_months', label: 'Last 6 months' },
  { key: 'custom', label: 'Custom range' },
];

export const GRANULARITY_OPTIONS: { key: DashboardGranularity; label: string }[] = [
  { key: 'day', label: 'Daily' },
  { key: 'week', label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
];

export const MAX_CUSTOM_DAYS = 366;

/** Whole days inclusive between two ISO dates (YYYY-MM-DD). */
export function inclusiveDays(from: string, to: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86400000) + 1;
}

/** Returns an error message for an invalid custom range, or null when valid. */
export function validateCustomRange(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both a start and an end date.';
  if (to < from) return '"To" must be on or after "From".';
  if (inclusiveDays(from, to) > MAX_CUSTOM_DAYS) return `A custom range may not exceed ${MAX_CUSTOM_DAYS} days.`;
  return null;
}

/**
 * Every bucket key (day / Monday-week / month-start) from `from` to `to`,
 * inclusive, so charts show zero-valued buckets instead of silent gaps.
 */
export function bucketKeys(from: string, to: string, granularity: DashboardGranularity): string[] {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const keys: string[] = [];
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t);
    let key = iso(t);
    if (granularity === 'week') {
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      key = iso(t - dow * 86400000);
    } else if (granularity === 'month') {
      key = `${iso(t).slice(0, 7)}-01`;
    }
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}
