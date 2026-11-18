import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  formatNumber,
  moneyInputValue,
  parseMoneyInput,
  type Currency,
  type CustomFieldDefinitionView,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type EntityType } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { CheckboxGroup, formError, serverFieldErrors } from './record-form.js';
import { DetailList } from './profile-kit.js';
import { FormRow } from '@/features/settings/settings-kit.js';

const ENTITY_PLURAL: Record<EntityType, string> = {
  lead: 'leads',
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
};

interface DraftMoney {
  amountText: string;
  currency: Currency;
}

function initialDraftValues(
  defs: CustomFieldDefinitionView[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const raw = values[def.fieldKey];
    if (def.fieldType === 'money') {
      const m = raw as { amountMinor?: string; currency?: Currency } | undefined;
      out[def.fieldKey] = {
        amountText: m?.amountMinor ? moneyInputValue(m.amountMinor) : '',
        currency: m?.currency === 'CAD' ? 'CAD' : 'USD',
      } satisfies DraftMoney;
    } else if (def.fieldType === 'multi_select') {
      out[def.fieldKey] = Array.isArray(raw) ? raw.map(String) : [];
    } else if (def.fieldType === 'boolean') {
      out[def.fieldKey] = raw === true ? 'true' : raw === false ? 'false' : '';
    } else {
      out[def.fieldKey] = raw === null || raw === undefined ? '' : String(raw);
    }
  }
  return out;
}

function renderCustomValue(def: CustomFieldDefinitionView, raw: unknown) {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (def.fieldType) {
    case 'boolean':
      return raw === true ? 'Yes' : raw === false ? 'No' : null;
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? formatNumber(n) : String(raw);
    }
    case 'date':
      return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? formatDate(`${raw}T00:00:00Z`, 'UTC')
        : String(raw);
    case 'money': {
      const m = raw as { amountMinor?: string; currency?: Currency };
      if (!m?.amountMinor) return null;
      return formatMoney({
        amountMinor: BigInt(m.amountMinor),
        currency: m.currency === 'CAD' ? 'CAD' : 'USD',
      });
    }
    case 'multi_select':
      return Array.isArray(raw) && raw.length > 0 ? raw.map(String).join(', ') : null;
    case 'url': {
      const url = String(raw);
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-primary-ink font-semibold break-all hover:underline"
        >
          {url}
        </a>
      );
    }
    case 'select':
    case 'text':
      return String(raw);
  }
}

/**
 * Custom fields panel for Lead, Contact, Company and Deal profiles (PRD 4.3-4.6, 4.17).
 */
export function CustomFieldsPanel({
  entityType,
  entityId,
  version,
  values,
  canWrite,
  onSaved,
}: {
  entityType: EntityType;
  entityId: string;
  version: number;
  values: Record<string, unknown> | undefined;
  canWrite: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const defsQuery = useQuery({
    queryKey: ['custom-fields', entityType],
    queryFn: () => api.listCustomFields(entityType),
  });

  const save = useMutation({
    mutationFn: (payloadValues: Record<string, unknown>) =>
      api.setRecordCustomFields(entityType, entityId, {
        version,
        values: payloadValues,
      }),
    onSuccess: async () => {
      setEditing(false);
      setFieldErrors({});
      toast('Saved custom fields.');
      await queryClient.invalidateQueries({ queryKey: ['timeline', entityType, entityId] });
      onSaved();
    },
    onError: (err) => setFieldErrors(serverFieldErrors(err)),
  });

  if (defsQuery.isPending) {
    return (
      <Panel title="Custom fields" padded>
        <LoadingState rows={2} />
      </Panel>
    );
  }

  if (defsQuery.isError) {
    return (
      <Panel title="Custom fields" padded>
        <ErrorState
          message={errorMessage(defsQuery.error)}
          onRetry={() => void defsQuery.refetch()}
        />
      </Panel>
    );
  }

  const defs = defsQuery.data;
  const currentValues = values ?? {};

  if (defs.length === 0) {
    return (
      <Panel title="Custom fields" padded>
        <p className="m-0 text-[14px] text-ink-2" data-testid="custom-fields-empty">
          No custom fields set up for {ENTITY_PLURAL[entityType]}.
        </p>
      </Panel>
    );
  }

  const startEdit = () => {
    setDraft(initialDraftValues(defs, currentValues));
    setFieldErrors({});
    save.reset();
    setEditing(true);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    const payload: Record<string, unknown> = {};

    for (const def of defs) {
      const raw = draft[def.fieldKey];
      if (def.fieldType === 'money') {
        const moneyDraft = (raw ?? { amountText: '', currency: 'USD' }) as DraftMoney;
        const trimmed = moneyDraft.amountText.trim();
        if (!trimmed) {
          if (def.isRequired) nextErrors[def.fieldKey] = `Enter a value for "${def.label}".`;
          payload[def.fieldKey] = null;
        } else {
          const minor = parseMoneyInput(trimmed);
          if (minor === null) {
            nextErrors[def.fieldKey] = 'Enter a non-negative amount (for example 4500 or 4500.50).';
          } else {
            payload[def.fieldKey] = {
              amountMinor: minor.toString(),
              currency: moneyDraft.currency,
            };
          }
        }
      } else if (def.fieldType === 'multi_select') {
        const list = Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
        if (def.isRequired && list.length === 0) {
          nextErrors[def.fieldKey] = `Choose at least one option for "${def.label}".`;
        }
        payload[def.fieldKey] = list;
      } else if (def.fieldType === 'boolean') {
        if (raw === 'true') payload[def.fieldKey] = true;
        else if (raw === 'false') payload[def.fieldKey] = false;
        else {
          if (def.isRequired) nextErrors[def.fieldKey] = `Choose Yes or No for "${def.label}".`;
          payload[def.fieldKey] = null;
        }
      } else if (def.fieldType === 'number') {
        const str = String(raw ?? '').trim();
        if (!str) {
          if (def.isRequired) nextErrors[def.fieldKey] = `Enter a number for "${def.label}".`;
          payload[def.fieldKey] = null;
        } else {
          const n = Number(str);
          if (!Number.isFinite(n)) {
            nextErrors[def.fieldKey] = 'Enter a valid number.';
          } else {
            payload[def.fieldKey] = n;
          }
        }
      } else {
        const str = String(raw ?? '').trim();
        if (!str) {
          if (def.isRequired) nextErrors[def.fieldKey] = `Enter a value for "${def.label}".`;
          payload[def.fieldKey] = null;
        } else {
          payload[def.fieldKey] = str;
        }
      }
    }

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      save.mutate(payload);
    }
  };

  return (
    <Panel
      title="Custom fields"
      padded
      actions={
        canWrite && !editing ? (
          <Button variant="secondary" size="sm" onClick={startEdit}>
            Edit fields
          </Button>
        ) : undefined
      }
    >
      <div data-testid="custom-fields-panel">
        {!editing ? (
          <DetailList
            items={defs.map((def) => [
              def.label,
              renderCustomValue(def, currentValues[def.fieldKey]),
            ])}
          />
        ) : (
          <form onSubmit={submit} noValidate className="grid gap-[14px]">
            {defs.map((def) => {
              const id = `cf-${entityType}-${def.fieldKey}`;
              const err = fieldErrors[def.fieldKey];
              const labelText = def.isRequired ? `${def.label} *` : def.label;

              if (def.fieldType === 'multi_select') {
                const selected = Array.isArray(draft[def.fieldKey])
                  ? (draft[def.fieldKey] as string[])
                  : [];
                return (
                  <div key={def.id} className="grid gap-[4px]">
                    <CheckboxGroup
                      legend={labelText}
                      options={def.options}
                      value={selected}
                      onChange={(next) => setDraft((prev) => ({ ...prev, [def.fieldKey]: next }))}
                    />
                    {err && (
                      <p role="alert" className="m-0 text-[12.5px] text-danger">
                        {err}
                      </p>
                    )}
                  </div>
                );
              }

              if (def.fieldType === 'select') {
                return (
                  <FormRow key={def.id} id={id} label={labelText} error={err}>
                    <Select
                      id={id}
                      value={String(draft[def.fieldKey] ?? '')}
                      onChange={(e) =>
                        setDraft((prev) => ({ ...prev, [def.fieldKey]: e.target.value }))
                      }
                    >
                      <option value="">Select…</option>
                      {def.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </Select>
                  </FormRow>
                );
              }

              if (def.fieldType === 'boolean') {
                return (
                  <FormRow key={def.id} id={id} label={labelText} error={err}>
                    <Select
                      id={id}
                      value={String(draft[def.fieldKey] ?? '')}
                      onChange={(e) =>
                        setDraft((prev) => ({ ...prev, [def.fieldKey]: e.target.value }))
                      }
                    >
                      <option value="">Not set</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </Select>
                  </FormRow>
                );
              }

              if (def.fieldType === 'money') {
                const moneyDraft = (draft[def.fieldKey] ?? {
                  amountText: '',
                  currency: 'USD',
                }) as DraftMoney;
                return (
                  <FormRow key={def.id} id={id} label={labelText} error={err}>
                    <div className="flex gap-[8px]">
                      <Select
                        aria-label={`${def.label} currency`}
                        className="w-[100px] shrink-0"
                        value={moneyDraft.currency}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            [def.fieldKey]: {
                              ...moneyDraft,
                              currency: e.target.value as Currency,
                            },
                          }))
                        }
                      >
                        <option value="USD">USD</option>
                        <option value="CAD">CAD</option>
                      </Select>
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={moneyDraft.amountText}
                        invalid={Boolean(err)}
                        placeholder="4500"
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            [def.fieldKey]: { ...moneyDraft, amountText: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </FormRow>
                );
              }

              return (
                <FormRow key={def.id} id={id} label={labelText} error={err}>
                  <Input
                    id={id}
                    type={
                      def.fieldType === 'date'
                        ? 'date'
                        : def.fieldType === 'number'
                          ? 'number'
                          : def.fieldType === 'url'
                            ? 'url'
                            : 'text'
                    }
                    value={String(draft[def.fieldKey] ?? '')}
                    invalid={Boolean(err)}
                    placeholder={def.fieldType === 'url' ? 'https://example.com' : undefined}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, [def.fieldKey]: e.target.value }))
                    }
                  />
                </FormRow>
              );
            })}

            {save.isError && Object.keys(fieldErrors).length === 0 && (
              <p role="alert" className="m-0 text-[13px] text-danger">
                {formError(save.error)}
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-[8px]">
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setFieldErrors({});
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save fields'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
