import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EspBulkSender,
  EspTransportError,
  parseEspWebhookPayload,
  verifyEspWebhookSignature,
} from '../esp-bulk.js';

describe('EspBulkSender provider adapter & HMAC webhook verifier (PRD 5.4, 8.4, 8.7, 9)', () => {
  let tempDir: string;
  let apiKeyFile: string;
  let webhookSecretFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'adas-esp-test-'));
    apiKeyFile = path.join(tempDir, 'esp_api_key.txt');
    webhookSecretFile = path.join(tempDir, 'esp_webhook_secret.txt');
    writeFileSync(apiKeyFile, 'pm_test_server_token_synthetic', 'utf8');
    writeFileSync(webhookSecretFile, 'whsec_test_esp_hmac_secret', 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('forbids enabling live ESP sends outside production (AGENTS.md §5)', () => {
    expect(
      () =>
        new EspBulkSender({
          provider: 'postmark',
          apiBaseUrl: 'https://api.postmarkapp.com',
          apiKeyFile,
          webhookSecretFile,
          sendingDomain: 'mail.adasglobuspro.com',
          nodeEnv: 'development',
          mailLive: true,
        }),
    ).toThrow(/Safety guard/);
  });

  it('enforces dedicated sending subdomain and executes Postmark & Resend HTTP wire requests with retryable 5xx classification', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const sender = new EspBulkSender({
      provider: 'postmark',
      apiBaseUrl: 'https://api.postmarkapp.com',
      apiKeyFile,
      webhookSecretFile,
      sendingDomain: 'mail.adasglobuspro.com',
      nodeEnv: 'production',
      mailLive: true,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const hdrs: Record<string, string> = {};
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
          hdrs[k.toLowerCase()] = v;
        }
        const parsed = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
        calls.push({ url: String(url), headers: hdrs, body: parsed });
        return new Response(
          JSON.stringify({
            MessageID: 'pm_msg_9912',
            SubmittedAt: '2026-11-18T12:00:00.000Z',
            ErrorCode: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    // Rejects root employee domain
    await expect(
      sender.sendCampaignMessage({
        idempotencyKey: 'cmp:bad_root',
        fromEmail: 'ananya@adasglobuspro.com',
        toEmail: 'partner@acmecpa.example.com',
        subject: 'Briefing',
        bodyText: 'Hello',
      }),
    ).rejects.toMatchObject({ status: 422, retryable: false });

    // Sends cleanly from dedicated subdomain
    const receipt = await sender.sendCampaignMessage({
      idempotencyKey: 'cmp:rec_1',
      fromEmail: 'briefings@mail.adasglobuspro.com',
      toEmail: 'partner@acmecpa.example.com',
      subject: 'Busy Season Briefing',
      bodyText: 'Plain copy',
      bodyHtml: '<p>HTML copy</p>',
      headers: {
        'List-Unsubscribe': '<https://go.adasglobuspro.com/u/tok1>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    expect(receipt.provider).toBe('esp_bulk');
    expect(receipt.providerMessageId).toBe('pm_msg_9912');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.postmarkapp.com/email');
    expect(calls[0]?.headers['x-postmark-server-token']).toBe('pm_test_server_token_synthetic');

    // Marks 503 / 429 as retryable for safe worker retry (A15)
    const failingSender = new EspBulkSender({
      provider: 'resend',
      apiBaseUrl: 'https://api.resend.com',
      apiKeyFile,
      webhookSecretFile,
      sendingDomain: 'mail.adasglobuspro.com',
      nodeEnv: 'production',
      mailLive: true,
      fetchImpl: (async () =>
        new Response('Service Unavailable', {
          status: 503,
          headers: { 'Retry-After': '15' },
        })) as typeof fetch,
    });

    await expect(
      failingSender.sendCampaignMessage({
        idempotencyKey: 'cmp:rec_503',
        fromEmail: 'briefings@mail.adasglobuspro.com',
        toEmail: 'partner@acmecpa.example.com',
        subject: 'Briefing',
        bodyText: 'Copy',
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EspTransportError &&
        err.status === 503 &&
        err.retryable === true &&
        err.retryAfterSeconds === 15,
    );
  });

  it('verifies HMAC-SHA256 webhook signatures with 5-minute replay guard and parses Postmark & Resend events', () => {
    const rawBody = JSON.stringify({
      RecordType: 'Bounce',
      ID: 8821,
      Type: 'HardBounce',
      MessageID: 'pm_msg_9912',
      Email: 'Bounced.Partner@AcmeCPA.example.com',
      Description: '550 5.1.1 User unknown',
      BouncedAt: '2026-11-18T12:05:00.000Z',
    });
    const nowMs = Date.parse('2026-11-18T12:05:30.000Z');
    const ts = String(Math.floor(nowMs / 1000));
    const validSig = createHmac('sha256', 'whsec_test_esp_hmac_secret')
      .update(`${ts}.${rawBody}`, 'utf8')
      .digest('hex');

    expect(
      verifyEspWebhookSignature({
        rawBody,
        signatureHeader: `sha256=${validSig}`,
        timestampHeader: ts,
        secret: 'whsec_test_esp_hmac_secret',
        nowMs,
      }),
    ).toBe(true);

    // Replay > 5 minutes later is rejected
    expect(
      verifyEspWebhookSignature({
        rawBody,
        signatureHeader: `sha256=${validSig}`,
        timestampHeader: ts,
        secret: 'whsec_test_esp_hmac_secret',
        nowMs: nowMs + 10 * 60 * 1000,
      }),
    ).toBe(false);

    const parsed = parseEspWebhookPayload(JSON.parse(rawBody));
    expect(parsed).toEqual([
      {
        providerEventId: 'postmark_8821',
        providerMessageId: 'pm_msg_9912',
        recipientEmail: 'bounced.partner@acmecpa.example.com',
        eventType: 'bounced_hard',
        occurredAt: '2026-11-18T12:05:00.000Z',
        diagnostic: '550 5.1.1 User unknown',
        linkUrl: null,
      },
    ]);
  });
});
