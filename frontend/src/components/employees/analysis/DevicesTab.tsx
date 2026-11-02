import React, { useEffect, useRef, useState } from 'react';
import { MonitorSmartphone, MapPin } from 'lucide-react';
import { EmployeeDevices, getEmployeeDevices } from '../../../api/employees';
import { fmtDateTimeIST } from '../../../lib/datetime';
import { readable } from '../../../lib/activityLogs';
import { Panel, BlockLoading, BlockFailure, Empty, C } from './kit';

const Field = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex justify-between gap-3 py-1 text-[11px]">
    <dt className="text-[#697586]">{label}</dt>
    <dd className="text-right font-medium text-[#17212B]">{value ?? 'Not available'}</dd>
  </div>);

export function DevicesTab({ employeeId, propertyId }: { employeeId: string; propertyId: string }) {
  const [data, setData] = useState<EmployeeDevices | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useRef(0);
  useEffect(() => {
    const rid = ++id.current;
    setLoading(true); setError(false);
    void getEmployeeDevices(employeeId, propertyId)
      .then((d) => { if (rid === id.current) setData(d); })
      .catch(() => { if (rid === id.current) setError(true); })
      .finally(() => { if (rid === id.current) setLoading(false); });
    return () => { id.current += 1; };
  }, [employeeId, propertyId, retry]);

  return <Panel title="App & device diagnostics"
    note="Point-in-time registration data from the shared employee-app tables — not affected by the reporting period. Push tokens and credentials are never shown; a missing record never implies a failed device.">
    {loading ? <BlockLoading label="Loading device diagnostics" />
      : error ? <BlockFailure msg="Unable to load device diagnostics." retry={() => setRetry((v) => v + 1)} />
      : !data ? null
      : data.available === false ? <Empty msg="Device tables are not available in this environment (shared employee-app schema not present)." />
      : <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#697586]"><MonitorSmartphone size={12} /> Registered devices</h3>
          {!data.devices.length ? <Empty msg="No registered devices for this employee." />
            : <ul className="mt-2 space-y-2">{data.devices.map((d) => (
              <li key={d.device_id} className="rounded-md border border-[#E9EDF2] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#17212B]">{d.platform || 'unknown'}{d.app_version ? ` · v${d.app_version}` : ''}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${d.is_active ? 'bg-[#EAF6F0] text-[#169B72]' : 'bg-[#F1F3F6] text-[#697586]'}`}>{d.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                <dl className="mt-1 divide-y divide-[#F1F3F6]">
                  <Field label="Device" value={<span className="font-mono text-[10px]">{d.device_id}</span>} />
                  <Field label="Registered" value={d.registered_at ? fmtDateTimeIST(d.registered_at) : null} />
                  <Field label="Last seen" value={d.last_seen_at ? fmtDateTimeIST(d.last_seen_at) : null} />
                </dl>
              </li>))}
            </ul>}
          {data.latest_release && <p className="mt-2 text-[10px] text-[#697586]">
            Latest published release: {data.latest_release.platform} v{data.latest_release.version}{data.latest_release.force_update ? ' (mandatory update)' : ''}
          </p>}
        </div>
        <div>
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#697586]"><MapPin size={12} /> Location tracking</h3>
          <dl className="mt-2 divide-y divide-[#F1F3F6] rounded-md border border-[#E9EDF2] px-3 py-1">
            <Field label="Tracking sessions" value={data.tracking.sessions} />
            <Field label="Session active now" value={data.tracking.active_session ? 'Yes' : 'No'} />
            <Field label="Last session started" value={data.tracking.last_session_started ? fmtDateTimeIST(data.tracking.last_session_started) : null} />
            <Field label="Last session ended" value={data.tracking.last_session_ended ? fmtDateTimeIST(data.tracking.last_session_ended) : null} />
            <Field label="Last recorded location event" value={data.tracking.last_event_at ? fmtDateTimeIST(data.tracking.last_event_at) : null} />
            <Field label="Event source" value={data.tracking.last_event_source ? readable(data.tracking.last_event_source) : null} />
          </dl>
          <p className="mt-2 text-[10px] leading-relaxed text-[#697586]">
            Precise coordinates are never displayed here. Activity timestamps describe recorded events only — absence of events is unavailability of data, not device failure.
          </p>
        </div>
      </div>}
  </Panel>;
}
