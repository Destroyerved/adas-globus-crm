import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import { DESKTOP_IPC_CHANNELS } from '../shared/ipc-contract.js';
import { DesktopIpcController } from './ipc-controller.js';
import { ServerProfileVault } from './profile-vault.js';
import {
  createHardenedWebPreferences,
  DESKTOP_CONTENT_SECURITY_POLICY,
  isAllowedNavigationUrl,
} from './security-policy.js';

/**
 * Standalone Electron Main Process Entrypoint (`@adas/desktop`).
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(currentDir, '..');
const defaultRepoRoot = path.resolve(distRoot, '..', '..', '..');

let controller: DesktopIpcController | null = null;

function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(distRoot, 'preload', 'index.cjs');
  const rendererHtmlPath = path.join(distRoot, 'renderer', 'index.html');
  const entryUrl = pathToFileURL(rendererHtmlPath).toString();

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 375,
    minHeight: 640,
    title: 'ADAS Globus CRM — Server Management Console',
    backgroundColor: '#fbfcfb',
    webPreferences: createHardenedWebPreferences(preloadPath),
  });

  // Block all external navigations and popups
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedNavigationUrl(navigationUrl, entryUrl)) {
      event.preventDefault();
    }
  });

  void win.loadFile(rendererHtmlPath);
  return win;
}

void app.whenReady().then(() => {
  // Deny all browser hardware permissions (camera, microphone, geolocation, notifications)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  // Enforce strict Content-Security-Policy on all local responses
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [DESKTOP_CONTENT_SECURITY_POLICY],
      },
    });
  });

  const vaultDir = path.join(app.getPath('userData'), 'vault');
  const vault = new ServerProfileVault(vaultDir, safeStorage);

  controller = new DesktopIpcController({
    vault,
    defaultRepoRoot,
    saveDiagnosticsFile: async (defaultFileName, jsonContent) => {
      const res = await dialog.showSaveDialog({
        title: 'Save Redacted Diagnostics Bundle',
        defaultPath: defaultFileName,
        filters: [{ name: 'JSON Bundle', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePath) return null;
      writeFileSync(res.filePath, jsonContent, 'utf8');
      return res.filePath;
    },
  });

  for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      const senderFrameUrl = event.senderFrame?.url ?? '';
      const expectedEntry = pathToFileURL(path.join(distRoot, 'renderer', 'index.html')).toString();
      if (senderFrameUrl && !isAllowedNavigationUrl(senderFrameUrl, expectedEntry)) {
        throw new Error('Unauthorized IPC sender origin.');
      }
      if (!controller) throw new Error('Desktop controller not initialized.');
      return controller.invokeChannel(channel, payload);
    });
  }

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (controller) {
    void controller.close();
  }
});
