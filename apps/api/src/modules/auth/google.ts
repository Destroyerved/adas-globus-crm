import { existsSync, readFileSync } from 'node:fs';
import * as oidc from 'openid-client';
import { DomainError } from '../../platform/errors/index.js';
import type { PendingSignIn } from './entra.js';

/**
 * Google Workspace Single Sign-On (OIDC Authorization Code flow with PKCE, PRD §6.6, §15 Q2).
 *
 * Calls Google's real OIDC endpoints (`accounts.google.com`, `oauth2.googleapis.com/token`,
 * `www.googleapis.com/oauth2/v3/certs`). Without real credentials, `isConfigured()` returns
 * `false` rather than faking sign-in (`AGENTS.md §5`).
 */

export const GOOGLE_PLACEHOLDER_CLIENT_ID = '000000000000-placeholder.apps.googleusercontent.com';

export interface GoogleSsoSettings {
  clientId: string;
  clientSecretFile: string;
  redirectUri: string;
  allowedDomains?: string;
  issuerUrl?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
}

export interface GoogleIdentity {
  subjectId: string;
  email: string;
  name: string;
  hostedDomain: string | null;
}

export class GoogleSignIn {
  private config: oidc.Configuration | null = null;

  constructor(private readonly settings: GoogleSsoSettings) {}

  isConfigured(): boolean {
    const { clientId, clientSecretFile } = this.settings;
    return (
      Boolean(clientId) &&
      clientId !== GOOGLE_PLACEHOLDER_CLIENT_ID &&
      existsSync(clientSecretFile) &&
      readFileSync(clientSecretFile, 'utf8').trim() !== ''
    );
  }

  private parseAllowedDomains(): string[] {
    return (this.settings.allowedDomains ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  private getConfig(): oidc.Configuration {
    if (this.config) return this.config;
    const issuer = this.settings.issuerUrl ?? 'https://accounts.google.com';
    const allowHttpForLocalTests =
      issuer.startsWith('http://127.0.0.1') || issuer.startsWith('http://localhost');
    this.config = new oidc.Configuration(
      {
        issuer,
        authorization_endpoint:
          this.settings.authorizationEndpoint ?? 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: this.settings.tokenEndpoint ?? 'https://oauth2.googleapis.com/token',
        jwks_uri: this.settings.jwksUri ?? 'https://www.googleapis.com/oauth2/v3/certs',
      },
      this.settings.clientId,
      readFileSync(this.settings.clientSecretFile, 'utf8').trim(),
    );
    if (allowHttpForLocalTests) {
      oidc.allowInsecureRequests(this.config);
    }
    return this.config;
  }

  async start(): Promise<{ url: string; pending: PendingSignIn }> {
    const pending: PendingSignIn = {
      codeVerifier: oidc.randomPKCECodeVerifier(),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
    };
    const allowedDomains = this.parseAllowedDomains();
    const extraParams: Record<string, string> = {
      redirect_uri: this.settings.redirectUri,
      scope: 'openid email profile',
      response_type: 'code',
      code_challenge: await oidc.calculatePKCECodeChallenge(pending.codeVerifier),
      code_challenge_method: 'S256',
      state: pending.state,
      nonce: pending.nonce,
      prompt: 'select_account',
    };
    if (allowedDomains.length === 1 && allowedDomains[0]) {
      extraParams['hd'] = allowedDomains[0];
    }
    const url = oidc.buildAuthorizationUrl(this.getConfig(), extraParams);
    return { url: url.href, pending };
  }

  async finish(callbackQuery: string, pending: PendingSignIn): Promise<GoogleIdentity> {
    const callbackUrl = new URL(this.settings.redirectUri);
    callbackUrl.search = callbackQuery;
    const tokens = await oidc.authorizationCodeGrant(this.getConfig(), callbackUrl, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('Google did not return an ID token.');

    if (claims['email_verified'] !== true) {
      throw new DomainError({
        status: 403,
        code: 'GOOGLE_EMAIL_NOT_VERIFIED',
        title: 'Email address not verified',
        detail: 'Google reported that this email address is not verified.',
      });
    }

    const email = String(claims['email'] ?? '')
      .trim()
      .toLowerCase();
    const subjectId = String(claims['sub'] ?? '').trim();
    const hostedDomain =
      typeof claims['hd'] === 'string' ? claims['hd'].trim().toLowerCase() : null;

    if (!email || !subjectId) {
      throw new Error('Google did not return an email address and subject identifier.');
    }

    const allowedDomains = this.parseAllowedDomains();
    if (allowedDomains.length > 0) {
      const emailDomain = email.split('@')[1] ?? '';
      const domainMatches =
        allowedDomains.includes(emailDomain) &&
        (hostedDomain === null || allowedDomains.includes(hostedDomain));
      if (!domainMatches) {
        throw new DomainError({
          status: 403,
          code: 'GOOGLE_DOMAIN_NOT_ALLOWED',
          title: 'Google Workspace domain not permitted',
          detail: 'Sign in with an invited company Google Workspace account.',
        });
      }
    }

    return {
      subjectId,
      email,
      name: String(claims['name'] ?? email),
      hostedDomain,
    };
  }
}
