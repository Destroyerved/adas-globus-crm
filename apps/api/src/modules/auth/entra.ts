import { existsSync, readFileSync } from 'node:fs';
import * as oidc from 'openid-client';

/**
 * Microsoft Entra ID sign-in (OIDC authorization code flow with PKCE, PRD 6.6).
 * Calls Microsoft's real endpoints. Without a configured app registration it reports
 * "not configured" instead of pretending (AGENTS.md section 5).
 */

export interface EntraSettings {
  tenantId: string;
  clientId: string;
  clientSecretFile: string;
  redirectUri: string;
}

export interface EntraIdentity {
  objectId: string;
  email: string;
  name: string;
}

export interface PendingSignIn {
  codeVerifier: string;
  state: string;
  nonce: string;
}

const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

export class EntraSignIn {
  private config: oidc.Configuration | null = null;

  constructor(private readonly settings: EntraSettings) {}

  /** True when a real app registration and client secret are present. */
  isConfigured(): boolean {
    const { tenantId, clientId, clientSecretFile } = this.settings;
    return (
      tenantId !== PLACEHOLDER_ID &&
      clientId !== PLACEHOLDER_ID &&
      existsSync(clientSecretFile) &&
      readFileSync(clientSecretFile, 'utf8').trim() !== ''
    );
  }

  private getConfig(): oidc.Configuration {
    if (this.config) return this.config;
    const { tenantId, clientId, clientSecretFile } = this.settings;
    const base = `https://login.microsoftonline.com/${tenantId}`;
    this.config = new oidc.Configuration(
      {
        issuer: `${base}/v2.0`,
        authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
        token_endpoint: `${base}/oauth2/v2.0/token`,
        jwks_uri: `${base}/discovery/v2.0/keys`,
      },
      clientId,
      readFileSync(clientSecretFile, 'utf8').trim(),
    );
    return this.config;
  }

  /** Builds the Microsoft sign-in URL and the values to check when Microsoft redirects back. */
  async start(): Promise<{ url: string; pending: PendingSignIn }> {
    const pending: PendingSignIn = {
      codeVerifier: oidc.randomPKCECodeVerifier(),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
    };
    const url = oidc.buildAuthorizationUrl(this.getConfig(), {
      redirect_uri: this.settings.redirectUri,
      scope: 'openid profile email',
      response_type: 'code',
      code_challenge: await oidc.calculatePKCECodeChallenge(pending.codeVerifier),
      code_challenge_method: 'S256',
      state: pending.state,
      nonce: pending.nonce,
      prompt: 'select_account',
    });
    return { url: url.href, pending };
  }

  /**
   * Exchanges the authorization code with Microsoft and validates the ID token
   * (signature, issuer, audience, expiry, nonce). Returns who signed in.
   */
  async finish(callbackQuery: string, pending: PendingSignIn): Promise<EntraIdentity> {
    const callbackUrl = new URL(this.settings.redirectUri);
    callbackUrl.search = callbackQuery;
    const tokens = await oidc.authorizationCodeGrant(this.getConfig(), callbackUrl, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('Microsoft did not return an ID token.');
    if (claims['tid'] !== this.settings.tenantId) {
      throw new Error('Signed in with an account from a different Microsoft organisation.');
    }
    const email = String(claims['email'] ?? claims['preferred_username'] ?? '')
      .trim()
      .toLowerCase();
    const objectId = String(claims['oid'] ?? '');
    if (!email || !objectId) throw new Error('Microsoft did not return an email and account ID.');
    return { objectId, email, name: String(claims['name'] ?? email) };
  }
}
