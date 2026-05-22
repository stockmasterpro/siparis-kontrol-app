
import React, { useState } from 'react';
import { Database, UserRole, ApiConfig } from '../types';
import { exportBackup, importBackup, resetToFactoryDefaults } from '../services/db';
import { syncBarcodeStock } from '../services/integration';
import { Save, UserPlus, Trash, RotateCcw, UploadCloud, Loader2, Edit, X, ShoppingCart, Key, Check, MessageSquare, Plus, Clock, Infinity, Package, BarChart3, LayoutDashboard, Volume2, RefreshCw } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

const AVAILABLE_SOUNDS = [
    { name: 'Yok (Sessiz)', file: 'none' },
    { name: 'Beep Once', file: 'Beep_Once.wav' },
    { name: 'Clover', file: 'Clover.wav' },
    { name: 'Country Blues', file: 'Country_Blues1.wav' },
    { name: 'Crystal', file: 'Crystal.wav' },
    { name: 'Crystal High', file: 'Crystal1.wav' },
    { name: 'Crystal Drop', file: 'Crystal_Drop.wav' },
    { name: 'Doorbell', file: 'Doorbell.wav' },
    { name: 'Drip', file: 'Drip.wav' },
    { name: 'Hello', file: 'Hello.wav' },
    { name: 'Lilac', file: 'Lilac.wav' },
    { name: 'Microwave Oven', file: 'Microwave_Oven.wav' },
    { name: 'New Mail', file: 'NewMail.wav' },
    { name: 'Old Bicycle', file: 'Old_Bicycle.wav' },
    { name: 'Pure', file: 'Pure.wav' },
    { name: 'Dew Drops', file: 'S_Dew_drops.wav' },
    { name: 'Knock', file: 'S_Knock.wav' },
    { name: 'Pure Bell', file: 'S_Pure_Bell.wav' },
    { name: 'Woodpecker', file: 'Woodpecker.wav' },
    { name: 'Postacı Geliyor', file: 'bak-postaci-geliyor.wav' },
    { name: 'Fresh', file: 'fresh.wav' },
    { name: 'Notification', file: 'notification.wav' }
];

interface Props {
    db: Database;
    updateDB: (newDB: Database) => void;
    setNotification: (notif: { type: 'success' | 'error', message: string } | null) => void;
    requestConfirm: (message: string, onConfirm: () => void) => void;
}

export const Settings: React.FC<Props> = ({ db, updateDB, setNotification, requestConfirm }) => {
    const [activeTab, setActiveTab] = useState<'api' | 'users' | 'system' | 'license'>('api');
    const [isSyncingStocks, setIsSyncingStocks] = useState(false);
    const [tempKey, setTempKey] = useState('');

    // API Form
    const [newApi, setNewApi] = useState<ApiConfig>({
        id: '',
        storeName: '',
        type: 'TRENDYOL',
        apiKey: '',
        apiSecret: '',
        supplierId: '',
        mode: 'LIVE',
        enableStockSync: true,
        isOrderSyncEnabled: true,
        isQuestionSyncEnabled: true,
        isReturnSyncEnabled: true,
        color: '#3b82f6'
    });
    const [isEditingApi, setIsEditingApi] = useState(false);

    const resetApiForm = () => {
        setNewApi({
            id: '',
            storeName: '',
            type: 'TRENDYOL',
            apiKey: '',
            apiSecret: '',
            supplierId: '',
            mode: 'LIVE',
            enableStockSync: true,
            isOrderSyncEnabled: true,
            isQuestionSyncEnabled: true,
            isReturnSyncEnabled: true,
            color: '#3b82f6'
        });
        setIsEditingApi(false);
    };



    const handleAddApi = async () => {
        if (!newApi.storeName) {
            setNotification({ type: 'error', message: "Mağaza adı zorunludur." });
            return;
        }

        if (newApi.type === 'TRENDYOL' && (!newApi.apiKey || !newApi.apiSecret || !newApi.supplierId)) {
            setNotification({ type: 'error', message: "API bilgileri zorunludur." });
            return;
        }

        if (isEditingApi && newApi.id) {
            updateDB(prev => ({
                ...prev,
                apiConfigs: prev.apiConfigs.map(a => a.id === newApi.id ? { ...newApi } : a)
            }));
            resetApiForm();
            setNotification({ type: 'success', message: "API güncellendi." });
            return;
        }

        // Kısıtlama olmadan ekle (v1.2.0 sınırsız API)
        updateDB(prev => ({ ...prev, apiConfigs: [...prev.apiConfigs, { ...newApi, id: uuidv4() }] }));

        resetApiForm();
        setNotification({ type: 'success', message: "API konfigürasyonu başarıyla eklendi." });
    };

    // Lisans durumunu kontrol et (render için)
    const [isLicenseValid, setIsLicenseValid] = React.useState(false);
    React.useEffect(() => {
        const checkLicense = async () => {
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                const licensed = await ipcRenderer.invoke('is-licensed');
                if (licensed) {
                    setIsLicenseValid(true);
                    return;
                }
                if (db.settings.licenseKey) {
                    const valid = await ipcRenderer.invoke('validate-license', db.settings.licenseKey);
                    setIsLicenseValid(valid);
                    return;
                }
            } else {
                const normalize = (val: string) => (val || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                setIsLicenseValid(normalize(db.settings.licenseKey) === normalize("8F3KQ-9A7M2-LP5XW-4Z8N6-YT2RD"));
            }
        };
        checkLicense();
    }, [db.settings.licenseKey]);

    const handleDeleteApi = (id: string) => {
        requestConfirm("Bu entegrasyonu silmek istediğinize emin misiniz?", () => {
            updateDB(prev => ({ ...prev, apiConfigs: prev.apiConfigs.filter(a => a.id !== id) }));
        });
    };

    const handleEditApiClick = (api: ApiConfig) => {
        setNewApi({
            ...api,
            enableStockSync: api.enableStockSync !== false,
            isOrderSyncEnabled: api.isOrderSyncEnabled !== false,
            isQuestionSyncEnabled: api.isQuestionSyncEnabled !== false,
            isReturnSyncEnabled: api.isReturnSyncEnabled !== false
        });
        setIsEditingApi(true);
    };

    // User Mgmt
    const [userForm, setUserForm] = useState({ id: '', username: '', password: '', name: '', role: UserRole.ADMIN });
    const [isEditingUser, setIsEditingUser] = useState(false);

    const handleSaveUser = () => {
        if (!userForm.username || !userForm.password) {
            setNotification({ type: 'error', message: "Kullanıcı adı ve şifre zorunludur." });
            return;
        }

        // Check: Don't allow creating a Staff if no Admin exists
        if (userForm.role === UserRole.USER && !db.users.some(u => u.role === UserRole.ADMIN)) {
            setNotification({ type: 'error', message: "Sisteme önce bir Yönetici profili eklenmelidir. Personel profili ancak yönetici hesabından sonra oluşturulabilir." });
            return;
        }

        updateDB(prev => {
            let updatedUsers = [...prev.users];

            if (isEditingUser && userForm.id) {
                // Update existing user
                updatedUsers = updatedUsers.map(u => u.id === userForm.id ? { ...userForm } : u);
            } else {
                // Create new user
                if (prev.users.some(u => u.username === userForm.username)) {
                    setNotification({ type: 'error', message: "Bu kullanıcı adı zaten kullanılıyor." });
                    return prev;
                }
                updatedUsers.push({ ...userForm, id: uuidv4() });
            }

            return { ...prev, users: updatedUsers };
        });

        setNotification({ type: 'success', message: isEditingUser ? "Kullanıcı güncellendi." : "Kullanıcı başarıyla eklendi." });
        resetUserForm();
    };

    const handleEditUserClick = (user: any) => {
        setUserForm({ ...user });
        setIsEditingUser(true);
    };

    const handleDeleteUser = (id: string) => {
        requestConfirm('Kullanıcıyı silmek istediğinize emin misiniz?', () => {
            updateDB(prev => {
                const newUsers = prev.users.filter(u => u.id !== id);
                const isDeletingSelf = prev.currentUser?.id === id;

                // Return updated DB
                if (isDeletingSelf) {
                    // If deleting self, force logout or revert to DEFAULT_ADMIN if no users left
                    return {
                        ...prev,
                        users: newUsers,
                        currentUser: newUsers.length === 0 ? null : null // App.tsx handles the null -> login redirect
                    };
                }

                return { ...prev, users: newUsers };
            });

            setNotification({ type: 'success', message: "Kullanıcı silindi." });
        });
    };


    const resetUserForm = () => {
        setUserForm({ id: '', username: '', password: '', name: '', role: UserRole.ADMIN });
        setIsEditingUser(false);
    };





    const handleBulkStockUpdate = async () => {
        if (db.apiConfigs.length === 0) {
            setNotification({ type: 'error', message: "Pazaryeri entegrasyonu tanımlı değil." });
            return;
        }

        requestConfirm("DİKKAT: Veritabanındaki TÜM ürün stokları (barkod bazlı), tanımlı TÜM pazaryerlerine gönderilecek. Bu işlem zaman alabilir.\n\nOnaylıyor musunuz?", async () => {
            setIsSyncingStocks(true);

            // Tüm barkodları ve stoklarını topla (barkod bazlı)
            const barcodesToSync: { [barcode: string]: number } = {};
            let totalBarcodes = 0;

            db.products.forEach(p => {
                p.variants.forEach(v => {
                    if (v.barcode) {
                        // Her barkod için kendi stok değerini hesapla
                        const totalStock = Object.values(v.stocks).reduce((a: number, b: number) => a + b, 0);
                        barcodesToSync[v.barcode] = totalStock as number;
                        totalBarcodes++;
                    }
                });
            });

            let successCount = 0;
            let errorCount = 0;

            // Her barkod için ayrı ayrı stok gönder
            for (const [barcode, qty] of Object.entries(barcodesToSync)) {
                try {
                    await syncBarcodeStock(db.apiConfigs, barcode, qty, db.settings);
                    successCount++;
                } catch (error) {
                    console.error(`Barkod ${barcode} stok gönderim hatası:`, error);
                    errorCount++;
                }
                // Progress göster (her 10 barkodda bir)
                if ((successCount + errorCount) % 10 === 0) {
                    console.log(`İlerleme: ${successCount + errorCount}/${totalBarcodes} barkod işlendi...`);
                }
            }

            setIsSyncingStocks(false);

            if (errorCount > 0) {
                setNotification({ type: 'error', message: `Toplu stok güncelleme tamamlandı.\nBaşarılı: ${successCount} barkod\nHatalı: ${errorCount} barkod` });
            } else {
                setNotification({ type: 'success', message: `Toplu stok güncelleme tamamlandı.\n${successCount} barkodun stok bilgileri pazaryerlerine gönderildi.` });
            }
        });
    };


    const handleTestNotification = async (customPath, type) => {
        if (!window.require) {
            setNotification({ type: 'error', message: "Bu özellik sadece masaüstü uygulamasında çalışır." });
            return;
        }
        try {
            setNotification({ type: 'success', message: "Bildirim testi başlatıldı..." });

            const { ipcRenderer } = window.require('electron');
            const result = await ipcRenderer.invoke('test-notification', customPath, type);
            console.log('[TEST-NOTIFICATION-RESULT]', result);

            if (!result.soundExists) {
                setNotification({ type: 'error', message: `Ses dosyası bulunamadı! Yol: ${result.soundPath}` });
            } else {
                setNotification({ type: 'success', message: "Bildirim testi başarıyla tamamlandı. Ses ve bildirim gelmiş olmalı." });
            }
        } catch (error) {
            console.error('Test notification error:', error);
            setNotification({ type: 'error', message: "Bildirim testi sırasında hata oluştu." });
        }
    };

    const handleUpdateSound = (type, fileName) => {
        updateDB(prev => ({
            ...prev,
            settings: {
                ...prev.settings,
                notifications: {
                    ...prev.settings.notifications,
                    [type + 'SoundPath']: fileName
                }
            }
        }));
        setNotification({ type: 'success', message: 'Bildirim sesi güncellendi.' });
    };

    const handleResetSound = (type) => {
        updateDB(prev => ({
            ...prev,
            settings: {
                ...prev.settings,
                notifications: {
                    ...prev.settings.notifications,
                    [type + 'SoundPath']: undefined
                }
            }
        }));
        setNotification({ type: 'success', message: 'Bildirim sesi varsayılana sıfırlandı.' });
    };

    return (
        <div className="bg-white rounded-lg shadow min-h-[500px] flex">
            <div className="w-48 border-r bg-gray-50 p-4 space-y-2">
                <button onClick={() => setActiveTab('api')} className={`w-full text-left px-4 py-2 rounded ${activeTab === 'api' ? 'bg-blue-100 text-blue-700 font-bold' : 'hover:bg-gray-200'}`}>API ve Mağaza Ayarları</button>
                <button onClick={() => setActiveTab('users')} className={`w-full text-left px-4 py-2 rounded ${activeTab === 'users' ? 'bg-blue-100 text-blue-700 font-bold' : 'hover:bg-gray-200'}`}>Kullanıcılar</button>
                <button onClick={() => setActiveTab('license')} className={`w-full text-left px-4 py-2 rounded ${activeTab === 'license' ? 'bg-blue-100 text-blue-700 font-bold' : 'hover:bg-gray-200'}`}>Lisans Yönetimi</button>

                <button onClick={() => setActiveTab('system')} className={`w-full text-left px-4 py-2 rounded ${activeTab === 'system' ? 'bg-blue-100 text-blue-700 font-bold' : 'hover:bg-gray-200'}`}>Yedekleme & Sistem</button>
            </div>

            <div className="flex-1 p-8">
                {activeTab === 'api' && (
                    <div>
                        <h3 className="text-xl font-bold mb-6">API ve Mağaza Yönetimi</h3>
                        <div className="bg-gray-50 p-4 rounded border mb-4 relative">
                            {isEditingApi && (
                                <button
                                    onClick={resetApiForm}
                                    className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1 shadow hover:bg-red-600"
                                    title="İptal Et"
                                >
                                    <X size={14} />
                                </button>
                            )}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="col-span-1">
                                    <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Mağaza Tipi</label>
                                    <select
                                        className="w-full border p-2 rounded bg-white"
                                        value={newApi.type}
                                        onChange={e => setNewApi({ ...newApi, type: e.target.value as 'TRENDYOL' | 'MANUAL' })}
                                    >
                                        <option value="TRENDYOL">Trendyol Pazaryeri (API)</option>
                                        <option value="MANUAL">Perakende / Manuel Mağaza</option>
                                    </select>
                                </div>
                                <div className="col-span-1">
                                    <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Mağaza Adı</label>
                                    <input className="w-full border p-2 rounded" placeholder="Örn: Güngören Şubesi" value={newApi.storeName} onChange={e => setNewApi({ ...newApi, storeName: e.target.value })} />
                                </div>

                                {newApi.type === 'TRENDYOL' && (
                                    <>
                                        <div className="col-span-1">
                                            <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Satıcı ID (Supplier ID)</label>
                                            <input className="w-full border p-2 rounded" placeholder="Supplier ID" value={newApi.supplierId} onChange={e => setNewApi({ ...newApi, supplierId: e.target.value })} />
                                        </div>
                                        <div className="col-span-1">
                                            <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Çalışma Modu</label>
                                            <select
                                                className="w-full border p-2 rounded bg-white"
                                                value={newApi.mode || 'TEST'}
                                                onChange={e => setNewApi({ ...newApi, mode: e.target.value as 'TEST' | 'LIVE' })}
                                            >
                                                <option value="TEST">Test Ortamı (Sandbox)</option>
                                                <option value="LIVE">Canlı Ortam (Production)</option>
                                            </select>
                                        </div>
                                        <div className="col-span-1">
                                            <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">API Key</label>
                                            <input className="w-full border p-2 rounded" placeholder="API Key" value={newApi.apiKey} onChange={e => setNewApi({ ...newApi, apiKey: e.target.value })} />
                                        </div>
                                        <div className="col-span-1">
                                            <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">API Secret</label>
                                            <input className="w-full border p-2 rounded" placeholder="API Secret" value={newApi.apiSecret} onChange={e => setNewApi({ ...newApi, apiSecret: e.target.value })} />
                                        </div>
                                    </>
                                )}

                                <div className="col-span-1">
                                    <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Dashboard Rengi</label>
                                    <input
                                        type="color"
                                        className="w-full h-10 border p-1 rounded cursor-pointer"
                                        value={newApi.color || '#3b82f6'}
                                        onChange={e => setNewApi({ ...newApi, color: e.target.value })}
                                    />
                                </div>

                                {newApi.type === 'TRENDYOL' && (
                                    <div className="col-span-2">
                                        <label className="block text-xs font-bold text-gray-500 mb-2 uppercase">Senkronizasyon Ayarları</label>
                                        <div className="grid grid-cols-4 gap-4 bg-white p-3 border rounded">
                                            <label className="flex items-center gap-2 text-xs font-bold text-gray-700 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={newApi.enableStockSync !== false}
                                                    onChange={e => setNewApi({ ...newApi, enableStockSync: e.target.checked })}
                                                    className="w-4 h-4 text-blue-600 rounded"
                                                />
                                                Stok Gönder
                                            </label>
                                            <label className="flex items-center gap-2 text-xs font-bold text-gray-700 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={newApi.isOrderSyncEnabled !== false}
                                                    onChange={e => setNewApi({ ...newApi, isOrderSyncEnabled: e.target.checked })}
                                                    className="w-4 h-4 text-blue-600 rounded"
                                                />
                                                Sipariş Çek
                                            </label>
                                            <label className="flex items-center gap-2 text-xs font-bold text-gray-700 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={newApi.isQuestionSyncEnabled !== false}
                                                    onChange={e => setNewApi({ ...newApi, isQuestionSyncEnabled: e.target.checked })}
                                                    className="w-4 h-4 text-blue-600 rounded"
                                                />
                                                Soru Çekme
                                            </label>
                                            <label className="flex items-center gap-2 text-xs font-bold text-gray-700 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={newApi.isReturnSyncEnabled !== false}
                                                    onChange={e => setNewApi({ ...newApi, isReturnSyncEnabled: e.target.checked })}
                                                    className="w-4 h-4 text-blue-600 rounded"
                                                />
                                                İade Çekme
                                            </label>
                                        </div>
                                    </div>
                                )}

                                <div className="col-span-2 pt-2">
                                    <button
                                        onClick={handleAddApi}
                                        className={`w-full ${isEditingApi ? 'bg-orange-600 hover:bg-orange-700' : 'bg-blue-600 hover:bg-blue-700'} text-white py-3 rounded-lg font-bold flex items-center justify-center gap-2 shadow-lg transition-all`}
                                    >
                                        {isEditingApi ? <Save size={20} /> : <Plus size={20} />}
                                        {isEditingApi ? 'Mağazayı Güncelle' : 'Yeni Mağaza Ekle'}
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-2">
                            {db.apiConfigs.map(api => (
                                <div key={api.id} className="flex justify-between items-center p-4 border rounded bg-white">
                                    <div className="flex items-center gap-4">
                                        <div
                                            className="w-4 h-4 rounded-full shadow-sm"
                                            style={{ backgroundColor: api.color || '#3b82f6' }}
                                        />
                                        <div>
                                            <div className="font-bold flex items-center gap-2">
                                                {api.storeName}
                                                <span className={`text-[9px] px-2 py-0.5 rounded-full text-white font-black ${api.type === 'MANUAL' ? 'bg-purple-600' : 'bg-blue-600'}`}>
                                                    {api.type === 'MANUAL' ? 'PERAKENDE' : 'PAZARYERİ'}
                                                </span>
                                                {api.type === 'TRENDYOL' && (
                                                    <span className={`text-[9px] px-2 py-0.5 rounded-full text-white font-black ${api.mode === 'LIVE' ? 'bg-green-600' : 'bg-orange-500'}`}>
                                                        {api.mode === 'LIVE' ? 'CANLI' : 'TEST'}
                                                    </span>
                                                )}
                                                {api.type === 'TRENDYOL' && (
                                                    <div className="flex gap-1">
                                                        <span className={`text-[9px] px-2 py-0.5 rounded-full text-white font-black ${api.enableStockSync !== false ? 'bg-blue-500' : 'bg-gray-400'}`}>
                                                            {api.enableStockSync !== false ? 'STOK AKTİF' : 'STOK KAPALI'}
                                                        </span>
                                                        <span className={`text-[9px] px-2 py-0.5 rounded-full text-white font-black ${api.isOrderSyncEnabled !== false ? 'bg-teal-600' : 'bg-gray-400'}`}>
                                                            {api.isOrderSyncEnabled !== false ? 'SİPARİŞ AÇIK' : 'SİPARİŞ KAPALI'}
                                                        </span>
                                                        <span className={`text-[9px] px-2 py-0.5 rounded-full text-white font-black ${api.isQuestionSyncEnabled !== false ? 'bg-indigo-600' : 'bg-gray-400'}`}>
                                                            {api.isQuestionSyncEnabled !== false ? 'SORU AÇIK' : 'SORU KAPALI'}
                                                        </span>
                                                        <span className={`text-[9px] px-2 py-0.5 rounded-full text-white font-black ${api.isReturnSyncEnabled !== false ? 'bg-rose-600' : 'bg-gray-400'}`}>
                                                            {api.isReturnSyncEnabled !== false ? 'İADE AÇIK' : 'İADE KAPALI'}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="text-xs text-gray-500">
                                                {api.type === 'TRENDYOL' ? `API: ${api.apiKey?.substring(0, 8)}...` : 'Manuel Satış Mağazası'}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        <button onClick={() => handleEditApiClick(api)} className="text-blue-600 hover:bg-blue-50 p-2 rounded" title="Düzenle">
                                            <Edit size={16} />
                                        </button>
                                        <button onClick={() => handleDeleteApi(api.id)} className="text-red-600 hover:bg-red-50 p-2 rounded" title="Sil">
                                            <Trash size={16} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {activeTab === 'users' && (
                    <div>
                        <h3 className="text-xl font-bold mb-6">Kullanıcı Profilleri</h3>
                        <div className="grid grid-cols-5 gap-2 mb-6 bg-gray-50 p-4 rounded border relative">
                            {isEditingUser && (
                                <button
                                    onClick={resetUserForm}
                                    className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1 shadow hover:bg-red-600"
                                    title="İptal Et"
                                >
                                    <X size={14} />
                                </button>
                            )}
                            <input className="border p-2 rounded col-span-1" placeholder="Ad Soyad" value={userForm.name} onChange={e => setUserForm({ ...userForm, name: e.target.value })} />
                            <input className="border p-2 rounded col-span-1" placeholder="Kullanıcı Adı" value={userForm.username} onChange={e => setUserForm({ ...userForm, username: e.target.value })} />
                            <input className="border p-2 rounded col-span-1" placeholder="Şifre" value={userForm.password} onChange={e => setUserForm({ ...userForm, password: e.target.value })} />
                            <select className="border p-2 rounded col-span-1" value={userForm.role} onChange={e => setUserForm({ ...userForm, role: e.target.value as UserRole })}>
                                <option value={UserRole.USER}>Personel</option>
                                <option value={UserRole.ADMIN}>Yönetici</option>
                            </select>
                            <button
                                onClick={handleSaveUser}
                                className={`${isEditingUser ? 'bg-orange-600 hover:bg-orange-700' : 'bg-green-600 hover:bg-green-700'} text-white rounded col-span-1 flex justify-center items-center`}
                            >
                                {isEditingUser ? <Save size={16} className="mr-2" /> : <UserPlus size={16} className="mr-2" />}
                                {isEditingUser ? 'Güncelle' : 'Ekle'}
                            </button>
                        </div>

                        <table className="w-full text-left text-sm border-collapse border border-gray-200">
                            <thead className="bg-gray-100">
                                <tr>
                                    <th className="p-2 border">Ad</th>
                                    <th className="p-2 border">Kullanıcı Adı</th>
                                    <th className="p-2 border">Rol</th>
                                    <th className="p-2 border text-right">İşlem</th>
                                </tr>
                            </thead>
                            <tbody>
                                {db.users.map(u => (
                                    <tr key={u.id} className={`border-b ${isEditingUser && userForm.id === u.id ? 'bg-orange-50' : ''}`}>
                                        <td className="p-2 border">{u.name}</td>
                                        <td className="p-2 border">{u.username}</td>
                                        <td className="p-2 border">
                                            <span className={`px-2 py-0.5 rounded text-xs text-white ${u.role === UserRole.ADMIN ? 'bg-purple-600' : 'bg-gray-500'}`}>
                                                {u.role}
                                            </span>
                                        </td>
                                        <td className="p-2 border text-right">
                                            <button onClick={() => handleEditUserClick(u)} className="text-blue-600 hover:bg-blue-100 p-1 rounded mr-2" title="Düzenle">
                                                <Edit size={14} />
                                            </button>
                                            <button onClick={() => handleDeleteUser(u.id)} className="text-red-600 hover:bg-red-100 p-1 rounded" title="Sil">
                                                <Trash size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {activeTab === 'system' && (
                    <div className="space-y-8">
                        <div>
                            <h3 className="text-lg font-bold mb-4">Otomasyon Ayarları</h3>

                            <div className="flex flex-col gap-4">
                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Otomatik Sipariş Çekme</h4>
                                        <p className="text-xs text-gray-500">Belirtilen aralıklarla pazaryerlerinden yeni siparişleri kontrol eder.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, enableAutoOrderFetch: !prev.settings.enableAutoOrderFetch } }))}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.enableAutoOrderFetch ? 'bg-blue-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.enableAutoOrderFetch ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                {db.settings.enableAutoOrderFetch && (
                                    <div className="flex items-center gap-4 p-3 ml-4 border-l-2 border-gray-300">
                                        <label className="text-sm font-medium">Sipariş Çekme Aralığı (dk):</label>
                                        <input
                                            type="number"
                                            className="border p-1 rounded w-20 text-center"
                                            value={db.settings.autoFetchIntervalMinutes}
                                            min="1"
                                            onChange={(e) => updateDB(prev => ({ ...prev, settings: { ...prev.settings, autoFetchIntervalMinutes: Math.max(1, Number(e.target.value)) } }))}
                                        />
                                    </div>
                                )}

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Otomatik Stok Gönderimi</h4>
                                        <p className="text-xs text-gray-500">Ürün stoğu değiştiğinde veya sipariş geldiğinde pazaryerlerine anlık güncelleme gönderir.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, enableAutoStockSync: !prev.settings.enableAutoStockSync } }))}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.enableAutoStockSync ? 'bg-green-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.enableAutoStockSync ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                {db.settings.enableAutoStockSync && (
                                    <div className="flex items-center gap-4 p-3 ml-4 border-l-2 border-gray-300">
                                        <div className="flex-1 space-y-3">
                                            {/* Sub-toggle for Limits */}
                                            <div className="flex items-center justify-between">
                                                <label className="text-sm font-bold text-gray-700">Stok Miktar Sınırları (Min/Max)</label>
                                                <button
                                                    onClick={() => updateDB(prev => ({
                                                        ...prev,
                                                        settings: {
                                                            ...prev.settings,
                                                            stockSyncSettings: {
                                                                ...prev.settings.stockSyncSettings,
                                                                enabled: !prev.settings.stockSyncSettings?.enabled
                                                            }
                                                        }
                                                    }))}
                                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${db.settings.stockSyncSettings?.enabled ? 'bg-indigo-600' : 'bg-gray-300'}`}
                                                >
                                                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${db.settings.stockSyncSettings?.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                                                </button>
                                            </div>

                                            {db.settings.stockSyncSettings?.enabled && (
                                                <div className="space-y-3 pl-2 transition-all duration-300">
                                                    <div className="flex items-center gap-4">
                                                        <label className="text-sm font-medium w-32">Min. Stok Eşiği:</label>
                                                        <input
                                                            type="number"
                                                            className="border p-1 rounded w-20 text-center"
                                                            value={db.settings.stockSyncSettings?.minStockThreshold ?? 10}
                                                            min="0"
                                                            onChange={(e) => updateDB(prev => ({
                                                                ...prev,
                                                                settings: {
                                                                    ...prev.settings,
                                                                    stockSyncSettings: {
                                                                        ...prev.settings.stockSyncSettings,
                                                                        minStockThreshold: e.target.value === '' ? 0 : Math.max(0, Number(e.target.value))
                                                                    }
                                                                }
                                                            }))}
                                                        />
                                                    </div>
                                                    <div className="flex items-center gap-4">
                                                        <label className="text-sm font-medium w-32">Max. Gönderim:</label>
                                                        <input
                                                            type="number"
                                                            className="border p-1 rounded w-20 text-center"
                                                            value={db.settings.stockSyncSettings?.maxStockToSend ?? 10000}
                                                            min="0"
                                                            onChange={(e) => updateDB(prev => ({
                                                                ...prev,
                                                                settings: {
                                                                    ...prev.settings,
                                                                    stockSyncSettings: {
                                                                        ...prev.settings.stockSyncSettings,
                                                                        maxStockToSend: e.target.value === '' ? 0 : Math.max(0, Number(e.target.value))
                                                                    }
                                                                }
                                                            }))}
                                                        />
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Otomatik İşleme Al</h4>
                                        <p className="text-xs text-gray-500">Yeni siparişler geldiğinde otomatik olarak Trendyol'da işleme alınır.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, enableAutoProcessOrders: !prev.settings.enableAutoProcessOrders } }))}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.enableAutoProcessOrders ? 'bg-blue-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.enableAutoProcessOrders ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Oturum Zaman Aşımı</h4>
                                        <p className="text-xs text-gray-500">Belirtilen süre boyunca mouse hareketi olmazsa oturum kapanır ve şifre istenir.</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, enableSessionTimeout: !prev.settings.enableSessionTimeout } }))}
                                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.enableSessionTimeout ? 'bg-blue-600' : 'bg-gray-200'}`}
                                        >
                                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.enableSessionTimeout ? 'translate-x-6' : 'translate-x-1'}`} />
                                        </button>
                                        <input
                                            type="number"
                                            className="border p-1 rounded w-20 text-center"
                                            value={db.settings.sessionTimeoutMinutes}
                                            onChange={(e) => updateDB(prev => ({ ...prev, settings: { ...prev.settings, sessionTimeoutMinutes: Math.max(1, Number(e.target.value)) } }))}
                                            min="1"
                                            disabled={!db.settings.enableSessionTimeout}
                                        />
                                        <span className="text-sm text-gray-600">dakika</span>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Otomatik Soru Çekme</h4>
                                        <p className="text-xs text-gray-500">Pazar yerlerinden müşteri sorularını arka planda otomatik olarak günceller.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, enableAutoQuestionFetch: !prev.settings.enableAutoQuestionFetch } }))}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.enableAutoQuestionFetch ? 'bg-blue-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.enableAutoQuestionFetch ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                {db.settings.enableAutoQuestionFetch && (
                                    <div className="flex items-center justify-between border p-3 ml-4 border-l-2 border-gray-300 bg-gray-50/50">
                                        <div>
                                            <h4 className="font-bold text-sm">Soru Çekme Aralığı</h4>
                                            <p className="text-xs text-gray-500">Trendyol'dan müşteri sorularının kaç dakikada bir otomatik çekileceğini belirler.</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number"
                                                className="border p-1 rounded w-20 text-center"
                                                value={db.settings.questionFetchIntervalMinutes || 5}
                                                onChange={(e) => updateDB(prev => ({ ...prev, settings: { ...prev.settings, questionFetchIntervalMinutes: Math.max(1, Number(e.target.value)) } }))}
                                                min="1"
                                            />
                                            <span className="text-sm text-gray-600">dakika</span>
                                        </div>
                                    </div>
                                )}

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Otomatik İade Çekme</h4>
                                        <p className="text-xs text-gray-500">Pazar yerlerinden iade taleplerini arka planda otomatik olarak günceller.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, enableAutoReturnFetch: !prev.settings.enableAutoReturnFetch } }))}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.enableAutoReturnFetch ? 'bg-blue-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.enableAutoReturnFetch ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                {db.settings.enableAutoReturnFetch && (
                                    <div className="flex items-center justify-between border p-3 ml-4 border-l-2 border-gray-300 bg-gray-50/50">
                                        <div>
                                            <h4 className="font-bold text-sm">İade Çekme Aralığı</h4>
                                            <p className="text-xs text-gray-500">Trendyol'dan iade taleplerinin kaç dakikada bir otomatik çekileceğini belirler.</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number"
                                                className="border p-1 rounded w-20 text-center"
                                                value={db.settings.returnFetchIntervalMinutes || 5}
                                                onChange={(e) => updateDB(prev => ({ ...prev, settings: { ...prev.settings, returnFetchIntervalMinutes: Math.max(1, Number(e.target.value)) } }))}
                                                min="1"
                                            />
                                            <span className="text-sm text-gray-600">dakika</span>
                                        </div>
                                    </div>
                                )}

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Sipariş Çekme ve Görünürlük Sınırı</h4>
                                        <p className="text-xs text-gray-500">Pazaryerinden kaç gün öncesine kadar siparişlerin çekileceğini ve listede gösterileceğini belirler.</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, enableOrderVisibilityLimit: !prev.settings.enableOrderVisibilityLimit } }))}
                                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.enableOrderVisibilityLimit ? 'bg-blue-600' : 'bg-gray-200'}`}
                                        >
                                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.enableOrderVisibilityLimit ? 'translate-x-6' : 'translate-x-1'}`} />
                                        </button>
                                        <input
                                            type="number"
                                            className="border p-1 rounded w-20 text-center"
                                            value={db.settings.orderFetchDays || 2}
                                            onChange={(e) => updateDB(prev => ({ ...prev, settings: { ...prev.settings, orderFetchDays: Math.max(1, Number(e.target.value)) } }))}
                                            min="1"
                                            disabled={!db.settings.enableOrderVisibilityLimit}
                                        />
                                        <span className="text-sm text-gray-600">gün</span>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Kargodaki Siparişleri Çekme Geçmişi</h4>
                                        <p className="text-xs text-gray-500">Taşıma durumundaki (kargolanmış) siparişlerin kaç gün geriye dönük çekileceğini belirler.</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="number"
                                            className="border p-1 rounded w-20 text-center"
                                            value={db.settings.shippedOrderFetchDays ?? 14}
                                            onChange={(e) => updateDB(prev => ({ ...prev, settings: { ...prev.settings, shippedOrderFetchDays: Math.max(1, Number(e.target.value)) } }))}
                                            min="1"
                                        />
                                        <span className="text-sm text-gray-600">gün</span>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Alt Limit Detaylarını Göster</h4>
                                        <p className="text-xs text-gray-500">Ana sayfadaki stok uyarısında Renk/Beden detaylarını gösterir.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, showLowStockDetails: !prev.settings.showLowStockDetails } }))}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.showLowStockDetails ? 'bg-indigo-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.showLowStockDetails ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Stok Sıfırın Altına Düşebilsin</h4>
                                        <p className="text-xs text-gray-500">Manuel siparişlerde stok miktarının negatif (-1, -2 vb.) olmasına izin verir.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, allowNegativeStock: !prev.settings.allowNegativeStock } }))}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.allowNegativeStock ? 'bg-red-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.allowNegativeStock ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Ürün Listesinde Görselleri Göster</h4>
                                        <p className="text-xs text-gray-500">Ürün yönetimi tablosunda renk bazlı ürün görsellerini sütun olarak listeler.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, showProductImages: !prev.settings.showProductImages } }))}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.showProductImages !== false ? 'bg-blue-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.showProductImages !== false ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">İade İstisna Raporunu İndir</h4>
                                        <p className="text-xs text-gray-500">İade onayında sistemde bulunamayan siparişler için otomatik .txt raporu indirir.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB(prev => ({ ...prev, settings: { ...prev.settings, enableReturnExceptionReport: !prev.settings.enableReturnExceptionReport } }))}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.enableReturnExceptionReport ? 'bg-orange-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.enableReturnExceptionReport ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div>
                            <h3 className="text-lg font-bold mb-4">Bildirim Ayarları</h3>

                            <div className="flex flex-col gap-4">
                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Windows Bildirimleri</h4>
                                        <p className="text-xs text-gray-500">Windows sistem bildirimlerini aç/kapat.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB({ ...db, settings: { ...db.settings, notifications: { ...db.settings.notifications, windowsEnabled: !db.settings.notifications?.windowsEnabled } } })}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.notifications?.windowsEnabled ? 'bg-blue-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.notifications?.windowsEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Sesli Bildirim</h4>
                                        <p className="text-xs text-gray-500">Yeni sipariş geldiğinde bildirim sesi çalar.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB({ ...db, settings: { ...db.settings, notifications: { ...db.settings.notifications, soundEnabled: !db.settings.notifications?.soundEnabled } } })}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.notifications?.soundEnabled ? 'bg-indigo-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.notifications?.soundEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                {db.settings.notifications?.soundEnabled && (
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 ml-4 border-l-2 border-gray-300 p-3">
                                        {[
                                            { key: 'order', label: 'Yeni Sipariş Sesi', icon: <ShoppingCart size={16} /> },
                                            { key: 'return', label: 'Yeni İade Sesi', icon: <Package size={16} /> },
                                            { key: 'question', label: 'Yeni Soru Sesi', icon: <MessageSquare size={16} /> },
                                            { key: 'system', label: 'Sistem Sesi', icon: <Clock size={16} /> },
                                            { key: 'update', label: 'Güncelleme Sesi', icon: <RefreshCw size={16} /> }
                                        ].map(item => (
                                            <div key={item.key} className="bg-white p-3 border rounded shadow-sm flex flex-col gap-2">
                                                <div className="flex items-center gap-2 font-bold text-xs text-gray-700">
                                                    {item.icon}
                                                    {item.label}
                                                </div>
                                                <div className="relative">
                                                    <select
                                                        className="w-full border p-1 rounded text-[10px] bg-gray-50 focus:bg-white outline-none"
                                                        value={db.settings.notifications?.[`${item.key}SoundPath`] || ''}
                                                        onChange={(e) => handleUpdateSound(item.key, e.target.value)}
                                                    >
                                                        <option value="">Varsayılan Ses</option>
                                                        <option value="none">Sessiz (Ses Çalma)</option>
                                                        {AVAILABLE_SOUNDS.filter(s => s.file !== 'none').map(sound => (
                                                            <option key={sound.file} value={sound.file}>
                                                                {sound.name}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div className="flex gap-1">
                                                    <button
                                                        onClick={() => handleResetSound(item.key)}
                                                        className="flex-1 flex items-center justify-center gap-1 bg-gray-50 text-gray-600 border border-gray-200 py-1 rounded text-[10px] hover:bg-gray-100"
                                                        title="Sıfırla"
                                                    >
                                                        <RotateCcw size={10} /> Sıfırla
                                                    </button>
                                                    <button
                                                        onClick={() => handleTestNotification(db.settings.notifications?.[`${item.key}SoundPath`], item.key)}
                                                        className="flex items-center justify-center bg-green-50 text-green-600 border border-green-200 p-1 rounded hover:bg-green-100 w-10"
                                                        title="Test Et"
                                                    >
                                                        <Volume2 size={12} />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Yeni Sipariş Bildirimi</h4>
                                        <p className="text-xs text-gray-500">Sadece yeni sipariş geldiğinde bildirim göster.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB({ ...db, settings: { ...db.settings, notifications: { ...db.settings.notifications, newOrderNotification: !db.settings.notifications?.newOrderNotification } } })}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.notifications?.newOrderNotification ? 'bg-green-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.notifications?.newOrderNotification ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Sipariş Güncelleme Bildirimi</h4>
                                        <p className="text-xs text-gray-500">Sipariş durumu değiştiğinde bildirim göster.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB({ ...db, settings: { ...db.settings, notifications: { ...db.settings.notifications, orderUpdateNotification: !db.settings.notifications?.orderUpdateNotification } } })}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.notifications?.orderUpdateNotification ? 'bg-blue-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.notifications?.orderUpdateNotification ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">İade Bildirimi</h4>
                                        <p className="text-xs text-gray-500">Yeni iade talebi geldiğinde bildirim göster.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB({ ...db, settings: { ...db.settings, notifications: { ...db.settings.notifications, returnNotification: !db.settings.notifications?.returnNotification } } })}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.notifications?.returnNotification ? 'bg-orange-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.notifications?.returnNotification ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Soru Bildirimi</h4>
                                        <p className="text-xs text-gray-500">Müşteriden yeni soru geldiğinde bildirim göster.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB({ ...db, settings: { ...db.settings, notifications: { ...db.settings.notifications, questionNotification: !db.settings.notifications?.questionNotification } } })}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.notifications?.questionNotification ? 'bg-yellow-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.notifications?.questionNotification ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between border p-3 rounded bg-gray-50">
                                    <div>
                                        <h4 className="font-bold text-sm">Sistem Bildirimleri</h4>
                                        <p className="text-xs text-gray-500">Oturum zaman aşımı, hata gibi sistem olaylarında bildirim göster.</p>
                                    </div>
                                    <button
                                        onClick={() => updateDB({ ...db, settings: { ...db.settings, notifications: { ...db.settings.notifications, systemNotification: !db.settings.notifications?.systemNotification } } })}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${db.settings.notifications?.systemNotification ? 'bg-purple-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${db.settings.notifications?.systemNotification ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {isLicenseValid && (
                            <div>
                                <h3 className="text-lg font-bold mb-4 mt-8">Veritabanı Yedekleme ve Kurtarma</h3>
                                <div className="flex flex-col gap-4 border p-4 rounded bg-gray-50">
                                    <p className="text-sm text-gray-600 mb-2">
                                        Tüm ürün, sipariş ve ayar verilerinizi güvenli bir şekilde bilgisayarınıza yedekleyebilir veya daha önce aldığınız bir yedeği geri yükleyebilirsiniz.
                                    </p>
                                    <div className="flex gap-4">
                                        <button
                                            onClick={() => exportBackup(
                                                (msg) => setNotification({ type: 'success', message: msg }),
                                                (msg) => setNotification({ type: 'error', message: msg })
                                            )}
                                            className="bg-blue-600 text-white px-6 py-2 rounded flex items-center hover:bg-blue-700 font-bold"
                                        >
                                            <UploadCloud size={18} className="mr-2" />
                                            Yedek Al
                                        </button>
                                        <input
                                            type="file"
                                            accept=".json"
                                            className="hidden"
                                            id="backup-upload"
                                            onChange={(e) => {
                                                const file = e.target.files?.[0];
                                                if (file) {
                                                    importBackup(file, {
                                                        onConfirm: (msg, onProceed) => requestConfirm(msg, onProceed),
                                                        onSuccess: (msg) => setNotification({ type: 'success', message: msg }),
                                                        onError: (msg) => setNotification({ type: 'error', message: msg }),
                                                        onDone: () => window.location.reload()
                                                    });
                                                }
                                                e.target.value = '';
                                            }}
                                        />
                                        <button
                                            onClick={() => document.getElementById('backup-upload')?.click()}
                                            className="bg-green-600 text-white px-6 py-2 rounded flex items-center hover:bg-green-700 font-bold"
                                        >
                                            <RotateCcw size={18} className="mr-2" />
                                            Yedekten Dön
                                        </button>
                                        <button
                                            onClick={() => requestConfirm(
                                                "DİKKAT: Tüm veriler (ürünler, siparişler, ayarlar) silinecek ve program fabrika ayarlarına dönecektir. Bu işlem geri alınamaz. Onaylıyor musunuz?",
                                                async () => {
                                                    const success = await resetToFactoryDefaults();
                                                    if (success) {
                                                        setNotification({ type: 'success', message: 'Sistem başarıyla sıfırlandı. Uygulama yeniden başlatılıyor...' });
                                                        setTimeout(() => window.location.reload(), 2000);
                                                    } else {
                                                        setNotification({ type: 'error', message: 'Sıfırlama sırasında bir hata oluştu.' });
                                                    }
                                                }
                                            )}
                                            className="bg-red-50 text-red-600 border border-red-200 px-6 py-2 rounded flex items-center hover:bg-red-100 font-bold ml-auto"
                                        >
                                            <Trash size={18} className="mr-2" />
                                            Fabrika Ayarlarına Dön
                                        </button>
                                    </div>
                                </div>

                                <h3 className="text-lg font-bold mb-4 mt-8">Sistem Güncelleme</h3>
                                <div className="flex flex-col gap-4 border p-4 rounded bg-gray-50">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <h4 className="font-bold text-sm">Güncellemeleri Denetle</h4>
                                            <p className="text-xs text-gray-500">Uygulamanın en yeni sürümünü GitHub üzerinden kontrol eder.</p>
                                        </div>
                                        <button
                                            onClick={async () => {
                                                if (window.require) {
                                                    const { ipcRenderer } = window.require('electron');
                                                    setNotification({ type: 'success', message: 'Güncelleme kontrolü başlatıldı...' });
                                                    await ipcRenderer.invoke('check-for-updates');
                                                } else {
                                                    setNotification({ type: 'error', message: 'Bu özellik sadece masaüstü uygulamasında çalışır.' });
                                                }
                                            }}
                                            className="bg-indigo-600 text-white px-6 py-2 rounded flex items-center hover:bg-indigo-700 font-bold shadow-sm"
                                        >
                                            <RefreshCw size={18} className="mr-2" />
                                            Şimdi Denetle
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                    </div>
                )
                }

                {
                    activeTab === 'license' && (
                        <div className="space-y-6">
                            <h3 className="text-xl font-bold mb-4">Lisans Yönetimi</h3>

                            <div className="bg-blue-50 border border-blue-200 rounded p-6">
                                <div className="flex items-center gap-4 mb-4">
                                    <div className="bg-blue-600 p-3 rounded-full text-white">
                                        <Key size={24} />
                                    </div>
                                    <div>
                                        <h4 className="text-lg font-bold text-blue-900">Program Lisans Durumu</h4>
                                        <p className="text-sm text-blue-700">
                                            {db.settings.licenseKey ? (
                                                <span className="flex items-center gap-1 text-green-700 font-bold">
                                                    <Check size={16} /> Lisanslı Sürüm (Sınırsız)
                                                </span>
                                            ) : db.trialStartDate ? (
                                                (() => {
                                                    const startDate = new Date(db.trialStartDate);
                                                    const now = new Date();
                                                    const diffTime = Math.abs(now.getTime() - startDate.getTime());
                                                    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                                                    const remaining = 7 - diffDays;
                                                    return remaining >= 0
                                                        ? `Deneme Sürümü (${remaining} gün kaldı)`
                                                        : 'Deneme Süresi Doldu';
                                                })()
                                            ) : 'Lisanssız / Deneme Başlatılmadı'}
                                        </p>
                                    </div>
                                </div>

                                {!db.settings.licenseKey && (
                                    <div className="mt-4 space-y-4">
                                        <p className="text-sm text-gray-600">
                                            Programı sınırsız kullanmak ve birden fazla mağaza (API) eklemek için lisans anahtarınızı giriniz.
                                        </p>
                                        <div className="flex gap-2">
                                            <input
                                                type="password"
                                                className="flex-1 border p-2 rounded font-mono uppercase text-gray-800"
                                                placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                                                value={tempKey}
                                                onChange={e => setTempKey(e.target.value)}
                                            />
                                            <button
                                                onClick={async () => {
                                                    if (!tempKey) return;
                                                    const isVal = async (k: string) => {
                                                        if (window.require) {
                                                            const { ipcRenderer } = window.require('electron');
                                                            return await ipcRenderer.invoke('validate-license', k);
                                                        }
                                                        const normalize = (val: string) => (val || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                                                        return normalize(k) === normalize("8F3KQ-9A7M2-LP5XW-4Z8N6-YT2RD");
                                                    };

                                                    const result = await isVal(tempKey);
                                                    if (result) {
                                                        updateDB({ ...db, settings: { ...db.settings, licenseKey: tempKey.trim() } });
                                                        setNotification({ type: 'success', message: "Tebrikler! Programınız başarıyla lisanslandı." });
                                                        setTempKey('');
                                                    } else {
                                                        setNotification({ type: 'error', message: "Geçersiz lisans anahtarı." });
                                                    }
                                                }}
                                                className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 font-bold"
                                            >
                                                Etkinleştir
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {db.settings.licenseKey && (
                                    <div className="mt-4 p-3 bg-white/50 rounded border border-blue-200">
                                        <p className="text-sm font-mono text-blue-800">
                                            Kayıtlı Anahtar: *****-*****-*****-*****-*****
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* Unified System Features Panel */}
                            <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6 shadow-sm">
                                <h5 className="text-gray-800 font-bold mb-4 flex items-center gap-2">
                                    <LayoutDashboard size={18} className="text-blue-600" />
                                    Sistem Yetenekleri
                                </h5>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-y-3 gap-x-6">
                                    <div className="flex items-center gap-3 text-gray-600">
                                        <div className="bg-blue-50 p-2 rounded-full"><Plus size={14} className="text-blue-600" /></div>
                                        <span className="text-xs font-medium">Trendyol ve Manuel Mağaza Entegrasyonu</span>
                                    </div>
                                    <div className="flex items-center gap-3 text-gray-600">
                                        <div className="bg-green-50 p-2 rounded-full"><Package size={14} className="text-green-600" /></div>
                                        <span className="text-xs font-medium">Canlı Stok ve Sipariş Takibi</span>
                                    </div>
                                    <div className="flex items-center gap-3 text-gray-600">
                                        <div className="bg-purple-50 p-2 rounded-full"><RotateCcw size={14} className="text-purple-600" /></div>
                                        <span className="text-xs font-medium">Müşteri Soruları ve İade Süreçleri</span>
                                    </div>
                                    <div className="flex items-center gap-3 text-gray-600">
                                        <div className="bg-orange-50 p-2 rounded-full"><ShoppingCart size={14} className="text-orange-600" /></div>
                                        <span className="text-xs font-medium">Barkod Destekli Hızlı İşlem Paketi</span>
                                    </div>
                                    <div className="flex items-center gap-3 text-gray-600">
                                        <div className="bg-indigo-50 p-2 rounded-full"><BarChart3 size={14} className="text-indigo-600" /></div>
                                        <span className="text-xs font-medium">Kapsamlı Veri Analizi ve Raporlama</span>
                                    </div>
                                </div>
                            </div>

                            {/* License Status Comparison */}
                            <div className="grid grid-cols-2 gap-6">
                                {/* Trial Card */}
                                <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 relative overflow-hidden group">
                                    <div className="flex items-center justify-between mb-3">
                                        <h5 className="font-bold text-gray-700">Deneme Sürümü</h5>
                                        <Clock className="text-gray-400" size={20} />
                                    </div>
                                    <div className="space-y-2">
                                        <div className="flex items-start gap-2">
                                            <Check size={14} className="text-green-600 mt-0.5" />
                                            <p className="text-[11px] text-gray-600 font-bold">7 Günlük Kullanım Süresi</p>
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <Check size={14} className="text-green-600 mt-0.5" />
                                            <p className="text-[11px] text-gray-600">Tüm modüller bu süre boyunda eksiksiz çalışır.</p>
                                        </div>
                                    </div>
                                    <div className="absolute top-0 right-0 w-16 h-16 bg-gray-100 rotate-45 translate-x-10 -translate-y-10 group-hover:bg-gray-200 transition-colors" />
                                </div>

                                {/* Full License Card */}
                                <div className="bg-gradient-to-br from-amber-50 to-white border border-amber-200 rounded-lg p-5 shadow-sm relative overflow-hidden group">
                                    <div className="flex items-center justify-between mb-3">
                                        <h5 className="font-bold text-amber-800">Tam Sürüm (Premium)</h5>
                                        <Key className="text-amber-500 animate-pulse" size={20} />
                                    </div>
                                    <div className="space-y-2">
                                        <div className="flex items-start gap-2">
                                            <Infinity size={14} className="text-amber-600 mt-0.5" />
                                            <p className="text-[11px] text-amber-900 font-bold uppercase tracking-wider">Süresiz Kullanım Hakkı</p>
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <Check size={14} className="text-amber-600 mt-0.5" />
                                            <p className="text-[11px] text-amber-800">Ömür boyu geçerli tek lisans anahtarı.</p>
                                        </div>
                                    </div>
                                    <div className="absolute top-0 right-0 w-24 h-4 bg-amber-500 rotate-45 translate-x-8 translate-y-2 text-[8px] text-white font-bold flex items-center justify-center uppercase">Önerilen</div>
                                </div>
                            </div>
                        </div>
                    )
                }



            </div >
        </div >
    );
};
