import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime, formatNumber, type Market } from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Drawer } from '@/components/ui/drawer.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type ApolloSearchPersonRow, type Scope } from '@/lib/api.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { errorMessage, tableClass, thClass, theadRowClass } from '@/features/shared/live-kit.js';
import { CAPABILITY_LABEL, FormRow, SCOPE_LABEL } from './settings-kit.js';

const TOKEN_CAPABILITY_OPTIONS = [
  'leads.read',
  'leads.write',
  'contacts.read',
  'contacts.write',
  'companies.read',
  'companies.write',
  'deals.read',
  'deals.write',
  'tasks.read',
  'tasks.write',
  'reports.read',
] as const;

export function ApolloSearchDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [keywords, setKeywords] = useState('');
  const [titlesText, setTitlesText] = useState('Managing Partner, Tax Partner');
  const [market, setMarket] = useState<Market>('US');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmConfirmed, setConfirmConfirmed] = useState(false);

  const searchMutation = useMutation({
    mutationFn: () =>
      api.searchApollo({
        qKeywords: keywords.trim() || undefined,
        personTitles: titlesText
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        market,
        page: 1,
        perPage: 25,
      }),
    onSuccess: () => {
      setSelectedIds([]);
      setConfirmConfirmed(false);
    },
  });

  const results: ApolloSearchPersonRow[] = searchMutation.data?.items ?? [];
  const selectedRows = results.filter((r) => selectedIds.includes(r.apolloPersonId));
  const totalCreditCost = selectedRows.reduce((sum, r) => sum + r.estimatedCreditCost, 0);

  const importMutation = useMutation({
    mutationFn: () =>
      api.importFromApollo({
        confirmedCreditCost: confirmConfirmed ? totalCreditCost : 0,
        candidates: selectedRows.map((r) => ({
          apolloPersonId: r.apolloPersonId,
          apolloOrgId: r.apolloOrgId,
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email ?? undefined,
          title: r.title,
          firmName: r.firmName,
          domain: r.domain,
          market,
        })),
      }),
    onSuccess: async (res) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['contacts'] }),
        queryClient.invalidateQueries({ queryKey: ['companies'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-integrations'] }),
        queryClient.invalidateQueries({ queryKey: ['apollo-status'] }),
      ]);
      toast(
        `Imported ${res.createdCount} contact${res.createdCount === 1 ? '' : 's'} (${res.creditsConsumed} credit${res.creditsConsumed === 1 ? '' : 's'} used).`,
      );
      setSelectedIds([]);
      setConfirmConfirmed(false);
      onClose();
    },
  });

  const toggleRow = (id: string) => {
    setConfirmConfirmed(false);
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <Drawer
      open={open}
      width={620}
      title="Search Apollo prospects"
      description="Search accounting and tax decision makers. Suppressed addresses are never imported, and imported contacts carry no marketing consent."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={
              selectedRows.length === 0 ||
              (totalCreditCost > 0 && !confirmConfirmed) ||
              importMutation.isPending
            }
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending
              ? 'Importing…'
              : `Import ${selectedRows.length || ''} (${totalCreditCost} credit${totalCreditCost === 1 ? '' : 's'})`.trim()}
          </Button>
        </>
      }
    >
      <div className="space-y-[14px]">
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            searchMutation.mutate();
          }}
          className="space-y-[12px]"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-[10px]">
            <FormRow id="apollo-q" label="Keywords or software">
              <Input
                id="apollo-q"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="e.g. CPA firm UltraTax"
              />
            </FormRow>
            <FormRow id="apollo-market" label="Market">
              <Select
                id="apollo-market"
                value={market}
                onChange={(e) => setMarket(e.target.value as Market)}
              >
                <option value="US">United States</option>
                <option value="CA">Canada</option>
              </Select>
            </FormRow>
          </div>
          <FormRow id="apollo-titles" label="Job titles (comma-separated)">
            <Input
              id="apollo-titles"
              value={titlesText}
              onChange={(e) => setTitlesText(e.target.value)}
            />
          </FormRow>
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={searchMutation.isPending}>
              {searchMutation.isPending ? 'Searching…' : 'Search prospects'}
            </Button>
          </div>
        </form>

        {searchMutation.isError && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {errorMessage(searchMutation.error)}
          </p>
        )}

        {searchMutation.data && (
          <div className="space-y-[10px]">
            <div className="text-[12px] text-ink-3 flex flex-wrap justify-between gap-[8px]">
              <span>{formatNumber(searchMutation.data.totalEntries)} matching people</span>
              <span>
                Remaining daily credits: {formatNumber(searchMutation.data.remainingDailyCredits)}{' '}
                of {formatNumber(searchMutation.data.dailyCap)}
              </span>
            </div>

            <div
              className="border border-line rounded-[8px] max-h-[280px] overflow-y-auto divide-y divide-line"
              tabIndex={0}
              role="region"
              aria-label="Apollo search results"
            >
              {results.length === 0 ? (
                <div className="p-[14px] text-[13px] text-ink-3">No matching people returned.</div>
              ) : (
                results.map((r) => {
                  const checked = selectedIds.includes(r.apolloPersonId);
                  return (
                    <label
                      key={r.apolloPersonId}
                      className={`flex items-start gap-[10px] px-[12px] py-[10px] ${
                        r.suppressed
                          ? 'opacity-60 cursor-not-allowed'
                          : 'cursor-pointer hover:bg-bg-alt'
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={r.suppressed}
                        checked={checked}
                        onChange={() => toggleRow(r.apolloPersonId)}
                        className="mt-[3px]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-[6px]">
                          <span className="text-[14px] font-medium text-ink">
                            {r.firstName} {r.lastName}
                          </span>
                          {r.suppressed ? (
                            <StatusBadge tone="danger">Suppressed</StatusBadge>
                          ) : r.alreadyInCrm ? (
                            <StatusBadge tone="info">In CRM · 0 credits</StatusBadge>
                          ) : (
                            <StatusBadge tone="brand">1 credit</StatusBadge>
                          )}
                        </span>
                        <span className="block text-[12px] text-ink-2 truncate">
                          {r.title || 'Contact'} · {r.firmName || r.domain || 'Unknown firm'}
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>

            {selectedRows.length > 0 && totalCreditCost > 0 && (
              <Callout tone="warning">
                <label className="flex items-start gap-[8px] cursor-pointer text-[13px]">
                  <input
                    type="checkbox"
                    checked={confirmConfirmed}
                    onChange={(e) => setConfirmConfirmed(e.target.checked)}
                    className="mt-[2px]"
                  />
                  <span>
                    Confirm spending <strong>{totalCreditCost}</strong> Apollo credit
                    {totalCreditCost === 1 ? '' : 's'} to unlock work emails and import these
                    prospects.
                  </span>
                </label>
              </Callout>
            )}
          </div>
        )}

        {importMutation.isError && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {errorMessage(importMutation.error)}
          </p>
        )}
      </div>
    </Drawer>
  );
}

export function IntegrationsTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const timeZone = viewerTimeZone();

  const overviewQuery = useQuery({
    queryKey: ['admin-integrations'],
    queryFn: api.getIntegrationsOverview,
  });
  const tokensQuery = useQuery({
    queryKey: ['admin-api-tokens'],
    queryFn: api.listApiTokens,
  });

  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [apolloOpen, setApolloOpen] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [tokenScope, setTokenScope] = useState<Scope>('team');
  const [tokenExpiryDays, setTokenExpiryDays] = useState('90');
  const [tokenCaps, setTokenCaps] = useState<string[]>(['leads.read', 'deals.read']);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null);

  const updateCapMutation = useMutation({
    mutationFn: (limit: number) => api.updateApolloCreditLimit({ dailyCreditLimit: limit }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-integrations'] });
      setCapDraft(null);
      toast(`Daily Apollo credit limit updated to ${formatNumber(res.dailyCap)}.`);
    },
  });

  const createTokenMutation = useMutation({
    mutationFn: () => {
      const days = Number(tokenExpiryDays);
      return api.createApiToken({
        name: tokenName.trim(),
        capabilities: tokenCaps,
        scopeLevel: tokenScope,
        expiresInDays: Number.isInteger(days) && days > 0 ? days : null,
      });
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-api-tokens'] });
      setRevealedToken(res.secretToken);
      setCreatingToken(false);
      setTokenName('');
      toast('Service API token created. Copy it now — it will not be shown again.');
    },
  });

  const revokeTokenMutation = useMutation({
    mutationFn: (id: string) => api.revokeApiToken(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-api-tokens'] });
      setRevokingTokenId(null);
      toast('API token revoked.');
    },
  });

  if (overviewQuery.isPending || tokensQuery.isPending) return <LoadingState />;
  if (overviewQuery.isError) {
    return (
      <ErrorState
        message={errorMessage(overviewQuery.error)}
        onRetry={() => void overviewQuery.refetch()}
      />
    );
  }
  if (tokensQuery.isError) {
    return (
      <ErrorState
        message={errorMessage(tokensQuery.error)}
        onRetry={() => void tokensQuery.refetch()}
      />
    );
  }

  const { connectors, recentApolloLedger } = overviewQuery.data;
  const effectiveCapInput = capDraft ?? String(connectors.apollo.dailyCap);

  const toggleCap = (cap: string) => {
    setTokenCaps((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]));
  };

  return (
    <div className="space-y-[18px]" data-testid="settings-integrations-tab">
      <Panel title="External connectors" padded>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-[12px]">
          <div className="border border-line rounded-[8px] p-[14px] space-y-[6px]">
            <div className="flex items-center justify-between gap-[8px]">
              <span className="font-semibold text-ink text-[14px]">Microsoft Entra sign-in</span>
              <StatusBadge tone={connectors.entraSso.configured ? 'success' : 'neutral'}>
                {connectors.entraSso.configured ? 'Connected' : 'Awaiting credentials'}
              </StatusBadge>
            </div>
            <p className="m-0 text-[13px] text-ink-2">
              Employee single sign-on with company Microsoft 365 accounts.
            </p>
          </div>

          <div className="border border-line rounded-[8px] p-[14px] space-y-[6px]">
            <div className="flex items-center justify-between gap-[8px]">
              <span className="font-semibold text-ink text-[14px]">Microsoft 365 mail sync</span>
              <StatusBadge tone={connectors.microsoftGraphMail.configured ? 'success' : 'neutral'}>
                {connectors.microsoftGraphMail.configured ? 'Connected' : 'Awaiting credentials'}
              </StatusBadge>
            </div>
            <p className="m-0 text-[13px] text-ink-2">
              {formatNumber(connectors.microsoftGraphMail.connectedMailboxes)} connected employee
              mailbox{connectors.microsoftGraphMail.connectedMailboxes === 1 ? '' : 'es'}.
            </p>
          </div>

          <div className="border border-line rounded-[8px] p-[14px] space-y-[6px]">
            <div className="flex items-center justify-between gap-[8px]">
              <span className="font-semibold text-ink text-[14px]">Campaign email provider</span>
              <StatusBadge tone={connectors.espCampaigns.mailLive ? 'success' : 'info'}>
                {connectors.espCampaigns.mailLive ? 'Live sending' : 'Test mode'}
              </StatusBadge>
            </div>
            <p className="m-0 text-[13px] text-ink-2 break-all">
              Adapter: {connectors.espCampaigns.provider} · Subdomain:{' '}
              {connectors.espCampaigns.sendingDomain}
            </p>
          </div>

          <div className="border border-line rounded-[8px] p-[14px] space-y-[6px]">
            <div className="flex items-center justify-between gap-[8px]">
              <span className="font-semibold text-ink text-[14px]">Microsoft Bookings</span>
              <StatusBadge tone={connectors.microsoftBookings.configured ? 'success' : 'neutral'}>
                {connectors.microsoftBookings.configured ? 'Verified' : 'Awaiting secret'}
              </StatusBadge>
            </div>
            <p className="m-0 text-[12px] text-ink-2 break-all">
              Endpoint: {connectors.microsoftBookings.webhookUrl}
            </p>
            <div className="text-[12px] text-ink-3">
              {formatNumber(connectors.microsoftBookings.eventsProcessed30d)} booked meetings
              processed in the last 30 days
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="Apollo prospecting & credit guard"
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={!connectors.apollo.configured}
            onClick={() => setApolloOpen(true)}
          >
            Search Apollo
          </Button>
        }
        padded
      >
        <div className="space-y-[14px]">
          {!connectors.apollo.configured && (
            <Callout tone="brand">
              Apollo API key is not configured yet. Place the key in{' '}
              <code>secrets/apollo_api_key.txt</code> on the server to enable live prospect search
              and enrichment.
            </Callout>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-[10px]">
            <div className="border border-line rounded-[8px] px-[12px] py-[10px] bg-bg-alt">
              <div className="text-[12px] text-ink-3">Credits used today</div>
              <div className="text-[18px] font-semibold text-ink tabular-nums">
                {formatNumber(connectors.apollo.creditsUsedToday)}
              </div>
            </div>
            <div className="border border-line rounded-[8px] px-[12px] py-[10px] bg-bg-alt">
              <div className="text-[12px] text-ink-3">Daily credit cap</div>
              <div className="text-[18px] font-semibold text-ink tabular-nums">
                {formatNumber(connectors.apollo.dailyCap)}
              </div>
            </div>
            <div className="border border-line rounded-[8px] px-[12px] py-[10px] bg-bg-alt">
              <div className="text-[12px] text-ink-3">Remaining today</div>
              <div className="text-[18px] font-semibold text-ink tabular-nums">
                {formatNumber(connectors.apollo.remainingDailyCredits)}
              </div>
            </div>
          </div>

          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const parsed = Number(effectiveCapInput);
              if (Number.isInteger(parsed) && parsed >= 0) {
                updateCapMutation.mutate(parsed);
              }
            }}
            className="flex flex-wrap items-end gap-[10px]"
          >
            <div className="w-full sm:w-[220px]">
              <FormRow id="apollo-daily-cap-input" label="Daily credit limit">
                <Input
                  id="apollo-daily-cap-input"
                  type="number"
                  min={0}
                  max={50000}
                  value={effectiveCapInput}
                  onChange={(e) => setCapDraft(e.target.value)}
                />
              </FormRow>
            </div>
            <Button type="submit" variant="secondary" disabled={updateCapMutation.isPending}>
              {updateCapMutation.isPending ? 'Saving…' : 'Save credit limit'}
            </Button>
          </form>

          {recentApolloLedger.length > 0 && (
            <div
              className="overflow-x-auto border border-line rounded-[8px]"
              tabIndex={0}
              role="region"
              aria-label="Recent Apollo credit usage"
            >
              <table className={tableClass}>
                <thead>
                  <tr className={theadRowClass}>
                    <th className={thClass}>Action</th>
                    <th className={thClass}>Credits</th>
                    <th className={thClass}>Actor</th>
                    <th className={thClass}>Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {recentApolloLedger.map((entry) => (
                    <tr key={entry.id}>
                      <td className="px-[14px] py-[10px] text-[13px] text-ink">
                        {entry.action.replace(/_/g, ' ')}
                      </td>
                      <td className="px-[14px] py-[10px] text-[13px] tabular-nums">
                        {entry.creditsUsed}
                      </td>
                      <td className="px-[14px] py-[10px] text-[13px] text-ink-2">
                        {entry.actorName ?? 'System'}
                      </td>
                      <td className="px-[14px] py-[10px] text-[13px] text-ink-3 tabular-nums">
                        {formatDateTime(entry.createdAt, timeZone)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Service API tokens"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreatingToken(true)}>
            New API token
          </Button>
        }
      >
        <div className="space-y-[12px] p-[20px] pt-0">
          {revealedToken && (
            <Callout tone="warning">
              <div className="space-y-[6px]">
                <div className="font-semibold">Copy your new API token now</div>
                <p className="m-0 text-[13px]">
                  For security, only the SHA-256 hash is stored and this secret cannot be viewed
                  again.
                </p>
                <div className="flex flex-wrap items-center gap-[8px]">
                  <code
                    className="px-[10px] py-[6px] rounded-[6px] bg-surface border border-line text-[12px] break-all"
                    data-testid="revealed-api-token"
                  >
                    {revealedToken}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(revealedToken);
                      toast('Copied token to clipboard.');
                    }}
                  >
                    Copy
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRevealedToken(null)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            </Callout>
          )}

          {tokensQuery.data.length === 0 ? (
            <EmptyState
              title="No service API tokens yet"
              description="Create a scoped token for n8n or internal automation scripts."
              actionLabel="New API token"
              onAction={() => setCreatingToken(true)}
            />
          ) : (
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Service API tokens"
            >
              <table className={tableClass}>
                <thead>
                  <tr className={theadRowClass}>
                    <th className={thClass}>Name</th>
                    <th className={thClass}>Prefix</th>
                    <th className={thClass}>Scope</th>
                    <th className={thClass}>Status</th>
                    <th className={thClass}>Expires</th>
                    <th className={`${thClass} text-right`}>Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {tokensQuery.data.map((tok) => (
                    <tr key={tok.id}>
                      <td className="px-[14px] py-[10px]">
                        <div className="font-medium text-ink text-[13px]">{tok.name}</div>
                        <div className="text-[12px] text-ink-3">
                          {tok.capabilities.length} capabilit
                          {tok.capabilities.length === 1 ? 'y' : 'ies'}
                        </div>
                      </td>
                      <td className="px-[14px] py-[10px] text-[12px] font-mono text-ink-2">
                        {tok.tokenPrefix}…
                      </td>
                      <td className="px-[14px] py-[10px] text-[13px] text-ink-2">
                        {SCOPE_LABEL[tok.scopeLevel] ?? tok.scopeLevel}
                      </td>
                      <td className="px-[14px] py-[10px]">
                        <StatusBadge tone={tok.revokedAt ? 'neutral' : 'success'}>
                          {tok.revokedAt ? 'Revoked' : 'Active'}
                        </StatusBadge>
                      </td>
                      <td className="px-[14px] py-[10px] text-[13px] text-ink-3 tabular-nums">
                        {tok.expiresAt ? formatDate(tok.expiresAt, timeZone) : 'Never'}
                      </td>
                      <td className="px-[14px] py-[10px] text-right">
                        {!tok.revokedAt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRevokingTokenId(tok.id)}
                          >
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>

      <ApolloSearchDrawer open={apolloOpen} onClose={() => setApolloOpen(false)} />

      <Drawer
        open={creatingToken}
        title="New service API token"
        description="Tokens authenticate with Authorization: Bearer and can never exceed the creator’s live permissions."
        onClose={() => setCreatingToken(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreatingToken(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                tokenName.trim().length < 2 ||
                tokenCaps.length === 0 ||
                createTokenMutation.isPending
              }
              onClick={() => createTokenMutation.mutate()}
            >
              {createTokenMutation.isPending ? 'Creating…' : 'Create token'}
            </Button>
          </>
        }
      >
        <div className="space-y-[14px]">
          <FormRow id="api-tok-name" label="Token name">
            <Input
              id="api-tok-name"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              placeholder="e.g. n8n Deal Won Automation"
            />
          </FormRow>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-[10px]">
            <FormRow id="api-tok-scope" label="Record scope">
              <Select
                id="api-tok-scope"
                value={tokenScope}
                onChange={(e) => setTokenScope(e.target.value as Scope)}
              >
                <option value="own">Own records</option>
                <option value="team">Team records</option>
                <option value="all">All records</option>
              </Select>
            </FormRow>
            <FormRow id="api-tok-exp" label="Expires in days (blank = never)">
              <Input
                id="api-tok-exp"
                type="number"
                min={1}
                max={365}
                value={tokenExpiryDays}
                onChange={(e) => setTokenExpiryDays(e.target.value)}
              />
            </FormRow>
          </div>

          <fieldset className="border border-line rounded-[8px] p-[12px] m-0 space-y-[8px]">
            <legend className="px-[4px] text-[12px] font-semibold text-ink-2">
              Allowed capabilities
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-[6px]">
              {TOKEN_CAPABILITY_OPTIONS.map((cap) => (
                <label
                  key={cap}
                  className="flex items-center gap-[8px] text-[13px] text-ink cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={tokenCaps.includes(cap)}
                    onChange={() => toggleCap(cap)}
                  />
                  <span>{CAPABILITY_LABEL[cap] ?? cap}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {createTokenMutation.isError && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {errorMessage(createTokenMutation.error)}
            </p>
          )}
        </div>
      </Drawer>

      <ConfirmDialog
        open={Boolean(revokingTokenId)}
        title="Revoke API token"
        tone="danger"
        confirmLabel="Revoke token"
        pending={revokeTokenMutation.isPending}
        error={revokeTokenMutation.isError ? errorMessage(revokeTokenMutation.error) : null}
        onCancel={() => setRevokingTokenId(null)}
        onConfirm={() => {
          if (revokingTokenId) revokeTokenMutation.mutate(revokingTokenId);
        }}
        body={
          <p className="m-0">
            Any external workflow using this token will immediately lose access.
          </p>
        }
      />
    </div>
  );
}
