import React, { useCallback, useEffect, useState } from 'react';
import { CalendarOff, Check, RefreshCw, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { ApiError } from '../../api/client';
import {
  attendanceApi,
  type AttendanceRequest,
  type AttendanceRequestStatus,
} from '../../api/attendance';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';

const LEAVE_TYPE_LABELS: Record<string, string> = {
  casual_leave: 'Casual Leave',
  sick_leave: 'Sick Leave',
  paid_leave: 'Paid Leave',
  unpaid_leave: 'Unpaid Leave',
  other: 'Other',
};

const STATUS_TONE: Record<
  AttendanceRequestStatus,
  'sage' | 'orange' | 'red' | 'neutral'
> = {
  pending: 'orange',
  approved: 'sage',
  rejected: 'red',
  cancelled: 'neutral',
};

const formatRange = (r: AttendanceRequest) =>
  r.from_date === r.to_date
    ? r.from_date
    : `${r.from_date} → ${r.to_date}`;

export const LeavesPanel: React.FC = () => {
  const { currentUser } = useApp();
  const isStaff = currentUser?.role === 'super_admin' || currentUser?.role === 'property_manager';

  const [requests, setRequests] = useState<AttendanceRequest[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [commentFor, setCommentFor] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await attendanceApi.listRequests();
      setRequests(res?.items ?? []);
      setError(null);
      setStatus('ready');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load requests.'
      );
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (
    r: AttendanceRequest,
    approve: boolean
  ) => {
    setDeciding(r.request_uid);
    setActionError(null);
    try {
      const updated = approve
        ? await attendanceApi.approve(r.request_uid, comment || undefined)
        : await attendanceApi.reject(r.request_uid, comment || undefined);
      setRequests((prev) =>
        prev.map((x) => (x.request_uid === updated.request_uid ? updated : x))
      );
      setCommentFor(null);
      setComment('');
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : 'The decision failed.'
      );
    } finally {
      setDeciding(null);
    }
  };

  if (!isStaff) {
    return (
      <Card className="p-6 text-sm text-[#66706A]">
        Leave decisions are restricted to supervisory staff.
      </Card>
    );
  }

  const pending = requests.filter((r) => r.status === 'pending');
  const decided = requests.filter((r) => r.status !== 'pending');
  const visible = showDecided ? decided : pending;

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#EDEAE2]">
        <div className="flex items-center gap-2">
          <CalendarOff className="w-4 h-4 text-[#2F6B45]" />
          <h3 className="font-display font-semibold text-sm text-[#17221B]">
            Leave Requests
          </h3>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] bg-[#FFF3E4] text-[#C98232]">
            {pending.length} pending
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDecided((v) => !v)}
            className="text-[11px] font-semibold text-[#66706A] hover:text-[#17221B] cursor-pointer"
          >
            {showDecided ? 'Show pending' : `History (${decided.length})`}
          </button>
          <button
            onClick={() => void load()}
            className="p-1.5 rounded-[6px] text-[#66706A] hover:text-[#17221B] hover:bg-[#F1EEE7] cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {actionError && (
        <div className="mx-4 mt-3 bg-[#FDE8E8] border border-[#F2C9C9] rounded-[8px] px-3 py-2 text-[11px] text-[#A82828]">
          {actionError}
        </div>
      )}

      {status === 'loading' ? (
        <div className="p-4 space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : status === 'error' ? (
        <div className="p-6 text-center">
          <p className="text-xs text-[#B33A3A]">{error}</p>
          <Button variant="ghost" onClick={() => void load()} className="mt-2">
            Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="p-8 text-center text-xs text-[#8A918C]">
          {showDecided
            ? 'No decided requests yet.'
            : 'No pending leave requests.'}
        </div>
      ) : (
        <div className="divide-y divide-[#F4F1EA]">
          {visible.map((r) => (
            <div key={r.request_uid} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-xs font-semibold text-[#17221B]">
                      {r.employee_name}
                    </p>
                    <Badge
                      variant={STATUS_TONE[r.status]}
                      size="sm"
                    >
                      {r.status}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-[#66706A] mt-0.5">
                    {r.request_type === 'leave'
                      ? LEAVE_TYPE_LABELS[r.leave_type ?? ''] ?? 'Leave'
                      : 'Week Off'}
                    {' · '}
                    {formatRange(r)}
                    {' · '}
                    {r.requested_days} day{r.requested_days === 1 ? '' : 's'}
                  </p>
                  {r.reason && (
                    <p className="text-[11px] text-[#8A918C] mt-0.5 italic">
                      “{r.reason}”
                    </p>
                  )}
                  {r.review_comment && (
                    <p className="text-[11px] text-[#8A918C] mt-0.5">
                      {r.reviewed_by}: “{r.review_comment}”
                    </p>
                  )}
                </div>

                {r.status === 'pending' && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="primary"
                      onClick={() => void decide(r, true)}
                      disabled={deciding !== null}
                      className="gap-1 !rounded-[7px] !px-2.5 !py-1.5 text-[11px] !bg-[#2F6B45] hover:!bg-[#245538]"
                    >
                      <Check className="w-3.5 h-3.5" /> Approve
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void decide(r, false)}
                      disabled={deciding !== null}
                      className="gap-1 !rounded-[7px] !px-2.5 !py-1.5 text-[11px] !text-[#A82828] hover:!bg-[#FDE8E8]"
                    >
                      <X className="w-3.5 h-3.5" /> Reject
                    </Button>
                    <button
                      onClick={() =>
                        setCommentFor(
                          commentFor === r.request_uid ? null : r.request_uid
                        )
                      }
                      className="text-[10px] text-[#66706A] underline cursor-pointer"
                    >
                      note
                    </button>
                  </div>
                )}
              </div>
              {commentFor === r.request_uid && r.status === 'pending' && (
                <input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Optional review note…"
                  className="mt-2 w-full bg-[#FAF8F5] border border-[#DDD7CB] rounded-[8px] px-2.5 py-1.5 text-xs focus:outline-none"
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};
