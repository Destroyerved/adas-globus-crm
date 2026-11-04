import { type Currency, type Market } from '@adas/shared';

/**
 * Typed client for the ADAS CRM API. Every failure throws an ApiError so screens can show
 * their error state; nothing falls back to demo data (AGENTS.md section 5).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Who is signed in. The session lives in an HttpOnly cookie the browser sends itself. */
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: string;
  teamId: string | null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', "Can't reach the CRM server. Check that it's running.");
  }

  const text = await response.text();
  const body: unknown = text ? safeJson(text) : null;
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    const problem = (body ?? {}) as {
      code?: string;
      detail?: string;
      title?: string;
      fieldErrors?: Record<string, string[]>;
    };
    throw new ApiError(
      response.status,
      problem.code ?? 'HTTP_ERROR',
      problem.detail ?? problem.title ?? `Request failed (${response.status}).`,
      problem.fieldErrors ?? {},
    );
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// Row shapes returned by the API (snake_case columns from PostgreSQL)
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role_name: string;
  team_name: string | null;
}

export interface LeadRow {
  id: string;
  full_name: string;
  email: string;
  firm_name: string | null;
  title: string | null;
  market: Market;
  status: string;
  status_category: string;
  source: string;
  owner_user_id: string;
  company_id: string | null;
  contact_id: string | null;
  services_needed: string[];
  lead_score: number | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  firm_type: string;
  market: Market;
  state_province: string | null;
  city: string | null;
  timezone: string;
  staff_band: string;
  account_status: string;
  owner_user_id: string;
  accounting_software: string[];
  services_needed: string[];
  version: number;
  updated_at: string;
}

export interface ContactRow {
  id: string;
  company_id: string | null;
  full_name: string;
  title: string | null;
  primary_email: string;
  phone_e164: string | null;
  market: Market;
  timezone: string;
  owner_user_id: string;
  do_not_contact: boolean;
  email_verification_status: string;
  updated_at: string;
}

export interface DealRow {
  id: string;
  name: string;
  company_id: string;
  primary_contact_id: string | null;
  stage_id: string;
  stage_name: string;
  stage_category: 'open' | 'won' | 'lost';
  monthly_value_minor: string;
  currency: Currency;
  fte_count: string | number;
  probability: number;
  expected_close_date: string | null;
  owner_user_id: string;
  version: number;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  title: string;
  task_type: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: string;
  due_at: string;
  assignee_user_id: string;
  company_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  lead_id: string | null;
}

export interface ActivityRow {
  id: string;
  activity_type: string;
  title: string;
  detail: string;
  actor_user_id: string | null;
  occurred_at: string;
}

export interface CompanyProfile {
  company: CompanyRow;
  contacts: ContactRow[];
  deals: DealRow[];
  tasks: TaskRow[];
  activities: ActivityRow[];
}

/** The stages of the New business pipeline, in board order (PRD 3.3). */
export const PIPELINE_STAGES = [
  'New Opportunity',
  'Discovery Scheduled',
  'Free Trial (3-Day)',
  'Proposal Sent',
  'Negotiation / MSA',
  'Won',
  'Lost',
] as const;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

type Items<T> = { items: T[] };

export const api = {
  authConfig: () => request<{ microsoftSignIn: boolean; devSignIn: boolean }>('/auth/config'),
  me: () => request<CurrentUser>('/auth/me'),
  devLogin: (userId: string) => post<CurrentUser>('/auth/dev-login', { userId }),
  logout: () => post<undefined>('/auth/logout', {}),

  listUsers: () => request<Items<UserRow>>('/users').then((r) => r.items),

  listLeads: () => request<Items<LeadRow>>('/leads').then((r) => r.items),
  createLead: (input: {
    firstName: string;
    lastName: string;
    email: string;
    firmName?: string;
    title?: string;
    market: Market;
  }) => post<LeadRow>('/leads', input),
  convertLead: (input: { leadId: string; dealName?: string; monthlyValueMinor?: string }) =>
    post<{ leadId: string; companyId: string | null; contactId: string; dealId: string | null }>(
      '/leads/convert',
      input,
    ),

  listCompanies: () => request<Items<CompanyRow>>('/companies').then((r) => r.items),
  getCompanyProfile: (id: string) =>
    request<CompanyProfile>(`/companies/${encodeURIComponent(id)}`),
  createCompany: (input: { name: string; websiteOrDomain?: string; market: Market }) =>
    post<{ company: CompanyRow; created: boolean }>('/companies', input),

  listContacts: () => request<Items<ContactRow>>('/contacts').then((r) => r.items),
  createContact: (input: {
    firstName: string;
    lastName: string;
    primaryEmail: string;
    title?: string;
    companyId?: string | null;
    market: Market;
  }) => post<ContactRow>('/contacts', input),

  listDeals: () => request<Items<DealRow>>('/deals').then((r) => r.items),
  moveDealStage: (
    id: string,
    input: {
      stageName: string;
      version: number;
      trialCandidateRole?: string;
      contractStartDate?: string;
      lostReason?: string;
    },
  ) => patch<DealRow>(`/deals/${encodeURIComponent(id)}/stage`, input),

  listTasks: () => request<Items<TaskRow>>('/tasks').then((r) => r.items),
  createTask: (input: {
    title: string;
    dueAt: string;
    taskType?: string;
    priority?: TaskRow['priority'];
    companyId?: string | null;
  }) => post<TaskRow>('/tasks', input),
  completeTask: (id: string) => post<TaskRow>(`/tasks/${encodeURIComponent(id)}/complete`, {}),
};
