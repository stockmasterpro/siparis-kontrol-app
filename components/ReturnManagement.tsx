import React, { useState, useMemo, useEffect } from 'react';
import { Database, ReturnClaim, OrderStatus, ReturnRecord, UserRole } from '../types';
import { Search, RotateCw, CheckCircle, AlertTriangle, ChevronLeft, ChevronRight, Image as ImageIcon, ArrowUpDown, Copy, X, FileSpreadsheet } from 'lucide-react';
import { format } from 'date-fns';
import { tr } from 'date-fns/locale';
import * as XLSX from 'xlsx';
import { syncMarketplaceClaims, approveMarketplaceClaim, updateLocalStockWithConsistency, syncBarcodeStockBatchMultiple } from '../services/integration';
import { v4 as uuidv4 } from 'uuid';

interface Props {
    db: Database;
    updateDB: (newDB: Database | ((prev: Database) => Database)) => void;
    userRole: UserRole;
    setNotification: (notif: { type: 'success' | 'error', message: string } | null) => void;
    requestConfirm: (message: string, onConfirm: () => void) => void;
}

export const ReturnManagement: React.FC<Props> = ({ db, updateDB, userRole, setNotification, requestConfirm }) => {
    const claims = db.returnClaims || [];
    const [searchTerm, setSearchTerm] = useState('');
    const [storeFilter, setStoreFilter] = useState<string>('all');
    const [selectedClaimIds, setSelectedClaimIds] = useState<Set<string>>(new Set());
    const [isSyncing, setIsSyncing] = useState(false);
    const [isApproving, setIsApproving] = useState<string | null>(null); // claimId if individual, 'bulk' if bulk
    const [currentPage, setCurrentPage] = useState(1);
    const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'claimDate', direction: 'desc' });
    const [zoomedImage, setZoomedImage] = useState<string | null>(null);

    const itemsPerPage = 25;
    const criticalReasonTokens = ['eksik ürün', 'kusurlu ürün', 'yanlış ürün'];

    const isCriticalReason = (reason: string) => {
        const normalized = (reason || '').toLocaleLowerCase('tr-TR');
        return criticalReasonTokens.some(token => normalized.includes(token));
    };

    const getClaimProductImage = (claim: ReturnClaim) => {
        if (claim.productImageUrl) return claim.productImageUrl;
        const matchedProduct = db.products.find(p => p.variants.some(v => v.barcode === claim.barcode));
        if (!matchedProduct) return '';

        const matchedVariant = matchedProduct.variants.find(v => v.barcode === claim.barcode);
        if (!matchedVariant) return '';

        // 1) Barkod varyantının ana görseli
        if (matchedVariant.mainImage) return matchedVariant.mainImage;
        // 2) Barkod varyantının ilk görseli
        if (matchedVariant.images && matchedVariant.images.length > 0) return matchedVariant.images[0];

        // 3) Link bilgisi olmasa bile barkodun bağlı olduğu renk grubunun ana/ilk görselini kullan
        const sameColorVariants = matchedProduct.variants.filter(v => v.color === matchedVariant.color);
        const sameColorMain = sameColorVariants.find(v => v.mainImage)?.mainImage;
        if (sameColorMain) return sameColorMain;
        const sameColorFirst = sameColorVariants.find(v => v.images && v.images.length > 0)?.images?.[0];
        return sameColorFirst || '';
    };

    const safeFormatDate = (dateStr: string | number | undefined, formatStr: string = 'd MMMM yyyy HH:mm') => {
        if (!dateStr) return 'Tarih Belirtilmemiş';
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return 'Geçersiz Tarih';
            return format(date, formatStr, { locale: tr });
        } catch (e) {
            return 'Hatalı Tarih';
        }
    };

    const handleSync = async () => {
        setIsSyncing(true);
        try {
            let allClaims: ReturnClaim[] = [];
            for (const config of db.apiConfigs) {
                const storeClaims = await syncMarketplaceClaims(config);
                allClaims = [...allClaims, ...storeClaims];
            }
            
            const existingClaimKeys = new Set(claims.map(c => `${c.storeName}|${c.claimId}|${c.claimLineItemId}`));
            const actualNewClaims = allClaims.filter(c => !existingClaimKeys.has(`${c.storeName}|${c.claimId}|${c.claimLineItemId}`));
            const newClaimsInWaitingState = actualNewClaims.filter(c => {
                const s = String(c.status).toUpperCase();
                return s === 'WAITING_FOR_APPROVE' ||
                    s === 'WAITINGFORAPPROVE' ||
                    s === 'WAITING_FOR_RETURN_PACKAGE' ||
                    s === 'WAITINGFORRETURNPACKAGE' ||
                    s === 'CREATED';
            });

            updateDB(prev => ({
                ...prev,
                returnClaims: allClaims
            }));
            
            if (newClaimsInWaitingState.length > 0) {
                const notifSettings = db.settings.notifications;
                if (notifSettings?.returnNotification) {
                    const shouldToast = notifSettings.windowsEnabled !== false;
                    const shouldSound = notifSettings.soundEnabled !== false;

                    const options = {
                        title: 'Yeni İade Talebi',
                        body: `${newClaimsInWaitingState.length} adet YENİ iade talebi var.`,
                        playSound: shouldSound,
                        customSoundPath: notifSettings.returnSoundPath,
                        type: 'return'
                    };

                    try {
                        if (window.require) {
                            const { ipcRenderer } = window.require('electron');
                            ipcRenderer.invoke('show-notification', options);
                        } else {
                            const electron = (window as any).electron;
                            if (electron?.showNotification) {
                                electron.showNotification(options);
                            }
                        }
                    } catch (e) {
                        console.error('Notification invoke failed:', e);
                    }
                }
            }
            
            setNotification({ type: 'success', message: `${allClaims.length} iade talebi güncellendi.` });
        } catch (error: any) {
            setNotification({ type: 'error', message: 'İadeler çekilirken hata oluştu.' });
        } finally {
            setIsSyncing(false);
        }
    };

    // NOTE: Auto-fetch is controlled centrally in App.tsx settings timers.
    // This screen should not fetch automatically when opened.

    // Notification clear effect


    // Auto-sync on mount disabled in v1.2.8 for better UX
    useEffect(() => {
        // handleSync();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const filteredClaims = useMemo(() => {
        return claims
            .filter(c =>
                storeFilter === 'all' || c.storeName === storeFilter
            )
            .filter(c =>
                c.customerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                c.orderNumber.includes(searchTerm) ||
                c.claimId.includes(searchTerm) ||
                (c.cargoTrackingNumber || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                c.barcode.includes(searchTerm) ||
                c.productName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                c.reason.toLowerCase().includes(searchTerm.toLowerCase())
            )
            .sort((a, b) => {
                const aVal = (a as any)[sortConfig.key] || '';
                const bVal = (b as any)[sortConfig.key] || '';

                if (sortConfig.key === 'claimDate') {
                    return sortConfig.direction === 'asc'
                        ? new Date(aVal).getTime() - new Date(bVal).getTime()
                        : new Date(bVal).getTime() - new Date(aVal).getTime();
                }

                const comparison = String(aVal).localeCompare(String(bVal), 'tr');
                return sortConfig.direction === 'asc' ? comparison : -comparison;
            });
    }, [claims, searchTerm, storeFilter, sortConfig]);

    const paginatedClaims = filteredClaims.slice(
        (currentPage - 1) * itemsPerPage,
        currentPage * itemsPerPage
    );

    const totalPages = Math.ceil(filteredClaims.length / itemsPerPage);

    const downloadMissingReport = (claim: ReturnClaim, reason: string) => {
        const content = `İADE İSTİSNA RAPORU (KAYIT BULUNAMADI)
------------------------------------------
Tarih: ${new Date().toLocaleString('tr-TR')}
Sipariş No: ${claim.orderNumber || 'Bilinmiyor'}
Pazaryeri Claim ID: ${claim.claimId}
------------------------------------------
Durum/Sebep: ${reason}

Müşteri: ${claim.customerName}
Barkod: ${claim.barcode}
Ürün: ${claim.productName}
İade Nedeni: ${claim.reason}
Mağaza: ${claim.storeName}
------------------------------------------
        `;

        const element = document.createElement("a");
        const file = new Blob([content], { type: 'text/plain;charset=utf-8' });
        element.href = URL.createObjectURL(file);
        element.download = `iade_raporu_${claim.orderNumber}.txt`;
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
    };

    const processLocalReturn = async (claim: ReturnClaim): Promise<{ success: boolean, stockUpdated: boolean, reason?: string }> => {
        const order = db.orders.find(o => o.marketplaceOrderId === claim.orderNumber && o.storeName === claim.storeName);
        if (!order) {
            if (db.settings.enableReturnExceptionReport) {
                downloadMissingReport(claim, "Sipariş sistemde (yerel veritabanında) bulunamadı.");
            }
            updateDB(prev => ({
                ...prev,
                returnClaims: prev.returnClaims.filter(rc => rc.claimId !== claim.claimId || rc.claimLineItemId !== claim.claimLineItemId)
            }));
            return { success: true, stockUpdated: false, reason: 'Sipariş yerelde bulunamadı' };
        }

        const item = order.items.find(i =>
            (claim.orderLineItemId && i.orderItemId && String(i.orderItemId) === String(claim.orderLineItemId)) ||
            i.barcode === claim.barcode
        );
        if (!item) {
            if (db.settings.enableReturnExceptionReport) {
                downloadMissingReport(claim, "Barkod bu siparişin kalemleri arasında bulunamadı.");
            }
            updateDB(prev => ({
                ...prev,
                returnClaims: prev.returnClaims.filter(rc => rc.claimId !== claim.claimId || rc.claimLineItemId !== claim.claimLineItemId)
            }));
            return { success: true, stockUpdated: false, reason: 'Barkod sipariş kalemlerinde bulunamadı' };
        }

        let currentProducts = [...db.products];
        const barcodesToSync: { [key: string]: number } = {};

        const returnQty = Math.max(1, Number(claim.returnQuantity || 1));
        const newReturnRecord: ReturnRecord = {
            id: uuidv4(),
            orderId: order.id,
            marketplaceOrderId: order.marketplaceOrderId,
            customerName: order.customerName,
            item: item,
            returnQuantity: returnQty,
            returnDate: new Date().toISOString()
        };

        const product = currentProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
        const variant = product?.variants.find(v => v.barcode === item.barcode);
        if (!product || !variant) {
            if (db.settings.enableReturnExceptionReport) {
                downloadMissingReport(claim, "Barkod ürün kartında kayıtlı değil. Stok iadesi yapılamadı.");
            }
            updateDB(prev => ({
                ...prev,
                returnClaims: prev.returnClaims.filter(rc => rc.claimId !== claim.claimId || rc.claimLineItemId !== claim.claimLineItemId)
            }));
            return { success: true, stockUpdated: false, reason: 'Barkod ürün kartında bulunamadı' };
        }

        const whId = 'wh1';
        const currentStock = variant.stocks[whId] || 0;
        const newStock = currentStock + returnQty;

        const result = updateLocalStockWithConsistency(
            currentProducts,
            product.id,
            variant.color,
            variant.size,
            whId,
            newStock
        );
        currentProducts = result.updatedProducts;

        const up = currentProducts.find(p => p.id === product.id);
        if (up) {
            up.variants.forEach(pv => {
                if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                    const total = Object.values(pv.stocks).reduce<number>((a, b) => a + (Number(b) || 0), 0);
                    barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : Number(total);
                }
            });
        }

        const allReturns = [...db.returns, newReturnRecord];

        updateDB(prev => ({
            ...prev,
            products: currentProducts,
            returns: allReturns,
            orders: prev.orders,
            returnClaims: prev.returnClaims.filter(rc => rc.claimId !== claim.claimId || rc.claimLineItemId !== claim.claimLineItemId)
        }));

        if (db.settings.enableAutoStockSync && Object.keys(barcodesToSync).length > 0) {
            const itemsToSync = Object.entries(barcodesToSync).map(([barcode, qty]) => ({ barcode, quantity: qty }));
            await syncBarcodeStockBatchMultiple(db.apiConfigs, itemsToSync, db.settings);
        }

        return { success: true, stockUpdated: true };
    };

    const handleCopy = (text: string, label: string) => {
        if (!text) return;
        navigator.clipboard.writeText(text);
        setNotification({ type: 'success', message: `${label} kopyalandı.` });
    };

    const CopyableText: React.FC<{ text: string, label: string, className?: string }> = ({ text, label, className }) => (
        <div
            className={`flex items-center gap-1 group/copy cursor-pointer hover:text-orange-600 transition-colors ${className}`}
            onClick={() => handleCopy(text, label)}
            title={`Kopyalamak için tıkla: ${label}`}
        >
            <span className="truncate">{text}</span>
            <Copy size={10} className="opacity-0 group-hover/copy:opacity-100 transition-opacity flex-shrink-0" />
        </div>
    );

    const handleApprove = async (claim: ReturnClaim) => {
        setIsApproving(claim.claimId);
        try {
            const config = db.apiConfigs.find(c => c.storeName === claim.storeName);
            if (!config) throw new Error('Mağaza yapılandırması bulunamadı.');

            if (!claim.claimLineItemId) throw new Error('Claim line item id bulunamadı.');
            const success = await approveMarketplaceClaim(config, claim.claimId, [claim.claimLineItemId]);
            if (success) {
                // Automated Local Sync (includes removing from returnClaims)
                const result = await processLocalReturn(claim);

                if (result.stockUpdated) {
                    setNotification({ type: 'success', message: 'İade başarıyla onaylandı ve stoklar güncellendi.' });
                } else {
                    setNotification({ type: 'success', message: `İade pazaryerinde onaylandı. (${result.reason || 'Yerel kayıt bulunamadı, stok güncellenmedi'})` });
                }
            }
        } catch (error: any) {
            console.error(error);
            setNotification({ type: 'error', message: error.message || 'Onaylanırken hata oluştu.' });
        } finally {
            setIsApproving(null);
        }
    };

    const handleBulkApprove = async () => {
        if (selectedClaimIds.size === 0) return;

        requestConfirm(`${selectedClaimIds.size} adet iade talebini onaylamak istediğinize emin misiniz?`, async () => {
            setIsApproving('bulk');
            let successCount = 0;
            let stockUpdatedCount = 0;
            let failCount = 0;

            const idsArray = Array.from(selectedClaimIds);
            const claimsToApprove = claims.filter(c => idsArray.includes(c.id));

            let currentProducts = [...db.products];
            let currentOrders = [...db.orders];
            let currentReturns = [...db.returns];
            let currentReturnClaims = [...db.returnClaims];
            const barcodesToSync: { [key: string]: number } = {};

            for (const claim of claimsToApprove) {
                const config = db.apiConfigs.find(c => c.storeName === claim.storeName);
                if (!config) {
                    failCount++;
                    continue;
                }

                try {
                    if (!claim.claimLineItemId) {
                        failCount++;
                        continue;
                    }
                    const success = await approveMarketplaceClaim(config, claim.claimId, [claim.claimLineItemId]);
                    if (success) {
                        // Process the return details atomically
                        const order = currentOrders.find(o => o.marketplaceOrderId === claim.orderNumber && o.storeName === claim.storeName);
                        if (!order) {
                            if (db.settings.enableReturnExceptionReport) {
                                downloadMissingReport(claim, "Sipariş sistemde (yerel veritabanında) bulunamadı.");
                            }
                            currentReturnClaims = currentReturnClaims.filter(rc => rc.claimId !== claim.claimId || rc.claimLineItemId !== claim.claimLineItemId);
                            successCount++;
                            continue;
                        }

                        const item = order.items.find(i =>
                            (claim.orderLineItemId && i.orderItemId && String(i.orderItemId) === String(claim.orderLineItemId)) ||
                            i.barcode === claim.barcode
                        );
                        if (!item) {
                            if (db.settings.enableReturnExceptionReport) {
                                downloadMissingReport(claim, "Barkod bu siparişin kalemleri arasında bulunamadı.");
                            }
                            currentReturnClaims = currentReturnClaims.filter(rc => rc.claimId !== claim.claimId || rc.claimLineItemId !== claim.claimLineItemId);
                            successCount++;
                            continue;
                        }

                        const product = currentProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
                        const variant = product?.variants.find(v => v.barcode === item.barcode);
                        if (!product || !variant) {
                            if (db.settings.enableReturnExceptionReport) {
                                downloadMissingReport(claim, "Barkod ürün kartında kayıtlı değil. Stok iadesi yapılamadı.");
                            }
                            currentReturnClaims = currentReturnClaims.filter(rc => rc.claimId !== claim.claimId || rc.claimLineItemId !== claim.claimLineItemId);
                            successCount++;
                            continue;
                        }

                        // Update stocks
                        const whId = 'wh1';
                        const returnQty = Math.max(1, Number(claim.returnQuantity || 1));
                        const currentStock = variant.stocks[whId] || 0;
                        const newStock = currentStock + returnQty;

                        const result = updateLocalStockWithConsistency(
                            currentProducts,
                            product.id,
                            variant.color,
                            variant.size,
                            whId,
                            newStock
                        );
                        currentProducts = result.updatedProducts;

                        // Add barcode to sync
                        const up = currentProducts.find(p => p.id === product.id);
                        if (up) {
                            up.variants.forEach(pv => {
                                if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                                    const total = Object.values(pv.stocks).reduce<number>((a, b) => a + (Number(b) || 0), 0);
                                    barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : Number(total);
                                }
                            });
                        }

                        // Add new return record
                        const newReturnRecord: ReturnRecord = {
                            id: uuidv4(),
                            orderId: order.id,
                            marketplaceOrderId: order.marketplaceOrderId,
                            customerName: order.customerName,
                            item: item,
                            returnQuantity: returnQty,
                            returnDate: new Date().toISOString()
                        };
                        currentReturns.push(newReturnRecord);

                        // Remove from claim list
                        currentReturnClaims = currentReturnClaims.filter(rc => rc.claimId !== claim.claimId || rc.claimLineItemId !== claim.claimLineItemId);

                        successCount++;
                        stockUpdatedCount++;
                    } else {
                        failCount++;
                    }
                } catch (e) {
                    console.error(e);
                    failCount++;
                }
            }

            // Single atomic DB update
            updateDB({
                ...db,
                products: currentProducts,
                orders: db.orders,
                returns: currentReturns,
                returnClaims: currentReturnClaims
            });

            // Batch sync stocks
            if (db.settings.enableAutoStockSync && Object.keys(barcodesToSync).length > 0) {
                const itemsToSync = Object.entries(barcodesToSync).map(([barcode, qty]) => ({ barcode, quantity: qty }));
                await syncBarcodeStockBatchMultiple(db.apiConfigs, itemsToSync, db.settings);
            }

            let finalMsg = `${successCount} iade onaylandı.`;
            if (stockUpdatedCount > 0) {
                finalMsg += ` ${stockUpdatedCount} adetinde stok güncellendi.`;
            } else {
                finalMsg += ` (Yerel kayıt bulunamadığı için stok güncellemesi yapılmadı)`;
            }

            if (failCount > 0) finalMsg += ` ${failCount} hata oluştu.`;

            setNotification({
                type: successCount > 0 ? 'success' : 'error',
                message: finalMsg
            });
            setSelectedClaimIds(new Set());
            setIsApproving(null);
        });
    };


    const toggleSelectAll = () => {
        if (selectedClaimIds.size === paginatedClaims.length && paginatedClaims.length > 0) {
            setSelectedClaimIds(new Set());
        } else {
            setSelectedClaimIds(new Set(paginatedClaims.map(c => c.id)));
        }
    };

    const toggleSelectClaim = (id: string) => {
        const newSet = new Set(selectedClaimIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedClaimIds(newSet);
    };

    const availableStores = useMemo(() => {
        return Array.from(new Set(db.apiConfigs.map(c => c.storeName)));
    }, [db.apiConfigs]);

    return (
        <div className="flex flex-col h-full space-y-4">
            {/* Header Area */}
            <div className="flex items-center justify-between bg-gray-50 p-4 border-b rounded-t-lg">
                <div className="flex items-center gap-4">
                    <div className="flex flex-col">
                        <h2 className="text-lg font-bold text-gray-800 flex items-center">
                            <RotateCw className="w-5 h-5 mr-2 text-orange-600" />
                            İade Yönetimi
                            <span className="ml-3 bg-orange-100 text-orange-700 text-xs px-2 py-1 rounded-full border border-orange-200">
                                {claims.length} Aksiyon Bekliyor
                            </span>
                        </h2>
                        <span className="text-[10px] text-gray-400 font-bold ml-7 uppercase tracking-widest mt-0.5">Aksiyondakiler</span>
                    </div>
                </div>

                <div className="flex items-center space-x-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                        <input
                            type="text"
                            placeholder="Sipariş no, müşteri, barkod, claim no, kargo kodu..."
                            className="pl-10 pr-4 py-2 border rounded-lg text-sm w-48 focus:ring-2 focus:ring-orange-500 outline-none"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>

                    <select
                        className="border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500 bg-white cursor-pointer"
                        value={storeFilter}
                        onChange={(e) => { setStoreFilter(e.target.value); setCurrentPage(1); }}
                    >
                        <option value="all">Tüm Mağazalar</option>
                        {availableStores.map(store => (
                            <option key={store} value={store}>{store}</option>
                        ))}
                    </select>

                    {selectedClaimIds.size > 0 && (
                        <button
                            onClick={handleBulkApprove}
                            disabled={isApproving !== null}
                            className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2 text-sm shadow-sm transition-all active:scale-95"
                        >
                            {isApproving === 'bulk' ? <RotateCw size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                            Seçilenleri Onayla ({selectedClaimIds.size})
                        </button>
                    )}

                    <button
                        onClick={handleSync}
                        disabled={isSyncing}
                        className="flex items-center gap-2 px-3 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-sm font-bold shadow-sm disabled:bg-gray-400 transition-all active:scale-95"
                    >
                        <RotateCw size={16} className={isSyncing ? 'animate-spin' : ''} />
                        {isSyncing ? 'Güncelleniyor...' : 'İadeleri Yenile'}
                    </button>

                </div>
            </div>

            {/* Table Area */}
            <div className="flex-1 overflow-auto px-4 pb-4">
                <table className="w-full text-left border-collapse bg-white rounded-lg shadow-sm border border-gray-200">
                    <thead className="bg-gray-100 border-b sticky top-0 z-10 font-bold text-gray-600 text-[10px] uppercase tracking-wider">
                        <tr>
                            <th className="px-4 py-3 w-10 text-center">
                                <input
                                    type="checkbox"
                                    className="rounded border-gray-300 text-orange-600 focus:ring-orange-500 cursor-pointer"
                                    checked={selectedClaimIds.size === paginatedClaims.length && paginatedClaims.length > 0}
                                    onChange={toggleSelectAll}
                                />
                            </th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-gray-200" onClick={() => setSortConfig(prev => ({ key: 'storeName', direction: prev.key === 'storeName' && prev.direction === 'asc' ? 'desc' : 'asc' }))}>
                                <div className="flex items-center gap-1">
                                    Mağaza / Müşteri
                                    <ArrowUpDown size={10} className="opacity-30" />
                                </div>
                            </th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-gray-200" onClick={() => setSortConfig(prev => ({ key: 'orderNumber', direction: prev.key === 'orderNumber' && prev.direction === 'asc' ? 'desc' : 'asc' }))}>
                                <div className="flex items-center gap-1">
                                    Sipariş No
                                    <ArrowUpDown size={10} className="opacity-30" />
                                </div>
                            </th>
                            <th className="px-4 py-3">Ürün Görseli / Bilgisi</th>
                            <th className="px-4 py-3 text-center">İade Adet</th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-gray-200" onClick={() => setSortConfig(prev => ({ key: 'barcode', direction: prev.key === 'barcode' && prev.direction === 'asc' ? 'desc' : 'asc' }))}>
                                <div className="flex items-center gap-1">
                                    Barkod
                                    <ArrowUpDown size={10} className="opacity-30" />
                                </div>
                            </th>
                            <th className="px-4 py-3">İade Gönderi Kodu</th>
                            <th className="px-4 py-3">İade Sebebi</th>
                            <th className="px-4 py-3">Açıklama</th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-gray-200" onClick={() => setSortConfig(prev => ({ key: 'claimDate', direction: prev.key === 'claimDate' && prev.direction === 'asc' ? 'desc' : 'asc' }))}>
                                <div className="flex items-center gap-1">
                                    Talep Tarihi
                                    <ArrowUpDown size={10} className="opacity-30" />
                                </div>
                            </th>
                            <th className="px-4 py-3 text-right">İşlem</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                        {paginatedClaims.map((claim) => (
                            <tr key={claim.id} className={`hover:bg-orange-50/30 transition-colors group ${selectedClaimIds.has(claim.id) ? 'bg-orange-50' : ''}`}>
                                <td className="px-4 py-4 text-center">
                                    <input
                                        type="checkbox"
                                        className="rounded border-gray-300 text-orange-600 focus:ring-orange-500 cursor-pointer"
                                        checked={selectedClaimIds.has(claim.id)}
                                        onChange={() => toggleSelectClaim(claim.id)}
                                    />
                                </td>
                                <td className="px-4 py-4 whitespace-nowrap">
                                    <div className="flex flex-col">
                                        <span className="font-extrabold text-xs text-gray-800 uppercase tracking-tight">{claim.storeName}</span>
                                        <span className="text-[10px] text-gray-500 font-medium">{claim.customerName}</span>
                                    </div>
                                </td>
                                <td className="px-4 py-4 text-[11px] font-mono font-bold text-gray-600">
                                    <CopyableText text={claim.orderNumber} label="Sipariş No" />
                                </td>
                                <td className="px-4 py-4 min-w-[320px]">
                                    <div className="flex items-center space-x-3">
                                        <div
                                            className="relative group/img cursor-pointer"
                                            onClick={() => {
                                                const img = getClaimProductImage(claim);
                                                if (img) setZoomedImage(img);
                                            }}
                                        >
                                            {getClaimProductImage(claim) ? (
                                                <img src={getClaimProductImage(claim)} alt="" className="w-12 h-12 object-cover rounded-lg border-2 border-white shadow-md bg-white group-hover/img:scale-110 transition-transform" />
                                            ) : (
                                                <div className="w-12 h-12 rounded-lg border-2 border-gray-200 bg-gray-100 flex items-center justify-center text-gray-400">
                                                    <ImageIcon size={14} />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex flex-col max-w-[300px]">
                                            <CopyableText text={claim.productName} label="Ürün Adı" className="text-[12px] font-bold text-gray-800 leading-tight uppercase" />
                                            <span className="text-[10px] text-gray-500">
                                                {(claim.color || '-') + ' / ' + (claim.size || '-')}
                                            </span>
                                        </div>
                                    </div>
                                </td>
                                <td className="px-4 py-4 text-center text-[12px] font-extrabold text-gray-800">
                                    {claim.returnQuantity}
                                </td>
                                <td className="px-4 py-4 text-[11px] font-extrabold text-gray-700 bg-gray-50/50">
                                    <CopyableText text={claim.barcode} label="Barkod" />
                                </td>
                                <td className="px-4 py-4 text-[11px] font-mono text-gray-600">
                                    <CopyableText text={claim.cargoTrackingNumber || '-'} label="Kargo Kodu" />
                                </td>
                                <td className="px-4 py-4">
                                    <div className="flex flex-col max-w-xs">
                                        <span className={`text-[11px] font-extrabold uppercase tracking-tight ${isCriticalReason(claim.reason) ? 'text-red-700' : 'text-orange-700'}`}>{claim.reason}</span>
                                        {isCriticalReason(claim.reason) && (
                                            <span className="mt-1 text-[10px] font-extrabold text-red-600 bg-red-50 border border-red-200 rounded px-1 py-0.5">
                                                Dikkat: Kritik iade nedeni, kontrol ederek onaylayın.
                                            </span>
                                        )}
                                    </div>
                                </td>
                                <td className="px-4 py-4 min-w-[260px]">
                                    <p className="text-[12px] text-gray-600 italic leading-relaxed">{claim.description || 'Açıklama girilmedi.'}</p>
                                </td>
                                <td className="px-4 py-4 whitespace-nowrap text-[10px] font-medium text-gray-500">
                                    {safeFormatDate(claim.claimDate)}
                                </td>
                                <td className="px-4 py-4 text-right">
                                    <button
                                        onClick={() => handleApprove(claim)}
                                        disabled={isApproving !== null}
                                        className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg text-[11px] font-extrabold transition-all shadow-md active:scale-95 disabled:bg-gray-400 disabled:shadow-none uppercase tracking-widest"
                                    >
                                        {isApproving === claim.claimId ? <RotateCw size={14} className="animate-spin" /> : 'Onayla'}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {paginatedClaims.length === 0 && !isSyncing && (
                    <div className="flex flex-col items-center justify-center py-24 bg-white rounded-xl border-2 border-dashed border-gray-100 text-gray-300 mt-4">
                        <div className="p-6 bg-gray-50 rounded-full mb-4">
                            <ImageIcon size={48} className="opacity-20 text-orange-600" />
                        </div>
                        <p className="text-lg font-extrabold text-gray-400">İade talebi bulunamadı</p>
                        <p className="text-xs font-bold text-gray-300 uppercase tracking-widest">Şu an için onay bekleyen iade kaydı yok.</p>
                    </div>
                )}
            </div>

            {/* Pagination Area */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between bg-white px-6 py-4 border-t rounded-b-lg shadow-inner">
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                        Sayfa <strong className="text-gray-600">{currentPage}</strong> / <strong className="text-gray-600">{totalPages}</strong> (Toplam {filteredClaims.length} kayıt)
                    </div>
                    <div className="flex items-center space-x-2">
                        <button
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={currentPage === 1}
                            className="p-2 rounded-xl border-2 border-gray-100 hover:border-orange-200 hover:bg-orange-50 disabled:opacity-30 disabled:border-gray-100 disabled:bg-transparent transition-all"
                        >
                            <ChevronLeft size={18} className="text-gray-600" />
                        </button>
                        <div className="flex items-center space-x-1.5">
                            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                                <button
                                    key={p}
                                    onClick={() => setCurrentPage(p)}
                                    className={`w-10 h-10 rounded-xl text-xs font-bold transition-all shadow-sm ${currentPage === p ? 'bg-orange-600 text-white shadow-orange-200 scale-110' : 'bg-white border-2 border-gray-100 hover:border-orange-200 text-gray-600'}`}
                                >
                                    {p}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={currentPage === totalPages}
                            className="p-2 rounded-xl border-2 border-gray-100 hover:border-orange-200 hover:bg-orange-50 disabled:opacity-30 disabled:border-gray-100 disabled:bg-transparent transition-all"
                        >
                            <ChevronRight size={18} className="text-gray-600" />
                        </button>
                    </div>
                </div>
            )}



            {/* Image Zoom Modal */}
            {zoomedImage && (
                <div
                    className="fixed inset-0 z-[500] flex items-center justify-center p-10 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300 cursor-zoom-out"
                    onClick={() => setZoomedImage(null)}
                >
                    <button
                        className="absolute top-6 right-6 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
                        onClick={() => setZoomedImage(null)}
                    >
                        <X size={32} />
                    </button>
                    <img
                        src={zoomedImage}
                        alt="Zoomed"
                        className="max-w-full max-h-full object-contain rounded-xl shadow-2xl animate-in zoom-in-95 duration-300"
                    />
                </div>
            )}
        </div>
    );
};
