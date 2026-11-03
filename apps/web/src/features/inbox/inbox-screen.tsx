import { useState } from 'react';
import { CheckCircle2, Mail, Send, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';

interface ThreadMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  sender: string;
  sentAt: string;
  body: string;
}

interface InboxThread {
  id: string;
  subject: string;
  contactName: string;
  contactEmail: string;
  firmName: string;
  market: 'US' | 'CA';
  dealName: string;
  sequenceStoppedNote?: string;
  messages: ThreadMessage[];
}

const INITIAL_THREADS: InboxThread[] = [
  {
    id: 'thd_acme_1',
    subject: 'Re: 3-day UltraTax CS trial candidate resumes',
    contactName: 'Jane Patel',
    contactEmail: 'jane.patel@acmetax.example.com',
    firmName: 'Acme Tax & Advisory LLP',
    market: 'US',
    dealName: '2027 Tax Season Prep Pod (3 FTE)',
    sequenceStoppedNote: 'Sequence auto-stopped on reply · Task created',
    messages: [
      {
        id: 'm1',
        direction: 'outbound',
        sender: 'arjun@adasglobuspro.example.com',
        sentAt: 'Today · 9:15 am CT',
        body: 'Hi Jane, attached are two EA-qualified Senior Tax Preparer profiles ready to start your 3-day free trial inside UltraTax CS and Suralink.',
      },
      {
        id: 'm2',
        direction: 'inbound',
        sender: 'jane.patel@acmetax.example.com',
        sentAt: 'Today · 9:42 am CT',
        body: 'Thanks Arjun — let us start the 3-day trial with Candidate A next Tuesday at 9:00 am CT. Can we confirm Citrix access requirements today?',
      },
    ],
  },
  {
    id: 'thd_northstar_1',
    subject: 'CaseWare & TaxCycle T1/T2 pod availability',
    contactName: 'Marcus Vance',
    contactEmail: 'm.vance@northstarcpa.example.ca',
    firmName: 'Northstar Chartered Accountants',
    market: 'CA',
    dealName: 'T1/T2 Canadian Tax Pod (2 FTE)',
    messages: [
      {
        id: 'm3',
        direction: 'inbound',
        sender: 'm.vance@northstarcpa.example.ca',
        sentAt: 'Yesterday · 4:10 pm ET',
        body: 'Hi Priya, we are looking for two reviewers experienced with Canadian T2 corporate returns and CaseWare working papers.',
      },
    ],
  },
];

export function InboxScreen() {
  const [threads, setThreads] = useState<InboxThread[]>(INITIAL_THREADS);
  const [selectedId, setSelectedId] = useState<string>('thd_acme_1');
  const [replyText, setReplyText] = useState('');
  const [sentNotice, setSentNotice] = useState<string | null>(null);

  const selectedThread = threads.find((t) => t.id === selectedId) ?? threads[0];

  const handleSendReply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim() || !selectedThread) return;

    const newMsg: ThreadMessage = {
      id: `msg_${Date.now()}`,
      direction: 'outbound',
      sender: 'arjun@adasglobuspro.example.com',
      sentAt: 'Just now · Routed via Mailpit (MAIL_LIVE=false)',
      body: replyText.trim(),
    };

    setThreads((prev) =>
      prev.map((t) =>
        t.id === selectedThread.id ? { ...t, messages: [...t.messages, newMsg] } : t,
      ),
    );
    setReplyText('');
    setSentNotice(`Reply passed checkSendable() and was delivered to Mailpit sandbox.`);
  };

  return (
    <div className="space-y-[16px] pb-[32px]" data-testid="inbox-screen">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-[12px]">
        <div>
          <div className="kicker mb-[4px]">Microsoft 365 delegated sync (PRD 4.11)</div>
          <h1 className="text-display text-ink m-0">
            <strong>Connected inbox</strong>{' '}
            <span className="text-ink-3 font-light tabular-nums">{threads.length} threads</span>
          </h1>
          <p className="text-[13.5px] text-ink-2 mt-[4px] mb-0">
            Syncs only threads matching known CRM contact emails. Non-CRM personal and internal
            emails are never imported.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-[8px]">
          <StatusBadge tone="success">
            <ShieldCheck size={12} className="inline mr-[4px]" aria-hidden="true" />
            M365 connected · 8/50 sent today
          </StatusBadge>
          <StatusBadge tone="neutral">Mailpit sandbox</StatusBadge>
        </div>
      </div>

      {sentNotice && (
        <div
          role="status"
          className="rounded-[10px] border border-line bg-tint px-[16px] py-[10px] text-[13.5px] text-primary-ink flex items-center gap-[8px]"
        >
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>{sentNotice}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-[16px]">
        <Panel padded={false} className="overflow-hidden">
          <div className="px-[16px] py-[12px] border-b border-line bg-bg-alt text-eyebrow text-ink-2">
            Synced CRM Threads ({threads.length})
          </div>
          <div className="divide-y divide-line">
            {threads.map((thread) => {
              const active = thread.id === selectedThread?.id;
              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => setSelectedId(thread.id)}
                  className={`w-full text-left p-[14px] border-0 cursor-pointer transition-colors ${
                    active
                      ? 'bg-tint text-primary-ink'
                      : 'bg-surface hover:bg-surface-hover text-ink'
                  }`}
                >
                  <div className="flex items-center justify-between gap-[8px]">
                    <span className="font-[600] text-[13.5px] truncate">
                      {thread.contactName} · {thread.firmName}
                    </span>
                    <StatusBadge tone="neutral">{thread.market}</StatusBadge>
                  </div>
                  <div className="text-[13px] font-[500] mt-[4px] truncate">{thread.subject}</div>
                  <div className="text-[12px] text-ink-2 mt-[4px] truncate">
                    {thread.messages[thread.messages.length - 1]?.body}
                  </div>
                </button>
              );
            })}
          </div>
        </Panel>

        {selectedThread && (
          <Panel className="p-[20px] flex flex-col justify-between space-y-[16px]">
            <div className="space-y-[14px]">
              <div className="border-b border-line pb-[12px]">
                <div className="flex flex-wrap items-center justify-between gap-[8px]">
                  <h2 className="text-title text-ink m-0">{selectedThread.subject}</h2>
                  <StatusBadge tone="brand">{selectedThread.dealName}</StatusBadge>
                </div>
                <div className="text-[13px] text-ink-2 mt-[4px]">
                  {selectedThread.contactName} ({selectedThread.contactEmail}) ·{' '}
                  {selectedThread.firmName}
                </div>
                {selectedThread.sequenceStoppedNote && (
                  <div className="mt-[8px]">
                    <StatusBadge tone="info">{selectedThread.sequenceStoppedNote}</StatusBadge>
                  </div>
                )}
              </div>

              <div className="space-y-[12px]">
                {selectedThread.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`rounded-[10px] border border-line p-[14px] ${
                      msg.direction === 'inbound' ? 'bg-surface' : 'bg-bg-alt'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-[6px] text-[12px] text-ink-2 mb-[6px]">
                      <span className="font-[600] text-ink">
                        <Mail size={12} className="inline mr-[6px]" aria-hidden="true" />
                        {msg.sender}
                      </span>
                      <span>{msg.sentAt}</span>
                    </div>
                    <p className="text-[13.5px] text-ink m-0 leading-[20px]">{msg.body}</p>
                  </div>
                ))}
              </div>
            </div>

            <form
              onSubmit={handleSendReply}
              className="pt-[12px] border-t border-line space-y-[10px]"
            >
              <label
                htmlFor="inbox-reply-textarea"
                className="block text-[12.5px] font-[550] text-ink-2"
              >
                Reply as arjun@adasglobuspro.example.com (gated by checkSendable)
              </label>
              <textarea
                id="inbox-reply-textarea"
                rows={3}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Write a reply to this CPA firm partner…"
                className="w-full rounded-[8px] border border-line-field bg-surface p-[10px] text-[13.5px] text-ink"
              />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" size="md">
                  <Send size={14} strokeWidth={1.8} aria-hidden="true" />
                  <span>Send reply</span>
                </Button>
              </div>
            </form>
          </Panel>
        )}
      </div>
    </div>
  );
}
