import { useState } from 'react';
import { CheckCircle2, PauseCircle, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';

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

  const activeScenario = SCENARIOS[scenario];

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
    </div>
  );
}
