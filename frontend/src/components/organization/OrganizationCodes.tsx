import React, { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw } from 'lucide-react';
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

/** Organization Codes card — one 12-char key per property; each admits
 *  mobile-app registrations into that specific property. Fetched once
 *  on mount; rotation requires an explicit confirmation per property.
 *  Shared between Admin Settings and Workforce → Accounts. */
export const OrganizationCodes: React.FC = () => {
  const { addToast } = useApp();

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

  return (
    <>
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
    </>
  );
};
