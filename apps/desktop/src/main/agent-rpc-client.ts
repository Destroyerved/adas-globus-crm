import { signAgentRequest, type AgentRole } from '@adas/server-agent';
import type { DecryptedServerProfile } from './profile-vault.js';
import { validateAgentBaseUrl } from './security-policy.js';

/**
 * Main-Process Signed HMAC-SHA256 RPC Client for `@adas/server-agent`.
 *
 * Runs strictly inside Electron's Main Process so `sharedSecret` and Cloudflare Access
 * Service Tokens never enter the Chromium Renderer process.
 */

export class AgentRpcClient {
  private readonly allowInsecureRemoteHttp: boolean;

  constructor(options: { allowInsecureRemoteHttp?: boolean } = {}) {
    this.allowInsecureRemoteHttp = Boolean(options.allowInsecureRemoteHttp);
  }

  async pairWithAgent(params: {
    agentUrl: string;
    pairingCode: string;
    clientName: string;
    cfAccessClientId?: string;
    cfAccessClientSecret?: string;
  }): Promise<{
    normalizedUrl: string;
    keyId: string;
    sharedSecret: string;
    role: AgentRole;
    serverName: string;
  }> {
    const normalizedUrl = validateAgentBaseUrl(params.agentUrl, {
      allowInsecureRemoteHttp: this.allowInsecureRemoteHttp,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (params.cfAccessClientId && params.cfAccessClientSecret) {
      headers['CF-Access-Client-Id'] = params.cfAccessClientId.trim();
      headers['CF-Access-Client-Secret'] = params.cfAccessClientSecret.trim();
    }

    const res = await fetch(`${normalizedUrl}/agent/v1/pair`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        pairingCode: params.pairingCode.trim(),
        clientName: params.clientName.trim(),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(String(payload['error'] ?? `Pairing failed (HTTP ${res.status})`));
    }

    return {
      normalizedUrl,
      keyId: String(payload['keyId']),
      sharedSecret: String(payload['sharedSecret']),
      role: payload['role'] as AgentRole,
      serverName: String(payload['serverName'] ?? 'ADAS Server'),
    };
  }

  async requestJson<T>(
    profile: DecryptedServerProfile,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    pathWithQuery: string,
    body?: unknown,
  ): Promise<T> {
    const normalizedUrl = validateAgentBaseUrl(profile.agentUrl, {
      allowInsecureRemoteHttp: this.allowInsecureRemoteHttp,
    });
    const rawBody =
      body !== undefined && method !== 'GET' && method !== 'DELETE' ? JSON.stringify(body) : '';

    const signedHeaders = signAgentRequest({
      keyId: profile.keyId,
      sharedSecret: profile.sharedSecret,
      method,
      pathWithQuery,
      rawBody,
    });

    const headers: Record<string, string> = {
      ...signedHeaders,
    };
    if (rawBody) {
      headers['Content-Type'] = 'application/json';
    }
    if (profile.cfAccessClientId && profile.cfAccessClientSecret) {
      headers['CF-Access-Client-Id'] = profile.cfAccessClientId;
      headers['CF-Access-Client-Secret'] = profile.cfAccessClientSecret;
    }

    const res = await fetch(`${normalizedUrl}${pathWithQuery}`, {
      method,
      headers,
      body: rawBody || undefined,
      signal: AbortSignal.timeout(120_000),
    });

    const parsed = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(String(parsed['error'] ?? `Agent HTTP ${res.status}`));
    }
    return parsed as T;
  }
}
