import { type Market, type SystemRoleName } from '@adas/shared';

export interface DevUser {
  id: string;
  displayName: string;
  email: string;
  initials: string;
  role: SystemRoleName;
  timeZone: string;
}

export const DEFAULT_DEV_USER: DevUser = {
  id: 'usr_01',
  displayName: 'Ved Shah',
  email: 'ved.shah@adasglobuspro.example.com',
  initials: 'VS',
  role: 'Super Admin',
  timeZone: 'Asia/Kolkata',
};

export const SYNTHETIC_DEV_USERS: readonly DevUser[] = [
  DEFAULT_DEV_USER,
  {
    id: 'usr_02',
    displayName: 'Arjun Mehta',
    email: 'arjun.mehta@adasglobuspro.example.com',
    initials: 'AM',
    role: 'Sales Executive',
    timeZone: 'Asia/Kolkata',
  },
  {
    id: 'usr_03',
    displayName: 'Priya Nair',
    email: 'priya.nair@adasglobuspro.example.com',
    initials: 'PN',
    role: 'Sales Manager',
    timeZone: 'Asia/Kolkata',
  },
];

/**
 * Dev login is compiled out of production builds (AGENTS.md §6).
 */
export function canUseDevLogin(isProdBuild: boolean = import.meta.env.PROD): boolean {
  return !isProdBuild;
}

export interface ApiHealthResponse {
  status: 'ok';
  service: string;
  version: string;
  timestamp: string;
}

async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  user: DevUser = DEFAULT_DEV_USER,
): Promise<T | null> {
  try {
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('x-dev-user-id', user.id);
    headers.set('x-dev-user-role', user.role);
    headers.set('x-csrf-token', 'csrf_dev_token');

    const response = await fetch(path, {
      ...options,
      headers,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export const apiClient = {
  getHealth(): Promise<ApiHealthResponse | null> {
    return requestJson<ApiHealthResponse>('/api/v1/health');
  },
  createLead(payload: {
    firstName: string;
    lastName?: string;
    email: string;
    companyName: string;
    market: Market;
    source?: string;
  }) {
    return requestJson<{ id: string }>('/api/v1/leads', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  convertLead(leadId: string, payload: { dealName: string; startTrial: boolean }) {
    return requestJson<{
      companyId: string;
      contactId: string;
      dealId: string;
      trialTasksCreated: number;
    }>(`/api/v1/leads/${encodeURIComponent(leadId)}/convert`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  createTask(payload: { title: string; priority?: 'low' | 'normal' | 'high' | 'urgent' }) {
    return requestJson<{ id: string }>('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  triggerN8nPipeline(payload: {
    workflowId: 'wf_01_lead_sequence_enroll' | 'wf_02_marketing_campaign_dispatch';
    contactId?: string;
  }) {
    return requestJson<{
      workflowId: string;
      webhookEventId: string;
      webhookSignature: string;
      webhookTimestamp: string;
      complianceGate: {
        sendable: boolean;
        reasonCode: string;
        reasonMessage: string;
      };
      enrollmentId: string | null;
      messageSendId: string | null;
      providerMessageId: string | null;
      transportProvider: string;
    }>('/api/v1/n8n/pipeline/trigger', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  createN8nToken(payload: { name: string; scopes?: string[] }) {
    return requestJson<{ id: string; rawToken: string; tokenPrefix: string }>(
      '/api/v1/n8n/api-tokens',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  },
  tailorOutreachEmail(payload: {
    contactId?: string;
    firstName?: string;
    title?: string;
    companyName?: string;
    market?: Market;
    city?: string;
    stateProvince?: string;
    staffBand?: string;
    softwareStack?: string[];
    servicesNeeded?: string[];
  }) {
    return requestJson<{
      recipient: {
        firstName: string;
        title: string;
        companyName: string;
        market: 'US' | 'CA';
        location: string;
        staffBand: string;
        softwareStack: string[];
        servicesNeeded: string[];
      };
      subject: string;
      bodyPlainText: string;
      postalFooter: string;
      deliverabilityCheck: {
        spamRiskScore: number;
        wordCount: number;
        plainTextFirst: boolean;
        openTrackingDisabled: boolean;
        scheduledJitterMinutes: number;
        verdict: 'INBOX_READY' | 'REVIEW_NEEDED';
      };
    }>('/api/v1/outreach/tailor-preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  generateDeploymentBlueprint(payload: { domain: string; tunnelName?: string }) {
    return requestJson<{
      domain: string;
      tunnelName: string;
      serverMemoryGb: number;
      hostRoutes: {
        crmAppUrl: string;
        publicIntakeAndUnsubUrl: string;
        uptimeStatusUrl: string;
        n8nAutomationUrl: string;
      };
      cloudflareTunnelYaml: string;
      dnsRecordsBind: string;
      exeInstallerPath: string;
    }>('/api/v1/deployment/blueprint', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};
