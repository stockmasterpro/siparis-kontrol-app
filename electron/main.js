import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, screen, protocol, net, shell, Notification } from 'electron';
import { exec } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, sep } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { autoUpdater } = require('electron-updater');

// Configure autoUpdater
autoUpdater.autoDownload = true; // Automatically download updates
autoUpdater.autoInstallOnAppQuit = true; // Install when app quits

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// License key validation
const LICENSE_KEY = '8F3KQ-9A7M2-LP5XW-4Z8N6-YT2RD';
let isLicensed = false;

// --- Auto Updater Integration ---

function setupAutoUpdater() {
  // Check for updates
  autoUpdater.on('checking-for-update', () => {
    console.log('[UPDATE] Checking for update...');
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[UPDATE] Update not available.');
    if (mainWindow) {
      mainWindow.webContents.send('update-message', {
        type: 'info',
        message: 'Uygulamanız güncel.'
      });
    }
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[UPDATE] Update available:', info.version);

    // Windows System Notification
    new Notification({
      title: 'Sipariş Kontrol - Güncelleme Mevcut',
      body: `Yeni sürüm (${info.version}) bulundu. Arka planda indiriliyor...`,
      icon: getIconPath(),
      silent: true
    }).show();

    if (mainWindow) {
      mainWindow.webContents.send('update-message', {
        type: 'available',
        version: info.version,
        message: `Yeni sürüm (${info.version}) mevcut. İndiriliyor...`
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[UPDATE] Error:', err);
    if (mainWindow) {
      mainWindow.webContents.send('update-message', {
        type: 'error',
        message: 'Güncelleme kontrolü sırasında hata oluştu.'
      });
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    let log_message = "Download speed: " + progressObj.bytesPerSecond;
    log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
    log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
    console.log('[UPDATE]', log_message);
    if (mainWindow) {
      mainWindow.webContents.send('update-message', {
        type: 'progress',
        percent: progressObj.percent
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[UPDATE] Update downloaded.');

    // Windows System Notification
    new Notification({
      title: 'Sipariş Kontrol - Güncelleme Hazır',
      body: `Yeni sürüm (${info.version}) başarıyla indirildi. Yüklemek için onayınız bekleniyor.`,
      icon: getIconPath(),
      silent: true
    }).show();

    if (mainWindow) {
      mainWindow.webContents.send('update-message', {
        type: 'downloaded',
        version: info.version,
        message: 'Güncelleme başarıyla indirildi. Yüklemek için uygulamayı yeniden başlatın.'
      });
    }
  });
}

// IPC Handlers for Updates
ipcMain.handle('check-for-updates', async () => {
  return autoUpdater.checkForUpdates();
});

ipcMain.handle('quit-and-install', async () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('open-external', async (event, url) => {
  try {
    const target = String(url || '').trim();
    if (!target) return false;
    await shell.openExternal(target);
    return true;
  } catch (err) {
    console.error('[OPEN-EXTERNAL] failed:', err);
    return false;
  }
});

// License validation function
function validateLicense(key) {
  if (!key) return false;
  // Normalize: Remove dashes, spaces, and make uppercase
  const normalizedInput = key.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const normalizedTarget = LICENSE_KEY.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return normalizedInput === normalizedTarget;
}

// Helper to resolve icon path
function getIconPath() {
  let iconPath;
  if (app.isPackaged) {
    // In production (ASAR) - looking in the resources/assets folder
    iconPath = join(process.resourcesPath, 'assets', 'icon.png');
    if (!existsSync(iconPath)) {
      iconPath = join(process.resourcesPath, 'assets', 'icon.ico');
    }
    if (!existsSync(iconPath)) {
      // Check adjacent to exe for manual installs
      iconPath = join(dirname(app.getPath('exe')), 'assets', 'icon.png');
    }
  } else {
    // In development
    iconPath = join(__dirname, '../assets/icon.png');
    if (!existsSync(iconPath)) {
      iconPath = join(__dirname, '../assets/icon.ico');
    }
  }

  if (existsSync(iconPath)) return iconPath;

  // Fallback to build folder if assets fails
  const buildIcon = join(__dirname, '../build/icon.png');
  if (existsSync(buildIcon)) return buildIcon;

  return null;
}

// Helper to get internal sounds path
function getSoundsDirectory() {
  const dir = join(app.getPath('userData'), 'sounds');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Helper to resolve sound path with robust fallbacks
function getSoundPath(customPath, type) {
  // 0. Handle silence option
  if (customPath === 'none') {
    return null;
  }

  // 1. If custom path provided
  if (customPath) {
    // If it's an absolute path and exists, use it (backward compatibility)
    if (existsSync(customPath)) {
      return customPath;
    }

    // If it's a simple filename, check in assets
    const fileName = customPath.split(/[/\\]/).pop();
    const assetTryPaths = [];
    if (app.isPackaged) {
      assetTryPaths.push(join(process.resourcesPath, 'assets', fileName));
      assetTryPaths.push(join(process.resourcesPath, 'app.asar.unpacked', 'assets', fileName));
      assetTryPaths.push(join(process.resourcesPath, 'app.asar.unpacked', 'public', 'assets', fileName));
      assetTryPaths.push(join(dirname(app.getPath('exe')), 'resources', 'assets', fileName));
      assetTryPaths.push(join(app.getAppPath(), '..', 'assets', fileName));
    } else {
      assetTryPaths.push(join(__dirname, '..', 'assets', fileName));
      assetTryPaths.push(join(__dirname, 'assets', fileName));
      assetTryPaths.push(join(__dirname, '../public/assets/sounds', fileName));
    }

    for (const p of assetTryPaths) {
      if (existsSync(p)) return p;
    }
  }

  // 2. Default logical fallbacks based on type
  const defaultFile = type === 'return' ? 'Crystal.wav' : (type === 'question' ? 'Clover.wav' : (type === 'update' ? 'notification.wav' : 'notification.wav'));

  const tryPaths = [];
  if (app.isPackaged) {
    tryPaths.push(join(process.resourcesPath, `assets/${defaultFile}`));
    tryPaths.push(join(dirname(app.getPath('exe')), `resources/assets/${defaultFile}`));
    tryPaths.push(join(app.getAppPath(), `../assets/${defaultFile}`));
    // Secondary fallback to standard notification
    if (defaultFile !== 'notification.wav') {
      tryPaths.push(join(process.resourcesPath, 'assets/notification.wav'));
    }
  } else {
    tryPaths.push(join(__dirname, `../assets/${defaultFile}`));
    tryPaths.push(join(__dirname, `assets/${defaultFile}`));
    if (defaultFile !== 'notification.wav') {
      tryPaths.push(join(__dirname, '../assets/notification.wav'));
    }
  }

  for (const p of tryPaths) {
    if (existsSync(p)) return p;
  }

  return tryPaths[0];
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Focus existing instance
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // App ready handler moved here
  app.whenReady().then(() => {
    // Register custom protocol for local images
    protocol.handle('app-img', (request) => {
      const { imagesBase, absolutePath } = resolveAppImagePath(request.url);

      if (!absolutePath.startsWith(imagesBase)) {
        console.error('Access denied for image path:', absolutePath);
        return new Response('Access Denied', { status: 403 });
      }

      try {
        return net.fetch(pathToFileURL(absolutePath).toString());
      } catch (e) {
        return new Response('Not Found', { status: 404 });
      }
    });

    app.setAppUserModelId("com.eticaret.desktop");

    // Initialize SQLite Database
    setupAutoUpdater();
    initSQLite().then(() => {
      createWindow();
      createTray();

      // Initial check for updates after a short delay
      setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify();
      }, 5000);
    }).catch(err => {
      console.error('Database initialization failed:', err);
      // Fallback to window creation even if DB fails initially
      createWindow();
      createTray();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

// Crash prevention - Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't crash the app, just log
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't crash the app, just log
});

let mainWindow = null;
let tray = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function getProductImagesBasePath() {
  return join(app.getPath('userData'), 'product_images');
}

function sanitizePathSegment(value) {
  return String(value || '').replace(/[<>:"/\\|?*]/g, '_').trim();
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function resolveAppImagePath(requestUrl) {
  const imagesBase = getProductImagesBasePath();
  const parsed = new URL(requestUrl);
  const rawCombined = `${parsed.hostname || ''}${parsed.pathname || ''}`;
  const cleaned = decodeURIComponent(rawCombined).replace(/^\/+/, '');
  const safeRelative = cleaned.split('/').filter(Boolean).join(sep);
  const absolutePath = join(imagesBase, safeRelative);
  return { imagesBase, absolutePath };
}

function createWindow() {
  // Check license first
  // Check license from file in userData
  const licensePath = join(app.getPath('userData'), 'license.key');
  let storedLicense = null;

  try {
    if (existsSync(licensePath)) {
      storedLicense = readFileSync(licensePath, 'utf-8').trim();
    }
  } catch (error) {
    console.error('Error reading license file:', error);
  }

  isLicensed = validateLicense(storedLicense);

  const iconPath = join(__dirname, '../build/icon.ico');
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const windowOptions = {
    width: Math.floor(screenWidth * 0.9),
    height: Math.floor(screenHeight * 0.9),
    minWidth: 1024,
    minHeight: 720,
    resizable: true,
    maximizable: true,
    minimizable: true,
    title: 'StockMaster Pro',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: false,
      preload: join(__dirname, 'preload.js'),
      webSecurity: true,
      backgroundThrottling: false, // Critical for background sync
    },
    show: false, // Don't show until ready
  };

  // Add icon only if it exists
  if (existsSync(iconPath)) {
    windowOptions.icon = iconPath;
  }

  // Remove menu bar
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow(windowOptions);

  // Handle window close - minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  // Show window when ready to prevent blank page
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.maximize();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevent blank page on navigation errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
    if (!isDev && errorCode !== -3) { // -3 is ERR_ABORTED, which is normal
      mainWindow?.loadFile(join(__dirname, '../dist/index.html'));
    }
  });

  // Handle crashes gracefully
  mainWindow.webContents.on('crashed', () => {
    console.error('Renderer process crashed');
    // Reload the window
    if (mainWindow) {
      mainWindow.reload();
    }
  });

  // Add context menu for copy/paste
  mainWindow.webContents.on('context-menu', (event, params) => {
    const template = [
      { label: 'Geri Al', role: 'undo', enabled: params.editFlags.canUndo },
      { label: 'Yinele', role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { label: 'Kes', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Kopyala', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Yapıştır', role: 'paste', enabled: params.editFlags.canPaste },
      { label: 'Sil', role: 'delete', enabled: params.isEditable },
      { type: 'separator' },
      { label: 'Tümünü Seç', role: 'selectAll', enabled: params.editFlags.canSelectAll }
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup();
  });
}

// Create tray icon
function createTray() {
  // Try to load from file first
  const iconPath = getIconPath();
  let trayIcon;

  if (iconPath) {
    trayIcon = nativeImage.createFromPath(iconPath);
    // Remove resize if not needed or verify iconPath
  } else {
    // Fallback: Create a simple tray icon using nativeImage with SVG
    function createGenericIcon() {
      const svgData = `
        <svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
          <rect width="64" height="64" fill="#3B82F6" rx="12"/>
          <text x="32" y="40" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">E</text>
        </svg>
      `;
      return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svgData).toString('base64')}`);
    }
    trayIcon = createGenericIcon();
  }

  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Göster',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: 'Gizle',
      click: () => {
        mainWindow.hide();
      }
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('E-Ticaret Yönetim Paneli');
  tray.setContextMenu(contextMenu);

  // Double click to show window
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// App event handlers (moved to Single Instance Lock block)

app.on('window-all-closed', () => {
  // Don't quit on window close, keep running in tray
  // if (process.platform !== 'darwin') {
  //   app.quit();
  // }
});

// IPC handlers for file operations (if needed)
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8');
    }
    return null;
  } catch (error) {
    console.error('Error reading file:', error);
    return null;
  }
});

// License validation handler
ipcMain.handle('validate-license', async (event, key) => {
  const isValid = validateLicense(key);
  if (isValid) {
    isLicensed = true;
    // Store license key to file
    const licensePath = join(app.getPath('userData'), 'license.key');
    try {
      if (!existsSync(dirname(licensePath))) {
        mkdirSync(dirname(licensePath), { recursive: true });
      }
      writeFileSync(licensePath, key, 'utf-8');
    } catch (error) {
      console.error('Error saving license file:', error);
    }

    if (event.sender && event.sender.send) {
      event.sender.send('license-validated', true);
    }
  }
  return isValid;
});

// Maximize window handler
ipcMain.handle('maximize-window', async () => {
  if (mainWindow) {
    mainWindow.maximize();
    return true;
  }
  return false;
});

// Get app path handler
ipcMain.handle('get-path', (event, name) => {
  return app.getPath(name);
});

// Fullscreen handlers
ipcMain.handle('toggle-fullscreen', async () => {
  if (mainWindow) {
    const isFullScreen = mainWindow.isFullScreen();
    mainWindow.setFullScreen(!isFullScreen);
    return !isFullScreen;
  }
  return false;
});

ipcMain.handle('is-fullscreen', async () => {
  if (mainWindow) {
    return mainWindow.isFullScreen();
  }
  return false;
});

// Check license status
ipcMain.handle('is-licensed', async () => {
  if (isLicensed) return true;

  const licensePath = join(app.getPath('userData'), 'license.key');
  if (existsSync(licensePath)) {
    const key = readFileSync(licensePath, 'utf-8').trim();
    isLicensed = validateLicense(key);
  }
  return isLicensed;
});

ipcMain.handle('write-file', async (event, filePath, data) => {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, data, 'utf-8');
    return true;
  } catch (error) {
    console.error('Error writing file:', error);
    return false;
  }
});

// Product Image Management IPCs
// Product Image Management IPCs
ipcMain.handle('save-product-image', async (event, { productCode, color, fileName, base64Data }) => {
  try {
    const imagesBase = getProductImagesBasePath();
    const safeProductCode = sanitizePathSegment(productCode);
    const safeColor = sanitizePathSegment(color);
    const safeFileName = sanitizePathSegment(fileName);

    const targetDir = join(imagesBase, safeProductCode, safeColor);

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const filePath = join(targetDir, safeFileName);
    const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Content, 'base64');

    writeFileSync(filePath, buffer);
    const relativePath = [
      encodeURIComponent(safeProductCode),
      encodeURIComponent(safeColor),
      encodeURIComponent(safeFileName)
    ].join('/');

    return {
      success: true,
      url: `app-img:///${relativePath}`
    };
  } catch (error) {
    console.error('Error saving product image:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-product-images-folder', async (event, { productCode, color }) => {
  try {
    const imagesBase = getProductImagesBasePath();
    let targetPath = imagesBase;

    if (productCode) {
      const safeProductCode = sanitizePathSegment(productCode);
      targetPath = join(imagesBase, safeProductCode);
      if (color) {
        const safeColor = sanitizePathSegment(color);
        targetPath = join(targetPath, safeColor);
      }
    }

    if (!existsSync(targetPath)) {
      mkdirSync(targetPath, { recursive: true });
    }

    const openError = await shell.openPath(targetPath);
    if (openError) {
      console.error('Open folder error:', openError);
      return { success: false, error: openError };
    }
    return { success: true };
  } catch (error) {
    console.error('Error opening images folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-product-image', async (event, filePath) => {
  try {
    const { imagesBase, absolutePath } = resolveAppImagePath(String(filePath || ''));
    const normalizedPath = absolutePath;

    if (!normalizedPath.startsWith(imagesBase)) {
      return false;
    }

    try {
      if (existsSync(normalizedPath)) {
        unlinkSync(normalizedPath);

        // Clean up empty directories if possible
        const colorDir = dirname(normalizedPath);
        const productDir = dirname(colorDir);

        if (readdirSync(colorDir).length === 0) {
          rmdirSync(colorDir);
          if (readdirSync(productDir).length === 0) {
            rmdirSync(productDir);
          }
        }
      }
      return true;
    } catch (error) {
      console.error('Error deleting product image inner:', error);
      return false;
    }
  } catch (err) {
    console.error('Error deleting product image outer:', err);
    return false;
  }
});

ipcMain.handle('get-images-base-path', () => {
  return getProductImagesBasePath();
});

// Notification handler with stable sound and focus
ipcMain.handle('show-notification', async (event, options) => {
  const safePlaySound = () => {
    // UPDATED: Use customSoundPath from options if available and pass notification type
    const soundPath = getSoundPath(options.customSoundPath, options.type);
    if (!soundPath) {
      console.log('[SOUND] Silence requested (none selected)');
      return;
    }
    if (!existsSync(soundPath)) {
      console.warn('[SOUND] File not found:', soundPath);
      return;
    }
    try {
      const psPath = String(soundPath).replace(/'/g, "''");
      const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = New-Object System.Media.SoundPlayer '${psPath}'; $p.PlaySync()"`;

      console.log('[SOUND] Executing PowerShell:', psCommand);
      exec(psCommand, (error) => {
        if (error) console.error('[SOUND] PowerShell execution error:', error);
      });
    } catch (err) {
      console.error('[SOUND] Main process sound error:', err);
    }
  };

  if (!options.title && !options.body) {
    if (options.playSound) safePlaySound();
    return true;
  }

  if (options.playSound) safePlaySound();

  if (Notification.isSupported()) {
    const iconPath = getIconPath();
    const notification = new Notification({
      title: options.title || 'StockMaster Pro',
      body: options.body || '',
      icon: iconPath,
      silent: true
    });

    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setAlwaysOnTop(true);
            mainWindow.setAlwaysOnTop(false);
            mainWindow.focus();
          }
        }, 100);
      }
    });

    notification.show();
    return true;
  }
  return false;
});

// Select Notification Sound IPC
ipcMain.handle('select-notification-sound', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3'] }],
    title: 'Yeni Bildirim Sesi Seçin'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const sourcePath = result.filePaths[0];
    const fileName = sanitizePathSegment(join(sourcePath).split(sep).pop());
    const targetDir = getSoundsDirectory();
    const targetPath = join(targetDir, fileName);

    try {
      // Copy file to app data to ensure persistence
      const buffer = readFileSync(sourcePath);
      writeFileSync(targetPath, buffer);
      return { success: true, filePath: targetPath };
    } catch (err) {
      console.error('Error copying sound file:', err);
      return { success: false, error: err.message };
    }
  }
  return null;
});

// Diagnostic handler to test notification and sound path
ipcMain.handle('test-notification', async (event, customPath, type) => {
  const soundPath = getSoundPath(customPath, type);
  const exists = existsSync(soundPath);
  const iconPath = getIconPath();

  const report = {
    soundPath,
    soundExists: exists,
    iconPath,
    iconExists: iconPath ? existsSync(iconPath) : false,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    appDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged
  };

  console.log('[DIAGNOSTIC-REPORT]', report);

  // Trigger real notification logic
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'Bildirim Testi',
      body: exists ? 'Bildirim ve ses sistemi çalışıyor.' : `Ses dosyası bulunamadı!\nYol: ${soundPath}`,
      icon: iconPath,
      silent: !exists
    });

    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });

    notification.show();

    if (exists && soundPath) {
      // Play sound using the same logic
      const psPath = String(soundPath).replace(/'/g, "''");
      const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = New-Object System.Media.SoundPlayer '${psPath}'; $p.PlaySync()"`;
      console.log('[SOUND-TEST] Executing:', psCommand);
      exec(psCommand);
    }
  }

  return report;
});

// Ses çalma desteği için renderer'a base64 olarak sesi ver
ipcMain.handle('get-notification-sound', async (event, customPath, type) => {
  try {
    const soundPath = getSoundPath(customPath, type);
    if (soundPath && existsSync(soundPath)) {
      const buffer = readFileSync(soundPath);
      return `data:audio/wav;base64,${buffer.toString('base64')}`;
    }
  } catch (error) {
    console.error('Error reading sound file:', error);
  }
  return null;
});

// PDF save handler
ipcMain.handle('save-pdf', async (event, pdfBlob, fileName, savePath) => {
  try {

    // Convert ArrayBuffer to Buffer
    const buffer = Buffer.from(pdfBlob);

    // Create file path
    let filePath;
    if (savePath) {
      // Kullanıcının seçtiği klasörü kullan
      filePath = join(savePath, fileName);
    } else {
      // Fallback: Desktop
      const desktopPath = app.getPath('desktop');
      filePath = join(desktopPath, fileName);
    }

    // Write file
    writeFileSync(filePath, buffer);

    return {
      success: true,
      filePath: filePath
    };
  } catch (error) {
    console.error('Error saving PDF:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Handle app quit
app.on('before-quit', () => {
  app.isQuitting = true;
});

// Handle folder picker for PDF save location
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'PDF Kaydetme Konumunu Seçin'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Handle printer detection
ipcMain.handle('get-printers', async () => {
  if (mainWindow) {
    return mainWindow.webContents.getPrinters();
  }
  return [];
});

// --- SQLite Integration ---
let dbPath = null;
let sqliteDb = null;

async function initSQLite() {
  const userDataPath = app.getPath('userData');
  dbPath = join(userDataPath, 'app_database.sqlite');

  sqliteDb = new Database(dbPath);

  // Create tables
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    
    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT PRIMARY KEY,
      name TEXT
    );
    
    CREATE TABLE IF NOT EXISTS api_configs (
      id TEXT PRIMARY KEY,
      data TEXT
    );
    
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      productCode TEXT,
      name TEXT,
      brand TEXT,
      "group" TEXT,
      date TEXT,
      data TEXT
    );
    
    CREATE TABLE IF NOT EXISTS variants (
      id TEXT PRIMARY KEY,
      productId TEXT,
      barcode TEXT,
      color TEXT,
      size TEXT,
      costPrice REAL,
      salePrice REAL,
      stocks TEXT,
      images TEXT,
      data TEXT,
      FOREIGN KEY(productId) REFERENCES products(id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      marketplaceOrderId TEXT,
      storeName TEXT,
      status TEXT,
      customerName TEXT,
      deliveryAddress TEXT,
      cargoCode TEXT,
      orderDate TEXT,
      isSuspended INTEGER,
      shipmentPackageId TEXT,
      countryCode TEXT,
      data TEXT
    );
    
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      orderId TEXT,
      orderItemId TEXT,
      barcode TEXT,
      productName TEXT,
      sku TEXT,
      color TEXT,
      size TEXT,
      quantity INTEGER,
      unitPrice REAL,
      costPrice REAL,
      totalPrice REAL,
      FOREIGN KEY(orderId) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      data TEXT
    );

    CREATE TABLE IF NOT EXISTS return_claims (
      id TEXT PRIMARY KEY,
      data TEXT
    );

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      data TEXT
    );
  `);

  console.log('[SQLITE] Database initialized at:', dbPath);

  // Check for migration
  const jsonPath = join(userDataPath, 'app_database.json');
  if (existsSync(jsonPath)) {
    console.log('[MIGRATION] Migration from JSON to SQLite started...');
    try {
      const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));

      const insertSettings = sqliteDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      const insertWarehouse = sqliteDb.prepare('INSERT OR REPLACE INTO warehouses (id, name) VALUES (?, ?)');
      const insertApi = sqliteDb.prepare('INSERT OR REPLACE INTO api_configs (id, data) VALUES (?, ?)');
      const insertProduct = sqliteDb.prepare('INSERT OR REPLACE INTO products (id, productCode, name, brand, "group", date, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insertVariant = sqliteDb.prepare('INSERT OR REPLACE INTO variants (id, productId, barcode, color, size, costPrice, salePrice, stocks, images, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insertOrder = sqliteDb.prepare('INSERT OR REPLACE INTO orders (id, marketplaceOrderId, storeName, status, customerName, deliveryAddress, cargoCode, orderDate, isSuspended, shipmentPackageId, countryCode, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insertOrderItem = sqliteDb.prepare('INSERT OR REPLACE INTO order_items (id, orderId, orderItemId, barcode, productName, sku, color, size, quantity, unitPrice, costPrice, totalPrice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insertGeneric = (table) => sqliteDb.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`);

      sqliteDb.transaction(() => {
        // Settings
        if (data.settings) {
          Object.entries(data.settings).forEach(([k, v]) => insertSettings.run(k, JSON.stringify(v)));
        }

        // Warehouses
        if (data.warehouses) {
          data.warehouses.forEach(w => insertWarehouse.run(w.id, w.name));
        }

        // API Configs
        if (data.apiConfigs) {
          data.apiConfigs.forEach(c => insertApi.run(c.id || c.storeName, JSON.stringify(c)));
        }

        // Products & Variants
        if (data.products) {
          data.products.forEach(p => {
            insertProduct.run(p.id, p.productCode, p.name, p.brand, p.group, p.date, JSON.stringify(p));
            if (p.variants) {
              p.variants.forEach(v => {
                insertVariant.run(v.id, p.id, v.barcode, v.color, v.size, v.costPrice || 0, v.salePrice || 0, JSON.stringify(v.stocks), JSON.stringify(v.images), JSON.stringify(v));
              });
            }
          });
        }

        // Orders & Items
        if (data.orders) {
          data.orders.forEach(o => {
            insertOrder.run(o.id, o.marketplaceOrderId, o.storeName, o.status, o.customerName, o.deliveryAddress, o.cargoCode, o.orderDate, o.isSuspended ? 1 : 0, o.shipmentPackageId, o.countryCode, JSON.stringify(o));
            if (o.items) {
              o.items.forEach(item => {
                insertOrderItem.run(item.id || Math.random().toString(36).substr(2, 9), o.id, item.orderItemId, item.barcode, item.productName, item.sku, item.color, item.size, item.quantity, item.unitPrice, item.costPrice, item.totalPrice);
              });
            }
          });
        }

        // Questions, Returns, Claims
        if (data.questions) data.questions.forEach(q => insertGeneric('questions').run(q.id, JSON.stringify(q)));
        if (data.returns) data.returns.forEach(r => insertGeneric('returns').run(r.id, JSON.stringify(r)));
        if (data.returnClaims) data.returnClaims.forEach(rc => insertGeneric('return_claims').run(rc.id, JSON.stringify(rc)));
      })();

      console.log('[MIGRATION] Migration successful. Renaming old JSON file.');
      renameSync(jsonPath, join(userDataPath, 'app_database.json.bak'));
    } catch (err) {
      console.error('[MIGRATION] Migration failed:', err);
    }
  }
}

// IPC Handlers for SQLite
ipcMain.handle('sqlite-all', async (event, query, params = []) => {
  try {
    return sqliteDb.prepare(query).all(params);
  } catch (err) {
    console.error('[SQLITE-ERROR] query.all:', err);
    throw err;
  }
});

ipcMain.handle('sqlite-get', async (event, query, params = []) => {
  try {
    return sqliteDb.prepare(query).get(params);
  } catch (err) {
    console.error('[SQLITE-ERROR] query.get:', err);
    throw err;
  }
});

ipcMain.handle('sqlite-run', async (event, query, params = []) => {
  try {
    return sqliteDb.prepare(query).run(params);
  } catch (err) {
    console.error('[SQLITE-ERROR] query.run:', err);
    throw err;
  }
});

ipcMain.handle('sqlite-transaction', async (event, list) => {
  try {
    const run = sqliteDb.transaction((ops) => {
      for (const op of ops) {
        sqliteDb.prepare(op.query).run(op.params || []);
      }
    });
    run(list);
    return true;
  } catch (err) {
    console.error('[SQLITE-ERROR] transaction:', err);
    throw err;
  }
});

ipcMain.handle('sqlite-wipe', async () => {
  try {
    const tables = [
      'settings', 'warehouses', 'api_configs', 'products', 'variants',
      'orders', 'order_items', 'returns', 'return_claims', 'questions'
    ];

    const wipe = sqliteDb.transaction(() => {
      for (const table of tables) {
        sqliteDb.prepare(`DELETE FROM ${table}`).run();
      }
    });

    wipe();
    console.log('[SQLITE] Database wiped successfully');
    return true;
  } catch (err) {
    console.error('[SQLITE-ERROR] wipe:', err);
    throw err;
  }
});

// Helper for frontend to pull complete DB for legacy compatibility
ipcMain.handle('db-get-all', async () => {
  try {
    const db = {
      settings: {},
      warehouses: sqliteDb.prepare('SELECT * FROM warehouses').all(),
      apiConfigs: sqliteDb.prepare('SELECT data FROM api_configs').all().map(r => JSON.parse(r.data)),
      products: sqliteDb.prepare('SELECT data FROM products').all().map(r => JSON.parse(r.data)),
      orders: sqliteDb.prepare('SELECT data FROM orders').all().map(r => JSON.parse(r.data)),
      returns: sqliteDb.prepare('SELECT data FROM returns').all().map(r => JSON.parse(r.data)),
      returnClaims: sqliteDb.prepare('SELECT data FROM return_claims').all().map(r => JSON.parse(r.data)),
      questions: sqliteDb.prepare('SELECT data FROM questions').all().map(r => JSON.parse(r.data)),
      currentUser: null // Handled separately usually or stored in settings
    };

    const settingsRows = sqliteDb.prepare('SELECT * FROM settings').all();
    settingsRows.forEach(row => {
      try {
        db.settings[row.key] = JSON.parse(row.value);
      } catch {
        db.settings[row.key] = row.value;
      }
    });

    return db;
  } catch (err) {
    console.error('db-get-all error:', err);
    return null;
  }
});

// Handle tray click
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
});

// Auto-start functionality
app.setLoginItemSettings({
  openAtLogin: true,
  openAsHidden: false
});

// Handle app ready for autostart
app.whenReady().then(() => {
  console.log('[AUTOSTART] Application ready and set to auto-start');
});

