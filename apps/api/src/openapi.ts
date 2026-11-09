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
        summary: 'Public website form intake endpoint (PRD §4.10)',
        responses: { '200': { description: 'Accepted' } },
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

const allPaths = openApiSpec.paths as Record<string, Record<string, unknown>>;
for (const [path, methods] of Object.entries({
  ...listsAndEditingPaths,
  ...adminAndDashboardPaths,
  ...duplicatePaths,
  ...exportPaths,
})) {
  allPaths[path] = { ...allPaths[path], ...methods };
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(openApiSpec, null, 2)}\n`, 'utf8');
console.log(`[openapi] Wrote OpenAPI snapshot to ${outPath}`);
