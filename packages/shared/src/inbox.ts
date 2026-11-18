import { z } from 'zod';
import { MarketSchema } from './enums.js';

// ---------------------------------------------------------------------------
// HTML Sanitisation & Remote Image Blocking (PRD 9, DESIGN 6.10)
// ---------------------------------------------------------------------------

const STRIP_BLOCK_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'frameset',
  'noscript',
  'svg',
  'math',
];

const STRIP_VOID_OR_FORM_TAGS = [
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'meta',
  'link',
  'base',
  'frame',
];

export interface SanitizedEmailHtml {
  html: string;
  hasRemoteImages: boolean;
}

/**
 * Sanitises untrusted synced HTML email on input (PRD 9):
 * - Removes active/executable tags (`<script>`, `<style>`, `<iframe>`, `<svg>`, `<form>`, etc.).
 * - Strips inline event handlers (`on*`), `srcdoc`, and `javascript:` / `vbscript:` / `data:text/html` URLs.
 * - Rewrites remote `<img src="https://...">` to `data-remote-url="..."` so remote tracking pixels
 *   and external images never load until the viewer clicks "Load remote images".
 */
export function sanitizeEmailHtml(rawHtml: string): SanitizedEmailHtml {
  if (!rawHtml || !rawHtml.trim()) {
    return { html: '', hasRemoteImages: false };
  }

  let html = rawHtml;

  // 1. Strip dangerous paired elements and their inner content
  for (const tag of STRIP_BLOCK_TAGS) {
    const blockRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    html = html.replace(blockRe, '');
    const selfRe = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    html = html.replace(selfRe, '');
  }

  // 2. Strip form/navigation/meta tags (keep inner text if paired)
  for (const tag of STRIP_VOID_OR_FORM_TAGS) {
    const openCloseRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    html = html.replace(openCloseRe, '');
  }

  // 3. Strip HTML comments
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 4. Strip inline event handlers (`onclick=...`, `onerror=...`) and `srcdoc` / `formaction`
  html = html.replace(
    /\s+(?:on[a-z0-9_-]+|srcdoc|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    '',
  );

  // 5. Neutralise dangerous URI schemes in `href` / `src` / `xlink:href` / `background`
  html = html.replace(
    /\b(href|src|background)\s*=\s*(?:"\s*(?:javascript|vbscript|file|data\s*:\s*text\/html)[^"]*"|'\s*(?:javascript|vbscript|file|data\s*:\s*text\/html)[^']*'|(?:\s*(?:javascript|vbscript|file|data\s*:\s*text\/html)[^\s>]*))/gi,
    '$1="#"',
  );

  // 6. Strip CSS `expression(...)` or `url(...)` inside inline `style` attributes so inline styles
  //    cannot fetch remote tracking beacons.
  html = html.replace(/\bstyle\s*=\s*"([^"]*)"/gi, (_match, css: string) => {
    const cleaned = css
      .replace(/expression\s*\([^)]*\)/gi, '')
      .replace(/url\s*\([^)]*\)/gi, 'none')
      .trim();
    return cleaned ? `style="${cleaned}"` : '';
  });
  html = html.replace(/\bstyle\s*=\s*'([^']*)'/gi, (_match, css: string) => {
    const cleaned = css
      .replace(/expression\s*\([^)]*\)/gi, '')
      .replace(/url\s*\([^)]*\)/gi, 'none')
      .trim();
    return cleaned ? `style="${cleaned}"` : '';
  });

  // 7. Block remote `<img src="http(s)://...">` or `//...` until user clicks "Load remote images"
  let hasRemoteImages = false;
  html = html.replace(/<img\b([^>]*)>/gi, (full, attrs: string) => {
    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!srcMatch) return full;
    const rawSrc = (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '').trim();
    const normalizedSrc = rawSrc.startsWith('//') ? `https:${rawSrc}` : rawSrc;
    if (/^https?:\/\//i.test(normalizedSrc)) {
      hasRemoteImages = true;
      const safeUrl = normalizedSrc.replace(/"/g, '&quot;');
      const withoutSrc = attrs.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '').trim();
      return `<img data-remote-url="${safeUrl}" ${withoutSrc}>`;
    }
    // Block non-image `data:` or unknown protocols on `<img>`
    if (!/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(rawSrc)) {
      const withoutSrc = attrs.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '').trim();
      return `<img ${withoutSrc}>`;
    }
    return full;
  });

  // 8. Ensure `<a ...>` links open safely outside the sandboxed iframe
  html = html.replace(/<a\b([^>]*)>/gi, (_full, attrs: string) => {
    const cleaned = attrs
      .replace(/\btarget\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\brel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .trim();
    return `<a ${cleaned} target="_blank" rel="noopener noreferrer">`;
  });

  return { html: html.trim(), hasRemoteImages };
}

/**
 * Restores `src="https://..."` on `<img>` tags whose `data-remote-url` holds an HTTP(S) URL,
 * called only after explicit user consent ("Load remote images").
 */
export function activateRemoteImages(sanitizedHtml: string): string {
  return sanitizedHtml.replace(
    /\bdata-remote-url\s*=\s*"(https?:\/\/[^"]+)"/gi,
    'src="$1" referrerpolicy="no-referrer"',
  );
}

// ---------------------------------------------------------------------------
// Template Variable Rendering (PRD 4.11, 4.12, 4.13)
// ---------------------------------------------------------------------------

export interface EmailTemplateVariables {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  companyName?: string | null;
  senderName?: string | null;
  senderEmail?: string | null;
}

/**
 * Renders `{{key}}` and `{{key|fallback}}` placeholders for Inbox, Sequence, and Campaign copy.
 * Supports both flat (`{{first_name}}`, `{{company_name}}`) and dotted (`{{contact.first_name}}`,
 * `{{company.name}}`) tokens used in seeded templates.
 */
export function renderEmailTemplate(template: string, vars: EmailTemplateVariables): string {
  const full = (vars.fullName ?? '').trim();
  const inferredFirst = full ? (full.split(/\s+/)[0] ?? '') : '';
  const inferredLast = full ? full.split(/\s+/).slice(1).join(' ') : '';
  const firstName = (vars.firstName ?? inferredFirst).trim();
  const lastName = (vars.lastName ?? inferredLast).trim();
  const fullName = full || [firstName, lastName].filter(Boolean).join(' ');
  const companyName = (vars.companyName ?? '').trim();
  const senderName = (vars.senderName ?? '').trim();
  const senderEmail = (vars.senderEmail ?? '').trim();

  const lookup: Record<string, string> = {
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    company_name: companyName,
    sender_name: senderName,
    sender_email: senderEmail,
    'contact.first_name': firstName,
    'contact.last_name': lastName,
    'contact.full_name': fullName,
    'company.name': companyName,
    'sender.name': senderName,
    'sender.email': senderEmail,
  };

  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)(?:\|([^}]*))?\s*\}\}/g, (_m, rawKey, fb) => {
    const key = String(rawKey).toLowerCase();
    const val = lookup[key] ?? '';
    if (val) return val;
    return typeof fb === 'string' ? fb.trim() : '';
  });
}

// ---------------------------------------------------------------------------
// Non-Delivery Report (DSN 5.x.x) Hard Bounce Parser (PRD 8.3)
// ---------------------------------------------------------------------------

export interface DsnBounceResult {
  isHardBounce: boolean;
  bouncedAddress: string | null;
  statusCode: string | null;
}

const NDR_SENDER_RE = /^(?:postmaster|mailer-daemon|mail-daemon|noreply-dmarc|bounce)@/i;
const NDR_SUBJECT_RE =
  /\b(?:undeliverable|delivery status notification|mail delivery failed|returned mail|failure notice)\b/i;

export function parseDsnHardBounce(input: {
  fromEmail: string;
  subject: string;
  bodyText: string;
  headers?: Record<string, string>;
}): DsnBounceResult {
  const from = input.fromEmail.trim().toLowerCase();
  const isNdrEnvelope =
    NDR_SENDER_RE.test(from) ||
    NDR_SUBJECT_RE.test(input.subject) ||
    Boolean(input.headers?.['x-failed-recipients']);

  if (!isNdrEnvelope) {
    return { isHardBounce: false, bouncedAddress: null, statusCode: null };
  }

  const combined = [
    input.headers?.['diagnostic-code'] ?? '',
    input.headers?.['status'] ?? '',
    input.bodyText,
  ].join('\n');

  const statusMatch = combined.match(/\b(5\.\d{1,3}\.\d{1,3})\b/);
  if (!statusMatch?.[1]) {
    return { isHardBounce: false, bouncedAddress: null, statusCode: null };
  }

  const headerRecipient = input.headers?.['x-failed-recipients']?.trim();
  const finalRecipientMatch = combined.match(
    /(?:Final-Recipient|Original-Recipient)\s*:\s*(?:rfc822\s*;\s*)?([^\s<>]+@[^\s<>]+)/i,
  );
  const bodyEmailMatch = input.bodyText.match(
    /(?:could not be delivered to|delivery has failed to these recipients[^:]*:|recipient address rejected[^:]*:)\s*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/i,
  );

  const candidate = (headerRecipient || finalRecipientMatch?.[1] || bodyEmailMatch?.[1] || '')
    .trim()
    .toLowerCase();

  return {
    isHardBounce: true,
    bouncedAddress: candidate && !NDR_SENDER_RE.test(candidate) ? candidate : null,
    statusCode: statusMatch[1],
  };
}

// ---------------------------------------------------------------------------
// Zod Request & Response Schemas for Inbox API (PRD 4.11, 8.2)
// ---------------------------------------------------------------------------

export const InboxThreadStatusSchema = z.enum(['open', 'replied', 'archived']);
export type InboxThreadStatus = z.infer<typeof InboxThreadStatusSchema>;

export const InboxThreadFilterStatusSchema = z.enum(['all', 'open', 'replied', 'archived']);
export type InboxThreadFilterStatus = z.infer<typeof InboxThreadFilterStatusSchema>;

export const InboxThreadQuerySchema = z.object({
  status: InboxThreadFilterStatusSchema.default('all'),
  q: z.string().trim().max(200).optional(),
  contactId: z.string().trim().min(1).optional(),
  companyId: z.string().trim().min(1).optional(),
  dealId: z.string().trim().min(1).optional(),
  leadId: z.string().trim().min(1).optional(),
  cursor: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type InboxThreadQuery = z.infer<typeof InboxThreadQuerySchema>;

export const SendInboxEmailInputSchema = z.object({
  toEmail: z.string().trim().email().max(320),
  ccEmails: z.array(z.string().trim().email().max(320)).max(10).default([]),
  subject: z.string().trim().min(1, 'Enter a subject line.').max(300),
  bodyText: z.string().trim().min(1, 'Write a message before sending.').max(50_000),
  contactId: z.string().trim().min(1).nullable().optional(),
  companyId: z.string().trim().min(1).nullable().optional(),
  dealId: z.string().trim().min(1).nullable().optional(),
  leadId: z.string().trim().min(1).nullable().optional(),
  templateId: z.string().trim().min(1).nullable().optional(),
});
export type SendInboxEmailInput = z.infer<typeof SendInboxEmailInputSchema>;

export const ReplyInboxThreadInputSchema = z.object({
  bodyText: z.string().trim().min(1, 'Write a reply before sending.').max(50_000),
  ccEmails: z.array(z.string().trim().email().max(320)).max(10).default([]),
  templateId: z.string().trim().min(1).nullable().optional(),
});
export type ReplyInboxThreadInput = z.infer<typeof ReplyInboxThreadInputSchema>;

export const UpdateInboxThreadInputSchema = z.object({
  status: InboxThreadStatusSchema.optional(),
  markRead: z.boolean().optional(),
  dealId: z.string().trim().min(1).nullable().optional(),
});
export type UpdateInboxThreadInput = z.infer<typeof UpdateInboxThreadInputSchema>;

export const CreateTaskFromEmailInputSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  dueAt: z.string().datetime().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  assigneeUserId: z.string().trim().min(1).optional(),
});
export type CreateTaskFromEmailInput = z.infer<typeof CreateTaskFromEmailInputSchema>;

export const ManualLinkEmailInputSchema = z.object({
  providerMessageId: z.string().trim().min(1).max(500),
  contactId: z.string().trim().min(1).nullable().optional(),
  companyId: z.string().trim().min(1).nullable().optional(),
  dealId: z.string().trim().min(1).nullable().optional(),
});
export type ManualLinkEmailInput = z.infer<typeof ManualLinkEmailInputSchema>;

export const CreateEmailTemplateInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a template name.').max(160),
  category: z.enum(['inbox', 'sequence', 'campaign', 'outreach']).default('inbox'),
  market: MarketSchema.default('US'),
  subject: z.string().trim().min(1, 'Enter a subject line.').max(300),
  bodyText: z.string().trim().min(1, 'Enter the template body.').max(50_000),
  shared: z.boolean().default(true),
});
export type CreateEmailTemplateInput = z.infer<typeof CreateEmailTemplateInputSchema>;

export interface MailboxStatusView {
  connected: boolean;
  status: 'connected' | 'Needs Reconnect' | 'disconnected' | 'not_connected';
  email: string | null;
  provider: 'microsoft_graph' | null;
  entraConfigured: boolean;
  mailLive: boolean;
  dailySendCap: number;
  sentTodayCount: number;
  lastSyncedAt: string | null;
  inboxSubscriptionExpiresAt: string | null;
  sentSubscriptionExpiresAt: string | null;
  retryAfterAt: string | null;
  lastError: string | null;
}

export interface AdminMailboxRow {
  id: string;
  userId: string;
  userName: string;
  email: string;
  status: string;
  dailySendCap: number;
  sentTodayCount: number;
  lastSyncedAt: string | null;
  inboxSubscriptionExpiresAt: string | null;
  retryAfterAt: string | null;
  lastError: string | null;
}

export interface EmailAttachmentView {
  id: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
}

export interface EmailMessageView {
  id: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  bodyPreview: string;
  bodyText: string;
  bodyHtmlSanitized: string | null;
  hasRemoteImages: boolean;
  outboundStatus: 'queued' | 'sent' | 'failed';
  errorDetail: string | null;
  hasAttachments: boolean;
  attachments: EmailAttachmentView[];
  linkedBy: 'auto' | 'user';
  sentAt: string;
}

export interface InboxThreadSummary {
  id: string;
  subject: string;
  snippet: string;
  status: InboxThreadStatus;
  messageCount: number;
  unreadCount: number;
  lastMessageAt: string;
  ownerUserId: string;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  companyId: string | null;
  companyName: string | null;
  dealId: string | null;
  dealName: string | null;
  leadId: string | null;
  hasFailedOutbound: boolean;
}

export interface InboxThreadDetail {
  thread: InboxThreadSummary;
  messages: EmailMessageView[];
}

export interface EmailTemplateView {
  id: string;
  name: string;
  category: string;
  market: 'US' | 'CA' | 'OTHER';
  subject: string;
  bodyText: string;
  shared: boolean;
  ownerUserId: string;
  updatedAt: string;
}
