import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type DealRow, type StageRow } from '@/lib/api.js';
import { Field, errorMessage } from '@/features/shared/live-kit.js';
import { useReferenceLists } from '@/features/shared/list-kit.js';

export function computeMissingStageGateFields(deal: DealRow, stage: StageRow): Set<string> {
  return new Set(
    [
      ...(stage.required_fields ?? []),
      ...(stage.category === 'lost' ? ['lost_reason'] : []),
    ].filter(
      (field) =>
        !(field === 'trial_candidate_role' && deal.trial_candidate_role) &&
        !(field === 'contract_start_date' && deal.contract_start_date) &&
        !(field === 'primary_contact_id' && deal.primary_contact_id),
    ),
  );
}

export async function invalidateDealBoardQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  deal: { id: string; company_id: string },
): Promise<void> {
  await Promise.all(
    [['board'], ['deals'], ['deal', deal.id], ['company', deal.company_id], ['timeline']].map(
      (key) => queryClient.invalidateQueries({ queryKey: key }),
    ),
  );
}

export function StageGateDialog({
  deal,
  stage,
  onClose,
  onOpenDeal,
}: {
  deal: DealRow;
  stage: StageRow;
  onClose: () => void;
  onOpenDeal: (dealId: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const refs = useReferenceLists();
  const needs = computeMissingStageGateFields(deal, stage);
  const missingContact = needs.has('primary_contact_id');

  const [trialRole, setTrialRole] = useState('');
  const [startDate, setStartDate] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [lostNotes, setLostNotes] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const move = useMutation({
    mutationFn: () =>
      api.moveDealStage(deal.id, {
        stageName: stage.name,
        version: deal.version,
        ...(needs.has('trial_candidate_role') ? { trialCandidateRole: trialRole.trim() } : {}),
        ...(needs.has('contract_start_date') ? { contractStartDate: startDate } : {}),
        ...(needs.has('lost_reason')
          ? { lostReason, lostNotes: lostNotes.trim() || undefined }
          : {}),
      }),
    onSuccess: async () => {
      toast(`Moved ${deal.name} to ${stage.name}.`);
      await invalidateDealBoardQueries(queryClient, deal);
      onClose();
    },
  });

  const ready =
    !missingContact &&
    (!needs.has('trial_candidate_role') || trialRole.trim() !== '') &&
    (!needs.has('contract_start_date') || startDate !== '') &&
    (!needs.has('lost_reason') || lostReason !== '');

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) move.mutate();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-[16px]"
      style={{ background: 'var(--scrim)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="stage-gate-dialog-title"
        data-testid="stage-gate-dialog"
        className="w-full max-w-[480px] bg-surface border border-line rounded-xl p-[20px] space-y-[16px]"
        style={{ boxShadow: 'var(--shadow-dialog)' }}
      >
        <div className="flex items-start justify-between gap-[12px]">
          <div>
            <h2 id="stage-gate-dialog-title" className="m-0 text-title text-ink">
              Move to {stage.name}
            </h2>
            <p className="m-0 mt-[2px] text-[13px] text-ink-2">
              {deal.company_name ? `${deal.company_name} · ${deal.name}` : deal.name}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog">
            <X size={16} strokeWidth={1.6} aria-hidden="true" />
          </Button>
        </div>

        {missingContact ? (
          <div className="space-y-[14px]">
            <div className="bg-warning-bg border-l-[3px] border-warning rounded-r-[10px] px-[14px] py-[10px] text-[13.5px] text-warning">
              Add a primary contact on this deal before moving it to {stage.name}.
            </div>
            <div className="flex justify-end gap-[8px]">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  onClose();
                  onOpenDeal(deal.id);
                }}
              >
                Open deal
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-[14px]">
            {needs.has('trial_candidate_role') && (
              <Field label="Trial candidate role">
                <Input
                  value={trialRole}
                  onChange={(e) => setTrialRole(e.target.value)}
                  placeholder="e.g. Senior tax preparer"
                  required
                  autoFocus
                />
              </Field>
            )}

            {needs.has('contract_start_date') && (
              <Field label="Contract start date">
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                  autoFocus={!needs.has('trial_candidate_role')}
                />
              </Field>
            )}

            {needs.has('lost_reason') && (
              <>
                <Field label="Why was it lost?">
                  <Select
                    value={lostReason}
                    onChange={(e) => setLostReason(e.target.value)}
                    required
                    autoFocus={
                      !needs.has('trial_candidate_role') && !needs.has('contract_start_date')
                    }
                  >
                    <option value="">Choose a reason…</option>
                    {(refs.data?.['lost_reasons'] ?? []).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Notes" optional>
                  <Textarea
                    rows={2}
                    value={lostNotes}
                    onChange={(e) => setLostNotes(e.target.value)}
                    placeholder="Context for future follow-up"
                  />
                </Field>
              </>
            )}

            {move.isError && (
              <p role="alert" className="m-0 text-[13px] text-danger">
                {errorMessage(move.error)}
              </p>
            )}

            <div className="flex justify-end gap-[8px] pt-[4px]">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={move.isPending || !ready}>
                {move.isPending ? 'Moving…' : `Move to ${stage.name}`}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
