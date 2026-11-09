import {
  type Currency,
  type DuplicateCandidateView,
  type ImportBatchView,
  type ImportEntity,
  type ImportRowView,
  type Market,
  type MergeEntity,
  type MergeInput,
  type MergePreviewView,
  type MergeView,
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
  source: 'activity' | 'note' | 'history';
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
  suppression: { reason: string; source: string; created_at: string } | null;
  consent: { basis: string; status: string; source: string; expires_at: string | null } | null;
  enrollments: { id: string; sequence_name: string; status: string; enrolled_at: string }[];
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
  search: (q: string) => request<SearchResults>(`/search?q=${enc(q)}`),

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
  convertLead: (input: { leadId: string; dealName?: string; monthlyValueMinor?: string }) =>
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

  // Deals and pipelines
  listDeals: (params: ListParams = {}) => request<Page<DealRow>>(`/deals${listQuery(params)}`),
  getDeal: (dealId: string) => request<DealProfile>(`/deals/${enc(dealId)}`),
  updateDeal: (dealId: string, input: Patch) => patch<DealRow>(`/deals/${enc(dealId)}`, input),
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
  dashboardWidget: <T>(id: WidgetId, period: DashboardPeriod) => {
    const search = new URLSearchParams({ from: period.from, to: period.to });
    if (period.market) search.set('market', period.market);
    return request<WidgetResult<T>>(`/dashboard/widgets/${id}?${search.toString()}`);
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

  // Notifications
  notifications: () => request<{ items: NotificationRow[]; unreadCount: number }>('/notifications'),
  markNotificationsRead: (notificationId?: string) =>
    post<{ updated: number }>('/notifications/read', notificationId ? { id: notificationId } : {}),
};
