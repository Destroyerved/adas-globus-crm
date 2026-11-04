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
  const [warmupWeek, setWarmupWeek] = useState<1 | 2 | 3 | 4>(4);
  const [tailorProfileId, setTailorProfileId] = useState<'cnt_jane' | 'cnt_marcus' | 'cnt_elena'>(
    'cnt_jane',
  );
  const [tailoredPreview, setTailoredPreview] = useState<{
    recipientLabel: string;
    market: 'US' | 'CA';
    softwareStack: string[];
    subject: string;
    bodyPlainText: string;
    postalFooter: string;
    spamRiskScore: number;
    jitterMinutes: number;
    verdict: 'INBOX_READY' | 'REVIEW_NEEDED';
  }>({
    recipientLabel: 'Jane Patel · Managing Partner · Acme Tax & Advisory LLP (Chicago, IL)',
    market: 'US',
    softwareStack: ['UltraTax CS', 'QuickBooks', 'Suralink'],
    subject: 'Acme Tax & Advisory LLP · UltraTax CS and QuickBooks reviewer pod for IL busy season',
    bodyPlainText: [
      'Hi Jane,',
      '',
      "Speaking with 21–50-person CPA firms in Chicago, IL, most Managing Partners tell us the bottleneck isn't finding clients—it's getting clean, review-ready IRS 1040, 1065 and 1120 tax returns and GAAP audit workpapers inside UltraTax CS and QuickBooks without burning out senior managers.",
      '',
      'At ADAS Globus Pro, we pair Acme Tax & Advisory LLP with a dedicated offshore Tax Preparation pod trained directly on UltraTax CS, QuickBooks, Suralink. Before any commitment, we run a 3-day free trial on a sample engagement so your partners can grade our workpaper indexing and turnaround firsthand.',
      '',
      'Would next Tuesday or Thursday inside your Chicago business hours work for a 12-minute walkthrough of how our UltraTax CS and QuickBooks pods operate?',
      '',
      'Best regards,',
      'Arjun Mehta',
      'Partner Success · ADAS Globus Pro',
      '',
      '---',
      'If you\'d rather not hear from me, reply "no thanks" or unsubscribe in one click: https://go.adasglobuspro.com/u/preview-token',
      'ADAS Globus Pro · 30 N Gould St Ste R, Sheridan, WY 82801, USA',
    ].join('\n'),
    postalFooter: 'ADAS Globus Pro · 30 N Gould St Ste R, Sheridan, WY 82801, USA',
    spamRiskScore: 0,
    jitterMinutes: 7,
    verdict: 'INBOX_READY',
  });

  const activeScenario = SCENARIOS[scenario];

  const handleSelectTailorProfile = async (contactId: 'cnt_jane' | 'cnt_marcus' | 'cnt_elena') => {
    setTailorProfileId(contactId);
    const live = await apiClient.tailorOutreachEmail({ contactId });
    if (live) {
      setTailoredPreview({
        recipientLabel: `${live.recipient.firstName} · ${live.recipient.title} · ${live.recipient.companyName} (${live.recipient.location})`,
        market: live.recipient.market,
        softwareStack: live.recipient.softwareStack,
        subject: live.subject,
        bodyPlainText: live.bodyPlainText,
        postalFooter: live.postalFooter,
        spamRiskScore: live.deliverabilityCheck.spamRiskScore,
        jitterMinutes: live.deliverabilityCheck.scheduledJitterMinutes,
        verdict: live.deliverabilityCheck.verdict,
      });
      return;
    }
    if (contactId === 'cnt_marcus') {
      setTailoredPreview({
        recipientLabel:
          'Marcus Vance · Tax Practice Leader · Northstar Chartered Accountants (Toronto, ON)',
        market: 'CA',
        softwareStack: ['CaseWare', 'TaxCycle', 'Xero'],
        subject:
          'Northstar Chartered Accountants · CaseWare and TaxCycle capacity for T1/T2 season (Toronto)',
        bodyPlainText: [
          'Hi Marcus,',
          '',
          "Speaking with 11–20-person CPA firms in Toronto, ON, most Tax Practice Leaders tell us the bottleneck isn't finding clients—it's getting clean, review-ready CRA T1 personal, T2 corporate and year-end compilation working papers inside CaseWare and TaxCycle without burning out senior managers.",
          '',
          'At ADAS Globus Pro, we pair Northstar Chartered Accountants with a dedicated offshore Canadian T1/T2 Tax pod trained directly on CaseWare, TaxCycle, Xero. Before any commitment, we run a 3-day free trial on a sample engagement so your partners can grade our workpaper indexing and turnaround firsthand.',
          '',
          'Would next Tuesday or Thursday inside your Toronto business hours work for a 12-minute walkthrough of how our CaseWare and TaxCycle pods operate?',
          '',
          'Best regards,',
          'Arjun Mehta',
          'Partner Success · ADAS Globus Pro',
          '',
          '---',
          'If you\'d rather not hear from me, reply "no thanks" or unsubscribe in one click: https://go.adasglobuspro.com/u/preview-token',
          'ADAS Globus Pro · 10180 101 St NW Suite 3400, Edmonton, AB T5J 3S4, Canada',
        ].join('\n'),
        postalFooter: 'ADAS Globus Pro · 10180 101 St NW Suite 3400, Edmonton, AB T5J 3S4, Canada',
        spamRiskScore: 0,
        jitterMinutes: 11,
        verdict: 'INBOX_READY',
      });
    } else if (contactId === 'cnt_elena') {
      setTailoredPreview({
        recipientLabel: 'Elena Rostova · Audit Director · Ridgeway CPA Group (Austin, TX)',
        market: 'US',
        softwareStack: ['CCH Axcess', 'QuickBooks', 'Canopy'],
        subject: 'Ridgeway CPA Group · CCH Axcess and QuickBooks reviewer pod for TX busy season',
        bodyPlainText: [
          'Hi Elena,',
          '',
          "Speaking with 51–100-person CPA firms in Austin, TX, most Audit Directors tell us the bottleneck isn't finding clients—it's getting clean, review-ready IRS 1040, 1065 and 1120 tax returns and GAAP audit workpapers inside CCH Axcess and QuickBooks without burning out senior managers.",
          '',
          'At ADAS Globus Pro, we pair Ridgeway CPA Group with a dedicated offshore Audit Support pod trained directly on CCH Axcess, QuickBooks, Canopy. Before any commitment, we run a 3-day free trial on a sample engagement so your partners can grade our workpaper indexing and turnaround firsthand.',
          '',
          'Would next Tuesday or Thursday inside your Austin business hours work for a 12-minute walkthrough of how our CCH Axcess and QuickBooks pods operate?',
          '',
          'Best regards,',
          'Arjun Mehta',
          'Partner Success · ADAS Globus Pro',
          '',
          '---',
          'If you\'d rather not hear from me, reply "no thanks" or unsubscribe in one click: https://go.adasglobuspro.com/u/preview-token',
          'ADAS Globus Pro · 30 N Gould St Ste R, Sheridan, WY 82801, USA',
        ].join('\n'),
        postalFooter: 'ADAS Globus Pro · 30 N Gould St Ste R, Sheridan, WY 82801, USA',
        spamRiskScore: 0,
        jitterMinutes: 7,
        verdict: 'INBOX_READY',
      });
    }
  };

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

      {/* Anti-Spam Deliverability, Warm-Up Ramp Schedule & CPA Email Tailoring Studio (PRD §4.12, §5.4, §5.5) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[16px]">
        <Panel className="p-[20px] space-y-[14px]" data-testid="warmup-deliverability-panel">
          <div className="flex flex-wrap items-center justify-between gap-[8px]">
            <div>
              <div className="text-eyebrow text-ink-3">
                PRD 5.4, 5.6, 8.3 · ANTI-SPAM &amp; WARM-UP RAMP
              </div>
              <h2 className="text-title text-ink m-0 mt-[2px]">
                Domain authentication &amp; gradual warm-up schedule
              </h2>
            </div>
            <StatusBadge tone="success">SPF · DKIM 2048 · DMARC p=quarantine</StatusBadge>
          </div>

          <div className="flex flex-wrap gap-[8px]">
            {([1, 2, 3, 4] as const).map((wk) => (
              <Button
                key={wk}
                size="sm"
                variant={warmupWeek === wk ? 'navy' : 'secondary'}
                onClick={() => setWarmupWeek(wk)}
              >
                Week {wk} ({wk === 1 ? '15' : wk === 2 ? '25' : wk === 3 ? '35' : '50'}/day)
              </Button>
            ))}
          </div>

          <div className="rounded-[10px] border border-line bg-bg-alt p-[14px] space-y-[8px]">
            <div className="flex flex-wrap items-center justify-between gap-[8px]">
              <span className="text-[13.5px] font-[600] text-ink">
                Active Ramp: Week {warmupWeek} ·{' '}
                {warmupWeek === 1
                  ? '15/day mailbox · 50/day subdomain (10/hr)'
                  : warmupWeek === 2
                    ? '25/day mailbox · 150/day subdomain (25/hr)'
                    : warmupWeek === 3
                      ? '35/day mailbox · 400/day subdomain (50/hr)'
                      : '50/day mailbox · 1,000/day subdomain (100/hr)'}
              </span>
              <StatusBadge tone="brand">Jitter: 2–20m random spacing</StatusBadge>
            </div>
            <ul className="text-[12.5px] text-ink-2 m-0 pl-[18px] space-y-[4px]">
              <li>
                <strong>Zero tracking pixels:</strong> Open tracking is strictly OFF; plain-text
                first so Gmail/M365 primary inbox filters never flag tracking beacons.
              </li>
              <li>
                <strong>Reputation isolation:</strong> 1:1 sequences send via employee M365 Graph (
                <code className="text-mono">adasglobuspro.com</code>); bulk campaigns use{' '}
                <code className="text-mono">mail.adasglobuspro.com</code>; links use{' '}
                <code className="text-mono">go.adasglobuspro.com</code>.
              </li>
              <li>
                <strong>Verification &amp; bounce guard:</strong> Excludes{' '}
                <code className="text-mono">unknown</code>/<code className="text-mono">risky</code>{' '}
                addresses and auto-pauses at &gt;3.0% bounce or &gt;0.1% complaint.
              </li>
            </ul>
          </div>
        </Panel>

        <Panel className="p-[20px] space-y-[14px]" data-testid="email-tailoring-panel">
          <div className="flex flex-wrap items-center justify-between gap-[8px]">
            <div>
              <div className="text-eyebrow text-ink-3">
                PRD 4.12, 5.5 · CPA FIRMOGRAPHIC EMAIL TAILORING
              </div>
              <h2 className="text-title text-ink m-0 mt-[2px]">
                Software-stack &amp; market-tailored plain-text preview
              </h2>
            </div>
            <StatusBadge tone="success">
              Spam Risk: {tailoredPreview.spamRiskScore}/100 ({tailoredPreview.verdict})
            </StatusBadge>
          </div>

          <div className="flex flex-wrap gap-[8px]">
            <Button
              size="sm"
              variant={tailorProfileId === 'cnt_jane' ? 'navy' : 'secondary'}
              onClick={() => void handleSelectTailorProfile('cnt_jane')}
            >
              US Partner · UltraTax CS (IL)
            </Button>
            <Button
              size="sm"
              variant={tailorProfileId === 'cnt_marcus' ? 'navy' : 'secondary'}
              onClick={() => void handleSelectTailorProfile('cnt_marcus')}
            >
              Canada Partner · CaseWare + TaxCycle (ON)
            </Button>
            <Button
              size="sm"
              variant={tailorProfileId === 'cnt_elena' ? 'navy' : 'secondary'}
              onClick={() => void handleSelectTailorProfile('cnt_elena')}
            >
              US Audit Director · CCH Axcess (TX)
            </Button>
          </div>

          <div className="rounded-[10px] border border-line bg-surface p-[14px] space-y-[8px]">
            <div className="flex flex-wrap items-center justify-between gap-[6px]">
              <span className="text-[12.5px] font-[600] text-ink">
                To: {tailoredPreview.recipientLabel}
              </span>
              <StatusBadge tone={tailoredPreview.market === 'CA' ? 'info' : 'brand'}>
                {tailoredPreview.market === 'CA'
                  ? 'CA · Edmonton, AB Footer'
                  : 'US · Sheridan, WY Footer'}
              </StatusBadge>
            </div>
            <div className="text-[13px] font-[600] text-ink border-b border-line pb-[6px]">
              Subject: {tailoredPreview.subject}
            </div>
            <pre className="text-[12px] text-ink-2 whitespace-pre-wrap font-sans m-0 leading-[1.5]">
              {tailoredPreview.bodyPlainText}
            </pre>
          </div>
        </Panel>
      </div>
    </div>
  );
}
