import type {
  AuditAndClientsPayload,
  DesktopBridgeApi,
  MaskedConfigPayload,
  ServerOverviewPayload,
  ServerProfileSummary,
} from '../shared/ipc-contract.js';

declare global {
  interface Window {
    adasDesktop?: DesktopBridgeApi;
  }
}

type TabId = 'overview' | 'services' | 'logs' | 'backups' | 'config' | 'security';

const TAB_TITLES: Record<TabId, string> = {
  overview: 'Overview & health',
  services: 'Services & releases',
  logs: 'Logs & diagnostics',
  backups: 'Backups & recovery',
  config: 'Configuration & secrets',
  security: 'Security & audit',
};

/**
 * Fallback loopback preview bridge used ONLY when running `pnpm --filter @adas/desktop preview`
 * in a standard browser for visual QA. Inside Electron, `window.adasDesktop` is injected by
 * the sandboxed preload bridge (`preload/index.cjs`) and `connect-src 'none'` is enforced.
 */
function createBridge(): DesktopBridgeApi {
  if (window.adasDesktop) {
    return window.adasDesktop;
  }
  const invokeHttp = async <T>(channel: string, payload: unknown): Promise<T> => {
    const res = await fetch('/__ipc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload }),
    });
    const body = (await res.json()) as { ok: boolean; data?: T; error?: string };
    if (!res.ok || !body.ok) {
      throw new Error(body.error ?? `Bridge error (${res.status})`);
    }
    return body.data as T;
  };

  return {
    listProfiles: () => invokeHttp('adas-desktop:profiles:list', {}),
    connectLocalServer: (i) => invokeHttp('adas-desktop:profiles:connect-local', i),
    pairRemoteServer: (i) => invokeHttp('adas-desktop:profiles:pair-remote', i),
    removeProfile: (i) => invokeHttp('adas-desktop:profiles:remove', i),
    getOverview: (i) => invokeHttp('adas-desktop:server:overview', i),
    controlService: (i) => invokeHttp('adas-desktop:server:service-control', i),
    deployRelease: (i) => invokeHttp('adas-desktop:server:deploy', i),
    rollbackRelease: (i) => invokeHttp('adas-desktop:server:rollback', i),
    runMigrations: (i) => invokeHttp('adas-desktop:server:migrate', i),
    getLogs: (i) => invokeHttp('adas-desktop:server:logs', i),
    exportDiagnostics: (i) => invokeHttp('adas-desktop:server:diagnostics', i),
    getBackups: (i) => invokeHttp('adas-desktop:server:backups-list', i),
    runBackup: (i) => invokeHttp('adas-desktop:server:backup-run', i),
    runRestoreDrill: (i) => invokeHttp('adas-desktop:server:backup-drill', i),
    restoreBackup: (i) => invokeHttp('adas-desktop:server:backup-restore', i),
    getConfig: (i) => invokeHttp('adas-desktop:server:config-get', i),
    updateConfig: (i) => invokeHttp('adas-desktop:server:config-update', i),
    getAuditAndClients: (i) => invokeHttp('adas-desktop:server:audit-clients', i),
    revokeClient: (i) => invokeHttp('adas-desktop:server:revoke-client', i),
  };
}

const api = createBridge();

let profiles: ServerProfileSummary[] = [];
let activeProfileId: string | null = null;
let activeTab: TabId = 'overview';
let pendingRestoreFile: string | null = null;

let logFilterState: {
  service: 'postgres' | 'api' | 'worker' | 'backup' | 'uptime-kuma' | 'cloudflared' | 'n8n';
  level: 'all' | 'info' | 'warn' | 'error';
  query: string;
} = {
  service: 'api',
  level: 'all',
  query: '',
};

const profileSelect = document.getElementById('profileSelect') as HTMLSelectElement;
const pageHeading = document.getElementById('pageHeading') as HTMLElement;
const roleBadge = document.getElementById('serverRoleBadge') as HTMLElement;
const btnRemoveServer = document.getElementById('btnRemoveServer') as HTMLButtonElement;
const mainEl = document.getElementById('panel-main') as HTMLElement;
const bannerEl = document.getElementById('statusBanner') as HTMLElement;

const pairDialog = document.getElementById('pairDialog') as HTMLDialogElement;
const pairForm = document.getElementById('pairForm') as HTMLFormElement;
const restoreDialog = document.getElementById('restoreDialog') as HTMLDialogElement;
const restoreForm = document.getElementById('restoreForm') as HTMLFormElement;

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'Unavailable';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function showBanner(message: string, isError = false): void {
  bannerEl.textContent = message;
  bannerEl.className = isError ? 'banner error' : 'banner';
  bannerEl.hidden = false;
}

function clearBanner(): void {
  bannerEl.hidden = true;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: { className?: string; text?: string } = {},
  children: Array<Node | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.className) node.className = attrs.className;
  if (attrs.text !== undefined) node.textContent = attrs.text;
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

function statusPill(label: string, tone: 'success' | 'warning' | 'danger' | 'neutral' | 'brand') {
  return el('span', { className: `pill ${tone}`, text: label });
}

function renderProfilePicker(): void {
  profileSelect.innerHTML = '';
  if (profiles.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No server connected';
    profileSelect.appendChild(opt);
    roleBadge.hidden = true;
    btnRemoveServer.hidden = true;
    return;
  }

  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.mode})`;
    if (p.id === activeProfileId) opt.selected = true;
    profileSelect.appendChild(opt);
  }

  const active = profiles.find((p) => p.id === activeProfileId);
  if (active) {
    roleBadge.textContent = `Role: ${active.role}`;
    roleBadge.hidden = false;
    btnRemoveServer.hidden = false;
  }
}

function renderEmptyNoServer(): void {
  mainEl.innerHTML = '';
  const connectBtn = el('button', {
    className: 'btn primary',
    text: 'Connect local server',
  });
  connectBtn.type = 'button';
  connectBtn.addEventListener('click', () => void handleConnectLocal());

  const pairBtn = el('button', {
    className: 'btn',
    text: 'Pair remote server',
  });
  pairBtn.type = 'button';
  pairBtn.addEventListener('click', () => pairDialog.showModal());

  const actions = el('div', { className: 'row-actions' }, [connectBtn, pairBtn]);
  actions.style.justifyContent = 'center';
  actions.style.marginTop = '14px';

  mainEl.appendChild(
    el('section', { className: 'empty-state' }, [
      el('h2', { text: 'No server connected yet' }),
      el('p', {
        className: 'muted',
        text: 'Connect to the local server agent on this machine or pair a remote office server with a one-time code.',
      }),
      actions,
    ]),
  );
}

function renderLoading(): void {
  mainEl.innerHTML = '';
  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('p', { className: 'muted', text: 'Loading live server telemetry…' }),
    ]),
  );
}

function renderErrorState(message: string): void {
  mainEl.innerHTML = '';
  const retryBtn = el('button', { className: 'btn primary', text: 'Try again' });
  retryBtn.type = 'button';
  retryBtn.addEventListener('click', () => void renderActiveTab());
  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('h2', { className: 'panel-title', text: 'Could not reach server agent' }),
      el('p', { className: 'muted', text: message }),
      retryBtn,
    ]),
  );
}

function renderOverview(data: ServerOverviewPayload): void {
  mainEl.innerHTML = '';
  const t = data.telemetry;

  const memCard = el('div', { className: 'kpi-card' }, [
    el('div', { className: 'kpi-label', text: 'Memory usage' }),
    el('div', { className: 'kpi-value', text: `${t.memoryUsedPercent.toFixed(1)}%` }),
    el('div', {
      className: 'kpi-sub',
      text: `${formatBytes(t.memoryTotalBytes - t.memoryFreeBytes)} of ${formatBytes(t.memoryTotalBytes)}`,
    }),
  ]);
  const memBar = el('div', { className: 'meter' });
  const memFill = el('div', { className: 'meter-fill' });
  memFill.style.width = `${Math.min(100, Math.max(0, t.memoryUsedPercent))}%`;
  memBar.appendChild(memFill);
  memCard.appendChild(memBar);

  const diskPct = t.diskUsedPercent ?? 0;
  const diskCard = el('div', { className: 'kpi-card' }, [
    el('div', { className: 'kpi-label', text: 'SSD storage' }),
    el('div', {
      className: 'kpi-value',
      text: t.diskUsedPercent !== null ? `${t.diskUsedPercent.toFixed(1)}%` : 'Available',
    }),
    el('div', {
      className: 'kpi-sub',
      text: `${formatBytes(t.diskFreeBytes)} free`,
    }),
  ]);
  const diskBar = el('div', { className: 'meter' });
  const diskFill = el('div', { className: 'meter-fill' });
  diskFill.style.width = `${Math.min(100, Math.max(0, diskPct))}%`;
  diskBar.appendChild(diskFill);
  diskCard.appendChild(diskBar);

  const cpuCard = el('div', { className: 'kpi-card' }, [
    el('div', { className: 'kpi-label', text: 'CPU & host uptime' }),
    el('div', { className: 'kpi-value', text: `${t.cpuCount} threads` }),
    el('div', {
      className: 'kpi-sub',
      text: `Uptime ${formatDuration(t.uptimeSeconds)} · ${t.hostname}`,
    }),
  ]);

  const releaseCard = el('div', { className: 'kpi-card' }, [
    el('div', { className: 'kpi-label', text: 'Active release' }),
    el('div', { className: 'kpi-value', text: t.activeReleaseTag ?? 'Not deployed' }),
    el('div', {
      className: 'kpi-sub',
      text: t.previousReleaseTag
        ? `Previous rollback tag: ${t.previousReleaseTag}`
        : 'No previous tag recorded',
    }),
  ]);

  mainEl.appendChild(
    el('div', { className: 'kpi-grid' }, [cpuCard, memCard, diskCard, releaseCard]),
  );

  // Readiness & Tunnel status panel
  const healthTone = t.crmHealth.ok ? 'success' : 'warning';
  const tunnelTone = t.cloudflaredConfigured ? 'success' : 'neutral';

  const readinessRows = el('tbody');
  readinessRows.appendChild(
    el('tr', {}, [
      el('td', { text: 'CRM HTTP /healthz readiness' }),
      el('td', {}, [statusPill(t.crmHealth.ok ? 'Healthy' : 'Unreachable', healthTone)]),
      el('td', { text: t.crmHealth.detail }),
    ]),
  );
  readinessRows.appendChild(
    el('tr', {}, [
      el('td', { text: 'Cloudflare Tunnel credentials' }),
      el('td', {}, [
        statusPill(t.cloudflaredConfigured ? 'Configured' : 'Not configured', tunnelTone),
      ]),
      el('td', {
        text: t.cloudflaredConfigured
          ? 'Outbound tunnel credentials detected on server'
          : 'Provision tunnel credentials in Configuration & secrets',
      }),
    ]),
  );

  for (const c of data.containers) {
    const tone = c.state === 'running' ? 'success' : c.state === 'degraded' ? 'danger' : 'neutral';
    readinessRows.appendChild(
      el('tr', {}, [
        el('td', { text: `Service: ${c.service}` }),
        el('td', {}, [statusPill(c.state.replace('_', ' '), tone)]),
        el('td', { text: c.statusDetail }),
      ]),
    );
  }

  const tableWrap = el('div', { className: 'table-scroll' });
  tableWrap.tabIndex = 0;
  tableWrap.setAttribute('role', 'region');
  tableWrap.setAttribute('aria-label', 'Subsystem readiness');
  const tbl = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Subsystem' }),
        el('th', { text: 'Status' }),
        el('th', { text: 'Details' }),
      ]),
    ]),
    readinessRows,
  ]);
  tableWrap.appendChild(tbl);

  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('div', { className: 'panel-head' }, [
        el('h2', { className: 'panel-title', text: 'Application, worker, and tunnel health' }),
      ]),
      tableWrap,
    ]),
  );
}

function renderServicesAndReleases(data: ServerOverviewPayload): void {
  mainEl.innerHTML = '';
  const profileId = data.profile.id;

  // Release deployment & migration card
  const tagInput = el('input') as HTMLInputElement;
  tagInput.id = 'deployTagInput';
  tagInput.value = data.telemetry.activeReleaseTag ?? 'v1.0.0';

  const deployBtn = el('button', { className: 'btn primary', text: 'Deploy release' });
  deployBtn.type = 'button';
  deployBtn.addEventListener('click', async () => {
    try {
      const res = await api.deployRelease({
        profileId,
        imageTag: tagInput.value.trim(),
      });
      showBanner(
        res.rolledBack
          ? `Health check failed; automatically rolled back to ${res.activeTag}.`
          : `Deployed release ${res.activeTag}.`,
        res.rolledBack,
      );
      await renderActiveTab();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Deploy failed', true);
    }
  });

  const migrateBtn = el('button', { className: 'btn', text: 'Run migrations' });
  migrateBtn.type = 'button';
  migrateBtn.addEventListener('click', async () => {
    try {
      const res = await api.runMigrations({ profileId });
      showBanner(res.output);
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Migration failed', true);
    }
  });

  const rollbackBtn = el('button', { className: 'btn danger-outline', text: 'Rollback release' });
  rollbackBtn.type = 'button';
  rollbackBtn.addEventListener('click', async () => {
    try {
      const res = await api.rollbackRelease({ profileId });
      showBanner(`Rolled back stack to ${res.restoredTag}.`);
      await renderActiveTab();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Rollback failed', true);
    }
  });

  const tagField = el('div', { className: 'field' }, [
    el('label', { text: 'Release image tag' }),
    tagInput,
  ]);
  (tagField.firstChild as HTMLLabelElement).htmlFor = 'deployTagInput';

  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('div', { className: 'panel-head' }, [
        el('h2', { className: 'panel-title', text: 'Release deployment, migrations & rollback' }),
      ]),
      el('div', { className: 'toolbar' }, [tagField, deployBtn, migrateBtn, rollbackBtn]),
    ]),
  );

  // Containers control table
  const tbody = el('tbody');
  for (const c of data.containers) {
    const tone = c.state === 'running' ? 'success' : c.state === 'degraded' ? 'danger' : 'neutral';
    const actionsDiv = el('div', { className: 'row-actions' });
    for (const act of ['start', 'restart', 'stop'] as const) {
      const b = el('button', {
        className: 'btn small',
        text: act.charAt(0).toUpperCase() + act.slice(1),
      });
      b.type = 'button';
      b.setAttribute('aria-label', `${act} ${c.service}`);
      b.addEventListener('click', async () => {
        try {
          const out = await api.controlService({
            profileId,
            service: c.service,
            action: act,
          });
          showBanner(out.output);
          await renderActiveTab();
        } catch (err) {
          showBanner(err instanceof Error ? err.message : 'Service action failed', true);
        }
      });
      actionsDiv.appendChild(b);
    }

    tbody.appendChild(
      el('tr', {}, [
        el('td', { text: c.service }),
        el('td', {}, [statusPill(c.state.replace('_', ' '), tone)]),
        el('td', { text: c.statusDetail }),
        el('td', {}, [actionsDiv]),
      ]),
    );
  }

  const wrap = el('div', { className: 'table-scroll' });
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', 'Managed containers');
  wrap.appendChild(
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Service' }),
          el('th', { text: 'State' }),
          el('th', { text: 'Details' }),
          el('th', { text: 'Controls' }),
        ]),
      ]),
      tbody,
    ]),
  );

  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('div', { className: 'panel-head' }, [
        el('h2', { className: 'panel-title', text: 'Container lifecycle controls' }),
      ]),
      wrap,
    ]),
  );
}

async function renderLogsSection(profileId: string): Promise<void> {
  const logsData = await api.getLogs({
    profileId,
    service: logFilterState.service,
    lines: 150,
    level: logFilterState.level,
    query: logFilterState.query || undefined,
  });

  mainEl.innerHTML = '';

  const svcSelect = el('select') as HTMLSelectElement;
  svcSelect.id = 'logServiceSelect';
  for (const s of [
    'api',
    'worker',
    'postgres',
    'backup',
    'uptime-kuma',
    'cloudflared',
    'n8n',
  ] as const) {
    const o = el('option', { text: s });
    o.value = s;
    if (s === logFilterState.service) o.selected = true;
    svcSelect.appendChild(o);
  }

  const lvlSelect = el('select') as HTMLSelectElement;
  lvlSelect.id = 'logLevelSelect';
  for (const l of ['all', 'info', 'warn', 'error'] as const) {
    const o = el('option', { text: l.toUpperCase() });
    o.value = l;
    if (l === logFilterState.level) o.selected = true;
    lvlSelect.appendChild(o);
  }

  const qInput = el('input') as HTMLInputElement;
  qInput.id = 'logQueryInput';
  qInput.placeholder = 'Filter log text…';
  qInput.value = logFilterState.query;

  const filterBtn = el('button', { className: 'btn primary', text: 'Load logs' });
  filterBtn.type = 'button';
  filterBtn.addEventListener('click', () => {
    logFilterState = {
      service: svcSelect.value as typeof logFilterState.service,
      level: lvlSelect.value as typeof logFilterState.level,
      query: qInput.value,
    };
    void renderActiveTab();
  });

  const diagBtn = el('button', { className: 'btn', text: 'Export diagnostics bundle' });
  diagBtn.type = 'button';
  diagBtn.addEventListener('click', async () => {
    try {
      const res = await api.exportDiagnostics({ profileId });
      showBanner(
        res.savedPath
          ? `Diagnostics bundle saved to ${res.savedPath}`
          : 'Diagnostics export cancelled.',
      );
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Diagnostics export failed', true);
    }
  });

  const svcField = el('div', { className: 'field' }, [el('label', { text: 'Service' }), svcSelect]);
  (svcField.firstChild as HTMLLabelElement).htmlFor = 'logServiceSelect';
  const lvlField = el('div', { className: 'field' }, [
    el('label', { text: 'Severity' }),
    lvlSelect,
  ]);
  (lvlField.firstChild as HTMLLabelElement).htmlFor = 'logLevelSelect';
  const qField = el('div', { className: 'field' }, [el('label', { text: 'Search' }), qInput]);
  (qField.firstChild as HTMLLabelElement).htmlFor = 'logQueryInput';

  const logOutput = el('pre', {
    className: 'log-box',
    text:
      logsData.lines.length > 0
        ? logsData.lines.join('\n')
        : 'No matching log lines (emails and secrets are automatically redacted).',
  });
  logOutput.tabIndex = 0;

  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('div', { className: 'panel-head' }, [
        el('h2', { className: 'panel-title', text: 'Redacted service logs & diagnostics' }),
        diagBtn,
      ]),
      el('div', { className: 'toolbar' }, [svcField, lvlField, qField, filterBtn]),
      logOutput,
    ]),
  );
}

async function renderBackupsSection(profileId: string): Promise<void> {
  const { backups } = await api.getBackups({ profileId });
  mainEl.innerHTML = '';

  const runBtn = el('button', { className: 'btn primary', text: 'Run encrypted backup' });
  runBtn.type = 'button';
  runBtn.addEventListener('click', async () => {
    try {
      const res = await api.runBackup({ profileId });
      showBanner(res.output);
      await renderActiveTab();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Backup failed', true);
    }
  });

  const drillBtn = el('button', { className: 'btn', text: 'Run restore drill' });
  drillBtn.type = 'button';
  drillBtn.addEventListener('click', async () => {
    try {
      const res = await api.runRestoreDrill({ profileId });
      showBanner(res.output);
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Restore drill failed', true);
    }
  });

  const tbody = el('tbody');
  if (backups.length === 0) {
    const emptyTd = el('td', {
      className: 'muted',
      text: 'No local encrypted .adasbk archives found in data/backups yet.',
    });
    emptyTd.colSpan = 5;
    tbody.appendChild(el('tr', {}, [emptyTd]));
  } else {
    for (const b of backups) {
      const restoreBtn = el('button', {
        className: 'btn small danger-outline',
        text: 'Restore',
      });
      restoreBtn.type = 'button';
      restoreBtn.addEventListener('click', () => {
        pendingRestoreFile = b.fileName;
        const promptEl = document.getElementById('restorePromptText') as HTMLElement;
        promptEl.textContent = `Type "RESTORE DATABASE ${b.fileName}" to overwrite the active database from this encrypted archive.`;
        (document.getElementById('restoreConfirmInput') as HTMLInputElement).value = '';
        restoreDialog.showModal();
      });

      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: b.fileName }),
          el('td', { text: formatBytes(b.sizeBytes) }),
          el('td', { text: b.createdAt.slice(0, 19).replace('T', ' ') }),
          el('td', {}, [
            statusPill(
              b.hasValidMagicHeader ? 'AES-256-GCM verified' : 'Invalid header',
              b.hasValidMagicHeader ? 'success' : 'danger',
            ),
          ]),
          el('td', {}, [restoreBtn]),
        ]),
      );
    }
  }

  const wrap = el('div', { className: 'table-scroll' });
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', 'Encrypted backups');
  wrap.appendChild(
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Archive file' }),
          el('th', { text: 'Size' }),
          el('th', { text: 'Created (UTC)' }),
          el('th', { text: 'Envelope' }),
          el('th', { text: 'Recovery' }),
        ]),
      ]),
      tbody,
    ]),
  );

  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('div', { className: 'panel-head' }, [
        el('h2', { className: 'panel-title', text: 'Encrypted backups & verified restore drills' }),
        el('div', { className: 'row-actions' }, [drillBtn, runBtn]),
      ]),
      wrap,
    ]),
  );
}

async function renderConfigSection(profileId: string): Promise<void> {
  const cfg: MaskedConfigPayload = await api.getConfig({ profileId });
  mainEl.innerHTML = '';

  const envInputs = new Map<string, HTMLInputElement>();
  const envGrid = el('div', { className: 'form-grid' });

  for (const [key, val] of Object.entries(cfg.values)) {
    const input = el('input') as HTMLInputElement;
    input.id = `cfg_${key}`;
    input.value = val;
    envInputs.set(key, input);
    const label = el('label', { text: key });
    label.htmlFor = input.id;
    envGrid.appendChild(el('div', { className: 'field' }, [label, input]));
  }

  const saveEnvBtn = el('button', { className: 'btn primary', text: 'Save configuration' });
  saveEnvBtn.type = 'button';
  saveEnvBtn.addEventListener('click', async () => {
    const values: Record<string, string> = {};
    for (const [k, inp] of envInputs.entries()) {
      values[k] = inp.value;
    }
    try {
      const res = await api.updateConfig({ profileId, values });
      showBanner(`Saved ${res.updatedKeys.length} configuration settings.`);
      await renderActiveTab();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Failed to save configuration', true);
    }
  });

  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('div', { className: 'panel-head' }, [
        el('h2', { className: 'panel-title', text: 'Production environment settings' }),
        saveEnvBtn,
      ]),
      envGrid,
    ]),
  );

  // Masked secret slots
  const secretInputs = new Map<string, HTMLInputElement>();
  const secretBody = el('tbody');
  for (const slot of cfg.secrets) {
    const inp = el('input') as HTMLInputElement;
    inp.type = 'password';
    inp.placeholder = slot.configured ? 'Leave blank to preserve secret' : 'Enter new secret value';
    inp.setAttribute('aria-label', `New value for ${slot.fileName}`);
    secretInputs.set(slot.fileName, inp);

    secretBody.appendChild(
      el('tr', {}, [
        el('td', { text: slot.fileName }),
        el('td', {}, [
          statusPill(
            slot.configured ? 'Configured' : 'Not set',
            slot.configured ? 'success' : 'neutral',
          ),
        ]),
        el('td', { text: slot.updatedAt ? slot.updatedAt.slice(0, 19).replace('T', ' ') : '—' }),
        el('td', {}, [el('div', { className: 'field' }, [inp])]),
      ]),
    );
  }

  const rotateBtn = el('button', { className: 'btn', text: 'Apply secret rotations' });
  rotateBtn.type = 'button';
  rotateBtn.addEventListener('click', async () => {
    const rotateSecrets: Record<string, string> = {};
    for (const [fileName, inp] of secretInputs.entries()) {
      if (inp.value.trim().length > 0) {
        rotateSecrets[fileName] = inp.value.trim();
      }
    }
    if (Object.keys(rotateSecrets).length === 0) {
      showBanner('Enter at least one new secret value to rotate.');
      return;
    }
    try {
      const res = await api.updateConfig({ profileId, rotateSecrets });
      showBanner(`Rotated ${res.rotatedSecrets.length} secret file(s). Restart services to apply.`);
      await renderActiveTab();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Secret rotation failed', true);
    }
  });

  const secretWrap = el('div', { className: 'table-scroll' });
  secretWrap.tabIndex = 0;
  secretWrap.setAttribute('role', 'region');
  secretWrap.setAttribute('aria-label', 'Secret files');
  secretWrap.appendChild(
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Secret file' }),
          el('th', { text: 'Status' }),
          el('th', { text: 'Updated (UTC)' }),
          el('th', { text: 'Write-only rotation' }),
        ]),
      ]),
      secretBody,
    ]),
  );

  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('div', { className: 'panel-head' }, [
        el('h2', {
          className: 'panel-title',
          text: 'Vault secret slots (values are never transmitted to console)',
        }),
        rotateBtn,
      ]),
      secretWrap,
    ]),
  );
}

async function renderSecuritySection(profileId: string): Promise<void> {
  const data: AuditAndClientsPayload = await api.getAuditAndClients({ profileId });
  mainEl.innerHTML = '';

  const chainBadge = statusPill(
    data.integrity.valid
      ? `Hash chain verified (${data.integrity.checkedCount} entries)`
      : `Chain broken at #${data.integrity.brokenAtIndex}`,
    data.integrity.valid ? 'success' : 'danger',
  );

  const clientsBody = el('tbody');
  for (const c of data.clients) {
    const actionCell = el('td');
    if (!c.revokedAt) {
      const revBtn = el('button', { className: 'btn small danger-outline', text: 'Revoke' });
      revBtn.type = 'button';
      revBtn.addEventListener('click', async () => {
        try {
          await api.revokeClient({ profileId, keyId: c.keyId });
          showBanner(`Revoked client ${c.keyId}.`);
          await renderActiveTab();
        } catch (err) {
          showBanner(err instanceof Error ? err.message : 'Revoke failed', true);
        }
      });
      actionCell.appendChild(revBtn);
    } else {
      actionCell.textContent = 'Revoked';
    }

    clientsBody.appendChild(
      el('tr', {}, [
        el('td', { text: c.clientName }),
        el('td', { text: c.keyId }),
        el('td', {}, [statusPill(c.role, 'brand')]),
        el('td', { text: c.lastUsedAt ? c.lastUsedAt.slice(0, 19).replace('T', ' ') : 'Never' }),
        actionCell,
      ]),
    );
  }

  const clientsWrap = el('div', { className: 'table-scroll' });
  clientsWrap.tabIndex = 0;
  clientsWrap.setAttribute('role', 'region');
  clientsWrap.setAttribute('aria-label', 'Paired desktop clients');
  clientsWrap.appendChild(
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Device' }),
          el('th', { text: 'Key ID' }),
          el('th', { text: 'Role' }),
          el('th', { text: 'Last active' }),
          el('th', { text: 'Access' }),
        ]),
      ]),
      clientsBody,
    ]),
  );

  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('div', { className: 'panel-head' }, [
        el('h2', { className: 'panel-title', text: 'Paired desktop consoles' }),
      ]),
      clientsWrap,
    ]),
  );

  const auditBody = el('tbody');
  for (const entry of data.entries) {
    const tone =
      entry.outcome === 'success' ? 'success' : entry.outcome === 'denied' ? 'danger' : 'warning';
    auditBody.appendChild(
      el('tr', {}, [
        el('td', { text: entry.timestamp.slice(0, 19).replace('T', ' ') }),
        el('td', { text: `${entry.actorName} (${entry.actorRole})` }),
        el('td', { text: entry.action }),
        el('td', {}, [statusPill(entry.outcome, tone)]),
        el('td', { text: `${entry.entryHash.slice(0, 14)}…` }),
      ]),
    );
  }

  const auditWrap = el('div', { className: 'table-scroll' });
  auditWrap.tabIndex = 0;
  auditWrap.setAttribute('role', 'region');
  auditWrap.setAttribute('aria-label', 'Admin action audit log');
  auditWrap.appendChild(
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Time (UTC)' }),
          el('th', { text: 'Actor' }),
          el('th', { text: 'Action' }),
          el('th', { text: 'Outcome' }),
          el('th', { text: 'Chain hash' }),
        ]),
      ]),
      auditBody,
    ]),
  );

  mainEl.appendChild(
    el('section', { className: 'panel' }, [
      el('div', { className: 'panel-head' }, [
        el('h2', { className: 'panel-title', text: 'Tamper-evident admin action audit log' }),
        chainBadge,
      ]),
      auditWrap,
    ]),
  );
}

async function renderActiveTab(): Promise<void> {
  pageHeading.textContent = TAB_TITLES[activeTab];
  if (!activeProfileId) {
    renderEmptyNoServer();
    return;
  }

  renderLoading();
  try {
    if (activeTab === 'overview') {
      renderOverview(await api.getOverview({ profileId: activeProfileId }));
    } else if (activeTab === 'services') {
      renderServicesAndReleases(await api.getOverview({ profileId: activeProfileId }));
    } else if (activeTab === 'logs') {
      await renderLogsSection(activeProfileId);
    } else if (activeTab === 'backups') {
      await renderBackupsSection(activeProfileId);
    } else if (activeTab === 'config') {
      await renderConfigSection(activeProfileId);
    } else if (activeTab === 'security') {
      await renderSecuritySection(activeProfileId);
    }
  } catch (err) {
    renderErrorState(err instanceof Error ? err.message : 'Unexpected agent error');
  }
}

async function refreshProfiles(): Promise<void> {
  const res = await api.listProfiles();
  profiles = res.profiles;
  if (!activeProfileId || !profiles.some((p) => p.id === activeProfileId)) {
    activeProfileId = profiles[0]?.id ?? null;
  }
  renderProfilePicker();
  await renderActiveTab();
}

async function handleConnectLocal(): Promise<void> {
  clearBanner();
  try {
    const { profile } = await api.connectLocalServer({ name: 'Local ADAS server' });
    activeProfileId = profile.id;
    showBanner(`Connected and paired with ${profile.serverName}.`);
    await refreshProfiles();
  } catch (err) {
    showBanner(err instanceof Error ? err.message : 'Local connection failed', true);
  }
}

// Wire navigation tabs
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    const nextTab = btn.dataset['tab'] as TabId | undefined;
    if (!nextTab) return;
    activeTab = nextTab;
    for (const b of tabButtons) {
      const selected = b === btn;
      b.classList.toggle('active', selected);
      b.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    void renderActiveTab();
  });
}

profileSelect.addEventListener('change', () => {
  activeProfileId = profileSelect.value || null;
  renderProfilePicker();
  void renderActiveTab();
});

document.getElementById('btnAddLocal')?.addEventListener('click', () => void handleConnectLocal());
document
  .getElementById('btnOpenPairModal')
  ?.addEventListener('click', () => pairDialog.showModal());
document.getElementById('btnCancelPair')?.addEventListener('click', () => pairDialog.close());
document.getElementById('btnCancelRestore')?.addEventListener('click', () => restoreDialog.close());

document.getElementById('btnRefresh')?.addEventListener('click', () => {
  clearBanner();
  void renderActiveTab();
});

btnRemoveServer.addEventListener('click', async () => {
  if (!activeProfileId) return;
  await api.removeProfile({ profileId: activeProfileId });
  activeProfileId = null;
  showBanner('Disconnected server profile from local vault.');
  await refreshProfiles();
});

pairForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { profile } = await api.pairRemoteServer({
      name: (document.getElementById('pairName') as HTMLInputElement).value,
      agentUrl: (document.getElementById('pairUrl') as HTMLInputElement).value,
      pairingCode: (document.getElementById('pairCode') as HTMLInputElement).value,
      cfAccessClientId:
        (document.getElementById('pairCfId') as HTMLInputElement).value || undefined,
      cfAccessClientSecret:
        (document.getElementById('pairCfSecret') as HTMLInputElement).value || undefined,
    });
    pairDialog.close();
    activeProfileId = profile.id;
    showBanner(`Paired with remote server ${profile.serverName}.`);
    await refreshProfiles();
  } catch (err) {
    showBanner(err instanceof Error ? err.message : 'Remote pairing failed', true);
  }
});

restoreForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeProfileId || !pendingRestoreFile) return;
  try {
    const phrase = (document.getElementById('restoreConfirmInput') as HTMLInputElement).value;
    const res = await api.restoreBackup({
      profileId: activeProfileId,
      fileName: pendingRestoreFile,
      confirmationPhrase: phrase,
    });
    restoreDialog.close();
    showBanner(`Restored database from ${res.restoredFile}.`);
  } catch (err) {
    showBanner(err instanceof Error ? err.message : 'Database restore refused', true);
  }
});

void refreshProfiles();
