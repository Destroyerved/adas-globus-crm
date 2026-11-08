import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button.js';
import { Panel } from '@/components/ui/panel.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
import { useMe } from '@/features/shared/list-kit.js';
import { formError } from '@/features/records/record-form.js';
import { FormRow, TimeZoneSelect } from './settings-kit.js';
import { viewerTimeZone } from '@/features/records/timeline.js';

/** Personal preferences anyone can change (PRD 4.1 user menu: time zone). */
export function PreferencesTab() {
  const me = useMe();
  const queryClient = useQueryClient();
  const toast = useToast();
  const saved = me?.timezone ?? '';
  const [zone, setZone] = useState(saved);
  const browserZone = viewerTimeZone();
  const save = useMutation({
    mutationFn: () => api.updatePreferences({ timezone: zone }),
    onSuccess: async () => {
      toast('Time zone saved.');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (zone) save.mutate();
  };
  return (
    <Panel title="Your time zone" className="max-w-[560px]">
      <form onSubmit={submit} className="grid gap-[12px]">
        <FormRow
          id="my-timezone"
          label="Time zone"
          hint="Tasks due today, overdue tasks and dashboard periods use this time zone."
          error={save.isError ? (formError(save.error) ?? undefined) : undefined}
        >
          <TimeZoneSelect id="my-timezone" value={zone || saved} onChange={setZone} />
        </FormRow>
        {browserZone && browserZone !== (zone || saved) && (
          <p className="m-0 text-[13px] text-ink-2">
            This device is set to {browserZone.replace(/_/g, ' ')}.{' '}
            <button
              type="button"
              onClick={() => setZone(browserZone)}
              className="bg-transparent border-0 p-0 font-semibold text-primary-ink cursor-pointer hover:underline"
            >
              Use it
            </button>
          </p>
        )}
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={save.isPending || !zone || zone === saved}
          >
            {save.isPending ? 'Saving…' : 'Save time zone'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
