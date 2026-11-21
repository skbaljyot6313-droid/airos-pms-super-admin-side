import React, { useMemo } from 'react';
import { ActivityLog } from '../../api/logs';
import { ActivityGroup, groupActivity, timelineDateLabel, timelineDay } from '../../lib/activityLogs';
import { ActivityRow } from './ActivityEvent';

interface Props {
  events: ActivityLog[];
  grouped: boolean;
  propertyIds: string[];
  onOpenTask?: (id: string) => void;
}

export function ActivityTimeline({ events, grouped, propertyIds, onOpenTask }: Props) {
  const days = useMemo(() => {
    const result = new Map<string, ActivityGroup[]>();
    for (const group of groupActivity(events, grouped)) {
      const key = timelineDay(group.events[0].occurred_at);
      const day = result.get(key) || [];
      day.push(group);
      result.set(key, day);
    }
    return [...result.entries()];
  }, [events, grouped]);
  return <div role="region" aria-label="Activity timeline" className="pb-4">
    {days.map(([key, groups]) => <section key={key}>
      <h2 className="sticky top-0 z-10 border-y border-[#C3D6F0] bg-[#FFFFFF] px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-[#667085]">{timelineDateLabel(groups[0].events[0].occurred_at)}</h2>
      <ol aria-label={`Events on ${key}`}>
        {groups.map((group) => <ActivityRow key={group.id} events={group.events}
          workspaceAvailable={!!group.events[0].property_uid && propertyIds.includes(group.events[0].property_uid)} onOpenTask={onOpenTask} />)}
      </ol>
    </section>)}
  </div>;
}
