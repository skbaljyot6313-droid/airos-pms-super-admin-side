import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Video,
  Wifi,
  X,
} from 'lucide-react';
import {
  VaCamera,
  VaCameraPayload,
  bulkMoveVaCameras,
  createVaCamera,
  deleteVaCamera,
  listVaCameras,
  testVaCameraConnection,
  updateVaCamera,
} from '../../api/va';
import { useApp } from '../../context/AppContext';

const STATUS_STYLE: Record<VaCamera['connection_status'], string> = {
  online: 'bg-emerald-100 text-emerald-700',
  offline: 'bg-red-100 text-red-700',
  error: 'bg-amber-100 text-amber-700',
  unknown: 'bg-[#EFECE5] text-[#8C867C]',
};

const emptyForm = (): VaCameraPayload => ({
  name: '',
  description: '',
  zone_uid: null,
  area_uid: null,
  rtsp_url: '',
  sub_rtsp_url: '',
  transcode: null,
  warm: false,
  location: '',
  username: '',
  password: '',
  transport: 'tcp',
  resolution: '',
  fps: null,
  is_enabled: true,
});

const Field: React.FC<{
  label: string;
  children: React.ReactNode;
  required?: boolean;
}> = ({ label, children, required }) => (
  <label className="block">
    <span className="text-[11.5px] font-medium text-[#58534C]">
      {label}
      {required && <span className="text-red-500"> *</span>}
    </span>
    {children}
  </label>
);

const inputCls =
  'mt-1 w-full px-3 py-2 rounded-lg border border-[#EAE5DC] bg-white text-[13px] outline-none focus:border-[#386641]';

export const VaCameraSettings: React.FC<{ propertyUid: string }> = ({
  propertyUid,
}) => {
  const { addToast, areas, zones } = useApp();
  const [cameras, setCameras] = useState<VaCamera[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [fSection, setFSection] = useState('all');
  const [fStatus, setFStatus] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<'add' | 'edit' | 'delete' | null>(null);
  const [editing, setEditing] = useState<VaCamera | null>(null);
  const [form, setForm] = useState<VaCameraPayload>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cams = await listVaCameras(propertyUid);
      setCameras(cams);
    } catch (e) {
      addToast({ type: 'error', title: e instanceof Error ? e.message : 'Failed to load' });
    } finally {
      setLoading(false);
    }
  }, [propertyUid, addToast]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () =>
      cameras.filter((c) => {
        if (fSection === 'unassigned' && (c.zone_uid || c.area_uid))
          return false;
        if (fSection.startsWith('zone:') && c.zone_uid !== fSection.slice(5))
          return false;
        if (fSection.startsWith('area:') && c.area_uid !== fSection.slice(5))
          return false;
        if (fSection !== 'all' && !fSection.includes(':') && fSection !== 'unassigned')
          return false;
        if (fStatus !== 'all' && c.connection_status !== fStatus) return false;
        if (
          search &&
          !`${c.name} ${c.camera_uid}`.toLowerCase().includes(search.toLowerCase())
        )
          return false;
        return true;
      }),
    [cameras, fSection, fStatus, search]
  );

  const openEdit = (c: VaCamera) => {
    setEditing(c);
    setForm({
      name: c.name,
      description: c.description ?? '',
      zone_uid: c.zone_uid,
      area_uid: c.area_uid,
      rtsp_url: c.rtsp_url_masked, // masked — backend keeps stored URL when unchanged
      sub_rtsp_url: c.sub_rtsp_url_masked ?? '',
      transcode: c.transcode,
      warm: c.warm ?? false,
      location: c.location ?? '',
      username: c.username ?? '',
      password: '',
      transport: c.transport,
      resolution: c.resolution ?? '',
      fps: c.fps,
      is_enabled: c.is_enabled,
    });
    setModal('edit');
  };

  const submitCamera = async () => {
    setSaving(true);
    try {
      const body: VaCameraPayload = { ...form };
      if (modal === 'edit' && editing) {
        // Never send the masked URL or an empty password back.
        if (body.rtsp_url === editing.rtsp_url_masked)
          delete body.rtsp_url;
        if (body.sub_rtsp_url === editing.sub_rtsp_url_masked)
          delete body.sub_rtsp_url;
        if (!body.password) delete body.password;
        await updateVaCamera(propertyUid, editing.camera_uid, body);
        addToast({ type: 'success', title: 'Camera updated' });
      } else {
        await createVaCamera(propertyUid, body);
        addToast({ type: 'success', title: 'Camera added' });
      }
      setModal(null);
      await load();
    } catch (e) {
      addToast({ type: 'error', title: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await deleteVaCamera(propertyUid, editing.camera_uid);
      addToast({ type: 'success', title: `Camera "${editing.name}" deleted` });
      setModal(null);
      setEditing(null);
      await load();
    } catch (e) {
      addToast({ type: 'error', title: e instanceof Error ? e.message : 'Delete failed' });
    } finally {
      setSaving(false);
    }
  };

  const doTest = async (c: VaCamera) => {
    setTesting(c.camera_uid);
    try {
      const r = await testVaCameraConnection(propertyUid, c.camera_uid);
      addToast({ type: r.tcp_reachable ? 'success' : 'error', title: r.tcp_reachable
          ? `${c.name}: host reachable${r.media_server_ready ? ' + stream ready' : ''}`
          : `${c.name}: unreachable` });
      await load();
    } catch (e) {
      addToast({ type: 'error', title: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setTesting(null);
    }
  };

  const doBulkMove = async () => {
    if (selected.size === 0) return;
    try {
      const r = await bulkMoveVaCameras(propertyUid, [...selected], {
        zoneUid: moveTo.startsWith('zone:') ? moveTo.slice(5) : null,
        areaUid: moveTo.startsWith('area:') ? moveTo.slice(5) : null,
      });
      addToast({ type: 'success', title: `Moved ${r.moved} camera(s)` });
      setSelected(new Set());
      await load();
    } catch (e) {
      addToast({ type: 'error', title: e instanceof Error ? e.message : 'Move failed' });
    }
  };

  const shortId = (uid: string) => uid.slice(0, 8);

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 pb-4">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#A39D92]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or ID…"
            className="pl-8 pr-3 py-2 rounded-lg border border-[#EAE5DC] bg-white text-[12.5px] w-52 outline-none focus:border-[#386641]"
          />
        </div>
        <select
          value={fSection}
          onChange={(e) => setFSection(e.target.value)}
          className="px-3 py-2 rounded-lg border border-[#EAE5DC] bg-white text-[12.5px]"
        >
          <option value="all">All zones &amp; areas</option>
          {areas.map((a) => (
            <optgroup key={a.area_uid} label={a.name}>
              <option value={`area:${a.area_uid}`}>Entire {a.name}</option>
              {zones
                .filter((z) => z.area_uid === a.area_uid)
                .map((z) => (
                  <option key={z.zone_uid} value={`zone:${z.zone_uid}`}>
                    {z.name}
                  </option>
                ))}
            </optgroup>
          ))}
          <option value="unassigned">Unassigned</option>
        </select>
        <select
          value={fStatus}
          onChange={(e) => setFStatus(e.target.value)}
          className="px-3 py-2 rounded-lg border border-[#EAE5DC] bg-white text-[12.5px]"
        >
          <option value="all">All statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="error">Error</option>
          <option value="unknown">Unknown</option>
        </select>
        {selected.size > 0 && (
          <div className="flex items-center gap-1.5">
            <select
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[#EAE5DC] bg-white text-[12.5px]"
            >
              <option value="">Move to…</option>
              {areas.map((a) => (
                <optgroup key={a.area_uid} label={a.name}>
                  <option value={`area:${a.area_uid}`}>
                    Entire {a.name}
                  </option>
                  {zones
                    .filter((z) => z.area_uid === a.area_uid)
                    .map((z) => (
                      <option key={z.zone_uid} value={`zone:${z.zone_uid}`}>
                        {z.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            <button
              onClick={doBulkMove}
              disabled={!moveTo}
              className="px-3 py-2 rounded-lg bg-[#386641] text-white text-[12.5px] font-medium disabled:opacity-50"
            >
              Move {selected.size}
            </button>
          </div>
        )}
        <div className="flex-1" />
        <button
          onClick={() => {
            setEditing(null);
            setForm(emptyForm());
            setModal('add');
          }}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#386641] text-white text-[12.5px] font-medium hover:bg-[#2F5737]"
        >
          <Plus className="w-4 h-4" /> Add Camera
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-[#EAE5DC] bg-white overflow-hidden">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-[#FBFAF7] border-b border-[#EAE5DC] text-left text-[#8C867C] text-[11px] uppercase tracking-wide">
              <th className="px-3 py-2.5 w-8">
                <input
                  type="checkbox"
                  checked={
                    filtered.length > 0 &&
                    filtered.every((c) => selected.has(c.camera_uid))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? new Set(filtered.map((c) => c.camera_uid))
                        : new Set()
                    )
                  }
                />
              </th>
              <th className="px-3 py-2.5">Camera</th>
              <th className="px-3 py-2.5">ID</th>
              <th className="px-3 py-2.5">Section</th>
              <th className="px-3 py-2.5">Stream</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Last checked</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && cameras.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-[#A39D92]">
                  <Loader2 className="w-5 h-5 animate-spin inline" />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-[#A39D92]">
                  No cameras — click "Add Camera" to register one.
                </td>
              </tr>
            ) : (
              filtered.map((c) => (
                <tr
                  key={c.camera_uid}
                  className="border-b border-[#F0EDE6] last:border-0 hover:bg-[#FBFAF7]"
                >
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.has(c.camera_uid)}
                      onChange={(e) => {
                        const s = new Set(selected);
                        if (e.target.checked) s.add(c.camera_uid);
                        else s.delete(c.camera_uid);
                        setSelected(s);
                      }}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Video className="w-4 h-4 text-[#A39D92] flex-none" />
                      <div className="min-w-0">
                        <div className="font-medium text-[#1F1B16] truncate">
                          {c.name}
                          {!c.is_enabled && (
                            <span className="ml-1.5 text-[10px] text-[#A39D92]">
                              (disabled)
                            </span>
                          )}
                        </div>
                        {c.location && (
                          <div className="text-[11px] text-[#A39D92] truncate">
                            {c.location}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11.5px] text-[#8C867C]">
                    {shortId(c.camera_uid)}
                  </td>
                  <td className="px-3 py-2.5 text-[#58534C]">
                    {c.zone_name
                      ? `${c.area_name ? c.area_name + ' — ' : ''}${c.zone_name}`
                      : (c.area_name ?? '—')}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-[#8C867C]">
                    {c.rtsp_url_masked}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${STATUS_STYLE[c.connection_status]}`}
                    >
                      {c.connection_status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[#8C867C] text-[11.5px]">
                    {c.last_checked_at
                      ? new Date(c.last_checked_at).toLocaleTimeString()
                      : '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => doTest(c)}
                        title="Test connection"
                        className="p-1.5 rounded-md text-[#8C867C] hover:text-[#386641] hover:bg-[#EFECE5]"
                      >
                        {testing === c.camera_uid ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Wifi className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => openEdit(c)}
                        title="Edit"
                        className="p-1.5 rounded-md text-[#8C867C] hover:text-[#386641] hover:bg-[#EFECE5]"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          setEditing(c);
                          setModal('delete');
                        }}
                        title="Delete"
                        className="p-1.5 rounded-md text-[#8C867C] hover:text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add/Edit modal */}
      {(modal === 'add' || modal === 'edit') && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between pb-4">
              <h2 className="text-[15px] font-semibold text-[#1F1B16]">
                {modal === 'add' ? 'Add Camera' : `Edit — ${editing?.name}`}
              </h2>
              <button onClick={() => setModal(null)}>
                <X className="w-4.5 h-4.5 text-[#8C867C]" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Camera name" required>
                <input
                  className={inputCls}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Field>
              <Field label="Zone / Area" required>
                <select
                  className={inputCls}
                  value={
                    form.zone_uid
                      ? `zone:${form.zone_uid}`
                      : form.area_uid
                        ? `area:${form.area_uid}`
                        : ''
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm({
                      ...form,
                      zone_uid: v.startsWith('zone:') ? v.slice(5) : null,
                      area_uid: v.startsWith('area:') ? v.slice(5) : null,
                    });
                  }}
                >
                  <option value="">Select…</option>
                  {areas.map((a) => (
                    <optgroup key={a.area_uid} label={a.name}>
                      <option value={`area:${a.area_uid}`}>
                        Entire {a.name}
                      </option>
                      {zones
                        .filter((z) => z.area_uid === a.area_uid)
                        .map((z) => (
                          <option key={z.zone_uid} value={`zone:${z.zone_uid}`}>
                            {z.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                  {zones.filter((z) => !z.area_uid).length > 0 && (
                    <optgroup label="Other zones">
                      {zones
                        .filter((z) => !z.area_uid)
                        .map((z) => (
                          <option key={z.zone_uid} value={`zone:${z.zone_uid}`}>
                            {z.name}
                          </option>
                        ))}
                    </optgroup>
                  )}
                </select>
              </Field>
              <div className="col-span-2">
                <Field label="RTSP stream URL" required>
                  <input
                    className={`${inputCls} font-mono text-[12px]`}
                    placeholder="rtsp://192.168.1.100:554/stream1"
                    value={form.rtsp_url ?? ''}
                    onChange={(e) =>
                      setForm({ ...form, rtsp_url: e.target.value })
                    }
                  />
                </Field>
              </div>
              <div className="col-span-2">
                <Field label="Substream URL (optional — low-res feed for dense grids)">
                  <input
                    className={`${inputCls} font-mono text-[12px]`}
                    placeholder="rtsp://192.168.1.100:554/stream2"
                    value={form.sub_rtsp_url ?? ''}
                    onChange={(e) =>
                      setForm({ ...form, sub_rtsp_url: e.target.value })
                    }
                  />
                </Field>
              </div>
              <Field label="Transcoding">
                <select
                  className={inputCls}
                  value={
                    form.transcode === null || form.transcode === undefined
                      ? 'default'
                      : form.transcode
                        ? 'on'
                        : 'off'
                  }
                  onChange={(e) =>
                    setForm({
                      ...form,
                      transcode:
                        e.target.value === 'default'
                          ? null
                          : e.target.value === 'on',
                    })
                  }
                >
                  <option value="default">Default (passthrough)</option>
                  <option value="on">Transcode (H265 cameras)</option>
                  <option value="off">Force passthrough</option>
                </select>
              </Field>
              <Field label="Location">
                <input
                  className={inputCls}
                  value={form.location ?? ''}
                  onChange={(e) =>
                    setForm({ ...form, location: e.target.value })
                  }
                />
              </Field>
              <Field label="Transport">
                <select
                  className={inputCls}
                  value={form.transport}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      transport: e.target.value as 'tcp' | 'udp',
                    })
                  }
                >
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </select>
              </Field>
              <Field label="Username (optional)">
                <input
                  className={inputCls}
                  autoComplete="off"
                  value={form.username ?? ''}
                  onChange={(e) =>
                    setForm({ ...form, username: e.target.value })
                  }
                />
              </Field>
              <Field label="Password (optional)">
                <input
                  className={inputCls}
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    modal === 'edit' && editing?.has_credentials
                      ? '•••••• (unchanged)'
                      : ''
                  }
                  value={form.password ?? ''}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                />
              </Field>
              <Field label="Resolution">
                <input
                  className={inputCls}
                  placeholder="1920×1080"
                  value={form.resolution ?? ''}
                  onChange={(e) =>
                    setForm({ ...form, resolution: e.target.value })
                  }
                />
              </Field>
              <Field label="FPS">
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  max={120}
                  value={form.fps ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      fps: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </Field>
              <div className="col-span-2">
                <Field label="Description">
                  <input
                    className={inputCls}
                    value={form.description ?? ''}
                    onChange={(e) =>
                      setForm({ ...form, description: e.target.value })
                    }
                  />
                </Field>
              </div>
              <label className="col-span-2 flex items-center gap-2 text-[12.5px] text-[#58534C]">
                <input
                  type="checkbox"
                  checked={form.warm ?? false}
                  onChange={(e) =>
                    setForm({ ...form, warm: e.target.checked })
                  }
                />
                Keep stream warm — holds the upstream camera connection hot for
                near-instant first frame (bounded, costs one pull per camera)
              </label>
              <label className="col-span-2 flex items-center gap-2 text-[12.5px] text-[#58534C]">
                <input
                  type="checkbox"
                  checked={form.is_enabled}
                  onChange={(e) =>
                    setForm({ ...form, is_enabled: e.target.checked })
                  }
                />
                Enabled (available for streaming)
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-5">
              <button
                onClick={() => setModal(null)}
                className="px-4 py-2 rounded-lg border border-[#EAE5DC] text-[12.5px] text-[#58534C]"
              >
                Cancel
              </button>
              <button
                onClick={submitCamera}
                disabled={
                  saving ||
                  !form.name ||
                  (modal === 'add' && !form.rtsp_url)
                }
                className="px-4 py-2 rounded-lg bg-[#386641] text-white text-[12.5px] font-medium disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {modal === 'add' ? 'Add camera' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {modal === 'delete' && editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6">
            <h2 className="text-[15px] font-semibold text-[#1F1B16] pb-2">
              Delete camera?
            </h2>
            <p className="text-[12.5px] text-[#58534C]">
              <span className="font-medium">{editing.name}</span> (
              {editing.rtsp_url_masked}) will be removed from all VMS views and
              its stream sessions ended. This is a soft delete — audit history
              is preserved.
            </p>
            <div className="flex justify-end gap-2 pt-5">
              <button
                onClick={() => setModal(null)}
                className="px-4 py-2 rounded-lg border border-[#EAE5DC] text-[12.5px] text-[#58534C]"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-[12.5px] font-medium disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
