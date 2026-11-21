import { describe, expect, it } from 'vitest';
import { bucketKeys, inclusiveDays, validateCustomRange } from './period';

describe('inclusiveDays', () => {
  it('counts both ends', () => {
    expect(inclusiveDays('2026-11-01', '2026-11-01')).toBe(1);
    expect(inclusiveDays('2026-11-01', '2026-11-30')).toBe(30);
  });
  it('handles month and leap boundaries', () => {
    expect(inclusiveDays('2028-02-28', '2028-03-01')).toBe(3);
  });
});

describe('validateCustomRange', () => {
  it('requires both dates', () => {
    expect(validateCustomRange('', '2026-11-01')).toMatch(/both/);
  });
  it('rejects reversed ranges', () => {
    expect(validateCustomRange('2026-11-05', '2026-11-01')).toMatch(/after/);
  });
  it('caps range length at 366 days', () => {
    expect(validateCustomRange('2025-01-01', '2026-01-02')).toMatch(/366/);
    expect(validateCustomRange('2025-01-01', '2026-01-01')).toBeNull();
    expect(validateCustomRange('2026-01-01', '2026-12-31')).toBeNull();
  });
});

describe('bucketKeys', () => {
  it('returns every day, zero-filled by the caller', () => {
    expect(bucketKeys('2026-11-01', '2026-11-03', 'day')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });
  it('groups weeks by Monday', () => {
    // 2026-11-02 is a Monday; 2026-11-08 is a Sunday in the same week
    expect(bucketKeys('2026-11-02', '2026-11-10', 'week')).toEqual(['2026-11-02', '2026-11-09']);
  });
  it('groups months by first day', () => {
    expect(bucketKeys('2026-10-15', '2026-11-02', 'month')).toEqual(['2026-10-01', '2026-11-01']);
  });
});
