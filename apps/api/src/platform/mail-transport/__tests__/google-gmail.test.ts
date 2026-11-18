import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDsnHardBounce } from '@adas/shared';
import {
  buildRfc5322RawEmail,
  decodeBase64UrlToBuffer,
  GmailApiError,
  type GmailThrottleError,
  GoogleGmailMailboxClient,
  parseGmailApiMessage,
} from '../google-gmail.js';

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('GoogleGmailMailboxClient & RFC 5322 / MIME helpers', () => {
  const tempDirs: string[] = [];

  function makeSecretFile(secret = 'test_google_client_secret_value_123456'): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adas-gmail-unit-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'google_client_secret.txt');
    writeFileSync(file, secret, 'utf8');
    return file;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds RFC 5322 MIME messages with UTF-8 subjects, threading headers, and List-Unsubscribe', () => {
    const built = buildRfc5322RawEmail({
      fromEmail: 'bdr.alex@adasglobus.example.com',
      toEmails: ['partner@mapleleafcpa.example.com'],
      ccEmails: ['taxlead@mapleleafcpa.example.com'],
      subject: '3-day trial — Tax season staffing',
      bodyText: 'Hello from our staffing team.',
      bodyHtml: '<p>Hello from our <strong>staffing</strong> team.</p>',
      inReplyTo: '<orig-123@mapleleafcpa.example.com>',
      references: '<root-001@mapleleafcpa.example.com> <orig-123@mapleleafcpa.example.com>',
      extraHeaders: {
        'List-Unsubscribe': '<https://go.adasglobus.example.com/u/tok_synthetic_1>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    expect(built.internetMessageId).toMatch(/^<adas\..+@adasglobuspro\.com>$/);
    const rawMime = decodeBase64UrlToBuffer(built.rawBase64Url).toString('utf8');
    expect(rawMime).toContain('From: bdr.alex@adasglobus.example.com');
    expect(rawMime).toContain('To: partner@mapleleafcpa.example.com');
    expect(rawMime).toContain('Cc: taxlead@mapleleafcpa.example.com');
    expect(rawMime).toContain('Subject: =?UTF-8?B?');
    expect(rawMime).toContain('In-Reply-To: <orig-123@mapleleafcpa.example.com>');
    expect(rawMime).toContain(
      'References: <root-001@mapleleafcpa.example.com> <orig-123@mapleleafcpa.example.com>',
    );
    expect(rawMime).toContain(
      'List-Unsubscribe: <https://go.adasglobus.example.com/u/tok_synthetic_1>',
    );
    expect(rawMime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(rawMime).toContain('multipart/alternative');
  });

  it('parses multipart Gmail messages with attachment metadata and DSN 5.1.1 hard bounces', () => {
    const parsedNormal = parseGmailApiMessage(
      {
        id: 'gmail_msg_101',
        threadId: 'gmail_thr_55',
        labelIds: ['INBOX', 'UNREAD'],
        snippet: 'Can we book a call Thursday?',
        internalDate: '1762000000000',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'Jordan Taylor <jordan@harborcpa.example.com>' },
            { name: 'To', value: 'bdr.alex@adasglobus.example.com' },
            { name: 'Subject', value: 'Re: Offshore tax prep capacity' },
            { name: 'Message-ID', value: '<reply-99@harborcpa.example.com>' },
            { name: 'In-Reply-To', value: '<seq-step-1@adasglobuspro.com>' },
          ],
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                {
                  mimeType: 'text/plain',
                  body: { data: toBase64Url('Can we book a call Thursday afternoon?') },
                },
                {
                  mimeType: 'text/html',
                  body: { data: toBase64Url('<p>Can we book a call Thursday afternoon?</p>') },
                },
              ],
            },
            {
              mimeType: 'application/pdf',
              filename: 'scope-summary.pdf',
              body: {
                attachmentId: 'att_gmail_pdf_1',
                size: 24576,
              },
            },
          ],
        },
      },
      'bdr.alex@adasglobus.example.com',
    );

    expect(parsedNormal).not.toBeNull();
    expect(parsedNormal?.direction).toBe('inbound');
    expect(parsedNormal?.message.fromEmail).toBe('jordan@harborcpa.example.com');
    expect(parsedNormal?.message.inReplyTo).toBe('<seq-step-1@adasglobuspro.com>');
    expect(parsedNormal?.message.hasAttachments).toBe(true);
    expect(parsedNormal?.attachments).toHaveLength(1);
    expect(parsedNormal?.attachments[0]?.providerAttachmentId).toBe('att_gmail_pdf_1');
    expect(parsedNormal?.attachments[0]?.filename).toBe('scope-summary.pdf');

    // Multipart DSN bounce from mailer-daemon@googlemail.com
    const parsedDsn = parseGmailApiMessage(
      {
        id: 'gmail_dsn_202',
        threadId: 'gmail_thr_56',
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/report',
          headers: [
            { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
            { name: 'To', value: 'bdr.alex@adasglobus.example.com' },
            { name: 'Subject', value: 'Delivery Status Notification (Failure)' },
          ],
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: toBase64Url('Address not found.') },
            },
            {
              mimeType: 'message/delivery-status',
              body: {
                data: toBase64Url(
                  'Final-Recipient: rfc822; defunct@closedcpa.example.com\r\nAction: failed\r\nStatus: 5.1.1\r\n',
                ),
              },
            },
          ],
        },
      },
      'bdr.alex@adasglobus.example.com',
    );

    expect(parsedDsn).not.toBeNull();
    const bounce = parseDsnHardBounce({
      fromEmail: parsedDsn?.message.fromEmail ?? '',
      subject: parsedDsn?.message.subject ?? '',
      bodyText: parsedDsn?.message.bodyContent ?? '',
      headers: parsedDsn?.message.headers,
    });
    expect(bounce.isHardBounce).toBe(true);
    expect(bounce.statusCode).toBe('5.1.1');
    expect(bounce.bouncedAddress).toBe('defunct@closedcpa.example.com');
  });

  it('falls back to 90-day scan when startHistoryId returns 404 and raises GmailThrottleError on 429', async () => {
    const secretFile = makeSecretFile();
    const calls: string[] = [];

    const client = new GoogleGmailMailboxClient({
      clientId: '1234567890-unit.apps.googleusercontent.com',
      clientSecretFile: secretFile,
      redirectUri: 'http://localhost:5174/api/v1/inbox/oauth/callback',
      gmailBaseUrl: 'https://gmail.unit.test/gmail/v1',
      fetchImpl: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        if (url.includes('/users/me/history?')) {
          return new Response(
            JSON.stringify({
              error: { code: 404, status: 'NOT_FOUND', message: 'Expired historyId' },
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/users/me/profile')) {
          return new Response(
            JSON.stringify({ emailAddress: 'bdr.alex@adasglobus.example.com', historyId: '9050' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/users/me/messages?')) {
          return new Response(JSON.stringify({ messages: [{ id: 'gm_1' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/users/me/messages/gm_1?format=full')) {
          return new Response(
            JSON.stringify({
              id: 'gm_1',
              threadId: 'gt_1',
              historyId: '9055',
              labelIds: ['SENT'],
              payload: {
                mimeType: 'text/plain',
                headers: [
                  { name: 'From', value: 'bdr.alex@adasglobus.example.com' },
                  { name: 'To', value: 'client@summitcpa.example.com' },
                  { name: 'Subject', value: 'Checking in' },
                ],
                body: { data: toBase64Url('Quick follow-up note.') },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('throttle-test')) {
          return new Response('{}', { status: 429, headers: { 'Retry-After': '42' } });
        }
        return new Response('{}', { status: 404 });
      },
    });

    expect(client.isConfigured()).toBe(true);
    const syncRes = await client.syncMessages({
      accessToken: 'tok_unit_1',
      mailboxEmail: 'bdr.alex@adasglobus.example.com',
      startHistoryId: '1001',
    });

    expect(calls.some((u) => u.includes('/users/me/history?'))).toBe(true);
    expect(calls.some((u) => u.includes('/users/me/messages?'))).toBe(true);
    expect(syncRes.nextHistoryId).toBe('9055');
    expect(syncRes.items).toHaveLength(1);
    expect(syncRes.items[0]?.direction).toBe('outbound');

    const throttledClient = new GoogleGmailMailboxClient({
      clientId: '1234567890-unit.apps.googleusercontent.com',
      clientSecretFile: secretFile,
      redirectUri: 'http://localhost:5174/api/v1/inbox/oauth/callback',
      gmailBaseUrl: 'https://gmail.unit.test/throttle-test',
      fetchImpl: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '45' } }),
    });

    await expect(throttledClient.getMailboxProfile('tok_unit_1')).rejects.toMatchObject({
      name: 'GmailThrottleError',
      retryAfterSeconds: 45,
    } satisfies Partial<GmailThrottleError>);

    const oversizedClient = new GoogleGmailMailboxClient({
      clientId: '1234567890-unit.apps.googleusercontent.com',
      clientSecretFile: secretFile,
      redirectUri: 'http://localhost:5174/api/v1/inbox/oauth/callback',
      gmailBaseUrl: 'https://gmail.unit.test/gmail/v1',
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: toBase64Url('0123456789ABCDEF') }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await expect(
      oversizedClient.downloadAttachment({
        accessToken: 'tok_unit_1',
        providerMessageId: 'gm_1',
        providerAttachmentId: 'att_1',
        maxBytes: 8,
      }),
    ).rejects.toBeInstanceOf(GmailApiError);
  });
});
