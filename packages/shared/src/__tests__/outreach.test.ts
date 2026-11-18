import { describe, expect, it } from 'vitest';
import {
  appendOutreachComplianceFooter,
  CampaignBlockSchema,
  extractTrackableUrls,
  renderCampaignBlocks,
  rewriteUrlsWithClickTokens,
} from '../outreach.js';

describe('Outreach block editor, compliance footers & click-token URL rewriting (PRD 4.13, 5.5, 8.6)', () => {
  it('renders campaign blocks with variable fallbacks into inline-styled HTML and plain text while escaping HTML injection', () => {
    const rendered = renderCampaignBlocks(
      [
        {
          id: 'blk_1',
          type: 'heading',
          level: 'h1',
          text: 'Peak Season Pod Briefing for {{company.name|your firm}}',
        },
        {
          id: 'blk_2',
          type: 'text',
          text: 'Hi {{contact.first_name|there}}, <script>alert(1)</script>\n\nBook a 3-day trial.',
        },
        {
          id: 'blk_3',
          type: 'button',
          label: 'Schedule 3-day trial',
          url: 'https://adasglobuspro.example.com/trial?src=q1&ref=crm',
        },
        {
          id: 'blk_4',
          type: 'divider',
        },
      ],
      {
        'company.name': 'Northwind CPA LLP',
      },
    );

    expect(rendered.html).toContain('Peak Season Pod Briefing for Northwind CPA LLP');
    expect(rendered.html).toContain('Hi there, &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain(
      'href="https://adasglobuspro.example.com/trial?src=q1&amp;ref=crm"',
    );
    expect(rendered.text).toContain('PEAK SEASON POD BRIEFING FOR NORTHWIND CPA LLP');
    expect(rendered.text).toContain(
      'Schedule 3-day trial: https://adasglobuspro.example.com/trial?src=q1&ref=crm',
    );
  });

  it('rejects javascript: URLs in button and image blocks', () => {
    expect(() =>
      CampaignBlockSchema.parse({
        id: 'blk_bad',
        type: 'button',
        label: 'Unsafe',
        url: 'javascript:alert(1)',
      }),
    ).toThrow();
  });

  it('appends market-specific postal addresses (US Sheridan, WY vs CA Edmonton, AB) and channel opt-out copy', () => {
    const usSeq = appendOutreachComplianceFooter({
      channel: 'sequence',
      market: 'US',
      bodyText: 'Hi Partner, quick question.',
      unsubscribeUrl: 'https://go.adasglobuspro.com/u/tok_us_1',
    });
    expect(usSeq.bodyText).toContain(
      'reply "no thanks" or use this link: https://go.adasglobuspro.com/u/tok_us_1',
    );
    expect(usSeq.bodyText).toContain('Sheridan, WY');

    const caCampaign = appendOutreachComplianceFooter({
      channel: 'campaign',
      market: 'CA',
      bodyText: 'Briefing summary.',
      bodyHtml: '<div><p>Briefing summary.</p></div>',
      unsubscribeUrl: 'https://go.adasglobuspro.com/u/tok_ca_1',
    });
    expect(caCampaign.bodyText).toContain('Edmonton, AB');
    expect(caCampaign.bodyHtml).toContain('Edmonton, AB');
    expect(caCampaign.bodyHtml).toContain('href="https://go.adasglobuspro.com/u/tok_ca_1"');
  });

  it('extracts and rewrites trackable links without ever wrapping unsubscribe /u/ URLs', () => {
    const unsubUrl = 'https://go.adasglobuspro.com/u/unsub_token_99';
    const html = `<div><a href="https://adasglobuspro.example.com/briefing?utm=1&amp;b=2">Read</a><a href="${unsubUrl}">Unsubscribe</a></div>`;
    const text = `Read: https://adasglobuspro.example.com/briefing?utm=1&b=2\nUnsubscribe: ${unsubUrl}`;

    const urls = extractTrackableUrls(text, html, unsubUrl);
    expect(urls).toEqual(['https://adasglobuspro.example.com/briefing?utm=1&b=2']);

    const rewritten = rewriteUrlsWithClickTokens({
      bodyText: text,
      bodyHtml: html,
      replacements: new Map([
        [
          'https://adasglobuspro.example.com/briefing?utm=1&b=2',
          'https://go.adasglobuspro.com/c/clk_abc123',
        ],
      ]),
    });
    expect(rewritten.bodyText).toContain('https://go.adasglobuspro.com/c/clk_abc123');
    expect(rewritten.bodyText).toContain(unsubUrl);
    expect(rewritten.bodyHtml).toContain('href="https://go.adasglobuspro.com/c/clk_abc123"');
    expect(rewritten.bodyHtml).toContain(`href="${unsubUrl}"`);
  });
});
