import {
  type AddContactEmailInput,
  type AddContactPhoneInput,
  type AddDealContactInput,
  type AddSuppressedDomainInput,
  type AddSuppressionInput,
  type AdminMailboxRow,
  type BulkActionInput,
  type BulkJobView,
  type BatchEnrollSequenceInput,
  type CampaignBlock,
  type CampaignStatus,
  type ConvertLeadInput,
  type CreateCampaignInput,
  type CreateCustomFieldInput,
  type CreateEmailTemplateInput,
  type CreateMarketingListInput,
  type CreateOutreachTemplateInput,
  type CreateSavedViewInput,
  type CreateScoringRuleInput,
  type CreateSenderIdentityInput,
  type CreateSequenceInput,
  type CreateTaskFromEmailInput,
  type Currency,
  type CustomFieldDefinitionView,
  type DashboardSummaryView,
  type DealContactView,
  type DuplicateCandidateView,
  type EmailTemplateView,
  type EnrollmentStateActionInput,
  type ExportCreateInput,
  type ExportView,
  type FxRateView,
  type ImportBatchView,
  type ImportEntity,
  type ImportRowView,
  type InboxThreadDetail,
  type InboxThreadFilterStatus,
  type InboxThreadSummary,
  type InquiryFormType,
  type InquirySummaryView,
  type LiftSuppressionInput,
  type MailboxStatusView,
  type ManualLinkEmailInput,
  type Market,
  type MarketingBasisSummary,
  type MergeEntity,
  type MergeInput,
  type MergePreviewView,
  type MergeView,
  type ModifyListMembersInput,
  type PrivacyEraseInput,
  type RecordConsentInput,
  type RecurrenceRule,
  type RemoveSuppressedDomainInput,
  type ReplyInboxThreadInput,
  type ReportFilterOptions,
  type ReportId,
  type ReportResultView,
  type RoutingRuleView,
  type SavedView,
  type SavedViewEntity,
  type ScheduleCampaignInput,
  type ScoreBreakdownItem,
  type ScoringRuleView,
  type SendInboxEmailInput,
  type SetCustomFieldsInput,
  type SetPrimaryContactEmailInput,
  type SetPrimaryContactPhoneInput,
  type SuppressionStateFilter,
  type TemplateChannel,
  type TestSendCampaignInput,
  type ApiTokenView,
  type ApolloImportInput,
  type ApolloSearchInput,
  type CreateApiTokenInput,
  type CreateWebhookEndpointInput,
  type Scope,
  type UpdateApolloCreditLimitInput,
  type UpdateCampaignInput,
  type UpdateCustomFieldInput,
  type UpdateDealContactInput,
  type UpdateInboxThreadInput,
  type UpdateMarketingListInput,
  type UpdateOutreachTemplateInput,
  type UpdateRoutingRuleInput,
  type UpdateSavedViewInput,
  type UpdateScoringRuleInput,
  type UpdateSenderIdentityInput,
  type UpdateSequenceInput,
  type UpdateWebhookEndpointInput,
  type UpsertFxRateInput,
  type WithdrawConsentInput,
  type BackupRunView,
  type DeadLetterEventView,
  type HealthCheckResponse,
  type SystemHealthOverview,
  type WorkerHeartbeatView,
} from '@adas/shared';

const MERGE_PATH: Record<MergeEntity, string> = { contact: 'contacts', company: 'companies' };

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
  capabilities?: Record<string, string>;
  timezone?: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', "Can't reach the CRM server. Check that it's running.");
  }

  const text = await response.text();
  const body: unknown = text ? safeJson(text) : null;
  if (response.status === 204) return undefined as T;
  if (!response.ok) throw problemError(response.status, body);
  return body as T;
}

/** An RFC 9457 problem response as an ApiError. */
function problemError(status: number, body: unknown): ApiError {
  const problem = (body ?? {}) as {
    code?: string;
    detail?: string;
    title?: string;
    fieldErrors?: Record<string, string[]>;
  };
  return new ApiError(
    status,
    problem.code ?? 'HTTP_ERROR',
    problem.detail ?? problem.title ?? `Request failed (${status}).`,
    problem.fieldErrors ?? {},
  );
}

/** A file from the API, with the name the server gave it; errors throw like any request. */
async function download(path: string): Promise<{ blob: Blob; filename: string }> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', "Can't reach the CRM server. Check that it's running.");
  }
  if (!response.ok) throw problemError(response.status, safeJson(await response.text()));
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download';
  return { blob: await response.blob(), filename };
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
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });
const enc = (value: string) => encodeURIComponent(value);

/** A new key per create, so a retried request can't create the record twice (PRD 6.7). */
function createWithKey<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
}

// ---------------------------------------------------------------------------
// Lists: keyset pages, search, sort and the filter language (PRD 6.7, 6.8)
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export type FilterCondition = { field: string; op: string; value?: unknown };
export type Filter = FilterCondition | { and: Filter[] } | { or: Filter[] };

export interface ListParams {
  q?: string;
  sort?: string;
  filter?: Filter | null;
  cursor?: string | null;
  limit?: number;
  view?: string;
}

function listQuery(params: ListParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.sort) search.set('sort', params.sort);
  if (params.filter) search.set('filter', JSON.stringify(params.filter));
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.view) search.set('view', params.view);
  const text = search.toString();
  return text ? `?${text}` : '';
}

// ---------------------------------------------------------------------------
// Row shapes returned by the API (snake_case columns from PostgreSQL)
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role_name: string;
  team_name: string | null;
  team_id?: string | null;
  status?: string;
}

export type EntityType = 'lead' | 'contact' | 'company' | 'deal';

export interface LeadRow {
  id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  phone_e164: string | null;
  firm_name: string | null;
  website: string | null;
  domain: string | null;
  title: string | null;
  market: Market;
  state_province: string | null;
  staff_band: string;
  status: string;
  status_category: string;
  disqualification_reason: string | null;
  source: string;
  owner_user_id: string;
  company_id: string | null;
  contact_id: string | null;
  converted_deal_id: string | null;
  services_needed: string[];
  software_stack: string[];
  lead_score: number | null;
  lead_score_breakdown?: ScoreBreakdownItem[];
  custom_fields?: Record<string, unknown>;
  last_contacted_at: string | null;
  tags?: string[];
  version: number;
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
  custom_fields?: Record<string, unknown>;
  contact_count?: number;
  open_deal_count?: number;
  last_contacted_at?: string | null;
  tags?: string[];
  version: number;
  updated_at: string;
}

export interface ContactRow {
  id: string;
  company_id: string | null;
  company_name?: string | null;
  first_name: string;
  last_name: string;
  full_name: string;
  title: string | null;
  seniority: string;
  job_function: string;
  primary_email: string;
  phone_e164: string | null;
  market: Market;
  timezone: string;
  owner_user_id: string;
  do_not_contact: boolean;
  email_verification_status: string;
  lead_score?: number | null;
  lead_score_breakdown?: ScoreBreakdownItem[];
  custom_fields?: Record<string, unknown>;
  last_contacted_at?: string | null;
  tags?: string[];
  version: number;
  updated_at: string;
}

export interface DealRow {
  id: string;
  name: string;
  pipeline_id?: string;
  company_id: string;
  company_name?: string;
  primary_contact_id: string | null;
  primary_contact_name?: string | null;
  stage_id: string;
  stage_name: string;
  stage_category: 'open' | 'won' | 'lost';
  monthly_value_minor: string;
  one_time_value_minor?: string;
  term_months?: number;
  contract_value_minor?: string;
  currency: Currency;
  fte_count: string | number;
  engagement_model?: string;
  services?: string[];
  probability: number;
  probability_override?: boolean;
  expected_close_date: string | null;
  trial_candidate_role?: string | null;
  contract_start_date?: string | null;
  trial_ends_at?: string | null;
  closed_at?: string | null;
  lost_reason?: string | null;
  owner_user_id: string;
  is_idle?: boolean;
  idle_days?: number;
  custom_fields?: Record<string, unknown>;
  tags?: string[];
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
  reminder_at?: string | null;
  recurrence_rule?: RecurrenceRule | null;
  parent_task_id?: string | null;
  next_task_id?: string | null;
  completed_at?: string | null;
  outcome?: string | null;
  assignee_user_id: string;
  assignee_name?: string;
  assignee_timezone?: string;
  company_id: string | null;
  company_name?: string | null;
  contact_id: string | null;
  contact_name?: string | null;
  deal_id: string | null;
  deal_name?: string | null;
  lead_id: string | null;
  lead_name?: string | null;
  version: number;
}

export interface ActivityRow {
  id: string;
  activity_type: string;
  title: string;
  detail: string;
  actor_user_id: string | null;
  occurred_at: string;
}

export interface TimelineItem {
  id: string;
  source: 'activity' | 'note' | 'history' | 'email';
  kind: string;
  title: string;
  detail: string;
  actor_user_id: string | null;
  actor_name: string | null;
  at: string;
  metadata: Record<string, unknown>;
}

export interface CompanyProfile {
  company: CompanyRow;
  contacts: ContactRow[];
  leads?: LeadRow[];
  deals: DealRow[];
  tasks: TaskRow[];
  activities: ActivityRow[];
}

export interface LeadProfile {
  lead: LeadRow;
  tasks: TaskRow[];
  owner: { id: string; name: string } | null;
}

export interface ContactProfile {
  contact: ContactRow;
  company: { id: string; name: string; domain: string | null; market: Market } | null;
  emails: { email: string; is_primary: boolean; verification_status: string }[];
  phones: { phone_e164: string; phone_label: string; is_primary: boolean }[];
  deals: DealRow[];
  leads: {
    id: string;
    status: string;
    status_category: string;
    source: string;
    created_at: string;
  }[];
  tasks: TaskRow[];
  suppression: {
    id: string;
    kind: 'email' | 'domain';
    reason: string;
    source: string;
    created_at: string;
  } | null;
  consent: {
    id: string;
    basis: string;
    purpose: string;
    status: string;
    source: string;
    proof_text: string | null;
    captured_at: string;
    expires_at: string | null;
    revoked_at: string | null;
  } | null;
  marketingBasis: MarketingBasisSummary;
  enrollments: { id: string; sequence_name: string; status: string; enrolled_at: string }[];
}

export interface SuppressionView {
  id: string;
  email: string | null;
  emailSha256: string;
  reason: 'unsubscribe' | 'complaint' | 'hard_bounce' | 'manual_dnc' | 'privacy_erasure';
  source: string;
  notes: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  liftedAt: string | null;
  liftedByUserId: string | null;
  liftedByName: string | null;
  liftedReason: string | null;
  isPermanent: boolean;
}

export interface SuppressedDomainView {
  id: string;
  domain: string;
  reason: string;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface StageRow {
  id: string;
  name: string;
  category: 'open' | 'won' | 'lost';
  probability: number;
  stage_order: number;
  required_fields: string[];
  idle_days?: number;
  is_trial?: boolean;
}

export interface DealProfile {
  deal: DealRow;
  company: { id: string; name: string; market: Market } | null;
  primaryContact: { id: string; full_name: string; title: string | null } | null;
  dealContacts?: DealContactView[];
  tasks: TaskRow[];
  stages: StageRow[];
}

export interface BoardStage extends StageRow {
  count: number;
  totals: { currency: Currency; monthlyValueMinor: string }[];
  deals: DealRow[];
}

export interface PipelineRow {
  id: string;
  name: string;
  is_default: boolean;
  stages: StageRow[];
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

export type ReferenceLists = Record<string, string[]>;

export interface SearchResults {
  companies: { id: string; name: string; domain: string | null; market: Market }[];
  contacts: { id: string; full_name: string; primary_email: string; title: string | null }[];
  leads: {
    id: string;
    full_name: string;
    email: string;
    firm_name: string | null;
    status: string;
  }[];
  deals: { id: string; name: string; stage_name: string; company_id?: string }[];
  notes?: {
    id: string;
    entity_type: 'company' | 'contact' | 'lead' | 'deal';
    entity_id: string;
    snippet: string;
    created_at: string;
  }[];
  emailThreads?: {
    id: string;
    subject: string;
    snippet: string;
    contact_id: string | null;
    company_id: string | null;
    deal_id: string | null;
    lead_id: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

type Items<T> = { items: T[] };

export interface ImportTemplate {
  id: string;
  name: string;
  entity: ImportEntity;
  mapping: Record<string, string>;
}

export interface ImportMappingRequest {
  entity: ImportEntity;
  mapping: Record<string, string>;
  version: number;
  options: {
    duplicatePolicy: 'skip' | 'fill_blanks' | 'overwrite';
    source: string;
    ownerUserId: string;
    market: Market;
    tags: string[];
  };
}
type Patch = Record<string, unknown> & { version: number };

const plural = (entityType: EntityType) =>
  entityType === 'company' ? 'companies' : `${entityType}s`;

// ---------------------------------------------------------------------------
// Administration (PRD 2.1, 2.2, 3.3, 3.4, 4.17)
// ---------------------------------------------------------------------------

export type ScopeValue = 'own' | 'team' | 'all' | 'none';

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role_id: string;
  role_name: string;
  team_id: string | null;
  team_name: string | null;
  market_focus: Market;
  status: 'invited' | 'active' | 'disabled';
  timezone: string;
  daily_send_cap: number;
  is_break_glass: boolean;
  version: number;
  created_at: string;
  last_sign_in_at?: string | null;
}

export interface TeamRow {
  id: string;
  name: string;
  market: Market;
  version: number;
  member_count: number;
}

export interface RoleRow {
  id: string;
  name: string;
  description: string;
  user_count: number;
  grants: Record<string, ScopeValue>;
  changed: string[];
  locked: string[];
}

export interface AdminStageRow extends StageRow {
  pipeline_id: string;
  idle_days: number;
  is_trial: boolean;
  version: number;
  deal_count: number;
}

export interface AdminPipelineRow {
  id: string;
  name: string;
  is_default: boolean;
  stages: AdminStageRow[];
}

export interface SettingRow {
  key: string;
  value: unknown;
  version: number;
  updated_at: string;
  updated_by_name: string | null;
}

export interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Dashboard (PRD 4.2, 14)
// ---------------------------------------------------------------------------

export type WidgetId =
  | 'followups_today'
  | 'overdue_tasks'
  | 'sla_inquiries'
  | 'leads_by_status'
  | 'pipeline_by_stage'
  | 'won_lost'
  | 'sla_breaches'
  | 'overdue_by_person'
  | 'leads_by_source_market'
  | 'trial_to_win'
  | 'activity_summary'
  | 'outreach_performance';

export interface DashboardLayout {
  widgets: WidgetId[];
  timezone: string;
  reportingCurrency: Currency;
  defaultRange: { from: string; to: string };
}

export interface DashboardPeriod {
  from: string;
  to: string;
  market?: string;
}

export interface WidgetResult<T = Record<string, unknown>> {
  id: WidgetId;
  /** start and end are the period's UTC instants (end exclusive). */
  period: { from: string; to: string; market: string | null; start: string; end: string };
  generatedAt: string;
  data: T;
}

export const api = {
  authConfig: () =>
    request<{ microsoftSignIn: boolean; devSignIn: boolean; adminSignIn: boolean }>('/auth/config'),
  me: () => request<CurrentUser>('/auth/me'),
  devLogin: (userId: string) => post<CurrentUser>('/auth/dev-login', { userId }),
  adminSignIn: (input: { email: string; password: string; totpCode: string }) =>
    post<CurrentUser>('/auth/local/login', input),
  logout: () => post<undefined>('/auth/logout', {}),

  listUsers: () => request<Items<UserRow>>('/users').then((r) => r.items),
  referenceLists: () => request<ReferenceLists>('/reference-lists'),
  search: (q: string, options?: { extended?: boolean }) =>
    request<SearchResults>(`/search?q=${enc(q)}${options?.extended ? '&extended=1' : ''}`),

  // Leads
  listLeads: (params: ListParams = {}) => request<Page<LeadRow>>(`/leads${listQuery(params)}`),
  getLead: (leadId: string) => request<LeadProfile>(`/leads/${enc(leadId)}`),
  createLead: (input: {
    firstName: string;
    lastName: string;
    email: string;
    firmName?: string;
    title?: string;
    market: Market;
  }) => createWithKey<LeadRow>('/leads', input),
  updateLead: (leadId: string, input: Patch) => patch<LeadRow>(`/leads/${enc(leadId)}`, input),
  convertLead: (input: ConvertLeadInput) =>
    post<{ leadId: string; companyId: string | null; contactId: string; dealId: string | null }>(
      '/leads/convert',
      input,
    ),

  // Companies
  listCompanies: (params: ListParams = {}) =>
    request<Page<CompanyRow>>(`/companies${listQuery(params)}`),
  getCompanyProfile: (companyId: string) => request<CompanyProfile>(`/companies/${enc(companyId)}`),
  createCompany: (input: { name: string; websiteOrDomain?: string; market: Market }) =>
    createWithKey<{ company: CompanyRow; created: boolean }>('/companies', input),
  updateCompany: (companyId: string, input: Patch) =>
    patch<CompanyRow>(`/companies/${enc(companyId)}`, input),

  // Contacts
  listContacts: (params: ListParams = {}) =>
    request<Page<ContactRow>>(`/contacts${listQuery(params)}`),
  getContact: (contactId: string) => request<ContactProfile>(`/contacts/${enc(contactId)}`),
  createContact: (input: {
    firstName: string;
    lastName: string;
    primaryEmail: string;
    title?: string;
    companyId?: string | null;
    market: Market;
  }) => createWithKey<ContactRow>('/contacts', input),
  updateContact: (contactId: string, input: Patch) =>
    patch<ContactRow>(`/contacts/${enc(contactId)}`, input),
  addContactEmail: (contactId: string, input: AddContactEmailInput) =>
    post<{ emails: ContactProfile['emails'] }>(`/contacts/${enc(contactId)}/emails`, input),
  setPrimaryContactEmail: (contactId: string, input: SetPrimaryContactEmailInput) =>
    post<{ emails: ContactProfile['emails'] }>(`/contacts/${enc(contactId)}/emails/primary`, input),
  removeContactEmail: (contactId: string, email: string) =>
    del<{ emails: ContactProfile['emails'] }>(
      `/contacts/${enc(contactId)}/emails?email=${enc(email)}`,
    ),
  addContactPhone: (contactId: string, input: AddContactPhoneInput) =>
    post<{ phones: ContactProfile['phones'] }>(`/contacts/${enc(contactId)}/phones`, input),
  setPrimaryContactPhone: (contactId: string, input: SetPrimaryContactPhoneInput) =>
    post<{ phones: ContactProfile['phones'] }>(`/contacts/${enc(contactId)}/phones/primary`, input),
  removeContactPhone: (contactId: string, phoneE164: string) =>
    del<{ phones: ContactProfile['phones'] }>(
      `/contacts/${enc(contactId)}/phones?phone=${enc(phoneE164)}`,
    ),

  // Deals and pipelines
  listDeals: (params: ListParams = {}) => request<Page<DealRow>>(`/deals${listQuery(params)}`),
  getDeal: (dealId: string) => request<DealProfile>(`/deals/${enc(dealId)}`),
  updateDeal: (dealId: string, input: Patch) => patch<DealRow>(`/deals/${enc(dealId)}`, input),
  addDealContact: (dealId: string, input: AddDealContactInput) =>
    post<{ dealContacts: DealContactView[] }>(`/deals/${enc(dealId)}/contacts`, input),
  updateDealContact: (dealId: string, contactId: string, input: UpdateDealContactInput) =>
    patch<{ dealContacts: DealContactView[] }>(
      `/deals/${enc(dealId)}/contacts/${enc(contactId)}`,
      input,
    ),
  removeDealContact: (dealId: string, contactId: string) =>
    del<{ dealContacts: DealContactView[] }>(`/deals/${enc(dealId)}/contacts/${enc(contactId)}`),
  moveDealStage: (
    dealId: string,
    input: {
      stageName: string;
      version: number;
      trialCandidateRole?: string;
      contractStartDate?: string;
      lostReason?: string;
      lostNotes?: string;
    },
  ) => patch<DealRow>(`/deals/${enc(dealId)}/stage`, input),
  pipelines: () => request<Items<PipelineRow>>('/pipelines').then((r) => r.items),
  board: (pipelineId: string, params: { owner?: string; q?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.owner) search.set('owner', params.owner);
    if (params.q) search.set('q', params.q);
    const qs = search.toString();
    return request<{ pipelineId: string; stages: BoardStage[] }>(
      `/pipelines/${enc(pipelineId)}/board${qs ? `?${qs}` : ''}`,
    );
  },

  // Tasks
  listTasks: (params: ListParams = {}) => request<Page<TaskRow>>(`/tasks${listQuery(params)}`),
  createTask: (input: {
    title: string;
    dueAt: string;
    taskType?: string;
    priority?: TaskRow['priority'];
    assigneeUserId?: string;
    companyId?: string | null;
    contactId?: string | null;
    leadId?: string | null;
    dealId?: string | null;
    reminderAt?: string | null;
    recurrenceRule?: RecurrenceRule | null;
  }) => createWithKey<TaskRow>('/tasks', input),
  updateTask: (taskId: string, input: Patch) => patch<TaskRow>(`/tasks/${enc(taskId)}`, input),
  completeTask: (taskId: string, outcome?: string) =>
    post<TaskRow>(`/tasks/${enc(taskId)}/complete`, outcome ? { outcome } : {}),

  // Timeline, notes, tags, activities
  timeline: (entityType: EntityType, entityId: string, before?: string | null) =>
    request<{ items: TimelineItem[]; nextBefore: string | null }>(
      `/timeline?entityType=${entityType}&entityId=${enc(entityId)}${before ? `&before=${enc(before)}` : ''}`,
    ),
  logActivity: (input: {
    activityType: 'call' | 'meeting' | 'email_logged';
    entityType: EntityType;
    entityId: string;
    detail: string;
    outcome?: string;
    occurredAt?: string;
  }) => createWithKey<ActivityRow>('/activities', input),
  createNote: (input: { entityType: EntityType; entityId: string; body: string }) =>
    createWithKey<{ id: string }>('/notes', input),
  updateNote: (noteId: string, input: { version: number; body: string }) =>
    patch<{ id: string }>(`/notes/${enc(noteId)}`, input),
  listTags: () =>
    request<Items<{ id: string; name: string; usage_count: number }>>('/tags').then((r) => r.items),
  setTags: (entityType: EntityType, entityId: string, tags: string[]) =>
    put<{ tags: string[] }>(`/tags/${entityType}/${enc(entityId)}`, { tags }),
  deleteRecord: (entityType: EntityType, entityId: string) =>
    del<{ id: string }>(`/${plural(entityType)}/${enc(entityId)}`),

  // Preferences, administration and dashboard
  updatePreferences: (input: { timezone: string }) =>
    patch<{ timezone: string }>('/me/preferences', input),
  adminUsers: () => request<Items<AdminUserRow>>('/admin/users').then((r) => r.items),
  inviteUser: (input: {
    email: string;
    name: string;
    roleId: string;
    teamId: string | null;
    marketFocus: Market;
    timezone: string;
  }) => createWithKey<AdminUserRow>('/admin/users', input),
  updateUser: (userId: string, input: Patch) =>
    patch<AdminUserRow>(`/admin/users/${enc(userId)}`, input),
  adminTeams: () => request<Items<TeamRow>>('/admin/teams').then((r) => r.items),
  createTeam: (input: { name: string; market: Market }) =>
    createWithKey<TeamRow>('/admin/teams', input),
  updateTeam: (teamId: string, input: Patch) =>
    patch<TeamRow>(`/admin/teams/${enc(teamId)}`, input),
  adminRoles: () => request<{ items: RoleRow[]; capabilities: string[] }>('/admin/roles'),
  updateRoleCapabilities: (roleId: string, grants: Record<string, ScopeValue>) =>
    put<RoleRow>(`/admin/roles/${enc(roleId)}/capabilities`, { grants }),
  adminPipelines: () => request<Items<AdminPipelineRow>>('/admin/pipelines').then((r) => r.items),
  createStage: (
    pipelineId: string,
    input: { name: string; probability: number; idleDays: number },
  ) => createWithKey<AdminStageRow>(`/admin/pipelines/${enc(pipelineId)}/stages`, input),
  updateStage: (stageId: string, input: Patch) =>
    patch<AdminStageRow>(`/admin/stages/${enc(stageId)}`, input),
  moveStage: (stageId: string, version: number, direction: 'up' | 'down') =>
    post<{ id: string; moved: boolean }>(`/admin/stages/${enc(stageId)}/move`, {
      version,
      direction,
    }),
  deleteStage: (stageId: string) => del<{ id: string }>(`/admin/stages/${enc(stageId)}`),
  adminSettings: () => request<Items<SettingRow>>('/admin/settings').then((r) => r.items),
  updateSetting: (key: string, version: number, value: unknown) =>
    put<SettingRow>(`/admin/settings/${enc(key)}`, { version, value }),
  routingRules: () => request<Items<RoutingRuleView>>('/admin/routing-rules').then((r) => r.items),
  updateRoutingRule: (market: Market, input: UpdateRoutingRuleInput) =>
    put<RoutingRuleView>(`/admin/routing-rules/${enc(market)}`, input),
  recentInquiries: (
    params: {
      cursor?: string | null;
      limit?: number;
      market?: Market | '';
      formType?: InquiryFormType | '';
    } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.market) search.set('market', params.market);
    if (params.formType) search.set('formType', params.formType);
    const qs = search.toString();
    return request<{ items: InquirySummaryView[]; nextCursor: string | null; total: number }>(
      `/admin/inquiries${qs ? `?${qs}` : ''}`,
    );
  },
  auditLogs: (params: Record<string, string | null | undefined>) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
    const qs = search.toString();
    return request<{ items: AuditRow[]; nextCursor: string | null }>(
      `/audit-logs${qs ? `?${qs}` : ''}`,
    );
  },
  auditActions: () => request<Items<string>>('/audit-logs/actions').then((r) => r.items),
  dashboard: () => request<DashboardLayout>('/dashboard'),
  dashboardSummary: (period: DashboardPeriod) => {
    const search = new URLSearchParams({ from: period.from, to: period.to });
    if (period.market) search.set('market', period.market);
    return request<DashboardSummaryView>(`/dashboard/summary?${search.toString()}`);
  },
  dashboardWidget: <T>(id: WidgetId, period: DashboardPeriod) => {
    const search = new URLSearchParams({ from: period.from, to: period.to });
    if (period.market) search.set('market', period.market);
    return request<WidgetResult<T>>(`/dashboard/widgets/${id}?${search.toString()}`);
  },
  reportOptions: () => request<ReportFilterOptions>('/reports/options'),
  runReport: (
    id: ReportId,
    params: { from: string; to: string; market?: string; teamId?: string; ownerId?: string },
  ) => {
    const search = new URLSearchParams({ from: params.from, to: params.to });
    if (params.market) search.set('market', params.market);
    if (params.teamId) search.set('teamId', params.teamId);
    if (params.ownerId) search.set('ownerId', params.ownerId);
    return request<ReportResultView>(`/reports/${enc(id)}?${search.toString()}`);
  },
  downloadReportCsv: (
    id: ReportId,
    params: { from: string; to: string; market?: string; teamId?: string; ownerId?: string },
  ) => {
    const search = new URLSearchParams({ from: params.from, to: params.to });
    if (params.market) search.set('market', params.market);
    if (params.teamId) search.set('teamId', params.teamId);
    if (params.ownerId) search.set('ownerId', params.ownerId);
    return download(`/reports/${enc(id)}/export.csv?${search.toString()}`);
  },

  // Imports (PRD 4.9). The file goes as the raw body; its name in a header, not the URL.
  listImports: () => request<Items<ImportBatchView>>('/imports').then((r) => r.items),
  getImport: (importId: string) => request<ImportBatchView>(`/imports/${enc(importId)}`),
  uploadImport: (file: File) =>
    request<{ batch: ImportBatchView; suggested: Record<ImportEntity, Record<string, string>> }>(
      '/imports',
      {
        method: 'POST',
        body: file,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Upload-Filename': encodeURIComponent(file.name),
        },
      },
    ),
  setImportMapping: (importId: string, input: ImportMappingRequest) =>
    put<ImportBatchView>(`/imports/${enc(importId)}/mapping`, input),
  checkImport: (importId: string, version: number) =>
    post<ImportBatchView>(`/imports/${enc(importId)}/dry-run`, { version }),
  runImport: (importId: string, version: number) =>
    post<ImportBatchView>(`/imports/${enc(importId)}/run`, { version }),
  undoImport: (importId: string, version: number) =>
    post<ImportBatchView>(`/imports/${enc(importId)}/rollback`, { version }),
  importRows: (importId: string, params: { status?: string; undo?: 'kept'; cursor?: string }) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
    return request<{ items: ImportRowView[]; nextCursor: string | null }>(
      `/imports/${enc(importId)}/rows?${search.toString()}`,
    );
  },
  /** A download link (the browser sends the session cookie); the API audits each download. */
  importErrorsUrl: (importId: string) => `/api/v1/imports/${enc(importId)}/errors.csv`,
  importTemplates: (entity: ImportEntity) =>
    request<Items<ImportTemplate>>(`/imports/templates?entity=${entity}`).then((r) => r.items),
  saveImportTemplate: (input: {
    name: string;
    entity: ImportEntity;
    mapping: Record<string, string>;
  }) => post<ImportTemplate>('/imports/templates', input),

  // Duplicate review and merge (PRD 4.9)
  listDuplicates: (entity: MergeEntity, cursor?: string | null) => {
    const search = new URLSearchParams({ entity });
    if (cursor) search.set('cursor', cursor);
    return request<{ items: DuplicateCandidateView[]; nextCursor: string | null }>(
      `/duplicates?${search.toString()}`,
    );
  },
  getDuplicate: (pairId: string) => request<DuplicateCandidateView>(`/duplicates/${enc(pairId)}`),
  dismissDuplicate: (pairId: string) =>
    post<{ id: string; status: 'dismissed' }>(`/duplicates/${enc(pairId)}/dismiss`, {}),
  mergePreview: (entity: MergeEntity, keptId: string, mergedId: string) =>
    request<MergePreviewView>(
      `/${MERGE_PATH[entity]}/${enc(keptId)}/merge-preview?with=${enc(mergedId)}`,
    ),
  mergeRecords: (entity: MergeEntity, keptId: string, input: MergeInput) =>
    post<MergeView>(`/${MERGE_PATH[entity]}/${enc(keptId)}/merge`, input),
  listMerges: (entity: MergeEntity) =>
    request<Items<MergeView>>(`/merges?entity=${entity}`).then((r) => r.items),
  undoMerge: (mergeId: string) => post<MergeView>(`/merges/${enc(mergeId)}/undo`, {}),

  // Exports (PRD 4.9)
  createExport: (input: ExportCreateInput) => createWithKey<ExportView>('/exports', input),
  getExport: (exportId: string) => request<ExportView>(`/exports/${enc(exportId)}`),
  downloadExport: (exportId: string) => download(`/exports/${enc(exportId)}/download`),

  // Compliance, suppressions, consent and privacy (PRD 4.17, 4.18, 5.1-5.6)
  listSuppressions: (params: {
    q?: string;
    reason?: string;
    state?: SuppressionStateFilter;
    cursor?: string | null;
    limit?: number;
  }) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.reason) search.set('reason', params.reason);
    if (params.state) search.set('state', params.state);
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request<Page<SuppressionView>>(`/compliance/suppressions${qs ? `?${qs}` : ''}`);
  },
  addSuppression: (input: AddSuppressionInput) =>
    createWithKey<SuppressionView>('/compliance/suppressions', input),
  liftSuppression: (suppressionId: string, input: LiftSuppressionInput) =>
    post<SuppressionView>(`/compliance/suppressions/${enc(suppressionId)}/lift`, input),
  listSuppressedDomains: () =>
    request<Items<SuppressedDomainView>>('/compliance/suppressed-domains').then((r) => r.items),
  addSuppressedDomain: (input: AddSuppressedDomainInput) =>
    createWithKey<SuppressedDomainView>('/compliance/suppressed-domains', input),
  removeSuppressedDomain: (domainId: string, input: RemoveSuppressedDomainInput) =>
    post<{ id: string; removed: boolean }>(
      `/compliance/suppressed-domains/${enc(domainId)}/remove`,
      input,
    ),
  recordContactConsent: (contactId: string, input: RecordConsentInput) =>
    createWithKey<{
      id: string;
      contactId: string;
      basis: string;
      purpose: string;
      status: string;
      source: string;
      expiresAt: string | null;
    }>(`/contacts/${enc(contactId)}/consents`, input),
  withdrawContactConsent: (contactId: string, input: WithdrawConsentInput) =>
    post<{ contactId: string; revoked: boolean; suppressed: boolean }>(
      `/contacts/${enc(contactId)}/consents/withdraw`,
      input,
    ),
  downloadContactPrivacyJson: (contactId: string) =>
    download(`/contacts/${enc(contactId)}/privacy-export`),
  downloadContactPrivacyCsv: (contactId: string) =>
    download(`/contacts/${enc(contactId)}/privacy-export?format=csv`),
  eraseContactPrivacy: (contactId: string, input: PrivacyEraseInput) =>
    post<{
      contactId: string;
      erasedAt: string;
      suppressedHashes: string[];
      scrubbedLeadCount: number;
    }>(`/contacts/${enc(contactId)}/privacy-erase`, input),

  // Saved views & bulk actions (PRD 4.5, 4.8, 6.7)
  listSavedViews: (entity: SavedViewEntity) =>
    request<Items<SavedView>>(`/saved-views?entity=${enc(entity)}`).then((r) => r.items),
  createSavedView: (input: CreateSavedViewInput) => createWithKey<SavedView>('/saved-views', input),
  updateSavedView: (viewId: string, input: UpdateSavedViewInput) =>
    patch<SavedView>(`/saved-views/${enc(viewId)}`, input),
  deleteSavedView: (viewId: string) =>
    del<{ id: string; deleted: true }>(`/saved-views/${enc(viewId)}`),
  runBulkAction: (entity: SavedViewEntity, input: BulkActionInput) =>
    createWithKey<BulkJobView>(`/${plural(entity)}/bulk`, input),
  getBulkJob: (jobId: string) => request<BulkJobView>(`/bulk-jobs/${enc(jobId)}`),

  // Custom fields (PRD 4.3-4.6, 4.17, 6.8)
  listCustomFields: (entity?: EntityType | null, includeArchived = false) => {
    const search = new URLSearchParams();
    if (entity) search.set('entity', entity);
    if (includeArchived) search.set('includeArchived', '1');
    const qs = search.toString();
    return request<Items<CustomFieldDefinitionView>>(`/custom-fields${qs ? `?${qs}` : ''}`).then(
      (r) => r.items,
    );
  },
  createCustomField: (input: CreateCustomFieldInput) =>
    createWithKey<CustomFieldDefinitionView>('/admin/custom-fields', input),
  updateCustomField: (fieldId: string, input: UpdateCustomFieldInput) =>
    patch<CustomFieldDefinitionView>(`/admin/custom-fields/${enc(fieldId)}`, input),
  setRecordCustomFields: (entity: EntityType, recordId: string, input: SetCustomFieldsInput) =>
    put<{ customFields: Record<string, unknown>; version: number }>(
      `/${plural(entity)}/${enc(recordId)}/custom-fields`,
      input,
    ),

  // Lead & contact scoring rules (PRD 4.5, 4.16, 4.17)
  listScoringRules: () =>
    request<Items<ScoringRuleView>>('/admin/scoring-rules').then((r) => r.items),
  createScoringRule: (input: CreateScoringRuleInput) =>
    createWithKey<ScoringRuleView>('/admin/scoring-rules', input),
  updateScoringRule: (ruleId: string, input: UpdateScoringRuleInput) =>
    patch<ScoringRuleView>(`/admin/scoring-rules/${enc(ruleId)}`, input),
  deleteScoringRule: (ruleId: string) =>
    del<{ id: string; deleted: true }>(`/admin/scoring-rules/${enc(ruleId)}`),
  recalculateScores: () =>
    post<{ leadsUpdated: number; contactsUpdated: number }>('/admin/scoring-rules/recalculate', {}),

  // FX rates (PRD 4.15, 4.17, 14)
  listFxRates: () =>
    request<{ reportingCurrency: Currency; items: FxRateView[] }>('/admin/fx-rates'),
  upsertFxRate: (input: UpsertFxRateInput) =>
    createWithKey<{ rate: FxRateView }>('/admin/fx-rates', input),
  deleteFxRate: (rateId: string) =>
    del<{ id: string; deleted: true }>(`/admin/fx-rates/${enc(rateId)}`),

  // Notifications
  notifications: () => request<{ items: NotificationRow[]; unreadCount: number }>('/notifications'),
  markNotificationsRead: (notificationId?: string) =>
    post<{ updated: number }>('/notifications/read', notificationId ? { id: notificationId } : {}),

  // Inbox & Microsoft 365 Graph (PRD 4.11, 8.2, 8.7)
  inboxMailbox: () => request<MailboxStatusView>('/inbox/mailbox'),
  inboxOAuthStartUrl: () => '/api/v1/inbox/oauth/start',
  syncInboxMailbox: () =>
    post<{
      syncedMessages: number;
      ignoredMessages: number;
      bouncesProcessed: number;
      throttledUntil: string | null;
    }>('/inbox/mailbox/sync', {}),
  disconnectInboxMailbox: () =>
    post<{ disconnected: boolean; pausedSequences: number }>('/inbox/mailbox/disconnect', {}),
  adminMailboxes: () => request<Items<AdminMailboxRow>>('/admin/mailboxes').then((r) => r.items),
  listInboxThreads: (
    params: {
      status?: InboxThreadFilterStatus;
      q?: string;
      contactId?: string;
      companyId?: string;
      dealId?: string;
      leadId?: string;
      cursor?: string | null;
      limit?: number;
    } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.status && params.status !== 'all') search.set('status', params.status);
    if (params.q) search.set('q', params.q);
    if (params.contactId) search.set('contactId', params.contactId);
    if (params.companyId) search.set('companyId', params.companyId);
    if (params.dealId) search.set('dealId', params.dealId);
    if (params.leadId) search.set('leadId', params.leadId);
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request<{
      items: InboxThreadSummary[];
      nextCursor: string | null;
      counts: Record<string, number>;
    }>(`/inbox/threads${qs ? `?${qs}` : ''}`);
  },
  getInboxThread: (threadId: string) =>
    request<InboxThreadDetail>(`/inbox/threads/${enc(threadId)}`),
  sendInboxEmail: (input: SendInboxEmailInput) =>
    createWithKey<InboxThreadDetail>('/inbox/send', input),
  replyInboxThread: (threadId: string, input: ReplyInboxThreadInput) =>
    createWithKey<InboxThreadDetail>(`/inbox/threads/${enc(threadId)}/reply`, input),
  updateInboxThread: (threadId: string, input: UpdateInboxThreadInput) =>
    patch<InboxThreadSummary>(`/inbox/threads/${enc(threadId)}`, input),
  createTaskFromEmail: (messageId: string, input: CreateTaskFromEmailInput) =>
    createWithKey<TaskRow>(`/inbox/messages/${enc(messageId)}/task`, input),
  manualLinkEmail: (input: ManualLinkEmailInput) =>
    post<{ synced: boolean; threadId: string | null }>('/inbox/manual-link', input),
  downloadEmailAttachment: (messageId: string, attachmentId: string) =>
    download(`/inbox/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`),
  listInboxTemplates: () =>
    request<Items<EmailTemplateView>>('/inbox/templates').then((r) => r.items),
  createInboxTemplate: (input: CreateEmailTemplateInput) =>
    createWithKey<EmailTemplateView>('/inbox/templates', input),

  // System mail delivery mode (`/api/v1/healthz` -> `mailLive`)
  healthStatus: () =>
    request<{ status: string; mailLive: boolean; devLoginEnabled: boolean }>('/healthz'),

  // Outreach templates (sequence, campaign, inbox)
  listOutreachTemplates: (
    params: { channel?: TemplateChannel; market?: Market; q?: string } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.channel) search.set('channel', params.channel);
    if (params.market) search.set('market', params.market);
    if (params.q) search.set('q', params.q);
    const qs = search.toString();
    return request<Items<OutreachTemplateRow>>(`/templates${qs ? `?${qs}` : ''}`).then(
      (r) => r.items,
    );
  },
  createOutreachTemplate: (input: CreateOutreachTemplateInput) =>
    createWithKey<OutreachTemplateRow>('/templates', input),
  updateOutreachTemplate: (id: string, input: UpdateOutreachTemplateInput) =>
    patch<OutreachTemplateRow>(`/templates/${enc(id)}`, input),

  // Personal outreach sequences
  listSequences: () => request<Items<SequenceSummaryRow>>('/sequences').then((r) => r.items),
  getSequence: (sequenceId: string) => request<SequenceDetailView>(`/sequences/${enc(sequenceId)}`),
  createSequence: (input: CreateSequenceInput) =>
    createWithKey<SequenceSummaryRow>('/sequences', input),
  updateSequence: (sequenceId: string, input: UpdateSequenceInput) =>
    patch<SequenceSummaryRow>(`/sequences/${enc(sequenceId)}`, input),
  batchEnrollSequence: (sequenceId: string, input: BatchEnrollSequenceInput) =>
    createWithKey<{
      enrolled: Array<{ contactId: string; enrollmentId: string; nextSendAt: string }>;
      skipped: Array<{ contactId: string; reasonCode: string; reasonMessage: string }>;
    }>(`/sequences/${enc(sequenceId)}/enroll`, input),
  updateEnrollmentState: (enrollmentId: string, input: EnrollmentStateActionInput) =>
    post<SequenceEnrollmentRow>(`/enrollments/${enc(enrollmentId)}/state`, input),
  stopEnrollment: (enrollmentId: string, reason?: string) =>
    post<SequenceEnrollmentRow>(`/enrollments/${enc(enrollmentId)}/stop`, reason ? { reason } : {}),

  // Segments & static marketing lists
  listMarketingLists: () => request<Items<MarketingListRow>>('/lists').then((r) => r.items),
  getMarketingList: (listId: string) =>
    request<{ list: MarketingListRow; members: MarketingListMemberRow[]; totalCount: number }>(
      `/lists/${enc(listId)}`,
    ),
  createMarketingList: (input: CreateMarketingListInput) =>
    createWithKey<MarketingListRow>('/lists', input),
  updateMarketingList: (listId: string, input: UpdateMarketingListInput) =>
    patch<MarketingListRow>(`/lists/${enc(listId)}`, input),
  addMarketingListMembers: (listId: string, input: ModifyListMembersInput) =>
    post<{ addedCount: number; memberCount: number }>(`/lists/${enc(listId)}/members`, input),
  removeMarketingListMember: (listId: string, contactId: string) =>
    del<{ memberCount: number }>(`/lists/${enc(listId)}/members/${enc(contactId)}`),

  // Verified sender identities & sending subdomains
  listSenderIdentities: () =>
    request<Items<SenderIdentityRow>>('/sender-identities').then((r) => r.items),
  createSenderIdentity: (input: CreateSenderIdentityInput) =>
    createWithKey<SenderIdentityRow>('/sender-identities', input),
  updateSenderIdentity: (id: string, input: UpdateSenderIdentityInput) =>
    patch<SenderIdentityRow>(`/sender-identities/${enc(id)}`, input),

  // Marketing campaigns
  listCampaigns: () => request<Items<CampaignSummaryRow>>('/campaigns').then((r) => r.items),
  getCampaign: (campaignId: string) => request<CampaignDetailView>(`/campaigns/${enc(campaignId)}`),
  createCampaign: (input: CreateCampaignInput) =>
    createWithKey<CampaignSummaryRow>('/campaigns', input),
  updateCampaign: (campaignId: string, input: UpdateCampaignInput) =>
    patch<CampaignSummaryRow>(`/campaigns/${enc(campaignId)}`, input),
  getCampaignPreflight: (campaignId: string) =>
    request<CampaignPreflightView>(`/campaigns/${enc(campaignId)}/preflight`),
  submitCampaign: (campaignId: string) =>
    post<CampaignSummaryRow>(`/campaigns/${enc(campaignId)}/submit`, {}),
  approveCampaign: (campaignId: string) =>
    post<CampaignSummaryRow>(`/campaigns/${enc(campaignId)}/approve`, {}),
  testSendCampaign: (campaignId: string, input: TestSendCampaignInput) =>
    post<{ sent: boolean; messageSendId: string | null }>(
      `/campaigns/${enc(campaignId)}/test-send`,
      input,
    ),
  scheduleCampaign: (campaignId: string, input: ScheduleCampaignInput) =>
    post<CampaignSummaryRow>(`/campaigns/${enc(campaignId)}/schedule`, input),
  pauseCampaign: (campaignId: string, reason?: string) =>
    post<CampaignSummaryRow>(`/campaigns/${enc(campaignId)}/pause`, reason ? { reason } : {}),
  cancelCampaign: (campaignId: string) =>
    post<CampaignSummaryRow>(`/campaigns/${enc(campaignId)}/cancel`, {}),

  // Contact profile outreach history
  getContactOutreachHistory: (contactId: string) =>
    request<ContactOutreachHistoryView>(`/contacts/${enc(contactId)}/outreach`),

  // Integrations overview, Apollo prospecting & enrichment
  getIntegrationsOverview: () => request<IntegrationsOverviewView>('/admin/integrations'),
  updateApolloCreditLimit: (input: UpdateApolloCreditLimitInput) =>
    put<{ dailyCap: number; creditsUsedToday: number; remainingDailyCredits: number }>(
      '/admin/apollo/credit-limit',
      input,
    ),
  getApolloStatus: () =>
    request<{
      configured: boolean;
      dailyCap: number;
      creditsUsedToday: number;
      remainingDailyCredits: number;
    }>('/apollo/status'),
  searchApollo: (input: ApolloSearchInput) => post<ApolloSearchResultView>('/apollo/search', input),
  importFromApollo: (input: ApolloImportInput) =>
    createWithKey<{
      createdCount: number;
      deduplicatedCount: number;
      skippedSuppressedCount: number;
      skippedMissingEmailCount: number;
      creditsConsumed: number;
      remainingDailyCredits: number;
      contactIds: string[];
    }>('/apollo/import', input),
  enrichContactWithApollo: (contactId: string, confirmedCreditCost = 1) =>
    post<{
      enriched: boolean;
      updatedFields: string[];
      creditsConsumed: number;
      remainingDailyCredits: number;
    }>(`/contacts/${enc(contactId)}/enrich-apollo`, { confirmedCreditCost }),

  // Scoped Service API Tokens
  listApiTokens: () => request<Items<ApiTokenView>>('/admin/api-tokens').then((r) => r.items),
  createApiToken: (input: CreateApiTokenInput) =>
    createWithKey<{ token: ApiTokenView; secretToken: string }>('/admin/api-tokens', input),
  revokeApiToken: (tokenId: string) =>
    post<{ id: string; revoked: true }>(`/admin/api-tokens/${enc(tokenId)}/revoke`, {}),

  // Outbound Webhooks & delivery logs
  listWebhooks: () => request<Items<WebhookEndpointRow>>('/admin/webhooks').then((r) => r.items),
  createWebhook: (input: CreateWebhookEndpointInput) =>
    createWithKey<{ endpoint: WebhookEndpointRow; signingSecret: string }>(
      '/admin/webhooks',
      input,
    ),
  updateWebhook: (id: string, input: UpdateWebhookEndpointInput) =>
    patch<{ endpoint: WebhookEndpointRow; rotatedSigningSecret: string | null }>(
      `/admin/webhooks/${enc(id)}`,
      input,
    ),
  deleteWebhook: (id: string) => del<{ deleted: true }>(`/admin/webhooks/${enc(id)}`),
  listWebhookDeliveries: (endpointId: string) =>
    request<Items<WebhookDeliveryRow>>(`/admin/webhooks/${enc(endpointId)}/deliveries`).then(
      (r) => r.items,
    ),
  testWebhook: (endpointId: string) =>
    post<WebhookDeliveryRow>(`/admin/webhooks/${enc(endpointId)}/test`, {}),

  // Operational System Health & Dead-Letter Outbox Queue
  getSystemHealthOverview: () => request<SystemHealthOverview>('/admin/system-health'),
  retryDeadLetterEvent: (eventId: string) =>
    post<{ id: string; status: 'pending'; retryCount: number }>(
      `/admin/outbox/${enc(eventId)}/retry`,
      {},
    ),
  retryAllDeadLetters: () => post<{ retriedCount: number }>('/admin/outbox/retry-all', {}),
  purgeDeadLetterEvent: (eventId: string) =>
    del<{ deleted: true; id: string }>(`/admin/outbox/${enc(eventId)}`),
};

export type {
  BackupRunView,
  DeadLetterEventView,
  HealthCheckResponse,
  SystemHealthOverview,
  WorkerHeartbeatView,
};

export interface OutreachTemplateRow {
  id: string;
  name: string;
  channel: TemplateChannel;
  market: Market;
  subject: string;
  body_text: string;
  body_html: string | null;
  blocks_json: CampaignBlock[];
  variables: string[];
  shared: boolean;
  owner_user_id: string;
  owner_name?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SequenceSummaryRow {
  id: string;
  name: string;
  description: string | null;
  market: Market;
  status: 'draft' | 'active' | 'paused' | 'archived';
  shared: boolean;
  daily_cap_per_mailbox: number;
  send_window_start_minutes: number;
  send_window_end_minutes: number;
  stop_on_company_reply: boolean;
  click_tracking_enabled: boolean;
  owner_user_id: string;
  owner_name?: string | null;
  version: number;
  step_count: number;
  enrolled_count: number;
  active_enrollments: number;
  sent_count: number;
  replied_count: number;
  bounced_count: number;
  unsubscribed_count: number;
  meetings_count: number;
  created_at: string;
  updated_at: string;
}

export interface SequenceStepRow {
  id: string;
  sequence_id: string;
  step_order: number;
  step_kind: 'email' | 'task';
  delay_business_days: number;
  subject_template: string;
  body_template: string;
  reply_in_thread: boolean;
  task_type: string;
  task_title: string | null;
  template_id: string | null;
  sent_count: number;
  replied_count: number;
  bounced_count: number;
  replyRatePct: number;
}

export interface SequenceEnrollmentRow {
  id: string;
  sequence_id: string;
  contact_id: string;
  contact_name: string;
  contact_title: string | null;
  contact_market: Market;
  contact_timezone: string;
  company_name: string | null;
  email: string;
  sender_user_id: string;
  sender_name: string | null;
  current_step_order: number;
  status: string;
  stop_reason: string | null;
  last_skip_reason: string | null;
  next_send_at: string | null;
  enrolled_at: string;
}

export interface SequenceDetailView {
  sequence: SequenceSummaryRow;
  steps: SequenceStepRow[];
  enrollments: SequenceEnrollmentRow[];
  metrics: {
    enrolledCount: number;
    activeCount: number;
    pausedCount: number;
    completedCount: number;
    sentCount: number;
    repliedCount: number;
    bouncedCount: number;
    unsubscribedCount: number;
    meetingsCount: number;
    replyRatePct: number;
  };
}

export interface MarketingListRow {
  id: string;
  name: string;
  description: string | null;
  list_type: 'static' | 'dynamic';
  market: Market;
  filter_json: Record<string, unknown>;
  member_count: number;
  shared: boolean;
  owner_user_id: string;
  owner_name?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MarketingListMemberRow {
  id: string;
  full_name: string;
  first_name: string;
  primary_email: string;
  market: Market;
  timezone: string;
  email_verification_status: string;
  company_name: string | null;
}

export interface SenderIdentityRow {
  id: string;
  from_name: string;
  from_email: string;
  reply_to_email: string | null;
  domain: string;
  spf_verified: boolean;
  dkim_verified: boolean;
  dmarc_verified: boolean;
  verified_at: string | null;
  daily_warmup_cap: number;
  sent_today_count: number;
  created_at: string;
}

export interface CampaignSummaryRow {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  body_text: string;
  blocks_json: CampaignBlock[];
  market: Market;
  status: CampaignStatus;
  list_id: string | null;
  list_name?: string | null;
  segment_filter_json: Record<string, unknown> | null;
  sender_identity_id: string | null;
  sender_from_name?: string | null;
  sender_from_email?: string | null;
  throttle_per_hour: number;
  respect_recipient_timezone: boolean;
  click_tracking_enabled: boolean;
  exclude_unverified: boolean;
  approved_by_user_id: string | null;
  approved_by_name?: string | null;
  approved_at: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  sent_count: number;
  delivered_count: number;
  bounced_count: number;
  soft_bounced_count: number;
  complained_count: number;
  unsubscribed_count: number;
  clicked_count: number;
  opened_unreliable_count: number;
  replied_count: number;
  paused_reason: string | null;
  owner_user_id: string;
  owner_name?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CampaignPreflightView {
  campaignId: string;
  senderVerified: boolean;
  senderFromEmail: string | null;
  sendingSubdomainOk: boolean;
  unsubscribeFooterAutomatic: boolean;
  postalAddressConfigured: boolean;
  postalAddress: string;
  totalAudienceCount: number;
  eligibleCount: number;
  suppressedCount: number;
  skippedByReason: Record<string, number>;
  counselSignedOff: boolean;
  mailLive: boolean;
  readyToApprove: boolean;
}

export interface CampaignRecipientRow {
  id: string;
  campaign_id: string;
  contact_id: string;
  contact_name: string;
  company_name: string | null;
  email: string;
  status: string;
  reason_code: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  clicked_at: string | null;
}

export interface CampaignDetailView {
  campaign: CampaignSummaryRow;
  preflight: CampaignPreflightView;
  recipients: CampaignRecipientRow[];
  clicksByLink: Array<{
    target_url: string;
    total_clicks: number;
    unique_clickers: number;
  }>;
}

export interface ContactOutreachHistoryView {
  enrollments: Array<{
    id: string;
    sequence_id: string;
    sequence_name: string;
    sequence_market: Market;
    sender_name: string | null;
    current_step_order: number;
    status: string;
    stop_reason: string | null;
    last_skip_reason: string | null;
    next_send_at: string | null;
    enrolled_at: string;
  }>;
  campaigns: Array<{
    id: string;
    campaign_id: string;
    campaign_name: string;
    campaign_subject: string;
    status: string;
    reason_code: string | null;
    sent_at: string | null;
    delivered_at: string | null;
    clicked_at: string | null;
  }>;
  sends: Array<{
    id: string;
    channel: string;
    subject: string;
    status: string;
    compliance_reason_code: string;
    transport_provider: string;
    sent_at: string;
  }>;
}

export type { ApiTokenView, Scope };

export interface IntegrationsOverviewView {
  connectors: {
    entraSso: { configured: boolean };
    microsoftGraphMail: { configured: boolean; connectedMailboxes: number };
    espCampaigns: {
      configured: boolean;
      provider: string;
      sendingDomain: string;
      mailLive: boolean;
    };
    apollo: {
      configured: boolean;
      dailyCap: number;
      creditsUsedToday: number;
      remainingDailyCredits: number;
    };
    microsoftBookings: {
      configured: boolean;
      webhookUrl: string;
      eventsProcessed30d: number;
    };
    outboundWebhooks: {
      activeEndpointsCount: number;
      delivered24hCount: number;
      failed24hCount: number;
      availableEventTypes: string[];
    };
  };
  recentApolloLedger: Array<{
    id: string;
    action: string;
    creditsUsed: number;
    entityType: string | null;
    actorName: string | null;
    createdAt: string;
  }>;
}

export interface ApolloSearchPersonRow {
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
  alreadyInCrm: boolean;
  existingContactId: string | null;
  suppressed: boolean;
  estimatedCreditCost: number;
}

export interface ApolloSearchResultView {
  items: ApolloSearchPersonRow[];
  totalEntries: number;
  page: number;
  perPage: number;
  dailyCap: number;
  creditsUsedToday: number;
  remainingDailyCredits: number;
}

export interface WebhookEndpointRow {
  id: string;
  name: string;
  description: string | null;
  target_url: string;
  secret_hint: string;
  event_types: string[];
  active: boolean;
  last_status_code: number | null;
  last_delivered_at: string | null;
  last_error: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  outbox_event_id: string | null;
  event_type: string;
  status: 'pending' | 'retrying' | 'delivered' | 'failed';
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  available_at: string;
  delivered_at: string | null;
  created_at: string;
}
