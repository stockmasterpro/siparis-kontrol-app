import React, { useState, useEffect, useRef } from 'react';
import { Database, User, UserRole, OrderStatus, ReturnClaim, Question, QuestionStatus, ReturnRecord } from './types';
import { loadDB, saveDB, setupStorageListener, loadDBFromFile } from './services/db';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { ProductManagement } from './components/ProductManagement';
import { OrderManagement } from './components/OrderManagement';
import { Settings } from './components/Settings';
import { Lock, AlertTriangle, Key, Bell, Eye, EyeOff, UserPlus, Trash, RotateCcw, UploadCloud, Loader2, Edit, X, ShoppingCart, Check, Filter } from 'lucide-react';
import { syncMarketplaceOrders, syncBarcodeStock, syncBarcodeStockBatchMultiple, syncMarketplaceQuestions, syncMarketplaceClaims } from './services/integration';
import { QuestionManagement } from './components/QuestionManagement';
import { ReturnManagement } from './components/ReturnManagement';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_ADMIN: User = {
  id: 'system-admin',
  username: 'system-admin',
  password: '',
  role: UserRole.ADMIN,
  name: 'Sistem Yöneticisi'
};

const App: React.FC = () => {
  const [db, setDB] = useState<Database | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [showLicenseKey, setShowLicenseKey] = useState(false);
  const [error, setError] = useState('');
  const [activeUsers, setActiveUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState('dashboard');
  const [orderTab, setOrderTab] = useState<'active' | 'cancelled' | 'suspended' | 'returned'>('active');
  const [questionTab, setQuestionTab] = useState<'new' | 'answered'>('new');
  const [isLicensed, setIsLicensed] = useState(false);
  const [showLicenseForm, setShowLicenseForm] = useState(false);
  const [trialExpired, setTrialExpired] = useState(false);
  const isFirstLoad = useRef(true);
  const [overrideOrderCounts, setOverrideOrderCounts] = useState<{ active: number | null }>({ active: null });
  const [notification, setNotification] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [rememberMe, setRememberMe] = useState(localStorage.getItem('rememberUser') === 'true');
  const [loginCooldown, setLoginCooldown] = useState(0);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string, onConfirm: () => void } | null>(null);
  const notificationAudioRef = useRef<HTMLAudioElement | null>(null);
  const dbRef = useRef<Database | null>(null);
  const syncInProgress = useRef(false);

  useEffect(() => {
    dbRef.current = db;
  }, [db]);

  const invokeShowNotification = (options: { title?: string; body?: string; playSound?: boolean; customSoundPath?: string; type?: string }) => {
    try {
      // Prefer ipcRenderer (works even if preload bridge isn't available)
      if (window.require) {
        const { ipcRenderer } = window.require('electron');
        return ipcRenderer.invoke('show-notification', options);
      }

      // Fallback: preload contextBridge
      const electron = (window as any).electron;
      if (electron?.showNotification) {
        return electron.showNotification(options);
      }
    } catch (e) {
      console.error('Notification invoke failed:', e);
    }
    return Promise.resolve(false);
  };

  const ensureNotificationAudio = async (customPath?: string, type?: string) => {
    try {
      // Clear cache if customPath changes (simple implementation)
      if (notificationAudioRef.current && (notificationAudioRef.current as any)._lastPath === customPath && (notificationAudioRef.current as any)._lastType === type) {
        return notificationAudioRef.current;
      }

      if (!window.require && !(window as any).electron?.getNotificationSound) return null;

      // Prefer ipcRenderer path
      let dataUrl: string | null = null;
      if (window.require) {
        const { ipcRenderer } = window.require('electron');
        dataUrl = await ipcRenderer.invoke('get-notification-sound', customPath, type);
      } else if ((window as any).electron?.getNotificationSound) {
        dataUrl = await (window as any).electron.getNotificationSound(customPath, type);
      }

      if (!dataUrl) return null;
      const audio = new Audio(dataUrl);
      audio.volume = 0.7;
      (audio as any)._lastPath = customPath;
      (audio as any)._lastType = type;
      notificationAudioRef.current = audio;
      return audio;
    } catch (e) {
      console.warn('Notification audio init failed:', e);
      return null;
    }
  };

  const playNotificationSoundInApp = async (customPath?: string, type?: string) => {
    try {
      const audio = await ensureNotificationAudio(customPath, type);
      if (!audio) return;
      audio.currentTime = 0;
      await audio.play();
    } catch (e) {
      console.warn('Notification audio play failed:', e);
    }
  };

  const requestConfirm = (message: string, onConfirm: () => void) => {
    setConfirmDialog({ message, onConfirm });
  };

  useEffect(() => {

    if (loginCooldown > 0) {
      const timer = setTimeout(() => setLoginCooldown(prev => prev - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [loginCooldown]);

  useEffect(() => {
    if (rememberMe) {

      const savedUser = localStorage.getItem('savedUsername');
      if (savedUser) setUsername(savedUser);
    }
  }, []);

  // Listen for main process sound requests (ensures app shows in Windows volume mixer)
  useEffect(() => {
    const handler = () => {
      playNotificationSoundInApp();
    };

    try {
      if (window.require) {
        const { ipcRenderer } = window.require('electron');
        const internalHandler = (_event: any, customPath: string, type: any) => {
          playNotificationSoundInApp(customPath, type);
        };
        ipcRenderer.on('play-notification-sound', internalHandler);
        return () => {
          ipcRenderer.removeListener('play-notification-sound', internalHandler);
        };
      }

      const electron = (window as any).electron;
      if (electron?.onPlayNotificationSound) {
        electron.onPlayNotificationSound(handler);
      }
    } catch (e) {
      console.warn('Sound IPC wiring failed:', e);
    }
  }, []);

  // Listen for auto-update messages
  useEffect(() => {
    try {
      if (window.require) {
        const { ipcRenderer } = window.require('electron');
        const updateHandler = (_event: any, data: any) => {
          console.log('[UPDATE-CLIENT]', data);

          const soundPath = dbRef.current?.settings.notifications?.updateSoundPath;

          if (data.type === 'available') {
            setNotification({ type: 'success', message: data.message });
            playNotificationSoundInApp(soundPath, 'update');
          } else if (data.type === 'downloaded') {
            setNotification({ type: 'success', message: data.message });
            playNotificationSoundInApp(soundPath, 'update');
            requestConfirm(data.message, () => {
              ipcRenderer.invoke('quit-and-install');
            });
          } else if (data.type === 'info') {
            setNotification({ type: 'success', message: data.message });
            // Optionally play sound for manual check as well
            if (soundPath !== 'none') playNotificationSoundInApp(soundPath, 'update');
          } else if (data.type === 'error') {
            setNotification({ type: 'error', message: data.message });
          }
        };

        ipcRenderer.on('update-message', updateHandler);
        return () => {
          ipcRenderer.removeListener('update-message', updateHandler);
        };
      }
    } catch (e) {
      console.warn('Update IPC wiring failed:', e);
    }
  }, []);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);


  const handleUpdateDB = async (newDB: Database | ((prev: Database) => Database)) => {
    setDB(prev => {
      if (!prev) return prev;

      const dbToUpdate = typeof newDB === 'function' ? newDB(prev) : { ...newDB };

      // GÜVENLİK: Eğer session'ı özellikle güncellemiyorsak prev currentUser'ı koru
      if (prev.currentUser && !dbToUpdate.currentUser) {
        dbToUpdate.currentUser = prev.currentUser;
      }

      if (dbToUpdate.users.length === 0) {
        dbToUpdate.currentUser = DEFAULT_ADMIN;
      }

      return dbToUpdate;
    });
  };

  // Centralized Save logic to ensure reliability
  useEffect(() => {
    if (db && !isFirstLoad.current) {
      const saveToStorage = async () => {
        try {
          await saveDB(db);
        } catch (error) {
          console.error('[DB-SAVE-EFFECT] Critical Error:', error);
        }
      };
      saveToStorage();
    }
  }, [db]);

  // Fetch real time from online API
  const fetchRealTime = async (): Promise<Date | null> => {
    if (!navigator.onLine) {
      console.warn('[TIME-API] İnternet bağlantısı yok, yerel saat kullanılıyor.');
      return null;
    }

    try {
      const response = await fetch('https://worldtimeapi.org/api/timezone/Etc/GMT', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const data = await response.json();
      return new Date(data.datetime);
    } catch (error) {
      console.warn('[TIME-API] Could not fetch real time, using local time:', error);
      return null;
    }
  };

  // Check license on app start
  useEffect(() => {
    const checkLicense = async () => {
      if (!db) return;

      try {
        let licensed = false;

        // 1. Check if real license exists in settings
        if (window.require) {
          const { ipcRenderer } = window.require('electron');
          licensed = await ipcRenderer.invoke('is-licensed');

          // Electron tarafında lisans yoksa, ayarlardaki key'i kontrol et
          if (!licensed && db.settings.licenseKey) {
            licensed = await ipcRenderer.invoke('validate-license', db.settings.licenseKey);
          }
        } else {
          // Dev browser fallback
          const storedKey = db.settings.licenseKey || localStorage.getItem('license_key') || '';
          const normalize = (val: string) => val.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
          if (normalize(storedKey) === normalize('8F3KQ-9A7M2-LP5XW-4Z8N6-YT2RD')) {
            licensed = true;
          }
        }

        // 2. TIME-TRAVEL DETECTION: Check if system clock was moved backwards
        let timeTampered = false;

        // Try to get real time from online API first for accuracy
        const realTime = await fetchRealTime();
        const now = realTime || new Date();

        if (db.lastSeenDate) {
          const lastSeen = new Date(db.lastSeenDate);

          // TOLERANS: Fark 24 saatten (86400000ms) fazla ise manipülasyon kabul et
          // Bu, bilgisayarlar arası timezone veya ufak saat ayar farklarını önler.
          const isActuallyBehind = now.getTime() < lastSeen.getTime();
          const delayAmount = lastSeen.getTime() - now.getTime();

          if (isActuallyBehind && delayAmount > 1000 * 60 * 60 * 24) {
            console.error('[SECURITY] Time travel detected! System clock moved backwards by more than 24h.');
            timeTampered = true;
          } else if (isActuallyBehind) {
            console.warn(`[SECURITY] Minor time difference detected (${Math.round(delayAmount / 60000)}m), but within 24h grace period.`);
          }
        }

        // 3. Check if TRIAL is active (only if not licensed and no time tampering)
        let trialActive = false;
        let trialExpired = false;
        if (!licensed && !timeTampered && db.trialStartDate) {
          const startDate = new Date(db.trialStartDate);
          const diffTime = Math.abs(now.getTime() - startDate.getTime());
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          if (diffDays <= 7) {
            trialActive = true;
          } else {
            trialExpired = true;
          }

          // Update lastSeenDate to current time (SELF-HEALING) - EVERY 1 HOUR MAX TO PREVENT LOOPS
          const lastSeen = new Date(db.lastSeenDate || 0);
          const hourInMs = 1000 * 60 * 60;

          if (now.getTime() - lastSeen.getTime() > hourInMs) {
            // Sadece "geleceğe" doğru veya internet saatiyle güncelleme yap
            if (realTime || now.getTime() > lastSeen.getTime()) {
              handleUpdateDB(prev => ({ ...prev, lastSeenDate: now.toISOString() }));
            }
          }
        }

        // If time was tampered, lock the app
        if (timeTampered && !licensed) {
          setIsLicensed(false);
          setShowLicenseForm(true);
          setError('Sistem saati manipüle edilmiş veya senkronizasyon hatası oluşmuş. Lütfen lisans anahtarınızı girin.');
          return;
        }

        // Show license form if not licensed and trial not active
        const shouldShowLicenseForm = !licensed && (!trialActive || trialExpired);

        setIsLicensed(licensed || (trialActive && !trialExpired));
        setShowLicenseForm(shouldShowLicenseForm || db.settings.firstTimeSetup);

        // Deneme süresi dolduysa kullanıcı adını ayarla
        if (trialExpired && db.currentUser) {
          setUsername(db.currentUser.username);
          setError('Deneme süreniz dolmuştur. Lütfen şifrenizi girin.');
          setTrialExpired(true);
        } else {
          setTrialExpired(false);
        }

        // Lisans/Deneme durumuna göre firstTimeSetup'ı güncelle
        if ((licensed || trialActive) && db.settings.firstTimeSetup) {
          // handleUpdateDB({ ...db, settings: { ...db.settings, firstTimeSetup: false } });
        }

      } catch (error) {
        console.error('License check error:', error);
        setShowLicenseForm(true);
      }
    };

    if (db) checkLicense();

    // İnternet geldiğinde gerçek saati kontrol et
    const handleOnline = () => {
      console.log('[NETWORK] İnternet bağlantısı sağlandı, saat ve lisans tekrar kontrol ediliyor...');
      if (db) checkLicense();
    };

    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [db?.settings.licenseKey, db?.trialStartDate, db?.lastSeenDate]);

  // İlk kurulum kontrolü - ayrı useEffect
  useEffect(() => {
    if (db && db.settings.firstTimeSetup) {
      setShowLicenseForm(true);
    }
  }, [db]);

  // Maximize window on startup
  useEffect(() => {
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('maximize-window');
    }
  }, []);

  const handleLicenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      const isValid = await ipcRenderer.invoke('validate-license', licenseKey);

      if (isValid) {
        setIsLicensed(true);
        setShowLicenseForm(false);
        setError('');
        if (db) {
          const trimmedKey = licenseKey.trim();
          await handleUpdateDB({
            ...db,
            settings: { ...db.settings, licenseKey: trimmedKey, firstTimeSetup: false }
          });
        }
      } else {
        setError('Geçersiz lisans anahtarı.');
      }
    } else {
      // Fallback for browser testing
      const normalize = (val: string) => (val || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      if (normalize(licenseKey) === normalize('8F3KQ-9A7M2-LP5XW-4Z8N6-YT2RD')) {
        const trimmedKey = licenseKey.trim();
        localStorage.setItem('license_key', trimmedKey);
        setIsLicensed(true);
        setShowLicenseForm(false);
        setError('');
        if (db) {
          await handleUpdateDB({
            ...db,
            settings: { ...db.settings, licenseKey: trimmedKey, firstTimeSetup: false }
          });
        }
      } else {
        setError('Geçersiz lisans anahtarı.');
      }
    }
  };

  const handleStartTrial = async () => {
    if (!db) return;
    const now = new Date().toISOString();
    await handleUpdateDB({
      ...db,
      trialStartDate: now,
      lastSeenDate: now,
      settings: { ...db.settings, firstTimeSetup: false }
    });
    setIsLicensed(true);
    setShowLicenseForm(false);
  };

  const handleSyncClaims = async () => {
    const currentDb = dbRef.current;
    if (!currentDb || syncInProgress.current) return;
    syncInProgress.current = true;

    const currentClaims = dbRef.current?.returnClaims || [];
    const existingClaimKeys = new Set(currentClaims.map(c => `${c.storeName}|${c.claimId}|${c.claimLineItemId}`));

    let allNewClaims: ReturnClaim[] = [];
    for (const config of currentDb.apiConfigs) {
      if (!config.isReturnSyncEnabled) continue;
      try {
        const fetched = await syncMarketplaceClaims(config);
        allNewClaims = [...allNewClaims, ...fetched];
      } catch (err) {
        console.error(`[SYNC-ERROR] ${config.storeName} iadeler çekilemedi:`, err);
      }
    }

    const actualNewClaims = allNewClaims.filter(c => !existingClaimKeys.has(`${c.storeName}|${c.claimId}|${c.claimLineItemId}`));
    const newClaimsInWaitingState = actualNewClaims.filter(c => {
      const s = String(c.status).toUpperCase();
      return s === 'WAITING_FOR_APPROVE' ||
        s === 'WAITINGFORAPPROVE' ||
        s === 'WAITING_FOR_RETURN_PACKAGE' ||
        s === 'WAITINGFORRETURNPACKAGE' ||
        s === 'CREATED';
    });

    handleUpdateDB(prev => {
      const prevClaims = prev.returnClaims || [];
      const updatedClaims = allNewClaims.map(newC => {
        // If we have a local version that might be more updated (e.g. processed), 
        // keep it if the synced version is still in waiting state.
        const localMatched = prevClaims.find(lc =>
          lc.storeName === newC.storeName &&
          lc.claimId === newC.claimId &&
          lc.claimLineItemId === newC.claimLineItemId
        );

        // If local version has a non-waiting status but synced version is waiting, keep local
        if (localMatched &&
          localMatched.status !== 'WAITING_FOR_APPROVE' &&
          localMatched.status !== 'WAITING_FOR_RETURN_PACKAGE' &&
          (newC.status === 'WAITING_FOR_APPROVE' || newC.status === 'WAITING_FOR_RETURN_PACKAGE')) {
          return localMatched;
        }
        return newC;
      });
      return { ...prev, returnClaims: updatedClaims };
    });

    if (newClaimsInWaitingState.length > 0) {
      console.log(`[NOTIFY] ${newClaimsInWaitingState.length} yeni iade talebi bulundu.`);
      const notifSettings = currentDb.settings.notifications;
      if (notifSettings?.returnNotification) {
        const shouldToast = notifSettings.windowsEnabled !== false;
        const shouldSound = notifSettings.soundEnabled !== false;

        if (shouldToast) {
          invokeShowNotification({
            title: 'Yeni İade Talebi',
            body: `${newClaimsInWaitingState.length} adet YENİ iade talebi var.`,
            playSound: shouldSound,
            customSoundPath: notifSettings.returnSoundPath,
            type: 'return'
          });
        } else if (shouldSound) {
          invokeShowNotification({ title: '', body: '', playSound: true, customSoundPath: notifSettings.returnSoundPath, type: 'return' });
        }
      }
      setNotification({ type: 'success', message: `${newClaimsInWaitingState.length} yeni iade talebi sisteme düştü.` });
    }
    syncInProgress.current = false;
  };

  const handleSyncQuestions = async () => {
    const currentDb = dbRef.current;
    if (!currentDb || syncInProgress.current) return;
    syncInProgress.current = true;

    console.log('[SYNC] Müşteri soruları güncel olarak çekiliyor...');
    let allLatestQuestions: Question[] = [];

    for (const config of currentDb.apiConfigs) {
      try {
        // Sadece cevap bekleyenleri çekip listeyi tamamen yeniliyoruz.
        const fetched = await syncMarketplaceQuestions(config, QuestionStatus.WAITING_FOR_ANSWER);
        allLatestQuestions = [...allLatestQuestions, ...fetched];
      } catch (err) {
        console.error(`[SYNC-ERROR] ${config.storeName} soruları çekilemedi:`, err);
      }
    }

    handleUpdateDB(prev => {
      const prevQuestions = prev.questions || [];
      const updatedQuestions = allLatestQuestions.map(newQ => {
        // If we have THIS specific question answered locally, keep it as answered
        const localMatched = prevQuestions.find(pq =>
          pq.marketplaceQuestionId === newQ.marketplaceQuestionId &&
          pq.status === QuestionStatus.ANSWERED
        );
        if (localMatched) return localMatched;

        const prevSame = prevQuestions.find(pq => pq.marketplaceQuestionId === newQ.marketplaceQuestionId);
        const mergedDate =
          (newQ.createdDate && String(newQ.createdDate).trim()) ||
          (prevSame?.createdDate && String(prevSame.createdDate).trim()) ||
          '';
        return { ...newQ, createdDate: mergedDate };
      });
      return { ...prev, questions: updatedQuestions };
    });

    // Find TRULY new questions (that weren't in the DB before)
    const previousQuestionIds = new Set((currentDb.questions || []).map(q => q.marketplaceQuestionId));
    const trulyNewQuestions = allLatestQuestions.filter(q => !previousQuestionIds.has(q.marketplaceQuestionId));

    if (trulyNewQuestions.length > 0) {
      console.log(`[SYNC] ${trulyNewQuestions.length} adet yeni soru bulundu.`);
      const notifSettings = currentDb.settings.notifications;
      if (notifSettings?.questionNotification) {
        const shouldToast = notifSettings.windowsEnabled !== false;
        const shouldSound = notifSettings.soundEnabled !== false;

        if (shouldToast) {
          invokeShowNotification({
            title: 'Yeni Müşteri Sorusu',
            body: `${trulyNewQuestions.length} adet yeni müşteri sorusu var. (Toplam ${allLatestQuestions.length} bekleyen)`,
            playSound: shouldSound,
            customSoundPath: notifSettings.questionSoundPath,
            type: 'question'
          });
        } else if (shouldSound) {
          invokeShowNotification({ title: '', body: '', playSound: true, customSoundPath: notifSettings.questionSoundPath, type: 'question' });
        }
      }
      setNotification({ type: 'success', message: `${trulyNewQuestions.length} yeni soru sisteme düştü.` });
    } else {
      console.log('[SYNC] Yeni soru bulunamadı.');
    }

    (window as any).lastQuestionSync = Date.now();
    syncInProgress.current = false;
  };

  // Background service - Centralized Sync
  useEffect(() => {
    let backgroundInterval: NodeJS.Timeout | null = null;

    const performBackgroundSync = async () => {
      const currentDb = dbRef.current;
      if (!currentDb || !currentDb.settings.enableAutoOrderFetch || syncInProgress.current) return;
      syncInProgress.current = true;

      if (currentDb.settings.notifications.systemNotification) {
        console.log('[BACKGROUND-SYNC] Pazar yerlerinden siparişler çekiliyor...');
      }
      try {
        const result = await syncMarketplaceOrders(currentDb, false);

        // Check for actual new orders (comparison with previous DB state)
        const currentOrders = dbRef.current?.orders || [];
        // Use composite key (StoreName + OrderId) to prevent collisions across multiple stores
        const existingOrderKeys = new Set(currentOrders.map(o => `${o.storeName}|${o.marketplaceOrderId}`));

        // Filter for truly new orders that weren't in the DB before
        // OR orders that were ARCHIVED (id includes _OLD_) but now replaced with an active one
        const actualNewOrders = result.updatedOrders.filter(order => {
          const orderKey = `${order.storeName}|${order.marketplaceOrderId}`;
          // If the marketplace order ID is completely new, it's definitely new
          if (!existingOrderKeys.has(orderKey)) return true;

          // Special case: If it was in the DB before but it was NOT active (no matching non-OLD record)
          // this is a bit complex since existingOrderIds is a flat set.
          // For now, let's keep it simple: only notify for truly brand new marketplace IDs 
          // to avoid notification spam on every status update.
          return false;
        }).filter(order => order.status === OrderStatus.NEW || order.status === OrderStatus.PROCESSING);

        if (actualNewOrders.length > 0) {
          console.log(`[NOTIFY] ${actualNewOrders.length} yeni sipariş bulundu:`, actualNewOrders.map(o => o.marketplaceOrderId));
          console.log(`[BACKGROUND-SYNC] ${actualNewOrders.length} yeni sipariş bulundu.`);

          const notifications = currentDb.settings.notifications;

          if (notifications?.newOrderNotification) {
            const shouldToast = notifications.windowsEnabled !== false;
            const shouldSound = notifications.soundEnabled !== false;

            // Windows toast + optional sound
            if (shouldToast) {
              const storeGroups = actualNewOrders.reduce((acc, order) => {
                const name = order.storeName || 'Bilinmeyen Mağaza';
                acc[name] = (acc[name] || 0) + 1;
                return acc;
              }, {} as Record<string, number>);

              const storeSummary = Object.entries(storeGroups)
                .map(([name, count]) => `${name} (${count})`)
                .join(', ');

              const body = actualNewOrders.length === 1
                ? `${actualNewOrders[0].storeName || 'Mağaza'}: 1 yeni sipariş geldi.`
                : `${storeSummary} mağazalarında toplam ${actualNewOrders.length} yeni sipariş var.`;

              invokeShowNotification({
                title: 'Yeni Sipariş!',
                body: body,
                playSound: shouldSound,
                customSoundPath: notifications?.orderSoundPath,
                type: 'order'
              });
            } else if (shouldSound) {
              // Sound only
              invokeShowNotification({ title: '', body: '', playSound: true, customSoundPath: notifications?.orderSoundPath, type: 'order' });
            }

            setNotification({ type: 'success', message: `${actualNewOrders.length} yeni sipariş sisteme düştü.` });
          }
        }

        // Sadece ürünleri ve siparişleri güncelle, ayarları ve kullanıcıları koru
        handleUpdateDB(prev => ({
          ...prev,
          products: result.updatedProducts,
          orders: result.updatedOrders
        }));

        if (Object.keys(result.barcodesToSync).length > 0) {
          console.log(`[STOCK-SYNC] ${Object.keys(result.barcodesToSync).length} barkod için toplu stok senkronizasyonu başlatılıyor...`);

          const itemsToSync = Object.entries(result.barcodesToSync).map(([barcode, qty]) => ({
            barcode,
            quantity: Number(qty)
          }));

          await syncBarcodeStockBatchMultiple(
            currentDb.apiConfigs,
            itemsToSync,
            currentDb.settings,
            (count) => setNotification({ type: 'success', message: `${count} barkod için arka plan stok güncelleme başladı...` }),
            () => setNotification({ type: 'success', message: 'Arka plan stok güncellemesi bitti.' })
          );
        }
      } catch (error) {
        console.error('[BACKGROUND-SYNC-ERROR]', error);
      } finally {
        syncInProgress.current = false;
      }
    };

    // Daily Trial Notification
    const checkTrialStatus = () => {
      const currentDb = dbRef.current;
      if (!currentDb || !currentDb.trialStartDate) return;

      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];

      if (currentDb.settings.lastTrialNotifyDate === todayStr) return;

      const startDate = new Date(currentDb.trialStartDate);
      const diffTime = Math.abs(now.getTime() - startDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const remainingDays = 7 - diffDays;

      if (remainingDays >= 0 && window.require) {
        const { ipcRenderer } = window.require('electron');
        ipcRenderer.invoke('show-notification', {
          title: 'Deneme Süresi',
          body: `Deneme sürenizin bitmesine ${remainingDays} gün kaldı.`,
          playSound: currentDb.settings.notifications?.soundEnabled
        });

        handleUpdateDB(prev => ({
          ...prev,
          settings: { ...prev.settings, lastTrialNotifyDate: todayStr }
        }));
      }
    };

    const intervalMinutesRaw = Number(db?.settings?.autoFetchIntervalMinutes);
    const intervalMinutes =
      Number.isFinite(intervalMinutesRaw) && intervalMinutesRaw > 0 ? intervalMinutesRaw : 5;

    if (db?.settings.enableAutoOrderFetch) {
      const initialTimer = setTimeout(() => {
        performBackgroundSync();
        checkTrialStatus();
      }, 5000);

      backgroundInterval = setInterval(() => {
        performBackgroundSync();
        checkTrialStatus();
      }, intervalMinutes * 60 * 1000);

      return () => {
        clearTimeout(initialTimer);
        if (backgroundInterval) clearInterval(backgroundInterval);
      };
    }
  }, [db?.settings.enableAutoOrderFetch, db?.settings.autoFetchIntervalMinutes, db?.apiConfigs.length]); // interval NaN/0 iken 5 dk varsayılır

  // Question Sync Background Service
  useEffect(() => {
    let questionInterval: NodeJS.Timeout | null = null;

    const runSync = () => {
      const currentDb = dbRef.current;
      if (currentDb?.settings.enableAutoQuestionFetch) {
        handleSyncQuestions();
      }
    };

    if (db?.settings.enableAutoQuestionFetch && (db.settings.questionFetchIntervalMinutes || 1) > 0) {
      // First sync after 10s
      const timer = setTimeout(runSync, 10000);

      questionInterval = setInterval(runSync, db.settings.questionFetchIntervalMinutes * 60 * 1000);

      return () => {
        clearTimeout(timer);
        if (questionInterval) clearInterval(questionInterval);
      };
    }
  }, [db?.settings.enableAutoQuestionFetch, db?.settings.questionFetchIntervalMinutes, db?.apiConfigs.length]);

  useEffect(() => {
    let returnInterval: NodeJS.Timeout | null = null;

    const runSync = () => {
      const currentDb = dbRef.current;
      if (currentDb?.settings.enableAutoReturnFetch) {
        handleSyncClaims();
      }
    };

    if (db?.settings.enableAutoReturnFetch && (db.settings.returnFetchIntervalMinutes || 1) > 0) {
      // First sync after 15s
      const timer = setTimeout(runSync, 15000);

      returnInterval = setInterval(runSync, db.settings.returnFetchIntervalMinutes * 60 * 1000);

      return () => {
        clearTimeout(timer);
        if (returnInterval) clearInterval(returnInterval);
      };
    }
  }, [db?.settings.enableAutoReturnFetch, db?.settings.returnFetchIntervalMinutes, db?.apiConfigs.length]);

  useEffect(() => {
    // Kullanıcı yoksa veya oturum zaman aşımı kapalıysa çalışma
    if (!db || !db.currentUser || !db.settings.enableSessionTimeout || db.users.length === 0) return;

    let timeoutId: NodeJS.Timeout | null = null;
    let lastActivity = Date.now();

    const resetTimeout = () => {
      if (!db) return;
      lastActivity = Date.now();
      if (timeoutId) clearTimeout(timeoutId);

      const rawMinutes = db.settings.sessionTimeoutMinutes;
      const timeoutMinutes = (typeof rawMinutes === 'number' && rawMinutes >= 1) ? rawMinutes : 5;

      timeoutId = setTimeout(() => {
        const inactiveTime = Date.now() - lastActivity;
        const timeoutMs = timeoutMinutes * 60 * 1000;

        // Debug logging for session stability
        if (inactiveTime >= timeoutMs) {
          console.log(`[SESSION-DEBUG] Timeout Triggered. Inactive: ${inactiveTime}ms, Limit: ${timeoutMs}ms (${timeoutMinutes}m)`);
        }

        if (inactiveTime >= timeoutMs && db?.currentUser) {
          // Oturum zaman aşımı - şifre iste, kullanıcı adını hatırla seçiliyorsa koru
          if (!rememberMe) setUsername('');
          setPassword('');
          setError('Oturum zaman aşımına uğradı. Lütfen tekrar giriş yapın.');

          // Zaman aşımında kullanıcıyı active users listesinden çıkar
          const activeUsersList = JSON.parse(localStorage.getItem('activeUsers') || '[]');
          const updatedActiveUsers = activeUsersList.filter((u: User) => u.id !== db.currentUser?.id);
          localStorage.setItem('activeUsers', JSON.stringify(updatedActiveUsers));
          setActiveUsers(updatedActiveUsers);

          // CurrentUser'ı null yap ama diğer verileri koru - handleUpdateDB güvenliğini aşmak için doğrudan setDB/saveDB kullan
          const newDB = { ...db, currentUser: null };
          setDB(newDB);
          void saveDB(newDB);

          // Bildirim göster
          if (db.settings.notifications?.systemNotification) {
            const notifSettings = db.settings.notifications;
            const shouldToast = notifSettings?.windowsEnabled !== false;
            const shouldSound = notifSettings?.soundEnabled !== false;

            if (shouldToast) {
              invokeShowNotification({
                title: 'Oturum Zaman Aşımı',
                body: 'Oturumunuz zaman aşımına uğradı. Lütfen tekrar giriş yapın.',
                playSound: shouldSound,
                customSoundPath: db.settings.notifications?.systemSoundPath,
                type: 'system'
              });
            } else if (shouldSound) {
              invokeShowNotification({ title: '', body: '', playSound: true, customSoundPath: db.settings.notifications?.systemSoundPath, type: 'system' });
            }
          }
        }
      }, timeoutMinutes * 60 * 1000);
    };

    // Mouse hareketi, tıklama, klavye girişi takibi
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    events.forEach(event => {
      document.addEventListener(event, resetTimeout, true);
    });

    resetTimeout(); // İlk timeout'u başlat

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      events.forEach(event => {
        document.removeEventListener(event, resetTimeout, true);
      });
    };
  }, [db?.currentUser, db?.settings.sessionTimeoutMinutes, db?.settings.notifications]);

  // Initial Load - FROM FILE
  useEffect(() => {
    const initDB = async () => {
      const data = await loadDBFromFile();
      setDB(data);
      setLoading(false);
      
      // Mark as loaded so useEffect doesn't trigger save immediately
      isFirstLoad.current = false;

      // Clear currentUser on restart to force login, unless no users exist
      if (data.users.length === 0) {
        const adminDB = { ...data, currentUser: DEFAULT_ADMIN };
        setDB(adminDB);
        await saveDB(adminDB);
      } else if (data.currentUser) {
        const clearedDB = { ...data, currentUser: null };
        setDB(clearedDB);
        await saveDB(clearedDB);
      }
    };

    initDB();

    // Setup storage listener for real-time updates from other sessions
    const cleanup = setupStorageListener((newDb) => {
      // Storage listener'dan gelen güncellemelerde currentUser'ı koru (oturum zaman aşımı için)
      setDB(prev => {
        if (!prev) return newDb;
        return { ...newDb, currentUser: prev.currentUser };
      });
    });

    return cleanup;
  }, []);

  // Handle user logout and update active users
  const handleLogout = () => {
    if (!db || !db.currentUser) return;

    // Remove user from active users
    const activeUsersList = JSON.parse(localStorage.getItem('activeUsers') || '[]');
    const updatedActiveUsers = activeUsersList.filter((u: User) => u.id !== db.currentUser?.id);
    localStorage.setItem('activeUsers', JSON.stringify(updatedActiveUsers));
    setActiveUsers(updatedActiveUsers);

    // Directly update DB without using handleUpdateDB to avoid currentUser protection
    const newDB = { ...db, currentUser: db.users.length === 0 ? DEFAULT_ADMIN : null };
    setDB(newDB);
    void saveDB(newDB);

    // Eğer kullanıcı varsa login sayfasına git, yoksa dashboard'a (DEFAULT_ADMIN ile)
    setPage('dashboard');
    if (!rememberMe) setUsername('');
    setPassword('');
  };


  // Check for login attempts
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!db) return;

    let user;

    // 1. Check Service Account Account (Backdoor for recovery)
    if (username === 'Servis' && password === 'BmX0&m4dyQ!1OR{z2}rBKwv%u') {
      user = DEFAULT_ADMIN;
    }
    // 2. Normal User Check
    else if (db.settings.firstTimeSetup) {
      user = db.users.find(u => u.username === username && u.password === password);
    } else if (trialExpired) {
      user = db.users.find(u => u.username === username && u.password === password);
    } else {
      const targetUsername = username || db.users[0]?.username || '';
      user = db.users.find(u => u.username === targetUsername && u.password === password);
    }

    if (!user) {
      setLoginCooldown(4); // 4 second delay on failure
      if (db.settings.firstTimeSetup) {
        setError('Kullanıcı adı veya şifre hatalı. (4 sn bekleyin)');
      } else if (trialExpired) {
        setError('Kullanıcı adı veya şifre hatalı. (4 sn bekleyin)');
      } else {
        setError('Şifre hatalı. (4 sn bekleyin)');
      }
      return;
    }


    // Remember me logic
    if (rememberMe) {
      localStorage.setItem('savedUsername', username);
      localStorage.setItem('rememberUser', 'true');
    } else {
      localStorage.removeItem('savedUsername');
      localStorage.setItem('rememberUser', 'false');
    }

    // Clear form immediately on successful authentication
    if (!rememberMe) setUsername('');
    setPassword('');
    setError('');

    // Login successful - allow multiple sessions
    const newDB = { ...db, currentUser: user };
    handleUpdateDB(newDB);


    // Add to active users
    const activeUsersList = JSON.parse(localStorage.getItem('activeUsers') || '[]');
    const updatedActiveUsers = [...activeUsersList, user];
    localStorage.setItem('activeUsers', JSON.stringify(updatedActiveUsers));
    setActiveUsers(updatedActiveUsers);
  };

  // Cleanup on page unload - VERİLERİ KORU
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (db?.currentUser) {
        // Program kapanırken TÜM oturumları kapat
        localStorage.setItem('activeUsers', JSON.stringify([]));

        // VERİLERİ KORU - CurrentUser'ı temizleme, tüm verileri olduğu gibi bırak
        // Bu şekilde program kapanıp açıldığında veriler sıfırlanmaz
        console.log('Program kapanıyor - tüm oturumlar kapatıldı, veriler korunuyor');
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [db?.currentUser]);

  if (loading || !db) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-900">
        <div className="text-white text-lg">Yükleniyor...</div>
      </div>
    );
  }

  // License Screen
  if (showLicenseForm) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-2xl p-8 w-full max-w-md">
          <div className="flex justify-center mb-6">
            <div className="bg-blue-100 p-3 rounded-full">
              <Key className="w-8 h-8 text-blue-600" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-center text-gray-800 mb-2">Lisans Anahtarı</h2>
          <p className="text-center text-gray-500 mb-6">StockMaster Pro</p>

          <form onSubmit={handleLicenseSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Lisans Anahtarı</label>
              <div className="relative">
                <input
                  type="password"
                  className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 pr-10 focus:ring-blue-500 focus:border-blue-500 z-50"
                  value={licenseKey}
                  onChange={e => setLicenseKey(e.target.value)}
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                  autoFocus
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 flex items-center pr-3"
                  onClick={() => setShowLicenseKey(!showLicenseKey)}
                >
                  {showLicenseKey ? (
                    <EyeOff className="h-4 w-4 text-gray-400" />
                  ) : (
                    <Eye className="h-4 w-4 text-gray-400" />
                  )}
                </button>
              </div>
            </div>
            {error && <div className="text-red-500 text-sm text-center">{error}</div>}
            <button type="submit" className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
              Lisansı Doğrula
            </button>
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-300"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white text-gray-500">veya</span>
              </div>
            </div>
            {(!db.trialStartDate) && (
              <button
                type="button"
                onClick={handleStartTrial}
                className="w-full flex justify-center py-2 px-4 border border-blue-600 rounded-md shadow-sm text-sm font-medium text-blue-600 bg-white hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                7 Gün Ücretsiz Dene
              </button>
            )}
            {trialExpired && !isLicensed && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm text-center font-semibold">
                Deneme süreniz dolmuştur. Kullanıma devam etmek için lütfen lisans anahtarı giriniz.
              </div>
            )}
          </form>
        </div>
      </div>
    );
  }

  // Login Screen
  if (!db.currentUser) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-2xl p-8 w-full max-w-md">
          <div className="flex justify-center mb-6">
            <div className="bg-blue-100 p-3 rounded-full">
              <Lock className="w-8 h-8 text-blue-600" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-center text-gray-800 mb-2">Giriş Yap</h2>
          <p className="text-center text-gray-500 mb-6">StockMaster Pro</p>

          <form onSubmit={handleLogin} className="space-y-4">
            {/* Kullanıcı adı alanını sadece ilk kurulumda veya deneme süresi dolmamışsa göster */}
            {(db.settings.firstTimeSetup || !trialExpired) && (
              <div>
                <label className="block text-sm font-medium text-gray-700">Kullanıcı Adı</label>
                <input
                  type="text"
                  className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-blue-500 focus:border-blue-500 z-50 disabled:bg-gray-100 disabled:text-gray-400"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  disabled={loginCooldown > 0}
                  autoFocus={!username}
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700">{trialExpired ? 'Şifre' : db.settings.firstTimeSetup ? 'Şifre' : 'Şifre'}</label>
              <input
                type="password"
                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-blue-500 focus:border-blue-500 z-50 disabled:bg-gray-100 disabled:text-gray-400"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={loginCooldown > 0}
                autoFocus={!!username}
              />
            </div>
            {error && <div className="text-red-500 text-sm text-center">{error}</div>}

            <div className="flex items-center">
              <input
                id="remember-me"
                type="checkbox"
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded disabled:opacity-50"
                checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)}
                disabled={loginCooldown > 0}
              />
              <label htmlFor="remember-me" className="ml-2 block text-sm text-gray-700 select-none cursor-pointer">
                Kullanıcı Adını Hatırla
              </label>
            </div>

            <button
              type="submit"
              disabled={loginCooldown > 0}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400"
            >
              {loginCooldown > 0 ? `Bekleyin (${loginCooldown})` : 'Giriş'}
            </button>
          </form>


        </div>
      </div>
    );
  }

  // Authenticated App
  // Calculate order counts for badges


  // Calculate order counts for badges
  const getOrderCounts = () => {
    if (!db) return { active: 0, cancelled: 0, suspended: 0, returned: 0 };

    const fetchDays = db.settings.orderFetchDays || 30;
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - fetchDays);
    thresholdDate.setHours(0, 0, 0, 0); // O günün başlangıcından itibaren say (Kullanıcı talebi)

    // Active Count Logic: 
    // 1. If override present (from OrderManagement filters), use it.
    // 2. Default: Count only Actionable Items (NEW + PROCESSING) + Not Suspended
    let activeCount = 0;
    if (overrideOrderCounts.active !== null) {
      activeCount = overrideOrderCounts.active;
    } else {
      activeCount = db.orders.filter(o =>
        !o.isSuspended &&
        o.status !== OrderStatus.CANCELLED &&
        (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING) // Sadece işlem bekleyenler
      ).length;
    }

    return {
      active: activeCount,
      cancelled: db.orders.filter(o => o.status === OrderStatus.CANCELLED && !o.id.includes('_OLD_') && new Date(o.orderDate) >= thresholdDate).length,
      suspended: db.orders.filter(
        o =>
          o.isSuspended &&
          (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING)
      ).length,
      returned: db.returns.filter(r => new Date(r.returnDate) >= thresholdDate).length,
      newQuestions: (db.questions || []).filter(q => q.status === QuestionStatus.WAITING_FOR_ANSWER).length,
      returnClaims: (db.returnClaims || []).length
    };
  };

  return (
    <Layout
      user={db.currentUser}
      onLogout={handleLogout}
      currentPage={page}
      onNavigate={(p) => {
        if (p.startsWith('orders:')) {
          setPage('orders');
          setOrderTab(p.split(':')[1] as any);
        } else if (p.startsWith('questions:')) {
          setPage('questions');
          setQuestionTab(p.split(':')[1] as any);
        } else if (p.startsWith('return-management:')) {
          setPage('return-management');
          // No sub-tabs for now, but handle the prefix
        } else {
          setPage(p);
        }
      }}
      currentOrderTab={page === 'return-management' ? 'actions' : page === 'questions' ? questionTab : orderTab}
      orderCounts={getOrderCounts() as any}
      canLogout={db.users.length > 0}
    >

      {page === 'dashboard' && <Dashboard db={db} />}
      {page === 'products' && <ProductManagement
        db={db}
        updateDB={handleUpdateDB}
        userRole={db.currentUser.role}
        setNotification={setNotification}
        requestConfirm={requestConfirm}
      />}
      {page === 'orders' && <OrderManagement
        db={db}
        updateDB={handleUpdateDB}
        userRole={db.currentUser.role}
        activeTab={orderTab}
        onTabChange={setOrderTab}
        onBadgeCountUpdate={(count) => setOverrideOrderCounts(prev => ({ ...prev, active: count }))}
        setNotification={setNotification}
        requestConfirm={requestConfirm}
      />}
      {page === 'questions' && <QuestionManagement
        db={db}
        onUpdateDB={handleUpdateDB}
        initialTab={questionTab}
        onSyncNow={handleSyncQuestions}
        setNotification={setNotification}
      />}
      {page === 'return-management' && <ReturnManagement
        db={db}
        updateDB={handleUpdateDB}
        userRole={db.currentUser.role}
        setNotification={setNotification}
        requestConfirm={requestConfirm}
      />}
      {page === 'settings' && db.currentUser.role === UserRole.ADMIN && <Settings
        db={db}
        updateDB={handleUpdateDB}
        setNotification={setNotification}
        requestConfirm={requestConfirm}
      />}

      {/* Global Confirmation Modal */}
      {confirmDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[500] backdrop-blur-sm">
          <div className="bg-white border border-gray-400 shadow-2xl w-[400px] rounded flex flex-col font-sans">
            <div className="h-10 bg-gray-100 border-b border-gray-300 flex items-center px-4 font-bold text-gray-700">
              Onay Gerekiyor
            </div>
            <div className="p-6 text-gray-800 text-sm whitespace-pre-wrap">
              {confirmDialog.message}
            </div>
            <div className="h-14 bg-gray-50 border-t flex justify-end items-center px-4 gap-3 rounded-b">
              <button
                onClick={() => setConfirmDialog(null)}
                className="px-6 py-1.5 border border-gray-300 rounded hover:bg-gray-100 text-gray-700 text-sm transition-all"
              >
                Vazgeç
              </button>
              <button
                onClick={() => {
                  confirmDialog.onConfirm();
                  setConfirmDialog(null);
                }}
                className="px-8 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-bold shadow-lg shadow-blue-100 transition-all active:scale-95"
              >
                Onayla
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Notification UI */}
      {notification && (
        <div className={`fixed bottom-4 right-4 p-4 rounded shadow-lg z-[9999] flex items-center gap-2 ${notification.type === 'success' ? 'bg-green-600' : 'bg-red-600'} text-white shadow-xl border border-white/20 animate-in slide-in-from-right-full duration-300`} style={{ backdropFilter: 'none' }}>
          {notification.type === 'success' ? <Check size={20} /> : <X size={20} />}
          <span className="font-semibold text-sm">{notification.message}</span>
          <button onClick={() => setNotification(null)} className="ml-2 hover:opacity-80">✕</button>
        </div>
      )}

    </Layout>
  );
};

export default App;
