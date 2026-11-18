import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(currentDir, '../openapi.json');

const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'ADAS CRM API',
    version: '1.0.0',
    description:
      'Internal CRM and compliant outreach API for ADAS Globus Pro across Phases 1–6 (PRD §6.5–6.8)',
  },
  servers: [{ url: '/api/v1' }],
  paths: {
    '/healthz': {
      get: {
        operationId: 'getHealth',
        summary: 'Service health check',
        responses: { '200': { description: 'Healthy' } },
      },
    },
    '/auth/config': {
      get: {
        operationId: 'getAuthConfig',
        summary: 'Which sign-in methods are available (PRD 6.6)',
        responses: { '200': { description: 'Sign-in options' } },
      },
    },
    '/auth/sso/start': {
      get: {
        operationId: 'startMicrosoftSignIn',
        summary: 'Redirects to Microsoft Entra sign-in (authorization code flow with PKCE)',
        responses: {
          '302': { description: 'Redirect to Microsoft, or to the login page if not configured' },
        },
      },
    },
    '/auth/sso/callback': {
      get: {
        operationId: 'finishMicrosoftSignIn',
        summary: 'Microsoft redirects here; validates the ID token and starts a session',
        responses: {
          '302': { description: 'Redirect to the app, or to the login page with an error' },
        },
      },
    },
    '/auth/me': {
      get: {
        operationId: 'getCurrentUser',
        summary: 'The signed-in user',
        responses: {
          '200': { description: 'Current user' },
          '401': { description: 'Not signed in' },
        },
      },
    },
    '/auth/local/login': {
      post: {
        operationId: 'emergencyAdminSignIn',
        summary:
          'Emergency admin sign-in with a password and an authenticator code (PRD 6.6). Same 401 for every wrong detail; locks after five wrong tries',
        responses: {
          '200': { description: 'Signed in; sets the session cookie' },
          '401': { description: 'Email, password or code wrong, or the account is locked' },
          '403': { description: 'Not sent from the CRM web app' },
          '422': { description: 'Missing or malformed fields' },
          '429': { description: 'Too many attempts from this network' },
          '503': { description: 'Not set up on this server (no encryption key)' },
        },
      },
    },
    '/auth/logout': {
      post: {
        operationId: 'signOut',
        summary: 'Ends the current session',
        responses: { '204': { description: 'Signed out' } },
      },
    },
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List invited and active CRM users (PRD §3.2)',
        responses: { '200': { description: 'User list' } },
      },
    },
    '/audit-logs': {
      get: {
        operationId: 'listAuditLogs',
        summary: 'List immutable security & compliance audit logs (PRD §9)',
        responses: { '200': { description: 'Audit logs' } },
      },
    },
    '/companies': {
      get: {
        operationId: 'listCompanies',
        summary: 'List scoped companies (PRD §4.3)',
        responses: { '200': { description: 'Companies' } },
      },
      post: {
        operationId: 'createCompany',
        summary: 'Create or deduplicate company by normalized domain (PRD §4.3)',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/companies/{id}': {
      patch: {
        operationId: 'updateCompany',
        summary: 'Update company with optimistic concurrency version check (PRD §6.5)',
        responses: {
          '200': { description: 'Updated' },
          '409': { description: 'Version conflict' },
        },
      },
    },
    '/contacts': {
      get: {
        operationId: 'listContacts',
        summary: 'List scoped contacts (PRD §4.4)',
        responses: { '200': { description: 'Contacts' } },
      },
      post: {
        operationId: 'createContact',
        summary: 'Create contact with normalized email and E.164 phone (PRD §4.4)',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/leads': {
      get: {
        operationId: 'listLeads',
        summary: 'List scoped leads (PRD §4.1)',
        responses: { '200': { description: 'Leads' } },
      },
      post: {
        operationId: 'createLead',
        summary: 'Create lead (PRD §4.1)',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/leads/convert': {
      post: {
        operationId: 'convertLead',
        summary:
          'Convert qualified lead to Company, Contact, Deal, and 3-Day Free Trial tasks (PRD §4.2)',
        responses: { '200': { description: 'Converted' } },
      },
    },
    '/deals': {
      get: {
        operationId: 'listDeals',
        summary: 'List scoped deals (PRD §4.5)',
        responses: { '200': { description: 'Deals' } },
      },
      post: {
        operationId: 'createDeal',
        summary: 'Create deal (PRD §4.5)',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/deals/{id}/stage': {
      patch: {
        operationId: 'moveDealStage',
        summary: 'Move deal stage with required-field gates and Free Trial / Won hooks (PRD §4.5)',
        responses: {
          '200': { description: 'Updated' },
          '422': { description: 'Missing required stage field' },
        },
      },
    },
    '/tasks': {
      get: {
        operationId: 'listTasks',
        summary: 'List scoped tasks and SLA timers (PRD §4.6)',
        responses: { '200': { description: 'Tasks' } },
      },
      post: {
        operationId: 'createTask',
        summary: 'Create task (PRD §4.6)',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/public/inquiries': {
      post: {
        operationId: 'submitPublicInquiry',
        summary:
          'Public website form intake endpoint on go.adasglobuspro.com; stores raw submission in inquiries, deduplicates on (email, form, day), routes by market, creates 1-business-day SLA task and returns generic 202 {"status":"received"} (PRD 4.10, A13)',
        responses: {
          '202': { description: 'Received ({"status":"received"})' },
          '413': { description: 'Body exceeds 16 KB' },
          '422': { description: 'Invalid email or payload' },
          '429': { description: 'Per-IP rate limit exceeded (5 per 10 minutes)' },
        },
      },
    },
    '/compliance/check-sendable': {
      post: {
        operationId: 'checkSendable',
        summary: 'Evaluate CAN-SPAM / CASL / suppression sendability gate (PRD §5.1)',
        responses: { '200': { description: 'Evaluation result' } },
      },
    },
    '/compliance/suppressions': {
      get: {
        operationId: 'listSuppressions',
        summary: 'List append-only suppressions (PRD §5.3)',
        responses: { '200': { description: 'Suppressions' } },
      },
      post: {
        operationId: 'addSuppression',
        summary: 'Add suppression and immediately stop active sequences (PRD §5.3)',
        responses: { '201': { description: 'Suppressed' } },
      },
    },
    '/imports': {
      get: {
        operationId: 'listImports',
        summary: 'Imports within your scope, newest first (PRD 4.9)',
        responses: { '200': { description: 'Imports' } },
      },
      post: {
        operationId: 'uploadImport',
        summary:
          'Upload a CSV or XLSX file (raw body, up to 50 MB and 100,000 rows; file name in the X-Upload-Filename header). Returns the columns, a preview and suggested mappings',
        responses: {
          '201': { description: 'Uploaded' },
          '413': { description: 'File larger than 50 MB' },
          '415': { description: 'Not a CSV or XLSX file (checked by content)' },
          '422': { description: 'Empty file or more than 100,000 rows' },
        },
      },
    },
    '/imports/templates': {
      get: {
        operationId: 'listImportTemplates',
        summary: 'Your saved column mappings',
        responses: { '200': { description: 'Templates' } },
      },
      post: {
        operationId: 'saveImportTemplate',
        summary: 'Save a column mapping under a name (same name replaces it)',
        responses: { '201': { description: 'Saved' } },
      },
    },
    '/imports/{id}': {
      get: {
        operationId: 'getImport',
        summary: 'One import: status, progress and counts',
        responses: { '200': { description: 'Import' }, '404': { description: 'Not found' } },
      },
    },
    '/imports/{id}/mapping': {
      put: {
        operationId: 'setImportMapping',
        summary: 'Choose the record type, column mapping, duplicate rule, source, owner and tags',
        responses: { '200': { description: 'Mapped' }, '409': { description: 'Already run' } },
      },
    },
    '/imports/{id}/dry-run': {
      post: {
        operationId: 'requestImportDryRun',
        summary: 'Check every row without saving; the worker fills in the preview counts',
        responses: { '200': { description: 'Checking' } },
      },
    },
    '/imports/{id}/run': {
      post: {
        operationId: 'requestImportRun',
        summary: 'Run the import in the background after a dry run (audited)',
        responses: { '200': { description: 'Queued' }, '409': { description: 'Not checked' } },
      },
    },
    '/imports/{id}/rollback': {
      post: {
        operationId: 'requestImportUndo',
        summary:
          'Undo a finished import within 7 days: created records removed, updates reverted, records edited since kept and listed',
        responses: { '200': { description: 'Undoing' }, '409': { description: 'Not undoable' } },
      },
    },
    '/imports/{id}/rows': {
      get: {
        operationId: 'listImportRows',
        summary: 'Row results of the latest pass; filter by status or undo=kept',
        responses: { '200': { description: 'Rows' } },
      },
    },
    '/imports/{id}/errors.csv': {
      get: {
        operationId: 'downloadImportErrors',
        summary: 'The rows that failed, with an Error column (audited)',
        responses: { '200': { description: 'CSV file' } },
      },
    },
    '/search': {
      get: {
        operationId: 'globalSearch',
        summary: 'Global trigram and full-text search (PRD §6.8)',
        responses: { '200': { description: 'Search results' } },
      },
    },
    '/inbox/threads': {
      get: {
        operationId: 'listInboxThreads',
        summary: 'List synced Microsoft 365 threads (PRD §4.11)',
        responses: { '200': { description: 'Threads' } },
      },
    },
    '/sequences': {
      get: {
        operationId: 'listSequences',
        summary: 'List multi-step outbound sequences (PRD §4.12)',
        responses: { '200': { description: 'Sequences' } },
      },
    },
    '/campaigns': {
      get: {
        operationId: 'listCampaigns',
        summary: 'List bulk campaigns (PRD §4.13)',
        responses: { '200': { description: 'Campaigns' } },
      },
    },
    '/campaigns/{id}/approve': {
      post: {
        operationId: 'approveCampaign',
        summary: 'Approve campaign (requires campaigns.approve capability, PRD §4.13)',
        responses: { '200': { description: 'Approved' }, '403': { description: 'Forbidden' } },
      },
    },
    '/reports/pipeline-rollup': {
      get: {
        operationId: 'getPipelineRollup',
        summary: 'Multi-currency pipeline rollup in integer minor units (PRD §4.15 & §14)',
        responses: { '200': { description: 'Pipeline report' } },
      },
    },
  },
};

// Routes added with the lists-and-editing slice (PRD 3.1-3.4, 4.3-4.7, 6.7, 6.8).
const listParameters = [
  { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search text' },
  {
    name: 'sort',
    in: 'query',
    schema: { type: 'string' },
    description: 'Field, "-" for descending',
  },
  {
    name: 'filter',
    in: 'query',
    schema: { type: 'string' },
    description: 'Filter language as JSON',
  },
  { name: 'cursor', in: 'query', schema: { type: 'string' } },
  { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
];
const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];
const ok = (description: string) => ({ '200': { description } });
const edit = {
  '200': { description: 'Updated' },
  '409': { description: 'Version conflict' },
  '422': { description: 'Validation failed' },
};
const page = (entity: string) => ({
  parameters: listParameters,
  responses: ok(`A page of ${entity}: { items, nextCursor, total }`),
});
const recordPaths = (entity: string, op: string) => ({
  get: {
    operationId: `get${op}`,
    parameters: idParam,
    responses: ok(`${entity} with related records`),
  },
  patch: { operationId: `update${op}`, parameters: idParam, responses: edit },
  delete: {
    operationId: `delete${op}`,
    parameters: idParam,
    responses: ok('Soft-deleted and audited'),
  },
});

const listsAndEditingPaths: Record<string, Record<string, unknown>> = {
  '/leads': { get: { operationId: 'listLeads', ...page('leads') } },
  '/contacts': { get: { operationId: 'listContacts', ...page('contacts') } },
  '/companies': { get: { operationId: 'listCompanies', ...page('companies') } },
  '/deals': { get: { operationId: 'listDeals', ...page('deals') } },
  '/tasks': {
    get: {
      operationId: 'listTasks',
      parameters: [
        ...listParameters,
        {
          name: 'view',
          in: 'query',
          schema: { enum: ['open', 'today', 'overdue', 'upcoming', 'done', 'all'] },
        },
      ],
      responses: ok('A page of tasks'),
    },
  },
  '/leads/{id}': recordPaths('Lead', 'Lead'),
  '/leads/{id}/convert': {
    post: { operationId: 'convertLeadById', parameters: idParam, responses: ok('Converted') },
  },
  '/contacts/{id}': recordPaths('Contact', 'Contact'),
  '/companies/{id}': recordPaths('Company', 'Company'),
  '/deals/{id}': recordPaths('Deal', 'Deal'),
  '/deals/{id}/move': { post: { operationId: 'moveDeal', parameters: idParam, responses: edit } },
  '/pipelines': { get: { operationId: 'listPipelines', responses: ok('Pipelines with stages') } },
  '/pipelines/{id}/board': {
    get: {
      operationId: 'getPipelineBoard',
      parameters: [
        ...idParam,
        { name: 'owner', in: 'query', schema: { type: 'string' } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
      ],
      responses: ok('Stages with counts, totals and up to 50 deals each'),
    },
  },
  '/tasks/{id}': { patch: { operationId: 'updateTask', parameters: idParam, responses: edit } },
  '/tasks/{id}/complete': {
    post: { operationId: 'completeTask', parameters: idParam, responses: ok('Completed') },
  },
  '/timeline': {
    get: {
      operationId: 'getTimeline',
      parameters: [
        {
          name: 'entityType',
          in: 'query',
          required: true,
          schema: { enum: ['lead', 'contact', 'company', 'deal'] },
        },
        { name: 'entityId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'before', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
      ],
      responses: ok('{ items, nextBefore }'),
    },
  },
  '/activities': {
    post: { operationId: 'logActivity', responses: { '201': { description: 'Logged' } } },
  },
  '/notes': {
    post: { operationId: 'createNote', responses: { '201': { description: 'Created' } } },
  },
  '/notes/{id}': { patch: { operationId: 'updateNote', parameters: idParam, responses: edit } },
  '/tags': { get: { operationId: 'listTags', responses: ok('Tags with usage counts') } },
  '/tags/{entityType}/{entityId}': {
    put: {
      operationId: 'setTags',
      parameters: [
        { name: 'entityType', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'entityId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: ok('Tags on the record'),
    },
  },
  '/reference-lists': {
    get: { operationId: 'getReferenceLists', responses: ok('Reference lists') },
  },
  '/notifications': {
    get: {
      operationId: 'listNotifications',
      parameters: [{ name: 'unread', in: 'query', schema: { enum: ['1'] } }],
      responses: ok('{ items, unreadCount }'),
    },
  },
  '/notifications/read': {
    post: { operationId: 'markNotificationsRead', responses: ok('{ updated }') },
  },
};

// Administration and the role dashboard (PRD 2.1, 2.2, 3.3, 3.4, 4.2, 4.17, 14).
const created = { '201': { description: 'Created' }, '409': { description: 'Already exists' } };
const adminAndDashboardPaths: Record<string, Record<string, unknown>> = {
  '/me/preferences': {
    patch: { operationId: 'updateMyPreferences', responses: ok('{ timezone }') },
  },
  '/admin/users': {
    get: { operationId: 'adminListUsers', responses: ok('Users with role, team and last sign-in') },
    post: { operationId: 'inviteUser', responses: created },
  },
  '/admin/users/{id}': {
    patch: { operationId: 'adminUpdateUser', parameters: idParam, responses: edit },
  },
  '/admin/teams': {
    get: { operationId: 'adminListTeams', responses: ok('Teams with member counts') },
    post: { operationId: 'createTeam', responses: created },
  },
  '/admin/teams/{id}': {
    patch: { operationId: 'updateTeam', parameters: idParam, responses: edit },
  },
  '/admin/roles': {
    get: { operationId: 'adminListRoles', responses: ok('Roles with capability scopes') },
  },
  '/admin/roles/{id}/capabilities': {
    put: { operationId: 'updateRoleCapabilities', parameters: idParam, responses: edit },
  },
  '/admin/pipelines': {
    get: {
      operationId: 'adminListPipelines',
      responses: ok('Pipelines with stages and deal counts'),
    },
  },
  '/admin/pipelines/{id}/stages': {
    post: { operationId: 'createStage', parameters: idParam, responses: created },
  },
  '/admin/stages/{id}': {
    patch: { operationId: 'updateStage', parameters: idParam, responses: edit },
    delete: {
      operationId: 'deleteStage',
      parameters: idParam,
      responses: { ...ok('Deleted'), '409': { description: 'The stage still has deals' } },
    },
  },
  '/admin/stages/{id}/move': {
    post: { operationId: 'moveStage', parameters: idParam, responses: ok('{ id, moved }') },
  },
  '/admin/settings': {
    get: { operationId: 'adminListSettings', responses: ok('Reference lists and defaults') },
  },
  '/admin/settings/{key}': {
    put: {
      operationId: 'updateSetting',
      parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
      responses: edit,
    },
  },
  '/audit-logs': {
    get: {
      operationId: 'listAuditLogs',
      parameters: [
        ...['cursor', 'action', 'actor', 'entityType', 'entityId', 'from', 'to'].map((name) => ({
          name,
          in: 'query',
          schema: { type: 'string' },
        })),
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
      ],
      responses: ok('{ items, nextCursor }, newest first, scoped by audit.read'),
    },
  },
  '/audit-logs/actions': {
    get: { operationId: 'listAuditActions', responses: ok('Distinct audit actions') },
  },
  '/dashboard': {
    get: {
      operationId: 'getDashboard',
      responses: ok('Widgets for the role and the default period'),
    },
  },
  '/dashboard/widgets/{id}': {
    get: {
      operationId: 'getDashboardWidget',
      parameters: [
        ...idParam,
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'market', in: 'query', schema: { enum: ['US', 'CA'] } },
      ],
      responses: {
        ...ok('{ id, period, generatedAt, data }'),
        '403': { description: 'Not allowed' },
      },
    },
  },
};

const mergePaths = (plural: string, entity: string): Record<string, Record<string, unknown>> => ({
  [`/${plural}/{id}/merge-preview`]: {
    get: {
      operationId: `preview${entity}Merge`,
      summary: `Both ${plural} side by side before a merge: field values, suggested choices, what is linked and what will happen. {id} is the record to keep; ?with= is the one to merge into it (PRD 4.9)`,
      parameters: [
        ...idParam,
        { name: 'with', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Preview' }, '404': { description: 'Not found' } },
    },
  },
  [`/${plural}/{id}/merge`]: {
    post: {
      operationId: `merge${entity}`,
      summary: `Merge another ${entity.toLowerCase()} into {id}: chosen fields, every link re-pointed, a snapshot kept for undo, audited (PRD 4.9)`,
      parameters: idParam,
      responses: {
        '200': { description: 'Merged' },
        '404': { description: 'Not found or outside your scope' },
        '409': { description: 'Version conflict' },
        '422': { description: 'Invalid choice' },
      },
    },
  },
});

const duplicatePaths: Record<string, Record<string, unknown>> = {
  '/duplicates': {
    get: {
      operationId: 'listDuplicates',
      summary:
        'Open probable-duplicate pairs where both records are inside your scope, newest first (PRD 4.9)',
      parameters: [
        { name: 'entity', in: 'query', schema: { type: 'string', enum: ['contact', 'company'] } },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      ],
      responses: ok('Pairs'),
    },
  },
  '/duplicates/{id}': {
    get: {
      operationId: 'getDuplicate',
      summary: 'One open pair',
      parameters: idParam,
      responses: { '200': { description: 'Pair' }, '404': { description: 'Not found' } },
    },
  },
  '/duplicates/{id}/dismiss': {
    post: {
      operationId: 'dismissDuplicate',
      summary: 'Mark a pair as not duplicates; it is never queued again (audited)',
      parameters: idParam,
      responses: ok('Dismissed'),
    },
  },
  ...mergePaths('contacts', 'Contact'),
  ...mergePaths('companies', 'Company'),
  '/merges': {
    get: {
      operationId: 'listMerges',
      summary: 'Recent merges of records inside your scope',
      parameters: [
        { name: 'entity', in: 'query', schema: { type: 'string', enum: ['contact', 'company'] } },
      ],
      responses: ok('Merges'),
    },
  },
  '/merges/{id}': {
    get: {
      operationId: 'getMerge',
      summary: 'One merge: what moved and whether it can still be undone',
      parameters: idParam,
      responses: { '200': { description: 'Merge' }, '404': { description: 'Not found' } },
    },
  },
  '/merges/{id}/undo': {
    post: {
      operationId: 'undoMerge',
      summary:
        'Undo a merge within 30 days: the merged record comes back with its links; fields of the kept record edited since are left and listed; do not contact is never lifted (audited)',
      parameters: idParam,
      responses: {
        '200': { description: 'Undone' },
        '409': { description: 'Already undone, too late, or the records have changed' },
      },
    },
  },
};

const exportPaths: Record<string, Record<string, unknown>> = {
  '/exports': {
    post: {
      operationId: 'createExport',
      summary:
        'Export a list view as CSV: { entity, q, sort, filter } exactly as the list takes them. Rows follow the list scope and the exports.run scope; more than 1,000 rows needs exports.run with scope all and alerts admins; up to 5,000 rows the file is ready at once, larger ones are built in the background and notify you (PRD 2.3, 4.9; audited)',
      responses: {
        '201': { description: 'Export, ready or queued' },
        '400': { description: 'Invalid filter' },
        '403': { description: 'No export permission, or too many rows for your scope' },
        '422': { description: 'Nothing to export, too many rows, or an unknown sort' },
      },
    },
  },
  '/exports/{id}': {
    get: {
      operationId: 'getExport',
      summary: 'One of your exports: its status and progress',
      parameters: idParam,
      responses: { '200': { description: 'Export' }, '404': { description: 'Not found' } },
    },
  },
  '/exports/{id}/download': {
    get: {
      operationId: 'downloadExport',
      summary: 'The CSV file of one of your ready exports, kept for 7 days (audited)',
      parameters: idParam,
      responses: {
        '200': { description: 'CSV file', content: { 'text/csv': {} } },
        '404': { description: 'Not found' },
        '409': { description: 'Not ready yet, or failed' },
        '410': { description: 'Deleted after 7 days' },
      },
    },
  },
};

const complianceAndPrivacyPaths: Record<string, Record<string, unknown>> = {
  '/compliance/suppressions': {
    get: {
      operationId: 'listSuppressions',
      summary:
        'Keyset-paged suppressions searchable by address or SHA-256 hash, filtered by state and reason (PRD 4.17, 5.5)',
      parameters: [
        { name: 'q', in: 'query', schema: { type: 'string' } },
        {
          name: 'state',
          in: 'query',
          schema: { type: 'string', enum: ['active', 'lifted', 'all'] },
        },
        { name: 'reason', in: 'query', schema: { type: 'string' } },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
      ],
      responses: ok('{ items, nextCursor, total }'),
    },
    post: {
      operationId: 'addSuppression',
      summary:
        'Add an email suppression, mark matching contacts do_not_contact and stop active enrollments (PRD 5.5)',
      responses: { '201': { description: 'Suppressed' }, '422': { description: 'Invalid email' } },
    },
  },
  '/compliance/suppressions/{id}/lift': {
    post: {
      operationId: 'liftSuppression',
      summary:
        'Lift an active suppression with a required reason (requires privacy.manage; privacy_erasure rows are permanent; audited — PRD 4.18, 5.5, 9)',
      parameters: idParam,
      responses: {
        '200': { description: 'Lifted' },
        '403': { description: 'Requires privacy.manage' },
        '404': { description: 'Not found' },
        '409': { description: 'Already lifted or permanent privacy erasure' },
        '422': { description: 'Reason shorter than 5 characters' },
      },
    },
  },
  '/compliance/suppressed-domains': {
    get: {
      operationId: 'listSuppressedDomains',
      summary: 'List blocked corporate domains (PRD 4.17, 5.1)',
      responses: ok('{ items }'),
    },
    post: {
      operationId: 'addSuppressedDomain',
      summary:
        'Block an entire corporate domain and stop active sequences for matching addresses; free-mail domains are refused (PRD 5.1)',
      responses: {
        '201': { description: 'Domain blocked' },
        '422': { description: 'Invalid or free-mail domain' },
      },
    },
  },
  '/compliance/suppressed-domains/{id}/remove': {
    post: {
      operationId: 'removeSuppressedDomain',
      summary:
        'Remove a blocked corporate domain with a required reason (requires privacy.manage; audited — PRD 4.17, 9)',
      parameters: idParam,
      responses: {
        '200': { description: 'Removed' },
        '403': { description: 'Requires privacy.manage' },
        '404': { description: 'Not found' },
        '422': { description: 'Reason shorter than 5 characters' },
      },
    },
  },
  '/contacts/{id}/consents': {
    post: {
      operationId: 'recordContactConsent',
      summary:
        'Record express or implied consent for a contact inside your contacts.write scope (audited — PRD 5.3, 9)',
      parameters: idParam,
      responses: {
        '201': { description: 'Recorded' },
        '404': { description: 'Not found or outside scope' },
        '409': { description: 'Contact is suppressed or do not contact' },
        '422': { description: 'Missing proof or invalid date' },
      },
    },
  },
  '/contacts/{id}/consents/withdraw': {
    post: {
      operationId: 'withdrawContactConsent',
      summary:
        'Withdraw marketing consent for a contact and optionally suppress all outreach (audited — PRD 5.3, 9)',
      parameters: idParam,
      responses: {
        '200': { description: 'Withdrawn' },
        '404': { description: 'Not found or outside scope' },
        '422': { description: 'Reason required' },
      },
    },
  },
  '/contacts/{id}/privacy-export': {
    get: {
      operationId: 'exportContactPrivacyData',
      summary:
        'Export all personal data held on a contact as JSON or CSV (requires privacy.manage; audited — PRD 4.18, 9)',
      parameters: [
        ...idParam,
        { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } },
      ],
      responses: {
        '200': { description: 'JSON or CSV archive' },
        '403': { description: 'Requires privacy.manage' },
        '404': { description: 'Not found' },
      },
    },
  },
  '/contacts/{id}/privacy-erase': {
    post: {
      operationId: 'eraseContactPrivacyData',
      summary:
        'Erase personal details, notes and email bodies for a contact while keeping deal financials, activity counts and a permanent SHA-256 suppression (requires privacy.manage; audited — PRD 4.18, 9)',
      parameters: idParam,
      responses: {
        '200': { description: 'Erased' },
        '403': { description: 'Requires privacy.manage' },
        '404': { description: 'Not found' },
        '422': { description: 'Reason shorter than 5 characters' },
      },
    },
  },
};

const intakeAndRoutingPaths = {
  '/admin/routing-rules': {
    get: {
      operationId: 'listRoutingRules',
      summary:
        'List market routing rules (US, CA, OTHER) for inbound website inquiries (requires settings.manage — PRD 4.10, 4.17, 15 Q13)',
      responses: ok('{ items }'),
    },
  },
  '/admin/routing-rules/{market}': {
    put: {
      operationId: 'updateRoutingRule',
      summary:
        'Update a market routing rule (round-robin within a team or named active owner; optimistic concurrency version; audited — PRD 4.17, 9)',
      parameters: [
        {
          name: 'market',
          in: 'path',
          required: true,
          schema: { type: 'string', enum: ['US', 'CA', 'OTHER'] },
        },
      ],
      responses: {
        '200': { description: 'Updated' },
        '403': { description: 'Requires settings.manage' },
        '409': { description: 'Stale version' },
        '422': { description: 'Invalid team or inactive/non-writable owner' },
      },
    },
  },
  '/admin/inquiries': {
    get: {
      operationId: 'listRecentInquiries',
      summary:
        'Keyset-paged summary of recent website inquiries without personal message bodies or raw IP addresses (requires settings.manage — PRD 4.10, 4.17)',
      parameters: [
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
        { name: 'market', in: 'query', schema: { type: 'string', enum: ['US', 'CA', 'OTHER'] } },
        {
          name: 'formType',
          in: 'query',
          schema: { type: 'string', enum: ['trial', 'contact', 'consultation'] },
        },
      ],
      responses: ok('{ items, nextCursor, total }'),
    },
  },
  '/admin/api-tokens': {
    get: {
      operationId: 'listApiTokens',
      summary:
        'List service API tokens with prefix, capability ceiling, scope level, expiry and last-used time (requires settings.manage — PRD 4.14, 9)',
      responses: ok('{ items }'),
    },
    post: {
      operationId: 'createApiToken',
      summary:
        'Create a scoped service API token bounded by the creator’s permissions; the secret token is returned once (audited — PRD 4.14, 9)',
      responses: {
        '201': { description: 'Created ({ token, secretToken })' },
        '403': { description: 'Requires settings.manage' },
        '422': { description: 'Capability or scope exceeds creator permissions' },
      },
    },
  },
  '/admin/api-tokens/{id}/revoke': {
    post: {
      operationId: 'revokeApiToken',
      summary:
        'Immediately revoke a service API token (requires settings.manage; audited — PRD 4.14, 9)',
      parameters: idParam,
      responses: {
        '200': { description: 'Revoked' },
        '403': { description: 'Requires settings.manage' },
        '404': { description: 'Not found' },
      },
    },
  },
};

const crmExtensionsPaths = {
  '/saved-views': {
    get: {
      operationId: 'listSavedViews',
      summary: 'List personal, team and shared saved views for an entity (PRD 4.8)',
      responses: ok('{ items }'),
    },
    post: {
      operationId: 'createSavedView',
      summary: 'Save a named filter/sort/column view (PRD 4.8)',
      responses: { '201': { description: 'Created' } },
    },
  },
  '/saved-views/{id}': {
    patch: {
      operationId: 'updateSavedView',
      summary: 'Update or share a saved view (PRD 4.8)',
      parameters: idParam,
      responses: ok('Updated'),
    },
    delete: {
      operationId: 'deleteSavedView',
      summary: 'Delete a saved view (PRD 4.8)',
      parameters: idParam,
      responses: ok('Deleted'),
    },
  },
  '/bulk-jobs/{id}': {
    get: {
      operationId: 'getBulkJob',
      summary: 'Get background bulk action status and counts (PRD 6.7, 6.9)',
      parameters: idParam,
      responses: ok('Bulk job'),
    },
  },
  '/custom-fields': {
    get: {
      operationId: 'listCustomFields',
      summary: 'List custom field definitions (PRD 4.17, 6.8)',
      responses: ok('{ items }'),
    },
  },
  '/admin/custom-fields': {
    post: {
      operationId: 'createCustomField',
      summary: 'Create a custom field definition (requires settings.manage — PRD 4.17)',
      responses: { '201': { description: 'Created' } },
    },
  },
  '/admin/custom-fields/{id}': {
    patch: {
      operationId: 'updateCustomField',
      summary: 'Update or archive a custom field definition (requires settings.manage — PRD 4.17)',
      parameters: idParam,
      responses: ok('Updated'),
    },
  },
  '/leads/{id}/custom-fields': {
    put: {
      operationId: 'setLeadCustomFields',
      summary: 'Set typed custom field values on a lead (PRD 4.5, 6.8)',
      parameters: idParam,
      responses: ok('{ customFields, version }'),
    },
  },
  '/contacts/{id}/custom-fields': {
    put: {
      operationId: 'setContactCustomFields',
      summary: 'Set typed custom field values on a contact (PRD 4.4, 6.8)',
      parameters: idParam,
      responses: ok('{ customFields, version }'),
    },
  },
  '/companies/{id}/custom-fields': {
    put: {
      operationId: 'setCompanyCustomFields',
      summary: 'Set typed custom field values on a company (PRD 4.3, 6.8)',
      parameters: idParam,
      responses: ok('{ customFields, version }'),
    },
  },
  '/deals/{id}/custom-fields': {
    put: {
      operationId: 'setDealCustomFields',
      summary: 'Set typed custom field values on a deal (PRD 4.6, 6.8)',
      parameters: idParam,
      responses: ok('{ customFields, version }'),
    },
  },
  '/contacts/{id}/emails': {
    post: {
      operationId: 'addContactEmail',
      summary: 'Add a secondary email address to a contact (PRD 4.4)',
      parameters: idParam,
      responses: { '201': { description: '{ emails }' } },
    },
    delete: {
      operationId: 'removeContactEmail',
      summary: 'Remove a non-primary email address from a contact (PRD 4.4)',
      parameters: idParam,
      responses: ok('{ emails }'),
    },
  },
  '/contacts/{id}/emails/primary': {
    post: {
      operationId: 'setPrimaryContactEmail',
      summary: 'Promote an email address on a contact to primary (PRD 4.4)',
      parameters: idParam,
      responses: ok('{ emails }'),
    },
  },
  '/contacts/{id}/phones': {
    post: {
      operationId: 'addContactPhone',
      summary: 'Add a normalized E.164 phone number to a contact (PRD 4.4)',
      parameters: idParam,
      responses: { '201': { description: '{ phones }' } },
    },
    delete: {
      operationId: 'removeContactPhone',
      summary: 'Remove a phone number from a contact (PRD 4.4)',
      parameters: idParam,
      responses: ok('{ phones }'),
    },
  },
  '/contacts/{id}/phones/primary': {
    post: {
      operationId: 'setPrimaryContactPhone',
      summary: 'Set primary phone number on a contact (PRD 4.4)',
      parameters: idParam,
      responses: ok('{ phones }'),
    },
  },
  '/admin/scoring-rules': {
    get: {
      operationId: 'listScoringRules',
      summary:
        'List configurable lead & contact scoring rules (requires settings.manage — PRD 4.16)',
      responses: ok('{ items }'),
    },
    post: {
      operationId: 'createScoringRule',
      summary: 'Create a scoring rule (requires settings.manage — PRD 4.16)',
      responses: { '201': { description: 'Created' } },
    },
  },
  '/admin/scoring-rules/recalculate': {
    post: {
      operationId: 'recalculateScores',
      summary: 'Recalculate scores across all active leads and contacts (PRD 4.16)',
      responses: ok('{ leadsUpdated, contactsUpdated }'),
    },
  },
  '/admin/scoring-rules/{id}': {
    patch: {
      operationId: 'updateScoringRule',
      summary: 'Update or toggle a scoring rule (PRD 4.16)',
      parameters: idParam,
      responses: ok('Updated'),
    },
    delete: {
      operationId: 'deleteScoringRule',
      summary: 'Delete a scoring rule (PRD 4.16)',
      parameters: idParam,
      responses: ok('Deleted'),
    },
  },
  '/deals/{id}/contacts': {
    post: {
      operationId: 'addDealContact',
      summary: 'Attach a stakeholder contact and role to a deal (PRD 4.6)',
      parameters: idParam,
      responses: { '201': { description: '{ dealContacts }' } },
    },
  },
  '/deals/{id}/contacts/{contactId}': {
    patch: {
      operationId: 'updateDealContactRole',
      summary: 'Update a stakeholder contact role on a deal (PRD 4.6)',
      responses: ok('{ dealContacts }'),
    },
    delete: {
      operationId: 'removeDealContact',
      summary: 'Remove a stakeholder contact from a deal (PRD 4.6)',
      responses: ok('{ dealContacts }'),
    },
  },
  '/admin/fx-rates': {
    get: {
      operationId: 'listFxRates',
      summary:
        'List stored currency exchange rates and reporting currency (requires settings.manage — PRD 4.17, 14)',
      responses: ok('{ reportingCurrency, items }'),
    },
    post: {
      operationId: 'upsertFxRate',
      summary: 'Add or update a currency exchange rate (requires settings.manage — PRD 4.17, 14)',
      responses: { '201': { description: '{ rate }' } },
    },
  },
  '/admin/fx-rates/{id}': {
    delete: {
      operationId: 'deleteFxRate',
      summary:
        'Remove a currency exchange rate if at least one rate remains for the pair (PRD 4.17)',
      parameters: idParam,
      responses: ok('Deleted'),
    },
  },
  '/dashboard/summary': {
    get: {
      operationId: 'dashboardSummary',
      summary:
        'Portfolio & funnel summary KPIs with previous-period deltas in the viewer time zone (PRD 4.2, 14)',
      responses: ok('DashboardSummaryView'),
    },
  },
  '/reports/options': {
    get: {
      operationId: 'reportOptions',
      summary:
        'Filter options (teams, owners, reporting currency, default date range, export capability) for standard reports (PRD 4.15)',
      responses: ok('ReportFilterOptions'),
    },
  },
  '/reports/{id}': {
    get: {
      operationId: 'runReport',
      summary:
        'Run a standard CRM report with date range, market, team and owner filters and FX conversion (PRD 4.15, 14)',
      parameters: idParam,
      responses: ok('ReportResultView'),
    },
  },
  '/reports/{id}/export.csv': {
    get: {
      operationId: 'exportReportCsv',
      summary:
        'Download a standard CRM report as UTF-8 CSV (requires reports.read and exports.run; audited in audit_logs — PRD 4.15, 9)',
      parameters: idParam,
      responses: { '200': { description: 'text/csv attachment' } },
    },
  },
};

const inboxAndGraphPaths = {
  '/inbox/mailbox': {
    get: {
      operationId: 'getInboxMailboxStatus',
      summary:
        'Get the current user Microsoft 365 delegated mailbox connection status, send cap and last sync (PRD 4.11, 8.2)',
      responses: ok('MailboxStatusView'),
    },
  },
  '/inbox/oauth/start': {
    get: {
      operationId: 'startInboxMailboxOAuth',
      summary:
        'Redirect to Microsoft Entra OAuth2 + PKCE consent for Mail.Read, Mail.Send and offline_access (PRD 4.11, 8.2)',
      responses: { '302': { description: 'Redirect to Microsoft authorize endpoint' } },
    },
  },
  '/inbox/oauth/callback': {
    get: {
      operationId: 'finishInboxMailboxOAuth',
      summary:
        'Exchange OAuth2 code, seal tokens with AES-256-GCM SecretBox, register Graph webhooks and run initial 90-day sync (PRD 8.2)',
      responses: { '302': { description: 'Redirect back to Inbox screen' } },
    },
  },
  '/inbox/mailbox/sync': {
    post: {
      operationId: 'syncInboxMailboxNow',
      summary: 'Trigger immediate delta sync for the signed-in user mailbox (PRD 8.2)',
      responses: ok('Sync summary'),
    },
  },
  '/inbox/mailbox/disconnect': {
    post: {
      operationId: 'disconnectInboxMailbox',
      summary:
        'Disconnect mailbox, delete Graph subscriptions, clear tokens and pause active sequence enrollments (PRD 4.12, 8.2)',
      responses: ok('Disconnect summary'),
    },
  },
  '/admin/mailboxes': {
    get: {
      operationId: 'listAdminMailboxes',
      summary: 'Admin overview of connected Microsoft 365 mailboxes (PRD 4.17)',
      responses: ok('AdminMailboxRow list'),
    },
  },
  '/inbox/threads': {
    get: {
      operationId: 'listInboxThreads',
      summary:
        'Keyset-paginated email conversation threads scoped by inbox.read and filterable by status, search, contact, company, deal or lead (PRD 4.11)',
      responses: ok('InboxThreadSummary page'),
    },
  },
  '/inbox/threads/{id}': {
    get: {
      operationId: 'getInboxThreadDetail',
      summary: 'Full email thread with sanitised messages and attachment metadata (PRD 4.11, 9)',
      parameters: idParam,
      responses: ok('InboxThreadDetail'),
    },
    patch: {
      operationId: 'updateInboxThread',
      summary: 'Archive, reopen, mark read or link a thread to a deal (PRD 4.11)',
      parameters: idParam,
      responses: ok('InboxThreadSummary'),
    },
  },
  '/inbox/send': {
    post: {
      operationId: 'sendInboxEmail',
      summary:
        'Send a 1:1 email from the user mailbox (Graph in live production, Mailpit outside production — PRD 4.11, 8.7, A10)',
      responses: { '201': { description: 'InboxThreadDetail' } },
    },
  },
  '/inbox/threads/{id}/reply': {
    post: {
      operationId: 'replyInboxThread',
      summary: 'Reply in an existing email conversation thread (PRD 4.11, 8.2)',
      parameters: idParam,
      responses: { '201': { description: 'InboxThreadDetail' } },
    },
  },
  '/inbox/messages/{id}/task': {
    post: {
      operationId: 'createTaskFromEmailMessage',
      summary:
        'Create a follow-up task pre-linked to the email contact, company, deal and lead (PRD 4.11)',
      parameters: idParam,
      responses: { '201': { description: 'Task' } },
    },
  },
  '/inbox/manual-link': {
    post: {
      operationId: 'manualLinkGraphMessage',
      summary:
        'Manually link a specific Microsoft 365 message to a CRM contact or company (PRD 4.11)',
      responses: ok('Link outcome'),
    },
  },
  '/inbox/messages/{messageId}/attachments/{attachmentId}': {
    get: {
      operationId: 'downloadInboxAttachment',
      summary:
        'Stream an email attachment on-demand from Microsoft Graph after verifying inbox.read scope (PRD 4.11)',
      responses: { '200': { description: 'Binary attachment stream' } },
    },
  },
  '/inbox/templates': {
    get: {
      operationId: 'listInboxTemplates',
      summary: 'List shared and personal email templates (PRD 4.11, 4.12)',
      responses: ok('EmailTemplateView list'),
    },
    post: {
      operationId: 'createInboxTemplate',
      summary: 'Create a reusable email template with personalisation variables (PRD 4.11, 4.12)',
      responses: { '201': { description: 'EmailTemplateView' } },
    },
  },
  '/webhooks/microsoft': {
    post: {
      operationId: 'receiveMicrosoftGraphWebhook',
      summary:
        'Public Microsoft Graph webhook on go. host: echoes validationToken on handshake and validates clientState SHA-256 on change notifications (PRD 8.2)',
      responses: {
        '200': { description: 'Plain-text validationToken echo' },
        '202': { description: 'Notification accepted' },
      },
    },
  },
};

const sequencesAndCampaignsPaths = {
  '/templates': {
    get: {
      operationId: 'listOutreachTemplates',
      summary:
        'List shared and personal outreach templates filtered by channel or market (PRD 4.12, 4.13)',
      responses: ok('Template list'),
    },
    post: {
      operationId: 'createOutreachTemplate',
      summary: 'Create a plain-text or block-editor outreach template (PRD 4.12, 4.13)',
      responses: { '201': { description: 'Template created' } },
    },
  },
  '/templates/{id}': {
    patch: {
      operationId: 'updateOutreachTemplate',
      summary: 'Update an outreach template with optimistic concurrency version check',
      parameters: idParam,
      responses: ok('Updated template'),
    },
  },
  '/sequences': {
    get: {
      operationId: 'listSequences',
      summary:
        'List outreach sequences within sequences.read scope with step and enrollment counts (PRD 4.12)',
      responses: ok('Sequence list'),
    },
    post: {
      operationId: 'createSequence',
      summary:
        'Create a multi-step email and task sequence with local send window and mailbox cap (PRD 4.12)',
      responses: { '201': { description: 'Sequence created' } },
    },
  },
  '/sequences/{id}': {
    get: {
      operationId: 'getSequenceDetail',
      summary: 'Get sequence detail, per-step metrics, and enrollments (PRD 4.12)',
      parameters: idParam,
      responses: ok('Sequence detail'),
    },
    patch: {
      operationId: 'updateSequence',
      summary: 'Update sequence configuration and steps (version checked)',
      parameters: idParam,
      responses: ok('Updated sequence'),
    },
  },
  '/sequences/{id}/enroll': {
    post: {
      operationId: 'batchEnrollSequence',
      summary:
        'Enroll one or more contacts into a sequence with checkSendable and single-active-sequence checks (PRD 4.12, A16, A17)',
      parameters: idParam,
      responses: { '201': { description: 'Enrollment results and skip reasons' } },
    },
  },
  '/enrollments/{id}/state': {
    post: {
      operationId: 'updateSequenceEnrollmentState',
      summary: 'Pause, resume, or stop a sequence enrollment (PRD 4.12)',
      parameters: idParam,
      responses: ok('Updated enrollment'),
    },
  },
  '/enrollments/{id}/stop': {
    post: {
      operationId: 'stopSequenceEnrollment',
      summary: 'Stop an active or paused sequence enrollment immediately (PRD 4.12, 6.7)',
      parameters: idParam,
      responses: ok('Stopped enrollment'),
    },
  },
  '/lists': {
    get: {
      operationId: 'listMarketingLists',
      summary: 'List static marketing lists and dynamic filter-language segments (PRD 4.13, 6.8)',
      responses: ok('Marketing lists'),
    },
    post: {
      operationId: 'createMarketingList',
      summary:
        'Create a static list or dynamic segment validated against the contact field registry (PRD 4.13, 6.8)',
      responses: { '201': { description: 'Created list or segment' } },
    },
  },
  '/lists/{id}': {
    get: {
      operationId: 'getMarketingListDetail',
      summary: 'Resolve members of a static list or dynamic segment (PRD 4.13)',
      parameters: idParam,
      responses: ok('List detail and resolved members'),
    },
    patch: {
      operationId: 'updateMarketingList',
      summary: 'Update a static list or dynamic segment (version checked)',
      parameters: idParam,
      responses: ok('Updated list'),
    },
  },
  '/lists/{id}/members': {
    post: {
      operationId: 'addMarketingListMembers',
      summary: 'Add contacts to a static marketing list',
      parameters: idParam,
      responses: ok('Updated member count'),
    },
  },
  '/lists/{id}/members/{contactId}': {
    delete: {
      operationId: 'removeMarketingListMember',
      summary: 'Remove a contact from a static marketing list',
      responses: ok('Updated member count'),
    },
  },
  '/sender-identities': {
    get: {
      operationId: 'listSenderIdentities',
      summary:
        'List campaign sender identities and SPF/DKIM/DMARC subdomain verification status (PRD 5.4, 4.17)',
      responses: ok('Sender identities'),
    },
    post: {
      operationId: 'createSenderIdentity',
      summary: 'Register a campaign sender identity on a dedicated sending subdomain (PRD 5.4)',
      responses: { '201': { description: 'Created sender identity' } },
    },
  },
  '/sender-identities/{id}': {
    patch: {
      operationId: 'updateSenderIdentity',
      summary: 'Update SPF/DKIM/DMARC verification status and daily warm-up cap (PRD 5.4)',
      parameters: idParam,
      responses: ok('Updated sender identity'),
    },
  },
  '/campaigns': {
    get: {
      operationId: 'listCampaigns',
      summary: 'List marketing campaigns within campaigns.read scope (PRD 4.13)',
      responses: ok('Campaign list'),
    },
    post: {
      operationId: 'createCampaign',
      summary: 'Create a marketing campaign with block-editor HTML and plain-text copy (PRD 4.13)',
      responses: { '201': { description: 'Created campaign' } },
    },
  },
  '/campaigns/{id}': {
    get: {
      operationId: 'getCampaignDetail',
      summary:
        'Get campaign detail, pre-flight checklist, recipients, and click breakdown (PRD 4.13)',
      parameters: idParam,
      responses: ok('Campaign detail'),
    },
    patch: {
      operationId: 'updateCampaign',
      summary: 'Edit a campaign; editing an approved campaign returns it to Draft (PRD 4.13)',
      parameters: idParam,
      responses: ok('Updated campaign'),
    },
  },
  '/campaigns/{id}/preflight': {
    get: {
      operationId: 'getCampaignPreflight',
      summary:
        'Run pre-flight compliance and sender verification checks across the target audience (PRD 4.13)',
      parameters: idParam,
      responses: ok('Pre-flight checklist'),
    },
  },
  '/campaigns/{id}/submit': {
    post: {
      operationId: 'submitCampaignForApproval',
      summary: 'Submit a draft campaign for second-person approval (PRD 4.13, A19)',
      parameters: idParam,
      responses: ok('Pending approval'),
    },
  },
  '/campaigns/{id}/approve': {
    post: {
      operationId: 'approveCampaign',
      summary:
        'Approve a campaign as a second reviewer (requires campaigns.approve; creator cannot self-approve — PRD 2.4, 4.13, A19)',
      parameters: idParam,
      responses: ok('Approved campaign'),
    },
  },
  '/campaigns/{id}/test-send': {
    post: {
      operationId: 'testSendCampaign',
      summary: 'Send a [TEST] preview to an internal active employee address (PRD 4.13)',
      parameters: idParam,
      responses: ok('Test send receipt'),
    },
  },
  '/campaigns/{id}/schedule': {
    post: {
      operationId: 'scheduleCampaign',
      summary:
        'Schedule an approved campaign or start throttled sending immediately (PRD 4.13, 8.4)',
      parameters: idParam,
      responses: ok('Scheduled or sending campaign'),
    },
  },
  '/campaigns/{id}/pause': {
    post: {
      operationId: 'pauseCampaign',
      summary: 'Pause an approved, scheduled, or sending campaign (PRD 4.13)',
      parameters: idParam,
      responses: ok('Paused campaign'),
    },
  },
  '/campaigns/{id}/cancel': {
    post: {
      operationId: 'cancelCampaign',
      summary: 'Cancel a campaign (PRD 4.13)',
      parameters: idParam,
      responses: ok('Cancelled campaign'),
    },
  },
  '/contacts/{id}/outreach': {
    get: {
      operationId: 'getContactOutreachHistory',
      summary:
        'Sequence enrollments, campaign deliveries, and message sends for a contact (PRD 4.4)',
      parameters: idParam,
      responses: ok('Contact outreach history'),
    },
  },
  '/webhooks/esp': {
    post: {
      operationId: 'receiveEspWebhook',
      summary:
        'Public HMAC-SHA256 verified ESP webhook on go. host for deliveries, bounces, complaints, clicks and auto-pause (PRD 5.6, 8.4, A20)',
      responses: {
        '202': { description: 'Webhook accepted' },
        '401': { description: 'Invalid signature' },
      },
    },
  },
};

const integrationsAndWebhooksPaths: Record<string, Record<string, unknown>> = {
  '/admin/integrations': {
    get: {
      operationId: 'getIntegrationsOverview',
      summary:
        'Live configuration and health summary for Entra SSO, Microsoft 365 Graph, ESP, Apollo, Bookings, and Outbound Webhooks (PRD 4.14, 4.17)',
      responses: ok('Integrations overview'),
    },
  },
  '/admin/apollo/credit-limit': {
    put: {
      operationId: 'updateApolloCreditLimit',
      summary: 'Update the daily Apollo enrichment credit guard cap (PRD 4.14, 4.17)',
      responses: ok('Updated Apollo credit cap'),
    },
  },
  '/apollo/status': {
    get: {
      operationId: 'getApolloStatus',
      summary: 'Apollo connector status and remaining daily credit balance (PRD 4.14)',
      responses: ok('Apollo status'),
    },
  },
  '/apollo/search': {
    post: {
      operationId: 'searchApolloProspects',
      summary:
        'Search Apollo B2B prospects with CRM deduplication and suppression preview (PRD 4.14)',
      responses: ok('Apollo search results'),
    },
  },
  '/apollo/import': {
    post: {
      operationId: 'importApolloProspects',
      summary:
        'Import selected Apollo prospects after upfront credit-cost confirmation, skipping suppressions and storing zero consent (PRD 4.14, 5)',
      responses: { '201': { description: 'Import result' } },
    },
  },
  '/contacts/{id}/enrich-apollo': {
    post: {
      operationId: 'enrichContactWithApollo',
      summary: 'Enrich a single CRM contact via Apollo after 1-credit confirmation (PRD 4.14)',
      parameters: idParam,
      responses: ok('Enrichment result'),
    },
  },
  '/admin/webhooks': {
    get: {
      operationId: 'listWebhookEndpoints',
      summary: 'List outbound webhook endpoints with masked secret hints (PRD 4.14, 4.17)',
      responses: ok('Webhook endpoints'),
    },
    post: {
      operationId: 'createWebhookEndpoint',
      summary:
        'Create an encrypted outbound webhook endpoint and reveal its HMAC signing secret once (PRD 4.14, 9)',
      responses: { '201': { description: 'Created webhook endpoint' } },
    },
  },
  '/admin/webhooks/{id}': {
    patch: {
      operationId: 'updateWebhookEndpoint',
      summary: 'Update or rotate the secret of an outbound webhook endpoint (PRD 4.14, 4.17)',
      parameters: idParam,
      responses: ok('Updated webhook endpoint'),
    },
    delete: {
      operationId: 'deleteWebhookEndpoint',
      summary: 'Delete an outbound webhook endpoint (PRD 4.17)',
      parameters: idParam,
      responses: ok('Deleted'),
    },
  },
  '/admin/webhooks/{id}/deliveries': {
    get: {
      operationId: 'listWebhookDeliveries',
      summary: 'List recent outbound webhook delivery attempts and HTTP status codes (PRD 4.14)',
      parameters: idParam,
      responses: ok('Webhook delivery log'),
    },
  },
  '/admin/webhooks/{id}/test': {
    post: {
      operationId: 'testWebhookEndpoint',
      summary:
        'Send a signed webhook.test ping and return the live HTTP delivery status (PRD 4.14)',
      parameters: idParam,
      responses: ok('Test delivery status'),
    },
  },
  '/webhooks/bookings': {
    post: {
      operationId: 'receiveMicrosoftBookingsWebhook',
      summary:
        'Public HMAC-SHA256 verified Microsoft Bookings webhook on go. host creating meeting activities and prep tasks (PRD 4.14, 6.5)',
      responses: {
        '202': { description: 'Bookings event accepted' },
        '401': { description: 'Invalid or expired signature' },
      },
    },
  },
};

const allPaths = openApiSpec.paths as Record<string, Record<string, unknown>>;
for (const [path, methods] of Object.entries({
  ...listsAndEditingPaths,
  ...adminAndDashboardPaths,
  ...duplicatePaths,
  ...exportPaths,
  ...complianceAndPrivacyPaths,
  ...intakeAndRoutingPaths,
  ...crmExtensionsPaths,
  ...inboxAndGraphPaths,
  ...sequencesAndCampaignsPaths,
  ...integrationsAndWebhooksPaths,
})) {
  allPaths[path] = { ...allPaths[path], ...methods };
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(openApiSpec, null, 2)}\n`, 'utf8');
console.log(`[openapi] Wrote OpenAPI snapshot to ${outPath}`);
