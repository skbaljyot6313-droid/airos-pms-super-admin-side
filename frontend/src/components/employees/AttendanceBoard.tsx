import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardList, RefreshCw, TriangleAlert } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { ApiError } from '../../api/client';
import {
  attendanceApi,
  type DayStatusBoard,
  type DayStatusItem,
} from '../../api/attendance';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';

type Tone = 'sage' | 'orange' | 'red' | 'neutral';

const STATUS_TONE: Record<DayStatusItem['status'], Tone> = {
  working: 'sage',
  on_break: 'orange',
  completed: 'sage',
  absent: 'red',
  awaiting: 'orange',
  scheduled: 'neutral',
  off_day: 'neutral',
  incomplete: 'red',
  not_scheduled: 'neutral',
};

const istToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const fmtTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const fmtWindow = (item: DayStatusItem) =>
  item.scheduled_start
    ? `${item.scheduled_start} – ${item.scheduled_end ?? '…'}`
    : 'No shift';

const Flag: React.FC<{ label: string; tone: Tone }> = ({ label, tone }) => (
  <Badge size="sm" variant={tone}>{label}</Badge>
);

export const AttendanceBoard: React.FC = () => {
  const { activeProperty } = useApp();
  const propertyUid = activeProperty?.property_uid;

  const [date, setDate] = useState(istToday);
  const [board, setBoard] = useState<DayStatusBoard | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!propertyUid) return;
    try {
      setBoard(await attendanceApi.statusBoard(propertyUid, date));
      setError(null);
      setStatus('ready');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load board.'
      );
      setStatus('error');
    }
  }, [propertyUid, date]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!board?.is_today) return;
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [board?.is_today, load]);

  const onFloor = (board?.employees ?? []).filter(
    (e) => e.floor_eligible
  ).length;
  const needsReview = (board?.employees ?? []).filter(
    (e) => e.needs_review
  ).length;
  const absent = (board?.employees ?? []).filter(
    (e) => e.status === 'absent'
  ).length;
  const late = (board?.employees ?? []).filter(
    (e) => e.arrival === 'late'
  ).length;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-[#2F6B45]" />
            <h2 className="font-display font-semibold text-[15px] text-[#17221B] tracking-tight">
              Attendance — {date}
              {board?.is_today ? ' (today)' : ''}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="px-2 py-1.5 rounded-[7px] border border-[#E9E4DA] text-[13px] text-[#17221B] focus:outline-none focus:border-[#2F6B45]"
            />
            <button
              onClick={() => void load()}
              className="p-1.5 rounded-[7px] text-[#66706A] hover:bg-[#F1EEE7] transition-colors cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {status === 'loading' && (
          <div className="space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {status === 'error' && (
          <p className="text-xs text-[#A82828]">{error}</p>
        )}

        {status === 'ready' && board && (
          <>
            {/* Metric strip */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-[11px] font-semibold px-2 py-1 rounded-[7px] bg-[#E7F0E9] text-[#2F6B45]">
                {onFloor} on floor
              </span>
              <span className="text-[11px] font-semibold px-2 py-1 rounded-[7px] bg-[#FDE8E8] text-[#A82828]">
                {absent} absent
              </span>
              <span className="text-[11px] font-semibold px-2 py-1 rounded-[7px] bg-[#FFF3E4] text-[#C98232]">
                {late} late
              </span>
              {needsReview > 0 && (
                <span className="text-[11px] font-semibold px-2 py-1 rounded-[7px] bg-[#FDE8E8] text-[#A82828] inline-flex items-center gap-1">
                  <TriangleAlert className="w-3 h-3" />
                  {needsReview} need review
                </span>
              )}
              <span className="text-[11px] text-[#8A918C] ml-auto">
                Op-day starts {board.operational_day_start} IST
              </span>
            </div>

            {board.employees.length === 0 ? (
              <p className="text-xs text-[#66706A] py-3">
                No employees at this property.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[10px] font-semibold uppercase tracking-wider text-[#8A918C] border-b border-[#EFECE4]">
                      <th className="pb-2 pr-3">Employee</th>
                      <th className="pb-2 pr-3">Shift</th>
                      <th className="pb-2 pr-3">Status</th>
                      <th className="pb-2 pr-3">In</th>
                      <th className="pb-2 pr-3">Out</th>
                      <th className="pb-2">Flags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#EFECE4]">
                    {board.employees.map((e) => (
                      <tr key={e.employee_uid}>
                        <td className="py-2 pr-3">
                          <span className="text-[13px] font-medium text-[#17221B]">
                            {e.name}
                          </span>
                          {e.needs_review && (
                            <TriangleAlert className="inline w-3 h-3 text-[#A82828] ml-1 -mt-0.5" />
                          )}
                        </td>
                        <td className="py-2 pr-3 text-[12px] text-[#66706A]">
                          {e.shift_name ? (
                            <>
                              {e.shift_name}{' '}
                              <span className="text-[#8A918C]">
                                ({fmtWindow(e)})
                              </span>
                            </>
                          ) : (
                            <span className="text-[#8A918C]">
                              {fmtWindow(e)}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge size="sm" variant={STATUS_TONE[e.status]}>
                            {e.label}
                          </Badge>
                          {e.unscheduled && e.started_at && (
                            <span className="block text-[10px] text-[#C98232] mt-0.5">
                              unscheduled clock-in
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-[12px] tabular-nums text-[#17221B]">
                          {fmtTime(e.started_at)}
                        </td>
                        <td className="py-2 pr-3 text-[12px] tabular-nums text-[#17221B]">
                          {fmtTime(e.ended_at)}
                        </td>
                        <td className="py-2 space-x-1">
                          {e.arrival === 'late' && (
                            <Flag label="Late" tone="red" />
                          )}
                          {e.arrival === 'on_time' && (
                            <Flag label="On time" tone="sage" />
                          )}
                          {e.departure === 'early' && (
                            <Flag label="Early exit" tone="red" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
};
