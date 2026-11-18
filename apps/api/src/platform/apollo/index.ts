import { existsSync, readFileSync } from 'node:fs';
import { type ApolloSearchInput } from '@adas/shared';
import { DomainError } from '../errors/index.js';

export interface ApolloClientOptions {
  apiBaseUrl?: string;
  apiKeyFile?: string;
  apiKey?: string | null;
  timeoutMs?: number;
}

export interface ApolloPersonPreview {
  apolloPersonId: string;
  apolloOrgId: string | null;
  firstName: string;
  lastName: string;
  title: string;
  firmName: string;
  domain: string;
  country: string | null;
  state: string | null;
  email: string | null;
  emailVerificationStatus: 'valid' | 'risky' | 'invalid' | 'unknown';
  hasEmail: boolean;
}

export interface ApolloMatchedPerson {
  apolloPersonId: string;
  apolloOrgId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  emailVerificationStatus: 'valid' | 'risky' | 'invalid' | 'unknown';
  title: string | null;
  firmName: string | null;
  domain: string | null;
  estimatedEmployees: number | null;
}

export interface ApolloOrganizationInfo {
  apolloOrgId: string;
  name: string;
  domain: string | null;
  websiteUrl: string | null;
  estimatedEmployees: number | null;
  country: string | null;
  state: string | null;
  city: string | null;
}

function mapApolloEmailStatus(raw: unknown): 'valid' | 'risky' | 'invalid' | 'unknown' {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'verified' || s === 'valid') return 'valid';
  if (s === 'guessed' || s === 'extrapolated' || s === 'catch_all' || s === 'risky') return 'risky';
  if (s === 'invalid' || s === 'bounced' || s === 'unavailable') return 'invalid';
  return 'unknown';
}

/**
 * Real HTTP connector for the Apollo REST v1 API (PRD 4.14, 8.7; AGENTS.md §5).
 * Never fabricates or mocks prospects: if no API key is configured, `isConfigured()` returns false
 * and calls fail with `503 APOLLO_NOT_CONFIGURED`.
 */
export class ApolloClient {
  private readonly baseUrl: string;
  private readonly apiKeyFile: string | undefined;
  private readonly explicitKey: string | null;
  private readonly timeoutMs: number;

  constructor(options: ApolloClientOptions = {}) {
    this.baseUrl = (options.apiBaseUrl ?? 'https://api.apollo.io').replace(/\/+$/, '');
    this.apiKeyFile = options.apiKeyFile;
    this.explicitKey = options.apiKey ?? null;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  private readApiKey(): string | null {
    if (this.explicitKey && this.explicitKey.trim().length > 0) {
      return this.explicitKey.trim();
    }
    if (!this.apiKeyFile || !existsSync(this.apiKeyFile)) {
      return null;
    }
    const raw = readFileSync(this.apiKeyFile, 'utf8').trim();
    if (
      !raw ||
      raw.startsWith('00000000') ||
      raw.toLowerCase() === 'changeme' ||
      raw.toLowerCase() === 'replace_me'
    ) {
      return null;
    }
    return raw;
  }

  isConfigured(): boolean {
    return this.readApiKey() !== null;
  }

  private requireKey(): string {
    const key = this.readApiKey();
    if (!key) {
      throw new DomainError({
        status: 503,
        code: 'APOLLO_NOT_CONFIGURED',
        title: 'Apollo API key is not configured',
        detail:
          'Provide a valid Apollo API key in secrets/apollo_api_key.txt before searching or enriching.',
      });
    }
    return key;
  }

  private async postJson(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DomainError({
        status: 502,
        code: 'APOLLO_UPSTREAM_UNREACHABLE',
        title: 'Could not reach Apollo API',
        detail: `Network error talking to Apollo (${(err as Error).name ?? 'Error'}).`,
      });
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      throw new DomainError({
        status: 429,
        code: 'APOLLO_RATE_LIMITED',
        title: 'Apollo rate limit reached',
        detail: retryAfter
          ? `Apollo asked to retry after ${retryAfter}s.`
          : 'Apollo rate limit reached; wait a minute before retrying.',
      });
    }

    if (!res.ok) {
      throw new DomainError({
        status: 502,
        code: 'APOLLO_UPSTREAM_ERROR',
        title: 'Apollo API returned an error',
        detail: `Apollo responded with HTTP ${res.status}.`,
      });
    }

    return (await res.json()) as Record<string, unknown>;
  }

  async searchPeople(input: ApolloSearchInput): Promise<{
    people: ApolloPersonPreview[];
    totalEntries: number;
    page: number;
    perPage: number;
  }> {
    const payload: Record<string, unknown> = {
      page: input.page,
      per_page: input.perPage,
    };
    if (input.qKeywords) payload['q_keywords'] = input.qKeywords;
    if (input.personTitles && input.personTitles.length > 0) {
      payload['person_titles'] = input.personTitles;
    }
    if (input.organizationLocations && input.organizationLocations.length > 0) {
      payload['organization_locations'] = input.organizationLocations;
    } else if (input.market === 'US') {
      payload['organization_locations'] = ['United States'];
    } else if (input.market === 'CA') {
      payload['organization_locations'] = ['Canada'];
    }
    if (input.organizationNumEmployeesRanges && input.organizationNumEmployeesRanges.length > 0) {
      payload['organization_num_employees_ranges'] = input.organizationNumEmployeesRanges;
    }

    const json = await this.postJson('/v1/mixed_people/search', payload);
    const rawPeople = Array.isArray(json['people'])
      ? (json['people'] as Array<Record<string, unknown>>)
      : Array.isArray(json['contacts'])
        ? (json['contacts'] as Array<Record<string, unknown>>)
        : [];
    const pagination =
      typeof json['pagination'] === 'object' && json['pagination'] !== null
        ? (json['pagination'] as Record<string, unknown>)
        : {};

    const people: ApolloPersonPreview[] = rawPeople
      .map((p) => {
        const id = typeof p['id'] === 'string' ? p['id'].trim() : '';
        if (!id) return null;
        const org =
          typeof p['organization'] === 'object' && p['organization'] !== null
            ? (p['organization'] as Record<string, unknown>)
            : {};
        const rawEmail = typeof p['email'] === 'string' ? p['email'].trim() : '';
        const usableEmail = rawEmail && !rawEmail.includes('email_not_unlocked') ? rawEmail : null;
        return {
          apolloPersonId: id,
          apolloOrgId: typeof org['id'] === 'string' ? org['id'] : null,
          firstName: typeof p['first_name'] === 'string' ? p['first_name'] : '',
          lastName: typeof p['last_name'] === 'string' ? p['last_name'] : '',
          title: typeof p['title'] === 'string' ? p['title'] : '',
          firmName:
            typeof org['name'] === 'string'
              ? org['name']
              : typeof p['organization_name'] === 'string'
                ? p['organization_name']
                : '',
          domain:
            typeof org['primary_domain'] === 'string'
              ? org['primary_domain']
              : typeof p['domain'] === 'string'
                ? p['domain']
                : '',
          country: typeof p['country'] === 'string' ? p['country'] : null,
          state: typeof p['state'] === 'string' ? p['state'] : null,
          email: usableEmail,
          emailVerificationStatus: mapApolloEmailStatus(p['email_status']),
          hasEmail: Boolean(usableEmail || p['email_status'] === 'verified' || p['has_email']),
        };
      })
      .filter((p): p is ApolloPersonPreview => p !== null && p.firstName.length > 0);

    return {
      people,
      totalEntries: Number(pagination['total_entries'] ?? people.length),
      page: Number(pagination['page'] ?? input.page),
      perPage: Number(pagination['per_page'] ?? input.perPage),
    };
  }

  async matchPerson(params: {
    apolloPersonId?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    domain?: string;
    organizationName?: string;
  }): Promise<ApolloMatchedPerson | null> {
    const body: Record<string, unknown> = {
      reveal_personal_emails: false,
      reveal_phone_number: false,
    };
    if (params.apolloPersonId) body['id'] = params.apolloPersonId;
    if (params.email) body['email'] = params.email;
    if (params.firstName) body['first_name'] = params.firstName;
    if (params.lastName) body['last_name'] = params.lastName;
    if (params.domain) body['domain'] = params.domain;
    if (params.organizationName) body['organization_name'] = params.organizationName;

    const json = await this.postJson('/v1/people/match', body);
    const p =
      typeof json['person'] === 'object' && json['person'] !== null
        ? (json['person'] as Record<string, unknown>)
        : null;
    if (!p || typeof p['id'] !== 'string') return null;
    const org =
      typeof p['organization'] === 'object' && p['organization'] !== null
        ? (p['organization'] as Record<string, unknown>)
        : {};
    const rawEmail = typeof p['email'] === 'string' ? p['email'].trim() : '';
    const email = rawEmail && !rawEmail.includes('email_not_unlocked') ? rawEmail : null;

    return {
      apolloPersonId: p['id'],
      apolloOrgId: typeof org['id'] === 'string' ? org['id'] : null,
      firstName: typeof p['first_name'] === 'string' ? p['first_name'] : '',
      lastName: typeof p['last_name'] === 'string' ? p['last_name'] : '',
      email,
      emailVerificationStatus: mapApolloEmailStatus(p['email_status']),
      title: typeof p['title'] === 'string' ? p['title'] : null,
      firmName: typeof org['name'] === 'string' ? org['name'] : null,
      domain: typeof org['primary_domain'] === 'string' ? org['primary_domain'] : null,
      estimatedEmployees:
        typeof org['estimated_num_employees'] === 'number' ? org['estimated_num_employees'] : null,
    };
  }

  async enrichOrganization(domain: string): Promise<ApolloOrganizationInfo | null> {
    const json = await this.postJson('/v1/organizations/enrich', { domain });
    const org =
      typeof json['organization'] === 'object' && json['organization'] !== null
        ? (json['organization'] as Record<string, unknown>)
        : null;
    if (!org || typeof org['id'] !== 'string') return null;
    return {
      apolloOrgId: org['id'],
      name: typeof org['name'] === 'string' ? org['name'] : domain,
      domain: typeof org['primary_domain'] === 'string' ? org['primary_domain'] : domain,
      websiteUrl: typeof org['website_url'] === 'string' ? org['website_url'] : null,
      estimatedEmployees:
        typeof org['estimated_num_employees'] === 'number' ? org['estimated_num_employees'] : null,
      country: typeof org['country'] === 'string' ? org['country'] : null,
      state: typeof org['state'] === 'string' ? org['state'] : null,
      city: typeof org['city'] === 'string' ? org['city'] : null,
    };
  }
}
