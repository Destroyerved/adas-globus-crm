import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AddContactEmailInputSchema,
  AddContactPhoneInputSchema,
  PHONE_LABELS,
  type PhoneLabel,
} from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type ContactProfile } from '@/lib/api.js';
import { formError, issuesOf, serverFieldErrors } from '@/features/records/record-form.js';
import { VERIFICATION_TONE } from './contacts-screen.js';

const PHONE_LABEL_TEXT: Record<PhoneLabel, string> = {
  work: 'Work',
  mobile: 'Mobile',
  direct: 'Direct',
  other: 'Other',
};

/**
 * Contact emails & phones panel (PRD 4.4): add secondary addresses/numbers, promote to primary,
 * or remove non-primary channels.
 */
export function ContactChannelsPanel({
  contactId,
  primaryEmail,
  emails,
  phones,
  canWrite,
  onChanged,
}: {
  contactId: string;
  primaryEmail: string;
  emails: ContactProfile['emails'];
  phones: ContactProfile['phones'];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [newEmail, setNewEmail] = useState('');
  const [emailErr, setEmailErr] = useState<string | null>(null);

  const [newPhone, setNewPhone] = useState('');
  const [phoneLabel, setPhoneLabel] = useState<PhoneLabel>('work');
  const [phoneErr, setPhoneErr] = useState<string | null>(null);

  const allEmails =
    emails.length > 0
      ? emails
      : [{ email: primaryEmail, is_primary: true, verification_status: 'unknown' }];

  const addEmail = useMutation({
    mutationFn: (email: string) => api.addContactEmail(contactId, { email, makePrimary: false }),
    onSuccess: () => {
      setNewEmail('');
      setEmailErr(null);
      toast('Added email address.');
      onChanged();
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      setEmailErr(fields['email'] ?? formError(err));
    },
  });

  const makePrimaryEmail = useMutation({
    mutationFn: (email: string) => api.setPrimaryContactEmail(contactId, { email }),
    onSuccess: () => {
      toast('Updated primary email.');
      onChanged();
    },
  });

  const removeEmail = useMutation({
    mutationFn: (email: string) => api.removeContactEmail(contactId, email),
    onSuccess: () => {
      toast('Removed secondary email.');
      onChanged();
    },
  });

  const addPhone = useMutation({
    mutationFn: ({ phone, label }: { phone: string; label: PhoneLabel }) =>
      api.addContactPhone(contactId, {
        phone,
        label,
        makePrimary: phones.length === 0,
      }),
    onSuccess: () => {
      setNewPhone('');
      setPhoneErr(null);
      toast('Added phone number.');
      onChanged();
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      setPhoneErr(fields['phone'] ?? formError(err));
    },
  });

  const makePrimaryPhone = useMutation({
    mutationFn: (phoneE164: string) => api.setPrimaryContactPhone(contactId, { phoneE164 }),
    onSuccess: () => {
      toast('Updated primary phone.');
      onChanged();
    },
  });

  const removePhone = useMutation({
    mutationFn: (phoneE164: string) => api.removeContactPhone(contactId, phoneE164),
    onSuccess: () => {
      toast('Removed phone number.');
      onChanged();
    },
  });

  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    const payload = { email: newEmail.trim(), makePrimary: false };
    const issues = issuesOf(AddContactEmailInputSchema, payload);
    if (issues['email']) {
      setEmailErr(issues['email']);
      return;
    }
    setEmailErr(null);
    addEmail.mutate(payload.email);
  };

  const submitPhone = (event: FormEvent) => {
    event.preventDefault();
    const payload = { phone: newPhone.trim(), label: phoneLabel, makePrimary: false };
    const issues = issuesOf(AddContactPhoneInputSchema, payload);
    if (issues['phone']) {
      setPhoneErr(issues['phone']);
      return;
    }
    setPhoneErr(null);
    addPhone.mutate({ phone: payload.phone, label: phoneLabel });
  };

  return (
    <Panel title="Emails & phones" padded>
      <div className="space-y-[16px]" data-testid="contact-channels-panel">
        <div className="space-y-[8px]">
          <div className="text-label text-ink">Email addresses</div>
          <ul className="m-0 p-0 list-none divide-y divide-line">
            {allEmails.map((item) => (
              <li
                key={item.email}
                className="py-[8px] first:pt-0 last:pb-0 flex flex-wrap items-center justify-between gap-[8px]"
              >
                <div className="min-w-0 flex flex-wrap items-center gap-[6px]">
                  <span className="text-[14px] text-ink break-all">{item.email}</span>
                  {item.is_primary && <StatusBadge tone="brand">Primary</StatusBadge>}
                  {item.verification_status in VERIFICATION_TONE && (
                    <StatusBadge
                      tone={
                        VERIFICATION_TONE[
                          item.verification_status as keyof typeof VERIFICATION_TONE
                        ]
                      }
                    >
                      {item.verification_status}
                    </StatusBadge>
                  )}
                </div>
                {canWrite && !item.is_primary && (
                  <div className="flex flex-wrap gap-[6px]">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={makePrimaryEmail.isPending}
                      onClick={() => makePrimaryEmail.mutate(item.email)}
                    >
                      Make primary
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={removeEmail.isPending}
                      aria-label={`Remove ${item.email}`}
                      onClick={() => removeEmail.mutate(item.email)}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {canWrite && (
            <form onSubmit={submitEmail} noValidate className="flex flex-wrap gap-[8px] pt-[4px]">
              <label htmlFor="contact-add-email" className="sr-only">
                Add secondary email
              </label>
              <Input
                id="contact-add-email"
                type="email"
                className="flex-1 min-w-[180px]"
                value={newEmail}
                invalid={Boolean(emailErr)}
                placeholder="Add another email…"
                onChange={(e) => setNewEmail(e.target.value)}
              />
              <Button type="submit" variant="secondary" size="sm" disabled={addEmail.isPending}>
                {addEmail.isPending ? 'Adding…' : 'Add email'}
              </Button>
            </form>
          )}
          {emailErr && (
            <p role="alert" className="m-0 text-[12.5px] text-danger">
              {emailErr}
            </p>
          )}
        </div>

        <div className="space-y-[8px] pt-[12px] border-t border-line">
          <div className="text-label text-ink">Phone numbers</div>
          {phones.length === 0 ? (
            <p className="m-0 text-[13.5px] text-ink-2">No phone numbers recorded.</p>
          ) : (
            <ul className="m-0 p-0 list-none divide-y divide-line">
              {phones.map((p) => (
                <li
                  key={p.phone_e164}
                  className="py-[8px] first:pt-0 last:pb-0 flex flex-wrap items-center justify-between gap-[8px]"
                >
                  <div className="min-w-0 flex flex-wrap items-center gap-[6px]">
                    <span className="text-[14px] text-ink tabular-nums">{p.phone_e164}</span>
                    <span className="text-[12.5px] text-ink-3">
                      ({PHONE_LABEL_TEXT[p.phone_label as PhoneLabel] ?? p.phone_label})
                    </span>
                    {p.is_primary && <StatusBadge tone="brand">Primary</StatusBadge>}
                  </div>
                  {canWrite && (
                    <div className="flex flex-wrap gap-[6px]">
                      {!p.is_primary && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={makePrimaryPhone.isPending}
                          onClick={() => makePrimaryPhone.mutate(p.phone_e164)}
                        >
                          Make primary
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={removePhone.isPending}
                        aria-label={`Remove ${p.phone_e164}`}
                        onClick={() => removePhone.mutate(p.phone_e164)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canWrite && (
            <form onSubmit={submitPhone} noValidate className="flex flex-wrap gap-[8px] pt-[4px]">
              <Select
                aria-label="Phone label"
                className="w-[106px] shrink-0"
                value={phoneLabel}
                onChange={(e) => setPhoneLabel(e.target.value as PhoneLabel)}
              >
                {PHONE_LABELS.map((lbl) => (
                  <option key={lbl} value={lbl}>
                    {PHONE_LABEL_TEXT[lbl]}
                  </option>
                ))}
              </Select>
              <label htmlFor="contact-add-phone" className="sr-only">
                Add phone number
              </label>
              <Input
                id="contact-add-phone"
                type="tel"
                className="flex-1 min-w-[160px]"
                value={newPhone}
                invalid={Boolean(phoneErr)}
                placeholder="+1 416 555 0140"
                onChange={(e) => setNewPhone(e.target.value)}
              />
              <Button type="submit" variant="secondary" size="sm" disabled={addPhone.isPending}>
                {addPhone.isPending ? 'Adding…' : 'Add phone'}
              </Button>
            </form>
          )}
          {phoneErr && (
            <p role="alert" className="m-0 text-[12.5px] text-danger">
              {phoneErr}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
