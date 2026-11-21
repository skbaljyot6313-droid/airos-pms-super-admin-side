import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarCheck, CalendarDays, ClipboardCheck, History, LayoutTemplate, OctagonX, Plus, Sunrise, Wrench } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { CreateTaskModal } from './CreateTaskModal';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { TodayTasksView } from './TodayTasksView';
import { TaskHistoryView } from './TaskHistoryView';
import { TaskCalendarView } from './TaskCalendarView';
import { AbandonedTodayView } from './AbandonedTodayView';
import { TaskReviewPanel } from './TaskReviewPanel';
import { MaintenanceView } from '../maintenance/MaintenanceView';
import { TemplatesView } from '../templates/TemplatesView';
import { BackButton } from '../ui/BackButton';
import { Task } from '../../types';

/**
 * Task workspace — two fundamentally different views:
 *
 *   Today's Tasks = "what work is supposed to happen today"
 *     (generated instances + scheduled template occurrences not yet generated)
 *   Task History  = "what actual task instances have been generated"
 *     (the tasks table — nothing appears here before it exists as a task)
 */
type TasksTab = 'today' | 'abandoned' | 'review' | 'maintenance' | 'templates' | 'history' | 'calendar';

const tabFromParams = (sp: URLSearchParams): TasksTab => {
  const v = sp.get('tab');
  if (v === 'maintenance' || sp.get('ticket')) return 'maintenance';
  if (v === 'review' || v === 'templates' || v === 'abandoned' || v === 'history' || v === 'calendar') return v;
  return 'today';
};

export const TasksView: React.FC = () => {
  const {
    currentPropertyTasks, currentUser, canDo, deleteTask, activePropertyUid,
    activeProperty, freshDay,
  } = useApp();

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TasksTab>(() => tabFromParams(searchParams));

  // The sidebar and other links change ?tab= while this component stays
  // mounted — keep the active tab in sync with the URL.
  useEffect(() => {
    setTab((prev) => {
      const next = tabFromParams(searchParams);
      return prev === next ? prev : next;
    });
  }, [searchParams]);
  const isStaff = currentUser?.role === 'super_admin' || currentUser?.role === 'property_manager';
  const [selectedTaskUid, setSelectedTaskUid] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);
  const [freshDayOpen, setFreshDayOpen] = useState(false);
  const [freshDayBusy, setFreshDayBusy] = useState(false);

  const selectedTask =
    currentPropertyTasks.find((t) => t.task_uid === selectedTaskUid) || null;
  const canCreate = canDo('create', 'tasks') && currentUser?.role !== 'employee';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="mb-2">
            <BackButton to={`/property/${activePropertyUid}/overview`} />
          </div>
          <h1 className="font-display font-bold text-2xl sm:text-[28px] text-[#0D1C42] tracking-tight">
            Tasks
          </h1>
          <p className="font-body text-sm text-[#667085] mt-1">
            Today's operational schedule and generated work history
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {isStaff && (
            <Button
              variant="outline"
              onClick={() => setFreshDayOpen(true)}
              disabled={freshDayBusy}
              className="gap-2"
            >
              <Sunrise className="w-4 h-4" />
              <span>{freshDayBusy ? 'Resetting…' : 'Fresh Day'}</span>
            </Button>
          )}
          {canCreate && (
            <Button
              variant="primary"
              onClick={() => {
                setEditingTask(null);
                setCreateOpen(true);
              }}
              className="gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>Add Task</span>
            </Button>
          )}
        </div>
      </div>

      {/* Section nav — Today's schedule vs pending review vs history */}
      <div className="flex items-center gap-1 bg-[#F6F4F2] rounded-[12px] p-1 w-fit border border-[#E7E5E4]">
        {([
          { v: 'today' as const, l: "Today's Tasks", icon: CalendarCheck },
          { v: 'abandoned' as const, l: "Today's Abandoned", icon: OctagonX },
          { v: 'review' as const, l: 'Review', icon: ClipboardCheck },
          { v: 'maintenance' as const, l: 'Maintenance', icon: Wrench },
          { v: 'templates' as const, l: 'Templates', icon: LayoutTemplate },
          { v: 'history' as const, l: 'Task History', icon: History },
          ...(isStaff ? [{ v: 'calendar' as const, l: 'Calendar', icon: CalendarDays }] : []),
        ]).map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.v}
              onClick={() => {
                setTab(t.v);
                setSearchParams((prev) => {
                  const q = new URLSearchParams(prev);
                  q.set('tab', t.v);
                  return q;
                });
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-[9px] text-[13px] font-semibold transition-all cursor-pointer ${
                tab === t.v
                  ? 'bg-[#800020] text-white shadow-sm'
                  : 'text-[#667085] hover:text-[#0D1C42] hover:bg-white/60'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.l}
            </button>
          );
        })}
      </div>

      {tab === 'today' ? (
        <TodayTasksView onOpenTask={setSelectedTaskUid} />
      ) : tab === 'abandoned' ? (
        <AbandonedTodayView onOpenTask={setSelectedTaskUid} />
      ) : tab === 'review' ? (
        <TaskReviewPanel onOpenTask={setSelectedTaskUid} />
      ) : tab === 'maintenance' ? (
        <MaintenanceView embedded />
      ) : tab === 'templates' ? (
        <TemplatesView />
      ) : tab === 'calendar' ? (
        <TaskCalendarView />
      ) : (
        <TaskHistoryView onOpenTask={setSelectedTaskUid} />
      )}

      <TaskDetailDrawer
        task={selectedTask}
        onClose={() => setSelectedTaskUid(null)}
      />
      <CreateTaskModal
        isOpen={createOpen || !!editingTask}
        onClose={() => {
          setCreateOpen(false);
          setEditingTask(null);
        }}
        editTask={editingTask}
      />
      <ConfirmationDialog
        isOpen={freshDayOpen}
        onClose={() => setFreshDayOpen(false)}
        onConfirm={() => {
          setFreshDayBusy(true);
          void freshDay()
            .catch(() => {})
            .finally(() => setFreshDayBusy(false));
        }}
        entityType="Day"
        entityName={activeProperty?.name || ''}
        title="Start a fresh day?"
        warningTitle="This resets the entire work schedule."
        impactMessage="Every open task — pending, assigned, in progress, scheduled, or awaiting review — will be abandoned. Units under cleaning (or maintenance with no open ticket) will be released to Available. Occupied units stay occupied; open maintenance tickets keep their hold."
        promptMessage={`Are you sure you want to start a fresh day at ${activeProperty?.name ?? 'this property'}?`}
        confirmLabel="Start Fresh Day"
      />
      <ConfirmationDialog
        isOpen={!!deletingTask}
        onClose={() => setDeletingTask(null)}
        onConfirm={() => {
          if (deletingTask) deleteTask(deletingTask.task_uid);
        }}
        entityType="Task"
        entityName={deletingTask?.title || ''}
        impactMessage="The task and its full history — including any photo evidence — will be permanently removed."
      />
    </div>
  );
};

export default TasksView;
