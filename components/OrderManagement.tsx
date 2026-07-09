import React, { useState, useEffect, useRef } from 'react';
import { isInternationalOrder, getEffectiveOrderCountryCode, resolveCountryCodeFromTrendyolApi, resolveCargoCompanyFromTrendyolApi, orderImportDismissKey } from '../utils/orderUtils';
import { Database, Order, OrderStatus, OrderItem, ReturnRecord, Product, UserRole, Variant } from '../types';
import { RefreshCcw, Printer, Play, Filter, PauseCircle, AlertTriangle, Loader2, RotateCcw, ChevronDown, CheckSquare, Square, FileSpreadsheet, LayoutTemplate, Save, Eye, ArrowLeftRight, Bell, FileText, SearchCheck, HardDrive, ArrowUp, ArrowDown, Trash, Trash2, ZoomIn, ZoomOut, Plus, Globe, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import * as XLSX from 'xlsx';
import { syncBarcodeStock, updateLocalStockWithConsistency, syncOrderStatusToMarketplaces, fetchOrdersFromTrendyol, syncMarketplaceOrders, syncBarcodeStockBatchMultiple } from '../services/integration';
// @ts-ignore
import JsBarcode from 'jsbarcode';

const uuid = () => Math.random().toString(36).substr(2, 9);

interface Props {
    db: Database;
    updateDB: (newDB: Database | ((prev: Database) => Database)) => void | Promise<void>;
    userRole: UserRole;
    activeTab: 'active' | 'cancelled' | 'suspended' | 'returned';
    onTabChange: (tab: 'active' | 'cancelled' | 'suspended' | 'returned') => void;
    onBadgeCountUpdate?: (count: number | null) => void;
    setNotification: (notif: { type: 'success' | 'error', message: string } | null) => void;
    requestConfirm: (message: string, onConfirm: () => void) => void;
}


interface PrintElement {
    id: string;
    label: string;
    key: string; // Key in Order object or special key like 'itemsTable'
    x: number;
    y: number;
    fontSize: number;
    fontFamily?: string;
    content?: string; // For notes or custom text
    width?: number; // For container width
    height?: number; // For container height (e.g. images)
    visible: boolean;
    isBarcode?: boolean;
    barcodeHeight?: number;
    forceUppercase?: boolean;
    tableColumns?: { key: string; label: string; visible: boolean }[]; // For items table customization
    isImage?: boolean; // For image elements
    rotation?: number;
}

interface PrintConfig {
    paperSize: 'A4' | 'A5' | 'Thermal' | 'Custom';
    customWidth?: number;
    customHeight?: number;
    elements: PrintElement[];
    selectedPrinter?: string;
}

export interface SavedPrintTemplate {
    id: string;
    name: string;
    config: PrintConfig;
}

const DEFAULT_PRINT_CONFIG: PrintConfig = {
    paperSize: 'A4',
    selectedPrinter: 'default',
    elements: [
        { id: '1', label: 'Mağaza Adı', key: 'storeName', x: 20, y: 10, fontSize: 18, visible: true },
        { id: '3', label: 'Sipariş No', key: 'marketplaceOrderId', x: 130, y: 20, fontSize: 14, visible: true, isBarcode: true },
        { id: '6', label: 'Tarih', key: 'orderDate', x: 20, y: 30, fontSize: 12, visible: true },
        { id: '2', label: 'Müşteri Adı', key: 'customerName', x: 20, y: 40, fontSize: 14, visible: true },
        { id: '4', label: 'Kargo Kodu', key: 'cargoCode', x: 130, y: 50, fontSize: 14, visible: true, isBarcode: true },
        { id: '4b', label: 'Kargo Firması', key: 'cargoCompanyName', x: 20, y: 52, fontSize: 10, visible: true },
        { id: '4c', label: 'Ülke', key: 'countryName', x: 20, y: 56, fontSize: 10, visible: true },
        { id: '7', label: 'Adres', key: 'deliveryAddress', x: 20, y: 64, fontSize: 10, width: 100, visible: true },
        {
            id: '5', label: 'Ürün Listesi', key: 'items', x: 20, y: 100, fontSize: 10, width: 170, visible: true, tableColumns: [
                { key: 'productName', label: 'Ürün Adı', visible: true },
                { key: 'color', label: 'Renk', visible: true },
                { key: 'size', label: 'Beden', visible: true },
                { key: 'quantity', label: 'Adet', visible: true },
                { key: 'sku', label: 'SKU', visible: true },
                { key: 'barcode', label: 'Barkod', visible: true },
                { key: 'price', label: 'Fiyat', visible: true }
            ]
        },
        { id: '8', label: 'Not 1', key: 'customNote', x: 20, y: 260, fontSize: 12, width: 150, visible: true, content: '' },
        { id: 'n2', label: 'Not 2', key: 'customNote2', x: 20, y: 275, fontSize: 12, width: 150, visible: false, content: '' },
        { id: 'n3', label: 'Not 3', key: 'customNote3', x: 20, y: 290, fontSize: 12, width: 150, visible: false, content: '' },
        { id: 'n4', label: 'Not 4', key: 'customNote4', x: 20, y: 305, fontSize: 12, width: 150, visible: false, content: '' },
        { id: 'n5', label: 'Not 5', key: 'customNote5', x: 20, y: 320, fontSize: 12, width: 150, visible: false, content: '' },
        { id: 'img1', label: 'Görsel 1', key: 'customImage1', x: 20, y: 230, fontSize: 12, width: 40, height: 20, visible: false, content: '', isImage: true },
        { id: 'img2', label: 'Görsel 2', key: 'customImage2', x: 150, y: 10, fontSize: 12, width: 40, height: 20, visible: false, content: '', isImage: true },
        { id: 'img3', label: 'Görsel 3', key: 'customImage3', x: 20, y: 10, fontSize: 12, width: 40, height: 20, visible: false, content: '', isImage: true },
    ]
};

export const OrderManagement: React.FC<Props> = ({ db, updateDB, userRole, activeTab, onTabChange, onBadgeCountUpdate, setNotification, requestConfirm }) => {
    const [selectedOrders, setSelectedOrders] = useState<string[]>([]);
    const [zoomLevel, setZoomLevel] = useState(100);
    // Search and Filter States
    const [searchTerm, setSearchTerm] = useState('');
    const [orderSearch, setOrderSearch] = useState('');
    const [customerSearch, setCustomerSearch] = useState('');
    const [barcodeSearch, setBarcodeSearch] = useState('');
    const [productNameSearch, setProductNameSearch] = useState('');
    const [selectedStores, setSelectedStores] = useState<string[]>([]);
    const [storeFilterOpen, setStoreFilterOpen] = useState(false);
    const storeDropdownRef = useRef<HTMLDivElement>(null);
    const [cargoSearch, setCargoSearch] = useState('');
    const [sellerSearch, setSellerSearch] = useState('');
    const [stockSearch, setStockSearch] = useState('');
    const [dateFilterStart, setDateFilterStart] = useState('');
    const [dateFilterEnd, setDateFilterEnd] = useState('');
    const [skuSearch, setSkuSearch] = useState('');
    const [printedFilter, setPrintedFilter] = useState<'all' | 'printed' | 'unprinted'>('all');
    const [isSyncing, setIsSyncing] = useState(false);
    const [isStatusUpdating, setIsStatusUpdating] = useState(false);
    const [selectedCountries, setSelectedCountries] = useState<string[]>([]); // Filter by multiple countries
    const [countryFilterOpen, setCountryFilterOpen] = useState(false);
    const countryDropdownRef = useRef<HTMLDivElement>(null);

    const PRIORITY_COUNTRIES = [
        { name: 'Türkiye', code: 'TR' },
        { name: 'Suudi Arabistan', code: 'SA' },
        { name: 'Birleşik Arap Emirlikleri', code: 'AE' },
        { name: 'Katar', code: 'QA' },
        { name: 'Kuveyt', code: 'KW' },
        { name: 'Umman', code: 'OM' },
        { name: 'Bahreyn', code: 'BH' },
        { name: 'Azerbaycan', code: 'AZ' },
        { name: 'Slovakya', code: 'SK' },
        { name: 'Romanya', code: 'RO' },
        { name: 'Çekya', code: 'CZ' },
        { name: 'Yunanistan', code: 'GR' },
        { name: 'Bulgaristan', code: 'BG' },
        { name: 'Moldova', code: 'MD' },
        { name: 'Sırbistan', code: 'XS' },
        { name: 'Ukrayna', code: 'UA' }
    ];

    const getCountryName = (code: string): string => {
        if (!code) return 'YURT DIŞI';
        const codeUpper = code.toUpperCase();
        if (codeUpper === 'TR') return '';
        const found = PRIORITY_COUNTRIES.find(c => c.code.toUpperCase() === codeUpper);
        return found ? found.name.toLocaleUpperCase('tr-TR') : codeUpper;
    };

    // Status Filter State

    const [statusFilterOpen, setStatusFilterOpen] = useState(false);
    const [selectedStatuses, setSelectedStatuses] = useState<OrderStatus[]>([
        OrderStatus.NEW,
        OrderStatus.PROCESSING
    ]);
    const [suspendedStatuses, setSuspendedStatuses] = useState<OrderStatus[]>([
        OrderStatus.NEW,
        OrderStatus.PROCESSING
    ]);
    const statusDropdownRef = useRef<HTMLDivElement>(null);

    // Badge Count Logic (Smart Badge)
    useEffect(() => {
        if (!onBadgeCountUpdate) return;

        // "Active" tab logic
        if (activeTab === 'active') {
            // Check if any filter is active that deviates from the default "Actionable" view
            const isDefaultView =
                searchTerm === '' &&
                orderSearch === '' &&
                customerSearch === '' &&
                productNameSearch === '' &&
                selectedStores.length === 0 &&
                cargoSearch === '' &&
                skuSearch === '' &&
                dateFilterStart === '' &&
                dateFilterEnd === '' &&
                printedFilter === 'all' &&
                selectedCountries.length === 0 &&
                selectedStatuses.length === 2 &&
                selectedStatuses.includes(OrderStatus.NEW) &&
                selectedStatuses.includes(OrderStatus.PROCESSING);

            if (isDefaultView) {
                // Return to default counting (App.tsx will handle it: NEW + PROCESSING)
                onBadgeCountUpdate(null);
            } else {
                // Filter active: Return exact count of displayed items
                onBadgeCountUpdate(getFilteredOrders().length);
            }
        } else {
            // For other tabs, we don't override (let App.tsx handle default logic)
            // Or if you want to be strict, you can override here too.
            // For now, let's reset override when leaving active tab
            onBadgeCountUpdate(null);
        }
    }, [
        activeTab,
        searchTerm,
        orderSearch,
        customerSearch,
        productNameSearch,
        selectedStores,
        selectedCountries,
        cargoSearch,
        skuSearch,
        dateFilterStart,
        dateFilterEnd,
        printedFilter,
        selectedStatuses,
        db.orders // db değişirse de güncelle
    ]);

    // Reset page on tab or filter change
    useEffect(() => {
        setCurrentPage(1);
    }, [activeTab, selectedStores, productNameSearch, selectedCountries, printedFilter]);

    // Return Modal State
    const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
    const [isProcessingReturn, setIsProcessingReturn] = useState(false);
    const [returnOrderTarget, setReturnOrderTarget] = useState<Order | null>(null);
    const [returnQuantities, setReturnQuantities] = useState<{ [barcode: string]: number }>({});

    // Order Detail Modal State
    const [detailOrder, setDetailOrder] = useState<Order | null>(null);

    const [autoRefreshTrigger, setAutoRefreshTrigger] = useState(0);
    const invokeShowNotification = (options: { title?: string; body?: string; playSound?: boolean }) => {
        try {
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                return ipcRenderer.invoke('show-notification', options);
            }
            const electron = (window as any).electron;
            if (electron?.showNotification) {
                return electron.showNotification(options);
            }
        } catch (e) {
            console.error('Notification invoke failed:', e);
        }
        return Promise.resolve(false);
    };
    const [isManualOrderModalOpen, setIsManualOrderModalOpen] = useState(false);
    const [manualOrderForm, setManualOrderForm] = useState<{
        customerName: string;
        phone: string;
        deliveryAddress: string;
        marketplaceOrderId: string;
        cargoCode: string;
        cargoCompanyName: string;
        countryCode: string;
        storeName: string;
        orderDate: string;
        items: { barcode: string; productName: string; color: string; size: string; quantity: number; unitPrice: number; sku: string; }[];
    }>({
        customerName: '',
        phone: '',
        deliveryAddress: '',
        marketplaceOrderId: '',
        cargoCode: '',
        cargoCompanyName: '',
        countryCode: 'TR',
        storeName: '',
        orderDate: new Date().toISOString().split('T')[0],
        items: []
    });
    const [manualBarcode, setManualBarcode] = useState('');



    // Print Designer State
    const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
    const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
    const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
    const [newTemplateName, setNewTemplateName] = useState('');
    const [printConfig, setPrintConfig] = useState<PrintConfig>(DEFAULT_PRINT_CONFIG);
    const [savedTemplates, setSavedTemplates] = useState<SavedPrintTemplate[]>([]);
    const [previewOrders, setPreviewOrders] = useState<Order[]>([]); // Preview için Trendyol'dan çekilen siparişler
    const [previewZoom, setPreviewZoom] = useState(1); // Preview yakınlaştırma/uzaklaştırma

    // Printer Detection State
    const [availablePrinters, setAvailablePrinters] = useState<string[]>([]);
    const [isScanningPrinters, setIsScanningPrinters] = useState(false);

    // PDF Generation State
    const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
    const [pdfProgress, setPdfProgress] = useState(0);
    const [pdfTotalPages, setPdfTotalPages] = useState(0);

    // Sorting State
    const [sortBy, setSortBy] = useState<'date' | 'orderNumber' | 'customerName' | 'sku' | 'productName' | null>('date');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Column Resizing State
    const [columnWidths, setColumnWidths] = useState<Record<string, number>>(db.settings.columnWidths || {});
    const resizingRef = useRef<{ key: string; startWidth: number; startX: number } | null>(null);

    const handleResizeStart = (e: React.MouseEvent, key: string, currentWidth: number) => {
        e.preventDefault();
        resizingRef.current = { key, startWidth: currentWidth, startX: e.pageX };
        document.body.style.cursor = 'col-resize';
        document.body.classList.add('resizing-active');
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!resizingRef.current) return;
            const { key, startWidth, startX } = resizingRef.current;
            const delta = e.pageX - startX;
            const newWidth = Math.max(50, startWidth + delta);
            setColumnWidths(prev => ({ ...prev, [key]: newWidth }));
        };

        const handleMouseUp = () => {
            if (resizingRef.current) {
                // Save to DB on finish
                const { key } = resizingRef.current;
                setColumnWidths(current => {
                    updateDB({
                        ...db,
                        settings: {
                            ...db.settings,
                            columnWidths: current
                        }
                    });
                    return current;
                });

                resizingRef.current = null;
                document.body.style.cursor = '';
                document.body.classList.remove('resizing-active');
            }
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [columnWidths, db, updateDB]);

    // Pagination State
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage, setItemsPerPage] = useState(25);

    const safeFormatDate = (dateStr: string | undefined, includeTime: boolean = true) => {
        if (!dateStr) return 'Tarih Belirtilmemiş';
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return 'Geçersiz Tarih';
            if (includeTime) {
                return date.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            }
            return date.toLocaleDateString('tr-TR');
        } catch (e) {
            return 'Hatalı Tarih';
        }
    };

    // Filtre verildiğinde tarih/görünürlük sınırını kapatmak için (liste her zaman db.orders üzerinden)
    const [showAllOrders, setShowAllOrders] = useState(false);


    // Handle clicking outside filter dropdown
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (statusDropdownRef.current && !statusDropdownRef.current.contains(event.target as Node)) {
                setStatusFilterOpen(false);
            }
            if (countryDropdownRef.current && !countryDropdownRef.current.contains(event.target as Node)) {
                setCountryFilterOpen(false);
            }
            if (storeDropdownRef.current && !storeDropdownRef.current.contains(event.target as Node)) {
                setStoreFilterOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);



    // Load saved print template on mount
    // Auto-sync on mount disabled in v1.2.8 for better UX
    useEffect(() => {
        // handleSync();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        const savedTemplatesStr = localStorage.getItem('printTemplates');
        if (savedTemplatesStr) {
            try {
                const templates = JSON.parse(savedTemplatesStr);
                setSavedTemplates(templates);
                if (templates.length > 0) {
                    setPrintConfig(templates[0].config);
                }
            } catch (error) {
                console.error('Failed to load print templates:', error);
            }
        } else {
            // Migration for old printConfig
            const saved = localStorage.getItem('printConfig');
            if (saved) {
                try {
                    const config = JSON.parse(saved);
                    const mergedElements = config.elements.map((el: any) => {
                        const defEl = DEFAULT_PRINT_CONFIG.elements.find(e => e.id === el.id);
                        if (defEl && defEl.tableColumns && el.tableColumns) {
                            const mergedCols = [...el.tableColumns];
                            defEl.tableColumns.forEach(defCol => {
                                if (!mergedCols.find(c => c.key === defCol.key)) {
                                    mergedCols.push(defCol);
                                }
                            });
                            return { ...el, tableColumns: mergedCols };
                        }
                        return el;
                    });
                    DEFAULT_PRINT_CONFIG.elements.forEach(defEl => {
                        if (!mergedElements.find(e => e.id === defEl.id)) {
                            mergedElements.push(defEl);
                        }
                    });
                    config.elements = mergedElements;
                    setPrintConfig(config);
                    
                    const migratedTemplate: SavedPrintTemplate = { id: uuid(), name: 'Eski Şablon', config };
                    setSavedTemplates([migratedTemplate]);
                    localStorage.setItem('printTemplates', JSON.stringify([migratedTemplate]));
                } catch (error) {
                    console.error('Failed to load saved print config:', error);
                }
            }
        }
    }, []);

    // Barcode Generation for Print View
    useEffect(() => {
        const timer = setTimeout(() => {
            if (window.document.querySelectorAll('.barcode-render').length > 0) {
                JsBarcode(".barcode-render").init();
            }
        }, 500);
        return () => clearTimeout(timer);
    }, [isPrintModalOpen, selectedOrders, printConfig]); // Re-run when config changes to update live preview

    // Listen for product saved events to auto-check suspended orders
    useEffect(() => {
        const handleCheckSuspendedOrderEvent = async (event: CustomEvent<{ orderId: string }>) => {
            // Kısa bir gecikme ile db'nin güncellenmesini bekle
            setTimeout(() => {
                const order = db.orders.find(o => o.id === event.detail.orderId);
                if (order && order.isSuspended && !order.wasSuspended) {
                    // handleCheckSuspended'i çağır
                    handleCheckSuspended(order).catch(err => console.error('Auto-check suspended order error:', err));
                }
            }, 500);
        };

        window.addEventListener('checkSuspendedOrder', handleCheckSuspendedOrderEvent as EventListener);
        return () => {
            window.removeEventListener('checkSuspendedOrder', handleCheckSuspendedOrderEvent as EventListener);
        };
    }, [db.orders]);


    const handleAddManualItem = () => {
        if (!manualBarcode) return;

        let foundProduct: Product | null = null;
        let foundVariant: Variant | null = null;

        for (const p of db.products) {
            const v = p.variants.find(v => v.barcode === manualBarcode);
            if (v) {
                foundProduct = p;
                foundVariant = v;
                break;
            }
        }

        if (foundProduct && foundVariant) {
            setManualOrderForm(prev => {
                const existingItemIndex = prev.items.findIndex(item => item.barcode === manualBarcode);

                if (existingItemIndex > -1) {
                    // Item already exists, increment quantity
                    const newItems = [...prev.items];
                    newItems[existingItemIndex] = {
                        ...newItems[existingItemIndex],
                        quantity: newItems[existingItemIndex].quantity + 1
                    };
                    return { ...prev, items: newItems };
                } else {
                    // New item
                    const newItem = {
                        barcode: manualBarcode,
                        productName: foundProduct!.name,
                        color: foundVariant!.color,
                        size: foundVariant!.size,
                        quantity: 1,
                        unitPrice: foundProduct!.salePrice || 0,
                        sku: foundVariant!.arma || '' // SKU alanı
                    };
                    return { ...prev, items: [...prev.items, newItem] };
                }
            });
            setManualBarcode('');
        } else {
            setNotification({ type: 'error', message: "Ürün bulunamadı!" });
            return;
        }
    };

    const handleSaveManualOrder = async () => {
        if (!manualOrderForm.customerName || manualOrderForm.items.length === 0) {
            setNotification({ type: 'error', message: "Müşteri adı ve en az bir ürün gereklidir." });
            return;
        }

        const newOrder: Order = {
            id: uuid(),
            marketplaceOrderId: manualOrderForm.marketplaceOrderId || `MAN-${Date.now()}`,
            storeName: manualOrderForm.storeName || 'Mağaza Satış',
            customerName: manualOrderForm.customerName,
            customerPhone: manualOrderForm.phone,
            deliveryAddress: manualOrderForm.deliveryAddress,
            orderDate: manualOrderForm.orderDate ? new Date(manualOrderForm.orderDate).toISOString() : new Date().toISOString(),
            status: OrderStatus.DELIVERED,
            cargoCode: manualOrderForm.cargoCode || '-',
            cargoCompanyName: manualOrderForm.cargoCompanyName || '',
            // @ts-ignore
            countryCode: manualOrderForm.countryCode || 'TR',
            items: manualOrderForm.items.map(item => ({
                productName: item.productName,
                barcode: item.barcode,
                sku: item.sku || item.barcode,
                color: item.color,
                size: item.size,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                totalPrice: Number(item.unitPrice) * Number(item.quantity)
            })),
            isSuspended: false,
            wasSuspended: false,
            isPrinted: false
        };

        let updatedProducts = [...db.products];
        const barcodesToSync: { [key: string]: number } = {};

        for (const item of newOrder.items) {
            const product = updatedProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
            if (product) {
                const variant = product.variants.find(v => v.barcode === item.barcode);
                if (variant) {
                    const targetWhId = 'wh1';
                    const currentWhStock = variant.stocks[targetWhId] || 0;

                    let newQty = currentWhStock - item.quantity;
                    if (!db.settings.allowNegativeStock && newQty < 0) {
                        newQty = 0;
                    }

                    const result = updateLocalStockWithConsistency(updatedProducts, product.id, variant.color, variant.size, targetWhId, newQty);
                    updatedProducts = result.updatedProducts;

                    const up = updatedProducts.find(p => p.id === product.id);
                    if (up) {
                        up.variants.forEach(pv => {
                            if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                                const total = Object.values(pv.stocks).reduce<number>((a, b) => a + (Number(b) || 0), 0);
                                barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : total;
                            }
                        });
                    }
                }
            }
        }

        updateDB(prev => ({
            ...prev,
            orders: [newOrder, ...prev.orders],
            products: updatedProducts
        }));

        if (Object.keys(barcodesToSync).length > 0) {
            const itemsToSync = Object.entries(barcodesToSync).map(([barcode, qty]) => ({ barcode, quantity: qty }));
            await syncBarcodeStockBatchMultiple(
                db.apiConfigs,
                itemsToSync,
                db.settings,
                (count) => setNotification({ type: 'success', message: `${count} barkod için sipariş stok güncellemesi başladı...` }),
                () => setNotification({ type: 'success', message: 'Sipariş stok güncellemesi bitti.' })
            );
        }

        setIsManualOrderModalOpen(false);
        setManualOrderForm({
            customerName: '',
            phone: '',
            deliveryAddress: '',
            marketplaceOrderId: '',
            cargoCode: '',
            cargoCompanyName: '',
            countryCode: 'TR',
            storeName: '',
            orderDate: new Date().toISOString().split('T')[0],
            items: []
        });
        setNotification({ type: 'success', message: 'Manuel sipariş başarıyla oluşturuldu.' });
    };


    const handleUpdateStatuses = async () => {
        setIsSyncing(true);
        console.log('[MANUAL-SYNC] Pazaryeri siparişleri güncelleniyor...');

        try {
            const result = await syncMarketplaceOrders(db, true);

            await updateDB(prev => ({
                ...prev,
                products: result.updatedProducts,
                orders: result.updatedOrders
            }));

            // OTOMATİK STOK GÜNCELLEME (Tüm mağazalara)
            if (Object.keys(result.barcodesToSync).length > 0) {
                const itemsToSync = Object.entries(result.barcodesToSync).map(([barcode, qty]) => ({ barcode, quantity: qty }));
                await syncBarcodeStockBatchMultiple(
                    db.apiConfigs,
                    itemsToSync,
                    db.settings,
                    (count) => setNotification({ type: 'success', message: `${count} barkod için stok güncelleme başladı...` }),
                    () => setNotification({ type: 'success', message: 'Stok güncelleme bitti.' })
                );
            }

            if (result.newOrdersAddedCount > 0) {
                const notifSettings = db.settings.notifications;
                if (notifSettings?.newOrderNotification) {
                    const shouldToast = notifSettings.windowsEnabled !== false;
                    const shouldSound = notifSettings.soundEnabled !== false;

                    if (shouldToast) {
                        invokeShowNotification({
                            title: 'Yeni Sipariş!',
                            body: `${result.newOrdersAddedCount} yeni sipariş sisteme düştü.`,
                            playSound: shouldSound
                        });
                    } else if (shouldSound) {
                        invokeShowNotification({ title: '', body: '', playSound: true });
                    }
                }

                setNotification({
                    type: 'success',
                    message: `${result.newOrdersAddedCount} yeni sipariş sisteme düştü.`
                });
            } else {
                setNotification({ type: 'success', message: 'Siparişler ve stoklar güncel.' });
            }
        } catch (error) {
            console.error('[MANUAL-SYNC-ERROR]', error);
            setNotification({ type: 'error', message: `Sipariş güncelleme hatası: ${(error as Error).message}` });
        } finally {
            setIsSyncing(false);
            setAutoRefreshTrigger(prev => prev + 1);
        }
    };

    const toggleStatusFilter = (status: OrderStatus) => {
        if (selectedStatuses.includes(status)) {
            if (selectedStatuses.length > 1) {
                setSelectedStatuses(selectedStatuses.filter(s => s !== status));
            }
        } else {
            setSelectedStatuses([...selectedStatuses, status]);
        }
    };

    const toggleSuspendedStatusFilter = (status: OrderStatus) => {
        if (suspendedStatuses.includes(status)) {
            if (suspendedStatuses.length > 1) {
                setSuspendedStatuses(suspendedStatuses.filter(s => s !== status));
            }
        } else {
            setSuspendedStatuses([...suspendedStatuses, status]);
        }
    };

    const toggleCountryFilter = (countryCode: string) => {
        if (selectedCountries.includes(countryCode)) {
            setSelectedCountries(selectedCountries.filter(c => c !== countryCode));
        } else {
            setSelectedCountries([...selectedCountries, countryCode]);
        }
    };

    const toggleStoreFilter = (storeName: string) => {
        if (selectedStores.includes(storeName)) {
            setSelectedStores(selectedStores.filter(s => s !== storeName));
        } else {
            setSelectedStores([...selectedStores, storeName]);
        }
    };


    const getFilteredOrders = () => {
        let list = db.orders.filter(o => !o.isDeleted);

        if (activeTab === 'cancelled') {
            // İade alınanları ve eski sürüm arşiv kayıtlarını İptal Edilenler sayfasında gösterme
            list = list.filter(o => o.status === OrderStatus.CANCELLED && !o.id.includes('_OLD_') && !db.returns.some(r => r.orderId === o.id));
        } else if (activeTab === 'suspended') {
            list = list.filter(
                o =>
                    o.isSuspended &&
                    o.status !== OrderStatus.CANCELLED &&
                    suspendedStatuses.includes(o.status)
            );
        } else if (activeTab === 'returned') {
            return []; // We handle this separately in render
        } else {
            list = list.filter(o => !o.isSuspended && o.status !== OrderStatus.CANCELLED);
            // Apply Status Filter only in Active Tab
            list = list.filter(o => selectedStatuses.includes(o.status));
        }

        // Ülke filtresi: yalnızca countryCode eşleşmesi (API / fullData ile tutarlı)
        if (activeTab !== 'returned' && selectedCountries.length > 0) {
            list = list.filter(o => {
                const codeUpper = getEffectiveOrderCountryCode(o).toUpperCase();
                return selectedCountries.some(code => codeUpper === code.toUpperCase());
            });
        }

        // Ayarlardaki gün filtresi (sadece filtre uygulanmadığında ve ayar aktifse)
        if (!showAllOrders && !dateFilterStart && !dateFilterEnd && db.settings.enableOrderVisibilityLimit) {
            const fetchDays = db.settings.orderFetchDays || 2;
            const thresholdDate = new Date();
            thresholdDate.setDate(thresholdDate.getDate() - fetchDays);

            list = list.filter(o => {
                // "Yeni Sipariş" ve "İşleme Alındı" statüsündekiler ASLA gizlenmez
                if (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING) {
                    return true;
                }
                return new Date(o.orderDate) >= thresholdDate;
            });
        }

        // Apply date filter (start-end range)
        if (dateFilterStart || dateFilterEnd) {
            list = list.filter(o => {
                const orderDate = new Date(o.orderDate);
                if (dateFilterStart && orderDate < new Date(dateFilterStart)) return false;
                if (dateFilterEnd) {
                    const endDate = new Date(dateFilterEnd);
                    endDate.setHours(23, 59, 59, 999); // End of day
                    if (orderDate > endDate) return false;
                }
                return true;
            });
        }

        // Mağaza (çoklu seçim)
        if (selectedStores.length > 0) {
            list = list.filter(o => selectedStores.includes(o.storeName));
        }

        // Apply SKU search filter
        if (skuSearch) {
            const lower = skuSearch.toLowerCase();
            console.log(`[SKU-SEARCH DEBUG] SKU Aranan: "${skuSearch}"`);
            list = list.filter(o => {
                const skuMatch = o.items.some(i => (i.sku || '').toLowerCase().includes(lower));
                console.log(`[SKU-SEARCH DEBUG] Sipariş ${o.marketplaceOrderId} SKU match: ${skuMatch}`);
                return skuMatch;
            });
        }

        // Apply order search filter
        if (orderSearch) {
            const lower = orderSearch.toLowerCase();
            list = list.filter(o => (o.marketplaceOrderId || '').toLowerCase().includes(lower));
        }

        // Apply customer search filter
        if (customerSearch) {
            const lower = customerSearch.toLowerCase();
            list = list.filter(o => (o.customerName || '').toLowerCase().includes(lower));
        }

        // Ürün adı (sütun filtresi)
        if (productNameSearch) {
            const lower = productNameSearch.toLowerCase();
            list = list.filter(o => o.items.some(i => (i.productName || '').toLowerCase().includes(lower)));
        }

        // Apply barcode search filter
        if (barcodeSearch) {
            const lower = barcodeSearch.toLowerCase();
            list = list.filter(o => o.items.some(i => (i.barcode || '').toLowerCase().includes(lower)));
        }

        // Apply cargo search filter
        if (cargoSearch) {
            const lower = cargoSearch.toLowerCase();
            list = list.filter(o => (String(o.cargoCode || '')).toLowerCase().includes(lower));
        }

        // Apply search filter
        // Apply printed filter
        if (printedFilter === 'printed') {
            list = list.filter(o => o.isPrinted);
        } else if (printedFilter === 'unprinted') {
            list = list.filter(o => !o.isPrinted);
        }

        if (searchTerm) {
            const lower = searchTerm.toLowerCase();
            console.log(`[SEARCH DEBUG] Aranan: "${searchTerm}"`);
            list = list.filter(o => {
                const customerMatch = (o.customerName || '').toLowerCase().includes(lower);
                const phoneMatch = (o.customerPhone || '').toLowerCase().includes(lower); // New: Search by phone
                const orderMatch = (o.marketplaceOrderId || '').toLowerCase().includes(lower);
                const storeMatch = (o.storeName || '').toLowerCase().includes(lower);
                const cargoMatch = (String(o.cargoCode || '')).toLowerCase().includes(lower);
                const itemMatch = o.items.some(i => {
                    const barcodeMatch = (i.barcode || '').toLowerCase().includes(lower);
                    const productNameMatch = (i.productName || '').toLowerCase().includes(lower);
                    const skuMatch = (i.sku || '').toLowerCase().includes(lower);
                    const colorMatch = (i.color || '').toLowerCase().includes(lower);
                    const sizeMatch = (i.size || '').toLowerCase().includes(lower);
                    return barcodeMatch || productNameMatch || skuMatch || colorMatch || sizeMatch;
                });

                const matches = customerMatch || phoneMatch || orderMatch || storeMatch || cargoMatch || itemMatch;
                return matches;
            });
        }

        // Apply sorting
        if (sortBy) {
            list = [...list].sort((a, b) => {
                let comparison = 0;
                switch (sortBy) {
                    case 'date':
                        comparison = new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime();
                        break;
                    case 'orderNumber':
                        comparison = (a.marketplaceOrderId || '').localeCompare(b.marketplaceOrderId || '', 'tr', { numeric: true, sensitivity: 'base' });
                        break;
                    case 'customerName':
                        comparison = (a.customerName || '').localeCompare(b.customerName || '', 'tr', { sensitivity: 'base' });
                        break;
                    case 'sku':
                        const aSku = a.items[0]?.sku || '';
                        const bSku = b.items[0]?.sku || '';
                        comparison = aSku.localeCompare(bSku, 'tr', { numeric: true, sensitivity: 'base' });
                        break;
                    case 'productName':
                        const aName = a.items[0]?.productName || '';
                        const bName = b.items[0]?.productName || '';
                        comparison = aName.localeCompare(bName, 'tr', { sensitivity: 'base' });
                        break;
                }
                return sortOrder === 'asc' ? comparison : -comparison;
            });
        }

        return list;
    };

    // Sipariş sayım fonksiyonları
    const getOrderCount = (tab: 'active' | 'cancelled' | 'suspended' | 'returned') => {
        let list = db.orders;

        if (tab === 'cancelled') {
            list = list.filter(o => o.status === OrderStatus.CANCELLED && !o.id.includes('_OLD_'));
        } else if (tab === 'suspended') {
            list = list.filter(
                o =>
                    o.isSuspended &&
                    o.status !== OrderStatus.CANCELLED &&
                    (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING)
            );
        } else if (tab === 'returned') {
            let retList = db.returns || [];
            if (!showAllOrders && !dateFilterStart && !dateFilterEnd) {
                const fetchDays = db.settings.orderFetchDays || 30;
                const thresholdDate = new Date();
                thresholdDate.setDate(thresholdDate.getDate() - fetchDays);
                retList = retList.filter(r => new Date(r.returnDate) >= thresholdDate);
            }
            const groups = new Set();
            retList.forEach(r => {
                const associatedOrder = db.orders.find(o => o.id === r.orderId || o.marketplaceOrderId === r.marketplaceOrderId);
                const storeName = associatedOrder ? associatedOrder.storeName : '-';
                groups.add(`${r.marketplaceOrderId}::${storeName}`);
            });
            return groups.size;
        } else {
            list = list.filter(o => !o.isSuspended && o.status !== OrderStatus.CANCELLED);
            list = list.filter(o => !isInternationalOrder(o));
        }

        // 30 gün filtresi
        if (!showAllOrders && !dateFilterStart && !dateFilterEnd) {
            const fetchDays = db.settings.orderFetchDays || 30;
            const thresholdDate = new Date();
            thresholdDate.setDate(thresholdDate.getDate() - fetchDays);
            list = list.filter(o => new Date(o.orderDate) >= thresholdDate);
        }

        return list.length;
    };

    // Filtre değiştiğinde tüm siparişleri göster
    useEffect(() => {
        const hasAnyFilter =
            dateFilterStart ||
            dateFilterEnd ||
            selectedStores.length > 0 ||
            cargoSearch ||
            sellerSearch ||
            stockSearch ||
            skuSearch ||
            searchTerm ||
            orderSearch ||
            customerSearch ||
            productNameSearch ||
            barcodeSearch ||
            selectedCountries.length > 0 ||
            printedFilter !== 'all';
        setShowAllOrders(hasAnyFilter);
    }, [
        dateFilterStart,
        dateFilterEnd,
        selectedStores,
        cargoSearch,
        sellerSearch,
        stockSearch,
        skuSearch,
        searchTerm,
        orderSearch,
        customerSearch,
        productNameSearch,
        barcodeSearch,
        selectedCountries,
        printedFilter
    ]);

    // Reset to page 1 when any filter or tab changes
    useEffect(() => {
        setCurrentPage(1);
    }, [
        searchTerm,
        orderSearch,
        customerSearch,
        barcodeSearch,
        productNameSearch,
        selectedStores,
        cargoSearch,
        sellerSearch,
        stockSearch,
        dateFilterStart,
        dateFilterEnd,
        printedFilter,
        selectedCountries,
        skuSearch,
        selectedStatuses,
        activeTab
    ]);

    // Get paginated orders
    const getPaginatedOrders = () => {
        const filtered = activeTab === 'returned' ? getGroupedReturns() : getFilteredOrders();
        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        return filtered.slice(startIndex, endIndex);
    };

    // Get total pages
    const getTotalPages = () => {
        const filtered = activeTab === 'returned' ? getGroupedReturns() : getFilteredOrders();
        const total = Math.ceil(filtered.length / itemsPerPage);
        return total > 0 ? total : 1;
    };

    const handleClearFilters = () => {
        setSearchTerm('');
        setOrderSearch('');
        setCustomerSearch('');
        setBarcodeSearch('');
        setProductNameSearch('');
        setSelectedStores([]);
        setCargoSearch('');
        setSellerSearch('');
        setStockSearch('');
        setDateFilterStart('');
        setDateFilterEnd('');
        setPrintedFilter('all');
        setSelectedCountries([]);
        setSkuSearch('');
        setSelectedStatuses([
            OrderStatus.NEW,
            OrderStatus.PROCESSING,
            OrderStatus.SHIPPING,
            OrderStatus.DELIVERED
        ]);
        setSortBy('date');
        setSortOrder('desc');
    };

    const handleSort = (column: 'sku') => {
        if (sortBy === column) {
            setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
        } else {
            setSortBy(column);
            setSortOrder('asc');
        }
    };

    const getFilteredReturns = () => {
        let list = db.returns || [];

        // Filter by 30 days visibility limit if showAllOrders is false
        if (!showAllOrders && !dateFilterStart && !dateFilterEnd) {
            const fetchDays = db.settings.orderFetchDays || 30;
            const thresholdDate = new Date();
            thresholdDate.setDate(thresholdDate.getDate() - fetchDays);
            list = list.filter(r => new Date(r.returnDate) >= thresholdDate);
        }

        // Mağaza (çoklu seçim)
        if (selectedStores.length > 0) {
            list = list.filter(r => {
                const associatedOrder = db.orders.find(o => o.id === r.orderId || o.marketplaceOrderId === r.marketplaceOrderId);
                const storeName = associatedOrder ? associatedOrder.storeName : '-';
                return selectedStores.includes(storeName);
            });
        }

        // Kargo arama
        if (cargoSearch) {
            const lower = cargoSearch.toLowerCase();
            list = list.filter(r => {
                const associatedOrder = db.orders.find(o => o.id === r.orderId || o.marketplaceOrderId === r.marketplaceOrderId);
                const cargoCode = associatedOrder ? String(associatedOrder.cargoCode || '') : '';
                return cargoCode.toLowerCase().includes(lower);
            });
        }

        // SKU arama
        if (skuSearch) {
            const lower = skuSearch.toLowerCase();
            list = list.filter(r => (r.item.sku || '').toLowerCase().includes(lower));
        }

        // Sipariş No arama
        if (orderSearch) {
            const lower = orderSearch.toLowerCase();
            list = list.filter(r => (r.marketplaceOrderId || '').toLowerCase().includes(lower));
        }

        // Müşteri adı arama
        if (customerSearch) {
            const lower = customerSearch.toLowerCase();
            list = list.filter(r => {
                const associatedOrder = db.orders.find(o => o.id === r.orderId || o.marketplaceOrderId === r.marketplaceOrderId);
                const name = r.customerName || (associatedOrder ? associatedOrder.customerName : '');
                return name.toLowerCase().includes(lower);
            });
        }

        // Ürün adı arama
        if (productNameSearch) {
            const lower = productNameSearch.toLowerCase();
            list = list.filter(r => (r.item.productName || '').toLowerCase().includes(lower));
        }

        // Tarih filtresi (İade Tarihi filter)
        if (dateFilterStart || dateFilterEnd) {
            list = list.filter(r => {
                const retDate = new Date(r.returnDate);
                if (dateFilterStart && retDate < new Date(dateFilterStart)) return false;
                if (dateFilterEnd) {
                    const endDate = new Date(dateFilterEnd);
                    endDate.setHours(23, 59, 59, 999);
                    if (retDate > endDate) return false;
                }
                return true;
            });
        }

        // Ülke Filtresi
        if (selectedCountries.length > 0) {
            list = list.filter(r => {
                const associatedOrder = db.orders.find(o => o.id === r.orderId || o.marketplaceOrderId === r.marketplaceOrderId);
                if (!associatedOrder) return false;
                const codeUpper = getEffectiveOrderCountryCode(associatedOrder).toUpperCase();
                return selectedCountries.some(code => codeUpper === code.toUpperCase());
            });
        }

        // Genel Arama (searchTerm)
        if (searchTerm) {
            const lower = searchTerm.toLowerCase();
            list = list.filter(r => {
                const associatedOrder = db.orders.find(o => o.id === r.orderId || o.marketplaceOrderId === r.marketplaceOrderId);
                const customerMatch = (r.customerName || (associatedOrder ? associatedOrder.customerName : '')).toLowerCase().includes(lower);
                const orderMatch = (r.marketplaceOrderId || '').toLowerCase().includes(lower);
                const storeMatch = (associatedOrder ? associatedOrder.storeName : '').toLowerCase().includes(lower);
                const cargoMatch = (associatedOrder ? String(associatedOrder.cargoCode || '') : '').toLowerCase().includes(lower);
                const productNameMatch = (r.item.productName || '').toLowerCase().includes(lower);
                const skuMatch = (r.item.sku || '').toLowerCase().includes(lower);
                const barcodeMatch = (r.item.barcode || '').toLowerCase().includes(lower);
                return customerMatch || orderMatch || storeMatch || cargoMatch || productNameMatch || skuMatch || barcodeMatch;
            });
        }

        return list;
    };

    const getGroupedReturns = () => {
        const list = getFilteredReturns();
        const groups: { [key: string]: any } = {};

        list.forEach(r => {
            const associatedOrder = db.orders.find(o => o.id === r.orderId || o.marketplaceOrderId === r.marketplaceOrderId);
            const storeName = associatedOrder ? associatedOrder.storeName : '-';
            const key = `${r.marketplaceOrderId}::${storeName}`;
            
            if (!groups[key]) {
                groups[key] = {
                    id: r.id,
                    marketplaceOrderId: r.marketplaceOrderId,
                    storeName: storeName,
                    customerName: r.customerName || (associatedOrder ? associatedOrder.customerName : '-'),
                    cargoCode: associatedOrder ? associatedOrder.cargoCode : '-',
                    orderDate: associatedOrder ? associatedOrder.orderDate : null,
                    itemsCount: associatedOrder ? associatedOrder.items.length : 0,
                    returnQuantity: 0,
                    returnDate: r.returnDate,
                    originalRecords: [],
                    groupedItems: []
                };
            }
            
            const group = groups[key];
            group.originalRecords.push(r);
            group.returnQuantity += r.returnQuantity;
            if (new Date(r.returnDate) > new Date(group.returnDate)) {
                group.returnDate = r.returnDate;
            }
            
            const itemKey = `${r.item.productName}::${r.item.color}`;
            let groupedItem = group.groupedItems.find((gi: any) => `${gi.productName}::${gi.color}` === itemKey);
            if (!groupedItem) {
                groupedItem = {
                    productName: r.item.productName,
                    color: r.item.color,
                    sizes: [],
                    barcodes: []
                };
                group.groupedItems.push(groupedItem);
            }
            
            const sizeStr = r.item.productSize || r.item.size || '-';
            if (!groupedItem.sizes.includes(sizeStr)) {
                groupedItem.sizes.push(sizeStr);
            }
            if (r.item.barcode && !groupedItem.barcodes.includes(r.item.barcode)) {
                groupedItem.barcodes.push(r.item.barcode);
            }
        });

        const result = Object.values(groups);

        if (sortBy) {
            result.sort((a: any, b: any) => {
                let comparison = 0;
                switch (sortBy) {
                    case 'date':
                        comparison = new Date(a.returnDate).getTime() - new Date(b.returnDate).getTime();
                        break;
                    case 'orderDate':
                        comparison = new Date(a.orderDate || 0).getTime() - new Date(b.orderDate || 0).getTime();
                        break;
                    case 'orderNumber':
                        comparison = (a.marketplaceOrderId || '').localeCompare(b.marketplaceOrderId || '', 'tr', { numeric: true, sensitivity: 'base' });
                        break;
                    case 'customerName':
                        comparison = (a.customerName || '').localeCompare(b.customerName || '', 'tr', { sensitivity: 'base' });
                        break;
                    case 'sku':
                        const aSku = a.originalRecords[0]?.item.sku || '';
                        const bSku = b.originalRecords[0]?.item.sku || '';
                        comparison = aSku.localeCompare(bSku, 'tr', { numeric: true, sensitivity: 'base' });
                        break;
                    case 'productName':
                        const aName = a.groupedItems[0]?.productName || '';
                        const bName = b.groupedItems[0]?.productName || '';
                        comparison = aName.localeCompare(bName, 'tr', { sensitivity: 'base' });
                        break;
                }
                return sortOrder === 'asc' ? comparison : -comparison;
            });
        } else {
            result.sort((a: any, b: any) => new Date(b.returnDate).getTime() - new Date(a.returnDate).getTime());
        }

        return result;
    };

    // --- ACTIONS ---

    // Stok kontrolü fonksiyonu
    const getStockStatus = (barcode: string): number => {
        if (!barcode) return 0;
        const product = db.products.find(p => p.variants.some(v => v.barcode === barcode));
        if (!product) return 0;
        const variant = product.variants.find(v => v.barcode === barcode);
        if (!variant || !variant.stocks) return 0;

        let total = 0;
        const stockValues = Object.values(variant.stocks);
        for (const qty of stockValues) {
            total += Number(qty) || 0;
        }
        return total;
    };

    const isOrderOutOfStock = (order: Order): boolean => {
        return order.items.some(item => {
            const stock = getStockStatus(item.barcode);
            return item.quantity > stock;
        });
    };

    // Aynı ürün (isim+renk+beden) için farklı barkodlar var mı kontrolü
    const hasConflictingBarcodes = (order: Order): boolean => {
        if (!order.items || order.items.length < 2) return false;

        const groups: { [key: string]: Set<string> } = {};

        order.items.forEach(item => {
            // "ÜrünAdi-Renk-Beden" anahtarı oluştur
            const key = `${item.productName}-${item.color}-${item.size}`.toLowerCase();
            if (!groups[key]) {
                groups[key] = new Set();
            }
            if (item.barcode) {
                groups[key].add(item.barcode);
            }
        });

        // Herhangi bir grupta birden fazla barkod varsa conflict vardır
        return Object.values(groups).some(barcodeSet => barcodeSet.size > 1);
    };

    // Fetch order details from Trendyol API - Tüm bilgileri çek
    const fetchOrderDetailsFromTrendyol = async (order: Order): Promise<Order | null> => {
        if (!db.apiConfigs.length) return null;

        const config = db.apiConfigs.find(c => c.storeName === order.storeName);
        if (!config) return null;

        try {
            const auth = btoa(`${config.apiKey}:${config.apiSecret}`);
            const url = `https://api.trendyol.com/sapigw/suppliers/${config.supplierId}/orders/${order.marketplaceOrderId}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json',
                    'User-Agent': `${config.supplierId} - SelfIntegration`
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`API Error ${response.status}:`, errorText);
                return null;
            }

            const data = await response.json();

            // Build delivery address from API data - Trendyol API format - Tüm olası alanları kontrol et
            let deliveryAddress = '';

            // Öncelik sırası: shipmentAddress > deliveryAddress > address > shipmentPackageHistories
            if (data.shipmentAddress) {
                const addr = data.shipmentAddress;
                deliveryAddress = [
                    addr.address1 || '',
                    addr.address2 || '',
                    addr.district || '',
                    addr.city || '',
                    addr.country || ''
                ].filter(Boolean).join(', ');
            } else if (data.deliveryAddress) {
                deliveryAddress = data.deliveryAddress;
            } else if (data.address) {
                deliveryAddress = data.address;
            } else if (data.shipmentPackageHistories && data.shipmentPackageHistories.length > 0) {
                // Try shipment package histories
                const pkg = data.shipmentPackageHistories[0];
                if (pkg.shipmentAddress) {
                    const addr = pkg.shipmentAddress;
                    deliveryAddress = [
                        addr.address1 || '',
                        addr.address2 || '',
                        addr.district || '',
                        addr.city || '',
                        addr.country || ''
                    ].filter(Boolean).join(', ');
                }
            } else if (data.customerAddress) {
                // Alternatif adres alanı
                const addr = data.customerAddress;
                deliveryAddress = [
                    addr.address1 || '',
                    addr.address2 || '',
                    addr.district || '',
                    addr.city || '',
                    addr.country || ''
                ].filter(Boolean).join(', ');
            }

            // Eğer hala adres yoksa, mevcut adresi koru veya boş bırak
            if (!deliveryAddress && order.deliveryAddress) {
                deliveryAddress = order.deliveryAddress;
            }

            // Update order with fresh marketplace data - Tüm bilgileri Trendyol'dan çek
            const updatedOrder: Order = {
                ...order,
                customerName: `${data.customerFirstName || data.customerName || ''} ${data.customerLastName || ''}`.trim() || order.customerName,
                deliveryAddress: deliveryAddress || undefined, // Boş string yerine undefined
                shipmentPackageId: data.shipmentPackages?.[0]?.id ? String(data.shipmentPackages[0].id) : (data.id ? String(data.id) : order.shipmentPackageId),
                cargoCode: String(
                    data.cargoTrackingNumber ||
                    data.trackingNumber ||
                    data.shipmentPackageHistories?.[0]?.trackingNumber ||
                    data.shipmentTrackingNumber ||
                    order.cargoCode ||
                    '-'
                ),
                cargoCompanyName: resolveCargoCompanyFromTrendyolApi(data) || order.cargoCompanyName,
                countryCode: resolveCountryCodeFromTrendyolApi(data),
                fullData: data,
                // 3 Saatlik zaman kayması düzeltmesi
                orderDate: data.orderDate ? new Date(new Date(data.orderDate).getTime() - (3 * 3600 * 1000)).toISOString() : order.orderDate,
                items: (data.lines || data.items || []).map((line: any) => ({
                    orderItemId: line.orderItemId || line.id, // Trendyol order item ID
                    barcode: line.barcode || line.stockCode || 'NO-BARCODE',
                    productName: line.productName || line.name || 'Ürün adı mevcut değil',
                    sku: line.merchantSku || line.sku || '',
                    // Varyant bilgilerini Trendyol'dan çek - attributes'dan veya merchantSku'dan
                    color: line.attributes?.find((attr: any) =>
                        attr.attributeName === 'Renk' ||
                        attr.attributeName === 'Color' ||
                        attr.attributeName === 'RENK'
                    )?.attributeValue ||
                        line.color ||
                        (line.merchantSku ? line.merchantSku.split('-')[0] : ''),
                    size: line.attributes?.find((attr: any) =>
                        attr.attributeName === 'Beden' ||
                        attr.attributeName === 'Size' ||
                        attr.attributeName === 'BEDEN'
                    )?.attributeValue ||
                        line.size ||
                        (line.quantity ? `${line.quantity} Adet` : ''),
                    quantity: line.quantity || 1,
                    unitPrice: line.price || line.unitPrice || 0,
                    totalPrice: (line.price || line.unitPrice || 0) * (line.quantity || 1)
                }))
            };

            return updatedOrder;
        } catch (error) {
            console.error('Order refresh error:', error);
            return null;
        }
    };

    const handleOrderDetailRefresh = async (order: Order) => {
        // Önce mevcut siparişi göster, sonra güncelle
        setDetailOrder(order);

        const updatedOrder = await fetchOrderDetailsFromTrendyol(order);

        if (updatedOrder) {
            // Update in database
            const updatedOrders = db.orders.map(o => o.id === order.id ? updatedOrder : o);
            updateDB({ ...db, orders: updatedOrders });
            setDetailOrder(updatedOrder);
            setNotification({ type: 'success', message: 'Sipariş detayları pazaryerinden güncellendi.' });
        } else {
            // API'den veri çekilemedi, mevcut siparişi göster - hata mesajı gösterme
            // Sessizce mevcut veriyi göster
        }
    };

    const handleProcessOrders = async () => {
        const orderIdsToProcess = selectedOrders.filter(id => {
            const o = db.orders.find(ord => ord.id === id);
            return o && (o.status === OrderStatus.NEW || o.isSuspended);
        });

        if (selectedOrders.length === 0) {
            setNotification({ type: 'error', message: "İşleme alınacak yeni veya askıda sipariş seçilmedi." });
            return;
        }

        setIsSyncing(true);
        setNotification({ type: 'info', message: `${orderIdsToProcess.length} sipariş güncelleniyor ve işleme alınıyor...` });

        try {
            const updatedOrdersToProcess: Order[] = [];

            // Her siparişi önce Trendyol'dan güncelle ki ID'ler kesin doğru olsun
            for (const id of orderIdsToProcess) {
                const localOrder = db.orders.find(o => o.id === id);
                if (!localOrder) continue;

                const freshOrder = await fetchOrderDetailsFromTrendyol(localOrder);
                if (freshOrder) {
                    updatedOrdersToProcess.push(freshOrder);
                } else {
                    // API'den çekilemezse yerel veriyi kullan (fallback)
                    updatedOrdersToProcess.push(localOrder);
                }
            }

            // Sync to marketplaces
            await syncOrderStatusToMarketplaces(db.apiConfigs, updatedOrdersToProcess, OrderStatus.PROCESSING);

            // Başarılı olursa yerel DB'yi güncelle
            const newOrders = db.orders.map(o => {
                const processed = updatedOrdersToProcess.find(p => p.id === o.id);
                if (processed) {
                    return { ...processed, status: OrderStatus.PROCESSING, isSuspended: o.isSuspended };
                }
                return o;
            });

            updateDB({ ...db, orders: newOrders });

            setNotification({
                type: 'success',
                message: `${updatedOrdersToProcess.length} sipariş başarıyla işleme alındı.`
            });
            setSelectedOrders([]);
        } catch (error) {
            console.error('Marketplace sync error:', error);
            const errorMessage = (error as Error).message;
            setNotification({ type: 'error', message: `Sipariş işleme hatası: ${errorMessage}` });
        } finally {
            setIsSyncing(false);
        }
    };


    const handleDeleteOrder = async (orderId: string) => {
        if (userRole !== UserRole.ADMIN) {
            setNotification({ type: 'error', message: "Sipariş silmek için yönetici yetkisi gerekli." });
            return;
        }

        const order = db.orders.find(o => o.id === orderId);
        if (!order) return;

        const isSuspended = order.isSuspended === true;
        const isCancelled = order.status === OrderStatus.CANCELLED;
        // Stoğu sadece aktif (askıda değil ve iptal edilmemiş) siparişler için geri ekle
        const shouldRestoreStock = !isSuspended && !isCancelled;

        let confirmMsg = `"${order.marketplaceOrderId}" numaralı siparişi silmek istediğinize emin misiniz?\n\nBu işlem geri alınamaz.`;
        if (shouldRestoreStock) {
            confirmMsg += " ve stoklar geri eklenecektir!";
        }

        requestConfirm(confirmMsg, async () => {
            let currentProducts = [...db.products];
            const barcodesToSync: { [key: string]: number } = {};

            // 1. Stoğu geri ekle (Sadece stock-affecting ise)
            if (shouldRestoreStock) {
                for (const item of order.items) {
                    const product = currentProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
                    if (product) {
                        const variant = product.variants.find(v => v.barcode === item.barcode);
                        if (variant) {
                            const whId = Object.keys(variant.stocks)[0] || 'wh1';
                            const currentStock = variant.stocks[whId] || 0;

                            const alreadyReturned = db.returns
                                .filter(r => r.orderId === orderId && r.item.barcode === item.barcode)
                                .reduce((sum, r) => sum + r.returnQuantity, 0);

                            const remainingToRestore = Math.max(0, item.quantity - alreadyReturned);
                            if (remainingToRestore <= 0) continue;

                            const newWhStock = currentStock + remainingToRestore;

                            // Local update with consistency
                            const result = updateLocalStockWithConsistency(currentProducts, product.id, variant.color, variant.size, whId, newWhStock);
                            currentProducts = result.updatedProducts;

                            // TOPLAM stoğu senkronizasyon listesine ekle - ÖNEMLİ: Tüm barkodları ekle
                            const up = currentProducts.find(p => p.id === product.id);
                            if (up) {
                                up.variants.forEach(pv => {
                                    if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                                        barcodesToSync[pv.barcode] = Object.values(pv.stocks).reduce<number>((a, b) => a + (Number(b) || 0), 0);
                                    }
                                });
                            }
                        }
                    }
                }
            }

            // 2. DB'yi Güncelle (Senkronizasyondan ÖNCE yap ki sync güncel veriyi okusun)

            const newOrders = db.orders.map(o => {
                if (o.id === orderId && o.status === OrderStatus.CANCELLED) {
                    return { ...o, isDeleted: true };
                }
                return o;
            }).filter(o => {
                if (o.id === orderId) {
                    return o.status === OrderStatus.CANCELLED;
                }
                return true;
            });
            const newReturns = db.returns.filter(r => r.orderId !== orderId);

            updateDB({
                ...db,
                orders: newOrders,
                returns: newReturns,
                products: currentProducts
            });

            // 3. Stok Senkronizasyonunu Tetikle (TOPLAM STOKLAR)
            if (Object.keys(barcodesToSync).length > 0) {
                const itemsToSync = Object.entries(barcodesToSync).map(([barcode, qty]) => ({ barcode, quantity: qty }));
                await syncBarcodeStockBatchMultiple(
                    db.apiConfigs,
                    itemsToSync,
                    db.settings,
                    (count) => setNotification({ type: 'success', message: `${count} barkod için stok iadesi başladı...` }),
                    () => setNotification({ type: 'success', message: 'Stok iadesi bitti.' })
                );
            }

            setSelectedOrders(selectedOrders.filter(id => id !== orderId));

            let successMessage = 'Sipariş başarıyla silindi.';
            if (isSuspended) {
                successMessage = 'Askıdaki sipariş başarıyla silindi.';
            } else if (isCancelled) {
                successMessage = 'İptal edilmiş sipariş kaydı silindi.';
            } else if (shouldRestoreStock) {
                successMessage = 'Sipariş başarıyla silindi ve stoklar geri eklendi.';
            }

            setNotification({
                type: 'success',
                message: successMessage
            });
        });
    };


    const handleBulkDeleteOrders = async () => {
        if (userRole !== UserRole.ADMIN) {
            setNotification({ type: 'error', message: "Sipariş silmek için yönetici yetkisi gerekli." });
            return;
        }

        if (selectedOrders.length === 0) {
            setNotification({ type: 'error', message: "Silinecek sipariş seçiniz." });
            return;
        }

        // Count suspended, cancelled vs regular orders for messaging
        const selectedOrderObjects = selectedOrders.map(id => db.orders.find(o => o.id === id)).filter(Boolean);
        const stockAffectingOrders = selectedOrderObjects.filter(o => o && !o.isSuspended && o.status !== OrderStatus.CANCELLED);
        const regularCount = stockAffectingOrders.length;

        const confirmMsg = regularCount > 0
            ? `${selectedOrders.length} adet siparişi silmek istediğinize emin misiniz?\n\nBu işlem geri alınamaz ve ${regularCount} adet sipariş için stoklar güncellenecektir!`
            : `${selectedOrders.length} adet seçili (askıda veya iptal) siparişi silmek istediğinize emin misiniz?\n\nBu işlem geri alınamaz.`;

        requestConfirm(confirmMsg, async () => {
            let currentProducts = [...db.products];
            const barcodesToSync: { [key: string]: number } = {};

            selectedOrders.forEach(orderId => {
                const order = db.orders.find(o => o.id === orderId);
                if (!order) return;

                // Sadece aktif (askıda ve iptal DEĞİL) ise stok iadesi yap
                if (!order.isSuspended && order.status !== OrderStatus.CANCELLED) {
                    order.items.forEach(item => {
                        const product = currentProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
                        if (product) {
                            const variant = product.variants.find(v => v.barcode === item.barcode);
                            if (variant) {
                                const whId = Object.keys(variant.stocks)[0] || 'wh1';

                                // Sadece henüz iade edilmemiş miktar kadar stoğa geri ekle
                                const alreadyReturned = db.returns
                                    .filter(r => r.orderId === orderId && r.item.barcode === item.barcode)
                                    .reduce((sum, r) => sum + r.returnQuantity, 0);

                                const remainingToRestore = Math.max(0, item.quantity - alreadyReturned);
                                if (remainingToRestore > 0) {
                                    const currentStock = variant.stocks[whId] || 0;
                                    const newStock = currentStock + remainingToRestore;

                                    const result = updateLocalStockWithConsistency(
                                        currentProducts,
                                        product.id,
                                        variant.color,
                                        variant.size,
                                        whId,
                                        newStock
                                    );
                                    currentProducts = result.updatedProducts;

                                    // Senkronizasyon listesi güncelle - TÜM BARKODLARI EKLE
                                    const up = currentProducts.find(p => p.id === product.id);
                                    if (up) {
                                        up.variants.forEach(pv => {
                                            if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                                                barcodesToSync[pv.barcode] = Object.values(pv.stocks).reduce<number>((a, b) => a + (Number(b) || 0), 0);
                                            }
                                        });
                                    }
                                }
                            }
                        }
                    });
                }
            });

            // 2. DB'yi Güncelle

            updateDB({
                ...db,
                orders: db.orders.map(o => {
                    if (selectedOrders.includes(o.id) && o.status === OrderStatus.CANCELLED) {
                        return { ...o, isDeleted: true };
                    }
                    return o;
                }).filter(o => {
                    if (selectedOrders.includes(o.id)) {
                        return o.status === OrderStatus.CANCELLED;
                    }
                    return true;
                }),
                products: currentProducts
            });

            // Sync
            if (Object.keys(barcodesToSync).length > 0) {
                const itemsToSync = Object.entries(barcodesToSync).map(([barcode, qty]) => ({ barcode, quantity: qty }));
                await syncBarcodeStockBatchMultiple(db.apiConfigs, itemsToSync, db.settings);
            }

            setSelectedOrders([]);

            let successMessage = `${selectedOrders.length} adet sipariş silindi.`;
            if (regularCount > 0) {
                successMessage = `${selectedOrders.length} adet sipariş silindi ve stoklar güncellendi.`;
            } else {
                successMessage = `${selectedOrders.length} adet (askıda/iptal) sipariş kaydı temizlendi.`;
            }

            setNotification({
                type: 'success',
                message: successMessage
            });
        });
    };


    const handleExportOrders = () => {
        const orders = activeTab === 'returned' ? [] : getFilteredOrders();
        if (orders.length === 0 && activeTab !== 'returned') {
            setNotification({ type: 'error', message: "Raporlanacak veri bulunamadı." });
            return;
        }

        let data: any[] = [];
        if (activeTab === 'returned') {
            getGroupedReturns().forEach(r => {
                r.groupedItems.forEach((gi: any) => {
                    const price = r.originalRecords.find((or: any) => or.item.productName === gi.productName)?.item.unitPrice || 0;
                    const qty = r.originalRecords.filter((or: any) => or.item.productName === gi.productName && or.item.color === gi.color).reduce((sum: number, or: any) => sum + or.returnQuantity, 0);
                    data.push({
                        'Mağaza': r.storeName,
                        'Sipariş No': r.marketplaceOrderId,
                        'Müşteri': r.customerName,
                        'Ürün': gi.productName,
                        'SKU': r.originalRecords.find((or: any) => or.item.productName === gi.productName)?.item.sku || '',
                        'Barkod': gi.barcodes.join(', '),
                        'Renk': gi.color,
                        'Beden': gi.sizes.join(', '),
                        'İade Adet': qty,
                        'Birim Fiyat': price,
                        'Toplam Fiyat': price * qty,
                        'Tarih': r.returnDate
                    });
                });
            });
        } else {
            // Her sipariş için her ürün kalemini ayrı satır olarak ekle
            // Filtreleme: Eğer Askıdakiler (suspended) sekmesindeysek, 'Taşıma Durumunda' ve 'Teslim Edildi' olanları kesinlikle hariç tut.
            const filteredForExport = activeTab === 'suspended' 
                ? orders.filter(o => o.status !== OrderStatus.SHIPPING && o.status !== OrderStatus.DELIVERED)
                : orders;

            filteredForExport.forEach(o => {
                o.items.forEach((item, index) => {
                    const config = db.apiConfigs.find(c => c.storeName === o.storeName);
                    const countryCode = getEffectiveOrderCountryCode(o);
                    const countryName = PRIORITY_COUNTRIES.find(c => c.code === countryCode)?.name || countryCode;

                    const orderData: any = {
                        'Mağaza': o.storeName,
                        'Satıcı ID': o.fullData?.supplierId || config?.supplierId || '-',
                        'Sipariş No': o.marketplaceOrderId,
                        'Müşteri': o.customerName,
                        'Teslimat Adresi': o.deliveryAddress || '',
                        'Kargo Firması': o.cargoCompanyName || '-',
                        'Kargo Kodu': o.cargoCode,
                        'Sipariş Tarihi': new Date(o.orderDate).toLocaleString('tr-TR'),
                        ...(o.fullData?.estimatedDeliveryEndDate ? { 'Termin Süresi': new Date(o.fullData.estimatedDeliveryEndDate).toLocaleString('tr-TR') } : {}),
                        'Sipariş Durumu': o.status,
                        'Kalem No': index + 1,
                        'Ürün Adı': item.productName,
                        'SKU': item.sku || '',
                        'Barkod': item.barcode,
                        'Renk': item.color,
                        'Beden': item.productSize || item.size || db.products.find(p => p.variants.some(v => v.barcode === item.barcode))?.variants.find(v => v.barcode === item.barcode)?.size || '-',
                        'Adet': item.quantity,
                        'Birim Fiyat': item.unitPrice.toFixed(2),
                        'Kalem Toplamı': (item.unitPrice * item.quantity).toFixed(2),
                        'Genel Toplam': (item.unitPrice * item.quantity).toFixed(2),
                        'Ülke': countryName,
                        'Yazdırıldı': o.isPrinted ? 'Evet' : 'Hayır',
                        'Askıda': o.isSuspended ? 'Evet' : 'Hayır'
                    };
                    data.push(orderData);
                });
            });
        }

        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, activeTab === 'returned' ? "Iadeler" : "Sipariş Detayları");

        // Sütun genişliklerini ayarla
        const columnWidths = [
            { wch: 15 }, // Mağaza
            { wch: 20 }, // Sipariş No
            { wch: 25 }, // Müşteri
            { wch: 30 }, // Teslimat Adresi
            { wch: 15 }, // Kargo Kodu
            { wch: 12 }, // Sipariş Tarihi
            { wch: 12 }, // Sipariş Durumu
            { wch: 8 },  // Kalem No
            { wch: 40 }, // Ürün Adı
            { wch: 15 }, // SKU
            { wch: 15 }, // Barkod
            { wch: 12 }, // Renk
            { wch: 10 }, // Beden
            { wch: 8 },  // Adet
            { wch: 12 }, // Birim Fiyat
            { wch: 12 }, // Kalem Toplamı
            { wch: 12 }, // Genel Toplam
            { wch: 10 }, // Ülke
            { wch: 10 }, // Yazdırıldı
            { wch: 8 }   // Askıda
        ];
        worksheet['!cols'] = columnWidths;

        XLSX.writeFile(workbook, `Siparis_Raporu_${new Date().toISOString().split('T')[0]}.xlsx`);
    };

    // --- SUSPENDED ORDER CHECK ---
    const handleCheckSuspended = async (order: Order) => {
        // Önce Trendyol'dan güncel sipariş detaylarını çek
        const trendyolOrder = await fetchOrderDetailsFromTrendyol(order);

        let currentProducts = [...db.products];
        let barcodesToSync: { [key: string]: number } = {};
        let allItemsFound = true;

        // Trendyol'dan gelen verileri kullan, yoksa mevcut verileri kullan
        const itemsToProcess = trendyolOrder?.items || order.items;

        const newItems = itemsToProcess.map(item => {
            // Try to find product
            const productIndex = currentProducts.findIndex(p => p.variants.some(v => v.barcode === item.barcode));

            if (productIndex > -1) {
                const product = currentProducts[productIndex];
                const variant = product.variants.find(v => v.barcode === item.barcode);

                if (variant) {
                    // Deduct stock now since we missed it when order first came
                    const whId = Object.keys(variant.stocks)[0] || 'wh1';
                    const currentStock = variant.stocks[whId] || 0;
                    const newStock = Math.max(0, currentStock - item.quantity);

                    const result = updateLocalStockWithConsistency(
                        currentProducts,
                        product.id,
                        variant.color,
                        variant.size,
                        whId,
                        newStock
                    );
                    currentProducts = result.updatedProducts;

                    // ÖNEMLİ: Ürün kartındaki TÜM barkodları senkronizasyon listesine ekle
                    product.variants.forEach(pv => {
                        if (pv.barcode) {
                            const total = Object.values(pv.stocks).reduce<number>((a, b) => a + (Number(b) || 0), 0);
                            barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : Number(total);
                        }
                    });

                    // Kullanıcı isteği: Askıdan işleme alınırken ürün adı Ürün Yönetimi'ndeki adla (product.name) ezilmesin, 
                    // Trendyol'dan geldiği gibi kalsın.
                    return {
                        ...item,
                        productName: trendyolOrder ? item.productName : (item.productName || product.name),
                        color: trendyolOrder ? item.color : (item.color || variant.color),
                        size: trendyolOrder ? item.size : (item.size || variant.size)
                    };
                }
            }
            allItemsFound = false;
            return item;
        });

        if (allItemsFound) {
            // Update Order Status - Askıdan çıkar ve tekrar askıya gitmesini engelle
            const updatedOrderData = trendyolOrder || order;
            const newOrders = db.orders.map(o => {
                if (o.id === order.id) {
                    return {
                        ...updatedOrderData,
                        items: newItems,
                        isSuspended: false,
                        // ÖNEMLİ: Askıdan çıktığını işaretle, tekrar askıya gitmesin
                        wasSuspended: true
                    };
                }
                return o;
            });

            updateDB({ ...db, products: currentProducts, orders: newOrders });

            // Sync if enabled - Barkod bazlı stok gönderimi
            if (Object.keys(barcodesToSync).length > 0) {
                const itemsToSync = Object.entries(barcodesToSync).map(([barcode, qty]) => ({ barcode, quantity: qty }));
                await syncBarcodeStockBatchMultiple(
                    db.apiConfigs,
                    itemsToSync,
                    db.settings,
                    (count) => setNotification({ type: 'success', message: `${count} barkod için askıdan alma stok güncellemesi başladı...` }),
                    () => setNotification({ type: 'success', message: 'Askıdan alma stok güncellemesi bitti.' })
                );
            }

            setNotification({ type: 'success', message: 'Sipariş başarıyla askıdan alındı ve işlendi.' });
        } else {
            setNotification({ type: 'error', message: `Siparişin içindeki bazı ürünlerin barkodları (${order.items.map(i => i.barcode).join(', ')}) hala sistemde bulunamadı.` });
        }
    };

    // --- Return Logic ---
    const handleOpenReturnModal = (order: Order) => {
        setReturnOrderTarget(order);
        setReturnQuantities({});
        setIsReturnModalOpen(true);
    };

    const handleConfirmReturn = async () => {
        if (!returnOrderTarget || isProcessingReturn) return;
        setIsProcessingReturn(true);
        try {
            const itemsToReturn: { item: OrderItem, qty: number }[] = [];
            returnOrderTarget.items.forEach(item => {
                const qty = returnQuantities[item.barcode] || 0;
                if (qty > 0) itemsToReturn.push({ item, qty });
            });

            if (itemsToReturn.length === 0) {
                setNotification({ type: 'error', message: "Lütfen iade edilecek en az bir ürün seçiniz." });
                setIsProcessingReturn(false);
                return;
            }

            let currentProducts = [...db.products];
            const newReturnRecords: ReturnRecord[] = [];
            const barcodesToSync: { [key: string]: number } = {};

            itemsToReturn.forEach(({ item, qty }) => {
                newReturnRecords.push({
                    id: uuid(),
                    orderId: returnOrderTarget.id,
                    marketplaceOrderId: returnOrderTarget.marketplaceOrderId,
                    customerName: returnOrderTarget.customerName,
                    item: item,
                    returnQuantity: qty,
                    returnDate: new Date().toISOString()
                });

                const product = currentProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
                if (product) {
                    const variant = product.variants.find(v => v.barcode === item.barcode);
                    if (variant) {
                        const whId = 'wh1';
                        const currentStock = variant.stocks[whId] || 0;
                        const newStock = currentStock + qty;

                        const result = updateLocalStockWithConsistency(
                            currentProducts,
                            product.id,
                            variant.color,
                            variant.size,
                            whId,
                            newStock
                        );
                        currentProducts = result.updatedProducts;

                        // ÖNEMLİ: Ürün kartındaki TÜM barkodları senkronizasyon listesine ekle (İade durumu)
                        const up = currentProducts.find(p => p.id === product.id);
                        if (up) {
                            up.variants.forEach(pv => {
                                if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                                    const total = Object.values(pv.stocks).reduce<number>((a, b) => a + (Number(b) || 0), 0);
                                    barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : Number(total);
                                }
                            });
                        }
                    }
                }
            });

            const allReturns = [...db.returns, ...newReturnRecords];

            updateDB({
                ...db,
                products: currentProducts,
                returns: allReturns,
                orders: db.orders
            });

            // Sync if enabled - Barkod bazlı stok gönderimi
            if (Object.keys(barcodesToSync).length > 0) {
                const itemsToSync = Object.entries(barcodesToSync).map(([barcode, qty]) => ({ barcode, quantity: qty }));
                await syncBarcodeStockBatchMultiple(
                    db.apiConfigs,
                    itemsToSync,
                    db.settings,
                    (count) => setNotification({ type: 'success', message: `${count} barkod için iade stok güncellemesi başladı...` }),
                    () => setNotification({ type: 'success', message: 'İade stok güncellemesi bitti.' })
                );
            }
            setNotification({ type: 'success', message: `${itemsToReturn.length} kalem ürün iade alındı ve stoklara eklendi.` });
        } catch (error) {
            console.error('Return error:', error);
            setNotification({ type: 'error', message: "İade işlemi sırasında bir hata oluştu." });
        } finally {
            setIsProcessingReturn(false);
            setIsReturnModalOpen(false);
            setReturnOrderTarget(null);
        }
    };

    const handleDeleteReturnRecord = async (ret: any) => {
        const records: ReturnRecord[] = ret.originalRecords ? ret.originalRecords : [ret];
        const recordIds = new Set(records.map(r => r.id));
        const orderIds = new Set(records.map(r => r.orderId));

        requestConfirm('Seçili iade kayıtlarını silmek istediğinize emin misiniz? Bu işlem stokları etkilemez.', () => {
            updateDB(prev => {
                // İade kaydını sil
                const newReturns = prev.returns.filter(r => !recordIds.has(r.id));

                // Eğer sipariş tam iade durumundaysa (İptal Edildi), siparişi de sistemden tamamen sil
                let newOrders = prev.orders;
                orderIds.forEach(orderId => {
                    const associatedOrder = prev.orders.find(o => o.id === orderId);
                    if (associatedOrder && associatedOrder.status === OrderStatus.CANCELLED) {
                        newOrders = newOrders.filter(o => o.id !== orderId);
                    }
                });

                return {
                    ...prev,
                    returns: newReturns,
                    orders: newOrders
                };
            });

            setNotification({ type: 'success', message: 'İade kaydı silindi.' });
        });
    };

    const handleBulkDeleteReturns = async () => {
        requestConfirm('Tüm iade kayıtlarını silmek istediğinize emin misiniz? Bu işlem stokları etkilemez.', () => {
            updateDB(prev => {
                // İptal edilmiş (tam iade) siparişleri de temizle
                const returnedOrderIds = new Set(prev.returns.map(r => r.orderId));
                const newOrders = prev.orders.filter(o => {
                    // Eğer siparişin bir iadesi varsa ve durumu İptal Edildi ise siparişi de sil
                    if (returnedOrderIds.has(o.id) && o.status === OrderStatus.CANCELLED) {
                        return false;
                    }
                    return true;
                });

                return {
                    ...prev,
                    returns: [],
                    orders: newOrders
                };
            });

            setNotification({ type: 'success', message: 'Tüm iade kayıtları silindi.' });
        });
    };

    const handleUndoReturn = async (ret: any) => {
        const records: ReturnRecord[] = ret.originalRecords ? ret.originalRecords : [ret];
        const recordIds = new Set(records.map(r => r.id));
        const orderIds = new Set(records.map(r => r.orderId));

        requestConfirm('Bu iade işlemini geri almak istediğinize emin misiniz? İade edilen ürün stoğu geri düşülecektir.', async () => {
            let currentProducts = [...db.products];
            const barcodesToSync: { [key: string]: number } = {};

            // 1. Stoğu geri düş (İade işlemi stoğu artırmıştı, şimdi azaltacağız)
            records.forEach(returnRecord => {
                const product = currentProducts.find(p => p.variants.some(v => v.barcode === returnRecord.item.barcode));
                if (product) {
                    const variant = product.variants.find(v => v.barcode === returnRecord.item.barcode);
                    if (variant) {
                        const whId = Object.keys(variant.stocks)[0] || 'wh1';
                        const currentStock = variant.stocks[whId] || 0;
                        // İade edilen miktarı geri düşüyoruz
                        const newStock = Math.max(0, currentStock - returnRecord.returnQuantity);

                        const result = updateLocalStockWithConsistency(
                            currentProducts,
                            product.id,
                            variant.color,
                            variant.size,
                            whId,
                            newStock
                        );
                        currentProducts = result.updatedProducts;

                        // Sync listesine ekle - SADECE ilgili varyantın (Renk/Beden) tüm barkodlarını ekle
                        const updatedProduct = currentProducts.find(p => p.id === product.id);
                        if (updatedProduct) {
                            updatedProduct.variants.forEach(pv => {
                                if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                                    const total = Object.values(pv.stocks).reduce((a: number, b: number) => a + Number(b), 0);
                                    barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : Number(total);
                                }
                            });
                        }
                    }
                }
            });

            // 2. İade kaydını sil
            const newReturns = db.returns.filter(r => !recordIds.has(r.id));

            // 3. Sipariş durumunu geri al (Eğer İptal Edildi ise Teslim Edildi'ye çek)
            const updatedOrders = db.orders.map(o => {
                if (orderIds.has(o.id) && o.status === OrderStatus.CANCELLED) {
                    return { ...o, status: OrderStatus.DELIVERED };
                }
                return o;
            });

            updateDB({
                ...db,
                products: currentProducts,
                returns: newReturns,
                orders: updatedOrders
            });

            // 3. Stok Senkronizasyonunu Tetikle
            if (Object.keys(barcodesToSync).length > 0) {
                const itemsToSync = Object.entries(barcodesToSync).map(([barcode, qty]) => ({ barcode, quantity: qty }));
                await syncBarcodeStockBatchMultiple(
                    db.apiConfigs,
                    itemsToSync,
                    db.settings,
                    (count) => setNotification({ type: 'success', message: `${count} barkod için iade silme stok güncellemesi başladı...` }),
                    () => setNotification({ type: 'success', message: 'İade silme stok güncellemesi bitti.' })
                );
            }

            setNotification({ type: 'success', message: 'İade işlemi geri alındı.' });
        });
    };


    // --- PRINT DESIGNER ---
    const handleOpenPrintModal = async () => {
        // Filtreleme uygulanmış görünür seçili siparişleri bul
        const visibleOrderIds = new Set(getFilteredOrders().map(o => o.id));
        const finalSelectedOrders = selectedOrders.filter(id => visibleOrderIds.has(id));

        if (finalSelectedOrders.length === 0) {
            setNotification({ type: 'error', message: "Lütfen yazdırılacak siparişleri seçin (Filtreleme dahilinde olanlar dikkate alinir)." });
            return;
        }

        setIsPrintModalOpen(true);
        detectPrinters();

        // Preview için Trendyol'dan güncel verileri çek
        const ordersToPreview = db.orders.filter(o => finalSelectedOrders.includes(o.id));
        const updatedPreviewOrders = await Promise.all(
            ordersToPreview.map(async (order) => {
                const trendyolOrder = await fetchOrderDetailsFromTrendyol(order);
                return trendyolOrder || order;
            })
        );
        setPreviewOrders(updatedPreviewOrders);
    };


    const detectPrinters = async () => {
        setIsScanningPrinters(true);
        try {
            // @ts-ignore
            if (window.electron && window.electron.getPrinters) {
                // @ts-ignore
                const printers = await window.electron.getPrinters();
                setAvailablePrinters(printers.map((p: any) => p.name));
            } else {
                setAvailablePrinters(["Sistem Varsayılanı"]);
            }
        } catch (error) {
            console.error('Printer detection error:', error);
            setAvailablePrinters(["Sistem Varsayılanı"]);
        } finally {
            setIsScanningPrinters(false);
        }
    };

    const handleElementChange = (id: string, field: keyof PrintElement, value: any) => {
        const newElements = printConfig.elements.map(el => el.id === id ? { ...el, [field]: value } : el);
        setPrintConfig({ ...printConfig, elements: newElements });
    };

    const handleMoveTableColumn = (elementId: string, colIndex: number, direction: 'up' | 'down') => {
        const el = printConfig.elements.find(e => e.id === elementId);
        if (!el || !el.tableColumns) return;

        const newCols = [...el.tableColumns];
        const newIndex = direction === 'up' ? colIndex - 1 : colIndex + 1;

        if (newIndex < 0 || newIndex >= newCols.length) return;

        const temp = newCols[colIndex];
        newCols[colIndex] = newCols[newIndex];
        newCols[newIndex] = temp;

        handleElementChange(elementId, 'tableColumns', newCols);
    };

    const getPageDimensions = () => {
        if (printConfig.paperSize === 'Custom') {
            return { w: printConfig.customWidth || 210, h: printConfig.customHeight || 297 };
        }
        switch (printConfig.paperSize) {
            case 'A4': return { w: 210, h: 297 }; // mm
            case 'A5': return { w: 148, h: 210 };
            case 'Thermal': return { w: 100, h: 150 };
            default: return { w: 210, h: 297 };
        }
    };

    const renderPrintPage = (order: Order, isPreview = false) => {
        const { w, h } = getPageDimensions();
        const style: React.CSSProperties = {
            width: `${w}mm`,
            height: `${h}mm`,
            backgroundColor: 'white',
            position: 'relative',
            overflow: 'hidden',
            boxShadow: isPreview ? '0 0 10px rgba(0,0,0,0.2)' : 'none',
            marginBottom: isPreview ? '20px' : '0',
            border: isPreview ? '1px solid #ddd' : 'none',
            pageBreakAfter: 'always'
        };

        // Preview için previewOrders'dan, yazdırma için direkt order'dan kullan
        const orderToPrint = order;

        return (
            <div style={style} className="print-page flex-shrink-0">
                {printConfig.elements.filter(e => e.visible).map(el => {
                    const elStyle: React.CSSProperties = {
                        position: 'absolute',
                        left: `${el.x}mm`,
                        top: `${el.y}mm`,
                        fontSize: `${el.fontSize}pt`,
                        fontFamily: el.fontFamily || 'Arial, sans-serif',
                        width: el.width ? `${el.width}mm` : 'auto',
                        height: el.height ? `${el.height}mm` : 'auto',
                        fontWeight: 'bold',
                        color: 'black',
                        whiteSpace: 'pre-wrap',
                        textTransform: el.forceUppercase ? 'uppercase' : 'none',
                        transform: `rotate(${el.rotation || 0}deg)`,
                        transformOrigin: 'top left'
                    };

                    let content: React.ReactNode = '';

                    if (el.key === 'items') {
                        const visibleCols = (el.tableColumns || []).filter(c => c.visible);
                        content = (
                            <table className="w-full border-collapse border border-black" style={{ fontFamily: el.fontFamily || 'Arial, sans-serif', fontSize: `${el.fontSize}pt` }}>
                                <thead>
                                    <tr className="bg-gray-200">
                                        {visibleCols.map(col => (
                                            <th key={col.key} className={`border border-black p-1 ${col.key === 'productName' ? 'text-left' : col.key === 'price' ? 'text-right' : 'text-center'}`}>
                                                {col.label}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {orderToPrint.items.map((item, idx) => (
                                        <tr key={idx}>
                                            {visibleCols.map(col => {
                                                if (col.key === 'productName') {
                                                    return <td key={col.key} className="border border-black p-1">{item.productName}</td>;
                                                }
                                                if (col.key === 'color') {
                                                    return <td key={col.key} className="border border-black p-1 text-center">{item.color}</td>;
                                                }
                                                if (col.key === 'size') {
                                                    return <td key={col.key} className="border border-black p-1 text-center">{item.productSize || item.size}</td>;
                                                }
                                                if (col.key === 'quantity') {
                                                    return <td key={col.key} className="border border-black p-1 text-center">{item.quantity}</td>;
                                                }
                                                if (col.key === 'sku') {
                                                    return <td key={col.key} className="border border-black p-1 text-center font-mono" style={{ fontFamily: el.fontFamily || 'monospace' }}>{item.sku || ''}</td>;
                                                }
                                                if (col.key === 'barcode') {
                                                    return <td key={col.key} className="border border-black p-1 text-center font-mono" style={{ fontFamily: el.fontFamily || 'monospace' }}>{item.barcode || ''}</td>;
                                                }
                                                if (col.key === 'price') {
                                                    return <td key={col.key} className="border border-black p-1 text-right">{item.unitPrice.toFixed(2)}</td>;
                                                }
                                                return <td key={col.key} className="border border-black p-1"></td>;
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                                {visibleCols.some(c => c.key === 'price') && (
                                    <tfoot>
                                        <tr className="bg-gray-50">
                                            <td colSpan={visibleCols.length - 1} className="border border-black p-1 text-right font-bold uppercase">Toplam</td>
                                            <td className="border border-black p-1 text-right font-bold">
                                                {orderToPrint.items.reduce((acc, i) => acc + (i.unitPrice * i.quantity), 0).toFixed(2)} ₺
                                            </td>
                                        </tr>
                                    </tfoot>
                                )}
                            </table>
                        );
                    }
                    else if (el.key === 'orderDate') {
                        content = new Date(orderToPrint.orderDate).toLocaleDateString('tr-TR');
                    } else if (el.key === 'cargoCompanyName') {
                        const val = orderToPrint.cargoCompanyName || '';
                        content = <div style={{ fontWeight: 600 }}>{val || '—'}</div>;
                    } else if (el.key === 'countryName') {
                        const cCode = getEffectiveOrderCountryCode(orderToPrint as Order);
                        const cName = PRIORITY_COUNTRIES.find(c => c.code === cCode)?.name || cCode;
                        content = <div style={{ fontWeight: 600 }}>{cName}</div>;
                    } else if (el.key === 'sku') {
                        content = orderToPrint.items.map(i => i.sku).filter(Boolean).join(', ');
                    } else if (el.key.startsWith('customNote')) {
                        content = el.content || '';
                    } else if (el.key === 'totalPrice') {
                        const total = orderToPrint.items.reduce((acc, i) => acc + (i.unitPrice * i.quantity), 0);
                        content = `${total.toFixed(2)} ₺`;
                    } else if (el.isImage) {
                        content = el.content ? <img src={el.content} style={{ width: '100%', height: '100%', objectFit: 'contain' }} alt="Görsel" /> : <div className="border border-dashed border-gray-300 w-full h-full flex items-center justify-center text-[8px] text-gray-400">Görsel Seçilmedi</div>;
                    } else {
                        // @ts-ignore
                        content = orderToPrint[el.key] || '';
                    }

                    if (el.isBarcode) {
                        const barcodeId = `bc-${orderToPrint.id}-${el.id}`;
                        return (
                            <div style={elStyle} key={el.id}>
                                <svg
                                    className="barcode-render"
                                    data-value={content as string}
                                    data-format="CODE128"
                                    data-height={el.barcodeHeight || Math.max(20, el.fontSize * 2.5)}
                                    data-width={Math.max(1, el.fontSize / 8)}
                                    data-displayvalue="true"
                                    data-fontoptions="bold"
                                ></svg>
                            </div>
                        );
                    }

                    return <div key={el.id} style={elStyle}>{content}</div>;
                })}
            </div >
        );
    };

    const handleSavePrintTemplate = () => {
        if (!newTemplateName || newTemplateName.trim() === '') {
             setNotification({ type: 'error', message: 'Lütfen sağ alttaki kutuya bir şablon adı girin.' });
             return;
        }
        
        const newTemplate: SavedPrintTemplate = {
            id: uuidv4(),
            name: newTemplateName.trim(),
            config: printConfig
        };
        
        const updatedTemplates = [...savedTemplates, newTemplate];
        setSavedTemplates(updatedTemplates);
        localStorage.setItem('printTemplates', JSON.stringify(updatedTemplates));
        setNewTemplateName('');
        
        setNotification({
            type: 'success',
            message: 'Yazdırma şablonu kaydedildi.'
        });
    };
    
    const handleDeletePrintTemplate = (id: string) => {
        requestConfirm('Bu şablonu silmek istediğinize emin misiniz?', () => {
            const updated = savedTemplates.filter(t => t.id !== id);
            setSavedTemplates(updated);
            localStorage.setItem('printTemplates', JSON.stringify(updated));
            setNotification({ type: 'success', message: 'Şablon silindi.' });
        });
    };

    const handleResetPrintTemplate = () => {
        requestConfirm('Varsayılan şablona dönmek istediğinize emin misiniz? Mevcut ayarlar kaybolacak.', () => {
            setPrintConfig(DEFAULT_PRINT_CONFIG);
            setNotification({
                type: 'success',
                message: 'Varsayılan şablon yüklendi.'
            });
        });
    };


    const renderPrintPageHTML = async (order: Order): Promise<string> => {
        // Yazdırma öncesi Trendyol'dan güncel verileri çek
        const trendyolOrder = await fetchOrderDetailsFromTrendyol(order);
        const orderToPrint = trendyolOrder || order;

        const { w, h } = getPageDimensions();
        const styleStr = `width: ${w}mm; height: ${h}mm; background-color: white; position: relative; overflow: hidden; page-break-after: always;`;

        let elementsHTML = '';

        printConfig.elements.filter(e => e.visible).forEach(el => {
            const elRotation = el.rotation || 0;
            const transformOrigin = 'top left'; // Elements position origin is top left
            const elStyleStr = `position: absolute; left: ${el.x}mm; top: ${el.y}mm; font-size: ${el.fontSize}pt; font-family: ${el.fontFamily || 'Arial, sans-serif'}; width: ${el.width ? el.width + 'mm' : 'auto'}; height: ${el.height ? el.height + 'mm' : 'auto'}; font-weight: bold; color: black; white-space: pre-wrap; text-transform: ${el.forceUppercase ? 'uppercase' : 'none'}; transform: rotate(${elRotation}deg); transform-origin: ${transformOrigin};`;

            let content = '';

            if (el.key === 'items') {
                const visibleCols = (el.tableColumns || []).filter(c => c.visible);
                let tableHeader = `<thead><tr style="background-color: #e5e7eb;">`;
                visibleCols.forEach(col => {
                    const align = col.key === 'productName' ? 'left' : col.key === 'price' ? 'right' : 'center';
                    tableHeader += `<th class="border border-black p-1 text-${align}">${col.label}</th>`;
                });
                tableHeader += `</tr></thead>`;

                let tableRows = orderToPrint.items.map(item => {
                    let row = '<tr>';
                    visibleCols.forEach(col => {
                        const align = col.key === 'productName' ? 'left' : col.key === 'price' ? 'right' : 'center';
                        let val = '';
                        if (col.key === 'productName') val = item.productName;
                        else if (col.key === 'color') val = item.color;
                        else if (col.key === 'size') val = item.productSize || item.size;
                        else if (col.key === 'quantity') val = String(item.quantity);
                        else if (col.key === 'sku') val = `<span style="font-family: ${el.fontFamily || 'monospace'};">${item.sku || ''}</span>`;
                        else if (col.key === 'barcode') val = `<span style="font-family: ${el.fontFamily || 'monospace'};">${item.barcode || ''}</span>`;
                        else if (col.key === 'price') val = item.unitPrice.toFixed(2);
                        row += `<td class="border border-black p-1 text-${align}">${val}</td>`;
                    });
                    row += '</tr>';
                    return row;
                }).join('');

                const totalPrice = orderToPrint.items.reduce((acc, i) => acc + (i.unitPrice * i.quantity), 0).toFixed(2);
                const showPrice = visibleCols.some(c => c.key === 'price');
                const tfootHTML = showPrice ? `
            <tfoot>
              <tr style="background-color: #f9fafb;">
                <td colspan="${visibleCols.length - 1}" class="border border-black p-1 text-right" style="font-weight: bold; text-transform: uppercase;">Toplam</td>
                <td class="border border-black p-1 text-right" style="font-weight: bold;">${totalPrice} ₺</td>
              </tr>
            </tfoot>
                ` : '';

                content = `<table style="width: 100%; font-size: ${el.fontSize}pt; font-family: ${el.fontFamily || 'Arial, sans-serif'}; border-collapse: collapse; border: 1px solid black;">${tableHeader}<tbody>${tableRows}</tbody>${tfootHTML}</table>`;
            }
            else if (el.key === 'orderDate') {
                content = new Date(orderToPrint.orderDate).toLocaleDateString('tr-TR');
            } else if (el.key === 'cargoCompanyName') {
                const raw = String((orderToPrint as Order).cargoCompanyName || '');
                const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                const val = esc(raw);
                content = `<div style="font-weight:600">${val || '—'}</div>`;
            } else if (el.key === 'countryName') {
                const cCode = getEffectiveOrderCountryCode(orderToPrint as Order);
                const cName = PRIORITY_COUNTRIES.find(c => c.code === cCode)?.name || cCode;
                content = `<div style="font-weight:600">${cName}</div>`;
            } else if (el.key === 'sku') {
                content = orderToPrint.items.map(i => i.sku).filter(Boolean).join(', ');
            } else if (el.key.startsWith('customNote')) {
                content = el.content || '';
            } else if (el.key === 'totalPrice') {
                const total = orderToPrint.items.reduce((acc, i) => acc + (i.unitPrice * i.quantity), 0);
                content = `${total.toFixed(2)} ₺`;
            } else if (el.isImage) {
                content = el.content ? `<img src="${el.content}" style="width: 100%; height: 100%; object-fit: contain;" />` : '';
            } else {
                // @ts-ignore
                const value = orderToPrint[el.key];
                content = value ? String(value) : '';
            }

            if (el.isBarcode && content) {
                const barcodeId = `bc-${orderToPrint.id}-${el.id}`;
                elementsHTML += `<div style="${elStyleStr}" id="${barcodeId}"><svg class="barcode-render" data-value="${String(content)}" data-format="CODE128" data-height="${el.barcodeHeight || Math.max(20, el.fontSize * 2.5)}" data-width="${Math.max(1, el.fontSize / 8)}" data-displayvalue="true" data-fontoptions="bold"></svg></div>`;
            } else {
                elementsHTML += `<div style="${elStyleStr}">${content}</div>`;
            }
        });

        const rotation = printConfig.rotation || 0;
        const innerStyle = `position: absolute; inset: 0; transform: rotate(${rotation}deg); transform-origin: center center;`;
        return `<div style="${styleStr}" class="print-page"><div style="${innerStyle}">${elementsHTML}</div></div>`;
    };

    const triggerPrint = async (mode: 'pdf' | 'print' = 'print') => {
        if (selectedOrders.length === 0) {
            setNotification({ type: 'error', message: 'Lütfen yazdırılacak siparişleri seçin.' });
            return;
        }

        try {
            setIsGeneratingPDF(true);
            setPdfProgress(0);

            let savePath = '';
            if (mode === 'pdf') {
                // Önce klasör seçimi yap
                try {
                    // @ts-ignore
                    if (window.electron && window.electron.selectFolder) {
                        // @ts-ignore
                        savePath = await window.electron.selectFolder();
                        if (!savePath) {
                            setNotification({ type: 'info', message: 'PDF kaydetme iptal edildi.' });
                            return;
                        }
                    }
                } catch (error) {
                    console.error('Folder selection error:', error);
                }
            }

            // Modal'ı hemen kapat
            setIsPrintModalOpen(false);

            // Seçilen siparişleri mevcut sıralamaya göre al
            const filteredOrders = getFilteredOrders();
            const ordersToPrint = filteredOrders.filter(o => selectedOrders.includes(o.id));

            setPdfTotalPages(ordersToPrint.length);
            setPdfProgress(0);

            // Sayfa sayfa PDF oluştur (optimize edilmiş)
            const printPages = [];
            for (let i = 0; i < ordersToPrint.length; i++) {
                const order = ordersToPrint[i];
                const pageHTML = await renderPrintPageHTML(order);
                printPages.push(pageHTML);

                // İlerleme güncelle
                setPdfProgress(i + 1);

                // Daha küçük bekleme - daha hızlı oluşturma
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            const printContent = printPages.join('');
            const { w, h } = getPageDimensions();

            if (mode === 'print') {
                await handleSystemPrint(printContent, w, h);
                setNotification({ type: 'success', message: `${ordersToPrint.length} sipariş yazdırıldı.` });
            } else {
                // PDF oluştur
                const pdfBlob = await createPDFDocument(printContent, w, h);

                // PDF'i seçilen klasöre kaydet
                try {
                    // @ts-ignore
                    if (window.electron && window.electron.savePDF) {
                        const fileName = `siparisler_${new Date().toISOString().split('T')[0]}.pdf`;
                        // @ts-ignore
                        const result = await window.electron.savePDF(pdfBlob, fileName, savePath);
                        if (result.success) {
                            setNotification({ type: 'success', message: `${ordersToPrint.length} sipariş PDF olarak kaydedildi: ${result.filePath}` });
                        } else {
                            throw new Error(result.error);
                        }
                    } else {
                        // Fallback: Browser indirme
                        const url = URL.createObjectURL(pdfBlob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `siparisler_${new Date().toISOString().split('T')[0]}.pdf`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                        setNotification({ type: 'success', message: `${ordersToPrint.length} sipariş PDF olarak indirildi.` });
                    }
                } catch (error) {
                    console.error('PDF kaydetme hatası:', error);
                    setNotification({ type: 'error', message: 'PDF kaydedilemedi.' });
                }
            }

            // Mark orders as printed
            console.log(`[PRINT-DEBUG] Yazdırılacak siparişler:`, selectedOrders);
            const updatedOrders = db.orders.map(o => {
                const shouldMark = selectedOrders.includes(o.id);
                if (shouldMark) {
                    console.log(`[PRINT-DEBUG] Sipariş ${o.marketplaceOrderId} yazdırıldı olarak işaretleniyor`);
                }
                return shouldMark ? { ...o, isPrinted: true } : o;
            });
            updateDB({ ...db, orders: updatedOrders });
            console.log(`[PRINT-DEBUG] Toplam ${updatedOrders.filter(o => o.isPrinted).length} yazdırılmış sipariş var`);
        } catch (error) {
            console.error('Print/PDF generation error:', error);
            setNotification({ type: 'error', message: 'Hata oluştu.' });
        } finally {
            setIsGeneratingPDF(false);
            setPdfProgress(0);
        }
    };

    const handleSystemPrint = async (htmlContent: string, pageWidth: number, pageHeight: number): Promise<void> => {
        return new Promise((resolve, reject) => {
            const iframe = document.createElement('iframe');
            iframe.style.position = 'absolute';
            iframe.style.left = '-9999px';
            iframe.style.width = `${pageWidth}mm`;
            iframe.style.height = `${pageHeight}mm`;
            document.body.appendChild(iframe);

            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!iframeDoc) {
                document.body.removeChild(iframe);
                reject(new Error('iframe oluşturulamadı'));
                return;
            }

            iframeDoc.write(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
            <meta charset="UTF-8">
            <title>Yazdır</title>
            <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
            <style>
                @page { margin: 0; size: ${pageWidth}mm ${pageHeight}mm; }
                * { box-sizing: border-box; }
                body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
                .print-page { width: ${pageWidth}mm; height: ${pageHeight}mm; position: relative; page-break-after: always; overflow: hidden; }
                .border { border: 1px solid black; }
                .p-1 { padding: 4px; }
                .text-left { text-align: left; }
                .text-center { text-align: center; }
                .text-right { text-align: right; }
                .font-mono { font-family: monospace; }
                table { border-collapse: collapse; width: 100%; }
                th, td { border: 1px solid black; padding: 4px; }
            </style>
        </head>
        <body>
            ${htmlContent}
            <script>
                window.onload = () => {
                   JsBarcode(".barcode-render").init();
                   setTimeout(() => {
                       window.print();
                       setTimeout(() => {
                           window.parent.postMessage('print-done', '*');
                       }, 500);
                   }, 500);
                };
            </script>
        </body>
        </html>
      `);
            iframeDoc.close();

            const handleMessage = (event: MessageEvent) => {
                if (event.data === 'print-done') {
                    window.removeEventListener('message', handleMessage);
                    document.body.removeChild(iframe);
                    resolve();
                }
            };
            window.addEventListener('message', handleMessage);
        });
    };

    // Yeni PDF oluşturma fonksiyonu - popup olmadan
    const createPDFDocument = async (htmlContent: string, pageWidth: number, pageHeight: number): Promise<Blob> => {
        return new Promise((resolve, reject) => {
            // Gizli iframe oluştur
            const iframe = document.createElement('iframe');
            iframe.style.position = 'absolute';
            iframe.style.left = '-9999px';
            iframe.style.width = `${pageWidth}mm`;
            iframe.style.height = `${pageHeight}mm`;
            document.body.appendChild(iframe);

            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!iframeDoc) {
                document.body.removeChild(iframe);
                reject(new Error('iframe oluşturulamadı'));
                return;
            }

            iframeDoc.write(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
            <title>Sipariş Yazdırma</title>
            <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
            <style>
                @page { 
                    margin: 0mm; 
                    size: ${pageWidth}mm ${pageHeight}mm;
                }
                * { box-sizing: border-box; }
                body { 
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                    margin: 0; 
                    padding: 0; 
                }
                .print-page { 
                    width: ${pageWidth}mm; 
                    height: ${pageHeight}mm; 
                    position: relative; 
                    background: white; 
                    margin-bottom: 0; 
                    page-break-after: always;
                    break-after: always;
                    overflow: hidden;
                }
                .print-page:last-child {
                    page-break-after: auto;
                    break-after: auto;
                }
                .border { border: 1px solid black; }
                .p-1 { padding: 2px 4px; }
                .text-left { text-align: left; }
                .text-center { text-align: center; }
                .text-right { text-align: right; }
                .font-mono { font-family: 'Courier New', monospace; }
                table { border-collapse: collapse; width: 100%; }
                th, td { border: 1px solid black; padding: 2px 4px; }
            </style>
        </head>
        <body>
            ${htmlContent}
        </body>
        </html>
      `);

            iframeDoc.close();

            // Barkodları render et (daha hızlı)
            setTimeout(() => {
                try {
                    // @ts-ignore
                    if (typeof iframe.contentWindow?.JsBarcode !== 'undefined') {
                        // @ts-ignore
                        iframe.contentWindow.JsBarcode('.barcode-render').init();
                    }

                    // PDF oluştur (daha hızlı canvas ayarları)
                    setTimeout(async () => {
                        try {
                            // @ts-ignore
                            const { jsPDF } = iframe.contentWindow.jspdf;
                            const pdf = new jsPDF({
                                orientation: 'portrait',
                                unit: 'mm',
                                format: [pageWidth, pageHeight]
                            });

                            // @ts-ignore
                            const canvas = await iframe.contentWindow.html2canvas(iframe.body, {
                                scale: 1.5, // Daha düşük scale - daha hızlı
                                useCORS: true,
                                allowTaint: true,
                                backgroundColor: '#ffffff',
                                logging: false, // Logları kapat - daha hızlı
                                removeContainer: false,
                                foreignObjectRendering: false // Daha hızlı render
                            });

                            const imgData = canvas.toDataURL('image/jpeg', 0.8); // JPEG - daha küçük boyut
                            pdf.addImage(imgData, 'JPEG', 0, 0, pageWidth, pageHeight);

                            const pdfBlob = pdf.output('blob');
                            document.body.removeChild(iframe);
                            resolve(pdfBlob);
                        } catch (error) {
                            document.body.removeChild(iframe);
                            reject(error);
                        }
                    }, 500); // Daha kıçük bekleme
                } catch (error) {
                    document.body.removeChild(iframe);
                    reject(error);
                }
            }, 300); // Daha kıçük bekleme
        });
    };

    return (
        <div className="flex flex-col h-full font-sans relative">


            {/* Toolstrip */}
            <div className="bg-gray-100 p-1 border-b border-gray-300 flex justify-between items-center no-print gap-2">
                <div className="flex items-center space-x-2 shrink-0">
                    <div className="flex items-center bg-white border border-gray-300 rounded px-2 py-0.5 w-64">
                        <Filter size={12} className="text-gray-400 mr-1" />
                        <input
                            className="desktop-input border-none w-full p-0 focus:ring-0"
                            placeholder="Sipariş No, Barkod, SKU, Müşteri..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                        {searchTerm && (
                            <button onClick={() => setSearchTerm('')} className="text-gray-400 hover:text-red-500">
                                <Trash size={12} />
                            </button>
                        )}
                    </div>
                </div>

                <div className="flex items-center space-x-2">
                    {/* Status Filter - Moved to Right */}
                    {activeTab === 'active' && (
                        <div className="relative" ref={statusDropdownRef}>
                            <button
                                onClick={() => setStatusFilterOpen(!statusFilterOpen)}
                                className="desktop-btn bg-white"
                            >
                                <Filter size={12} className="mr-1" /> Durum ({selectedStatuses.length}) <ChevronDown size={10} className="ml-1" />
                            </button>
                            {statusFilterOpen && (
                                <div className="absolute top-full right-0 mt-1 bg-white border border-gray-400 shadow-lg p-2 z-[100] w-48 rounded">
                                    {Object.values(OrderStatus).filter(s => s !== OrderStatus.CANCELLED).map(status => (
                                        <label key={status} className="flex items-center gap-2 mb-1 cursor-pointer hover:bg-gray-100 p-1 rounded">
                                            <input
                                                type="checkbox"
                                                checked={selectedStatuses.includes(status)}
                                                onChange={() => toggleStatusFilter(status)}
                                            />
                                            <span className="text-xs">{status}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {activeTab === 'suspended' && (
                        <div className="relative" ref={statusDropdownRef}>
                            <button
                                onClick={() => setStatusFilterOpen(!statusFilterOpen)}
                                className="desktop-btn bg-white"
                            >
                                <Filter size={12} className="mr-1" /> Durum ({suspendedStatuses.length}) <ChevronDown size={10} className="ml-1" />
                            </button>
                            {statusFilterOpen && (
                                <div className="absolute top-full right-0 mt-1 bg-white border border-gray-400 shadow-lg p-2 z-[100] w-48 rounded">
                                    {[OrderStatus.NEW, OrderStatus.PROCESSING, OrderStatus.SHIPPING].map(status => (
                                        <label key={status} className="flex items-center gap-2 mb-1 cursor-pointer hover:bg-gray-100 p-1 rounded">
                                            <input
                                                type="checkbox"
                                                checked={suspendedStatuses.includes(status)}
                                                onChange={() => toggleSuspendedStatusFilter(status)}
                                            />
                                            <span className="text-xs">{status}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    <button onClick={handleUpdateStatuses} disabled={isSyncing} className="desktop-btn desktop-btn-primary border-blue-600">
                        <RefreshCcw className={`w-3 h-3 mr-1 ${isSyncing ? 'animate-spin' : ''}`} /> Manuel Sipariş Çek
                    </button>
                    <button onClick={() => setIsManualOrderModalOpen(true)} className="desktop-btn bg-white border-green-500 text-green-700 hover:bg-green-50">
                        <Plus className="w-3 h-3 mr-1" /> Sipariş Oluştur
                    </button>

                    <div className="w-px h-4 bg-gray-300 mx-1"></div>

                    {/* Zoom Controls */}
                    <div className="flex items-center gap-1 bg-white border border-gray-300 rounded px-1 h-8">
                        <button
                            onClick={() => setZoomLevel(Math.max(50, zoomLevel - 10))}
                            className="p-1 hover:bg-gray-100 rounded text-gray-600"
                            title="Küçült"
                        >
                            <ZoomOut className="w-4 h-4" />
                        </button>
                        <span className="text-xs font-medium w-8 text-center">{zoomLevel}%</span>
                        <button
                            onClick={() => setZoomLevel(Math.min(150, zoomLevel + 10))}
                            className="p-1 hover:bg-gray-100 rounded text-gray-600"
                            title="Büyüt"
                        >
                            <ZoomIn className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="w-px h-4 bg-gray-300 mx-1"></div>

                    <div className="w-px h-4 bg-gray-300 mx-1"></div>

                    {activeTab === 'active' && (
                        <>
                            <div className="w-px h-4 bg-gray-300 mx-1"></div>
                            <button onClick={handleExportOrders} className="desktop-btn text-green-700 border-green-300">
                                <FileSpreadsheet className="w-3 h-3 mr-1" /> Excel
                            </button>
                            <button onClick={handleProcessOrders} disabled={selectedOrders.length === 0} className="desktop-btn disabled:text-gray-400">
                                <Play className="w-3 h-3 mr-1 text-green-600" /> İşleme Al
                            </button>

                            {isGeneratingPDF && (
                                <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded px-3 py-1">
                                    <div className="w-24 bg-gray-200 rounded-full h-2">
                                        <div
                                            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                                            style={{ width: `${(pdfProgress / pdfTotalPages) * 100}%` }}
                                        />
                                    </div>
                                    <span className="text-xs text-blue-700 font-medium">
                                        {pdfProgress}/{pdfTotalPages}
                                    </span>
                                </div>
                            )}
                            <button onClick={handleOpenPrintModal} disabled={selectedOrders.length === 0} className="desktop-btn text-blue-700 border-blue-300">
                                <Printer className="w-3 h-3 mr-1" /> Yazdır
                            </button>
                            {userRole === UserRole.ADMIN && (
                                <>
                                    <div className="w-px h-4 bg-gray-300 mx-1"></div>
                                    <button onClick={handleBulkDeleteOrders} disabled={selectedOrders.length === 0} className="desktop-btn text-red-600 border-red-300 disabled:text-gray-400">
                                        <Trash className="w-3 h-3 mr-1" /> Sil
                                    </button>
                                </>
                            )}
                        </>
                    )}

                    {(activeTab === 'cancelled' || activeTab === 'suspended') && (
                        <>
                            {activeTab === 'suspended' && (
                                <>
                                    <button onClick={handleExportOrders} className="desktop-btn text-green-700 border-green-300">
                                        <FileSpreadsheet className="w-3 h-3 mr-1" /> Excel
                                    </button>
                                    <button onClick={handleProcessOrders} disabled={selectedOrders.length === 0} className="desktop-btn disabled:text-gray-400">
                                        <Play className="w-3 h-3 mr-1 text-green-600" /> İşleme Al
                                    </button>
                                    <button onClick={handleOpenPrintModal} disabled={selectedOrders.length === 0} className="desktop-btn text-blue-700 border-blue-300">
                                        <Printer className="w-3 h-3 mr-1" /> Yazdır
                                    </button>
                                </>
                            )}
                            {userRole === UserRole.ADMIN && (
                                <button onClick={handleBulkDeleteOrders} disabled={selectedOrders.length === 0} className="desktop-btn text-red-600 border-red-300 disabled:text-gray-400">
                                    <Trash className="w-3 h-3 mr-1" /> Sil
                                </button>
                            )}
                        </>
                    )}

                    {activeTab === 'returned' && (
                        <div className="flex items-center gap-2">
                            <button onClick={handleExportOrders} className="desktop-btn text-green-700 border-green-300">
                                <FileSpreadsheet className="w-3 h-3 mr-1" /> Excel
                            </button>
                            <button onClick={handleBulkDeleteReturns} className="desktop-btn text-red-600 border-red-400 bg-red-50 hover:bg-red-100 font-bold">
                                <Trash2 className="w-3 h-3 mr-1" /> Tüm İadeleri Sil
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* DataGrid */}
            < div className="flex-1 bg-white border border-gray-400 datagrid-container no-print" style={{ zoom: `${zoomLevel}%` }}>
                <table className="datagrid">
                    <thead>
                        <tr>
                            {activeTab !== 'returned' && (
                                <th className="w-12 text-center p-0">
                                    <div className="flex items-center justify-center gap-1">
                                        <input
                                            type="checkbox"
                                            title="Tüm Sayfalardaki Filtrelenmiş Siparişleri Seç"
                                            className="w-3 h-3 cursor-pointer"
                                            onChange={(e) => {
                                                if (e.target.checked) setSelectedOrders(getFilteredOrders().map(o => o.id));
                                                else setSelectedOrders([]);
                                            }}
                                        />
                                        <input
                                            type="checkbox"
                                            title="Sadece Bu Sayfadaki Siparişleri Seç"
                                            className="w-3 h-3 cursor-pointer border-blue-400"
                                            onChange={(e) => {
                                                if (e.target.checked) {
                                                    const pageIds = getPaginatedOrders().map(o => o.id);
                                                    setSelectedOrders(prev => Array.from(new Set([...prev, ...pageIds])));
                                                } else {
                                                    const pageIds = getPaginatedOrders().map(o => o.id);
                                                    setSelectedOrders(prev => prev.filter(id => !pageIds.includes(id)));
                                                }
                                            }}
                                        />
                                    </div>
                                </th>
                            )}
                            <th>Durum</th>
                            <th style={{ width: columnWidths['store'] || 'auto' }}>
                                <div className="resizable-header">
                                    <div className="flex flex-col">
                                        <span>Mağaza</span>
                                    </div>
                                    <div className="resizer-handle" onMouseDown={(e) => handleResizeStart(e, 'store', columnWidths['store'] || 120)} />
                                </div>
                            </th>
                            <th style={{ width: columnWidths['orderNo'] || 'auto' }}>
                                <div className="resizable-header">
                                    <div className="flex flex-col">
                                        <span
                                            className="cursor-pointer hover:bg-gray-100 px-1 rounded text-nowrap"
                                            onClick={() => {
                                                if (sortBy === 'orderNumber') {
                                                    setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                                                } else {
                                                    setSortBy('orderNumber');
                                                    setSortOrder('desc');
                                                }
                                            }}
                                        >
                                            Sipariş No {sortBy === 'orderNumber' && (sortOrder === 'asc' ? '↑' : '↓')}
                                        </span>
                                        <input
                                            type="text"
                                            className="text-xs border rounded px-1 py-0.5 mt-1"
                                            placeholder="Ara..."
                                            value={orderSearch}
                                            onChange={(e) => setOrderSearch(e.target.value)}
                                        />
                                    </div>
                                    <div className="resizer-handle" onMouseDown={(e) => handleResizeStart(e, 'orderNo', columnWidths['orderNo'] || 130)} />
                                </div>
                            </th>
                            <th style={{ width: columnWidths['customer'] || 'auto' }}>
                                <div className="resizable-header">
                                    <div className="flex flex-col">
                                        <span
                                            className="cursor-pointer hover:bg-gray-100 px-1 rounded"
                                            onClick={() => {
                                                if (sortBy === 'customerName') {
                                                    setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                                                } else {
                                                    setSortBy('customerName');
                                                    setSortOrder('asc');
                                                }
                                            }}
                                        >
                                            Müşteri {sortBy === 'customerName' && (sortOrder === 'asc' ? '↑' : '↓')}
                                        </span>
                                        <input
                                            type="text"
                                            className="text-xs border rounded px-1 py-0.5 mt-1"
                                            placeholder="Müşteri ara..."
                                            value={customerSearch}
                                            onChange={(e) => setCustomerSearch(e.target.value)}
                                        />
                                    </div>
                                    <div className="resizer-handle" onMouseDown={(e) => handleResizeStart(e, 'customer', columnWidths['customer'] || 150)} />
                                </div>
                            </th>
                            {activeTab === 'returned' ? (
                                <>
                                    <th style={{ width: columnWidths['cargo'] || 'auto' }}>
                                        <div className="resizable-header">
                                            <div className="flex flex-col">
                                                <span>Kargo</span>
                                                <input
                                                    type="text"
                                                    className="text-xs border rounded px-1 py-0.5 mt-1"
                                                    placeholder="Kargo ara..."
                                                    value={cargoSearch}
                                                    onChange={(e) => setCargoSearch(e.target.value)}
                                                />
                                            </div>
                                            <div className="resizer-handle" onMouseDown={(e) => handleResizeStart(e, 'cargo', columnWidths['cargo'] || 100)} />
                                        </div>
                                    </th>
                                    <th>Kalem</th>
                                    <th style={{ width: columnWidths['productName'] || 'auto' }}>
                                        <div className="resizable-header">
                                            <div className="flex flex-col">
                                                <div
                                                    className="cursor-pointer hover:bg-gray-100 px-1 rounded"
                                                    onClick={() => {
                                                        if (sortBy === 'productName') setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                                                        else { setSortBy('productName'); setSortOrder('asc'); }
                                                    }}
                                                >
                                                    Ürün Adı {sortBy === 'productName' && (sortOrder === 'asc' ? '↑' : '↓')}
                                                </div>
                                                <input
                                                    type="text"
                                                    className="text-xs border rounded px-1 py-0.5 mt-1 w-full min-w-0"
                                                    placeholder="Ürün adı ara..."
                                                    value={productNameSearch}
                                                    onChange={(e) => setProductNameSearch(e.target.value)}
                                                />
                                            </div>
                                            <div className="resizer-handle" onMouseDown={(e) => handleResizeStart(e, 'productName', columnWidths['productName'] || 200)} />
                                        </div>
                                    </th>
                                    <th style={{ width: columnWidths['sku'] || 'auto' }}>
                                        <div className="resizable-header">
                                            <div className="flex flex-col">
                                                <div className="flex items-center gap-1 cursor-pointer hover:bg-gray-200 p-1 rounded" onClick={() => handleSort('sku')} title="Satıcı Stok Koduna göre sırala">
                                                    <span>Satıcı Stok Kodu</span>
                                                    {sortBy === 'sku' && (
                                                        sortOrder === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                                                    )}
                                                </div>
                                                <input
                                                    type="text"
                                                    className="text-xs border rounded px-1 py-0.5 mt-1"
                                                    placeholder="SKU ara..."
                                                    value={skuSearch}
                                                    onChange={(e) => setSkuSearch(e.target.value)}
                                                />
                                            </div>
                                            <div className="resizer-handle" onMouseDown={(e) => handleResizeStart(e, 'sku', columnWidths['sku'] || 120)} />
                                        </div>
                                    </th>
                                    <th>
                                        <span
                                            className="cursor-pointer hover:bg-gray-100 px-1 rounded text-nowrap"
                                            onClick={() => {
                                                if (sortBy === 'orderDate') {
                                                    setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                                                } else {
                                                    setSortBy('orderDate');
                                                    setSortOrder('desc');
                                                }
                                            }}
                                        >
                                            Sipariş Tarihi {sortBy === 'orderDate' && (sortOrder === 'asc' ? '↑' : '↓')}
                                        </span>
                                    </th>
                                    <th className="w-8 text-center" title="Stok Durumu">Stok</th>
                                    <th>İade Adeti</th>
                                    <th>
                                        <div className="flex flex-col">
                                            <span
                                                className="cursor-pointer hover:bg-gray-100 px-1 rounded text-nowrap"
                                                onClick={() => {
                                                    if (sortBy === 'date') {
                                                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                                                    } else {
                                                        setSortBy('date');
                                                        setSortOrder('desc');
                                                    }
                                                }}
                                            >
                                                İade Tarihi {sortBy === 'date' && (sortOrder === 'asc' ? '↑' : '↓')}
                                            </span>
                                            <div className="flex gap-1 mt-1">
                                                <input
                                                    type="date"
                                                    className="text-xs border rounded px-1 py-0.5 flex-1"
                                                    placeholder="Başlangıç"
                                                    value={dateFilterStart}
                                                    onChange={(e) => setDateFilterStart(e.target.value)}
                                                    title="Başlangıç Tarihi"
                                                />
                                                <input
                                                    type="date"
                                                    className="text-xs border rounded px-1 py-0.5 flex-1"
                                                    placeholder="Bitiş"
                                                    value={dateFilterEnd}
                                                    onChange={(e) => setDateFilterEnd(e.target.value)}
                                                    title="Bitiş Tarihi"
                                                />
                                            </div>
                                        </div>
                                    </th>
                                    <th className="w-24 text-center">İşlem</th>
                                </>
                            ) : (
                                <>
                                    <th style={{ width: columnWidths['cargo'] || 'auto' }}>
                                        <div className="resizable-header">
                                            <div className="flex flex-col">
                                                <span>Kargo</span>
                                                <input
                                                    type="text"
                                                    className="text-xs border rounded px-1 py-0.5 mt-1"
                                                    placeholder="Kargo ara..."
                                                    value={cargoSearch}
                                                    onChange={(e) => setCargoSearch(e.target.value)}
                                                />
                                            </div>
                                            <div className="resizer-handle" onMouseDown={(e) => handleResizeStart(e, 'cargo', columnWidths['cargo'] || 100)} />
                                        </div>
                                    </th>
                                    <th>Kalem</th>
                                    <th style={{ width: columnWidths['productName'] || 'auto' }}>
                                        <div className="resizable-header">
                                            <div className="flex flex-col">
                                                <div
                                                    className="cursor-pointer hover:bg-gray-100 px-1 rounded"
                                                    onClick={() => {
                                                        if (sortBy === 'productName') setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                                                        else { setSortBy('productName'); setSortOrder('asc'); }
                                                    }}
                                                >
                                                    Ürün Adı {sortBy === 'productName' && (sortOrder === 'asc' ? '↑' : '↓')}
                                                </div>
                                                <input
                                                    type="text"
                                                    className="text-xs border rounded px-1 py-0.5 mt-1 w-full min-w-0"
                                                    placeholder="Ürün adı ara..."
                                                    value={productNameSearch}
                                                    onChange={(e) => setProductNameSearch(e.target.value)}
                                                />
                                            </div>
                                            <div className="resizer-handle" onMouseDown={(e) => handleResizeStart(e, 'productName', columnWidths['productName'] || 200)} />
                                        </div>
                                    </th>
                                    <th style={{ width: columnWidths['sku'] || 'auto' }}>
                                        <div className="resizable-header">
                                            <div className="flex flex-col">
                                                <div className="flex items-center gap-1 cursor-pointer hover:bg-gray-200 p-1 rounded" onClick={() => handleSort('sku')} title="Satıcı Stok Koduna göre sırala">
                                                    <span>Satıcı Stok Kodu</span>
                                                    {sortBy === 'sku' && (
                                                        sortOrder === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                                                    )}
                                                </div>
                                                <input
                                                    type="text"
                                                    className="text-xs border rounded px-1 py-0.5 mt-1"
                                                    placeholder="SKU ara..."
                                                    value={skuSearch}
                                                    onChange={(e) => setSkuSearch(e.target.value)}
                                                />
                                            </div>
                                            <div className="resizer-handle" onMouseDown={(e) => handleResizeStart(e, 'sku', columnWidths['sku'] || 120)} />
                                        </div>
                                    </th>
                                    <th>
                                        <div className="flex flex-col">
                                            <span
                                                className="cursor-pointer hover:bg-gray-100 px-1 rounded"
                                                onClick={() => {
                                                    if (sortBy === 'date') {
                                                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                                                    } else {
                                                        setSortBy('date');
                                                        setSortOrder('desc');
                                                    }
                                                }}
                                            >
                                                Tarih {sortBy === 'date' && (sortOrder === 'asc' ? '↑' : '↓')}
                                            </span>
                                            <div className="flex gap-1 mt-1">
                                                <input
                                                    type="date"
                                                    className="text-xs border rounded px-1 py-0.5 flex-1"
                                                    placeholder="Başlangıç"
                                                    value={dateFilterStart}
                                                    onChange={(e) => setDateFilterStart(e.target.value)}
                                                    title="Başlangıç Tarihi"
                                                />
                                                <input
                                                    type="date"
                                                    className="text-xs border rounded px-1 py-0.5 flex-1"
                                                    placeholder="Bitiş"
                                                    value={dateFilterEnd}
                                                    onChange={(e) => setDateFilterEnd(e.target.value)}
                                                    title="Bitiş Tarihi"
                                                />
                                            </div>
                                        </div>
                                    </th>
                                    <th className="w-8 text-center" title="Stok Durumu">Stok</th>
                                    <th className="w-24 text-center">İşlem</th>
                                </>
                            )}
                        </tr>
                        {activeTab !== 'returned' && (
                            <tr className="bg-gray-50">
                                <th colSpan={activeTab === 'returned' ? 1 : 12}>
                                    <div className="flex items-center justify-between py-2">
                                        <div className="flex items-center gap-4">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-gray-600">Yazdırılanlar:</span>
                                                <select
                                                    className="text-xs border rounded px-2 py-1"
                                                    value={printedFilter}
                                                    onChange={(e) => setPrintedFilter(e.target.value as 'all' | 'printed' | 'unprinted')}
                                                >
                                                    <option value="all">Tümü</option>
                                                    <option value="printed">Yazdırılanlar</option>
                                                    <option value="unprinted">Yazdırılmayanlar</option>
                                                </select>
                                            </div>

                                            <div className="flex items-center gap-2 ml-4">
                                                <span className="text-xs text-gray-600">Mağaza Filtresi:</span>
                                                <div className="relative" ref={storeDropdownRef}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setStoreFilterOpen(!storeFilterOpen)}
                                                        className="text-xs border rounded px-2 py-1 bg-white min-w-[140px] flex justify-between items-center hover:bg-gray-50 transition-colors shadow-sm"
                                                    >
                                                        <span className="truncate max-w-[120px]">
                                                            {selectedStores.length > 0
                                                                ? `${selectedStores.length} Mağaza Seçili`
                                                                : 'Tümü'}
                                                        </span>
                                                        <ChevronDown size={10} className="ml-1 shrink-0" />
                                                    </button>
                                                    {storeFilterOpen && (
                                                        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-400 shadow-xl p-0 z-[100] w-56 max-h-64 overflow-y-auto rounded">
                                                            <div className="p-2 border-b bg-gray-50 flex justify-between items-center sticky top-0">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        const stores = Array.from(new Set(db.orders.map(o => o.storeName)))
                                                                            .filter((s): s is string => Boolean(s))
                                                                            .sort();
                                                                        setSelectedStores(stores);
                                                                    }}
                                                                    className="text-[10px] bg-blue-100 text-blue-600 px-2 py-0.5 rounded hover:bg-blue-200 font-bold"
                                                                >
                                                                    Tümünü Seç
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setSelectedStores([])}
                                                                    className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded hover:bg-gray-200 font-bold"
                                                                >
                                                                    Temizle
                                                                </button>
                                                            </div>
                                                            <div className="p-1">
                                                                {Array.from(new Set(db.orders.map(o => o.storeName)))
                                                                    .filter((s): s is string => Boolean(s))
                                                                    .sort()
                                                                    .map(storeName => (
                                                                        <label
                                                                            key={storeName}
                                                                            className="flex items-center gap-2 p-1.5 hover:bg-blue-50 rounded cursor-pointer"
                                                                        >
                                                                            <input
                                                                                type="checkbox"
                                                                                className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600"
                                                                                checked={selectedStores.includes(storeName)}
                                                                                onChange={() => toggleStoreFilter(storeName)}
                                                                            />
                                                                            <span className={`text-[11px] ${selectedStores.includes(storeName) ? 'text-blue-700 font-bold' : 'text-gray-700'}`}>
                                                                                {storeName}
                                                                            </span>
                                                                        </label>
                                                                    ))}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 ml-4">
                                                <span className="text-xs text-gray-600">Ülke Filtresi:</span>
                                                <div className="relative" ref={countryDropdownRef}>
                                                    <button
                                                        onClick={() => setCountryFilterOpen(!countryFilterOpen)}
                                                        className="text-xs border rounded px-2 py-1 bg-white min-w-[120px] flex justify-between items-center hover:bg-gray-50 transition-colors shadow-sm"
                                                    >
                                                        <span className="truncate max-w-[100px]">
                                                            {selectedCountries.length > 0
                                                                ? `${selectedCountries.length} Ülke Seçili`
                                                                : 'Tümü'
                                                            }
                                                        </span>
                                                        <ChevronDown size={10} className="ml-1 shrink-0" />
                                                    </button>
                                                    {countryFilterOpen && (
                                                        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-400 shadow-xl p-0 z-[100] w-56 rounded overflow-hidden">
                                                            <div className="p-2 border-b bg-gray-50 flex justify-between items-center">
                                                                <button
                                                                    onClick={() => {
                                                                        const allCodes = Array.from(new Set([
                                                                            ...PRIORITY_COUNTRIES.map(c => c.code),
                                                                            ...db.orders.map(o => getEffectiveOrderCountryCode(o))
                                                                        ]));
                                                                        setSelectedCountries(allCodes);
                                                                    }}
                                                                    className="text-[10px] bg-blue-100 text-blue-600 px-2 py-0.5 rounded hover:bg-blue-200 font-bold"
                                                                >
                                                                    Tümünü Seç
                                                                </button>
                                                                <button
                                                                    onClick={() => setSelectedCountries([])}
                                                                    className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded hover:bg-gray-200 font-bold"
                                                                >
                                                                    Temizle
                                                                </button>
                                                            </div>
                                                            <div className="max-h-64 overflow-y-auto p-1 custom-scrollbar">
                                                                {/* Priority Countries */}
                                                                {PRIORITY_COUNTRIES.map(country => (
                                                                    <label key={country.code} className="flex items-center gap-2 p-1.5 hover:bg-blue-50 rounded cursor-pointer transition-colors group">
                                                                        <input
                                                                            type="checkbox"
                                                                            className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                                            checked={selectedCountries.includes(country.code)}
                                                                            onChange={() => toggleCountryFilter(country.code)}
                                                                        />
                                                                        <span className={`text-[11px] ${selectedCountries.includes(country.code) ? 'text-blue-700 font-bold' : 'text-gray-700'}`}>
                                                                            {country.name}
                                                                        </span>
                                                                        {country.code === 'TR' && <span className="ml-auto text-[9px] bg-gray-100 text-gray-400 px-1 rounded">Yerel</span>}
                                                                    </label>
                                                                ))}

                                                                {/* Other Countries from DB */}
                                                                {(() => {
                                                                    const dbCountryCodes = Array.from(new Set(db.orders
                                                                        .map(o => getEffectiveOrderCountryCode(o).toUpperCase())
                                                                        .filter(c => c && c !== 'TR' && !PRIORITY_COUNTRIES.some(p => p.code === c))
                                                                    )).sort() as string[];

                                                                    if (dbCountryCodes.length > 0) {
                                                                        return (
                                                                            <>
                                                                                <div className="h-px bg-gray-200 my-1 mx-2" />
                                                                                {dbCountryCodes.map((code: string) => (
                                                                                    <label key={code} className="flex items-center gap-2 p-1.5 hover:bg-blue-50 rounded cursor-pointer transition-colors group">
                                                                                        <input
                                                                                            type="checkbox"
                                                                                            className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                                                            checked={selectedCountries.includes(code)}
                                                                                            onChange={() => toggleCountryFilter(code)}
                                                                                        />
                                                                                        <span className={`text-[11px] ${selectedCountries.includes(code) ? 'text-blue-700 font-bold' : 'text-gray-700'}`}>
                                                                                            {code}
                                                                                        </span>
                                                                                    </label>
                                                                                ))}
                                                                            </>
                                                                        );
                                                                    }
                                                                    return null;
                                                                })()}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                        <button
                                            onClick={handleClearFilters}
                                            className="text-xs bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600"
                                        >
                                            Filtreyi Temizle
                                        </button>
                                    </div>
                                </th>
                            </tr>
                        )}
                    </thead>
                    <tbody>
                        {/* Standard Orders List */}
                        {activeTab !== 'returned' && getPaginatedOrders().map(order => (
                            <tr
                                key={order.id}
                                className={`
                                    ${selectedOrders.includes(order.id) ? 'bg-blue-50' : ''} 
                                    ${hasConflictingBarcodes(order) ? 'bg-indigo-100' : ''}
                                `}
                                onDoubleClick={async () => {
                                    // First show loading state
                                    setDetailOrder(order);
                                    // Then fetch fresh data from marketplace
                                    await handleOrderDetailRefresh(order);
                                }}
                            >
                                <td className="text-center">
                                    <input type="checkbox" checked={selectedOrders.includes(order.id)} onChange={(e) => {
                                        if (e.target.checked) setSelectedOrders([...selectedOrders, order.id]);
                                        else setSelectedOrders(selectedOrders.filter(id => id !== order.id));
                                    }} />
                                </td>
                                <td>
                                    <div className="flex flex-col gap-1">
                                        <span>{order.status}</span>
                                        {(() => {
                                            if (!isInternationalOrder(order)) return null;
                                            const cCode = getEffectiveOrderCountryCode(order);
                                            const countryName = getCountryName(cCode);
                                            if (!countryName) return null;
                                            return (
                                                <span className="bg-orange-100 text-orange-700 text-[10px] px-1 py-0.5 rounded font-bold w-fit">
                                                    {countryName}
                                                </span>
                                            );
                                        })()}
                                    </div>
                                </td>
                                <td>{order.storeName}</td>
                                <td>{order.marketplaceOrderId}</td>
                                <td>{order.customerName}</td>
                                <td>{order.cargoCode}</td>
                                <td className="text-xs">{order.items.length} Kalem</td>
                                <td className="text-[10px] truncate max-w-0" title={order.items[0]?.productName || '-'}>
                                    <div className="flex flex-col">
                                        <span>{order.items[0]?.productName || '-'}</span>
                                        {order.items[0]?.productSize && (
                                            <span className="text-blue-600 font-bold">Beden: {order.items[0].productSize}</span>
                                        )}
                                    </div>
                                </td>
                                <td className="text-xs font-mono">{order.items[0]?.sku || '-'}</td>
                                <td className="text-xs">{safeFormatDate(order.orderDate)}</td>
                                <td className="text-center">
                                    {isOrderOutOfStock(order) && (
                                        <div className="group relative inline-block">
                                            <AlertTriangle className="text-red-600 w-5 h-5 mx-auto" />
                                            <div className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 bg-red-600 text-white text-xs p-1 rounded whitespace-nowrap z-50 mb-1">
                                                Stok Yetersiz!
                                            </div>
                                        </div>
                                    )}
                                </td>
                                <td className="text-center">
                                    <div className="flex gap-1 justify-center">
                                        {activeTab === 'active' && (order.status === OrderStatus.SHIPPING || order.status === OrderStatus.DELIVERED) && (
                                            <button
                                                onClick={() => handleOpenReturnModal(order)}
                                                className="text-purple-600 hover:bg-purple-100 p-1 rounded border border-transparent hover:border-purple-200"
                                                title="İade Al"
                                            >
                                                <RotateCcw size={14} />
                                            </button>
                                        )}
                                        {/* Kontrol Et butonu kullanıcı isteğiyle kaldırıldı */}
                                        {userRole === UserRole.ADMIN && (
                                            <button
                                                onClick={() => handleDeleteOrder(order.id)}
                                                className="text-red-600 hover:bg-red-100 p-1 rounded border border-transparent hover:border-red-200"
                                                title="Siparişi Sil"
                                            >
                                                <Trash size={14} />
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}

                        {/* Returned Items List */}
                        {activeTab === 'returned' && getPaginatedOrders().map((ret: any) => {
                            const associatedOrder = db.orders.find(o => o.id === ret.originalRecords[0]?.orderId || o.marketplaceOrderId === ret.marketplaceOrderId);
                            return (
                                <tr
                                    key={ret.id}
                                    className="hover:bg-purple-50/50 cursor-pointer transition-colors"
                                    onDoubleClick={async () => {
                                        if (associatedOrder) {
                                            setDetailOrder(associatedOrder);
                                            await handleOrderDetailRefresh(associatedOrder);
                                        } else {
                                            const mockOrder: any = {
                                                id: ret.id,
                                                marketplaceOrderId: ret.marketplaceOrderId,
                                                storeName: ret.storeName,
                                                status: 'İade Alındı',
                                                customerName: ret.customerName,
                                                cargoCode: ret.cargoCode || '-',
                                                orderDate: ret.orderDate || new Date().toISOString(),
                                                items: ret.originalRecords.map((rec: any) => rec.item)
                                            };
                                            setDetailOrder(mockOrder);
                                        }
                                    }}
                                >
                                    <td><span className="bg-purple-100 text-purple-800 px-1 text-[10px] rounded font-bold">İADE</span></td>
                                    <td>{ret.storeName}</td>
                                    <td>{ret.marketplaceOrderId}</td>
                                    <td>{ret.customerName}</td>
                                    <td>{ret.cargoCode || '-'}</td>
                                    <td className="text-xs">{ret.itemsCount || 0} Kalem</td>
                                    <td className="text-[10px] truncate max-w-0" title={ret.groupedItems.map((gi: any) => gi.productName).join(', ')}>
                                        <div className="flex flex-col">
                                            <span>{ret.groupedItems[0]?.productName || '-'}</span>
                                            {ret.groupedItems[0]?.sizes && ret.groupedItems[0].sizes.length > 0 && (
                                                <span className="text-blue-600 font-bold">Beden: {ret.groupedItems[0].sizes.join(', ')}</span>
                                            )}
                                            {ret.groupedItems.length > 1 && (
                                                <span className="text-purple-600 font-semibold text-[9px] mt-0.5">
                                                    (+{ret.groupedItems.length - 1} farklı ürün daha)
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="text-xs font-mono">
                                        {ret.originalRecords.map((rec: any, idx: number) => (
                                            <div key={idx}>{rec.item.sku || '-'}</div>
                                        ))}
                                    </td>
                                    <td className="text-xs">{ret.orderDate ? safeFormatDate(ret.orderDate) : '-'}</td>
                                    <td className="text-center">
                                        {associatedOrder && isOrderOutOfStock(associatedOrder) && (
                                            <div className="group relative inline-block">
                                                <AlertTriangle className="text-red-600 w-5 h-5 mx-auto" />
                                                <div className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 bg-red-600 text-white text-xs p-1 rounded whitespace-nowrap z-50 mb-1">
                                                    Stok Yetersiz!
                                                </div>
                                            </div>
                                        )}
                                    </td>
                                    <td className="text-center font-bold text-red-600">{ret.returnQuantity}</td>
                                    <td className="text-xs">{safeFormatDate(ret.returnDate, true)}</td>
                                    <td className="text-center">
                                        <div className="flex gap-1 justify-center">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleDeleteReturnRecord(ret); }}
                                                className="text-red-500 hover:bg-red-50 p-1 rounded transition-colors"
                                                title="İade Kaydını Sil (Stok Etkilemez)"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleUndoReturn(ret); }}
                                                className="text-orange-500 hover:bg-orange-50 p-1 rounded transition-colors"
                                                title="İadeyi Geri Al (Stoktan Düşer)"
                                            >
                                                <RotateCcw size={14} />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}

                        {activeTab === 'returned' && getPaginatedOrders().length === 0 && (
                            <tr><td colSpan={13} className="text-center text-gray-500 p-4">İade kaydı bulunamadı.</td></tr>
                        )}
                    </tbody>
                </table>

                {/* Pagination Controls */}
                {
                    (activeTab === 'active' || activeTab === 'returned' || activeTab === 'suspended' || activeTab === 'cancelled') && (
                        <div className="flex items-center justify-between p-3 border-t bg-gray-50">
                            <div className="flex items-center gap-2">
                                <span className="text-sm text-gray-600">
                                    {(activeTab === 'returned' ? getGroupedReturns() : getFilteredOrders()).length} siparişden {(currentPage - 1) * itemsPerPage + 1} - {Math.min(currentPage * itemsPerPage, (activeTab === 'returned' ? getGroupedReturns() : getFilteredOrders()).length)} arası gösteriliyor
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <select
                                    className="text-sm border rounded px-2 py-1"
                                    value={itemsPerPage}
                                    onChange={(e) => {
                                        setItemsPerPage(Number(e.target.value));
                                        setCurrentPage(1);
                                    }}
                                >
                                    <option value={25}>25</option>
                                    <option value={50}>50</option>
                                    <option value={100}>100</option>
                                    <option value={200}>200</option>
                                </select>

                                <button
                                    className="px-2 py-1 text-sm border rounded hover:bg-gray-100 disabled:opacity-50"
                                    onClick={() => setCurrentPage(1)}
                                    disabled={currentPage === 1}
                                >
                                    İlk
                                </button>
                                <button
                                    className="px-2 py-1 text-sm border rounded hover:bg-gray-100 disabled:opacity-50"
                                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                                    disabled={currentPage === 1}
                                >
                                    Önceki
                                </button>
                                <span className="text-sm font-medium px-2">
                                    Sayfa {currentPage} / {getTotalPages()}
                                </span>
                                <button
                                    className="px-2 py-1 text-sm border rounded hover:bg-gray-100 disabled:opacity-50"
                                    onClick={() => setCurrentPage(prev => Math.min(getTotalPages(), prev + 1))}
                                    disabled={currentPage === getTotalPages()}
                                >
                                    Sonraki
                                </button>
                                <button
                                    className="px-2 py-1 text-sm border rounded hover:bg-gray-100 disabled:opacity-50"
                                    onClick={() => setCurrentPage(getTotalPages())}
                                    disabled={currentPage === getTotalPages()}
                                >
                                    Son
                                </button>
                            </div>
                        </div>
                    )
                }
            </div >

            {/* --- RETURN MODAL --- */}
            {
                isReturnModalOpen && returnOrderTarget && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110] backdrop-blur-sm no-print">
                        <div className="bg-white border border-gray-400 shadow-xl w-[600px] flex flex-col font-sans rounded">
                            <div className="h-10 bg-orange-100 border-b border-orange-300 flex justify-between items-center px-4 rounded-t">
                                <div className="font-bold flex items-center gap-2 text-orange-800 text-sm">
                                    <RotateCcw size={16} />
                                    İade Al - {returnOrderTarget.marketplaceOrderId}
                                </div>
                                <button onClick={() => { setIsReturnModalOpen(false); setReturnOrderTarget(null); }} className="hover:bg-red-500 hover:text-white px-2 rounded transition-colors">✕</button>
                            </div>
                            <div className="p-4 overflow-auto max-h-[60vh] bg-gray-50">
                                <div className="text-xs text-blue-700 bg-blue-50 p-2 rounded mb-4 border border-blue-100">
                                    İade edilen ürünler stoğa geri eklenecek ve pazaryeri stokları güncellenecektir.
                                </div>
                                <table className="w-full text-sm border-collapse bg-white border border-gray-200 shadow-sm rounded overflow-hidden">
                                    <thead>
                                        <tr className="bg-gray-100 text-gray-700">
                                            <th className="p-2 border-b border-gray-200 text-left">Ürün</th>
                                            <th className="p-2 border-b border-gray-200 text-center w-20">Sipariş</th>
                                            <th className="p-2 border-b border-gray-200 text-center w-28">İade Adedi</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {returnOrderTarget.items.map((item, idx) => {
                                            const alreadyReturned = db.returns
                                                .filter(r => r.orderId === returnOrderTarget.id && r.item.barcode === item.barcode)
                                                .reduce((sum, r) => sum + r.returnQuantity, 0);
                                            const remaining = item.quantity - alreadyReturned;

                                            if (remaining <= 0) return null;

                                            return (
                                                <tr key={idx} className="hover:bg-orange-50/30 transition-colors border-b border-gray-100 last:border-0 text-xs">
                                                    <td className="p-2">
                                                        <div className="font-semibold text-gray-800 line-clamp-1">{item.productName}</div>
                                                        <div className="text-[10px] text-gray-500 font-mono mt-0.5">{item.barcode} | {item.color} - {item.size}</div>
                                                    </td>
                                                    <td className="p-2 text-center font-bold text-gray-600">
                                                        {item.quantity}
                                                        {alreadyReturned > 0 && <span className="text-orange-600 block text-[10px]">(İade: {alreadyReturned})</span>}
                                                    </td>
                                                    <td className="p-2 flex justify-center">
                                                        <div className="flex items-center border border-orange-200 rounded overflow-hidden h-7">
                                                            <button
                                                                onClick={() => {
                                                                    const current = returnQuantities[item.barcode] || 0;
                                                                    setReturnQuantities({ ...returnQuantities, [item.barcode]: Math.max(0, current - 1) });
                                                                }}
                                                                className="px-2 bg-orange-50 hover:bg-orange-100 text-orange-700 font-bold border-r border-orange-200"
                                                            >
                                                                -
                                                            </button>
                                                            <input
                                                                type="number"
                                                                min="0"
                                                                max={remaining}
                                                                className="w-10 text-center focus:outline-none focus:ring-1 focus:ring-orange-300 font-bold text-orange-800"
                                                                value={returnQuantities[item.barcode] || 0}
                                                                onChange={(e) => {
                                                                    const val = Math.min(remaining, Math.max(0, parseInt(e.target.value) || 0));
                                                                    setReturnQuantities({ ...returnQuantities, [item.barcode]: val });
                                                                }}
                                                            />
                                                            <button
                                                                onClick={() => {
                                                                    const current = returnQuantities[item.barcode] || 0;
                                                                    setReturnQuantities({ ...returnQuantities, [item.barcode]: Math.min(remaining, current + 1) });
                                                                }}
                                                                className="px-2 bg-orange-50 hover:bg-orange-100 text-orange-700 font-bold border-l border-orange-200"
                                                            >
                                                                +
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                            <div className="p-3 border-t bg-white flex justify-end gap-3 rounded-b">
                                <button
                                    onClick={() => { setIsReturnModalOpen(false); setReturnOrderTarget(null); }}
                                    className="px-6 py-1.5 border border-gray-300 rounded hover:bg-gray-50 text-gray-700 text-sm transition-all"
                                >
                                    Vazgeç
                                </button>
                                <button
                                    onClick={handleConfirmReturn}
                                    disabled={isProcessingReturn}
                                    className={`px-8 py-1.5 ${isProcessingReturn ? 'bg-gray-400' : 'bg-orange-600 hover:bg-orange-700'} text-white rounded text-sm font-bold flex items-center gap-2 shadow-lg shadow-orange-100 transition-all active:scale-95`}
                                >
                                    <RotateCcw size={16} className={isProcessingReturn ? 'animate-spin' : ''} />
                                    {isProcessingReturn ? 'İşleniyor...' : 'İadeyi Onayla'}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* --- ORDER DETAIL MODAL (DOUBLE CLICK) --- */}
            {
                detailOrder && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] backdrop-blur-sm no-print">
                        <div className="bg-white border border-gray-400 shadow-xl w-[700px] flex flex-col font-sans rounded">
                            <div className="h-10 bg-gray-100 border-b border-gray-300 flex justify-between items-center px-4">
                                <div className="font-bold flex items-center gap-2 text-blue-800">
                                    <FileText size={18} />
                                    Sipariş Detayı -
                                    <span
                                        className="cursor-pointer hover:bg-blue-100 px-2 py-1 rounded font-mono select-text"
                                        onClick={() => {
                                            navigator.clipboard.writeText(detailOrder.marketplaceOrderId);
                                            setNotification({ type: 'success', message: 'Sipariş numarası kopyalandı!' });
                                        }}
                                        title="Tıklayarak kopyala"
                                    >
                                        {detailOrder.marketplaceOrderId}
                                    </span>
                                </div>
                                <button onClick={() => setDetailOrder(null)} className="hover:bg-red-500 hover:text-white px-2 rounded">✕</button>
                            </div>

                            <div className="p-4 flex-1 overflow-auto max-h-[75vh] bg-gray-50 text-sm">
                                {/* Header Info */}
                                <div className="grid grid-cols-2 gap-4 mb-4">
                                    <div className="bg-white p-3 border rounded shadow-sm">
                                        <h4 className="font-bold border-b pb-1 mb-2 text-gray-700">Müşteri Bilgileri</h4>
                                        <p><strong>Ad Soyad:</strong> {detailOrder.customerName}</p>
                                        <p><strong>Telefon:</strong> {detailOrder.customerPhone || 'Telefon bilgisi yok'}</p>
                                        <p><strong>Teslimat Adresi:</strong> {detailOrder.deliveryAddress || 'Adres bilgisi yok'}</p>
                                    </div>
                                    <div className="bg-white p-3 border rounded shadow-sm">
                                        <h4 className="font-bold border-b pb-1 mb-2 text-gray-700">Sipariş Bilgileri</h4>
                                        <div className="space-y-1 text-sm text-gray-700">
                                            <p><strong>Mağaza:</strong> {detailOrder.storeName}</p>
                                            <p><strong>Sipariş No:</strong> {detailOrder.marketplaceOrderId || '-'}</p>
                                            <p><strong>Tarih:</strong> {safeFormatDate(detailOrder.orderDate, true)}</p>
                                            <p><strong>Durum:</strong> <span className="font-semibold text-blue-600">{detailOrder.status}</span></p>
                                            <p><strong>Kargo Kodu:</strong> {detailOrder.cargoCode}</p>
                                            <p><strong>Kargo Firması:</strong> {detailOrder.cargoCompanyName || '—'}</p>
                                            <p><strong>Ülke:</strong> {getEffectiveOrderCountryCode(detailOrder)}</p>
                                        </div>
                                    </div>
                                </div>

                                {/* Items Table - Move outside the grid for better width */}
                                <div className="flex-1 overflow-auto p-4">
                                    <div className="bg-white border rounded shadow-sm overflow-hidden mb-4">
                                        <table className="w-full text-left border-collapse">
                                            <thead>
                                                <tr className="bg-gray-200 text-xs text-gray-700">
                                                    <th className="p-2 border-b">Ürün Adı</th>
                                                    <th className="p-2 border-b">SKU / Barkod</th>
                                                    <th className="p-2 border-b">Renk / Beden</th>
                                                    <th className="p-2 border-b text-center">Adet</th>
                                                    <th className="p-2 border-b text-right">Birim Fiyat</th>
                                                    <th className="p-2 border-b text-right">Toplam</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {detailOrder.items.map((item, idx) => {
                                                    // Filter out items that have already been returned
                                                    const totalReturned = db.returns
                                                        .filter(r => r.orderId === detailOrder.id && r.item.barcode === item.barcode)
                                                        .reduce((acc, r) => acc + r.returnQuantity, 0);

                                                    const remainingQty = item.quantity - totalReturned;
                                                    // Hide fully returned items only when not on returned tab
                                                    if (activeTab !== 'returned' && remainingQty <= 0) return null;

                                                    const currentStock = getStockStatus(item.barcode);
                                                    const qty = activeTab === 'returned' ? item.quantity : remainingQty;
                                                    const isOutOfStock = qty > currentStock;

                                                    return (
                                                        <tr key={idx} className={`border-b last:border-0 ${isOutOfStock ? 'bg-red-100' : 'hover:bg-gray-50'}`}>
                                                            <td className="p-2">{item.productName}</td>
                                                            <td className="p-2 text-xs text-gray-600 font-mono select-text">
                                                                {item.sku} <br /> {item.barcode}
                                                            </td>
                                                            <td className="p-2">
                                                                {item.color}
                                                                {item.productSize && (
                                                                    <span className="ml-1 text-blue-600 font-bold">({item.productSize})</span>
                                                                )}
                                                            </td>
                                                            <td className="p-2 text-center font-bold">
                                                                {qty}
                                                                {activeTab === 'returned' && totalReturned > 0 && (
                                                                    <span className="text-red-600 block text-[10px] font-semibold">(İade: {totalReturned})</span>
                                                                )}
                                                            </td>
                                                            <td className="p-2 text-right">{item.unitPrice.toFixed(2)} ₺</td>
                                                            <td className="p-2 text-right font-bold">{(item.unitPrice * qty).toFixed(2)} ₺</td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                            <tfoot className="bg-gray-100">
                                                <tr>
                                                    <td colSpan={5} className="p-2 text-right font-bold text-gray-700">GENEL TOPLAM:</td>
                                                    <td className="p-2 text-right font-bold text-lg text-green-700">
                                                        {detailOrder.items.reduce((acc, i) => {
                                                            const returned = db.returns
                                                                .filter(r => r.orderId === detailOrder.id && r.item.barcode === i.barcode)
                                                                .reduce((sum, r) => sum + r.returnQuantity, 0);
                                                            const qty = activeTab === 'returned' ? i.quantity : (i.quantity - returned);
                                                            return acc + (i.unitPrice * qty);
                                                        }, 0).toFixed(2)} ₺
                                                    </td>
                                                </tr>
                                            </tfoot>
                                        </table>
                                    </div>
                                </div>

                                <div className="h-12 bg-gray-100 border-t border-gray-300 flex justify-end items-center px-4">
                                    <button className="desktop-btn w-24" onClick={() => setDetailOrder(null)}>Kapat</button>
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* --- PRINT MODAL --- */}
            {
                isPrintModalOpen && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[150] backdrop-blur-sm no-print">
                        <div className="bg-[#f0f0f0] border border-gray-500 shadow-2xl w-[95vw] h-[95vh] flex flex-col font-sans">
                            <div className="h-8 bg-white border-b border-gray-300 flex justify-between items-center px-3 select-none">
                                <span className="font-semibold text-gray-800 flex items-center gap-2"><LayoutTemplate size={16} /> Yazdırma Şablonu Tasarımcısı</span>
                                <button onClick={() => setIsPrintModalOpen(false)} className="hover:bg-red-500 hover:text-white px-2"><div className="text-lg leading-none">×</div></button>
                            </div>

                            <div className="flex-1 flex overflow-hidden">
                                {/* Sidebar Controls */}
                                {isLeftSidebarOpen ? (
                                <div className="w-80 bg-gray-100 border-r border-gray-300 flex flex-col overflow-y-auto shrink-0 relative">
                                    <button onClick={() => setIsLeftSidebarOpen(false)} className="absolute top-2 right-2 p-1 hover:bg-gray-200 rounded text-gray-500 hover:text-red-500 z-10" title="Paneli Gizle"><X size={16} /></button>
                                    <div className="p-3 border-b border-gray-300 bg-white">
                                        
                                        
                                        <label className="block text-xs font-bold text-gray-700 mb-1 mt-3 uppercase">Kağıt Boyutu</label>
                                        <div className="flex flex-wrap gap-1 mb-2">
                                            {(['A4', 'A5', 'Thermal', 'Custom'] as const).map(size => (
                                                <button
                                                    key={size}
                                                    onClick={() => setPrintConfig({ ...printConfig, paperSize: size })}
                                                    className={`flex-1 py-1 px-1 text-[10px] border ${printConfig.paperSize === size ? 'bg-blue-100 border-blue-400 text-blue-700' : 'bg-white border-gray-300 text-gray-600'}`}
                                                >
                                                    {size === 'Custom' ? 'Özel' : size}
                                                </button>
                                            ))}
                                        </div>
                                        {printConfig.paperSize === 'Custom' && (
                                            <div className="grid grid-cols-2 gap-2 mb-2">
                                                <div>
                                                    <label className="text-[10px] text-gray-500">Genişlik (mm)</label>
                                                    <input type="number" className="border w-full p-1 text-xs" value={printConfig.customWidth || 210} onChange={e => setPrintConfig({ ...printConfig, customWidth: Number(e.target.value) })} />
                                                </div>
                                                <div>
                                                    <label className="text-[10px] text-gray-500">Yükseklik (mm)</label>
                                                    <input type="number" className="border w-full p-1 text-xs" value={printConfig.customHeight || 297} onChange={e => setPrintConfig({ ...printConfig, customHeight: Number(e.target.value) })} />
                                                </div>
                                            </div>
                                        )}

                                        <div className="mt-2 text-xs">
                                            <label className="block font-bold text-gray-700 mb-1 flex items-center justify-between uppercase">
                                                Yazıcı Seçimi
                                                <button onClick={detectPrinters} className="text-blue-600 hover:underline font-normal bg-transparent border-none p-0" disabled={isScanningPrinters}>
                                                    {isScanningPrinters ? 'Taranıyor...' : 'Yenile'}
                                                </button>
                                            </label>
                                            <select
                                                className="border w-full p-1 text-xs bg-white"
                                                value={printConfig.selectedPrinter || 'default'}
                                                onChange={(e) => setPrintConfig({ ...printConfig, selectedPrinter: e.target.value })}
                                            >
                                                <option value="default">Sistem Varsayılanı (Diyalog)</option>
                                                {availablePrinters.map(printer => (
                                                    <option key={printer} value={printer}>{printer}</option>
                                                ))}
                                            </select>
                                        </div>

                                        <div className="mt-4 border-t pt-2 flex gap-2">
                                            <button
                                                onClick={() => {
                                                    const nextNote = printConfig.elements.find(e => e.key.startsWith('customNote') && !e.visible);
                                                    if (nextNote) handleElementChange(nextNote.id, 'visible', true);
                                                }}
                                                className="flex-1 py-2 border-2 border-dashed border-gray-300 rounded text-[10px] text-gray-500 hover:border-blue-500 hover:text-blue-500 transition-colors uppercase font-bold"
                                            >
                                                + Not Ekle
                                            </button>
                                            <button
                                                onClick={() => {
                                                    const nextImg = printConfig.elements.find(e => e.key.startsWith('customImage') && !e.visible);
                                                    if (nextImg) handleElementChange(nextImg.id, 'visible', true);
                                                }}
                                                className="flex-1 py-2 border-2 border-dashed border-gray-300 rounded text-[10px] text-gray-500 hover:border-blue-500 hover:text-blue-500 transition-colors uppercase font-bold"
                                            >
                                                + Görsel Ekle
                                            </button>
                                        </div>
                                    </div>
                                    <div className="p-2 space-y-2">
                                        <div className="text-[10px] font-bold text-gray-500 mb-1 px-1 uppercase tracking-wider">Şablon Öğeleri</div>
                                        {printConfig.elements.map(el => (
                                            <div key={el.id} className={`bg-white border rounded text-xs shadow-sm transition-all ${el.visible ? 'border-blue-300' : 'border-gray-200'}`}>
                                                <div className={`flex items-center justify-between p-2 rounded-t ${el.visible ? 'bg-blue-50' : 'bg-gray-50'}`}>
                                                    <span className={`font-bold ${el.visible ? 'text-blue-800' : 'text-gray-500'}`}>{el.label}</span>
                                                    <input
                                                        type="checkbox"
                                                        className="w-4 h-4 cursor-pointer"
                                                        checked={el.visible}
                                                        onChange={(e) => handleElementChange(el.id, 'visible', e.target.checked)}
                                                    />
                                                </div>
                                                {el.visible && (
                                                    <div className="p-2 space-y-2 border-t border-gray-100">
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <div>
                                                                <label className="text-[10px] text-gray-500 block">Soldan (mm)</label>
                                                                <input type="number" className="border w-full p-1" value={el.x} onChange={e => handleElementChange(el.id, 'x', Number(e.target.value))} />
                                                            </div>
                                                            <div>
                                                                <label className="text-[10px] text-gray-500 block">Üstten (mm)</label>
                                                                <input type="number" className="border w-full p-1" value={el.y} onChange={e => handleElementChange(el.id, 'y', Number(e.target.value))} />
                                                            </div>
                                                            {!el.isImage && (
                                                                <>
                                                                    <div>
                                                                        <label className="text-[10px] text-gray-500 block">Font Boyutu</label>
                                                                        <input type="number" className="border w-full p-1" value={el.fontSize} onChange={e => handleElementChange(el.id, 'fontSize', Number(e.target.value))} />
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-[10px] text-gray-500 block">Yazı Tipi</label>
                                                                        <select
                                                                            className="border w-full p-1 text-[10px]"
                                                                            value={el.fontFamily || 'Arial'}
                                                                            onChange={e => handleElementChange(el.id, 'fontFamily', e.target.value)}
                                                                        >
                                                                            <option value="Arial">Arial</option>
                                                                            <option value="'Courier New'">Courier New</option>
                                                                            <option value="'Times New Roman'">Times New Roman</option>
                                                                            <option value="Verdana">Verdana</option>
                                                                            <option value="Tahoma">Tahoma</option>
                                                                            <option value="'Trebuchet MS'">Trebuchet MS</option>
                                                                            <option value="Impact">Impact</option>
                                                                        </select>
                                                                    </div>
                                                                </>
                                                            )}
                                                        </div>

                                                        {(el.key === 'items' || el.key === 'deliveryAddress' || el.key.startsWith('customNote') || el.key === 'sku') && (
                                                            <div>
                                                                <label className="text-[10px] text-gray-500 block font-bold">Alan Genişliği (mm)</label>
                                                                <input type="number" className="border w-full p-1" value={el.width} onChange={e => handleElementChange(el.id, 'width', Number(e.target.value))} />
                                                            </div>
                                                        )}

                                                        {el.key === 'items' && el.tableColumns && (
                                                            <div className="border-t pt-2 mt-2">
                                                                <label className="text-[10px] font-bold text-gray-700 block mb-1 uppercase text-blue-700">Tablo Sütunlarını Seç</label>
                                                                <div className="space-y-1">
                                                                    {el.tableColumns.map((col, cidx) => (
                                                                        <div key={col.key} className="flex items-center justify-between group hover:bg-gray-50 p-1 rounded">
                                                                            <label className="flex items-center gap-2 cursor-pointer flex-1">
                                                                                <input
                                                                                    type="checkbox"
                                                                                    checked={col.visible}
                                                                                    onChange={(e) => {
                                                                                        const newCols = [...(el.tableColumns || [])];
                                                                                        newCols[cidx] = { ...col, visible: e.target.checked };
                                                                                        handleElementChange(el.id, 'tableColumns', newCols);
                                                                                    }}
                                                                                />
                                                                                <span className="text-[10px]">{col.label}</span>
                                                                            </label>
                                                                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                                <button
                                                                                    onClick={() => handleMoveTableColumn(el.id, cidx, 'up')}
                                                                                    disabled={cidx === 0}
                                                                                    className="p-0.5 hover:bg-gray-200 rounded disabled:opacity-30"
                                                                                    title="Sola Kaydır"
                                                                                >
                                                                                    <ArrowUp size={10} />
                                                                                </button>
                                                                                <button
                                                                                    onClick={() => handleMoveTableColumn(el.id, cidx, 'down')}
                                                                                    disabled={cidx === el.tableColumns!.length - 1}
                                                                                    className="p-0.5 hover:bg-gray-200 rounded disabled:opacity-30"
                                                                                    title="Sağa Kaydır"
                                                                                >
                                                                                    <ArrowDown size={10} />
                                                                                </button>
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}

                                                        {el.key.startsWith('customNote') && (
                                                            <div className="mt-1">
                                                                <label className="text-[10px] text-gray-500 block font-bold mb-1 uppercase">Not Metni</label>
                                                                <textarea
                                                                    className="border w-full p-1 text-[10px] h-12 resize-none"
                                                                    placeholder="Not metnini giriniz..."
                                                                    value={el.content || ''}
                                                                    onChange={e => handleElementChange(el.id, 'content', e.target.value)}
                                                                />
                                                            </div>
                                                        )}

                                                        {!el.isImage && (
                                                            <div className="flex flex-col gap-2 pt-1 border-t border-gray-100 mt-1">
                                                                <div className="flex items-center gap-2">
                                                                    <input
                                                                        type="checkbox"
                                                                        id={`is-barcode-${el.id}`}
                                                                        className="w-3 h-3 cursor-pointer"
                                                                        checked={el.isBarcode || false}
                                                                        onChange={e => handleElementChange(el.id, 'isBarcode', e.target.checked)}
                                                                    />
                                                                    <label htmlFor={`is-barcode-${el.id}`} className="text-[9px] text-blue-700 font-bold cursor-pointer uppercase">Barkod Olarak Yazdır</label>
                                                                </div>
                                                                {el.isBarcode && (
                                                                    <div className="pl-5">
                                                                        <label className="text-[10px] text-gray-500 block">Barkod Yüksekliği (mm)</label>
                                                                        <input
                                                                            type="number"
                                                                            className="border w-full p-1 text-xs"
                                                                            value={el.barcodeHeight || 20}
                                                                            onChange={e => handleElementChange(el.id, 'barcodeHeight', Number(e.target.value))}
                                                                        />
                                                                    </div>
                                                                )}
                                                                <div className="flex items-center gap-2">
                                                                    <input
                                                                        type="checkbox"
                                                                        id={`force-up-${el.id}`}
                                                                        className="w-3 h-3 cursor-pointer"
                                                                        checked={el.forceUppercase || false}
                                                                        onChange={e => handleElementChange(el.id, 'forceUppercase', e.target.checked)}
                                                                    />
                                                                    <label htmlFor={`force-up-${el.id}`} className="text-[9px] text-gray-700 font-bold cursor-pointer uppercase">Büyük Harf Yap</label>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {el.isImage && (
                                                            <div className="space-y-2 pt-1 border-t border-gray-100 mt-1">
                                                                <div>
                                                                    <label className="text-[10px] text-gray-500 block font-bold">Görsel Genişliği (mm)</label>
                                                                    <input type="number" className="border w-full p-1" value={el.width} onChange={e => handleElementChange(el.id, 'width', Number(e.target.value))} />
                                                                </div>
                                                                <div>
                                                                    <label className="text-[10px] text-gray-500 block font-bold">Görsel Yüksekliği (mm)</label>
                                                                    <input type="number" className="border w-full p-1" value={el.height || 20} onChange={e => handleElementChange(el.id, 'height', Number(e.target.value))} />
                                                                </div>
                                                                <div>
                                                                    <label className="text-[10px] text-gray-500 block font-bold">Dosya Seç (PC)</label>
                                                                    <input
                                                                        type="file"
                                                                        accept="image/*"
                                                                        onChange={(e) => {
                                                                            const file = e.target.files?.[0];
                                                                            if (file) {
                                                                                const reader = new FileReader();
                                                                                reader.onload = (event) => {
                                                                                    handleElementChange(el.id, 'content', event.target?.result);
                                                                                };
                                                                                reader.readAsDataURL(file);
                                                                            }
                                                                        }}
                                                                        className="text-[10px] w-full mt-0.5"
                                                                    />
                                                                </div>
                                                                {el.content && (
                                                                    <div className="border p-1 bg-gray-50 flex items-center justify-between mt-1 rounded">
                                                                        <span className="text-[9px] text-gray-500 truncate max-w-[150px]">Görsel yüklendi</span>
                                                                        <button
                                                                            onClick={() => handleElementChange(el.id, 'content', '')}
                                                                            className="text-red-500 hover:underline text-[9px]"
                                                                        >
                                                                            Kaldır
                                                                        </button>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                ) : (
                                    <div className="w-8 bg-gray-100 border-r border-gray-300 flex flex-col items-center py-2 shrink-0">
                                        <button onClick={() => setIsLeftSidebarOpen(true)} className="p-1 hover:bg-gray-200 rounded" title="Ayarları Aç">
                                            <div style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }} className="text-[10px] font-bold text-gray-600 mt-4 tracking-widest whitespace-nowrap">AYARLARI AÇ »</div>
                                        </button>
                                    </div>
                                )}
                                {/* Preview Area */}
                                <div className="flex-1 bg-gray-500 overflow-hidden flex flex-col relative">
                                    <div className="absolute top-4 right-4 z-10 bg-black/50 backdrop-blur-md p-2 rounded-lg border border-white/20 shadow-xl flex items-center gap-3 no-print">
                                        <div className="flex items-center gap-1">
                                            <button
                                                onClick={() => setPreviewZoom(Math.max(0.25, previewZoom - 0.25))}
                                                className="w-8 h-8 flex items-center justify-center bg-white/10 text-white rounded hover:bg-white/20 transition-colors"
                                                title="Uzaklaştır"
                                            >
                                                <ZoomOut size={14} />
                                            </button>
                                            <span className="text-white text-xs font-bold w-12 text-center">{Math.round(previewZoom * 100)}%</span>
                                            <button
                                                onClick={() => setPreviewZoom(Math.min(2, previewZoom + 0.25))}
                                                className="w-8 h-8 flex items-center justify-center bg-white/10 text-white rounded hover:bg-white/20 transition-colors"
                                                title="Yakınlaştır"
                                            >
                                                <ZoomIn size={14} />
                                            </button>
                                        </div>
                                        <button
                                            onClick={() => setPreviewZoom(1)}
                                            className="px-2 py-1 bg-blue-600 text-white text-[10px] font-bold rounded hover:bg-blue-700 transition-colors uppercase"
                                        >
                                            Sıfırla
                                        </button>
                                    </div>

                                    <div className="flex-1 overflow-auto p-12 flex flex-col items-center gap-8">
                                        <div className="text-white/50 text-[10px] uppercase font-bold tracking-[0.2em] mb-4">Şablon Önizleme</div>
                                        {previewOrders.length > 0 ? (
                                            previewOrders.map((order) => (
                                                <div key={order.id} className="origin-top shadow-[0_20px_50px_rgba(0,0,0,0.3)] bg-white transform transition-transform duration-300" style={{ transform: `scale(${previewZoom})` }}>
                                                    {renderPrintPage(order, true)}
                                                </div>
                                            ))
                                        ) : selectedOrders.length > 0 ? (
                                            <div className="h-full flex flex-col items-center justify-center text-white/40 italic">
                                                <Loader2 className="animate-spin mb-2" size={32} />
                                                <p>Veriler yükleniyor...</p>
                                            </div>
                                        ) : (
                                            <div className="h-full flex flex-col items-center justify-center text-white/40 italic border-2 border-dashed border-white/10 p-12 rounded-2xl">
                                                <Printer size={48} className="mb-4 opacity-20" />
                                                <p>Önizleme için sipariş seçin ve şablonu ayarlayın.</p>
                                            </div>
                                        )}
                                    </div>
                                </div>

{/* Right Sidebar Templates */}
                                {isRightSidebarOpen ? (
                                <div className="w-72 bg-gray-100 border-l border-gray-300 flex flex-col overflow-y-auto z-10 shadow-[-5px_0_15px_-5px_rgba(0,0,0,0.1)] shrink-0 relative">
                                    <button onClick={() => setIsRightSidebarOpen(false)} className="absolute top-2 right-2 p-1 hover:bg-gray-200 rounded text-gray-500 hover:text-red-500 z-10" title="Paneli Gizle"><X size={16} /></button>
                                    <div className="p-3 border-b border-gray-300 bg-white sticky top-0 font-bold text-gray-700 flex items-center gap-2 uppercase text-sm">
                                        <Save size={16} /> Kayıtlı Şablonlar
                                    </div>
                                    <div className="p-2 space-y-2 flex-1">
                                        {savedTemplates.length === 0 ? (
                                            <div className="text-xs text-gray-500 text-center italic mt-4">Henüz kaydedilmiş şablon yok.</div>
                                        ) : (
                                            savedTemplates.map(tpl => (
                                                <div key={tpl.id} className="flex items-center justify-between bg-white border border-gray-300 rounded p-2 hover:border-blue-500 transition-colors group cursor-pointer" onClick={() => setPrintConfig(tpl.config)}>
                                                    <span className="text-sm font-medium text-gray-700 truncate flex-1">{tpl.name}</span>
                                                    <button onClick={(e) => { e.stopPropagation(); handleDeletePrintTemplate(tpl.id); }} className="text-red-500 hover:text-white hover:bg-red-500 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <Trash size={14} />
                                                    </button>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                    <div className="p-3 border-t border-gray-300 bg-gray-50 flex flex-col gap-2 shrink-0">
                                        <label className="text-xs font-bold text-gray-700">Yeni Şablon Kaydet</label>
                                        <input type="text" className="border p-2 text-xs rounded" placeholder="Şablon Adı (Örn: A5)" value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} />
                                        <button onClick={handleSavePrintTemplate} className="desktop-btn desktop-btn-primary w-full py-2 text-xs flex justify-center items-center gap-1"><Save size={14}/> Kaydet</button>
                                    </div>
                                </div>
                                ) : (
                                    <div className="w-8 bg-gray-100 border-l border-gray-300 flex flex-col items-center py-2 shrink-0">
                                        <button onClick={() => setIsRightSidebarOpen(true)} className="p-1 hover:bg-gray-200 rounded" title="Şablonları Aç">
                                            <div style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }} className="text-[10px] font-bold text-gray-600 mt-4 tracking-widest whitespace-nowrap">« ŞABLONLAR</div>
                                        </button>
                                    </div>
                                )}
                            </div>

                            <div className="h-12 bg-white border-t border-gray-300 flex justify-end items-center px-4 gap-2">
                                <div className="mr-auto text-xs text-gray-500 flex items-center">
                                    <AlertTriangle size={12} className="mr-1 text-orange-500" />
                                    {selectedOrders.length} adet sipariş seçili. Şablona göre hepsi yazdırılacak.
                                </div>
                                <button onClick={handleResetPrintTemplate} className="desktop-btn w-24">Varsayılan</button>
                                
                                
                                <button onClick={() => setIsPrintModalOpen(false)} className="desktop-btn w-24">İptal</button>
                                <button onClick={() => triggerPrint('print')} disabled={isGeneratingPDF} className="desktop-btn desktop-btn-primary w-32">
                                    <Printer className="w-4 h-4 mr-2" /> {isGeneratingPDF ? 'Bekleyin...' : 'Yazdır'}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* --- MANUEL SİPARİŞ MODALI --- */}
            {
                isManualOrderModalOpen && (
                    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[200] backdrop-blur-sm no-print font-sans p-4">
                        <div className="bg-white border border-gray-200 shadow-2xl w-full max-w-4xl flex flex-col rounded-2xl overflow-hidden animate-in fade-in zoom-in duration-200 max-h-[90vh]">
                            <div className="h-14 bg-gradient-to-r from-green-600 to-green-700 text-white flex justify-between items-center px-6 shrink-0">
                                <div className="flex items-center gap-3">
                                    <div className="bg-white/20 p-2 rounded-lg"><Plus size={20} /></div>
                                    <span className="font-bold text-lg">Manuel Sipariş Oluştur</span>
                                </div>
                                <button onClick={() => setIsManualOrderModalOpen(false)} className="hover:bg-white/20 p-1.5 rounded-full transition-colors">
                                    <Plus size={24} className="rotate-45" />
                                </button>
                            </div>

                            <div className="p-6 overflow-y-auto min-h-0 space-y-6">
                                {/* Section 1: General Info */}
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Mağaza *</label>
                                        <select
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all"
                                            value={manualOrderForm.storeName}
                                            onChange={e => setManualOrderForm({ ...manualOrderForm, storeName: e.target.value })}
                                        >
                                            <option value="">Mağaza Seçiniz...</option>
                                            {db.apiConfigs.map(config => (
                                                <option key={config.id} value={config.storeName}>{config.storeName}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Sipariş No</label>
                                        <input
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all"
                                            value={manualOrderForm.marketplaceOrderId}
                                            onChange={e => setManualOrderForm({ ...manualOrderForm, marketplaceOrderId: e.target.value })}
                                            placeholder="Otomatik oluşturulur..."
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Tarih</label>
                                        <input
                                            type="date"
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all"
                                            value={manualOrderForm.orderDate}
                                            onChange={e => setManualOrderForm({ ...manualOrderForm, orderDate: e.target.value })}
                                        />
                                    </div>
                                </div>

                                {/* Section 2: Customer Info */}
                                <div className="bg-gray-50/50 p-5 rounded-2xl border border-gray-100 space-y-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <div className="w-1.5 h-4 bg-green-500 rounded-full"></div>
                                        <h4 className="text-sm font-bold text-gray-700">Müşteri ve Teslimat Bilgileri</h4>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Ad Soyad *</label>
                                            <input
                                                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all"
                                                value={manualOrderForm.customerName}
                                                onChange={e => setManualOrderForm({ ...manualOrderForm, customerName: e.target.value })}
                                                placeholder="Müşteri adını giriniz..."
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Telefon</label>
                                            <input
                                                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all"
                                                value={manualOrderForm.phone}
                                                onChange={e => setManualOrderForm({ ...manualOrderForm, phone: e.target.value })}
                                                placeholder="05xx..."
                                            />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <div className="md:col-span-2 space-y-1.5">
                                            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Teslimat Adresi</label>
                                            <textarea
                                                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all resize-none h-20"
                                                value={manualOrderForm.deliveryAddress}
                                                onChange={e => setManualOrderForm({ ...manualOrderForm, deliveryAddress: e.target.value })}
                                                placeholder="Adres detaylarını giriniz..."
                                            />
                                        </div>
                                        <div className="space-y-4">
                                            <div className="space-y-1.5">
                                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Ülke</label>
                                                <select
                                                    className="w-full bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all"
                                                    value={manualOrderForm.countryCode}
                                                    onChange={e => setManualOrderForm({ ...manualOrderForm, countryCode: e.target.value })}
                                                >
                                                    {PRIORITY_COUNTRIES.map(c => (
                                                        <option key={c.code} value={c.code}>{c.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className="space-y-1.5">
                                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Kargo Firması</label>
                                                <input
                                                    className="w-full bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all"
                                                    value={manualOrderForm.cargoCompanyName}
                                                    onChange={e => setManualOrderForm({ ...manualOrderForm, cargoCompanyName: e.target.value })}
                                                    placeholder="Örn: Trendyol Express"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Kargo Takip Kodu</label>
                                        <input
                                            className="w-full bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all"
                                            value={manualOrderForm.cargoCode}
                                            onChange={e => setManualOrderForm({ ...manualOrderForm, cargoCode: e.target.value })}
                                            placeholder="Takip kodunu giriniz..."
                                        />
                                    </div>
                                </div>

                                {/* Section 3: Products */}
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <div className="w-1.5 h-4 bg-green-500 rounded-full"></div>
                                            <h4 className="text-sm font-bold text-gray-700">Ürünler ({manualOrderForm.items.length})</h4>
                                        </div>
                                    </div>

                                    <div className="flex gap-2">
                                        <div className="relative flex-1">
                                            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-400">
                                                <HardDrive size={18} />
                                            </div>
                                            <input
                                                className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-sm focus:border-green-500 focus:ring-0 outline-none transition-all font-mono"
                                                value={manualBarcode}
                                                onChange={e => setManualBarcode(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && handleAddManualItem()}
                                                placeholder="Ürün barkodunu okutun veya yazın..."
                                            />
                                        </div>
                                        <button
                                            onClick={handleAddManualItem}
                                            className="bg-green-600 text-white px-6 rounded-xl font-bold hover:bg-green-700 transition-all active:scale-95 shadow-lg shadow-green-100 flex items-center gap-2"
                                        >
                                            <Plus size={18} /> Ekle
                                        </button>
                                    </div>

                                    {manualOrderForm.items.length > 0 ? (
                                        <div className="border border-gray-100 rounded-2xl overflow-hidden shadow-sm">
                                            <table className="w-full text-sm">
                                                <thead className="bg-gray-50 text-gray-500 text-[10px] uppercase font-bold tracking-wider">
                                                    <tr>
                                                        <th className="px-4 py-3 text-left">Ürün</th>
                                                        <th className="px-4 py-3 text-center">Beden</th>
                                                        <th className="px-4 py-3 text-center">Adet</th>
                                                        <th className="px-4 py-3 text-right">Fiyat</th>
                                                        <th className="px-4 py-3 text-right w-16"></th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-gray-100 bg-white">
                                                    {manualOrderForm.items.map((item, idx) => (
                                                        <tr key={idx} className="hover:bg-gray-50/50 transition-colors">
                                                            <td className="px-4 py-3">
                                                                <div className="font-bold text-gray-800">{item.productName}</div>
                                                                <div className="text-[10px] text-gray-400 font-mono">{item.barcode} | {item.sku}</div>
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full text-[10px] font-bold border border-blue-100">{item.size}</span>
                                                            </td>
                                                            <td className="px-4 py-3">
                                                                <div className="flex items-center justify-center gap-2">
                                                                    <button
                                                                        onClick={() => {
                                                                            const newItems = [...manualOrderForm.items];
                                                                            if (newItems[idx].quantity > 1) {
                                                                                newItems[idx].quantity--;
                                                                                setManualOrderForm({ ...manualOrderForm, items: newItems });
                                                                            }
                                                                        }}
                                                                        className="w-6 h-6 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-100"
                                                                    >-</button>
                                                                    <span className="w-6 text-center font-bold">{item.quantity}</span>
                                                                    <button
                                                                        onClick={() => {
                                                                            const newItems = [...manualOrderForm.items];
                                                                            newItems[idx].quantity++;
                                                                            setManualOrderForm({ ...manualOrderForm, items: newItems });
                                                                        }}
                                                                        className="w-6 h-6 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-100"
                                                                    >+</button>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-3 text-right">
                                                                <div className="flex items-center justify-end gap-1">
                                                                    <input
                                                                        type="number"
                                                                        className="w-20 text-right bg-white border border-gray-200 rounded px-2 py-1 text-sm focus:border-green-500 outline-none font-bold text-green-700"
                                                                        value={item.unitPrice}
                                                                        onChange={(e) => {
                                                                            const newItems = [...manualOrderForm.items];
                                                                            newItems[idx].unitPrice = Number(e.target.value) || 0;
                                                                            setManualOrderForm({ ...manualOrderForm, items: newItems });
                                                                        }}
                                                                    />
                                                                    <span className="text-xs text-gray-500">₺</span>
                                                                </div>
                                                                <div className="text-[10px] text-gray-400 mt-1">
                                                                    Toplam: {(item.unitPrice * item.quantity).toFixed(2)} ₺
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-3 text-right">
                                                                <button
                                                                    onClick={() => {
                                                                        const newItems = manualOrderForm.items.filter((_, i) => i !== idx);
                                                                        setManualOrderForm({ ...manualOrderForm, items: newItems });
                                                                    }}
                                                                    className="text-red-400 hover:text-red-600 transition-colors"
                                                                >
                                                                    <Trash2 size={16} />
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                                <tfoot className="bg-gray-50/50">
                                                    <tr>
                                                        <td colSpan={3} className="px-4 py-4 text-right font-bold text-gray-500 uppercase text-xs">Genel Toplam</td>
                                                        <td className="px-4 py-4 text-right font-extrabold text-lg text-green-600">
                                                            {manualOrderForm.items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0).toFixed(2)} ₺
                                                        </td>
                                                        <td></td>
                                                    </tr>
                                                </tfoot>
                                            </table>
                                        </div>
                                    ) : (
                                        <div className="py-12 border-2 border-dashed border-gray-100 rounded-2xl flex flex-col items-center justify-center text-gray-400 bg-gray-50/50">
                                            <HardDrive size={40} className="mb-2 opacity-20" />
                                            <p className="text-sm font-medium">Henüz ürün eklenmedi</p>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="p-6 border-t bg-gray-50 flex justify-between items-center shrink-0">
                                <p className="text-xs text-gray-500">* İşaretli alanlar zorunludur.</p>
                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setIsManualOrderModalOpen(false)}
                                        className="px-6 py-2.5 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded-xl transition-colors"
                                    >
                                        İptal
                                    </button>
                                    <button
                                        onClick={handleSaveManualOrder}
                                        disabled={!manualOrderForm.customerName || !manualOrderForm.storeName || manualOrderForm.items.length === 0}
                                        className="px-8 py-2.5 bg-green-600 text-white rounded-xl text-sm font-bold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-green-100 transition-all active:scale-95 flex items-center gap-2"
                                    >
                                        <Save size={18} /> Siparişi Tamamla
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }

        </div>
    );
};
