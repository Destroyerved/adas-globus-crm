'use strict';

/**
 * Sandboxed Electron Preload Bridge (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
 *
 * Exposes ONLY frozen, strictly enumerated async RPC methods on `window.adasDesktop`.
 * Never exposes `ipcRenderer`, `process`, `Buffer`, or arbitrary channel invocation.
 */
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  listProfiles: 'adas-desktop:profiles:list',
  connectLocal: 'adas-desktop:profiles:connect-local',
  pairRemote: 'adas-desktop:profiles:pair-remote',
  removeProfile: 'adas-desktop:profiles:remove',
  getOverview: 'adas-desktop:server:overview',
  controlService: 'adas-desktop:server:service-control',
  deployRelease: 'adas-desktop:server:deploy',
  rollbackRelease: 'adas-desktop:server:rollback',
  runMigrations: 'adas-desktop:server:migrate',
  getLogs: 'adas-desktop:server:logs',
  exportDiagnostics: 'adas-desktop:server:diagnostics',
  getBackups: 'adas-desktop:server:backups-list',
  runBackup: 'adas-desktop:server:backup-run',
  runRestoreDrill: 'adas-desktop:server:backup-drill',
  restoreBackup: 'adas-desktop:server:backup-restore',
  getConfig: 'adas-desktop:server:config-get',
  updateConfig: 'adas-desktop:server:config-update',
  getAuditAndClients: 'adas-desktop:server:audit-clients',
  revokeClient: 'adas-desktop:server:revoke-client',
});

const bridgeApi = Object.freeze({
  listProfiles: () => ipcRenderer.invoke(CHANNELS.listProfiles, {}),
  connectLocalServer: (input) => ipcRenderer.invoke(CHANNELS.connectLocal, input),
  pairRemoteServer: (input) => ipcRenderer.invoke(CHANNELS.pairRemote, input),
  removeProfile: (input) => ipcRenderer.invoke(CHANNELS.removeProfile, input),
  getOverview: (input) => ipcRenderer.invoke(CHANNELS.getOverview, input),
  controlService: (input) => ipcRenderer.invoke(CHANNELS.controlService, input),
  deployRelease: (input) => ipcRenderer.invoke(CHANNELS.deployRelease, input),
  rollbackRelease: (input) => ipcRenderer.invoke(CHANNELS.rollbackRelease, input),
  runMigrations: (input) => ipcRenderer.invoke(CHANNELS.runMigrations, input),
  getLogs: (input) => ipcRenderer.invoke(CHANNELS.getLogs, input),
  exportDiagnostics: (input) => ipcRenderer.invoke(CHANNELS.exportDiagnostics, input),
  getBackups: (input) => ipcRenderer.invoke(CHANNELS.getBackups, input),
  runBackup: (input) => ipcRenderer.invoke(CHANNELS.runBackup, input),
  runRestoreDrill: (input) => ipcRenderer.invoke(CHANNELS.runRestoreDrill, input),
  restoreBackup: (input) => ipcRenderer.invoke(CHANNELS.restoreBackup, input),
  getConfig: (input) => ipcRenderer.invoke(CHANNELS.getConfig, input),
  updateConfig: (input) => ipcRenderer.invoke(CHANNELS.updateConfig, input),
  getAuditAndClients: (input) => ipcRenderer.invoke(CHANNELS.getAuditAndClients, input),
  revokeClient: (input) => ipcRenderer.invoke(CHANNELS.revokeClient, input),
});

contextBridge.exposeInMainWorld('adasDesktop', bridgeApi);
