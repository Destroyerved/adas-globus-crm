import { describe, expect, it } from 'vitest';
import { ApolloClient } from '../index.js';
import {
  signAdasWebhookPayload,
  validateWebhookTargetUrl,
  verifyTimestampedHmacSignature,
} from '../../webhooks/index.js';

describe('ApolloClient & Webhook Signing / SSRF Guard (PRD 4.14, 9)', () => {
  it('reports unconfigured and fails fast with 503 APOLLO_NOT_CONFIGURED when API key is missing', async () => {
    const client = new ApolloClient({
      apiKeyFile: './secrets/does_not_exist_apollo.txt',
    });
    expect(client.isConfigured()).toBe(false);
    await expect(client.searchPeople({ market: 'US', page: 1, perPage: 10 })).rejects.toMatchObject(
      {
        status: 503,
        code: 'APOLLO_NOT_CONFIGURED',
      },
    );
  });

  it('signs and verifies timestamped HMAC-SHA256 webhooks with a strict 5-minute replay window', () => {
    const body = JSON.stringify({ id: 'evt_1', eventType: 'deal.won' });
    const secret = 'whsec_test_signing_key_1234567890';
    const ts = 1_760_000_000;
    const signed = signAdasWebhookPayload(body, secret, ts);

    expect(signed.signatureHeader).toMatch(/^t=1760000000,v1=[0-9a-f]{64}$/);

    // Valid inside 5 minutes
    const valid = verifyTimestampedHmacSignature({
      rawBody: body,
      signatureHeader: signed.signatureHeader,
      secret,
      nowMs: (ts + 120) * 1000,
    });
    expect(valid).toEqual({ ok: true });

    // Rejected past 5 minutes (301s)
    const replayed = verifyTimestampedHmacSignature({
      rawBody: body,
      signatureHeader: signed.signatureHeader,
      secret,
      nowMs: (ts + 301) * 1000,
    });
    expect(replayed).toEqual({ ok: false, reason: 'replay_window_exceeded' });

    // Rejected on tampered payload
    const tampered = verifyTimestampedHmacSignature({
      rawBody: `${body} `,
      signatureHeader: signed.signatureHeader,
      secret,
      nowMs: (ts + 10) * 1000,
    });
    expect(tampered).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('blocks cloud metadata IPs unconditionally and enforces HTTPS / public hosts in production', () => {
    expect(() =>
      validateWebhookTargetUrl('http://169.254.169.254/latest/meta-data/', {
        production: false,
        allowPrivateTargets: true,
      }),
    ).toThrow(/Cloud metadata/);

    expect(() =>
      validateWebhookTargetUrl('http://127.0.0.1:5678/webhook/test', {
        production: true,
        allowPrivateTargets: false,
      }),
    ).toThrow(/Private or loopback/);

    expect(() =>
      validateWebhookTargetUrl('http://hooks.partner.example.com/webhook', {
        production: true,
        allowPrivateTargets: false,
      }),
    ).toThrow(/https:\/\//);

    expect(
      validateWebhookTargetUrl('https://hooks.partner.example.com/webhook', {
        production: true,
        allowPrivateTargets: false,
      }),
    ).toBe('https://hooks.partner.example.com/webhook');

    // Internal Docker n8n container allowed when WEBHOOK_ALLOW_PRIVATE_TARGETS=true
    expect(
      validateWebhookTargetUrl('http://n8n:5678/webhook/deal-won', {
        production: true,
        allowPrivateTargets: true,
      }),
    ).toBe('http://n8n:5678/webhook/deal-won');
  });
});
