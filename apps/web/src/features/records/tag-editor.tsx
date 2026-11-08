import { useId, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type EntityType } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';

/** Tags on a record (PRD 3.4): shown as chips, edited in place, saved together. */
export function TagEditor({
  entityType,
  entityId,
  tags,
  canWrite,
  onSaved,
}: {
  entityType: EntityType;
  entityId: string;
  tags: string[];
  canWrite: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const listId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(tags);
  const [text, setText] = useState('');
  const known = useQuery({ queryKey: ['tags'], queryFn: api.listTags, enabled: editing });

  const save = useMutation({
    mutationFn: (next: string[]) => api.setTags(entityType, entityId, next),
    onSuccess: async () => {
      setEditing(false);
      toast('Tags saved.');
      await queryClient.invalidateQueries({ queryKey: ['tags'] });
      onSaved();
    },
  });

  const add = () => {
    const name = text.trim().toLowerCase();
    if (name && !draft.includes(name) && draft.length < 20) setDraft([...draft, name]);
    setText('');
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
    }
  };

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-[6px]">
        {tags.length === 0 && <span className="text-[13px] text-ink-3">No tags</span>}
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center h-[24px] px-[10px] rounded-pill bg-bg-alt text-[12.5px] text-ink-2"
          >
            {t}
          </span>
        ))}
        {canWrite && (
          <button
            type="button"
            onClick={() => {
              setDraft(tags);
              setEditing(true);
            }}
            className="bg-transparent border-0 p-0 text-[13px] font-semibold text-primary-ink cursor-pointer hover:underline"
          >
            Edit tags
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-[8px]">
      <div className="flex flex-wrap gap-[6px]">
        {draft.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-[4px] h-[26px] pl-[10px] pr-[4px] rounded-pill bg-tint text-[12.5px] text-primary-ink"
          >
            {t}
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              onClick={() => setDraft(draft.filter((d) => d !== t))}
              className="inline-flex items-center justify-center h-[20px] w-[20px] rounded-pill bg-transparent border-0 cursor-pointer text-primary-ink hover:bg-surface"
            >
              <X size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-[8px]">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          list={listId}
          maxLength={40}
          placeholder="Type a tag and press Enter"
          aria-label="Add a tag"
        />
        <datalist id={listId}>
          {(known.data ?? []).map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
        <Button variant="secondary" size="sm" onClick={add} disabled={!text.trim()}>
          Add
        </Button>
      </div>
      {save.isError && (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {errorMessage(save.error)}
        </p>
      )}
      <div className="flex gap-[8px]">
        <Button
          variant="primary"
          size="sm"
          disabled={save.isPending}
          onClick={() => {
            const pending = text.trim().toLowerCase();
            save.mutate(pending && !draft.includes(pending) ? [...draft, pending] : draft);
          }}
        >
          {save.isPending ? 'Saving…' : 'Save tags'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
