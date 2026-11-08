import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button.js';
import { Drawer } from '@/components/ui/drawer.js';
import { ApiError } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';

/**
 * Edit forms in a drawer (DESIGN 6.2, 6.11). Only changed fields are sent, with the record's
 * version so a stale edit is refused (PRD 6.7). The shared zod schema checks the payload
 * before it leaves the browser, and server field errors land on the same fields.
 */

export type Values = Record<string, unknown>;

/** The part of a zod schema these helpers use (the schemas live in @adas/shared). */
interface SafeParser {
  safeParse(
    input: unknown,
  ):
    | { success: true }
    | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
}

export function changedFields(initial: Values, values: Values, nullable: readonly string[] = []) {
  const out: Values = {};
  for (const key of Object.keys(values)) {
    if (JSON.stringify(values[key]) === JSON.stringify(initial[key])) continue;
    const value = values[key];
    out[key] =
      nullable.includes(key) && typeof value === 'string' && value.trim() === '' ? null : value;
  }
  return out;
}

export function issuesOf(schema: SafeParser, payload: unknown): Record<string, string> {
  const result = schema.safeParse(payload);
  if (result.success) return {};
  const out: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_root';
    out[key] ??= issue.message;
  }
  return out;
}

export function serverFieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(err.fieldErrors)) {
    if (messages[0]) out[key] = messages[0];
  }
  return out;
}

export function formError(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
    return 'Someone else changed this record while you were editing. Close this form and open it again to see their changes.';
  }
  return errorMessage(err);
}

export function useDraft<V extends Values>(initial: V) {
  const [values, setValues] = useState<V>(initial);
  const set = <K extends keyof V>(key: K, value: V[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));
  return { values, set };
}

/** Drawer with a form body and Save/Cancel in the footer. */
export function EditDrawer({
  title,
  description,
  formId,
  pending,
  error,
  onClose,
  onSubmit,
  submitLabel = 'Save changes',
  children,
}: {
  title: string;
  description?: string;
  formId: string;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel?: string;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <Drawer
      open
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={pending}>
            {pending ? 'Saving…' : submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="grid gap-[14px]">
        {children}
        {error && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {error}
          </p>
        )}
      </form>
    </Drawer>
  );
}

/** A group of checkboxes for list fields such as services or software. */
export function CheckboxGroup({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const all = [...options, ...value.filter((v) => !options.includes(v))];
  return (
    <fieldset className="m-0 p-0 border-0 grid gap-[6px]">
      <legend className="text-label text-ink mb-[6px]">{legend}</legend>
      <div className="flex flex-wrap gap-[6px]">
        {all.map((option) => {
          const checked = value.includes(option);
          return (
            <label
              key={option}
              className={`inline-flex items-center gap-[6px] h-[30px] px-[10px] rounded-pill border text-[13px] cursor-pointer ${checked ? 'bg-tint border-primary text-primary-ink' : 'bg-surface border-line text-ink-2 hover:bg-bg-alt'}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...value, option] : value.filter((v) => v !== option),
                  )
                }
                className="accent-[var(--primary)]"
              />
              {option}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
