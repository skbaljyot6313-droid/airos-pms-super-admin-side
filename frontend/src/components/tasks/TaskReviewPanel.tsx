import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock, ImageIcon, RefreshCw, RotateCcw,
  ThumbsDown, ThumbsUp,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { usePolling } from '../../hooks/usePolling';
import { mediaUrl } from '../../api/client';
import * as tasksApi from '../../api/tasks';
import { Task, TaskCompletionImage } from '../../types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CompletionEvidenceLightbox, EvidenceImage } from './CompletionEvidenceLightbox';
import { fmtDateTimeIST } from '../../lib/datetime';

const inputCls =
  'px-3 py-2 text-sm bg-white border border-[#E2DCD0] rounded-[10px] ' +
  'focus:outline-none focus:ring-[3px] focus:ring-[#386641]/15 focus:border-[#386641]';

function taskLabel(t: Task): string {
  return t.room_number || t.dorm_name || t.washroom_name || '—';
}

/** Flatten every image across a task's submissions so all evidence shows
 * in one container — newest submission first. */
function allEvidence(t: Task): TaskCompletionImage[] {
  const subs = [...(t.completion_submissions || [])].sort(
    (a, b) => (b.attempt_number || 0) - (a.attempt_number || 0)
  );
  return subs.flatMap((s) => s.images || []);
}

interface Props {
  onOpenTask: (taskUid: string) => void;
}

export const TaskReviewPanel: React.FC<Props> = ({ onOpenTask }) => {
  const { activePropertyUid, addToast } = useApp();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [noteByTask, setNoteByTask] = useState<Record<string, string>>({});
  const [confirmReject, setConfirmReject] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{
    task: Task; index: number;
  } | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!activePropertyUid) return;
    if (!quiet) setLoading(true);
    try {
      setTasks(await tasksApi.taskReviewQueue(activePropertyUid));
      setError(null);
    } catch {
      if (!quiet) setError('Could not load the review queue.');
    } finally {
      setLoading(false);
    }
  }, [activePropertyUid]);

  useEffect(() => {
    load();
  }, [load]);
  usePolling(() => load(true), 30000, !!activePropertyUid, 'task-review');

  const decide = async (task: Task, approve: boolean) => {
    const note = (noteByTask[task.task_uid] || '').trim() || undefined;
    if (!approve && !note) {
      setConfirmReject(task.task_uid);
      return;
    }
    setBusyUid(task.task_uid);
    setConfirmReject(null);
    try {
      if (approve) {
        await tasksApi.approveTask(task.task_uid, note);
        addToast({ type: 'success', title: 'Submission Approved', description: task.title });
      } else {
        await tasksApi.rejectTask(task.task_uid, note);
        addToast({ type: 'success', title: 'Submission Sent Back', description: task.title });
      }
      await load(true);
    } catch (e) {
      addToast({
        type: 'error',
        title: approve ? 'Approve Failed' : 'Reject Failed',
        description: e instanceof Error ? e.message : 'Request failed',
      });
    } finally {
      setBusyUid(null);
    }
  };

  const lightboxImages = useMemo<EvidenceImage[]>(
    () =>
      lightbox
        ? allEvidence(lightbox.task).map((i) => ({
            image_uid: i.image_uid,
            url: i.url,
          }))
        : [],
    [lightbox]
  );

  if (loading && tasks.length === 0) {
    return (
      <div className="space-y-4">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="animate-pulse bg-white border border-[#E9E4D8] rounded-[16px] h-44"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white border border-[#E9E4D8] rounded-[16px] p-8 flex flex-col items-center gap-3 text-center">
        <AlertTriangle className="w-8 h-8 text-[#B4530A]" />
        <p className="text-sm text-[#6C675F]">{error}</p>
        <Button variant="secondary" onClick={() => load()} className="gap-2">
          <RefreshCw className="w-4 h-4" /> Retry
        </Button>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="bg-white border border-[#E9E4D8] rounded-[16px] p-10 flex flex-col items-center gap-3 text-center">
        <CheckCircle2 className="w-9 h-9 text-[#386641]" />
        <p className="font-semibold text-[#24221F]">Nothing awaiting review</p>
        <p className="text-sm text-[#6C675F]">
          Submitted work shows up here until it's approved or sent back.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {tasks.map((task) => {
        const images = allEvidence(task);
        const latest = (task.completion_submissions || [])
          .slice()
          .sort((a, b) => (b.attempt_number || 0) - (a.attempt_number || 0))[0];
        const submitNote = (task.history || [])
          .slice()
          .reverse()
          .find((h) => h.type === 'submitted')?.note;
        const busy = busyUid === task.task_uid;
        const rejecting = confirmReject === task.task_uid;
        return (
          <div
            key={task.task_uid}
            className="bg-white border border-[#E9E4D8] rounded-[16px] p-5 shadow-sm"
          >
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-[#24221F] text-[15px] truncate">
                    {task.title}
                  </h3>
                  {task.ticket_number && (
                    <span className="text-[11px] font-mono text-[#8A8478]">
                      {task.ticket_number}
                    </span>
                  )}
                  <Badge size="sm" variant="orange">Awaiting review</Badge>
                </div>
                <div className="flex items-center gap-3 mt-1.5 text-[12px] text-[#6C675F] flex-wrap">
                  <span>{taskLabel(task)}</span>
                  {task.assigned_to_name && (
                    <span>by {task.assigned_to_name}</span>
                  )}
                  {task.submitted_at && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {fmtDateTimeIST(task.submitted_at)}
                    </span>
                  )}
                  {(task.completion_submissions?.length || 0) > 1 && (
                    <span className="flex items-center gap-1">
                      <RotateCcw className="w-3.5 h-3.5" />
                      attempt #{latest?.attempt_number}
                    </span>
                  )}
                </div>
                {submitNote && (
                  <p className="mt-2 text-[13px] text-[#6C675F] italic">
                    "{submitNote}"
                  </p>
                )}
              </div>
              <button
                onClick={() => onOpenTask(task.task_uid)}
                className="self-start text-[12px] font-semibold text-[#386641] hover:underline cursor-pointer"
              >
                Full details
              </button>
            </div>

            {/* All evidence images in one container */}
            <div className="mt-4 bg-[#F7F5F0] border border-[#E9E4D8] rounded-[12px] p-3">
              <div className="flex items-center gap-2 mb-2.5">
                <ImageIcon className="w-4 h-4 text-[#6C675F]" />
                <span className="text-[12px] font-semibold text-[#6C675F] uppercase tracking-wide">
                  Evidence · {images.length} image{images.length === 1 ? '' : 's'}
                </span>
              </div>
              {images.length === 0 ? (
                <p className="text-[13px] text-[#8A8478] py-2">
                  No photos were submitted with this task.
                </p>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {images.map((img, i) => (
                    <button
                      key={img.image_uid || i}
                      onClick={() => setLightbox({ task, index: i })}
                      className="shrink-0 w-24 h-24 rounded-[10px] overflow-hidden border border-[#E2DCD0] bg-white hover:border-[#386641] transition-colors cursor-pointer"
                    >
                      <img
                        src={mediaUrl(img.url)}
                        alt={`Evidence ${i + 1}`}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Decision row */}
            <div className="mt-4 flex flex-col sm:flex-row gap-3 sm:items-center">
              <input
                className={`${inputCls} flex-1`}
                placeholder="Review note (required to send back)"
                value={noteByTask[task.task_uid] || ''}
                onChange={(e) =>
                  setNoteByTask((m) => ({
                    ...m,
                    [task.task_uid]: e.target.value,
                  }))
                }
                disabled={busy}
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => decide(task, true)}
                  className="gap-2"
                >
                  <ThumbsUp className="w-4 h-4" />
                  {busy ? 'Working…' : 'Approve'}
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => decide(task, false)}
                  className="gap-2"
                >
                  <ThumbsDown className="w-4 h-4" />
                  {busy ? 'Working…' : 'Send Back'}
                </Button>
              </div>
            </div>

            {rejecting && (
              <div className="mt-3 flex items-center justify-between gap-3 bg-[#FDF0E8] border border-[#F0D9C4] rounded-[10px] px-3 py-2.5">
                <p className="text-[13px] text-[#7C4A21]">
                  Send back without a reason? The assignee sees the task reopened.
                </p>
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm" variant="destructive" disabled={busy}
                    onClick={() => {
                      setConfirmReject(null);
                      const t = tasks.find((x) => x.task_uid === task.task_uid);
                      if (t) {
                        setBusyUid(t.task_uid);
                        tasksApi
                          .rejectTask(t.task_uid, undefined)
                          .then(() => load(true))
                          .catch(() =>
                            addToast({ type: 'error', title: 'Reject Failed' })
                          )
                          .finally(() => setBusyUid(null));
                      }
                    }}
                  >
                    Send back anyway
                  </Button>
                  <Button
                    size="sm" variant="secondary"
                    onClick={() => setConfirmReject(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {lightbox && (
        <CompletionEvidenceLightbox
          images={lightboxImages}
          initialIndex={lightbox.index}
          title={lightbox.task.title}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
};

export default TaskReviewPanel;
