import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Plus, Trash2, XCircle } from 'lucide-react';
import {
  formatDateTime,
  formatNumber,
  renderCampaignBlocks,
  type CampaignBlock,
  type Market,
  type StatusTone,
} from '@adas/shared';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Drawer } from '@/components/ui/drawer.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import {
  api,
  type CampaignSummaryRow,
  type MarketingListRow,
  type SenderIdentityRow,
} from '@/lib/api.js';
import { PageHeader, errorMessage } from '@/features/shared/live-kit.js';
import { can, useMe, useUrlState } from '@/features/shared/list-kit.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { FormRow } from '@/features/settings/settings-kit.js';

const CAMPAIGN_STATUS_TONE: Record<string, StatusTone> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'info',
  scheduled: 'brand',
  sending: 'brand',
  completed: 'success',
  sent: 'success',
  paused: 'warning',
  paused_deliverability: 'danger',
  cancelled: 'neutral',
};

const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  scheduled: 'Scheduled',
  sending: 'Sending',
  completed: 'Completed',
  sent: 'Completed',
  paused: 'Paused',
  paused_deliverability: 'Auto-paused (health)',
  cancelled: 'Cancelled',
};

const URL_DEFAULTS = {
  tab: 'campaigns',
  status: 'all',
  campaign: '',
  list: '',
} as const;

function makeDefaultBlocks(): CampaignBlock[] {
  return [
    {
      id: 'blk_heading_1',
      type: 'heading',
      level: 'h1',
      text: 'Busy Season Tax & Accounting Pod Briefing for {{company.name|your firm}}',
    },
    {
      id: 'blk_text_1',
      type: 'text',
      text: 'Hi {{contact.first_name|there}},\n\nSee how CPA practices onboard dedicated Senior Tax Preparers and Bookkeepers through a 3-day no-cost trial.',
    },
    {
      id: 'blk_button_1',
      type: 'button',
      label: 'Explore 3-day trial scope',
      url: 'https://adasglobuspro.example.com/trial',
    },
  ];
}

function CampaignEditorDrawer({
  open,
  onClose,
  lists,
  senders,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  lists: MarketingListRow[];
  senders: SenderIdentityRow[];
  initial?: CampaignSummaryRow | null;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState(initial?.name ?? '');
  const [subject, setSubject] = useState(
    initial?.subject ?? 'Dedicated tax & accounting pods for {{company.name|your firm}}',
  );
  const [market, setMarket] = useState<Market>(initial?.market ?? 'US');
  const [listId, setListId] = useState(initial?.list_id ?? lists[0]?.id ?? '');
  const [senderId, setSenderId] = useState(initial?.sender_identity_id ?? senders[0]?.id ?? '');
  const [throttle, setThrottle] = useState(String(initial?.throttle_per_hour ?? 200));
  const [respectTz, setRespectTz] = useState(initial?.respect_recipient_timezone ?? true);
  const [excludeUnverified, setExcludeUnverified] = useState(initial?.exclude_unverified ?? true);
  const [blocks, setBlocks] = useState<CampaignBlock[]>(
    initial?.blocks_json && initial.blocks_json.length > 0
      ? initial.blocks_json
      : makeDefaultBlocks(),
  );

  const preview = useMemo(() => {
    try {
      return renderCampaignBlocks(blocks, {
        'contact.first_name': 'Jane',
        'company.name': 'Sample CPA LLP',
      });
    } catch {
      return { html: '', text: '' };
    }
  }, [blocks]);

  const addBlock = (type: CampaignBlock['type']) => {
    const id = `blk_${type}_${Date.now()}`;
    setBlocks((prev) => {
      if (type === 'heading') {
        return [...prev, { id, type: 'heading', level: 'h2', text: 'Section heading' }];
      }
      if (type === 'text') {
        return [...prev, { id, type: 'text', text: 'Add paragraph copy here.' }];
      }
      if (type === 'button') {
        return [
          ...prev,
          {
            id,
            type: 'button',
            label: 'Learn more',
            url: 'https://adasglobuspro.example.com/overview',
          },
        ];
      }
      if (type === 'image') {
        return [
          ...prev,
          {
            id,
            type: 'image',
            alt: 'Team workflow',
            url: 'https://adasglobuspro.example.com/banner.png',
          },
        ];
      }
      return [...prev, { id, type: 'divider' }];
    });
  };

  const updateBlock = (index: number, next: CampaignBlock) => {
    setBlocks((prev) => prev.map((b, i) => (i === index ? next : b)));
  };

  const removeBlock = (index: number) => {
    if (blocks.length <= 1) return;
    setBlocks((prev) => prev.filter((_, i) => i !== index));
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const effectiveListId = listId || lists[0]?.id || null;
      const effectiveSenderId = senderId || senders[0]?.id || null;
      if (initial) {
        return api.updateCampaign(initial.id, {
          version: initial.version,
          name: name.trim(),
          subject: subject.trim(),
          market,
          listId: effectiveListId,
          senderIdentityId: effectiveSenderId,
          throttlePerHour: Math.max(1, Number(throttle) || 200),
          respectRecipientTimezone: respectTz,
          excludeUnverified,
          blocks,
        });
      }
      return api.createCampaign({
        name: name.trim(),
        subject: subject.trim(),
        market,
        listId: effectiveListId,
        senderIdentityId: effectiveSenderId,
        throttlePerHour: Math.max(1, Number(throttle) || 200),
        respectRecipientTimezone: respectTz,
        excludeUnverified,
        initialStatus: 'draft',
        blocks,
      });
    },
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
        queryClient.invalidateQueries({ queryKey: ['campaign', saved.id] }),
      ]);
      toast(
        initial
          ? saved.status === 'draft' && initial.status !== 'draft'
            ? 'Campaign updated and returned to Draft for re-approval.'
            : 'Campaign updated.'
          : 'Campaign draft saved.',
      );
      if (!initial) {
        setName('');
      }
      onClose();
    },
  });

  return (
    <Drawer
      open={open}
      width={600}
      title={initial ? 'Edit campaign' : 'New campaign'}
      description={
        initial && (initial.status === 'approved' || initial.status === 'scheduled')
          ? 'Editing an approved campaign returns it to Draft so a second reviewer can re-approve it.'
          : 'Build a responsive campaign from blocks with automatic plain-text fallback and compliance footer.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !subject.trim() || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? 'Saving…' : initial ? 'Save changes' : 'Save draft'}
          </Button>
        </>
      }
    >
      <div className="space-y-[14px]">
        <FormRow id="cmpg-name-input" label="Campaign name">
          <Input
            id="cmpg-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q1 Busy Season Tax Pod Briefing"
          />
        </FormRow>
        <FormRow id="cmpg-subject-input" label="Email subject">
          <Input
            id="cmpg-subject-input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </FormRow>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-[12px]">
          <FormRow id="cmpg-market-select" label="Market">
            <Select
              id="cmpg-market-select"
              value={market}
              onChange={(e) => setMarket(e.target.value as Market)}
            >
              <option value="US">United States (US)</option>
              <option value="CA">Canada (CA)</option>
              <option value="OTHER">Other markets</option>
            </Select>
          </FormRow>
          <FormRow id="cmpg-list-select" label="Audience segment or list">
            <Select
              id="cmpg-list-select"
              value={listId || lists[0]?.id || ''}
              onChange={(e) => setListId(e.target.value)}
            >
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.list_type === 'dynamic' ? 'Segment' : 'List'} · {l.member_count})
                </option>
              ))}
            </Select>
          </FormRow>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-[12px]">
          <FormRow id="cmpg-sender-select" label="Verified sender identity">
            <Select
              id="cmpg-sender-select"
              value={senderId || senders[0]?.id || ''}
              onChange={(e) => setSenderId(e.target.value)}
            >
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.from_name} ({s.from_email})
                </option>
              ))}
            </Select>
          </FormRow>
          <FormRow id="cmpg-throttle-input" label="Hourly send throttle">
            <Input
              id="cmpg-throttle-input"
              type="number"
              min={1}
              max={10000}
              value={throttle}
              onChange={(e) => setThrottle(e.target.value)}
            />
          </FormRow>
        </div>

        <div className="space-y-[6px]">
          <label className="flex items-center gap-[8px] text-[13px] text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={respectTz}
              onChange={(e) => setRespectTz(e.target.checked)}
            />
            <span>Deliver inside recipient local business hours</span>
          </label>
          <label className="flex items-center gap-[8px] text-[13px] text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={excludeUnverified}
              onChange={(e) => setExcludeUnverified(e.target.checked)}
            />
            <span>Exclude contacts with unknown or risky email verification</span>
          </label>
        </div>

        <div className="pt-[10px] border-t border-line space-y-[10px]">
          <div className="flex flex-wrap items-center justify-between gap-[8px]">
            <h3 className="m-0 text-[14px] font-semibold text-ink">
              Content blocks ({blocks.length})
            </h3>
            <div className="flex flex-wrap gap-[6px]">
              {(['heading', 'text', 'button', 'image', 'divider'] as const).map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => addBlock(kind)}
                >
                  <Plus size={13} aria-hidden="true" /> {kind}
                </Button>
              ))}
            </div>
          </div>

          {blocks.map((blk, idx) => (
            <div
              key={blk.id}
              className="border border-line rounded-[8px] p-[12px] bg-bg-alt space-y-[8px]"
            >
              <div className="flex items-center justify-between gap-[8px]">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">
                  {blk.type}
                </span>
                {blocks.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove ${blk.type} block`}
                    onClick={() => removeBlock(idx)}
                    className="bg-transparent border-0 text-ink-3 hover:text-danger cursor-pointer p-[4px]"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </div>

              {blk.type === 'heading' && (
                <FormRow id={`blk-h-${idx}`} label="Heading text">
                  <Input
                    id={`blk-h-${idx}`}
                    value={blk.text}
                    onChange={(e) => updateBlock(idx, { ...blk, text: e.target.value })}
                  />
                </FormRow>
              )}
              {blk.type === 'text' && (
                <FormRow id={`blk-t-${idx}`} label="Paragraph text">
                  <Textarea
                    id={`blk-t-${idx}`}
                    rows={3}
                    value={blk.text}
                    onChange={(e) => updateBlock(idx, { ...blk, text: e.target.value })}
                  />
                </FormRow>
              )}
              {blk.type === 'button' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-[8px]">
                  <FormRow id={`blk-bl-${idx}`} label="Button label">
                    <Input
                      id={`blk-bl-${idx}`}
                      value={blk.label}
                      onChange={(e) => updateBlock(idx, { ...blk, label: e.target.value })}
                    />
                  </FormRow>
                  <FormRow id={`blk-bu-${idx}`} label="Destination URL (https://)">
                    <Input
                      id={`blk-bu-${idx}`}
                      value={blk.url}
                      onChange={(e) => updateBlock(idx, { ...blk, url: e.target.value })}
                    />
                  </FormRow>
                </div>
              )}
              {blk.type === 'image' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-[8px]">
                  <FormRow id={`blk-ia-${idx}`} label="Alt description">
                    <Input
                      id={`blk-ia-${idx}`}
                      value={blk.alt}
                      onChange={(e) => updateBlock(idx, { ...blk, alt: e.target.value })}
                    />
                  </FormRow>
                  <FormRow id={`blk-iu-${idx}`} label="Image URL (https://)">
                    <Input
                      id={`blk-iu-${idx}`}
                      value={blk.url}
                      onChange={(e) => updateBlock(idx, { ...blk, url: e.target.value })}
                    />
                  </FormRow>
                </div>
              )}
              {blk.type === 'divider' && (
                <div className="text-[12px] text-ink-3">Horizontal rule divider</div>
              )}
            </div>
          ))}
        </div>

        <div className="border border-line rounded-[8px] p-[12px] bg-surface space-y-[6px]">
          <div className="text-[12px] font-semibold text-ink-3">Plain-text part preview</div>
          <pre className="m-0 text-[12px] text-ink-2 whitespace-pre-wrap font-sans">
            {preview.text || 'Add blocks above to preview plain-text copy.'}
          </pre>
        </div>

        {saveMutation.isError && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {errorMessage(saveMutation.error)}
          </p>
        )}
      </div>
    </Drawer>
  );
}

export function CampaignsScreen({ onOpenContact }: { onOpenContact: (id: string) => void }) {
  const me = useMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const timeZone = viewerTimeZone();
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);

  const activeTab =
    urlState.tab === 'segments' ? 'segments' : urlState.tab === 'senders' ? 'senders' : 'campaigns';
  const selectedCampaignId = urlState.campaign || null;
  const selectedListId = urlState.list || null;

  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<CampaignSummaryRow | null>(null);
  const [testEmail, setTestEmail] = useState('');

  const [creatingList, setCreatingList] = useState(false);
  const [listName, setListName] = useState('');
  const [listDesc, setListDesc] = useState('');
  const [listType, setListType] = useState<'dynamic' | 'static'>('dynamic');
  const [listMarket, setListMarket] = useState<Market>('US');
  const [listVerifiedOnly, setListVerifiedOnly] = useState(true);
  const [listSoftware, setListSoftware] = useState('');

  const [creatingSender, setCreatingSender] = useState(false);
  const [senderFromName, setSenderFromName] = useState('');
  const [senderFromEmail, setSenderFromEmail] = useState('');
  const [senderWarmupCap, setSenderWarmupCap] = useState('250');

  const canWrite = can(me, 'campaigns.write');
  const canApprove = can(me, 'campaigns.approve');
  const canManageSettings = can(me, 'settings.manage') || canApprove;
  const isAdmin = me?.role === 'Admin';

  const healthQuery = useQuery({
    queryKey: ['healthz'],
    queryFn: api.healthStatus,
  });

  const campaignsQuery = useQuery({
    queryKey: ['campaigns'],
    queryFn: api.listCampaigns,
  });

  const listsQuery = useQuery({
    queryKey: ['marketing-lists'],
    queryFn: api.listMarketingLists,
  });

  const sendersQuery = useQuery({
    queryKey: ['sender-identities'],
    queryFn: api.listSenderIdentities,
  });

  const campaignDetailQuery = useQuery({
    queryKey: ['campaign', selectedCampaignId],
    queryFn: () => api.getCampaign(selectedCampaignId as string),
    enabled: Boolean(selectedCampaignId),
  });

  const listDetailQuery = useQuery({
    queryKey: ['marketing-list', selectedListId],
    queryFn: () => api.getMarketingList(selectedListId as string),
    enabled: Boolean(selectedListId),
  });

  const refreshCampaign = async (id: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
      queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
    ]);
  };

  const submitMutation = useMutation({
    mutationFn: (id: string) => api.submitCampaign(id),
    onSuccess: async (c) => {
      await refreshCampaign(c.id);
      toast('Campaign submitted for second-person approval.');
    },
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.approveCampaign(id),
    onSuccess: async (c) => {
      await refreshCampaign(c.id);
      toast('Campaign approved.');
    },
  });

  const scheduleNowMutation = useMutation({
    mutationFn: (id: string) => api.scheduleCampaign(id, { sendNow: true }),
    onSuccess: async (c) => {
      await refreshCampaign(c.id);
      toast('Campaign audience snapshotted and queued for throttled delivery.');
    },
  });

  const pauseMutation = useMutation({
    mutationFn: (id: string) => api.pauseCampaign(id),
    onSuccess: async (c) => {
      await refreshCampaign(c.id);
      toast('Campaign paused.');
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelCampaign(id),
    onSuccess: async (c) => {
      await refreshCampaign(c.id);
      toast('Campaign cancelled.');
    },
  });

  const testSendMutation = useMutation({
    mutationFn: ({ id, email }: { id: string; email: string }) =>
      api.testSendCampaign(id, { recipientEmail: email }),
    onSuccess: () => {
      toast('Test email sent.');
    },
  });

  const createListMutation = useMutation({
    mutationFn: () => {
      const conditions: Array<Record<string, unknown>> = [
        { field: 'company.market', op: 'eq', value: listMarket },
      ];
      if (listVerifiedOnly) {
        conditions.push({ field: 'email.verificationStatus', op: 'eq', value: 'valid' });
      }
      if (listSoftware.trim()) {
        conditions.push({
          field: 'company.software',
          op: 'hasAny',
          value: listSoftware
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        });
      }
      return api.createMarketingList({
        name: listName.trim(),
        description: listDesc.trim() || null,
        listType,
        market: listMarket,
        filterJson: listType === 'dynamic' ? { and: conditions } : {},
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['marketing-lists'] });
      setCreatingList(false);
      setListName('');
      setListDesc('');
      setListSoftware('');
      toast(listType === 'dynamic' ? 'Dynamic segment created.' : 'Static list created.');
    },
  });

  const createSenderMutation = useMutation({
    mutationFn: () =>
      api.createSenderIdentity({
        fromName: senderFromName.trim(),
        fromEmail: senderFromEmail.trim(),
        dailyWarmupCap: Math.max(10, Number(senderWarmupCap) || 250),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sender-identities'] });
      setCreatingSender(false);
      setSenderFromName('');
      setSenderFromEmail('');
      toast('Sender identity added.');
    },
  });

  const verifySenderMutation = useMutation({
    mutationFn: (sender: SenderIdentityRow) => {
      const next = !(sender.spf_verified && sender.dkim_verified && sender.dmarc_verified);
      return api.updateSenderIdentity(sender.id, {
        spfVerified: next,
        dkimVerified: next,
        dmarcVerified: next,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sender-identities'] });
      toast('Updated DNS verification status.');
    },
  });

  const filteredCampaigns = useMemo(() => {
    const all = campaignsQuery.data ?? [];
    if (urlState.status === 'all') return all;
    return all.filter((c) => c.status === urlState.status);
  }, [campaignsQuery.data, urlState.status]);

  return (
    <div className="space-y-[16px] min-w-0" data-testid="campaigns-screen">
      <PageHeader
        kicker="GROW"
        title="Campaigns"
        count={campaignsQuery.data?.length}
        actions={
          <div className="flex flex-wrap gap-[8px]">
            {activeTab === 'campaigns' && canWrite && (
              <Button variant="primary" onClick={() => setCreatingCampaign(true)}>
                New campaign
              </Button>
            )}
            {activeTab === 'segments' && canWrite && (
              <Button variant="primary" onClick={() => setCreatingList(true)}>
                New segment or list
              </Button>
            )}
            {activeTab === 'senders' && canManageSettings && (
              <Button variant="primary" onClick={() => setCreatingSender(true)}>
                Add sender identity
              </Button>
            )}
          </div>
        }
      />

      {healthQuery.data && !healthQuery.data.mailLive && (
        <Callout tone="brand">
          Test delivery mode is active: campaign sends go to the local mail catcher rather than
          external inboxes.
        </Callout>
      )}

      {!selectedCampaignId && !selectedListId && (
        <div
          role="tablist"
          aria-label="Campaigns sections"
          className="flex flex-wrap gap-[6px] border-b border-line pb-[10px]"
        >
          {[
            ['campaigns', `Campaigns (${campaignsQuery.data?.length ?? 0})`],
            ['segments', `Segments & lists (${listsQuery.data?.length ?? 0})`],
            ['senders', `Sender identities (${sendersQuery.data?.length ?? 0})`],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => setUrlState({ tab: id, campaign: '', list: '' })}
              className={`h-[34px] px-[14px] rounded-pill text-[13px] font-medium border cursor-pointer ${
                activeTab === id
                  ? 'bg-navy text-white border-navy'
                  : 'bg-surface text-ink-2 border-line hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {selectedCampaignId ? (
        campaignDetailQuery.isPending ? (
          <LoadingState />
        ) : campaignDetailQuery.isError ? (
          <ErrorState
            message={errorMessage(campaignDetailQuery.error)}
            onRetry={() => void campaignDetailQuery.refetch()}
          />
        ) : (
          <div className="space-y-[16px] min-w-0" data-testid="campaign-detail-view">
            {(() => {
              const { campaign, preflight, recipients, clicksByLink } = campaignDetailQuery.data;
              const isCreator = campaign.owner_user_id === me?.id;
              const canApproveThis = canApprove && (!isCreator || isAdmin);
              const checklistItems: Array<{ ok: boolean; label: string }> = [
                {
                  ok: preflight.senderVerified && preflight.sendingSubdomainOk,
                  label: `Verified dedicated sending subdomain (${preflight.senderFromEmail ?? 'none'})`,
                },
                {
                  ok: preflight.unsubscribeFooterAutomatic,
                  label: 'One-click unsubscribe header and visible opt-out link included',
                },
                {
                  ok: preflight.postalAddressConfigured,
                  label: `Postal address: ${preflight.postalAddress}`,
                },
                {
                  ok: preflight.eligibleCount > 0,
                  label: `${formatNumber(preflight.eligibleCount)} eligible of ${formatNumber(preflight.totalAudienceCount)} contacts (${formatNumber(preflight.suppressedCount)} suppressed)`,
                },
              ];

              return (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-[10px]">
                    <button
                      type="button"
                      onClick={() => setUrlState({ campaign: '' })}
                      className="inline-flex items-center gap-[6px] bg-transparent border-0 p-0 text-[13px] font-medium text-ink-2 hover:text-ink cursor-pointer"
                    >
                      <ArrowLeft size={15} aria-hidden="true" /> All campaigns
                    </button>

                    <div className="flex flex-wrap gap-[8px]">
                      {canWrite &&
                        campaign.status !== 'sending' &&
                        campaign.status !== 'completed' &&
                        campaign.status !== 'sent' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setEditingCampaign(campaign)}
                          >
                            Edit campaign
                          </Button>
                        )}
                      {canWrite && campaign.status === 'draft' && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={submitMutation.isPending}
                          onClick={() => submitMutation.mutate(campaign.id)}
                        >
                          Submit for approval
                        </Button>
                      )}
                      {campaign.status === 'pending_approval' && canApprove && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={!canApproveThis || approveMutation.isPending}
                          title={
                            !canApproveThis
                              ? 'A second reviewer must approve a campaign you created.'
                              : undefined
                          }
                          onClick={() => approveMutation.mutate(campaign.id)}
                        >
                          Approve campaign
                        </Button>
                      )}
                      {(campaign.status === 'approved' || campaign.status === 'paused') &&
                        (canWrite || canApprove) && (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={scheduleNowMutation.isPending}
                            onClick={() => scheduleNowMutation.mutate(campaign.id)}
                          >
                            {campaign.status === 'paused' ? 'Resume sending' : 'Send campaign'}
                          </Button>
                        )}
                      {(campaign.status === 'approved' ||
                        campaign.status === 'scheduled' ||
                        campaign.status === 'sending') &&
                        (canWrite || canApprove) && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => pauseMutation.mutate(campaign.id)}
                          >
                            Pause
                          </Button>
                        )}
                      {campaign.status !== 'completed' &&
                        campaign.status !== 'sent' &&
                        campaign.status !== 'cancelled' &&
                        (canWrite || canApprove) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => cancelMutation.mutate(campaign.id)}
                          >
                            Cancel
                          </Button>
                        )}
                    </div>
                  </div>

                  {campaign.status === 'pending_approval' && isCreator && !isAdmin && (
                    <Callout tone="warning">
                      You created this campaign, so another Marketing Manager or Admin must review
                      and approve it before sending.
                    </Callout>
                  )}

                  {campaign.paused_reason && (
                    <Callout
                      tone={campaign.status === 'paused_deliverability' ? 'danger' : 'warning'}
                    >
                      {campaign.paused_reason}
                    </Callout>
                  )}

                  <Panel
                    title={campaign.name}
                    actions={
                      <div className="flex flex-wrap items-center gap-[6px]">
                        <MarketBadge market={campaign.market} />
                        <StatusBadge tone={CAMPAIGN_STATUS_TONE[campaign.status] ?? 'neutral'}>
                          {CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status}
                        </StatusBadge>
                      </div>
                    }
                    padded
                  >
                    <div className="text-[13px] text-ink-2 space-y-[4px]">
                      <div>
                        <span className="font-semibold text-ink">Subject:</span> {campaign.subject}
                      </div>
                      <div className="flex flex-wrap gap-[14px]">
                        <span>Audience: {campaign.list_name ?? 'Market audience'}</span>
                        <span>Sender: {campaign.sender_from_email ?? 'No sender selected'}</span>
                        <span>Throttle: {campaign.throttle_per_hour} / hour</span>
                        {campaign.approved_by_name && (
                          <span>Approved by {campaign.approved_by_name}</span>
                        )}
                      </div>
                    </div>

                    <div className="mt-[14px] grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-[10px]">
                      {[
                        ['Sent', formatNumber(campaign.sent_count)],
                        ['Delivered', formatNumber(campaign.delivered_count)],
                        ['Hard bounces', formatNumber(campaign.bounced_count)],
                        ['Soft bounces', formatNumber(campaign.soft_bounced_count)],
                        ['Complaints', formatNumber(campaign.complained_count)],
                        ['Unsubscribes', formatNumber(campaign.unsubscribed_count)],
                        ['Clicks', formatNumber(campaign.clicked_count)],
                      ].map(([label, val]) => (
                        <div
                          key={label}
                          className="border border-line rounded-[8px] px-[12px] py-[10px] bg-bg-alt"
                        >
                          <div className="text-[12px] text-ink-3">{label}</div>
                          <div className="text-[18px] font-semibold text-ink tabular-nums mt-[2px]">
                            {val}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-[10px] text-[12px] text-ink-3">
                      Opens (unreliable — never used in scoring or automation):{' '}
                      <span className="font-semibold tabular-nums">
                        {formatNumber(campaign.opened_unreliable_count)}
                      </span>
                    </div>
                  </Panel>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-[14px]">
                    <Panel title="Pre-flight checklist" padded>
                      <ul className="m-0 p-0 list-none space-y-[8px] text-[13px]">
                        {checklistItems.map((item, idx) => (
                          <li key={idx} className="flex items-start gap-[8px]">
                            {item.ok ? (
                              <CheckCircle2
                                size={16}
                                className="text-primary-ink shrink-0 mt-[2px]"
                                aria-hidden="true"
                              />
                            ) : (
                              <XCircle
                                size={16}
                                className="text-danger shrink-0 mt-[2px]"
                                aria-hidden="true"
                              />
                            )}
                            <span className="text-ink">{item.label}</span>
                          </li>
                        ))}
                      </ul>

                      {(canWrite || canApprove) && (
                        <div className="mt-[14px] pt-[12px] border-t border-line space-y-[8px]">
                          <label
                            htmlFor="cmpg-test-send-email"
                            className="block text-[12px] font-medium text-ink-2"
                          >
                            Send a test preview to an internal colleague
                          </label>
                          <div className="flex flex-wrap gap-[8px]">
                            <div className="flex-1 min-w-[200px]">
                              <Input
                                id="cmpg-test-send-email"
                                value={testEmail || me?.email || ''}
                                onChange={(e) => setTestEmail(e.target.value)}
                                placeholder="Internal employee email"
                              />
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={testSendMutation.isPending}
                              onClick={() =>
                                testSendMutation.mutate({
                                  id: campaign.id,
                                  email: (testEmail || me?.email || '').trim(),
                                })
                              }
                            >
                              {testSendMutation.isPending ? 'Sending…' : 'Send test'}
                            </Button>
                          </div>
                          {testSendMutation.isError && (
                            <p role="alert" className="m-0 text-[12px] text-danger">
                              {errorMessage(testSendMutation.error)}
                            </p>
                          )}
                        </div>
                      )}
                    </Panel>

                    <Panel title="Clicks by link" padded>
                      {clicksByLink.length === 0 ? (
                        <p className="m-0 text-[13px] text-ink-3">
                          Tracked link clicks will appear here after recipients open campaign links.
                        </p>
                      ) : (
                        <ul className="m-0 p-0 list-none space-y-[8px] text-[13px]">
                          {clicksByLink.map((lnk) => (
                            <li
                              key={lnk.target_url}
                              className="flex items-center justify-between gap-[10px] border-b border-line pb-[6px]"
                            >
                              <span className="truncate text-ink">{lnk.target_url}</span>
                              <span className="text-ink-2 tabular-nums shrink-0">
                                {formatNumber(lnk.total_clicks)} clicks ({lnk.unique_clickers}{' '}
                                people)
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Panel>
                  </div>

                  <Panel title={`Recipients (${recipients.length})`}>
                    {recipients.length === 0 ? (
                      <div className="p-[18px] text-[13px] text-ink-3">
                        Audience recipients are snapshotted when the campaign starts sending.
                      </div>
                    ) : (
                      <div
                        className="overflow-x-auto"
                        tabIndex={0}
                        role="region"
                        aria-label="Campaign recipients"
                      >
                        <table className="w-full border-collapse text-left text-[13px]">
                          <thead>
                            <tr className="border-b border-line text-[12px] text-ink-3">
                              <th className="py-[10px] px-[14px] font-medium">Contact</th>
                              <th className="py-[10px] px-[14px] font-medium">Status</th>
                              <th className="py-[10px] px-[14px] font-medium">Reason</th>
                              <th className="py-[10px] px-[14px] font-medium">Sent</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line">
                            {recipients.map((r) => (
                              <tr key={r.id}>
                                <td className="py-[10px] px-[14px]">
                                  <button
                                    type="button"
                                    onClick={() => onOpenContact(r.contact_id)}
                                    className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                                  >
                                    {r.contact_name}
                                  </button>
                                  <div className="text-[12px] text-ink-3">
                                    {r.company_name ?? r.email}
                                  </div>
                                </td>
                                <td className="py-[10px] px-[14px]">
                                  <StatusBadge
                                    tone={
                                      r.status === 'delivered' || r.status === 'sent'
                                        ? 'success'
                                        : r.status === 'queued'
                                          ? 'brand'
                                          : 'warning'
                                    }
                                  >
                                    {r.status.replace(/_/g, ' ')}
                                  </StatusBadge>
                                </td>
                                <td className="py-[10px] px-[14px] text-ink-2">
                                  {r.reason_code ?? '—'}
                                </td>
                                <td className="py-[10px] px-[14px] text-ink-2 tabular-nums">
                                  {r.sent_at ? formatDateTime(r.sent_at, timeZone) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>
                </>
              );
            })()}
          </div>
        )
      ) : selectedListId ? (
        listDetailQuery.isPending ? (
          <LoadingState />
        ) : listDetailQuery.isError ? (
          <ErrorState
            message={errorMessage(listDetailQuery.error)}
            onRetry={() => void listDetailQuery.refetch()}
          />
        ) : (
          <div className="space-y-[14px]">
            <button
              type="button"
              onClick={() => setUrlState({ list: '' })}
              className="inline-flex items-center gap-[6px] bg-transparent border-0 p-0 text-[13px] font-medium text-ink-2 hover:text-ink cursor-pointer"
            >
              <ArrowLeft size={15} aria-hidden="true" /> All segments & lists
            </button>
            <Panel
              title={listDetailQuery.data.list.name}
              actions={
                <div className="flex items-center gap-[6px]">
                  <MarketBadge market={listDetailQuery.data.list.market} />
                  <StatusBadge tone="brand">
                    {listDetailQuery.data.list.list_type === 'dynamic'
                      ? 'Dynamic segment'
                      : 'Static list'}
                  </StatusBadge>
                </div>
              }
            >
              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="Segment members"
              >
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[12px] text-ink-3">
                      <th className="py-[10px] px-[14px] font-medium">Contact</th>
                      <th className="py-[10px] px-[14px] font-medium">Company</th>
                      <th className="py-[10px] px-[14px] font-medium">Email</th>
                      <th className="py-[10px] px-[14px] font-medium">Verification</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {listDetailQuery.data.members.map((m) => (
                      <tr key={m.id}>
                        <td className="py-[10px] px-[14px]">
                          <button
                            type="button"
                            onClick={() => onOpenContact(m.id)}
                            className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                          >
                            {m.full_name}
                          </button>
                        </td>
                        <td className="py-[10px] px-[14px] text-ink-2">{m.company_name ?? '—'}</td>
                        <td className="py-[10px] px-[14px] text-ink-2">{m.primary_email}</td>
                        <td className="py-[10px] px-[14px]">
                          <StatusBadge
                            tone={m.email_verification_status === 'valid' ? 'success' : 'neutral'}
                          >
                            {m.email_verification_status}
                          </StatusBadge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        )
      ) : activeTab === 'segments' ? (
        listsQuery.isPending ? (
          <LoadingState />
        ) : listsQuery.isError ? (
          <ErrorState
            message={errorMessage(listsQuery.error)}
            onRetry={() => void listsQuery.refetch()}
          />
        ) : listsQuery.data.length === 0 ? (
          <Panel>
            <EmptyState
              title="No segments or lists yet"
              description="Create a dynamic segment or static list to target eligible contacts."
              actionLabel={canWrite ? 'New segment or list' : undefined}
              onAction={() => setCreatingList(true)}
            />
          </Panel>
        ) : (
          <Panel>
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Segments and static lists"
            >
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[12px] text-ink-3">
                    <th className="py-[10px] px-[14px] font-medium">Name</th>
                    <th className="py-[10px] px-[14px] font-medium">Type</th>
                    <th className="py-[10px] px-[14px] font-medium">Market</th>
                    <th className="py-[10px] px-[14px] font-medium text-right">Contacts</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {listsQuery.data.map((lst) => (
                    <tr key={lst.id} className="hover:bg-bg-alt">
                      <td className="py-[12px] px-[14px]">
                        <button
                          type="button"
                          onClick={() => setUrlState({ list: lst.id })}
                          className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                        >
                          {lst.name}
                        </button>
                        {lst.description && (
                          <div className="text-[12px] text-ink-3">{lst.description}</div>
                        )}
                      </td>
                      <td className="py-[12px] px-[14px]">
                        <StatusBadge tone={lst.list_type === 'dynamic' ? 'brand' : 'info'}>
                          {lst.list_type === 'dynamic' ? 'Dynamic segment' : 'Static list'}
                        </StatusBadge>
                      </td>
                      <td className="py-[12px] px-[14px]">
                        <MarketBadge market={lst.market} />
                      </td>
                      <td className="py-[12px] px-[14px] text-right tabular-nums">
                        {formatNumber(lst.member_count)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )
      ) : activeTab === 'senders' ? (
        sendersQuery.isPending ? (
          <LoadingState />
        ) : sendersQuery.isError ? (
          <ErrorState
            message={errorMessage(sendersQuery.error)}
            onRetry={() => void sendersQuery.refetch()}
          />
        ) : (
          <Panel>
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Verified sender identities"
            >
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[12px] text-ink-3">
                    <th className="py-[10px] px-[14px] font-medium">Sender</th>
                    <th className="py-[10px] px-[14px] font-medium">Subdomain</th>
                    <th className="py-[10px] px-[14px] font-medium">Authentication</th>
                    <th className="py-[10px] px-[14px] font-medium text-right">Warm-up cap</th>
                    <th className="py-[10px] px-[14px] font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {sendersQuery.data.map((s) => {
                    const verified = Boolean(
                      s.verified_at && s.spf_verified && s.dkim_verified && s.dmarc_verified,
                    );
                    return (
                      <tr key={s.id}>
                        <td className="py-[12px] px-[14px]">
                          <div className="font-semibold text-ink">{s.from_name}</div>
                          <div className="text-[12px] text-ink-3">{s.from_email}</div>
                        </td>
                        <td className="py-[12px] px-[14px] text-ink-2">{s.domain}</td>
                        <td className="py-[12px] px-[14px]">
                          <StatusBadge tone={verified ? 'success' : 'warning'}>
                            {verified ? 'SPF · DKIM · DMARC verified' : 'Pending DNS verification'}
                          </StatusBadge>
                        </td>
                        <td className="py-[12px] px-[14px] text-right tabular-nums">
                          {formatNumber(s.sent_today_count)} / {formatNumber(s.daily_warmup_cap)}
                        </td>
                        <td className="py-[12px] px-[14px] text-right">
                          {canManageSettings && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => verifySenderMutation.mutate(s)}
                            >
                              {verified ? 'Mark unverified' : 'Mark DNS verified'}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        )
      ) : campaignsQuery.isPending ? (
        <LoadingState />
      ) : campaignsQuery.isError ? (
        <ErrorState
          message={errorMessage(campaignsQuery.error)}
          onRetry={() => void campaignsQuery.refetch()}
        />
      ) : (
        <div className="space-y-[12px]">
          <div className="flex flex-wrap gap-[6px]">
            {[
              ['all', 'All'],
              ['draft', 'Draft'],
              ['pending_approval', 'Pending approval'],
              ['approved', 'Approved'],
              ['sending', 'Sending'],
              ['completed', 'Completed'],
              ['paused_deliverability', 'Auto-paused'],
            ].map(([st, label]) => (
              <button
                key={st}
                type="button"
                onClick={() => setUrlState({ status: st })}
                className={`h-[30px] px-[12px] rounded-pill text-[12px] font-medium border cursor-pointer ${
                  urlState.status === st
                    ? 'bg-navy text-white border-navy'
                    : 'bg-surface text-ink-2 border-line hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {filteredCampaigns.length === 0 ? (
            <Panel>
              <EmptyState
                title="No campaigns match this view"
                description="Create a campaign draft to send briefings from your verified sending subdomain."
                actionLabel={canWrite ? 'New campaign' : undefined}
                onAction={() => setCreatingCampaign(true)}
              />
            </Panel>
          ) : (
            <Panel>
              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="Marketing campaigns"
              >
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[12px] text-ink-3">
                      <th className="py-[10px] px-[14px] font-medium">Campaign</th>
                      <th className="py-[10px] px-[14px] font-medium">Market</th>
                      <th className="py-[10px] px-[14px] font-medium">Status</th>
                      <th className="py-[10px] px-[14px] font-medium text-right">Sent</th>
                      <th className="py-[10px] px-[14px] font-medium text-right">Delivered</th>
                      <th className="py-[10px] px-[14px] font-medium text-right">Bounces</th>
                      <th className="py-[10px] px-[14px] font-medium text-right">Clicks</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {filteredCampaigns.map((cmpg) => (
                      <tr key={cmpg.id} className="hover:bg-bg-alt">
                        <td className="py-[12px] px-[14px]">
                          <button
                            type="button"
                            onClick={() => setUrlState({ campaign: cmpg.id })}
                            className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                          >
                            {cmpg.name}
                          </button>
                          <div className="text-[12px] text-ink-3 truncate max-w-[360px]">
                            {cmpg.subject}
                          </div>
                        </td>
                        <td className="py-[12px] px-[14px]">
                          <MarketBadge market={cmpg.market} />
                        </td>
                        <td className="py-[12px] px-[14px]">
                          <StatusBadge tone={CAMPAIGN_STATUS_TONE[cmpg.status] ?? 'neutral'}>
                            {CAMPAIGN_STATUS_LABEL[cmpg.status] ?? cmpg.status}
                          </StatusBadge>
                        </td>
                        <td className="py-[12px] px-[14px] text-right tabular-nums">
                          {formatNumber(cmpg.sent_count)}
                        </td>
                        <td className="py-[12px] px-[14px] text-right tabular-nums">
                          {formatNumber(cmpg.delivered_count)}
                        </td>
                        <td className="py-[12px] px-[14px] text-right tabular-nums">
                          {formatNumber(cmpg.bounced_count)}
                        </td>
                        <td className="py-[12px] px-[14px] text-right tabular-nums">
                          {formatNumber(cmpg.clicked_count)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      )}

      <CampaignEditorDrawer
        key={editingCampaign?.id ?? (creatingCampaign ? 'new' : 'closed')}
        open={creatingCampaign || Boolean(editingCampaign)}
        initial={editingCampaign}
        lists={listsQuery.data ?? []}
        senders={sendersQuery.data ?? []}
        onClose={() => {
          setCreatingCampaign(false);
          setEditingCampaign(null);
        }}
      />

      <Drawer
        open={creatingList}
        title="New segment or static list"
        description="Dynamic segments resolve matching contacts automatically when a campaign starts."
        onClose={() => setCreatingList(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreatingList(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!listName.trim() || createListMutation.isPending}
              onClick={() => createListMutation.mutate()}
            >
              {createListMutation.isPending ? 'Saving…' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="space-y-[12px]">
          <FormRow id="lst-name-input" label="Name">
            <Input
              id="lst-name-input"
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="e.g. U.S. UltraTax & CCH Partners"
            />
          </FormRow>
          <FormRow id="lst-desc-input" label="Description">
            <Input
              id="lst-desc-input"
              value={listDesc}
              onChange={(e) => setListDesc(e.target.value)}
              placeholder="Optional summary"
            />
          </FormRow>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-[10px]">
            <FormRow id="lst-type-select" label="Audience type">
              <Select
                id="lst-type-select"
                value={listType}
                onChange={(e) => setListType(e.target.value as 'dynamic' | 'static')}
              >
                <option value="dynamic">Dynamic segment</option>
                <option value="static">Static list</option>
              </Select>
            </FormRow>
            <FormRow id="lst-market-select" label="Market">
              <Select
                id="lst-market-select"
                value={listMarket}
                onChange={(e) => setListMarket(e.target.value as Market)}
              >
                <option value="US">United States (US)</option>
                <option value="CA">Canada (CA)</option>
                <option value="OTHER">Other markets</option>
              </Select>
            </FormRow>
          </div>
          {listType === 'dynamic' && (
            <>
              <FormRow
                id="lst-sw-input"
                label="Accounting software filter (comma-separated, optional)"
              >
                <Input
                  id="lst-sw-input"
                  value={listSoftware}
                  onChange={(e) => setListSoftware(e.target.value)}
                  placeholder="e.g. UltraTax CS, CaseWare"
                />
              </FormRow>
              <label className="flex items-center gap-[8px] text-[13px] text-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={listVerifiedOnly}
                  onChange={(e) => setListVerifiedOnly(e.target.checked)}
                />
                <span>Only include contacts with verified email addresses</span>
              </label>
            </>
          )}
          {createListMutation.isError && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {errorMessage(createListMutation.error)}
            </p>
          )}
        </div>
      </Drawer>

      <Drawer
        open={creatingSender}
        title="Add sender identity"
        description="Campaigns must send from a dedicated sending subdomain (never the root employee domain)."
        onClose={() => setCreatingSender(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreatingSender(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                !senderFromName.trim() || !senderFromEmail.trim() || createSenderMutation.isPending
              }
              onClick={() => createSenderMutation.mutate()}
            >
              {createSenderMutation.isPending ? 'Saving…' : 'Add sender'}
            </Button>
          </>
        }
      >
        <div className="space-y-[12px]">
          <FormRow id="snd-name-input" label="Sender display name">
            <Input
              id="snd-name-input"
              value={senderFromName}
              onChange={(e) => setSenderFromName(e.target.value)}
              placeholder="e.g. Ananya Iyer · ADAS Globus Pro"
            />
          </FormRow>
          <FormRow id="snd-email-input" label="Subdomain email address">
            <Input
              id="snd-email-input"
              value={senderFromEmail}
              onChange={(e) => setSenderFromEmail(e.target.value)}
              placeholder="briefings@mail.adasglobuspro.com"
            />
          </FormRow>
          <FormRow id="snd-cap-input" label="Daily warm-up cap">
            <Input
              id="snd-cap-input"
              type="number"
              min={10}
              max={50000}
              value={senderWarmupCap}
              onChange={(e) => setSenderWarmupCap(e.target.value)}
            />
          </FormRow>
          {createSenderMutation.isError && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {errorMessage(createSenderMutation.error)}
            </p>
          )}
        </div>
      </Drawer>
    </div>
  );
}
