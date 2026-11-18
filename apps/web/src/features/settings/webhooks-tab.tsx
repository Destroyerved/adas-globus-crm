import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WEBHOOK_EVENT_TYPES, formatDateTime, type StatusTone } from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Drawer } from '@/components/ui/drawer.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type WebhookEndpointRow } from '@/lib/api.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { errorMessage, tableClass, thClass, theadRowClass } from '@/features/shared/live-kit.js';
import { FormRow } from './settings-kit.js';

const DELIVERY_STATUS_TONE: Record<string, StatusTone> = {
  delivered: 'success',
  pending: 'info',
  retrying: 'warning',
  failed: 'danger',
};

export function WebhooksTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const timeZone = viewerTimeZone();

  const webhooksQuery = useQuery({
    queryKey: ['admin-webhooks'],
    queryFn: api.listWebhooks,
  });

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [eventTypes, setEventTypes] = useState<string[]>(['lead.created', 'deal.won']);
  const [revealedSecret, setRevealedSecret] = useState<{
    endpointName: string;
    secret: string;
  } | null>(null);
  const [deliveriesEndpoint, setDeliveriesEndpoint] = useState<WebhookEndpointRow | null>(null);
  const [deletingEndpoint, setDeletingEndpoint] = useState<WebhookEndpointRow | null>(null);

  const deliveriesQuery = useQuery({
    queryKey: ['webhook-deliveries', deliveriesEndpoint?.id],
    queryFn: () => api.listWebhookDeliveries(deliveriesEndpoint?.id ?? ''),
    enabled: Boolean(deliveriesEndpoint),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createWebhook({
        name: name.trim(),
        description: description.trim() || null,
        targetUrl: targetUrl.trim(),
        eventTypes,
        active: true,
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-webhooks'] });
      setRevealedSecret({ endpointName: res.endpoint.name, secret: res.signingSecret });
      setCreating(false);
      setName('');
      setDescription('');
      setTargetUrl('');
      toast('Webhook endpoint created.');
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (ep: WebhookEndpointRow) =>
      api.updateWebhook(ep.id, {
        version: ep.version,
        active: !ep.active,
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-webhooks'] });
      toast(res.endpoint.active ? 'Webhook enabled.' : 'Webhook paused.');
    },
  });

  const rotateSecretMutation = useMutation({
    mutationFn: (ep: WebhookEndpointRow) =>
      api.updateWebhook(ep.id, {
        version: ep.version,
        rotateSecret: true,
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-webhooks'] });
      if (res.rotatedSigningSecret) {
        setRevealedSecret({
          endpointName: res.endpoint.name,
          secret: res.rotatedSigningSecret,
        });
      }
      toast('Signing secret rotated.');
    },
  });

  const testMutation = useMutation({
    mutationFn: (endpointId: string) => api.testWebhook(endpointId),
    onSuccess: async (delivery) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-webhooks'] }),
        queryClient.invalidateQueries({ queryKey: ['webhook-deliveries', delivery.endpoint_id] }),
      ]);
      toast(
        delivery.status === 'delivered'
          ? `Test webhook delivered (HTTP ${delivery.last_status_code}).`
          : `Test webhook failed (${delivery.last_error ?? 'unreachable'}).`,
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-webhooks'] });
      setDeletingEndpoint(null);
      toast('Webhook endpoint deleted.');
    },
  });

  if (webhooksQuery.isPending) return <LoadingState />;
  if (webhooksQuery.isError) {
    return (
      <ErrorState
        message={errorMessage(webhooksQuery.error)}
        onRetry={() => void webhooksQuery.refetch()}
      />
    );
  }

  const toggleEvent = (evt: string) => {
    setEventTypes((prev) => (prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt]));
  };

  return (
    <div className="space-y-[16px]" data-testid="settings-webhooks-tab">
      {revealedSecret && (
        <Callout tone="warning">
          <div className="space-y-[6px]">
            <div className="font-semibold">Signing secret for {revealedSecret.endpointName}</div>
            <p className="m-0 text-[13px]">
              Verify <code>X-ADAS-Signature</code> (timestamp + HMAC-SHA256) in your receiver using
              this secret. Copy it now — it is stored encrypted and will not be shown again.
            </p>
            <div className="flex flex-wrap items-center gap-[8px]">
              <code
                className="px-[10px] py-[6px] rounded-[6px] bg-surface border border-line text-[12px] break-all"
                data-testid="revealed-webhook-secret"
              >
                {revealedSecret.secret}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(revealedSecret.secret);
                  toast('Copied signing secret.');
                }}
              >
                Copy
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRevealedSecret(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        </Callout>
      )}

      <Panel
        title="Outbound webhooks"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            Add endpoint
          </Button>
        }
      >
        {webhooksQuery.data.length === 0 ? (
          <EmptyState
            title="No outbound webhooks configured"
            description="Send signed real-time events to n8n or internal systems with automatic 24-hour retry backoff."
            actionLabel="Add endpoint"
            onAction={() => setCreating(true)}
          />
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Outbound webhook endpoints"
          >
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>Endpoint</th>
                  <th className={thClass}>Events</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Last delivery</th>
                  <th className={`${thClass} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {webhooksQuery.data.map((ep) => (
                  <tr key={ep.id}>
                    <td className="px-[14px] py-[12px]">
                      <div className="font-semibold text-ink text-[13px]">{ep.name}</div>
                      <div className="text-[12px] text-ink-2 break-all">{ep.target_url}</div>
                      <div className="text-[11px] font-mono text-ink-3 mt-[2px]">
                        Secret: {ep.secret_hint}
                      </div>
                    </td>
                    <td className="px-[14px] py-[12px] text-[12px] text-ink-2">
                      {ep.event_types.join(', ')}
                    </td>
                    <td className="px-[14px] py-[12px]">
                      <StatusBadge tone={ep.active ? 'success' : 'neutral'}>
                        {ep.active ? 'Active' : 'Paused'}
                      </StatusBadge>
                    </td>
                    <td className="px-[14px] py-[12px] text-[12px] text-ink-2">
                      {ep.last_status_code ? (
                        <StatusBadge
                          tone={
                            ep.last_status_code >= 200 && ep.last_status_code < 300
                              ? 'success'
                              : 'danger'
                          }
                        >
                          HTTP {ep.last_status_code}
                        </StatusBadge>
                      ) : ep.last_error ? (
                        <span className="text-danger">{ep.last_error}</span>
                      ) : (
                        <span className="text-ink-3">Never</span>
                      )}
                    </td>
                    <td className="px-[14px] py-[12px] text-right">
                      <div className="inline-flex flex-wrap justify-end gap-[6px]">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={testMutation.isPending}
                          onClick={() => testMutation.mutate(ep.id)}
                        >
                          Send test
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeliveriesEndpoint(ep)}>
                          Deliveries
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleActiveMutation.mutate(ep)}
                        >
                          {ep.active ? 'Pause' : 'Enable'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => rotateSecretMutation.mutate(ep)}
                        >
                          Rotate secret
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeletingEndpoint(ep)}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Drawer
        open={creating}
        width={560}
        title="Add outbound webhook"
        description="Events are signed with X-ADAS-Signature (HMAC-SHA256 + Unix timestamp) and retried with exponential backoff for up to 24 hours."
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                name.trim().length < 2 ||
                !targetUrl.trim() ||
                eventTypes.length === 0 ||
                createMutation.isPending
              }
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Saving…' : 'Create endpoint'}
            </Button>
          </>
        }
      >
        <div className="space-y-[14px]">
          <FormRow id="wh-name" label="Endpoint name">
            <Input
              id="wh-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. n8n Client Onboarding"
            />
          </FormRow>
          <FormRow id="wh-url" label="Destination URL">
            <Input
              id="wh-url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://automation.adasglobuspro.com/webhook/deal-won"
            />
          </FormRow>
          <FormRow id="wh-desc" label="Description (optional)">
            <Input
              id="wh-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Workflow owner or purpose"
            />
          </FormRow>

          <fieldset className="border border-line rounded-[8px] p-[12px] m-0 space-y-[8px]">
            <legend className="px-[4px] text-[12px] font-semibold text-ink-2">
              Subscribed events
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-[6px]">
              {WEBHOOK_EVENT_TYPES.map((evt) => (
                <label
                  key={evt}
                  className="flex items-center gap-[8px] text-[13px] text-ink cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={eventTypes.includes(evt)}
                    onChange={() => toggleEvent(evt)}
                  />
                  <span>{evt}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {createMutation.isError && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {errorMessage(createMutation.error)}
            </p>
          )}
        </div>
      </Drawer>

      <Drawer
        open={Boolean(deliveriesEndpoint)}
        width={620}
        title={deliveriesEndpoint ? `Deliveries · ${deliveriesEndpoint.name}` : 'Deliveries'}
        description="Recent outbound HTTP attempts and retry schedule."
        onClose={() => setDeliveriesEndpoint(null)}
        footer={
          <Button variant="ghost" onClick={() => setDeliveriesEndpoint(null)}>
            Close
          </Button>
        }
      >
        {deliveriesQuery.isPending ? (
          <LoadingState />
        ) : deliveriesQuery.isError ? (
          <ErrorState
            message={errorMessage(deliveriesQuery.error)}
            onRetry={() => void deliveriesQuery.refetch()}
          />
        ) : deliveriesQuery.data.length === 0 ? (
          <EmptyState
            title="No deliveries recorded yet"
            description="Trigger Send test or wait for a matching CRM event."
          />
        ) : (
          <div
            className="overflow-x-auto border border-line rounded-[8px]"
            tabIndex={0}
            role="region"
            aria-label="Webhook delivery attempts"
          >
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>Event</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>HTTP / Error</th>
                  <th className={thClass}>Attempts</th>
                  <th className={thClass}>Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {deliveriesQuery.data.map((d) => (
                  <tr key={d.id}>
                    <td className="px-[12px] py-[10px] text-[13px] font-medium text-ink">
                      {d.event_type}
                    </td>
                    <td className="px-[12px] py-[10px]">
                      <StatusBadge tone={DELIVERY_STATUS_TONE[d.status] ?? 'neutral'}>
                        {d.status}
                      </StatusBadge>
                    </td>
                    <td className="px-[12px] py-[10px] text-[12px] text-ink-2">
                      {d.last_status_code ? `HTTP ${d.last_status_code}` : (d.last_error ?? '—')}
                    </td>
                    <td className="px-[12px] py-[10px] text-[13px] tabular-nums">{d.attempts}</td>
                    <td className="px-[12px] py-[10px] text-[12px] text-ink-3 tabular-nums">
                      {formatDateTime(d.created_at, timeZone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deletingEndpoint)}
        title={deletingEndpoint ? `Delete ${deletingEndpoint.name}?` : 'Delete webhook'}
        tone="danger"
        confirmLabel="Delete endpoint"
        pending={deleteMutation.isPending}
        error={deleteMutation.isError ? errorMessage(deleteMutation.error) : null}
        onCancel={() => setDeletingEndpoint(null)}
        onConfirm={() => {
          if (deletingEndpoint) deleteMutation.mutate(deletingEndpoint.id);
        }}
        body={
          <p className="m-0">
            Queued deliveries for this endpoint will be cancelled and removed permanently.
          </p>
        }
      />
    </div>
  );
}
