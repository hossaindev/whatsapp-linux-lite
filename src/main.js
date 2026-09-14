'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, Notification, shell, session, dialog
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

let mainWindow    = null;
let tray          = null;
let isQuitting    = false;
let settings      = {};
let clearingCache = false;
let sleepTimer    = null;

// ─── Linux Low-Memory & Desktop Switches ──────────────────────────────────────
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,VaapiVideoDecoder,MemoryPurge');
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,OptimizationHints,Translate');
  app.commandLine.appendSwitch('enable-low-end-device-mode');
  app.commandLine.appendSwitch('renderer-process-limit', '1');
  app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=128');
}

const { cleanCache, sanitizeSettings, safeExternal } = require('./safety');

// ─── Pseudo-Sleep (Deep Background RAM Purge) ─────────────────────────────────
function schedulePseudoSleep() {
  if (!settings.pseudoSleep) return;
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(async () => {
    try {
      if (mainWindow && !mainWindow.isVisible()) {
        if (typeof global.gc === 'function') global.gc();
        const waSession = session.fromPartition('persist:whatsapp');
        await waSession.clearCache().catch(() => {});
        if (typeof waSession.clearCodeCaches === 'function') {
          await waSession.clearCodeCaches({}).catch(() => {});
        }
        if (typeof waSession.clearHostResolverCache === 'function') {
          await waSession.clearHostResolverCache().catch(() => {});
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('enter-pseudo-sleep');
          mainWindow.webContents.executeJavaScript('if (typeof window.gc === "function") window.gc();').catch(() => {});
        }
      }
    } catch (_) {}
  }, 3500);
}

function wakeFromPseudoSleep() {
  clearTimeout(sleepTimer);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('wake-pseudo-sleep');
  }
}

async function clearCache(parentWindow = null, notifyOnSuccess = false) {
  if (clearingCache) return { error: 'Cache cleanup is already running.' };

  const parent = (parentWindow && typeof parentWindow.isVisible === 'function' && parentWindow.isVisible() && !parentWindow.isMinimized())
    ? parentWindow
    : null;

  const answer = await dialog.showMessageBox(parent, {
    type: 'question',
    buttons: ['Cancel', 'Clear cache'],
    defaultId: 1,
    cancelId: 0,
    title: 'Clear Cache - WhatsApp Lite',
    message: 'Clear temporary browser cache?',
    detail: 'Your login, chats, cookies, and settings will be preserved. Avoid clearing cache during an active call.'
  });

  if (answer.response !== 1) return { cancelled: true };
  clearingCache = true;
  try {
    const bytes = await cleanCache(session.fromPartition('persist:whatsapp'));
    const mb = (bytes / (1024 * 1024)).toFixed(1);

    if (notifyOnSuccess || !parent) {
      if (Notification.isSupported()) {
        new Notification({
          title: 'WhatsApp Lite',
          body: `Cleared ${mb} MB of temporary cache. Login and chats preserved.`,
          icon: path.join(__dirname, '..', 'assets', 'icons', '256x256.png')
        }).show();
      } else {
        await dialog.showMessageBox(null, {
          type: 'info',
          title: 'WhatsApp Lite',
          message: `Cleared ${mb} MB of temporary cache.`
        });
      }
    }
    return { bytes };
  } catch (error) {
    if (notifyOnSuccess || !parent) {
      dialog.showErrorBox('Cache Cleanup Error', error.message || 'Failed to clear cache.');
    }
    return { error: error.message };
  } finally {
    clearingCache = false;
  }
}

function openExternal(url) {
  if (safeExternal(url)) shell.openExternal(url).catch(console.error);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath))
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (_) { settings = {}; }
  const def = (k, v) => { if (settings[k] === undefined) settings[k] = v; };
  def('minimizeToTray',         false);
  def('closeToTray',            true);
  def('showUnreadCountInTitle', true);
  def('enableNotifications',    true);
  def('notificationSound',      true);
  def('startMinimized',         false);
  def('autoStart',              true);
  def('trayAppearance',         'color');
  def('pseudoSleep',            true);
}

function shouldStartHidden() {
  return process.argv.includes('--hidden') || settings.startMinimized;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath + '.tmp', JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(settingsPath + '.tmp', settingsPath);
  } catch (_) {}
}

// ─── Linux Autostart ──────────────────────────────────────────────────────────
function getAutostartFile() {
  return path.join(os.homedir(), '.config', 'autostart', 'whatsapp-linux-lite.desktop');
}

function setAutostart(enable) {
  const dir  = path.join(os.homedir(), '.config', 'autostart');
  const file = getAutostartFile();
  if (enable) {
    fs.mkdirSync(dir, { recursive: true });
    const exec = app.isPackaged
      ? `"${process.execPath}" --hidden`
      : `"${process.execPath}" "${path.join(__dirname, '..')}" --hidden`;
    fs.writeFileSync(file,
      ['[Desktop Entry]', 'Type=Application', 'Name=WhatsApp Lite',
       'Comment=Ultra-Lightweight WhatsApp Desktop for Linux', `Exec=${exec}`,
       'Icon=whatsapp-lite', 'Terminal=false', 'Hidden=false',
       'StartupWMClass=whatsapp-lite',
       'X-GNOME-Autostart-enabled=true'].join('\n') + '\n', 'utf8');
  } else {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

// ─── Tray Icon ────────────────────────────────────────────────────────────────
const trayIconCache = new Map();
let currentToolTip = 'WhatsApp Lite';

function loadValidatedIcon(fileName, targetSize = 22) {
  const cacheKey = `${fileName}_${targetSize}`;
  if (trayIconCache.has(cacheKey)) return trayIconCache.get(cacheKey);
  const p = path.join(__dirname, '..', 'assets', fileName);
  try {
    if (fs.existsSync(p)) {
      let img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        const size = img.getSize();
        if (size.width > 32 || size.height > 32) {
          img = img.resize({ width: targetSize, height: targetSize, quality: 'best' });
        }
        trayIconCache.set(cacheKey, img);
        return img;
      }
    }
  } catch (_) {}
  return null;
}

function getTrayIcon() {
  const appearance = settings.trayAppearance || 'color';
  const name = appearance === 'light' ? 'tray-icon-white.png'
    : appearance === 'dark' ? 'tray-icon-black.png'
    : 'tray-icon-color.png';

  return loadValidatedIcon(name, 22)
    || loadValidatedIcon('tray-icon-color.png', 22)
    || loadValidatedIcon('tray-icon.png', 22)
    || loadValidatedIcon('whatsapp-color.png', 22)
    || nativeImage.createEmpty();
}

function createTray() {
  try {
    if (tray && !tray.isDestroyed()) return tray;
    const icon = getTrayIcon();
    tray = new Tray(icon);
    tray.setToolTip(currentToolTip);
    if (typeof tray.setIgnoreDoubleClickEvents === 'function') {
      tray.setIgnoreDoubleClickEvents(true);
    }
    updateTrayMenu();
    tray.on('click', toggleWindow);
    tray.on('double-click', showWindow);
    return tray;
  } catch (err) {
    console.error('Tray creation failed:', err);
    tray = null;
    return null;
  }
}

function setupTrayWatcher() {
  if (process.platform !== 'linux') return;
  try {
    const dbus = require('dbus-next');
    const bus = dbus.sessionBus();
    bus.getProxyObject('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher')
      .then(proxy => {
        const iface = proxy.getInterface('org.kde.StatusNotifierWatcher');
        iface.on('StatusNotifierHostRegistered', () => {
          setTimeout(() => {
            try {
              if (tray && !tray.isDestroyed()) {
                tray.destroy();
                tray = null;
              }
              createTray();
            } catch (_) {}
          }, 1000);
        });
      })
      .catch(() => {});
  } catch (_) {}
}

function updateTrayMenu() {
  try {
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: mainWindow?.isVisible() ? 'Hide WhatsApp' : 'Open WhatsApp',
        click: toggleWindow
      },
      { type: 'separator' },
      {
        label: 'Clear Cache…',
        click: () => { clearCache(null, true); }
      },
      {
        label: 'Reload Page',
        click: () => { mainWindow?.webContents.reload(); }
      },
      { type: 'separator' },
      {
        label: 'Pseudo-Sleep (Save RAM)',
        type: 'checkbox',
        checked: settings.pseudoSleep,
        click: m => {
          settings.pseudoSleep = m.checked;
          saveSettings();
          updateTrayMenu();
          if (settings.pseudoSleep && !mainWindow?.isVisible()) schedulePseudoSleep();
          else wakeFromPseudoSleep();
        }
      },
      {
        label: 'Run in Background',
        type: 'checkbox',
        checked: settings.closeToTray,
        click: m => {
          settings.closeToTray = m.checked;
          saveSettings();
          updateTrayMenu();
        }
      },
      {
        label: 'Minimize to Tray',
        type: 'checkbox',
        checked: settings.minimizeToTray,
        click: m => { settings.minimizeToTray = m.checked; saveSettings(); }
      },
      {
        label: 'Launch at Login',
        type: 'checkbox',
        checked: settings.autoStart,
        click: m => { settings.autoStart = m.checked; saveSettings(); setAutostart(m.checked); }
      },
      {
        label: 'Notifications',
        type: 'checkbox',
        checked: settings.enableNotifications,
        click: m => { settings.enableNotifications = m.checked; saveSettings(); }
      },
      { type: 'separator' },
      {
        label: 'Quit WhatsApp Lite',
        click: () => { isQuitting = true; app.quit(); }
      }
    ]));
  } catch (err) {
    console.error('Update tray menu failed:', err);
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  wakeFromPseudoSleep();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  updateTrayMenu();
}

function hideWindow() {
  mainWindow?.hide();
  updateTrayMenu();
  schedulePseudoSleep();
}

function toggleWindow() {
  mainWindow?.isVisible() ? hideWindow() : showWindow();
}

// ─── Main Window (Single-Renderer Architecture) ──────────────────────────────
function createMainWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'WhatsApp',
    backgroundColor: '#111b21',
    icon: path.join(__dirname, '..', 'assets', 'icons', '256x256.png'),
    show: false,
    webPreferences: {
      partition: 'persist:whatsapp',
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true,
    },
  });

  mainWindow.webContents.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
  mainWindow.on('show', () => { wakeFromPseudoSleep(); updateTrayMenu(); });
  mainWindow.on('hide', () => { schedulePseudoSleep(); updateTrayMenu(); });

  mainWindow.on('minimize', e => {
    if (settings.minimizeToTray) {
      e.preventDefault();
      hideWindow();
    }
  });

  mainWindow.on('close', e => {
    if (!isQuitting && settings.closeToTray) {
      e.preventDefault();
      hideWindow();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === 'https://web.whatsapp.com') return; } catch (_) {}
    event.preventDefault();
    openExternal(url);
  });

  // Native Linux keyboard shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl  = input.control || input.meta;
    const shift = input.shift;
    const key   = input.key;

    if (ctrl && (key === 'q' || key === 'Q')) {
      event.preventDefault();
      isQuitting = true;
      app.quit();
    } else if (ctrl && (key === 'w' || key === 'W')) {
      event.preventDefault();
      if (settings.closeToTray) hideWindow();
      else mainWindow.close();
    } else if (ctrl && key === 'r' && !shift) {
      event.preventDefault(); mainWindow.webContents.reload();
    } else if ((ctrl && key === 'R' && shift) || key === 'F5') {
      event.preventDefault(); mainWindow.webContents.reloadIgnoringCache();
    } else if (input.alt && key === 'ArrowLeft') {
      event.preventDefault(); if (mainWindow.webContents.canGoBack()) mainWindow.webContents.goBack();
    } else if (input.alt && key === 'ArrowRight') {
      event.preventDefault(); if (mainWindow.webContents.canGoForward()) mainWindow.webContents.goForward();
    } else if (ctrl && (key === '=' || key === '+')) {
      event.preventDefault(); mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5);
    } else if (ctrl && key === '-') {
      event.preventDefault(); mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5);
    } else if (ctrl && key === '0') {
      event.preventDefault(); mainWindow.webContents.setZoomLevel(0);
    }
  });

  mainWindow.loadURL('https://web.whatsapp.com');

  mainWindow.once('ready-to-show', () => {
    if (!shouldStartHidden()) {
      mainWindow.show();
    } else {
      schedulePseudoSleep();
    }
  });
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
const { CallNotifications } = require('./call-notifications');
const callNotifications = new CallNotifications({
  icon: path.join(__dirname, '..', 'assets', 'icons', '256x256.png'),
  onAction: (action, id) => mainWindow?.webContents.send('call-action', { action, id }),
  onFailure: message => { new Notification({ title: 'WhatsApp call', body: message }).show(); }
});

ipcMain.on('call-state', (event, state) => {
  if (event.sender !== mainWindow?.webContents) return;
  if (!state?.active) { callNotifications.close(); return; }
  wakeFromPseudoSleep();
  if (settings.enableNotifications && typeof state.id === 'string') callNotifications.show(state.id);
});

ipcMain.on('call-result', (event, result) => {
  if (event.sender !== mainWindow?.webContents) return;
  if (!result?.ok) callNotifications.fail('Call action unavailable. Open WhatsApp to check the call.');
  else callNotifications.close();
});

ipcMain.on('unread-count', (_, count) => {
  currentToolTip = count > 0 ? `WhatsApp Lite (${count})` : 'WhatsApp Lite';
  try {
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(currentToolTip);
    } else {
      createTray();
    }
  } catch (_) {
    try { createTray(); } catch (_) {}
  }
});

ipcMain.on('wa-title', (_, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title || 'WhatsApp');
  }
});

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  loadSettings();
  app.setName('WhatsApp Lite');
  if (process.platform === 'linux' && typeof app.setDesktopName === 'function') {
    app.setDesktopName('whatsapp-lite.desktop');
  }

  const waSession = session.fromPartition('persist:whatsapp');
  const allowed = new Set(['media', 'notifications', 'fullscreen']);
  const trusted = url => {
    try { return new URL(url).origin === 'https://web.whatsapp.com'; } catch (_) { return false; }
  };
  waSession.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(allowed.has(permission) && trusted(details.requestingUrl || wc.getURL()))
  );
  waSession.setPermissionCheckHandler((wc, permission, origin) =>
    allowed.has(permission) && trusted(origin)
  );

  app.on('second-instance', showWindow);
  createMainWindow();
  try {
    createTray();
    setupTrayWatcher();
  } catch (error) {
    console.error(error);
    settings.closeToTray = false;
    showWindow();
  }
  try { setAutostart(settings.autoStart); } catch (error) { console.error(error); }
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => (mainWindow ? showWindow() : createMainWindow()));
app.on('before-quit', () => {
  isQuitting = true;
  clearTimeout(sleepTimer);
  callNotifications.close();
  tray?.destroy();
  tray = null;
});
