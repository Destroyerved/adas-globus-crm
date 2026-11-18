import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SendInboxEmailInputSchema, type InboxThreadDetail } from '@adas/shared';
import { Input } from '@/components/ui/input.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
import {
  EditDrawer,
  formError,
  issuesOf,
  serverFieldErrors,
} from '@/features/records/record-form.js';
import { FormRow } from '@/features/settings/settings-kit.js';

export function ComposeEmailDrawer({
  open,
  onClose,
  initialToEmail = '',
  initialSubject = '',
  contactId = null,
  companyId = null,
  dealId = null,
  leadId = null,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  initialToEmail?: string;
  initialSubject?: string;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  leadId?: string | null;
  onSent?: (detail: InboxThreadDetail) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [toEmail, setToEmail] = useState(initialToEmail);
  const [ccText, setCcText] = useState('');
  const [subject, setSubject] = useState(initialSubject);
  const [bodyText, setBodyText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const templatesQuery = useQuery({
    queryKey: ['inbox-templates'],
    queryFn: api.listInboxTemplates,
    enabled: open,
  });

  const sendMutation = useMutation({
    mutationFn: () => {
      const ccEmails = ccText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return api.sendInboxEmail({
        toEmail: toEmail.trim(),
        ccEmails,
        subject: subject.trim(),
        bodyText: bodyText.trim(),
        contactId,
        companyId,
        dealId,
        leadId,
        templateId: templateId || null,
      });
    },
    onSuccess: async (detail) => {
      toast('Email sent.');
      setClientErrors({});
      setSubject('');
      setBodyText('');
      setCcText('');
      setTemplateId('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox-threads'] }),
        queryClient.invalidateQueries({ queryKey: ['inbox-mailbox'] }),
        ...(contactId
          ? [
              queryClient.invalidateQueries({ queryKey: ['contact', contactId] }),
              queryClient.invalidateQueries({ queryKey: ['timeline', 'contact', contactId] }),
            ]
          : []),
        ...(companyId
          ? [
              queryClient.invalidateQueries({ queryKey: ['company', companyId] }),
              queryClient.invalidateQueries({ queryKey: ['timeline', 'company', companyId] }),
            ]
          : []),
        ...(dealId
          ? [
              queryClient.invalidateQueries({ queryKey: ['deal', dealId] }),
              queryClient.invalidateQueries({ queryKey: ['timeline', 'deal', dealId] }),
            ]
          : []),
        ...(leadId
          ? [
              queryClient.invalidateQueries({ queryKey: ['lead', leadId] }),
              queryClient.invalidateQueries({ queryKey: ['timeline', 'lead', leadId] }),
            ]
          : []),
      ]);
      onSent?.(detail);
      onClose();
    },
  });

  if (!open) return null;

  const errors = { ...serverFieldErrors(sendMutation.error), ...clientErrors };

  const applyTemplate = (selectedId: string) => {
    setTemplateId(selectedId);
    const tpl = templatesQuery.data?.find((t) => t.id === selectedId);
    if (tpl) {
      if (!subject.trim()) setSubject(tpl.subject);
      setBodyText(tpl.bodyText);
    }
  };

  const handleSubmit = () => {
    const ccEmails = ccText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const payload = {
      toEmail: toEmail.trim(),
      ccEmails,
      subject: subject.trim(),
      bodyText: bodyText.trim(),
      contactId,
      companyId,
      dealId,
      leadId,
      templateId: templateId || null,
    };
    const errs = issuesOf(SendInboxEmailInputSchema, payload);
    if (Object.keys(errs).length > 0) {
      setClientErrors(errs);
      return;
    }
    setClientErrors({});
    sendMutation.mutate();
  };

  return (
    <EditDrawer
      formId="compose-inbox-email-form"
      title="Compose email"
      submitLabel="Send email"
      pending={sendMutation.isPending}
      error={formError(sendMutation.error)}
      onClose={onClose}
      onSubmit={handleSubmit}
    >
      <FormRow id="compose-template" label="Template (optional)">
        <Select
          id="compose-template"
          value={templateId}
          onChange={(e) => applyTemplate(e.target.value)}
        >
          <option value="">Write from scratch</option>
          {(templatesQuery.data ?? []).map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name} ({tpl.market})
            </option>
          ))}
        </Select>
      </FormRow>

      <FormRow id="compose-to" label="To" error={errors['toEmail']}>
        <Input
          id="compose-to"
          type="email"
          value={toEmail}
          onChange={(e) => setToEmail(e.target.value)}
          invalid={Boolean(errors['toEmail'])}
          placeholder="partner@firm.com"
        />
      </FormRow>

      <FormRow id="compose-cc" label="Cc (optional)" error={errors['ccEmails']}>
        <Input
          id="compose-cc"
          value={ccText}
          onChange={(e) => setCcText(e.target.value)}
          invalid={Boolean(errors['ccEmails'])}
          placeholder="Comma-separated addresses"
        />
      </FormRow>

      <FormRow id="compose-subject" label="Subject" error={errors['subject']}>
        <Input
          id="compose-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          invalid={Boolean(errors['subject'])}
          placeholder="3-day tax & accounting trial"
        />
      </FormRow>

      <FormRow
        id="compose-body"
        label="Message"
        error={errors['bodyText']}
        hint="Personalisation tags like {{first_name}} and {{company_name}} fill in automatically."
      >
        <Textarea
          id="compose-body"
          rows={8}
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          invalid={Boolean(errors['bodyText'])}
          placeholder="Write your message…"
        />
      </FormRow>
    </EditDrawer>
  );
}
