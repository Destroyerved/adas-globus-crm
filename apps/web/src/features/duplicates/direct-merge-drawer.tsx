import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type MergeEntity, type MergeView } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Drawer } from '@/components/ui/drawer.js';
import { Input } from '@/components/ui/input.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useMe } from '@/features/shared/list-kit.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { api } from '@/lib/api.js';
import { entityNoun } from './merge-kit.js';
import { MergeDone, MergeForm } from './merge-review.js';

interface CandidateOption {
  id: string;
  name: string;
  detail: string | null;
}

/**
 * Direct "Merge with…" button and drawer on Contact and Company profiles (PRD 4.9; ADR 0009).
 */
export function MergeWithButton({
  entity,
  recordId,
  recordName,
  onOpenRecord,
}: {
  entity: MergeEntity;
  recordId: string;
  recordName: string;
  onOpenRecord: (id: string) => void;
}) {
  const me = useMe();
  const queryClient = useQueryClient();
  const timeZone = me?.timezone ?? 'UTC';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [otherId, setOtherId] = useState<string | null>(null);
  const [keepOther, setKeepOther] = useState(false);
  const [merged, setMerged] = useState<MergeView | null>(null);

  const noun = entityNoun(entity).toLowerCase();

  const candidatesQuery = useQuery({
    queryKey: ['direct-merge-search', entity, query.trim()],
    queryFn: async (): Promise<CandidateOption[]> => {
      if (entity === 'contact') {
        const page = await api.listContacts({ q: query.trim() || undefined, limit: 15 });
        return page.items
          .filter((c) => c.id !== recordId)
          .map((c) => ({
            id: c.id,
            name: c.full_name,
            detail: [c.primary_email, c.company_name, c.title].filter(Boolean).join(' · '),
          }));
      }
      const page = await api.listCompanies({ q: query.trim() || undefined, limit: 15 });
      return page.items
        .filter((c) => c.id !== recordId)
        .map((c) => ({
          id: c.id,
          name: c.name,
          detail: [c.domain, c.city, c.market].filter(Boolean).join(' · '),
        }));
    },
    enabled: open && otherId === null && merged === null,
  });

  const reset = () => {
    setQuery('');
    setOtherId(null);
    setKeepOther(false);
    setMerged(null);
  };

  const close = () => {
    const completed = merged;
    setOpen(false);
    reset();
    if (completed && !completed.undoneAt) {
      onOpenRecord(completed.kept.id);
    }
  };

  const keptId = otherId ? (keepOther ? otherId : recordId) : recordId;
  const mergedId = otherId ? (keepOther ? recordId : otherId) : '';

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Merge with…
      </Button>

      <Drawer
        open={open}
        width={760}
        title={`Merge ${recordName}`}
        description={`Combine two ${noun} records, choose which field values stay, and carry across every linked activity, deal and task.`}
        onClose={close}
      >
        {merged ? (
          <MergeDone
            merge={merged}
            timeZone={timeZone}
            onBack={close}
            onOpenRecord={(_e, id) => {
              setOpen(false);
              reset();
              onOpenRecord(id);
            }}
          />
        ) : otherId ? (
          <div className="space-y-[16px]">
            <MergeForm
              key={`${keptId}-${mergedId}`}
              entity={entity}
              keptId={keptId}
              mergedId={mergedId}
              timeZone={timeZone}
              onSwap={() => setKeepOther((prev) => !prev)}
              onMerged={async (res) => {
                setMerged(res);
                await Promise.all([
                  queryClient.invalidateQueries({
                    queryKey: [entity === 'contact' ? 'contacts' : 'companies'],
                  }),
                  queryClient.invalidateQueries({ queryKey: [entity, res.kept.id] }),
                  queryClient.invalidateQueries({ queryKey: [entity, res.merged.id] }),
                ]);
              }}
              onDismissed={() => {
                setOtherId(null);
                setKeepOther(false);
              }}
              onOpenRecord={(_e, id) => {
                setOpen(false);
                reset();
                onOpenRecord(id);
              }}
            />
          </div>
        ) : (
          <div className="space-y-[14px]" data-testid="direct-merge-picker">
            <div>
              <label
                htmlFor={`merge-search-${entity}`}
                className="block text-label text-ink mb-[6px]"
              >
                Find another {noun} to merge with {recordName}
              </label>
              <Input
                id={`merge-search-${entity}`}
                type="search"
                value={query}
                placeholder={
                  entity === 'contact' ? 'Search by name or email…' : 'Search by firm or domain…'
                }
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {candidatesQuery.isPending ? (
              <LoadingState rows={4} />
            ) : candidatesQuery.isError ? (
              <ErrorState
                message={errorMessage(candidatesQuery.error)}
                onRetry={() => void candidatesQuery.refetch()}
              />
            ) : candidatesQuery.data.length === 0 ? (
              <EmptyState
                title={`No matching ${noun}s`}
                description={`Try a different search term to find the ${noun} you want to merge.`}
              />
            ) : (
              <ul className="m-0 p-0 list-none divide-y divide-line border border-line rounded-[10px]">
                {candidatesQuery.data.map((candidate) => (
                  <li
                    key={candidate.id}
                    className="px-[14px] py-[10px] flex flex-wrap items-center justify-between gap-[8px]"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-ink break-words">{candidate.name}</div>
                      {candidate.detail && (
                        <div className="text-[13px] text-ink-2 break-words">{candidate.detail}</div>
                      )}
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setOtherId(candidate.id);
                        setKeepOther(false);
                      }}
                    >
                      Compare
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
