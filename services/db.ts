
import { Database, UserRole, Product, Order, User, AppSettings, Warehouse, ApiConfig } from '../types';

const DB_KEY = 'eticaret_desktop_db_v1';
const SHARED_DB_KEY = 'eticaret_shared_db_v1'; // For cross-session data sharing

const INITIAL_DB: Database = {
  currentUser: null,
  users: [],
  warehouses: [
    { id: 'wh1', name: 'Depo 1', isCenter: true, priority: 1 }
  ],
  products: [],
  orders: [],
  returns: [],
  apiConfigs: [],
  questions: [],
  returnClaims: [],
  dismissedOrderImportKeys: [],
  settings: {
    autoFetchIntervalMinutes: 5,
    enableAutoStockSync: false,
    enableAutoOrderFetch: false,
    enableAutoProcessOrders: false,
    sessionTimeoutMinutes: 5,
    enableSessionTimeout: false,
    orderFetchDays: 2,
    enableOrderVisibilityLimit: true, // v1.6.4: Varsayılan açık
    stockSyncSettings: {
      enabled: true,
      minStockThreshold: 10,
      maxStockToSend: 200,
    },
    notifications: {
      soundEnabled: true,
      newOrderNotification: true,
      orderUpdateNotification: false,
      returnNotification: true,
      questionNotification: true,
      systemNotification: true,
      windowsEnabled: true,
    },
    printTemplate: {
      showOrderNo: true,
      showCargo: true,
      fontSize: 12,
      barcodeFormat: 'CODE128',
    },
    requirePasswordLogin: false, // Varsayılan olarak şifreli giriş kapalı (Kullanıcı yoksa)
    aoiRequiresKey: false, // AOI için key zorunlu değil
    firstTimeSetup: true, // İlk kurulum
    allowNegativeStock: false, // Negatif stok desteği (varsayılan kapalı)
    questionFetchIntervalMinutes: 5,
    enableAutoQuestionFetch: false,
    returnFetchIntervalMinutes: 5,
    enableAutoReturnFetch: false,
    quickAnswers: [],
    showProductImages: false, // v1.2.2: Varsayılan kapalı
    productsPerPage: 25, // v1.2.2: Sayfalama varsayılan 25
    enableReturnExceptionReport: true, // v1.2.8: İade istisnai durum raporu (varsayılan açık)
  },
};

const DISMISS_IMPORT_CAP = 4000;

function mergeDismissedKeys(a?: string[], b?: string[]): string[] {
  const merged = [...new Set([...(a || []), ...(b || [])])];
  return merged.length > DISMISS_IMPORT_CAP ? merged.slice(-DISMISS_IMPORT_CAP) : merged;
}

// Merge shared data with local session data
const mergeDatabases = (localDb: Database, sharedDb: Partial<Database>): Database => {
  let mergedWarehouses = sharedDb.warehouses || localDb.warehouses || [];
  const needsNumbering = mergedWarehouses.length > 0 && mergedWarehouses.every(w => !w.priority || w.priority === 1);
  if (needsNumbering) {
    mergedWarehouses = mergedWarehouses.map((w, index) => ({
      ...w,
      priority: index + 1
    }));
  }

  return {
    ...localDb,
    // Merge shared data (products, orders, etc.) but keep session-specific data
    products: sharedDb.products || localDb.products,
    questions: sharedDb.questions || localDb.questions,
    returnClaims: sharedDb.returnClaims || localDb.returnClaims,
    orders: sharedDb.orders || localDb.orders,
    returns: sharedDb.returns || localDb.returns,
    apiConfigs: sharedDb.apiConfigs || localDb.apiConfigs,
    warehouses: mergedWarehouses,
    settings: { ...localDb.settings, ...sharedDb.settings },
    dismissedOrderImportKeys: mergeDismissedKeys(localDb.dismissedOrderImportKeys, sharedDb.dismissedOrderImportKeys),
    // Keep session-specific data
    currentUser: localDb.currentUser,
    users: localDb.users,
    trialStartDate: sharedDb.trialStartDate || localDb.trialStartDate,
    lastSeenDate: sharedDb.lastSeenDate || localDb.lastSeenDate,
  };
};

// Veri doğrulama ve migration fonksiyonu
const migrateAndValidateDB = (data: any): Database => {
  // Temel yapı kontrolü
  if (!data || typeof data !== 'object') {
    console.warn('Geçersiz veri yapısı, varsayılan veritabanı kullanılıyor');
    return INITIAL_DB;
  }

  let loadedWarehouses = Array.isArray(data.warehouses) ? data.warehouses : INITIAL_DB.warehouses;
  const needsNumbering = loadedWarehouses.length > 0 && loadedWarehouses.every(w => !w.priority || w.priority === 1);
  if (needsNumbering) {
    loadedWarehouses = loadedWarehouses.map((w, index) => ({
      ...w,
      priority: index + 1
    }));
  }

  // Eksik alanları varsayılan değerlerle doldur
  const migrated: Database = {
    currentUser: data.currentUser || null,
    users: Array.isArray(data.users) ? data.users : [],
    products: Array.isArray(data.products) ? data.products : [],
    orders: Array.isArray(data.orders) ? data.orders : [],
    returns: Array.isArray(data.returns) ? data.returns : [],
    apiConfigs: Array.isArray(data.apiConfigs) ? data.apiConfigs : [],
    warehouses: loadedWarehouses,
    questions: Array.isArray(data.questions) ? data.questions : [],
    returnClaims: Array.isArray(data.returnClaims) ? data.returnClaims : [],
    dismissedOrderImportKeys: Array.isArray(data.dismissedOrderImportKeys)
      ? data.dismissedOrderImportKeys.filter((k: unknown) => typeof k === 'string')
      : [],
    settings: {
      autoFetchIntervalMinutes: typeof data.settings?.autoFetchIntervalMinutes === 'number'
        ? data.settings.autoFetchIntervalMinutes
        : INITIAL_DB.settings.autoFetchIntervalMinutes,
      enableAutoStockSync: typeof data.settings?.enableAutoStockSync === 'boolean'
        ? data.settings.enableAutoStockSync
        : INITIAL_DB.settings.enableAutoStockSync,
      enableAutoOrderFetch: typeof data.settings?.enableAutoOrderFetch === 'boolean'
        ? data.settings.enableAutoOrderFetch
        : INITIAL_DB.settings.enableAutoOrderFetch,
      enableAutoProcessOrders: typeof data.settings?.enableAutoProcessOrders === 'boolean'
        ? data.settings.enableAutoProcessOrders
        : INITIAL_DB.settings.enableAutoProcessOrders,
      sessionTimeoutMinutes: typeof data.settings?.sessionTimeoutMinutes === 'number'
        ? data.settings.sessionTimeoutMinutes
        : INITIAL_DB.settings.sessionTimeoutMinutes,
      enableSessionTimeout: typeof data.settings?.enableSessionTimeout === 'boolean'
        ? data.settings.enableSessionTimeout
        : INITIAL_DB.settings.enableSessionTimeout,
      orderFetchDays: typeof data.settings?.orderFetchDays === 'number'
        ? data.settings.orderFetchDays
        : INITIAL_DB.settings.orderFetchDays,
      notifications: {
        soundEnabled: typeof data.settings?.notifications?.soundEnabled === 'boolean'
          ? data.settings.notifications.soundEnabled
          : INITIAL_DB.settings.notifications.soundEnabled,
        newOrderNotification: typeof data.settings?.notifications?.newOrderNotification === 'boolean'
          ? data.settings.notifications.newOrderNotification
          : INITIAL_DB.settings.notifications.newOrderNotification,
        orderUpdateNotification: typeof data.settings?.notifications?.orderUpdateNotification === 'boolean'
          ? data.settings.notifications.orderUpdateNotification
          : INITIAL_DB.settings.notifications.orderUpdateNotification,
        returnNotification: typeof data.settings?.notifications?.returnNotification === 'boolean'
          ? data.settings.notifications.returnNotification
          : INITIAL_DB.settings.notifications.returnNotification,
        questionNotification: typeof data.settings?.notifications?.questionNotification === 'boolean'
          ? data.settings.notifications.questionNotification
          : INITIAL_DB.settings.notifications.questionNotification,
        systemNotification: typeof data.settings?.notifications?.systemNotification === 'boolean'
          ? data.settings.notifications.systemNotification
          : INITIAL_DB.settings.notifications.systemNotification,
        windowsEnabled: typeof data.settings?.notifications?.windowsEnabled === 'boolean'
          ? data.settings.notifications.windowsEnabled
          : INITIAL_DB.settings.notifications.windowsEnabled,
        orderSoundPath: data.settings?.notifications?.orderSoundPath,
        returnSoundPath: data.settings?.notifications?.returnSoundPath,
        questionSoundPath: data.settings?.notifications?.questionSoundPath,
      },
      printTemplate: {
        showOrderNo: typeof data.settings?.printTemplate?.showOrderNo === 'boolean'
          ? data.settings.printTemplate.showOrderNo
          : INITIAL_DB.settings.printTemplate.showOrderNo,
        showCargo: typeof data.settings?.printTemplate?.showCargo === 'boolean'
          ? data.settings.printTemplate.showCargo
          : INITIAL_DB.settings.printTemplate.showCargo,
        fontSize: typeof data.settings?.printTemplate?.fontSize === 'number'
          ? data.settings.printTemplate.fontSize
          : INITIAL_DB.settings.printTemplate.fontSize,
        barcodeFormat: data.settings?.printTemplate?.barcodeFormat === 'QR'
          ? 'QR'
          : INITIAL_DB.settings.printTemplate.barcodeFormat,
      },
      stockSyncSettings: {
        enabled: typeof data.settings?.stockSyncSettings?.enabled === 'boolean'
          ? data.settings.stockSyncSettings.enabled
          : INITIAL_DB.settings.stockSyncSettings.enabled,
        minStockThreshold: typeof data.settings?.stockSyncSettings?.minStockThreshold === 'number'
          ? data.settings.stockSyncSettings.minStockThreshold
          : INITIAL_DB.settings.stockSyncSettings.minStockThreshold,
        maxStockToSend: typeof data.settings?.stockSyncSettings?.maxStockToSend === 'number'
          ? data.settings.stockSyncSettings.maxStockToSend
          : INITIAL_DB.settings.stockSyncSettings.maxStockToSend,
      },
      requirePasswordLogin: typeof data.settings?.requirePasswordLogin === 'boolean'
        ? data.settings.requirePasswordLogin
        : INITIAL_DB.settings.requirePasswordLogin,
      aoiRequiresKey: typeof data.settings?.aoiRequiresKey === 'boolean'
        ? data.settings.aoiRequiresKey
        : INITIAL_DB.settings.aoiRequiresKey,
      firstTimeSetup: typeof data.settings?.firstTimeSetup === 'boolean'
        ? data.settings.firstTimeSetup
        : INITIAL_DB.settings.firstTimeSetup,
      licenseKey: data.settings?.licenseKey,
      lastTrialNotifyDate: data.settings?.lastTrialNotifyDate,
      productsPerPage: data.settings?.productsPerPage ?? INITIAL_DB.settings.productsPerPage,
      allowNegativeStock: typeof data.settings?.allowNegativeStock === 'boolean'
        ? data.settings.allowNegativeStock
        : INITIAL_DB.settings.allowNegativeStock,
      questionFetchIntervalMinutes: typeof data.settings?.questionFetchIntervalMinutes === 'number'
        ? data.settings.questionFetchIntervalMinutes
        : INITIAL_DB.settings.questionFetchIntervalMinutes,
      enableAutoQuestionFetch: typeof data.settings?.enableAutoQuestionFetch === 'boolean'
        ? data.settings.enableAutoQuestionFetch
        : INITIAL_DB.settings.enableAutoQuestionFetch,
      returnFetchIntervalMinutes: typeof data.settings?.returnFetchIntervalMinutes === 'number'
        ? data.settings.returnFetchIntervalMinutes
        : INITIAL_DB.settings.returnFetchIntervalMinutes,
      enableAutoReturnFetch: typeof data.settings?.enableAutoReturnFetch === 'boolean'
        ? data.settings.enableAutoReturnFetch
        : INITIAL_DB.settings.enableAutoReturnFetch,
      enableReturnExceptionReport: typeof data.settings?.enableReturnExceptionReport === 'boolean'
        ? data.settings.enableReturnExceptionReport
        : INITIAL_DB.settings.enableReturnExceptionReport,
      quickAnswers: Array.isArray(data.settings?.quickAnswers)
        ? data.settings.quickAnswers
        : INITIAL_DB.settings.quickAnswers,
      showProductImages: typeof data.settings?.showProductImages === 'boolean'
        ? data.settings.showProductImages
        : INITIAL_DB.settings.showProductImages,
    },
    trialStartDate: data.trialStartDate,
    lastSeenDate: data.lastSeenDate,
  };

  // Auto-resolve any suspended orders whose items now match existing products/variants
  if (Array.isArray(migrated.orders) && Array.isArray(migrated.products)) {
    migrated.orders.forEach(order => {
      if (order.isSuspended && Array.isArray(order.items) && order.items.length > 0) {
        let allResolved = true;
        order.items.forEach(item => {
          if (!item.barcode || item.barcode === 'NO-BARCODE') {
            allResolved = false;
            return;
          }
          const cleanB = String(item.barcode).trim().toLowerCase();
          const cleanSku = String(item.sku || '').trim().toLowerCase();

          // Check if already matches variant barcode or variant arma
          let matched = migrated.products.some(p =>
            p.variants.some(v => {
              const vb = String(v.barcode || '').trim().toLowerCase();
              const va = String((v as any).arma || (v as any).data?.arma || '').trim().toLowerCase();
              return (vb && (vb === cleanB || vb === cleanSku)) ||
                     (va && (va === cleanB || va === cleanSku));
            }) || (p.productCode && String(p.productCode).trim().toLowerCase() === cleanB)
          );

          // If not matched, try matching through productCode or candidate prefix or size/color
          if (!matched) {
            for (const p of migrated.products) {
              const pcode = String(p.productCode || '').trim().toLowerCase();
              if (pcode && (cleanSku === pcode || cleanSku.startsWith(pcode + ' ') || cleanSku.startsWith(pcode + '-') || (pcode === 'tps' && cleanSku.includes('tp sort')))) {
                const itemSize = String(item.size || item.productSize || '').trim().toLowerCase();
                const rawCol = String(item.color || '').trim().toLowerCase();
                const itemCol = rawCol.split(/\s+/).pop() || rawCol;

                const vMatch = p.variants.find(v => {
                  const vs = String(v.size || '').trim().toLowerCase();
                  const vc = String(v.color || '').trim().toLowerCase();
                  return (!itemSize || vs === itemSize) && (!itemCol || vc === itemCol || vc.includes(itemCol));
                }) || p.variants.find(v => itemSize && String(v.size || '').trim().toLowerCase() === itemSize);

                if (vMatch) {
                  item.barcode = vMatch.barcode;
                  matched = true;
                  break;
                }
              }
            }
          }

          if (!matched) allResolved = false;
        });

        if (allResolved) {
          order.isSuspended = false;
          order.wasSuspended = true;
        }
      }
    });
  }

  return migrated;
};


// File-based persistence helpers
const getDbFilePath = async (): Promise<string | null> => {
  if (window.require) {
    const { ipcRenderer } = window.require('electron');
    const userDataPath = await ipcRenderer.invoke('get-path', 'userData');
    return `${userDataPath}/app_database.json`;
  }
  return null;
};

export const loadDB = (): Database => {
  const stored = localStorage.getItem(DB_KEY);
  const sharedStored = localStorage.getItem(SHARED_DB_KEY);

  let localDb: Database;
  let sharedDb: Partial<Database> = {};

  if (!stored) {
    localDb = INITIAL_DB;
    void saveDB(INITIAL_DB);
  } else {
    try {
      const parsed = JSON.parse(stored);
      localDb = migrateAndValidateDB(parsed);
    } catch (error) {
      console.error('Veritabanı yükleme hatası:', error);
      localDb = INITIAL_DB;
      void saveDB(INITIAL_DB);
    }
  }

  if (sharedStored) {
    try {
      const parsed = JSON.parse(sharedStored);
      sharedDb = migrateAndValidateDB(parsed);
    } catch (error) {
      console.error('Paylaşılan veritabanı yükleme hatası:', error);
      sharedDb = {};
    }
  }

  return mergeDatabases(localDb, sharedDb);
};

// Async version of load for startup
export const loadDBFromFile = async (): Promise<Database> => {
  if (window.require) {
    const { ipcRenderer } = window.require('electron');
    try {
      // 1. Try to load from SQLite first
      const sqlData = await ipcRenderer.invoke('db-get-all');
      if (sqlData) {
        console.log('[DB] Loaded from SQLite');
        const validated = migrateAndValidateDB(sqlData);
        // Sync to localStorage for very basic metadata if needed, but primary is SQL
        localStorage.setItem(DB_KEY, JSON.stringify({ currentUser: validated.currentUser }));
        return validated;
      }
    } catch (error) {
      console.error('SQLite load error, falling back to JSON:', error);
    }

    // 2. Legacy fallback to JSON if SQLite isn't ready or migration failed
    const filePath = await getDbFilePath();
    if (filePath) {
      try {
        const fileData = await ipcRenderer.invoke('read-file', filePath);
        if (fileData) {
          const parsed = JSON.parse(fileData);
          const validated = migrateAndValidateDB(parsed);
          // Trigger migration (handled in main.js initSQLite usually, but this is a backup)
          return validated;
        }
      } catch (e) {
        console.error('JSON load fallback error:', e);
      }
    }
  }
  return loadDB();
};

export const migrateProductImages = async (db: Database): Promise<Database> => {
  if (!window.require) return db;
  const { electron } = (window as any);
  let migrationNeeded = false;

  const updatedProducts = await Promise.all(db.products.map(async (product) => {
    let productUpdated = false;
    const updatedVariants = await Promise.all(product.variants.map(async (variant) => {
      if (!variant.images || variant.images.length === 0) return variant;

      let variantUpdated = false;
      const updatedImages = await Promise.all(variant.images.map(async (img, index) => {
        // Eğer görsel hala base64 ise taşı
        if (img.startsWith('data:image/')) {
          migrationNeeded = true;
          variantUpdated = true;
          productUpdated = true;

          const extension = img.split(';')[0].split('/')[1] || 'jpg';
          const fileName = `img_${Date.now()}_${index}.${extension}`;

          try {
            const result = await electron.saveProductImage({
              productCode: product.productCode,
              color: variant.color,
              fileName: fileName,
              base64Data: img
            });

            if (result.success) {
              return result.url; // 'app-img://...'
            }
          } catch (err) {
            console.error('Migration failed for image:', err);
          }
        }
        return img;
      }));

      return variantUpdated ? { ...variant, images: updatedImages } : variant;
    }));

    return productUpdated ? { ...product, variants: updatedVariants } : product;
  }));

  if (migrationNeeded) {
    console.log('[MIGRATION] Base64 görseller HDD klasörlerine taşındı.');
    const newDb = { ...db, products: updatedProducts };
    // Save the migrated DB immediately
    await saveDB(newDb);
    return newDb;
  }

  return db;
};

export const saveDB = async (db: Database): Promise<void> => {
  // 1. Sync small session data to localStorage
  const sessionData = { currentUser: db.currentUser };
  localStorage.setItem(DB_KEY, JSON.stringify(sessionData));
  window.dispatchEvent(new Event('storage'));

  // 2. Save to SQLite via IPC
  if (!window.require) return;

  const { ipcRenderer } = window.require('electron');

  try {
    const ops: { query: string; params?: unknown[] }[] = [];

    // Settings (Incremental)
    Object.entries(db.settings).forEach(([k, v]) => {
      ops.push({ query: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', params: [k, JSON.stringify(v)] });
    });

    ops.push({
      query: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: ['dismissedOrderImportKeys', JSON.stringify(db.dismissedOrderImportKeys || [])]
    });

    ops.push({
      query: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: ['trialStartDate', JSON.stringify(db.trialStartDate || null)]
    });

    ops.push({
      query: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: ['lastSeenDate', JSON.stringify(db.lastSeenDate || null)]
    });

    ops.push({
      query: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: ['users', JSON.stringify(db.users || [])]
    });

    // API Configs
    ops.push({ query: 'DELETE FROM api_configs', params: [] });
    db.apiConfigs.forEach(c => {
      ops.push({ query: 'INSERT OR REPLACE INTO api_configs (id, data) VALUES (?, ?)', params: [c.id || c.storeName, JSON.stringify(c)] });
    });

    // Warehouses
    ops.push({ query: 'DELETE FROM warehouses', params: [] });
    db.warehouses.forEach(w => {
      ops.push({ 
        query: 'INSERT OR REPLACE INTO warehouses (id, name, isCenter, syncDisabled, priority, isDefault) VALUES (?, ?, ?, ?, ?, ?)', 
        params: [w.id, w.name, w.isCenter ? 1 : 0, w.syncDisabled ? 1 : 0, w.priority || 1, w.isDefault ? 1 : 0] 
      });
    });

    // Products (This is still a bit heavy, but SQLite handles it better than JSON write)
    ops.push({ query: 'DELETE FROM products', params: [] });
    db.products.forEach(p => {
      ops.push({
        query: 'INSERT OR REPLACE INTO products (id, productCode, name, brand, "group", date, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [p.id, p.productCode, p.name, p.brand, p.group, p.date, JSON.stringify(p)]
      });
    });

    // Orders
    ops.push({ query: 'DELETE FROM orders', params: [] });
    db.orders.forEach(o => {
      ops.push({
        query: 'INSERT OR REPLACE INTO orders (id, marketplaceOrderId, storeName, status, customerName, deliveryAddress, cargoCode, orderDate, isSuspended, shipmentPackageId, countryCode, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [o.id, o.marketplaceOrderId, o.storeName, o.status, o.customerName, o.deliveryAddress, o.cargoCode, o.orderDate, o.isSuspended ? 1 : 0, o.shipmentPackageId, o.countryCode, JSON.stringify(o)]
      });
    });

    // Questions, Returns
    // v1.4.2: Wipe actions-needed tables before re-inserting to prevent ghost records
    ops.push({ query: 'DELETE FROM questions', params: [] });
    ops.push({ query: 'DELETE FROM return_claims', params: [] });
    ops.push({ query: 'DELETE FROM returns', params: [] });

    db.questions.forEach(q => ops.push({ query: 'INSERT OR REPLACE INTO questions (id, data) VALUES (?, ?)', params: [q.id, JSON.stringify(q)] }));
    db.returns.forEach(r => ops.push({ query: 'INSERT OR REPLACE INTO returns (id, data) VALUES (?, ?)', params: [r.id, JSON.stringify(r)] }));
    db.returnClaims.forEach(rc => ops.push({ query: 'INSERT OR REPLACE INTO return_claims (id, data) VALUES (?, ?)', params: [rc.id, JSON.stringify(rc)] }));

    await ipcRenderer.invoke('sqlite-transaction', ops);
  } catch (err) {
    console.error('============================');
    console.error('[DB-SAVE] SQLITE KAYIT HATASI!');
    console.error('SQLite transaction failed. The changes were NOT saved to disk.');
    console.error(err);
    console.error('============================');
  }
};

// Listen for storage changes from other sessions
export const setupStorageListener = (callback: (newDb: Database) => void) => {
  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === SHARED_DB_KEY) {
      const currentLocalDb = loadDB();
      const newSharedDb = e.newValue ? JSON.parse(e.newValue) : {};
      const mergedDb = mergeDatabases(currentLocalDb, newSharedDb);
      callback(mergedDb);
    }
  };
  window.addEventListener('storage', handleStorageChange);
  return () => window.removeEventListener('storage', handleStorageChange);
};

export const exportBackup = async (onSuccess?: (msg: string) => void, onError?: (msg: string) => void) => {
  try {
    // 1. Get the most up-to-date data (Prefer SQLite)
    let data: Database;
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      const sqlData = await ipcRenderer.invoke('db-get-all');
      data = migrateAndValidateDB(sqlData || loadDB());
    } else {
      data = loadDB();
    }

    // Güvenlik: currentUser'ı yedekten çıkar (şifreler güvenlik riski)
    const backupData = {
      ...data,
      currentUser: null, // Oturum bilgisi yedeklenmez
    };

    // Pretty print ile okunabilir JSON
    const jsonString = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup_${new Date().toISOString().slice(0, 10)}_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Memory cleanup
    setTimeout(() => URL.revokeObjectURL(url), 100);

    // Başarı callback'i
    if (onSuccess) {
      onSuccess('Yedek dosyası başarıyla oluşturuldu ve indirme başlatıldı.');
    }

    return true;
  } catch (error) {
    console.error('Yedek alma hatası:', error);
    if (onError) {
      onError('Yedek alma sırasında bir hata oluştu.');
    }
    return false;
  }
};

export const resetToFactoryDefaults = async (): Promise<boolean> => {
  try {
    // 1. Clear SQLite tables if in Electron
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      await ipcRenderer.invoke('sqlite-wipe');
    }

    // 2. Clear all localStorage data
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem(SHARED_DB_KEY);
    localStorage.removeItem('activeUsers');
    localStorage.removeItem('printConfig');

    // 3. Save initial database state
    await saveDB(INITIAL_DB);

    return true;
  } catch (error) {
    console.error('Fabrika ayarlarına dönme hatası:', error);
    return false;
  }
};

export const importBackup = (file: File, options: {
  onSuccess?: (msg: string) => void,
  onError?: (msg: string) => void,
  onConfirm?: (msg: string, onProceed: () => void) => void,
  onDone: () => void
}) => {
  // Dosya boyutu kontrolü (max 50MB)
  if (file.size > 50 * 1024 * 1024) {
    if (options.onError) options.onError('Yedek dosyası çok büyük. Maksimum 50MB olmalıdır.');
    return;
  }

  // Dosya tipi kontrolü
  if (!file.name.endsWith('.json') && file.type !== 'application/json') {
    if (options.onError) options.onError('Geçersiz dosya formatı. Lütfen .json uzantılı bir dosya seçin.');
    return;
  }

  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const fileContent = e.target?.result as string;
      if (!fileContent || fileContent.trim().length === 0) {
        throw new Error('Dosya boş');
      }

      const parsed = JSON.parse(fileContent);

      // Veri doğrulama ve migration
      const migratedData = migrateAndValidateDB(parsed);

      // Güvenlik: currentUser'ı temizle (yedekten yüklenen oturum bilgisi kullanılmamalı)
      migratedData.currentUser = null;

      // Mevcut kullanıcıları koru (yedekteki kullanıcılar varsa birleştir)
      // Eğer yedekte kullanıcı yoksa mevcut kullanıcıları koru
      if (!Array.isArray(parsed.users) || parsed.users.length === 0) {
        const currentDb = loadDB();
        migratedData.users = currentDb.users;
      }

      const processImport = async () => {
        try {
          // 1. Wipe SQLite before importing
          if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('sqlite-wipe');
          }

          // 2. Save the database
          await saveDB(migratedData);

          if (options.onSuccess) options.onSuccess('Yedek başarıyla yüklendi. Uygulama yenileniyor...');

          // Refresh after success message
          setTimeout(() => options.onDone(), 1500);
        } catch (err) {
          console.error('Import processing error:', err);
          if (options.onError) options.onError('Yedek işleme sırasında hata oluştu.');
        }
      };

      // Yedekleme öncesi onay
      if (options.onConfirm) {
        options.onConfirm('Yedek dosyası yüklenecek. Mevcut tüm veriler üzerine yazılacak. Devam etmek istiyor musunuz?', processImport);
      } else if (confirm('Yedek dosyası yüklenecek. Mevcut tüm veriler üzerine yazılacak. Devam etmek istiyor musunuz?')) {
        processImport();
      }

    } catch (err) {
      console.error('Yedek yükleme hatası:', err);
      let errorMessage = 'Yedek dosyası hatalı veya bozuk.';

      if (err instanceof SyntaxError) {
        errorMessage = 'Yedek dosyası geçerli bir JSON formatında değil.';
      } else if (err instanceof Error) {
        errorMessage = `Yedek yükleme hatası: ${err.message}`;
      }

      if (options.onError) options.onError(errorMessage);
    }
  };

  reader.onerror = () => {
    if (options.onError) options.onError('Dosya okuma hatası. Lütfen dosyanın bozuk olmadığından emin olun.');
  };

  reader.readAsText(file, 'utf-8');
};

/**
 * Başka bir program yedeğindeki sadece Sipariş Geçmişini ve API Ayarlarını
 * mevcut programa birleştirir. Lisans ve Ürün Yönetimi bilgilerine KESİNLİKLE dokunmaz.
 */
export const mergeBackup = (file: File, options: {
  onSuccess?: (msg: string) => void,
  onError?: (msg: string) => void,
  onConfirm?: (msg: string, onProceed: () => void) => void,
  onDone: () => void
}) => {
  if (file.size > 100 * 1024 * 1024) {
    if (options.onError) options.onError('Yedek dosyası çok büyük. Maksimum 100MB olmalıdır.');
    return;
  }

  if (!file.name.endsWith('.json') && file.type !== 'application/json') {
    if (options.onError) options.onError('Geçersiz dosya formatı. Lütfen .json uzantılı bir yedek dosyası seçin.');
    return;
  }

  const reader = new FileReader();

  reader.onload = async (e) => {
    try {
      const fileContent = e.target?.result as string;
      if (!fileContent || fileContent.trim().length === 0) {
        throw new Error('Dosya içeriği boş.');
      }

      const parsed = JSON.parse(fileContent);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Geçersiz yedek dosyası yapısı.');
      }

      // Mevcut güncel veritabanını yükle
      let currentDb: Database;
      if (window.require) {
        const { ipcRenderer } = window.require('electron');
        const sqlData = await ipcRenderer.invoke('db-get-all');
        currentDb = migrateAndValidateDB(sqlData || loadDB());
      } else {
        currentDb = loadDB();
      }

      // 1. SİPARİŞLER (orders) BİRLEŞTİRME
      const incomingOrders: any[] = Array.isArray(parsed.orders) ? parsed.orders : [];
      const existingOrderIds = new Set(currentDb.orders.map(o => String(o.id)));
      const existingMarketplaceOrderKeys = new Set(
        currentDb.orders
          .filter(o => o.marketplaceOrderId && o.storeName)
          .map(o => `${String(o.storeName).trim().toLowerCase()}:::${String(o.marketplaceOrderId).trim().toLowerCase()}`)
      );

      const newOrdersToAdd: any[] = [];
      for (const o of incomingOrders) {
        if (!o || !o.id) continue;
        const idStr = String(o.id);
        const marketKey = o.marketplaceOrderId && o.storeName
          ? `${String(o.storeName).trim().toLowerCase()}:::${String(o.marketplaceOrderId).trim().toLowerCase()}`
          : null;

        if (existingOrderIds.has(idStr)) continue;
        if (marketKey && existingMarketplaceOrderKeys.has(marketKey)) continue;

        existingOrderIds.add(idStr);
        if (marketKey) existingMarketplaceOrderKeys.add(marketKey);
        newOrdersToAdd.push(o);
      }

      // 2. İADE KAYITLARI (returns) BİRLEŞTİRME
      const incomingReturns: any[] = Array.isArray(parsed.returns) ? parsed.returns : [];
      const existingReturnIds = new Set(currentDb.returns.map(r => String(r.id)));
      const newReturnsToAdd: any[] = [];
      for (const r of incomingReturns) {
        if (!r || !r.id) continue;
        const idStr = String(r.id);
        if (!existingReturnIds.has(idStr)) {
          existingReturnIds.add(idStr);
          newReturnsToAdd.push(r);
        }
      }

      // 3. API BİLGİLERİ (apiConfigs) BİRLEŞTİRME
      const incomingApiConfigs: any[] = Array.isArray(parsed.apiConfigs) ? parsed.apiConfigs : [];
      const existingStoreNames = new Set(currentDb.apiConfigs.map(c => String(c.storeName || '').trim().toLowerCase()));
      const existingApiIds = new Set(currentDb.apiConfigs.map(c => String(c.id || '')));

      const newApiConfigsToAdd: any[] = [];
      for (const c of incomingApiConfigs) {
        if (!c || !c.storeName) continue;
        const stName = String(c.storeName).trim().toLowerCase();
        const apiId = String(c.id || '');

        // Mevcut mağaza adı veya ID varsa mevcut ayarı ezmiyoruz
        if (existingStoreNames.has(stName) || (apiId && existingApiIds.has(apiId))) {
          continue;
        }

        existingStoreNames.add(stName);
        if (apiId) existingApiIds.add(apiId);
        newApiConfigsToAdd.push(c);
      }

      const totalNewItems = newOrdersToAdd.length + newApiConfigsToAdd.length + newReturnsToAdd.length;
      if (totalNewItems === 0) {
        if (options.onError) {
          options.onError('Yedek dosyasında eklenecek yeni bir sipariş veya API mağaza ayarı bulunamadı (Tüm kayıtlar mevcut sisteminizde zaten mevcut).');
        }
        return;
      }

      const confirmMessage =
        `Yedek Verisi Birleştirme Özeti:\n\n` +
        `• Eklenecek Yeni Sipariş: ${newOrdersToAdd.length} adet\n` +
        (newReturnsToAdd.length > 0 ? `• Eklenecek İade Kaydı: ${newReturnsToAdd.length} adet\n` : '') +
        `• Eklenecek Yeni API/Mağaza Ayarı: ${newApiConfigsToAdd.length} adet\n\n` +
        `GÜVENLİK BİLGİSİ:\n` +
        `• Mevcut Lisans bilgileriniz ve Ürün Yönetimi (ürünler, stoklar, depolar) KESİNLİKLE KORUNACAK ve değiştirilmeyecektir.\n` +
        `• Yalnızca sipariş geçmişi ve API ayarları mevcut programa eklenecektir.\n\n` +
        `Birleştirme işlemini onaylıyor musunuz?`;

      const processMerge = async () => {
        try {
          const mergedDb: Database = {
            ...currentDb,
            orders: [...currentDb.orders, ...newOrdersToAdd],
            returns: [...currentDb.returns, ...newReturnsToAdd],
            apiConfigs: [...currentDb.apiConfigs, ...newApiConfigsToAdd],
            // Ürünler, stoklar, depolar, lisans ve kullanıcılar mevcut programdan KESİNLİKLE KORUNUR:
            products: currentDb.products,
            warehouses: currentDb.warehouses,
            settings: currentDb.settings,
            users: currentDb.users,
            currentUser: currentDb.currentUser,
          };

          await saveDB(mergedDb);

          if (options.onSuccess) {
            options.onSuccess(
              `Birleştirme başarıyla tamamlandı! (${newOrdersToAdd.length} sipariş, ${newApiConfigsToAdd.length} API ayarı eklendi). Uygulama yenileniyor...`
            );
          }

          setTimeout(() => options.onDone(), 1500);
        } catch (err: any) {
          console.error('Merge processing error:', err);
          if (options.onError) options.onError(`Birleştirme kaydedilirken hata oluştu: ${err?.message || err}`);
        }
      };

      if (options.onConfirm) {
        options.onConfirm(confirmMessage, processMerge);
      } else if (confirm(confirmMessage)) {
        processMerge();
      }

    } catch (err: any) {
      console.error('Yedek birleştirme hatası:', err);
      let errorMessage = 'Yedek dosyası hatalı veya okunamadı.';
      if (err instanceof SyntaxError) {
        errorMessage = 'Seçilen dosya geçerli bir JSON yedek formatında değil.';
      } else if (err instanceof Error) {
        errorMessage = `Hata: ${err.message}`;
      }
      if (options.onError) options.onError(errorMessage);
    }
  };

  reader.onerror = () => {
    if (options.onError) options.onError('Dosya okuma hatası. Lütfen dosyanın bozuk olmadığından emin olun.');
  };

  reader.readAsText(file, 'utf-8');
};
