import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UpsertFxRateInputSchema,
  formatDate,
  formatFxRateScaled,
  type Currency,
  type FxRateView,
  type UpsertFxRateInput,
} from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { formError, issuesOf, serverFieldErrors } from '@/features/records/record-form.js';
import { FormRow } from './settings-kit.js';

/**
 * Settings → Currencies (PRD 4.15, 4.17, 14): manage USD/CAD exchange rates for pipeline and
 * revenue reporting without floating-point math.
 */
export function CurrenciesTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const todayIso = new Date().toISOString().slice(0, 10);

  const [fromCurrency, setFromCurrency] = useState<Currency>('CAD');
  const [toCurrency, setToCurrency] = useState<Currency>('USD');
  const [rateText, setRateText] = useState('0.7350');
  const [effectiveDate, setEffectiveDate] = useState(todayIso);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<FxRateView | null>(null);

  const fxQuery = useQuery({
    queryKey: ['admin', 'fx-rates'],
    queryFn: api.listFxRates,
  });

  const upsert = useMutation({
    mutationFn: (input: UpsertFxRateInput) => api.upsertFxRate(input),
    onSuccess: async (res) => {
      toast(
        `Saved ${res.rate.fromCurrency} → ${res.rate.toCurrency} rate for ${res.rate.effectiveDate}.`,
      );
      setErrors({});
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'fx-rates'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteFxRate(id),
    onSuccess: async () => {
      toast('Removed exchange rate.');
      setDeleting(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'fx-rates'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const payload: UpsertFxRateInput = {
      fromCurrency,
      toCurrency,
      rateText: rateText.trim(),
      effectiveDate,
    };
    const issues = issuesOf(UpsertFxRateInputSchema, payload);
    setErrors(issues);
    if (Object.keys(issues).length === 0) {
      upsert.mutate(payload);
    }
  };

  if (fxQuery.isPending) return <LoadingState rows={4} />;
  if (fxQuery.isError) {
    return (
      <ErrorState message={errorMessage(fxQuery.error)} onRetry={() => void fxQuery.refetch()} />
    );
  }

  const { reportingCurrency, items } = fxQuery.data;

  return (
    <div className="space-y-[16px]" data-testid="settings-currencies-tab">
      <Callout>
        <div className="flex flex-wrap items-center justify-between gap-[8px]">
          <p className="m-0 text-[13.5px] text-ink">
            Open pipeline figures convert into the reporting currency using the latest effective
            exchange rate; closed deals lock in the rate active when the deal closed.
          </p>
          <StatusBadge tone="brand">Reporting currency: {reportingCurrency}</StatusBadge>
        </div>
      </Callout>

      <Panel title="Add or update exchange rate" padded>
        <form onSubmit={submit} noValidate className="grid gap-[12px]">
          <div className="grid gap-[12px] sm:grid-cols-4">
            <FormRow id="fx-from" label="From" error={errors['fromCurrency']}>
              <Select
                id="fx-from"
                value={fromCurrency}
                onChange={(e) => {
                  const next = e.target.value as Currency;
                  setFromCurrency(next);
                  setToCurrency(next === 'CAD' ? 'USD' : 'CAD');
                }}
              >
                <option value="CAD">CAD (CA$)</option>
                <option value="USD">USD (US$)</option>
              </Select>
            </FormRow>

            <FormRow id="fx-to" label="To" error={errors['toCurrency']}>
              <Select
                id="fx-to"
                value={toCurrency}
                onChange={(e) => setToCurrency(e.target.value as Currency)}
              >
                <option value="USD">USD (US$)</option>
                <option value="CAD">CAD (CA$)</option>
              </Select>
            </FormRow>

            <FormRow id="fx-rate" label="Exchange rate" error={errors['rateText']}>
              <Input
                id="fx-rate"
                inputMode="decimal"
                value={rateText}
                invalid={Boolean(errors['rateText'])}
                placeholder="0.7350"
                onChange={(e) => setRateText(e.target.value)}
              />
            </FormRow>

            <FormRow id="fx-date" label="Effective date" error={errors['effectiveDate']}>
              <Input
                id="fx-date"
                type="date"
                value={effectiveDate}
                invalid={Boolean(errors['effectiveDate'])}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </FormRow>
          </div>

          {upsert.isError && Object.keys(errors).length === 0 && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {formError(upsert.error)}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={upsert.isPending}>
              {upsert.isPending ? 'Saving…' : 'Save exchange rate'}
            </Button>
          </div>
        </form>
      </Panel>

      {items.length === 0 ? (
        <Panel padded={false}>
          <EmptyState
            title="No exchange rates recorded"
            description="Add a CAD to USD exchange rate above so multi-currency pipeline rollups convert accurately."
          />
        </Panel>
      ) : (
        <Panel title={`Stored exchange rates (${items.length})`} padded={false}>
          <ul className="m-0 p-0 list-none divide-y divide-line">
            {items.map((rate) => (
              <li
                key={rate.id}
                className="px-[16px] py-[12px] flex flex-wrap items-center justify-between gap-[8px]"
              >
                <div className="min-w-0 space-y-[2px]">
                  <div className="flex flex-wrap items-center gap-[8px]">
                    <span className="font-semibold text-ink">
                      1 {rate.fromCurrency} ={' '}
                      <span className="tabular-nums">{formatFxRateScaled(rate.rateScaled)}</span>{' '}
                      {rate.toCurrency}
                    </span>
                    <StatusBadge tone="neutral">
                      Effective {formatDate(`${rate.effectiveDate}T00:00:00Z`, 'UTC')}
                    </StatusBadge>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${rate.fromCurrency} to ${rate.toCurrency} rate for ${rate.effectiveDate}`}
                  onClick={() => {
                    remove.reset();
                    setDeleting(rate);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title={
          deleting
            ? `Remove ${deleting.fromCurrency} → ${deleting.toCurrency} (${deleting.effectiveDate})?`
            : 'Remove exchange rate?'
        }
        body="Closed deals that already locked in their exchange rate at close keep their stored figure."
        confirmLabel="Remove rate"
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
    </div>
  );
}
