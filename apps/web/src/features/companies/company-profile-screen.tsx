import { useState, type KeyboardEvent } from 'react';
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Handshake,
  ListChecks,
  Mail,
  Pencil,
  Phone,
  Plus,
  StickyNote,
} from 'lucide-react';
import { formatMoney } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { SYNTHETIC_COMPANY_PROFILE, type SyntheticTimelineItem } from '@/lib/synthetic-data.js';
import { type ScreenDataState } from '@/features/leads/leads-screen.js';

export interface CompanyProfileScreenProps {
  onOpenDeals: () => void;
}

export function CompanyProfileScreen({ onOpenDeals }: CompanyProfileScreenProps) {
  const company = SYNTHETIC_COMPANY_PROFILE;
  const [activeTab, setActiveTab] = useState<
    'activity' | 'overview' | 'contacts' | 'deals' | 'notes' | 'history'
  >('activity');
  const [dataState, setDataState] = useState<ScreenDataState>('loaded');
  const [typeFilter, setTypeFilter] = useState<'all' | 'call' | 'email' | 'note'>('all');
  const [expandedEmailIds, setExpandedEmailIds] = useState<string[]>(['tl_02']);
  const [expandedLongNoteIds, setExpandedLongNoteIds] = useState<string[]>([]);
  const [mobileAboutOpen, setMobileAboutOpen] = useState(true);

  // Inline editable fields in the About right rail (DESIGN.md §6.9)
  const [sizeBand, setSizeBand] = useState(company.sizeBand);
  const [editingField, setEditingField] = useState<'sizeBand' | null>(null);
  const [draftSizeBand, setDraftSizeBand] = useState(company.sizeBand);
  const [savedField, setSavedField] = useState<'sizeBand' | null>(null);

  // Quick-log note composer
  const [quickLogType, setQuickLogType] = useState<'note' | 'call' | 'meeting' | 'email' | 'task'>(
    'note',
  );
  const [quickNoteText, setQuickNoteText] = useState('');
  const [timelineItems, setTimelineItems] = useState<SyntheticTimelineItem[]>(company.timeline);

  const commitInlineEdit = () => {
    const trimmed = draftSizeBand.trim();
    if (trimmed) {
      setSizeBand(trimmed);
      setSavedField('sizeBand');
      setTimeout(() => setSavedField(null), 2000);
    }
    setEditingField(null);
  };

  const handleInlineKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitInlineEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraftSizeBand(sizeBand);
      setEditingField(null);
    }
  };

  const handleQuickLogSubmit = () => {
    if (!quickNoteText.trim()) {
      return;
    }
    const newItem: SyntheticTimelineItem = {
      id: `tl_custom_${Date.now()}`,
      dayGroup: 'TODAY',
      type: quickLogType,
      isUserAction: true,
      actor: 'Ved Shah',
      summary: `logged a ${quickLogType}`,
      timeLabel: 'Just now',
      body: quickNoteText.trim(),
    };
    setTimelineItems((prev) => [newItem, ...prev]);
    setQuickNoteText('');
  };

  const filteredTimeline = timelineItems.filter((item) => {
    if (typeFilter === 'all') {
      return true;
    }
    return item.type === typeFilter;
  });

  const dayGroups = Array.from(new Set(filteredTimeline.map((item) => item.dayGroup)));

  const renderTimelineIcon = (type: SyntheticTimelineItem['type']) => {
    switch (type) {
      case 'call':
        return <Phone size={14} strokeWidth={1.6} aria-hidden="true" />;
      case 'meeting':
        return <Calendar size={14} strokeWidth={1.6} aria-hidden="true" />;
      case 'email':
        return <Mail size={14} strokeWidth={1.6} aria-hidden="true" />;
      case 'note':
        return <StickyNote size={14} strokeWidth={1.6} aria-hidden="true" />;
      case 'task':
        return <ListChecks size={14} strokeWidth={1.6} aria-hidden="true" />;
      default:
        return <Handshake size={14} strokeWidth={1.6} aria-hidden="true" />;
    }
  };

  const renderAboutRailContent = () => (
    <div className="space-y-[16px]">
      <Panel padded>
        <div className="kicker mb-[10px]">About this firm</div>
        <ul className="m-0 p-0 list-none border-t border-line">
          <li className="flex items-baseline justify-between gap-[12px] py-[10px] border-b border-line text-[13.5px]">
            <span className="font-semibold text-ink shrink-0">Domain</span>
            <span className="text-ink-2 text-right truncate">{company.domain}</span>
          </li>
          <li className="flex items-baseline justify-between gap-[12px] py-[10px] border-b border-line text-[13.5px]">
            <span className="font-semibold text-ink shrink-0">Firm type</span>
            <span className="text-ink-2 text-right">{company.firmType}</span>
          </li>
          <li className="flex items-center justify-between gap-[12px] py-[10px] border-b border-line text-[13.5px]">
            <span className="font-semibold text-ink shrink-0">Staff size</span>
            <div className="flex items-center gap-[6px] justify-end">
              {editingField === 'sizeBand' ? (
                <Input
                  value={draftSizeBand}
                  onChange={(e) => setDraftSizeBand(e.target.value)}
                  onBlur={commitInlineEdit}
                  onKeyDown={handleInlineKeyDown}
                  aria-label="Edit staff size"
                  className="h-[28px] w-[110px] text-[13px] px-[8px]"
                  autoFocus
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDraftSizeBand(sizeBand);
                    setEditingField('sizeBand');
                  }}
                  aria-label={`Edit staff size: ${sizeBand} staff`}
                  className="inline-flex items-center gap-[5px] text-ink-2 hover:text-ink cursor-pointer bg-transparent border-0 p-0 text-[13.5px]"
                >
                  <span>{sizeBand} staff</span>
                  {savedField === 'sizeBand' ? (
                    <Check
                      size={14}
                      strokeWidth={1.8}
                      className="text-success"
                      aria-label="Saved"
                    />
                  ) : (
                    <Pencil size={12} strokeWidth={1.6} className="text-ink-3" aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          </li>
          <li className="flex items-baseline justify-between gap-[12px] py-[10px] border-b border-line text-[13.5px]">
            <span className="font-semibold text-ink shrink-0">Location</span>
            <span className="text-ink-2 text-right">
              {company.city}, {company.region}
            </span>
          </li>
          <li className="flex items-baseline justify-between gap-[12px] py-[10px] border-b border-line text-[13.5px]">
            <span className="font-semibold text-ink shrink-0">Est. revenue</span>
            <span className="text-ink-2 text-right tabular-nums">
              {formatMoney({
                amountMinor: company.annualRevenueMinor,
                currency: company.revenueCurrency,
              })}
            </span>
          </li>
          <li className="flex items-baseline justify-between gap-[12px] py-[10px] border-b border-line text-[13.5px]">
            <span className="font-semibold text-ink shrink-0">Lead source</span>
            <span className="text-ink-2 text-right">{company.leadSource}</span>
          </li>
          <li className="flex flex-col gap-[6px] py-[10px] border-b border-line text-[13.5px]">
            <span className="font-semibold text-ink">Software stack</span>
            <div className="flex flex-wrap gap-[6px]">
              {company.software.map((sw) => (
                <span
                  key={sw}
                  className="inline-flex items-center h-[22px] px-[8px] rounded-pill bg-bg-alt border border-line text-[12px] font-medium text-ink-2"
                >
                  {sw}
                </span>
              ))}
            </div>
          </li>
          <li className="flex flex-col gap-[4px] pt-[10px] text-[13px]">
            <span className="font-semibold text-ink">Marketing basis</span>
            <span className="text-ink-2">{company.marketingBasis}</span>
          </li>
        </ul>
      </Panel>

      {/* Associated contacts */}
      <Panel title="Contacts (3)" padded>
        <ul className="m-0 p-0 list-none space-y-[12px]">
          {company.contacts.map((ct) => (
            <li key={ct.id} className="pb-[12px] border-b border-line last:border-b-0 last:pb-0">
              <div className="flex items-center justify-between gap-[8px]">
                <span className="font-semibold text-ink text-[14px]">{ct.name}</span>
                <StatusBadge tone={ct.verificationTone}>{ct.verificationStatus}</StatusBadge>
              </div>
              <div className="text-body-sm text-ink-2 mt-[2px]">{ct.title}</div>
              <div className="text-body-sm text-ink-3 mt-[2px] truncate">{ct.email}</div>
              <div className="text-body-sm text-ink-3 tabular-nums">{ct.phone}</div>
            </li>
          ))}
        </ul>
      </Panel>

      {/* Open deals */}
      <Panel
        title="Open deals (2)"
        actions={
          <Button variant="link" onClick={onOpenDeals}>
            Open board
          </Button>
        }
        padded
      >
        <ul className="m-0 p-0 list-none space-y-[12px]">
          {company.deals.map((deal) => (
            <li key={deal.id} className="pb-[12px] border-b border-line last:border-b-0 last:pb-0">
              <div className="flex items-start justify-between gap-[8px]">
                <span className="font-semibold text-ink text-[14px]">{deal.name}</span>
                <span className="font-semibold text-ink tabular-nums whitespace-nowrap">
                  {formatMoney(
                    { amountMinor: deal.monthlyValueMinor, currency: deal.currency },
                    { compact: true, perMonth: true },
                  )}
                </span>
              </div>
              <div className="flex items-center gap-[8px] mt-[6px]">
                <StatusBadge tone="brand">{deal.stage}</StatusBadge>
                <span className="text-body-sm text-ink-3">
                  {deal.fteCount} · {deal.engagementModel}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {/* Next task */}
      <Panel title="Next task" padded>
        <div className="space-y-[6px]">
          <div className="flex items-center justify-between gap-[8px]">
            <StatusBadge tone="warning">Due tomorrow</StatusBadge>
            <span className="text-body-sm text-ink-3">{company.nextTask.assignee}</span>
          </div>
          <p className="font-semibold text-ink text-[14px] m-0">{company.nextTask.title}</p>
          <p className="text-body-sm text-ink-2 m-0">{company.nextTask.dueLabel}</p>
        </div>
      </Panel>
    </div>
  );

  return (
    <div className="max-w-[1240px] space-y-[16px]" data-testid="company-profile-screen">
      {/* Record profile header (DESIGN.md §6.9) */}
      <div className="bg-surface border border-line rounded-[10px] p-[20px]">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-[16px]">
          <div>
            <div className="text-eyebrow text-ink-3 mb-[4px]">COMPANY</div>
            <div className="flex flex-wrap items-center gap-[10px]">
              <h1 className="text-title-lg text-ink m-0">{company.name}</h1>
              <StatusBadge tone={company.accountStatusTone}>{company.accountStatus}</StatusBadge>
              <MarketBadge market={company.market} />
            </div>
            <p className="text-body text-ink-2 mt-[6px] mb-0">
              {company.domain} · Owner:{' '}
              <strong className="font-semibold text-ink">{company.ownerName}</strong> ·{' '}
              <span>{company.localTimeLabel}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-[8px]">
            <Button
              variant="outline"
              onClick={() => {
                setActiveTab('activity');
                setQuickLogType('call');
              }}
            >
              <Phone size={16} strokeWidth={1.6} aria-hidden="true" />
              <span>Log call</span>
            </Button>
            <Button variant="primary" onClick={onOpenDeals}>
              <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
              <span>New deal</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Under 1100px, collapsible "About" panel stacks above the tabs (DESIGN.md §5) */}
      <div className="block xl:hidden">
        <div className="bg-surface border border-line rounded-[10px] overflow-hidden">
          <button
            type="button"
            onClick={() => setMobileAboutOpen((prev) => !prev)}
            aria-expanded={mobileAboutOpen}
            className="w-full flex items-center justify-between px-[20px] py-[14px] bg-surface text-title text-ink cursor-pointer border-0"
          >
            <span>About & associated records</span>
            {mobileAboutOpen ? (
              <ChevronUp size={18} strokeWidth={1.6} aria-hidden="true" />
            ) : (
              <ChevronDown size={18} strokeWidth={1.6} aria-hidden="true" />
            )}
          </button>
          {mobileAboutOpen && (
            <div className="p-[16px] pt-0 border-t border-line">{renderAboutRailContent()}</div>
          )}
        </div>
      </div>

      {/* Main column + 320px right rail on desktop >=1100px (DESIGN.md §5, §6.9) */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-[20px] items-start">
        <div className="space-y-[16px] min-w-0">
          {/* Underline tabs + state switcher */}
          <div className="flex flex-wrap items-center justify-between gap-[12px] border-b border-line">
            <div
              className="flex items-center gap-[20px] overflow-x-auto"
              role="tablist"
              aria-label="Company profile tabs"
            >
              {(
                [
                  ['activity', 'Activity'],
                  ['overview', 'Overview'],
                  ['contacts', 'Contacts (3)'],
                  ['deals', 'Deals (2)'],
                  ['notes', 'Notes (3)'],
                  ['history', 'History'],
                ] as const
              ).map(([tabKey, label]) => (
                <button
                  key={tabKey}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tabKey}
                  onClick={() => setActiveTab(tabKey)}
                  className="view-tab"
                >
                  {label}
                </button>
              ))}
            </div>

            <div
              className="inline-flex items-center rounded-pill border border-line bg-surface p-[2px] mb-[6px]"
              role="group"
              aria-label="Timeline state preview"
            >
              {(['loaded', 'empty', 'loading', 'error'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  aria-pressed={dataState === st}
                  onClick={() => setDataState(st)}
                  className={`h-[26px] px-[8px] rounded-pill text-[12px] font-medium capitalize cursor-pointer border-0 ${
                    dataState === st
                      ? 'bg-tint text-primary-ink font-semibold'
                      : 'bg-transparent text-ink-3'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'overview' && (
            <Panel title="Firmographic & compliance overview" padded>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-[14px] text-[13.5px]">
                <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt">
                  <div className="text-ink-3 text-[12px]">Normalized domain</div>
                  <div className="font-semibold text-ink mt-[2px]">{company.domain}</div>
                </div>
                <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt">
                  <div className="text-ink-3 text-[12px]">Staff size band</div>
                  <div className="font-semibold text-ink mt-[2px]">{sizeBand} staff</div>
                </div>
                <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt">
                  <div className="text-ink-3 text-[12px]">Tax &amp; accounting stack</div>
                  <div className="font-semibold text-ink mt-[2px]">
                    {company.software.join(' · ')}
                  </div>
                </div>
                <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt">
                  <div className="text-ink-3 text-[12px]">CAN-SPAM / CASL marketing basis</div>
                  <div className="font-semibold text-ink mt-[2px]">{company.marketingBasis}</div>
                </div>
              </div>
            </Panel>
          )}

          {activeTab === 'contacts' && (
            <Panel title="Associated contacts (3)" padded>
              <div className="divide-y divide-line">
                {company.contacts.map((ct) => (
                  <div
                    key={ct.id}
                    className="py-[12px] first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-[8px]"
                  >
                    <div>
                      <div className="font-semibold text-ink text-[14px]">{ct.name}</div>
                      <div className="text-body-sm text-ink-2">
                        {ct.title} · {ct.email} · {ct.phone}
                      </div>
                    </div>
                    <StatusBadge tone={ct.verificationTone}>{ct.verificationStatus}</StatusBadge>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {activeTab === 'deals' && (
            <Panel title="Firm recurring deals (2)" padded>
              <div className="divide-y divide-line">
                {company.deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="py-[12px] first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-[8px]"
                  >
                    <div>
                      <div className="font-semibold text-ink text-[14px]">{deal.name}</div>
                      <div className="text-body-sm text-ink-2">
                        {deal.fteCount} · {deal.engagementModel}
                      </div>
                    </div>
                    <div className="flex items-center gap-[8px]">
                      <StatusBadge tone="brand">{deal.stage}</StatusBadge>
                      <span className="font-semibold text-ink tabular-nums">
                        {formatMoney(
                          { amountMinor: deal.monthlyValueMinor, currency: deal.currency },
                          { perMonth: true },
                        )}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {activeTab === 'notes' && (
            <Panel title="Pinned partner notes (3)" padded>
              <div className="space-y-[10px] text-[13.5px]">
                <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt">
                  <div className="font-semibold text-ink">
                    1040 &amp; 1120S UltraTax CS workflow requirements
                  </div>
                  <p className="text-ink-2 mt-[4px] mb-0">
                    Partner Jane Patel requires all workpapers indexed in Suralink with two-level
                    preparer sign-off before partner review.
                  </p>
                </div>
                <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt">
                  <div className="font-semibold text-ink">Citrix VDI onboarding window</div>
                  <p className="text-ink-2 mt-[4px] mb-0">
                    IT administrator Grant Miller provisions Citrix credentials 24h before the 3-day
                    free trial start date.
                  </p>
                </div>
                <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt">
                  <div className="font-semibold text-ink">Busy season expansion target</div>
                  <p className="text-ink-2 mt-[4px] mb-0">
                    Potential expansion from 3 FTE to 6 FTE in January if trial accuracy exceeds
                    98%.
                  </p>
                </div>
              </div>
            </Panel>
          )}

          {activeTab === 'history' && (
            <Panel title="Field-level record history (PRD 7.3)" padded>
              <div className="divide-y divide-line text-[13px]">
                <div className="py-[10px] first:pt-0 flex items-center justify-between gap-[8px]">
                  <span>
                    <strong className="font-semibold text-ink">Ved Shah</strong> updated{' '}
                    <code className="text-mono">size_band</code>: <code>11-20</code> →{' '}
                    <code>{sizeBand}</code>
                  </span>
                  <span className="text-ink-3 tabular-nums">Today · 2:10 pm</span>
                </div>
                <div className="py-[10px] flex items-center justify-between gap-[8px]">
                  <span>
                    <strong className="font-semibold text-ink">Arjun Mehta</strong> updated{' '}
                    <code className="text-mono">account_status</code>: <code>Lead</code> →{' '}
                    <code>Prospect</code>
                  </span>
                  <span className="text-ink-3 tabular-nums">Yesterday · 11:15 am</span>
                </div>
                <div className="py-[10px] last:pb-0 flex items-center justify-between gap-[8px]">
                  <span>
                    <strong className="font-semibold text-ink">System (Intake)</strong> recorded{' '}
                    <code className="text-mono">consent_status</code>: <code>implied_inquiry</code>
                  </span>
                  <span className="text-ink-3 tabular-nums">2 Nov 2026</span>
                </div>
              </div>
            </Panel>
          )}

          {/* Quick-log bar (DESIGN.md §6.10: Note · Call · Meeting · Email · Task) */}
          <Panel padded>
            <div className="flex flex-wrap items-center justify-between gap-[8px] mb-[12px]">
              <div
                className="flex flex-wrap items-center gap-[4px]"
                role="group"
                aria-label="Quick log activity type"
              >
                {(
                  [
                    ['note', 'Note', StickyNote],
                    ['call', 'Call', Phone],
                    ['meeting', 'Meeting', Calendar],
                    ['email', 'Email', Mail],
                    ['task', 'Task', ListChecks],
                  ] as const
                ).map(([key, label, IconComponent]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={quickLogType === key}
                    onClick={() => setQuickLogType(key)}
                    className={`inline-flex items-center gap-[6px] h-[32px] px-[12px] rounded-pill text-[13px] font-semibold cursor-pointer border transition-colors duration-120 ${
                      quickLogType === key
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-surface text-ink-2 border-line hover:bg-bg-alt'
                    }`}
                  >
                    <IconComponent size={14} strokeWidth={1.6} aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              <div
                className="flex items-center gap-[6px]"
                role="group"
                aria-label="Filter timeline by type"
              >
                {(['all', 'call', 'email', 'note'] as const).map((filterKey) => (
                  <button
                    key={filterKey}
                    type="button"
                    aria-pressed={typeFilter === filterKey}
                    onClick={() => setTypeFilter(filterKey)}
                    className={`h-[26px] px-[9px] rounded-pill text-[12px] font-medium capitalize cursor-pointer border-0 ${
                      typeFilter === filterKey
                        ? 'bg-tint text-primary-ink font-semibold'
                        : 'bg-transparent text-ink-3 hover:text-ink'
                    }`}
                  >
                    {filterKey}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-[8px]">
              <Input
                value={quickNoteText}
                onChange={(e) => setQuickNoteText(e.target.value)}
                placeholder={`Log a ${quickLogType} on ${company.name}…`}
                aria-label={`Log a ${quickLogType}`}
              />
              <Button variant="primary" onClick={handleQuickLogSubmit}>
                Save {quickLogType}
              </Button>
            </div>
          </Panel>

          {/* Consent callout (DESIGN.md §6.6) */}
          <Callout tone="brand">
            <strong>Trial stage active:</strong> 3-day free trial workpapers are scheduled for
            review tomorrow at 9:30 am Chicago (9:00 pm IST).
          </Callout>

          {/* Activity timeline panel (DESIGN.md §6.10) */}
          <Panel padded>
            {dataState === 'loading' && <LoadingState rows={5} />}

            {dataState === 'error' && (
              <ErrorState
                message="Could not load the activity timeline for Acme Tax & Advisory LLP."
                requestId="req_01jc9x9b7q2w8n"
                onRetry={() => setDataState('loaded')}
              />
            )}

            {dataState === 'empty' && (
              <EmptyState
                title="No activity logged yet"
                description="Calls, emails, meetings, stage changes and pinned notes appear here in chronological order."
                actionLabel="Log first call"
                onAction={() => setDataState('loaded')}
              />
            )}

            {dataState === 'loaded' && (
              <div className="space-y-[24px]" data-testid="activity-timeline">
                {dayGroups.map((day) => {
                  const items = filteredTimeline.filter((it) => it.dayGroup === day);
                  return (
                    <div key={day}>
                      <div className="text-eyebrow text-ink-3 mb-[12px]">{day}</div>
                      <ol className="relative m-0 p-0 list-none border-l border-line ml-[8px] space-y-[18px]">
                        {items.map((item) => {
                          const isEmailExpanded = expandedEmailIds.includes(item.id);
                          const isLongNote = (item.body?.split('\n').length ?? 0) > 4;
                          const isNoteExpanded = expandedLongNoteIds.includes(item.id);

                          return (
                            <li key={item.id} className="relative pl-[20px]">
                              {/* 9px dot on the 1px vertical rail (DESIGN.md §6.10) */}
                              <span
                                className={`absolute -left-[5px] top-[5px] h-[9px] w-[9px] rounded-pill ${
                                  item.isUserAction ? 'timeline-dot-user' : 'bg-ink-3'
                                }`}
                                aria-hidden="true"
                              />

                              <div className="flex items-baseline justify-between gap-[12px]">
                                <div className="flex items-center gap-[8px] text-[14px] text-ink">
                                  <span className="text-primary-ink">
                                    {renderTimelineIcon(item.type)}
                                  </span>
                                  <span>
                                    <strong className="font-semibold text-ink">{item.actor}</strong>{' '}
                                    <span className="text-ink-2">{item.summary}</span>
                                  </span>
                                </div>
                                <span className="text-body-sm text-ink-3 whitespace-nowrap shrink-0">
                                  {item.timeLabel}
                                </span>
                              </div>

                              {/* Inline expandable email entry */}
                              {item.type === 'email' && item.emailMeta && (
                                <div className="mt-[8px] rounded-[8px] border border-line bg-bg p-[12px]">
                                  <div className="flex items-center justify-between gap-[8px]">
                                    <div className="text-body-sm text-ink-2">
                                      <strong className="font-semibold text-ink">
                                        {item.emailMeta.subject}
                                      </strong>
                                      <div className="text-ink-3">
                                        From {item.emailMeta.from} to {item.emailMeta.to}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedEmailIds((prev) =>
                                          prev.includes(item.id)
                                            ? prev.filter((id) => id !== item.id)
                                            : [...prev, item.id],
                                        )
                                      }
                                      className="text-[12.5px] font-semibold text-primary-ink hover:underline cursor-pointer bg-transparent border-0"
                                    >
                                      {isEmailExpanded ? 'Hide message' : 'Show message'}
                                    </button>
                                  </div>
                                  {isEmailExpanded && item.body && (
                                    <pre className="mt-[10px] pt-[10px] border-t border-line font-sans text-[13.5px] leading-[20px] text-ink-2 whitespace-pre-wrap m-0">
                                      {item.body}
                                    </pre>
                                  )}
                                </div>
                              )}

                              {/* Call / Note body (collapses > 4 lines per DESIGN.md §6.10) */}
                              {item.type !== 'email' && item.body && (
                                <div className="mt-[6px] text-[14px] text-ink-2">
                                  <p
                                    className={`m-0 whitespace-pre-line ${
                                      isLongNote && !isNoteExpanded ? 'line-clamp-4' : ''
                                    }`}
                                  >
                                    {item.body}
                                  </p>
                                  {isLongNote && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedLongNoteIds((prev) =>
                                          prev.includes(item.id)
                                            ? prev.filter((id) => id !== item.id)
                                            : [...prev, item.id],
                                        )
                                      }
                                      className="mt-[4px] text-[12.5px] font-semibold text-primary-ink hover:underline cursor-pointer bg-transparent border-0 p-0"
                                    >
                                      {isNoteExpanded ? 'Show less' : 'Read full note'}
                                    </button>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        {/* Desktop 320px right rail (DESIGN.md §5, §6.9) */}
        <aside className="hidden xl:block w-[320px]" aria-label="About company">
          {renderAboutRailContent()}
        </aside>
      </div>
    </div>
  );
}
