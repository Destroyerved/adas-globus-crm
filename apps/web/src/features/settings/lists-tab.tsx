import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { formatRelative, settingValueSchema } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Panel } from '@/components/ui/panel.js';
import { ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type SettingRow } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { formError, issuesOf } from '@/features/records/record-form.js';

const LIST_INFO: Record<string, { title: string; help: string }> = {
  'reference.lead_sources': { title: 'Lead sources', help: 'Where a lead came from.' },
  'reference.lost_reasons': { title: 'Lost reasons', help: 'Asked for when a deal is lost.' },
  'reference.disqualify_reasons': {
    title: 'Disqualification reasons',
    help: 'Asked for when a lead is disqualified.',
  },
  'reference.services': { title: 'Services', help: 'What a firm needs from us.' },
  'reference.engagement_models': { title: 'Engagement models', help: 'How a deal is staffed.' },
  'reference.firm_types': { title: 'Firm types', help: 'Kinds of company we sell to.' },
  'reference.staff_bands': { title: 'Firm sizes', help: 'Staff count bands.' },
  'reference.software': { title: 'Software', help: 'Tools a firm uses.' },
  'reference.deal_contact_roles': {
    title: 'Contact roles on deals',
    help: 'The part each person plays in a deal.',
  },
};

const NUMBER_INFO: Record<string, { title: string; help: string; unit: string }> = {
  'sla.first_response_business_days': {
    title: 'First reply to a website inquiry',
    help: 'Business days before an unanswered inquiry counts as late.',
    unit: 'business days',
  },
  'deals.idle_days_default': {
    title: 'Idle deal warning for new stages',
    help: 'Each stage can change this in Pipelines.',
    unit: 'days',
  },
};

/** Reference lists and defaults (PRD 3.4, 4.17). Changes apply to forms straight away. */
export function ListsTab() {
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: api.adminSettings });
  if (settings.isPending) return <LoadingState rows={6} />;
  if (settings.isError) {
    return (
      <ErrorState message={errorMessage(settings.error)} onRetry={() => void settings.refetch()} />
    );
  }
  const numbers = settings.data.filter((s) => s.key in NUMBER_INFO);
  const lists = Object.keys(LIST_INFO)
    .map((key) => settings.data.find((s) => s.key === key))
    .filter((s): s is SettingRow => Boolean(s));
  return (
    <div className="space-y-[16px]">
      <div className="grid gap-[16px] md:grid-cols-2">
        {numbers.map((s) => (
          <NumberSetting key={s.key} setting={s} />
        ))}
      </div>
      <div className="grid gap-[16px] lg:grid-cols-2">
        {lists.map((s) => (
          <ListSetting key={`${s.key}-${s.version}`} setting={s} />
        ))}
      </div>
    </div>
  );
}

function useSaveSetting(setting: SettingRow, label: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (value: unknown) => api.updateSetting(setting.key, setting.version, value),
    onSuccess: async () => {
      toast(`Saved ${label.toLowerCase()}.`);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      await queryClient.invalidateQueries({ queryKey: ['reference-lists'] });
    },
  });
}

function Updated({ setting }: { setting: SettingRow }) {
  if (!setting.updated_by_name) return null;
  return (
    <p className="m-0 text-[12.5px] text-ink-3">
      Changed by {setting.updated_by_name} {formatRelative(setting.updated_at)}
    </p>
  );
}

function ListSetting({ setting }: { setting: SettingRow }) {
  const info = LIST_INFO[setting.key] ?? { title: setting.key, help: '' };
  const original = Array.isArray(setting.value) ? (setting.value as string[]) : [];
  const [values, setValues] = useState(original);
  const [adding, setAdding] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSaveSetting(setting, info.title);
  const dirty = JSON.stringify(values) !== JSON.stringify(original);
  const inputId = `add-${setting.key}`;

  const add = (event: FormEvent) => {
    event.preventDefault();
    const value = adding.trim();
    if (!value) return;
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      setProblem(`${value} is already on the list.`);
      return;
    }
    setValues([...values, value]);
    setAdding('');
    setProblem(null);
  };
  const submit = () => {
    const schema = settingValueSchema(setting.key);
    const issues = schema ? issuesOf(schema, values) : {};
    const first = Object.values(issues)[0];
    setProblem(first ?? null);
    if (!first) save.mutate(values);
  };

  return (
    <Panel title={info.title}>
      <p className="m-0 mb-[10px] text-[13px] text-ink-2">{info.help}</p>
      <ul
        className="m-0 p-0 list-none flex flex-wrap gap-[6px]"
        aria-label={`${info.title} values`}
      >
        {values.map((v) => (
          <li
            key={v}
            className="inline-flex items-center gap-[4px] h-[28px] pl-[10px] pr-[4px] rounded-pill border border-line-strong bg-surface text-[13px] text-ink"
          >
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => setValues(values.filter((x) => x !== v))}
              className="h-[22px] w-[22px] grid place-items-center rounded-pill bg-transparent border-0 text-ink-3 hover:bg-bg-alt hover:text-ink cursor-pointer"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-[12px] flex gap-[8px]">
        <label htmlFor={inputId} className="sr-only">
          Add to {info.title.toLowerCase()}
        </label>
        <Input
          id={inputId}
          value={adding}
          maxLength={120}
          placeholder="Add a value"
          onChange={(e) => setAdding(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          Add
        </Button>
      </form>
      {(problem || save.isError) && (
        <p role="alert" className="m-0 mt-[8px] text-[13px] text-danger">
          {problem ?? formError(save.error)}
        </p>
      )}
      <div className="mt-[12px] flex flex-wrap items-center justify-between gap-[8px]">
        <Updated setting={setting} />
        <div className="flex gap-[8px] ml-auto">
          {dirty && (
            <Button variant="ghost" onClick={() => setValues(original)}>
              Undo changes
            </Button>
          )}
          <Button variant="primary" size="sm" disabled={!dirty || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : `Save ${info.title.toLowerCase()}`}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function NumberSetting({ setting }: { setting: SettingRow }) {
  const info = NUMBER_INFO[setting.key] ?? { title: setting.key, help: '', unit: '' };
  const [value, setValue] = useState(String(setting.value ?? ''));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSaveSetting(setting, info.title);
  const inputId = `setting-${setting.key}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const schema = settingValueSchema(setting.key);
    const parsed = Number(value);
    const issue = schema ? Object.values(issuesOf(schema, parsed))[0] : undefined;
    setProblem(issue ?? null);
    if (!issue) save.mutate(parsed);
  };
  return (
    <Panel title={info.title}>
      <form onSubmit={submit} className="grid gap-[8px]">
        <label htmlFor={inputId} className="text-[13px] text-ink-2">
          {info.help}
        </label>
        <div className="flex items-center gap-[8px]">
          <Input
            id={inputId}
            type="number"
            className="w-[110px]"
            value={value}
            invalid={Boolean(problem)}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className="text-[14px] text-ink-2">{info.unit}</span>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="ml-auto"
            disabled={save.isPending || value === String(setting.value)}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {(problem || save.isError) && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {problem ?? formError(save.error)}
          </p>
        )}
        <Updated setting={setting} />
      </form>
    </Panel>
  );
}
