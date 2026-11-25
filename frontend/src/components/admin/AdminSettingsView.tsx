import React, { useEffect, useState } from 'react';
import { Building2, Check, Clock3, Copy, Database, KeyRound, RefreshCw } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { ApiError } from '../../api/client';
import {
  getOrganizationCodes,
  PropertyCode,
  regenerateOrganizationCode,
} from '../../api/employeeRequests';

export const AdminSettingsView: React.FC = () => {
  const {
    company,
    companyProperties,
    employees,
    zones,
    rooms,
    dorms,
    updateCompanyDetails,
    retryLoad,
    addToast,
  } = useApp();

  // Organization-scoped stats (zones/rooms/dorms/staff inherit scope via property)
  const companyPropertyUids = new Set(companyProperties.map((p) => p.property_uid));
  const companyZones = zones.filter((z) => companyPropertyUids.has(z.property_uid));
  const companyRooms = rooms.filter((r) => companyPropertyUids.has(r.property_uid));
  const companyDorms = dorms.filter((d) => companyPropertyUids.has(d.property_uid));
  const companyEmployees = employees.filter((e) => e.company_uid === company?.company_uid);

  const [legalName, setLegalName] = useState(company?.legal_name || company?.name || '');
  const [brandName, setBrandName] = useState(company?.brand_name || '');
  const [email, setEmail] = useState(company?.email || '');
  const [phone, setPhone] = useState(company?.phone || '');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dayStart, setDayStart] = useState(company?.operational_day_start || '06:00');
  const [isSavingDay, setIsSavingDay] = useState(false);
  const [dayError, setDayError] = useState<string | null>(null);

  // Organization Codes — one 12-char key per property; each admits
  // mobile-app registrations into that specific property. Fetched once
  // on mount; rotation requires an explicit confirmation per property.
  const [codes, setCodes] = useState<PropertyCode[] | null>(null);
  const [orgCodeError, setOrgCodeError] = useState<string | null>(null);
  const [copiedUid, setCopiedUid] = useState<string | null>(null);
  const [regenFor, setRegenFor] = useState<PropertyCode | null>(null);
  const [regenLoading, setRegenLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getOrganizationCodes()
      .then((r) => !cancelled && setCodes(r.items))
      .catch((e) =>
        !cancelled &&
        setOrgCodeError(
          e instanceof ApiError ? e.message : 'Could not load organization codes.',
        ),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const copyOrgCode = async (uid: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedUid(uid);
      window.setTimeout(() => setCopiedUid(null), 2000);
    } catch {
      /* clipboard unavailable — the code stays visible for manual copy */
    }
  };

  const handleRegenerate = async () => {
    if (!regenFor) return;
    setRegenLoading(true);
    try {
      const updated = await regenerateOrganizationCode(regenFor.property_uid);
      setCodes((prev) =>
        prev
          ? prev.map((c) =>
              c.property_uid === updated.property_uid ? updated : c,
            )
          : prev,
      );
      setRegenFor(null);
      addToast({
        type: 'success',
        title: 'Code Regenerated',
        description: `The previous code for ${updated.property_name} no longer accepts new registrations.`,
      });
    } catch (e) {
      setOrgCodeError(
        e instanceof ApiError ? e.message : 'Could not regenerate the code.',
      );
      setRegenFor(null);
    } finally {
      setRegenLoading(false);
    }
  };

  const handleSaveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateCompanyDetails({
        legal_name: legalName.trim(),
        brand_name: brandName.trim(),
        email: email.trim(),
        phone: phone.trim(),
      });
      addToast({
        type: 'success',
        title: 'Settings Saved',
        description: 'Organization details updated successfully.',
      });
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err.message : 'Could not save organization settings.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Top Header */}
      <div>
        <h1 className="font-display font-bold text-2xl sm:text-[28px] text-[#0D1C42] tracking-tight">
          Organization Settings
        </h1>
        <p className="font-body text-sm text-[#667085] mt-0.5">
          Legal corporate identity and administrative system configuration
        </p>
      </div>

      {/* Organization Info Form */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Building2 className="w-4 h-4 text-[#800020]" />
          <h3 className="font-display font-bold text-base text-[#0D1C42]">
            Organization & Brand Identity
          </h3>
        </div>

        {saveError && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-[10px] bg-[#FAEBEB] border border-[#F0C8C8] text-[#A83434] text-xs font-medium"
          >
            {saveError}
          </div>
        )}

        <form onSubmit={handleSaveCompany} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                Legal Entity Name
              </label>
              <input
                type="text"
                required
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                Hospitality Brand Name
              </label>
              <input
                type="text"
                required
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                Operations Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                Corporate Phone
              </label>
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              />
            </div>
          </div>

          <div className="flex justify-end pt-3">
            <Button type="submit" variant="primary" isLoading={isSaving}>
              Save Organization Info
            </Button>
          </div>
        </form>
      </Card>

      {/* Organization Codes — one per property; each admits employee
          self-registration requests into that specific property */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-2">
          <KeyRound className="w-4 h-4 text-[#800020]" />
          <h3 className="font-display font-bold text-base text-[#0D1C42]">
            Organization Codes
          </h3>
        </div>
        <p className="text-xs text-[#667085] font-body mb-4">
          Every property has its own code. Share a property's code with its
          prospective employees — their mobile-app registration lands on that
          property for admin approval.
        </p>

        {orgCodeError && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-[10px] bg-[#FAEBEB] border border-[#F0C8C8] text-[#A83434] text-xs font-medium"
          >
            {orgCodeError}
          </div>
        )}

        <div className="rounded-[10px] border border-[#E7E5E4] divide-y divide-[#E7E5E4] overflow-hidden">
          {(codes ?? []).length === 0 && !orgCodeError ? (
            <p className="px-4 py-6 text-center text-xs text-[#667085]">
              {codes === null ? 'Loading codes…' : 'No properties yet — create one to get its code.'}
            </p>
          ) : (
            (codes ?? []).map((c) => (
              <div
                key={c.property_uid}
                className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3"
              >
                <span className="font-body text-sm font-semibold text-[#0D1C42] sm:w-48 truncate">
                  {c.property_name}
                </span>
                <span className="font-mono text-base font-bold tracking-[0.25em] text-[#0D1C42] select-all flex-1">
                  {c.organization_code}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void copyOrgCode(c.property_uid, c.organization_code)}
                  >
                    {copiedUid === c.property_uid ? (
                      <Check className="w-3.5 h-3.5 text-[#386641]" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copiedUid === c.property_uid ? 'Copied' : 'Copy'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRegenFor(c)}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Regenerate
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
        <p className="text-[11px] text-[#667085] font-body mt-3">
          Regenerating a property's code immediately invalidates it for new
          registration requests. Existing approved employees are unaffected.
        </p>
      </Card>

      <ConfirmationDialog
        isOpen={regenFor !== null}
        onClose={() => setRegenFor(null)}
        onConfirm={() => void handleRegenerate()}
        entityType="Organization Code"
        entityName={regenFor?.property_name ?? ''}
        title="Regenerate organization code?"
        warningTitle="This immediately invalidates the current code for this property."
        impactMessage="Any new sign-ups using the old code will fail verification. Requests already submitted and approved employees are unaffected."
        confirmLabel="Regenerate Code"
        confirmVariant="primary"
        isLoading={regenLoading}
      />

      {/* Operational Day — drives the daily rollover + task analysis */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-2">
          <Clock3 className="w-4 h-4 text-[#800020]" />
          <h3 className="font-display font-bold text-base text-[#0D1C42]">
            Operational Day
          </h3>
        </div>
        <p className="text-xs text-[#667085] font-body mb-4">
          The time each operational day begins (IST). At this moment every
          unfinished task from the previous day is automatically marked
          Abandoned, and the task calendar/analysis group work by this window.
        </p>

        {dayError && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-[10px] bg-[#FAEBEB] border border-[#F0C8C8] text-[#A83434] text-xs font-medium"
          >
            {dayError}
          </div>
        )}

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (isSavingDay) return;
            setIsSavingDay(true);
            setDayError(null);
            try {
              await updateCompanyDetails({ operational_day_start: dayStart });
              addToast({
                type: 'success',
                title: 'Settings Saved',
                description: `Operational day now starts at ${dayStart} IST.`,
              });
            } catch (err) {
              setDayError(
                err instanceof ApiError
                  ? err.message
                  : 'Could not save the operational day start.'
              );
            } finally {
              setIsSavingDay(false);
            }
          }}
          className="flex items-end gap-4"
        >
          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
              Operational Day Starts At (IST)
            </label>
            <input
              type="time"
              required
              value={dayStart}
              onChange={(e) => setDayStart(e.target.value)}
              className="px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
            />
          </div>
          <Button type="submit" variant="primary" isLoading={isSavingDay}>
            Save
          </Button>
        </form>
      </Card>

      {/* Data Overview & Sync */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-2">
          <Database className="w-4 h-4 text-[#A56514]" />
          <h3 className="font-display font-bold text-base text-[#0D1C42]">
            Workspace Data
          </h3>
        </div>
        <p className="text-xs text-[#667085] font-body mb-4">
          Live operational data synced from the operations API across all company properties.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-5">
          <div className="p-3 bg-[#FFFFFF] rounded-[10px] border border-[#E7E5E4]">
            <span className="text-[#667085] block font-semibold">Properties</span>
            <span className="font-display font-bold text-lg text-[#0D1C42]">{companyProperties.length}</span>
          </div>
          <div className="p-3 bg-[#FFFFFF] rounded-[10px] border border-[#E7E5E4]">
            <span className="text-[#667085] block font-semibold">Zones</span>
            <span className="font-display font-bold text-lg text-[#0D1C42]">{companyZones.length}</span>
          </div>
          <div className="p-3 bg-[#FFFFFF] rounded-[10px] border border-[#E7E5E4]">
            <span className="text-[#667085] block font-semibold">Rooms & Dorms</span>
            <span className="font-display font-bold text-lg text-[#0D1C42]">
              {companyRooms.length + companyDorms.length}
            </span>
          </div>
          <div className="p-3 bg-[#FFFFFF] rounded-[10px] border border-[#E7E5E4]">
            <span className="text-[#667085] block font-semibold">Staff Count</span>
            <span className="font-display font-bold text-lg text-[#0D1C42]">{companyEmployees.length}</span>
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-[#F6F4F2]">
          <div>
            <h4 className="font-semibold text-xs text-[#0D1C42]">Reload Workspace Data</h4>
            <p className="text-[11px] text-[#667085]">
              Re-fetch all properties, zones, rooms, and staff from the server.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={retryLoad}>
            <RefreshCw className="w-3.5 h-3.5 mr-1 text-[#800020]" />
            <span>Refresh Data</span>
          </Button>
        </div>
      </Card>
    </div>
  );
};