import { useId, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input.js';
import { api } from '@/lib/api.js';
import { useDebounced } from './list-kit.js';

export interface PickedCompany {
  id: string;
  name: string;
}

/**
 * Search-as-you-type company picker (a combobox): asks the server for the first matches
 * instead of loading every company, so it stays fast with tens of thousands of firms.
 */
export function CompanyPicker({
  value,
  onChange,
  label = 'Company',
  name,
}: {
  value: PickedCompany | null;
  onChange: (company: PickedCompany | null) => void;
  label?: string;
  /** When set, a hidden input carries the chosen id in a plain form submit. */
  name?: string;
}) {
  const listId = useId();
  const [text, setText] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim());
  const results = useQuery({
    queryKey: ['company-picker', q],
    queryFn: () => api.listCompanies({ q, limit: 8, sort: 'name' }),
    enabled: open && q.length >= 1,
  });
  const options = results.data?.items ?? [];

  const choose = (company: PickedCompany | null) => {
    onChange(company);
    setText(company?.name ?? '');
    setOpen(false);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || options.length === 0) {
      if (event.key === 'ArrowDown') setOpen(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const pick = options[active];
      if (pick) choose({ id: pick.id, name: pick.name });
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      {name && <input type="hidden" name={name} value={value?.id ?? ''} />}
      <Input
        role="combobox"
        aria-label={label}
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        value={text}
        placeholder="Type to search companies"
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
          if (value && e.target.value !== value.name) onChange(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKey}
      />
      {open && options.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} results`}
          style={{ boxShadow: 'var(--shadow-pop)' }}
          className="absolute z-20 left-0 right-0 mt-[4px] m-0 p-[4px] list-none bg-surface border border-line rounded-[8px] max-h-[240px] overflow-y-auto"
        >
          {options.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose({ id: c.id, name: c.name });
              }}
              className={`px-[10px] py-[6px] rounded-[6px] cursor-pointer text-[14px] ${i === active ? 'bg-tint text-ink' : 'text-ink hover:bg-bg-alt'}`}
            >
              <div className="font-semibold">{c.name}</div>
              <div className="text-[12.5px] text-ink-3">
                {[c.domain, c.market].filter(Boolean).join(' · ')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
