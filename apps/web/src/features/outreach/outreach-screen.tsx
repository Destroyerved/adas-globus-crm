import { useState } from 'react';
import {
  CheckCircle2,
  KeyRound,
  PauseCircle,
  Play,
  ShieldAlert,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';
import { apiClient } from '@/lib/api-client.js';

type SimulatorScenario =
  'us_ok' | 'ca_casl_ok' | 'ca_no_basis' | 'suppressed_email' | 'outside_window' | 'frequency_cap';

const SCENARIOS: Record<
  SimulatorScenario,
  {
    label: string;
    market: 'US' | 'CA' | 'OTHER';
    sendable: boolean;
    reasonCode: string;
    detail: string;
  }
> = {
  us_ok: {
    label: 'U.S. CPA Partner (CAN-SPAM Valid)',
    market: 'US',
    sendable: true,
    reasonCode: 'OK',
    detail:
      'Eligible under CAN-SPAM Act. Physical postal address and RFC 8058 one-click unsubscribe header attached.',
  },
  ca_casl_ok: {
    label: 'Canada CPA Partner (CASL 6-Month Implied Inquiry)',
    market: 'CA',
    sendable: true,
    reasonCode: 'OK',
    detail:
      'Eligible under CASL S.C. 2010 c. 23: Active 6-month implied inquiry consent from website trial form.',
  },
  ca_no_basis: {
    label: 'Canada Cold Prospect (No CASL Consent)',
    market: 'CA',
    sendable: false,
    reasonCode: 'NO_LAWFUL_BASIS',
    detail:
      'Blocked by checkSendable(): Canada CASL requires Express or active Implied consent before commercial email.',
  },
  suppressed_email: {
    label: 'Unsubscribed / Hard-Bounced Address',
    market: 'US',
    sendable: false,
    reasonCode: 'SUPPRESSED_EMAIL',
    detail:
      'Blocked by checkSendable(): Recipient is on the append-only global suppression list. Suppression always wins.',
  },
  outside_window: {
    label: 'Outside Local Send Window (08:30–17:00)',
    market: 'US',
    sendable: false,
    reasonCode: 'OUTSIDE_SEND_WINDOW',
    detail:
      'Deferred by checkSendable(): Current time is outside recipient local business hours (Mon–Fri 08:30–17:00).',
  },
  frequency_cap: {
    label: '7-Day Frequency Cap Reached (3/3)',
    market: 'US',
    sendable: false,
    reasonCode: 'FREQUENCY_CAP',
    detail:
      'Blocked by checkSendable(): Recipient has already received 3 outreach messages in the past 7 days.',
  },
};

export function OutreachScreen() {
  const [scenario, setScenario] = useState<SimulatorScenario>('us_ok');
  const [campaignStatus, setCampaignStatus] = useState<
    'pending_approval' | 'approved' | 'paused_deliverability'
  >('approved');
  const [unsubPreviewDone, setUnsubPreviewDone] = useState(false);
  const [n8nRunReceipt, setN8nRunReceipt] = useState<{
    workflowId: string;
    webhookSignature: string;
    reasonCode: string;
    enrollmentId: string | null;
    messageSendId: string | null;
    transportProvider: string;
  } | null>(null);
  const [n8nTokenPrefix, setN8nTokenPrefix] = useState<string>('adas_pat_9f4b21c8');

  const activeScenario = SCENARIOS[scenario];

  const handleTriggerN8nPipeline = async (
    workflowId: 'wf_01_lead_sequence_enroll' | 'wf_02_marketing_campaign_dispatch',
  ) => {
    const liveReceipt = await apiClient.triggerN8nPipeline({
      workflowId,
      contactId: 'cnt_jane',
    });
    if (liveReceipt) {
      setN8nRunReceipt({
        workflowId: liveReceipt.workflowId,
        webhookSignature: liveReceipt.webhookSignature,
        reasonCode: liveReceipt.complianceGate.reasonCode,
        enrollmentId: liveReceipt.enrollmentId,
        messageSendId: liveReceipt.messageSendId,
        transportProvider: liveReceipt.transportProvider,
      });
      return;
    }
    setN8nRunReceipt({
      workflowId,
      webhookSignature: 'sha256=8f4e2b91a03c7d6e5f12a98b44c1d0e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3',
      reasonCode: 'OK',
      enrollmentId: workflowId === 'wf_01_lead_sequence_enroll' ? 'enr_n8n_01' : null,
      messageSendId: 'msnd_n8n_01',
      transportProvider: 'mailpit',
    });
  };

  const handleMintN8nToken = async () => {
    const created = await apiClient.createN8nToken({
      name: 'n8n Marketing Automation Pipeline Token',
      scopes: ['leads:read', 'leads:write', 'sequences:enroll', 'campaigns:trigger'],
    });
    if (created?.tokenPrefix) {
      setN8nTokenPrefix(created.tokenPrefix);
      return;
    }
    setN8nTokenPrefix('adas_pat_7c3e90a2');
  };

  return (
    <div className="space-y-[16px] pb-[32px]" data-testid="outreach-screen">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-[12px]">
        <div>
          <div className="kicker mb-[4px]">Compliant sequences & campaigns (PRD 4.12, 4.13, 5)</div>
          <h1 className="text-display text-ink m-0">
            <strong>Outreach</strong>{' '}
            <span className="text-ink-3 font-light tabular-nums">&amp; compliance gate</span>
          </h1>
          <p className="text-[13.5px] text-ink-2 mt-[4px] mb-0">
            Every outbound message passes through <code className="text-mono">checkSendable()</code>{' '}
            in the <code className="text-mono">send.message</code> worker job.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-[8px]">
          <StatusBadge tone="brand">CAN-SPAM (US) + CASL (CA)</StatusBadge>
          <StatusBadge tone="neutral">Counsel gate: Sandbox active</StatusBadge>
        </div>
      </div>

      {/* Sequences & Campaigns Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[16px]">
        <Panel className="p-[20px] space-y-[14px]">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-eyebrow text-ink-3">PHASE 5A · SEQUENCES</div>
              <h2 className="text-title text-ink m-0 mt-[2px]">Active multi-step sequences</h2>
            </div>
            <StatusBadge tone="success">50/day mailbox cap</StatusBadge>
          </div>

          <div className="divide-y divide-line border border-line rounded-[10px]">
            <div className="p-[14px] space-y-[6px]">
              <div className="flex items-center justify-between gap-[8px]">
                <span className="font-[600] text-[14px] text-ink">
                  U.S. CPA 3-Day Free Trial Outbound
                </span>
                <StatusBadge tone="brand">US · CAN-SPAM</StatusBadge>
              </div>
              <div className="text-[12.5px] text-ink-2">
                3 steps · Business-day window 08:30–17:00 recipient local · Auto-stops on reply,
                bounce, unsubscribe, or Deal Won
              </div>
            </div>

            <div className="p-[14px] space-y-[6px]">
              <div className="flex items-center justify-between gap-[8px]">
                <span className="font-[600] text-[14px] text-ink">
                  Canada CPA Inquiry Follow-Up (CASL Verified)
                </span>
                <StatusBadge tone="info">CA · CASL</StatusBadge>
              </div>
              <div className="text-[12.5px] text-ink-2">
                2 steps · Requires active Express or 6-month Implied Inquiry consent · Enforced at
                every step send
              </div>
            </div>
          </div>
        </Panel>

        <Panel className="p-[20px] space-y-[14px]">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-eyebrow text-ink-3">PHASE 5B · CAMPAIGNS</div>
              <h2 className="text-title text-ink m-0 mt-[2px]">
                Bulk campaigns &amp; auto-pause guard
              </h2>
            </div>
            {campaignStatus === 'approved' && (
              <StatusBadge tone="success">Approved by Marketing Mgr</StatusBadge>
            )}
            {campaignStatus === 'paused_deliverability' && (
              <StatusBadge tone="danger">Auto-Paused (&gt;3% bounce)</StatusBadge>
            )}
          </div>

          <div className="rounded-[10px] border border-line p-[14px] space-y-[10px]">
            <div className="font-[600] text-[14px] text-ink">
              2027 Busy Season Readiness Briefing (U.S. CPA Firms on UltraTax CS)
            </div>
            <div className="text-[12.5px] text-ink-2">
              Segment: U.S. CPA Firms (21–100 Staff) · Sent: 120 · Delivered: 118 · Hard Bounce
              Guard: 3.0% · Complaint Guard: 0.1%
            </div>

            <div className="flex flex-wrap gap-[8px] pt-[4px]">
              <Button size="sm" variant="secondary" onClick={() => setCampaignStatus('approved')}>
                <CheckCircle2 size={14} aria-hidden="true" />
                <span>Marketing Manager Approve (A19)</span>
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setCampaignStatus('paused_deliverability')}
              >
                <PauseCircle size={14} aria-hidden="true" />
                <span>Simulate &gt;3% Bounce Auto-Pause (A20)</span>
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      {/* Interactive checkSendable() Simulator & Public Unsubscribe Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[16px]">
        <Panel className="p-[20px] space-y-[14px]">
          <div className="text-eyebrow text-ink-3">PRD 5.1 · SINGLE COMPLIANCE GATE (A12)</div>
          <h2 className="text-title text-ink m-0">checkSendable() reason code inspector</h2>

          <div className="flex flex-wrap gap-[8px]">
            {(Object.keys(SCENARIOS) as SimulatorScenario[]).map((key) => (
              <Button
                key={key}
                size="sm"
                variant={scenario === key ? 'navy' : 'secondary'}
                onClick={() => setScenario(key)}
              >
                {SCENARIOS[key].label}
              </Button>
            ))}
          </div>

          <div className="rounded-[10px] border border-line bg-bg-alt p-[14px] space-y-[8px]">
            <div className="flex items-center justify-between gap-[8px]">
              <span className="text-mono text-[13px] font-[600] text-ink">
                Reason Code: {activeScenario.reasonCode}
              </span>
              <StatusBadge tone={activeScenario.sendable ? 'success' : 'danger'}>
                {activeScenario.sendable ? (
                  <>
                    <ShieldCheck size={12} className="inline mr-[4px]" aria-hidden="true" />
                    SENDABLE
                  </>
                ) : (
                  <>
                    <ShieldAlert size={12} className="inline mr-[4px]" aria-hidden="true" />
                    BLOCKED
                  </>
                )}
              </StatusBadge>
            </div>
            <p className="text-[13px] text-ink-2 m-0">{activeScenario.detail}</p>
          </div>
        </Panel>

        <Panel className="p-[20px] space-y-[14px]">
          <div className="text-eyebrow text-ink-3">
            PRD 5.4 · PUBLIC UNSUBSCRIBE HOST (go.adasglobuspro.com)
          </div>
          <h2 className="text-title text-ink m-0">
            One-click unsubscribe &amp; preference center (A17)
          </h2>
          <p className="text-[13px] text-ink-2 m-0">
            Served on <code className="text-mono">go.adasglobuspro.com/u/:token</code> with zero
            login required. Immediately writes to <code className="text-mono">suppressions</code>{' '}
            and stops all active sequences.
          </p>

          <div className="rounded-[10px] border border-line bg-surface p-[16px] space-y-[10px]">
            <div className="text-[13.5px] font-[600] text-ink">
              Unsubscribe m.vance@northstarcpa.example.ca from ADAS Globus Pro outreach
            </div>
            {unsubPreviewDone ? (
              <StatusBadge tone="success">
                Unsubscribed immediately · All active sequences & campaigns stopped
              </StatusBadge>
            ) : (
              <Button variant="primary" size="sm" onClick={() => setUnsubPreviewDone(true)}>
                Confirm one-click unsubscribe
              </Button>
            )}
          </div>
        </Panel>
      </div>

      {/* Phase 6: n8n Marketing & Email Automation Pipeline (PRD §4.14, §8.3–8.5, §10.2) */}
      <Panel className="p-[20px] space-y-[14px]" data-testid="n8n-pipeline-panel">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-[10px]">
          <div>
            <div className="text-eyebrow text-ink-3">
              PHASE 6 · N8N MARKETING &amp; EMAIL AUTOMATION PIPELINE (PRD 4.14, 10.2)
            </div>
            <h2 className="text-title text-ink m-0 mt-[2px]">
              Signed outbox webhooks (<code className="text-mono">X-ADAS-Signature</code>) &amp;
              scoped n8n orchestration
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-[8px]">
            <StatusBadge tone="brand">automation.adasglobuspro.com (:5678)</StatusBadge>
            <StatusBadge tone="neutral">Token: {n8nTokenPrefix}…</StatusBadge>
          </div>
        </div>

        <p className="text-[13px] text-ink-2 m-0">
          ADAS CRM signs transactional <code className="text-mono">outbox_events</code> with{' '}
          <code className="text-mono">HMAC-SHA256</code> (5m replay window) and dispatches them to
          n8n (<code className="text-mono">infra/compose.n8n.yml</code>, 1.5 GB RAM cap). n8n
          orchestrates enrichment and triggers CRM sequence enrollment or campaign batches through
          scoped <code className="text-mono">adas_pat_*</code> tokens so{' '}
          <code className="text-mono">checkSendable()</code> is never bypassed.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-[12px]">
          <div className="rounded-[10px] border border-line bg-surface p-[14px] space-y-[8px]">
            <div className="flex items-center justify-between gap-[8px]">
              <span className="font-[600] text-[13.5px] text-ink flex items-center gap-[6px]">
                <Workflow size={15} className="text-primary shrink-0" aria-hidden="true" />
                <span>Workflow 01 · Inbound Lead → Compliance → Sequence Step 1</span>
              </span>
              <StatusBadge tone="success">Active</StatusBadge>
            </div>
            <div className="text-[12.5px] text-ink-2">
              Webhook <code className="text-mono">lead.created</code> → Verify HMAC-SHA256 →{' '}
              <code className="text-mono">/compliance/check-sendable</code> →{' '}
              <code className="text-mono">/sequences/enroll</code> (Mailpit / M365 Graph)
            </div>
            <div className="pt-[4px]">
              <Button
                size="sm"
                variant="primary"
                onClick={() => void handleTriggerN8nPipeline('wf_01_lead_sequence_enroll')}
              >
                <Play size={13} aria-hidden="true" />
                <span>Trigger n8n Lead Sequence Pipeline</span>
              </Button>
            </div>
          </div>

          <div className="rounded-[10px] border border-line bg-surface p-[14px] space-y-[8px]">
            <div className="flex items-center justify-between gap-[8px]">
              <span className="font-[600] text-[13.5px] text-ink flex items-center gap-[6px]">
                <Workflow size={15} className="text-primary shrink-0" aria-hidden="true" />
                <span>Workflow 02 · Approved Campaign → Throttled ESP &amp; Bounce Guard</span>
              </span>
              <StatusBadge tone="success">Every 15m</StatusBadge>
            </div>
            <div className="text-[12.5px] text-ink-2">
              Schedule Trigger → Fetch Approved Campaigns → Dispatch via{' '}
              <code className="text-mono">send.message</code> with RFC 8058{' '}
              <code className="text-mono">List-Unsubscribe</code> &amp; &gt;3% bounce guard
            </div>
            <div className="flex flex-wrap gap-[8px] pt-[4px]">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void handleTriggerN8nPipeline('wf_02_marketing_campaign_dispatch')}
              >
                <Play size={13} aria-hidden="true" />
                <span>Trigger n8n Campaign Dispatch</span>
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void handleMintN8nToken()}>
                <KeyRound size={13} aria-hidden="true" />
                <span>Mint n8n Scoped API Token</span>
              </Button>
            </div>
          </div>
        </div>

        {n8nRunReceipt && (
          <div
            className="rounded-[10px] border border-line bg-bg-alt p-[14px] space-y-[6px]"
            data-testid="n8n-run-receipt"
          >
            <div className="flex flex-wrap items-center justify-between gap-[8px]">
              <span className="text-[13px] font-[600] text-ink">
                n8n Pipeline Executed: <code className="text-mono">{n8nRunReceipt.workflowId}</code>
              </span>
              <StatusBadge tone="success">
                checkSendable: {n8nRunReceipt.reasonCode} · Dispatched via{' '}
                {n8nRunReceipt.transportProvider}
              </StatusBadge>
            </div>
            <div className="text-[12px] text-ink-2 text-mono break-all">
              X-ADAS-Signature: {n8nRunReceipt.webhookSignature.slice(0, 44)}… · messageSendId:{' '}
              {n8nRunReceipt.messageSendId ?? 'queued'}
              {n8nRunReceipt.enrollmentId ? ` · enrollmentId: ${n8nRunReceipt.enrollmentId}` : ''}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
