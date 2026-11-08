import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type DealRow, type StageRow } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { useReferenceLists } from '@/features/shared/list-kit.js';

/**
 * Moves a deal to another stage (PRD 3.3, 4.6). Stages that need details first (trial role,
 * contract start date, lost reason) ask for them before the move is sent.
 */
export function StageMover({
  deal,
  stages,
  compact = false,
  onMoved,
}: {
  deal: DealRow;
  stages: StageRow[];
  compact?: boolean;
  onMoved?: (deal: DealRow) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const refs = useReferenceLists();
  const [target, setTarget] = useState('');
  const [trialRole, setTrialRole] = useState('');
  const [startDate, setStartDate] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [lostNotes, setLostNotes] = useState('');
  const stage = stages.find((s) => s.name === target);
  // Details already on the deal don't need asking again; lost stages always need a reason.
  const needs = new Set(
    [
      ...(stage?.required_fields ?? []),
      ...(stage?.category === 'lost' ? ['lost_reason'] : []),
    ].filter(
      (field) =>
        !(field === 'trial_candidate_role' && deal.trial_candidate_role) &&
        !(field === 'contract_start_date' && deal.contract_start_date),
    ),
  );
  const missingContact = needs.has('primary_contact_id') && !deal.primary_contact_id;

  const move = useMutation({
    mutationFn: () =>
      api.moveDealStage(deal.id, {
        stageName: target,
        version: deal.version,
        ...(needs.has('trial_candidate_role') ? { trialCandidateRole: trialRole.trim() } : {}),
        ...(needs.has('contract_start_date') ? { contractStartDate: startDate } : {}),
        ...(needs.has('lost_reason')
          ? { lostReason, lostNotes: lostNotes.trim() || undefined }
          : {}),
      }),
    onSuccess: async (moved) => {
      toast(`Moved ${deal.name} to ${target}.`);
      setTarget('');
      setTrialRole('');
      setStartDate('');
      setLostReason('');
      setLostNotes('');
      await Promise.all(
        [['board'], ['deals'], ['deal', deal.id], ['company', deal.company_id], ['timeline']].map(
          (key) => queryClient.invalidateQueries({ queryKey: key }),
        ),
      );
      onMoved?.(moved);
    },
  });

  const ready =
    target !== '' &&
    !missingContact &&
    (!needs.has('trial_candidate_role') || trialRole.trim() !== '') &&
    (!needs.has('contract_start_date') || startDate !== '') &&
    (!needs.has('lost_reason') || lostReason !== '');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) move.mutate();
  };

  const h = compact ? 'h-[32px] text-[13px]' : '';
  return (
    <form className="grid gap-[6px]" onSubmit={submit}>
      <Select
        value={target}
        onChange={(e) => {
          setTarget(e.target.value);
          move.reset();
        }}
        aria-label={`Move ${deal.name} to another stage`}
        className={h}
      >
        <option value="">Move to…</option>
        {stages
          .filter((s) => s.name !== deal.stage_name)
          .map((s) => (
            <option key={s.id} value={s.name}>
              {s.name}
            </option>
          ))}
      </Select>
      {missingContact && (
        <p className="m-0 text-[12.5px] text-ink-2">
          Add a primary contact to this deal before moving it to {target}.
        </p>
      )}
      {needs.has('trial_candidate_role') && (
        <Input
          value={trialRole}
          onChange={(e) => setTrialRole(e.target.value)}
          placeholder="Trial role"
          aria-label="Trial role"
          required
          className={h}
        />
      )}
      {needs.has('contract_start_date') && (
        <Input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          aria-label="Contract start date"
          required
          className={h}
        />
      )}
      {needs.has('lost_reason') && (
        <>
          <Select
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            aria-label="Why was it lost?"
            required
            className={h}
          >
            <option value="">Why was it lost?</option>
            {(refs.data?.['lost_reasons'] ?? []).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <Textarea
            rows={2}
            value={lostNotes}
            onChange={(e) => setLostNotes(e.target.value)}
            placeholder="Anything else to note (optional)"
            aria-label="Notes on why it was lost"
          />
        </>
      )}
      {target && (
        <Button
          type="submit"
          variant={compact ? 'outline' : 'primary'}
          size="sm"
          disabled={move.isPending || !ready}
        >
          {move.isPending ? 'Moving…' : `Move to ${target}`}
        </Button>
      )}
      {move.isError && (
        <p role="alert" className="m-0 text-[12.5px] text-danger">
          {errorMessage(move.error)}
        </p>
      )}
    </form>
  );
}
