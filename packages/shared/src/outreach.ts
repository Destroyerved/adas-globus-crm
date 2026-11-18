import { z } from 'zod';
import { MarketSchema, type Market } from './enums.js';
import { renderEmailTemplate } from './inbox.js';
import { SequenceStepInputSchema } from './schemas.js';

/**
 * Milestone 6: Sequences, Campaigns, Templates, Segments/Lists, Sender Identities,
 * Block Editor HTML/Plain-Text Renderer, Compliance Footers & Click URL Helpers
 * (PRD 4.12, 4.13, 5.4–5.6, 8.3–8.6).
 */

export const TemplateChannelSchema = z.enum(['sequence', 'campaign', 'inbox']);
export type TemplateChannel = z.infer<typeof TemplateChannelSchema>;

export const SafeHttpUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => /^https?:\/\/[^\s<>"']+$/i.test(value), {
    message: 'Enter an http:// or https:// web address.',
  });

export const CampaignBlockSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().trim().min(1).max(80),
    type: z.literal('heading'),
    level: z.enum(['h1', 'h2']).default('h1'),
    text: z.string().trim().min(1).max(300),
  }),
  z.object({
    id: z.string().trim().min(1).max(80),
    type: z.literal('text'),
    text: z.string().trim().min(1).max(8000),
  }),
  z.object({
    id: z.string().trim().min(1).max(80),
    type: z.literal('button'),
    label: z.string().trim().min(1).max(80),
    url: SafeHttpUrlSchema,
  }),
  z.object({
    id: z.string().trim().min(1).max(80),
    type: z.literal('image'),
    alt: z.string().trim().max(240).default(''),
    url: SafeHttpUrlSchema,
  }),
  z.object({
    id: z.string().trim().min(1).max(80),
    type: z.literal('divider'),
  }),
]);
export type CampaignBlock = z.infer<typeof CampaignBlockSchema>;

export const CreateOutreachTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  channel: TemplateChannelSchema.default('sequence'),
  market: MarketSchema.default('US'),
  subject: z.string().trim().min(1).max(240),
  bodyText: z.string().trim().max(40000).default(''),
  bodyHtml: z.string().max(100000).nullable().optional(),
  blocks: z.array(CampaignBlockSchema).max(40).default([]),
  variables: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  shared: z.boolean().default(true),
});
export type CreateOutreachTemplateInput = z.input<typeof CreateOutreachTemplateInputSchema>;

export const UpdateOutreachTemplateInputSchema = CreateOutreachTemplateInputSchema.partial().extend(
  {
    version: z.number().int().positive(),
  },
);
export type UpdateOutreachTemplateInput = z.input<typeof UpdateOutreachTemplateInputSchema>;

export const UpdateSequenceInputSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  market: MarketSchema.optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  shared: z.boolean().optional(),
  dailyCapPerMailbox: z.number().int().positive().max(150).optional(),
  sendWindowStartMinutes: z.number().int().min(0).max(1439).optional(),
  sendWindowEndMinutes: z.number().int().min(1).max(1440).optional(),
  stopOnCompanyReply: z.boolean().optional(),
  clickTrackingEnabled: z.boolean().optional(),
  steps: z.array(SequenceStepInputSchema).min(1).max(20).optional(),
});
export type UpdateSequenceInput = z.input<typeof UpdateSequenceInputSchema>;

export const BatchEnrollSequenceInputSchema = z.object({
  contactIds: z.array(z.string().trim().min(1)).min(1).max(500),
  senderUserId: z.string().trim().min(1).optional(),
});
export type BatchEnrollSequenceInput = z.input<typeof BatchEnrollSequenceInputSchema>;

export const EnrollmentStateActionInputSchema = z.object({
  action: z.enum(['pause', 'resume', 'stop']),
  reason: z.string().trim().max(300).optional(),
});
export type EnrollmentStateActionInput = z.input<typeof EnrollmentStateActionInputSchema>;

export const CreateMarketingListInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullable().optional(),
  listType: z.enum(['static', 'dynamic']).default('static'),
  market: MarketSchema.default('US'),
  filterJson: z.record(z.string(), z.unknown()).default({}),
  shared: z.boolean().default(true),
  contactIds: z.array(z.string().trim().min(1)).max(5000).default([]),
});
export type CreateMarketingListInput = z.input<typeof CreateMarketingListInputSchema>;

export const UpdateMarketingListInputSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  market: MarketSchema.optional(),
  filterJson: z.record(z.string(), z.unknown()).optional(),
  shared: z.boolean().optional(),
});
export type UpdateMarketingListInput = z.input<typeof UpdateMarketingListInputSchema>;

export const ModifyListMembersInputSchema = z.object({
  contactIds: z.array(z.string().trim().min(1)).min(1).max(1000),
});
export type ModifyListMembersInput = z.input<typeof ModifyListMembersInputSchema>;

export const CreateSenderIdentityInputSchema = z.object({
  fromName: z.string().trim().min(2).max(120),
  fromEmail: z.string().trim().toLowerCase().email().max(254),
  replyToEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  dailyWarmupCap: z.number().int().min(10).max(50000).default(250),
});
export type CreateSenderIdentityInput = z.input<typeof CreateSenderIdentityInputSchema>;

export const UpdateSenderIdentityInputSchema = z.object({
  spfVerified: z.boolean().optional(),
  dkimVerified: z.boolean().optional(),
  dmarcVerified: z.boolean().optional(),
  dailyWarmupCap: z.number().int().min(10).max(50000).optional(),
});
export type UpdateSenderIdentityInput = z.input<typeof UpdateSenderIdentityInputSchema>;

export const CampaignStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'scheduled',
  'sending',
  'paused',
  'paused_deliverability',
  'completed',
  'sent',
  'cancelled',
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const UpdateCampaignInputSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(160).optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  bodyHtml: z.string().max(100000).optional(),
  bodyText: z.string().max(50000).optional(),
  blocks: z.array(CampaignBlockSchema).max(40).optional(),
  market: MarketSchema.optional(),
  listId: z.string().trim().min(1).nullable().optional(),
  segmentFilterJson: z.record(z.string(), z.unknown()).nullable().optional(),
  templateId: z.string().trim().min(1).nullable().optional(),
  senderIdentityId: z.string().trim().min(1).nullable().optional(),
  throttlePerHour: z.number().int().min(1).max(10000).optional(),
  respectRecipientTimezone: z.boolean().optional(),
  clickTrackingEnabled: z.boolean().optional(),
  excludeUnverified: z.boolean().optional(),
});
export type UpdateCampaignInput = z.input<typeof UpdateCampaignInputSchema>;

export const ScheduleCampaignInputSchema = z.object({
  scheduledAt: z.string().datetime().nullable().optional(),
  sendNow: z.boolean().default(false),
  throttlePerHour: z.number().int().min(1).max(10000).optional(),
});
export type ScheduleCampaignInput = z.input<typeof ScheduleCampaignInputSchema>;

export const TestSendCampaignInputSchema = z.object({
  recipientEmail: z.string().trim().toLowerCase().email().max(254),
});
export type TestSendCampaignInput = z.input<typeof TestSendCampaignInputSchema>;

export const DEFAULT_POSTAL_ADDRESSES: Record<Market, string> = {
  US: 'ADAS Globus Pro · 30 N Gould St, Sheridan, WY 82801, USA',
  CA: 'ADAS Globus Pro · 9622 42 Ave NW, Edmonton, AB T6E 5Y4, Canada',
  OTHER: 'ADAS Globus Pro · 30 N Gould St, Sheridan, WY 82801, USA',
};

function escapeHtmlText(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders structured campaign blocks (`PRD 4.13`: heading, text, button, image, divider)
 * into responsive inline-styled HTML plus a clean plain-text part, applying variable fallbacks.
 */
export function renderCampaignBlocks(
  blocks: readonly CampaignBlock[],
  variables: Record<string, string | null | undefined> = {},
): { html: string; text: string } {
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  for (const rawBlock of blocks) {
    const block = CampaignBlockSchema.parse(rawBlock);
    switch (block.type) {
      case 'heading': {
        const rendered = renderEmailTemplate(block.text, variables);
        const fontSize = block.level === 'h1' ? '22px' : '17px';
        htmlParts.push(
          `<${block.level} style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:${fontSize};line-height:1.3;font-weight:700;color:#0F172A;">${escapeHtmlText(rendered)}</${block.level}>`,
        );
        textParts.push(rendered.toUpperCase());
        break;
      }
      case 'text': {
        const rendered = renderEmailTemplate(block.text, variables);
        const paragraphs = rendered
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean);
        for (const p of paragraphs) {
          const lineHtml = escapeHtmlText(p).replace(/\n/g, '<br />');
          htmlParts.push(
            `<p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1E293B;">${lineHtml}</p>`,
          );
        }
        textParts.push(rendered);
        break;
      }
      case 'button': {
        const label = renderEmailTemplate(block.label, variables);
        const url = block.url.trim();
        htmlParts.push(
          `<div style="margin:18px 0;"><a href="${escapeHtmlText(url)}" style="display:inline-block;padding:11px 22px;border-radius:999px;background-color:#0F172A;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;text-decoration:none;">${escapeHtmlText(label)}</a></div>`,
        );
        textParts.push(`${label}: ${url}`);
        break;
      }
      case 'image': {
        const alt = renderEmailTemplate(block.alt, variables);
        const url = block.url.trim();
        htmlParts.push(
          `<div style="margin:16px 0;"><img src="${escapeHtmlText(url)}" alt="${escapeHtmlText(alt)}" style="display:block;max-width:100%;height:auto;border-radius:8px;border:1px solid #E2E8F0;" /></div>`,
        );
        if (alt) textParts.push(`[Image: ${alt}]`);
        break;
      }
      case 'divider': {
        htmlParts.push(`<hr style="border:0;border-top:1px solid #E2E8F0;margin:20px 0;" />`);
        textParts.push('---');
        break;
      }
    }
  }

  const bodyInner = htmlParts.join('\n');
  const html = `<div style="max-width:600px;margin:0 auto;padding:24px;background-color:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px;">\n${bodyInner}\n</div>`;
  const text = textParts.join('\n\n').trim();
  return { html, text };
}

/**
 * Appends required opt-out copy and market-specific postal address (PRD 5.5).
 */
export function appendOutreachComplianceFooter(input: {
  channel: 'sequence' | 'campaign';
  market: Market;
  bodyText: string;
  bodyHtml?: string | null;
  unsubscribeUrl: string;
  postalAddress?: string | null;
}): { bodyText: string; bodyHtml: string | undefined } {
  const address = (input.postalAddress?.trim() || DEFAULT_POSTAL_ADDRESSES[input.market]).trim();
  const unsubUrl = input.unsubscribeUrl.trim();

  const textFooter =
    input.channel === 'sequence'
      ? `\n\n---\nIf you'd rather not hear from me, reply "no thanks" or use this link: ${unsubUrl}\n${address}`
      : `\n\n---\n${address}\nUnsubscribe from all emails: ${unsubUrl}`;

  const nextText = input.bodyText.includes(unsubUrl)
    ? input.bodyText
    : `${input.bodyText.trimEnd()}${textFooter}`;

  let nextHtml: string | undefined;
  if (input.bodyHtml && input.bodyHtml.trim().length > 0) {
    if (input.bodyHtml.includes(unsubUrl)) {
      nextHtml = input.bodyHtml;
    } else {
      const htmlFooter =
        input.channel === 'sequence'
          ? `<div style="margin-top:24px;padding-top:14px;border-top:1px solid #E2E8F0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#64748B;"><p style="margin:0 0 6px 0;">If you'd rather not hear from me, reply &ldquo;no thanks&rdquo; or <a href="${escapeHtmlText(unsubUrl)}" style="color:#475569;text-decoration:underline;">use this link</a>.</p><p style="margin:0;">${escapeHtmlText(address)}</p></div>`
          : `<div style="max-width:600px;margin:16px auto 0 auto;padding:14px 4px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#64748B;"><p style="margin:0 0 6px 0;">${escapeHtmlText(address)}</p><p style="margin:0;"><a href="${escapeHtmlText(unsubUrl)}" style="color:#475569;text-decoration:underline;">Unsubscribe from all emails</a></p></div>`;
      nextHtml = `${input.bodyHtml}\n${htmlFooter}`;
    }
  }

  return { bodyText: nextText, bodyHtml: nextHtml };
}

/**
 * Extracts unique trackable `http(s)://` URLs from HTML `href="..."` attributes and plain-text copy,
 * strictly excluding unsubscribe `/u/` links so opt-out links are never wrapped in click tracking (PRD 8.6).
 */
export function extractTrackableUrls(
  bodyText: string,
  bodyHtml: string | undefined,
  unsubscribeUrl: string,
): string[] {
  const urls = new Set<string>();
  const skip = (candidate: string): boolean => {
    if (!/^https?:\/\//i.test(candidate)) return true;
    if (candidate === unsubscribeUrl) return true;
    try {
      const parsed = new URL(candidate);
      if (parsed.pathname.startsWith('/u/') || parsed.pathname.startsWith('/c/')) return true;
      return false;
    } catch {
      return true;
    }
  };

  if (bodyHtml) {
    const hrefRegex = /href=["'](https?:\/\/[^"'\s<>]+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = hrefRegex.exec(bodyHtml)) !== null) {
      const raw = (match[1] ?? '').replace(/&amp;/g, '&');
      if (!skip(raw)) urls.add(raw);
    }
  }

  const textUrlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
  let textMatch: RegExpExecArray | null;
  while ((textMatch = textUrlRegex.exec(bodyText)) !== null) {
    const raw = (textMatch[0] ?? '').replace(/[.,;:!?]+$/, '');
    if (!skip(raw)) urls.add(raw);
  }

  return [...urls];
}

/**
 * Rewrites original URLs to their `/c/:token` stored-redirect URLs in both HTML and plain-text parts.
 */
export function rewriteUrlsWithClickTokens(input: {
  bodyText: string;
  bodyHtml?: string;
  replacements: ReadonlyMap<string, string>;
}): { bodyText: string; bodyHtml: string | undefined } {
  let nextText = input.bodyText;
  let nextHtml = input.bodyHtml;

  for (const [originalUrl, trackedUrl] of input.replacements.entries()) {
    nextText = nextText.split(originalUrl).join(trackedUrl);
    if (nextHtml) {
      const escapedOriginal = escapeHtmlText(originalUrl);
      const escapedTracked = escapeHtmlText(trackedUrl);
      nextHtml = nextHtml.split(`href="${escapedOriginal}"`).join(`href="${escapedTracked}"`);
      nextHtml = nextHtml.split(`href="${originalUrl}"`).join(`href="${escapedTracked}"`);
    }
  }

  return { bodyText: nextText, bodyHtml: nextHtml };
}
