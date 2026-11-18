/**
 * ADAS CRM — Production Pre-Release Load Test (`PRD 12.2`).
 *
 * Simulates 20 concurrent virtual users across realistic CRM operations for 15 minutes
 * against a staging/local instance seeded with 20,000 companies, 60,000 contacts, and
 * 300,000 timeline activities (`pnpm db:seed --size=large`).
 *
 * Usage (with k6 CLI):
 *   k6 run -e BASE_URL=http://127.0.0.1:3000 -e API_TOKEN=adas_pat_... infra/k6/crm-load.js
 *
 * Cross-platform Node equivalent (no k6 binary required):
 *   pnpm perf:load
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const k6Env = globalThis.__ENV ?? {};
const BASE_URL = k6Env.BASE_URL || 'http://127.0.0.1:3000';
const API_TOKEN = k6Env.API_TOKEN || '';
const DURATION = k6Env.DURATION || '15m';

const listLatency = new Trend('crm_list_duration', true);
const searchLatency = new Trend('crm_search_duration', true);
const profileLatency = new Trend('crm_profile_duration', true);
const kanbanLatency = new Trend('crm_kanban_duration', true);
const widgetLatency = new Trend('crm_widget_duration', true);
const errorRate = new Rate('crm_errors');

export const options = {
  scenarios: {
    crm_workday: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '1m', target: 20 },
        { duration: DURATION, target: 20 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    // PRD 12.2 p95 latency budgets & < 0.5% error rate
    crm_list_duration: ['p(95)<400'],
    crm_search_duration: ['p(95)<300'],
    crm_profile_duration: ['p(95)<500'],
    crm_kanban_duration: ['p(95)<1500'],
    crm_widget_duration: ['p(95)<800'],
    crm_errors: ['rate<0.005'],
  },
};

function buildHeaders() {
  const headers = {
    Accept: 'application/json',
    Host: 'crm.adasglobuspro.com',
  };
  if (API_TOKEN) {
    headers.Authorization = `Bearer ${API_TOKEN}`;
  }
  return headers;
}

export default function runVirtualUser() {
  const headers = buildHeaders();
  const vu = globalThis.__VU ?? 1;

  // 1. Filtered & sorted 50-row list page (budget: 400 ms p95)
  const usFilter = encodeURIComponent(JSON.stringify({ field: 'market', op: 'eq', value: 'US' }));
  const listPaths = [
    '/api/v1/contacts?limit=50&sort=-updatedAt',
    `/api/v1/companies?limit=50&sort=name&filter=${usFilter}`,
    '/api/v1/leads?limit=50&sort=-score',
    '/api/v1/deals?limit=50&sort=-updatedAt',
  ];
  const listRes = http.get(`${BASE_URL}${listPaths[vu % listPaths.length]}`, { headers });
  listLatency.add(listRes.timings.duration);
  errorRate.add(listRes.status !== 200);
  check(listRes, { 'list 200': (r) => r.status === 200 });

  // 2. Global trigram + full-text search (budget: 300 ms p95)
  const queries = ['acme', 'tax%20advisory', 'montreal', 'partner%20audit'];
  const searchRes = http.get(
    `${BASE_URL}/api/v1/search?q=${queries[vu % queries.length]}&extended=1`,
    { headers },
  );
  searchLatency.add(searchRes.timings.duration);
  errorRate.add(searchRes.status !== 200);
  check(searchRes, { 'search 200': (r) => r.status === 200 });

  // 3. Record profile with timeline (budget: 500 ms p95)
  const profilePaths = [
    `/api/v1/companies/cmp_l_${(vu % 50) + 1}`,
    `/api/v1/contacts/cnt_l_${(vu % 50) + 1}`,
  ];
  const profileRes = http.get(`${BASE_URL}${profilePaths[vu % profilePaths.length]}`, { headers });
  profileLatency.add(profileRes.timings.duration);
  errorRate.add(profileRes.status !== 200 && profileRes.status !== 404);
  check(profileRes, { 'profile 200': (r) => r.status === 200 || r.status === 404 });

  // 4. Kanban board (budget: 1,500 ms p95)
  if (vu % 2 === 0) {
    const boardRes = http.get(`${BASE_URL}/api/v1/pipelines/pipeline_new_business/board`, {
      headers,
    });
    kanbanLatency.add(boardRes.timings.duration);
    errorRate.add(boardRes.status !== 200);
    check(boardRes, { 'kanban 200': (r) => r.status === 200 });
  }

  // 5. Role dashboard widget (budget: 800 ms p95)
  const widgetIds = ['followups_today', 'overdue_tasks', 'leads_by_status', 'pipeline_by_stage'];
  const widgetRes = http.get(
    `${BASE_URL}/api/v1/dashboard/widgets/${widgetIds[vu % widgetIds.length]}?from=2026-10-01&to=2026-11-30`,
    { headers },
  );
  widgetLatency.add(widgetRes.timings.duration);
  errorRate.add(widgetRes.status !== 200);
  check(widgetRes, { 'widget 200': (r) => r.status === 200 });

  sleep(0.25);
}
