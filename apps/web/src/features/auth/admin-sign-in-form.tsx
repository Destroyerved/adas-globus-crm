import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { BreakGlassLoginInputSchema, type BreakGlassLoginInput } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { api } from '@/lib/api.js';
import { formError, issuesOf, serverFieldErrors } from '@/features/records/record-form.js';

/**
 * Emergency admin sign-in (PRD 6.6; DESIGN 6.14): password plus authenticator code, for when
 * Microsoft sign-in is down. The shared schema checks the fields first; the server answers
 * every wrong detail the same way, so the message never says which part was wrong.
 */
export function AdminSignInForm({
  onSignedIn,
  onCancel,
}: {
  onSignedIn: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [values, setValues] = useState<BreakGlassLoginInput>({
    email: '',
    password: '',
    totpCode: '',
  });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const signIn = useMutation({ mutationFn: api.adminSignIn, onSuccess: onSignedIn });
  const errors = { ...serverFieldErrors(signIn.error), ...issues };
  const message = signIn.error && Object.keys(errors).length === 0 ? formError(signIn.error) : null;

  const set = (field: keyof BreakGlassLoginInput) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setIssues((i) => {
      const { [field]: _removed, ...rest } = i;
      return rest;
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = issuesOf(BreakGlassLoginInputSchema, values);
    setIssues(found);
    if (Object.keys(found).length > 0) {
      document.getElementById(`${id}-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    signIn.reset();
    signIn.mutate(BreakGlassLoginInputSchema.parse(values));
  };

  const field = (
    name: keyof BreakGlassLoginInput,
    label: string,
    props: Partial<React.InputHTMLAttributes<HTMLInputElement>>,
  ) => (
    <div className="grid gap-[6px]">
      <label htmlFor={`${id}-${name}`} className="text-label text-ink">
        {label}
      </label>
      <Input
        id={`${id}-${name}`}
        name={name}
        value={values[name]}
        onChange={(e) => set(name)(e.target.value)}
        invalid={Boolean(errors[name])}
        aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
        {...props}
      />
      {errors[name] && (
        <p id={`${id}-${name}-error`} className="m-0 text-[13px] text-danger">
          {errors[name]}
        </p>
      )}
    </div>
  );

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby={`${id}-title`}
      className="grid gap-[14px]"
      data-testid="admin-sign-in-form"
    >
      <div>
        <div className="kicker mb-[8px]">Emergency access</div>
        <h2 id={`${id}-title`} className="text-title-lg text-ink m-0">
          Admin sign-in
        </h2>
        <p className="text-body text-ink-2 mt-[6px] mb-[4px]">
          For emergencies, when Microsoft sign-in isn’t working. Every use alerts all admins.
        </p>
      </div>
      {field('email', 'Email', { type: 'email', autoComplete: 'username', autoFocus: true })}
      {field('password', 'Password', { type: 'password', autoComplete: 'current-password' })}
      {field('totpCode', 'Code from your authenticator app', {
        inputMode: 'numeric',
        autoComplete: 'one-time-code',
        maxLength: 6,
        pattern: '[0-9]*',
        className: 'tabular-nums tracking-[0.2em]',
      })}
      {message && (
        <p role="alert" className="m-0 text-[13.5px] text-danger">
          {message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-[12px]">
        <Button type="submit" variant="primary" disabled={signIn.isPending}>
          {signIn.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Back to Microsoft sign-in
        </Button>
      </div>
    </form>
  );
}
