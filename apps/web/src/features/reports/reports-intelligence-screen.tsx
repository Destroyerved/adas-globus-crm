import { useState } from 'react';
import { Lock, ShieldCheck, Sparkles, Webhook } from 'lucide-react';
import { formatMoney } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';

export function ReportsIntelligenceScreen() {
  const [reportingCurrency, setReportingCurrency] = useState<'USD' | 'CAD'>('USD');
  const [apolloImported, setApolloImported] = useState(false);

  // Open pipeline in minor units: USD 1,858,800 ($18,588/mo) or CAD 2,511,900 (CA$25,119/mo)
  const openPipelineMinor = reportingCurrency === 'USD' ? 1_858_800n : 2_511_900n;
  const wonPipelineMinor = reportingCurrency === 'USD' ? 520_000n : 702_700n;

  return (
    <div className="space-y-[16px] pb-[32px]" data-testid="reports-intelligence-screen">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-[12px]">
        <div>
          <div className="kicker mb-[4px]">
            Reports, integrations &amp; security audit (PRD 4.15, 4.16, 8, 9)
          </div>
          <h1 className="text-display text-ink m-0">
            <strong>Reports</strong>{' '}
            <span className="text-ink-3 font-light tabular-nums">
              &amp; governance intelligence
            </span>
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-[8px]">
          <Button
            size="sm"
            variant={reportingCurrency === 'USD' ? 'navy' : 'secondary'}
            onClick={() => setReportingCurrency('USD')}
          >
            Report in USD (Q8 Default)
          </Button>
          <Button
            size="sm"
            variant={reportingCurrency === 'CAD' ? 'navy' : 'secondary'}
            onClick={() => setReportingCurrency('CAD')}
          >
            Report in CAD (FX 1.3514)
          </Button>
        </div>
      </div>

      {/* Multi-currency KPI Cards (A9) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-[14px]">
        <Panel className="p-[18px]">
          <div className="text-eyebrow text-ink-3">OPEN PIPELINE (MULTI-CURRENCY FX A9)</div>
          <div className="text-kpi text-ink tabular-nums mt-[6px]">
            {formatMoney({ amountMinor: openPipelineMinor, currency: reportingCurrency })}/mo
          </div>
          <div className="text-[12.5px] text-ink-2 mt-[4px]">
            Includes U.S. (USD) and Canadian (CAD → USD @ 0.7400) open pods
          </div>
        </Panel>

        <Panel className="p-[18px]">
          <div className="text-eyebrow text-ink-3">CLOSED WON RECURRING REVENUE</div>
          <div className="text-kpi text-ink tabular-nums mt-[6px]">
            {formatMoney({ amountMinor: wonPipelineMinor, currency: reportingCurrency })}/mo
          </div>
          <div className="text-[12.5px] text-ink-2 mt-[4px]">
            3-day free trial → paid conversion rate: 66.7%
          </div>
        </Panel>

        <Panel className="p-[18px]">
          <div className="text-eyebrow text-ink-3">15-MINUTE WEBSITE SLA COMPLIANCE</div>
          <div className="text-kpi text-ink tabular-nums mt-[6px]">98.4%</div>
          <div className="text-[12.5px] text-ink-2 mt-[4px]">
            Median first response time: 6m 20s across US &amp; CA teams
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[16px]">
        {/* Explainable Lead Scoring (PRD §4.16) */}
        <Panel className="p-[20px] space-y-[12px]">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-eyebrow text-ink-3">PRD 4.16 · EXPLAINABLE LEAD SCORING</div>
              <h2 className="text-title text-ink m-0 mt-[2px]">
                Jane Patel · Acme Tax &amp; Advisory LLP
              </h2>
            </div>
            <StatusBadge tone="success">
              <Sparkles size={12} className="inline mr-[4px]" aria-hidden="true" />
              Score: 95 / 100
            </StatusBadge>
          </div>

          <div className="divide-y divide-line border border-line rounded-[10px] text-[13px]">
            <div className="p-[10px] flex justify-between">
              <span>Website 3-Day Free Trial Inquiry (Engagement)</span>
              <span className="font-[600] text-primary-ink tabular-nums">+35 pts</span>
            </div>
            <div className="p-[10px] flex justify-between">
              <span>CPA Firm 21–100 Staff ICP (Fit)</span>
              <span className="font-[600] text-primary-ink tabular-nums">+25 pts</span>
            </div>
            <div className="p-[10px] flex justify-between">
              <span>Decision Maker: Managing Partner (Fit)</span>
              <span className="font-[600] text-primary-ink tabular-nums">+20 pts</span>
            </div>
            <div className="p-[10px] flex justify-between">
              <span>Tier-1 Tax Software: UltraTax CS (Fit)</span>
              <span className="font-[600] text-primary-ink tabular-nums">+15 pts</span>
            </div>
          </div>
        </Panel>

        {/* Apollo Credit Guard & n8n HMAC Webhooks (PRD §8.3–8.6) */}
        <Panel className="p-[20px] space-y-[12px]">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-eyebrow text-ink-3">
                PHASE 6 · APOLLO, BOOKINGS & N8N WEBHOOKS
              </div>
              <h2 className="text-title text-ink m-0 mt-[2px]">Integrations &amp; credit guard</h2>
            </div>
            <StatusBadge tone="brand">
              Credits: {apolloImported ? '19/200' : '18/200'} today
            </StatusBadge>
          </div>

          <div className="rounded-[10px] border border-line p-[12px] space-y-[8px] text-[13px]">
            <div className="font-[600] text-ink">
              Apollo Prospect Deduplication (<code className="text-mono">apollo_person_id</code>)
            </div>
            <div className="text-ink-2">
              Deduplicates against existing CRM contacts before consuming enrichment credits.
              Enforces hard daily credit cap (200/day).
            </div>
            <Button size="sm" variant="secondary" onClick={() => setApolloImported(true)}>
              {apolloImported
                ? 'Imported & Deduplicated via apollo_person_id'
                : 'Test Apollo Import with Credit Guard'}
            </Button>
          </div>

          <div className="rounded-[10px] border border-line p-[12px] flex items-center justify-between text-[13px]">
            <div>
              <div className="font-[600] text-ink">
                <Webhook size={13} className="inline mr-[6px]" aria-hidden="true" />
                n8n Outbound Webhook (<code className="text-mono">deal.won</code>,{' '}
                <code className="text-mono">lead.created</code>)
              </div>
              <div className="text-ink-2 text-[12px]">
                Signed with <code className="text-mono">X-ADAS-Signature-256 (HMAC-SHA256)</code>
              </div>
            </div>
            <StatusBadge tone="success">200 OK</StatusBadge>
          </div>
        </Panel>
      </div>

      {/* Immutable Audit Log & Privacy Controls (PRD §5.5 & §9) */}
      <Panel className="p-[20px] space-y-[12px]">
        <div className="flex flex-wrap items-center justify-between gap-[8px]">
          <div>
            <div className="text-eyebrow text-ink-3">
              PRD 9 · APPEND-ONLY SECURITY & PRIVACY AUDIT LOG
            </div>
            <h2 className="text-title text-ink m-0 mt-[2px]">Database-protected audit trail</h2>
          </div>
          <StatusBadge tone="neutral">
            <Lock size={12} className="inline mr-[4px]" aria-hidden="true" />
            REVOKE UPDATE, DELETE ON audit_logs & suppressions
          </StatusBadge>
        </div>

        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Audit log entries">
          <table className="w-full text-left border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-ink-2">
                <th className="py-[8px] pr-[12px]">Timestamp (UTC)</th>
                <th className="py-[8px] pr-[12px]">Actor</th>
                <th className="py-[8px] pr-[12px]">Action</th>
                <th className="py-[8px] pr-[12px]">Entity</th>
                <th className="py-[8px]">Verification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              <tr>
                <td className="py-[8px] pr-[12px] text-mono text-[12px]">2026-11-04 14:20:00Z</td>
                <td className="py-[8px] pr-[12px]">Ved Shah (Admin)</td>
                <td className="py-[8px] pr-[12px] font-[550]">user.role_changed</td>
                <td className="py-[8px] pr-[12px]">usr_bdr_2</td>
                <td className="py-[8px]">
                  <StatusBadge tone="success">
                    <ShieldCheck size={11} className="inline mr-[3px]" aria-hidden="true" />
                    Immutable
                  </StatusBadge>
                </td>
              </tr>
              <tr>
                <td className="py-[8px] pr-[12px] text-mono text-[12px]">2026-11-04 14:25:12Z</td>
                <td className="py-[8px] pr-[12px]">Ananya Iyer (Marketing Mgr)</td>
                <td className="py-[8px] pr-[12px] font-[550]">campaign.approved</td>
                <td className="py-[8px] pr-[12px]">cmpg_us_q4_tax</td>
                <td className="py-[8px]">
                  <StatusBadge tone="success">
                    <ShieldCheck size={11} className="inline mr-[3px]" aria-hidden="true" />
                    Immutable
                  </StatusBadge>
                </td>
              </tr>
              <tr>
                <td className="py-[8px] pr-[12px] text-mono text-[12px]">2026-11-04 14:28:40Z</td>
                <td className="py-[8px] pr-[12px]">Ved Shah (Admin)</td>
                <td className="py-[8px] pr-[12px] font-[550]">privacy.erasure (A14)</td>
                <td className="py-[8px] pr-[12px]">SHA-256 Retained · PII Redacted</td>
                <td className="py-[8px]">
                  <StatusBadge tone="success">
                    <ShieldCheck size={11} className="inline mr-[3px]" aria-hidden="true" />
                    Immutable
                  </StatusBadge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
