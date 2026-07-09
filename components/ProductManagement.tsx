
import React, { useState, useRef, useEffect } from 'react';
import { Database, Product, Variant, Warehouse, UserRole } from '../types';
import { Plus, Trash2, Edit, Save, Copy, Download, Upload, Search, Archive, FileSpreadsheet, Check, X, FileMinus, HardDrive, Globe, Image as ImageIcon, FolderOpen, ChevronLeft, ChevronRight } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import * as XLSX from 'xlsx';
import { syncBarcodeStock } from '../services/integration';

const uuid = () => Math.random().toString(36).substr(2, 9);

interface Props {
    db: Database;
    updateDB: (newDB: Database | ((prev: Database) => Database)) => void;
    userRole: UserRole;
    setNotification: (notif: { type: 'success' | 'error', message: string } | null) => void;
    requestConfirm: (message: string, onConfirm: () => void) => void;
}

export const ProductManagement: React.FC<Props> = ({ db, updateDB, userRole, setNotification, requestConfirm }) => {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [activeSubPanel, setActiveSubPanel] = useState<'none' | 'barcode' | 'stock' | 'images'>('none');
    const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
    const [tableZoom, setTableZoom] = useState(1); // Tablo ölçeklendirme
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const [previewImageColor, setPreviewImageColor] = useState<string | null>(null);
    const [previewProduct, setPreviewProduct] = useState<Product | null>(null);
    const [currentGalleryIndex, setCurrentGalleryIndex] = useState(0);
    const [allGalleryImages, setAllGalleryImages] = useState<{ url: string, color: string }[]>([]);
    const [currentPage, setCurrentPage] = useState(1);

    const exactBarcodeMatch = React.useMemo(() => {
        if (!searchTerm) return null;
        for (const p of db.products) {
            for (const v of p.variants) {
                if (v.barcode === searchTerm) {
                    const totalVariantStock = Object.values(v.stocks).reduce((a: number, b: number) => a + b, 0);
                    return { product: p, variant: v, totalStock: totalVariantStock };
                }
            }
        }
        return null;
    }, [searchTerm, db.products]);

    // Pagination states
    const [showAllProducts, setShowAllProducts] = useState(false);

    // Progress states for bulk upload
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadTotal, setUploadTotal] = useState(0);
    const [uploadCurrent, setUploadCurrent] = useState(0);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const deleteFileInputRef = useRef<HTMLInputElement>(null);

    // Warehouse adding state
    const [isAddingWarehouse, setIsAddingWarehouse] = useState(false);
    const [newWarehouseName, setNewWarehouseName] = useState('');

    // Variant Filters
    const [variantFilterColor, setVariantFilterColor] = useState('');
    const [variantFilterSize, setVariantFilterSize] = useState('');
    const [variantFilterBarcode, setVariantFilterBarcode] = useState('');
    const [variantSortBy, setVariantSortBy] = useState<keyof Variant | 'none'>('none');
    const [variantSortOrder, setVariantSortOrder] = useState<'asc' | 'desc'>('asc');
    const [variantStockSortOrder, setVariantStockSortOrder] = useState<'asc' | 'desc'>('asc'); // Default A-Z for v1.2.9
    const [selectedImageColor, setSelectedImageColor] = useState<string>('');
    const [bulkValue, setBulkValue] = useState<string>('');
    const imageInputRef = useRef<HTMLInputElement>(null);
    const [hasShownDesktopWarning, setHasShownDesktopWarning] = useState(false);
    const [barcodeScrollTop, setBarcodeScrollTop] = useState(0);
    const [stockScrollTop, setStockScrollTop] = useState(0);
    const rowHeight = 33;
    const visibleRows = 12;
    const buffer = 5;

    const initialFormState: Product = {
        id: '',
        productCode: '',
        name: '',
        brand: '',
        group: '',
        costPrice: 0,
        salePrice: 0,
        date: new Date().toISOString().slice(0, 10),
        variants: [],
    };
    const [formData, setFormData] = useState<Product>(initialFormState);

    const getElectronBridge = () => {
        const w = window as any;
        if (w.electron) return w.electron;

        // Fallback for packaged desktop cases where preload bridge is unavailable.
        if (typeof w.require === 'function') {
            try {
                const { ipcRenderer } = w.require('electron');
                return {
                    saveProductImage: (data: any) => ipcRenderer.invoke('save-product-image', data),
                    deleteProductImage: (filePath: string) => ipcRenderer.invoke('delete-product-image', filePath),
                    openProductImagesFolder: (data: any) => ipcRenderer.invoke('open-product-images-folder', data),
                    getImagesBasePath: () => ipcRenderer.invoke('get-images-base-path'),
                };
            } catch (err) {
                console.error('Electron fallback bridge error:', err);
            }
        }

        return null;
    };

    const allFilteredProducts = (() => {
        let products = db.products;

        // Arama yapılmadıysa son eklenen ürünleri göster (Sıralama amaçlı)
        if (!searchTerm) {
            products = [...products].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        }

        return products.filter(p =>
            p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.productCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.variants.some(v =>
                v.barcode.includes(searchTerm) ||
                v.color.toLowerCase().includes(searchTerm.toLowerCase()) ||
                v.size.toLowerCase().includes(searchTerm.toLowerCase())
            )
        );
    })();

    const itemsPerPage = db.settings.productsPerPage === 'all' ? allFilteredProducts.length : (Number(db.settings.productsPerPage) || 25);
    const totalPages = Math.ceil(allFilteredProducts.length / itemsPerPage);
    const paginatedProducts = allFilteredProducts.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

    const calculateRealTotalStock = (product: Product) => {
        const uniqueVariants = new Set<string>();
        let total = 0;
        product.variants.forEach(v => {
            const key = `${v.color}-${v.size}`;
            if (!uniqueVariants.has(key)) {
                uniqueVariants.add(key);
                total += Object.values(v.stocks).reduce((a: number, b: number) => a + b, 0);
            }
        });
        return total;
    };

    // Keyboard Navigation for Gallery
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!previewImage) return;

            if (e.key === 'Escape') {
                setPreviewImage(null);
            } else if (e.key === 'ArrowRight') {
                const newIdx = (currentGalleryIndex + 1) % allGalleryImages.length;
                setCurrentGalleryIndex(newIdx);
                setPreviewImage(allGalleryImages[newIdx].url);
                setPreviewImageColor(allGalleryImages[newIdx].color);
            } else if (e.key === 'ArrowLeft') {
                const newIdx = (currentGalleryIndex - 1 + allGalleryImages.length) % allGalleryImages.length;
                setCurrentGalleryIndex(newIdx);
                setPreviewImage(allGalleryImages[newIdx].url);
                setPreviewImageColor(allGalleryImages[newIdx].color);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [previewImage, currentGalleryIndex, allGalleryImages]);

    // Search trigger
    useEffect(() => {
        // Arama yapıldığında tüm ürünleri göster ve ilk sayfaya dön
        setShowAllProducts(!!searchTerm);
        if (searchTerm) setCurrentPage(1);
    }, [searchTerm]);

    // Modal variant memoization for performance
    const modalVariantsList = React.useMemo(() => {
        return formData.variants
            .filter(v =>
                (v.color || '').toLowerCase().includes(variantFilterColor.toLowerCase()) &&
                (v.size || '').toLowerCase().includes(variantFilterSize.toLowerCase()) &&
                (v.barcode || '').toLowerCase().includes(variantFilterBarcode.toLowerCase())
            )
            .sort((a, b) => {
                if (variantSortBy === 'none') return 0;
                const compareStrings = (s1: string, s2: string, order: 'asc' | 'desc') => {
                    const cmp = String(s1 || '').toLocaleLowerCase('tr').localeCompare(String(s2 || '').toLocaleLowerCase('tr'), 'tr', { numeric: true });
                    return order === 'asc' ? cmp : -cmp;
                };
                const primaryCmp = compareStrings(String(a[variantSortBy]), String(b[variantSortBy]), variantSortOrder);
                if (primaryCmp !== 0) return primaryCmp;
                if (variantSortBy === 'color') {
                    return String(a.size || '').toLocaleLowerCase('tr').localeCompare(String(b.size || '').toLocaleLowerCase('tr'), 'tr', { numeric: true });
                } else if (variantSortBy === 'size') {
                    return String(a.color || '').toLocaleLowerCase('tr').localeCompare(String(b.size || '').toLocaleLowerCase('tr'), 'tr', { numeric: true });
                }
                return 0;
            });
    }, [formData.variants, variantFilterColor, variantFilterSize, variantFilterBarcode, variantSortBy, variantSortOrder]);

    const modalStockList = React.useMemo(() => {
        const uniqueGroups: { [key: string]: Variant } = {};
        formData.variants.forEach(v => {
            const key = `${v.color}-${v.size}`;
            if (!uniqueGroups[key]) {
                uniqueGroups[key] = v;
            }
        });

        return Object.entries(uniqueGroups).sort((a, b) => {
            const valA = `${a[1].color} / ${a[1].size}`;
            const valB = `${b[1].color} / ${b[1].size}`;
            const cmp = valA.toLocaleLowerCase('tr').localeCompare(valB.toLocaleLowerCase('tr'), 'tr', { numeric: true });
            return variantStockSortOrder === 'asc' ? cmp : -cmp;
        });
    }, [formData.variants, variantStockSortOrder]);



    const handleOpenAdd = () => {
        setFormData({ ...initialFormState, id: uuid(), date: new Date().toISOString().split('T')[0] });
        setEditingProduct(null);
        setIsModalOpen(true);
        setVariantFilterColor('');
        setVariantFilterSize('');
        setVariantFilterBarcode('');
        setActiveSubPanel('barcode');
    };

    const handleEdit = (product: Product) => {
        setFormData({ ...product });
        setEditingProduct(product);
        setIsModalOpen(true);
        setVariantFilterColor('');
        setVariantFilterSize('');
        setVariantFilterBarcode('');
        setActiveSubPanel('barcode');
    };

    const handleDelete = (id: string) => {
        if (userRole !== UserRole.ADMIN) {
            setNotification({ type: 'error', message: "Yetkiniz yok." });
            return;
        }

        requestConfirm('Bu ürünü silmek istediğinize emin misiniz? BU İŞLEM GERİ ALINAMAZ!', () => {
            const newProducts = db.products.filter(p => p.id !== id);
            updateDB({ ...db, products: newProducts });
            setSelectedProductIds(selectedProductIds.filter(pid => pid !== id));
            setNotification({ type: 'success', message: 'Ürün başarıyla silindi.' });
        });
    };

    // Bulk Delete Button Removed as requested.
    // const handleBulkDelete = ...

    const handleSaveProduct = async () => {
        // Zorunlu alan kontrolü
        if (!formData.productCode.trim() || !formData.name.trim() || !formData.brand.trim() || !formData.group.trim()) {
            setNotification({ type: 'error', message: "Ürün Kodu, Ürün Adı, Marka ve Grup alanları boş bırakılamaz!" });
            return;
        }

        // Benzersiz ürün kodu kontrolü
        const isDuplicateCode = db.products.some(p =>
            p.productCode.trim().toLowerCase() === formData.productCode.trim().toLowerCase() &&
            p.id !== formData.id
        );

        if (isDuplicateCode) {
            setNotification({ type: 'error', message: `"${formData.productCode}" koduna sahip başka bir ürün zaten mevcut! Lütfen farklı bir ürün kodu giriniz.` });
            return;
        }

        // Barkod tekilliği kontrolü - Final Check
        for (const variant of formData.variants) {
            if (variant.barcode && variant.barcode !== '') {
                const isDuplicateBarcode = db.products.some(p =>
                    p.id !== formData.id && p.variants.some(v => v.barcode === variant.barcode)
                );
                if (isDuplicateBarcode) {
                    setNotification({ type: 'error', message: `"${variant.barcode}" barkodu başka bir üründe zaten kullanılıyor! Kaydedilemedi.` });
                    return;
                }

                const isDuplicateInSelf = formData.variants.some(v =>
                    v.id !== variant.id && v.barcode === variant.barcode
                );
                if (isDuplicateInSelf) {
                    setNotification({ type: 'error', message: `"${variant.barcode}" barkodu bu ürün içinde birden fazla kullanılıyor! Kaydedilemedi.` });
                    return;
                }
            }
        }

        updateDB(prev => {
            const newProducts = prev.products.filter(p => p.id !== formData.id);
            newProducts.push(formData);
            return { ...prev, products: newProducts };
        });

        // Sync Check: Arka planda barkod bazlı toplu stok gönderimi
        if (db.settings.enableAutoStockSync) {
            // SADECE stoğu değişen varyantları belirle (Selective Sync)
            const itemsToSync = formData.variants
                .filter(v => v.barcode)
                .filter(v => {
                    if (!editingProduct) return true; // Yeni ürünse hepsini gönder
                    const oldVariant = editingProduct.variants.find(ov => ov.barcode === v.barcode);
                    if (!oldVariant) return true; // Yeni varyant
                    const oldStock = Object.values(oldVariant.stocks).reduce((a: number, b: number) => a + b, 0);
                    const newStock = Object.values(v.stocks).reduce((a: number, b: number) => a + b, 0);
                    return oldStock !== newStock; // Sadece stok değiştiyse
                })
                .map(v => ({
                    barcode: v.barcode,
                    quantity: Object.values(v.stocks).reduce((a: number, b: number) => a + b, 0)
                }));

            if (itemsToSync.length > 0) {
                import('../services/integration').then(m => {
                    m.syncBarcodeStockBatchMultiple(
                        db.apiConfigs,
                        itemsToSync,
                        db.settings,
                        (count) => setNotification({ type: 'success', message: `${count} barkod için stok güncelleme başladı...` }),
                        () => setNotification({ type: 'success', message: 'Stok güncelleme bitti.' })
                    );
                });
            }
        }

        // Kaydedilen barkodları kontrol et ve askıdaki siparişleri otomatik kontrol et (Functional Update sonrası)
        const savedBarcodes = formData.variants.map(v => v.barcode).filter(b => b && b !== '');
        if (savedBarcodes.length > 0) {
            savedBarcodes.forEach(barcode => {
                window.dispatchEvent(new CustomEvent('barcodeSaved', { detail: { barcode } }));
            });
        }

        setIsModalOpen(false);
    };

    const handleManualStockSync = async () => {
        const productsToProcess = selectedProductIds.length > 0
            ? db.products.filter(p => selectedProductIds.includes(p.id))
            : db.products;

        const confirmMessage = selectedProductIds.length > 0
            ? `${productsToProcess.length} seçili ürünün stokları gönderilecek. Devam edilsin mi?`
            : `Sistemdeki TÜM ürünlerin (${productsToProcess.length} adet) stokları gönderilecek. Bu işlem zaman alabilir. Devam edilsin mi?`;

        requestConfirm(confirmMessage, async () => {
            const barcodesToSync: { barcode: string, quantity: number }[] = [];

            productsToProcess.forEach(product => {
                product.variants.forEach(v => {
                    if (v.barcode) {
                        const totalStock = Object.values(v.stocks).reduce((a: number, b: number) => a + b, 0);
                        barcodesToSync.push({ barcode: v.barcode, quantity: totalStock as number });
                    }
                });
            });

            if (barcodesToSync.length === 0) {
                setNotification({ type: 'error', message: "Gönderilecek barkod bulunamadı." });
                return;
            }

            try {
                setIsUploading(true);
                const { syncBarcodeStockBatchMultiple } = await import('../services/integration');

                await syncBarcodeStockBatchMultiple(
                    db.apiConfigs,
                    barcodesToSync,
                    db.settings,
                    (count) => setNotification({ type: 'success', message: `${count} barkod için stok güncelleme başladı...` }),
                    () => setNotification({ type: 'success', message: 'Stoklar başarıyla güncellendi.' })
                );

            } catch (error) {
                console.error('Stock sync error:', error);
                setNotification({ type: 'error', message: "Stok gönderimi sırasında hata oluştu." });
            } finally {
                setIsUploading(false);
            }
        });
    };

    // --- TEMPLATE OPERATIONS ---

    const handleDownloadTemplate = () => {
        const templateData = [
            ['Ürün Kodu', 'Renk', 'Beden', 'Barkod']
        ];

        const ws = XLSX.utils.aoa_to_sheet(templateData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Şablon');

        XLSX.writeFile(wb, 'Urun-Yukleme-Sablonu.xlsx');
    };

    const handleBulkImport = () => {
        fileInputRef.current?.click();
    };

    // --- EXCEL OPERATIONS ---

    const handleExport = () => {
        const data: any[] = [];
        db.products.forEach(p => {
            p.variants.forEach(v => {
                const totalStock = Object.values(v.stocks).reduce((a: number, b: number) => a + b, 0);
                data.push({
                    'Ürün Kodu': p.productCode,
                    'Ürün adı': p.name,
                    'Marka': p.brand,
                    'Grup': p.group,
                    'Renk': v.color,
                    'Beden': v.size,
                    'Barkod': v.barcode,
                    'Maliyet Fiyat': v.costPrice || 0,
                    'PSF Fiyat': v.salePrice || 0,
                    'Stok': totalStock
                });
            });
        });

        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Ürünler");
        XLSX.writeFile(workbook, "Urunler_Raporu.xlsx");
    };



    const handleBulkUploadClick = () => {
        if (fileInputRef.current) fileInputRef.current.click();
    };

    const handleBulkDeleteUploadClick = () => {
        if (deleteFileInputRef.current) deleteFileInputRef.current.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            const bstr = evt.target?.result;
            const wb = XLSX.read(bstr, { type: 'binary' });
            const wsname = wb.SheetNames[0];
            const ws = wb.Sheets[wsname];
            const data = XLSX.utils.sheet_to_json(ws);

            processBulkData(data);
        };
        reader.readAsBinaryString(file);
        e.target.value = '';
    };

    const handleDeleteFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            const bstr = evt.target?.result;
            const wb = XLSX.read(bstr, { type: 'binary' });
            const wsname = wb.SheetNames[0];
            const ws = wb.Sheets[wsname];
            const data = XLSX.utils.sheet_to_json(ws);

            processBulkDeleteData(data);
        };
        reader.readAsBinaryString(file);
        e.target.value = '';
    };

    const processBulkData = async (data: any[]) => {
        setIsUploading(true);
        setUploadTotal(data.length);
        setUploadCurrent(0);
        setUploadProgress(0);

        let currentProducts = [...db.products];
        let addedBarcodeCount = 0;
        let skippedProductCount = 0;
        let alreadyExistsCount = 0;
        const skippedCodes: string[] = [];

        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            setUploadCurrent(i + 1);
            setUploadProgress(Math.round(((i + 1) / data.length) * 100));

            await new Promise(resolve => setTimeout(resolve, 5));

            const pCode = String(row['Ürün Kodu'] || '').trim();
            const color = String(row['Renk'] || '').trim();
            const size = String(row['Beden'] || '').trim();
            const barcode = row['Barkod'] ? String(row['Barkod']).trim() : '';

            if (!pCode || !color || !size || !barcode) {
                continue;
            }

            // 1. Barkod tekilliği kontrolü - sistem genelinde (Daha önce eklenmiş olanlar dahil)
            const isBarcodeExists = currentProducts.some(p =>
                p.variants.some(v => v.barcode === barcode)
            );

            if (isBarcodeExists) {
                alreadyExistsCount++;
                continue;
            }

            // 2. Ürünü bul
            let product = currentProducts.find(p => p.productCode === pCode);

            if (!product) {
                // Ürün kodu bulunamadıysa yeni ürün kartı oluştur
                const newProduct: Product = {
                    id: uuid(),
                    productCode: pCode,
                    name: String(row['Ürün adı'] || row['Ürün Adı'] || row['ad'] || 'Yeni Ürün').trim(),
                    brand: String(row['Marka'] || row['marka'] || '').trim(),
                    group: String(row['Grup'] || row['grup'] || '').trim(),
                    costPrice: Number(row['Maliyet Fiyat'] || row['maliyet'] || 0),
                    salePrice: Number(row['PSF Fiyat'] || row['psf'] || 0),
                    date: new Date().toISOString().split('T')[0],
                    variants: []
                };
                currentProducts.push(newProduct);
                product = newProduct;
            }

            // 3. Varyant ekle
            const newVar: Variant = {
                id: uuid(),
                color: color,
                size: size,
                barcode: barcode,
                costPrice: Number(row['Maliyet Fiyat'] || row['maliyet'] || 0),
                salePrice: Number(row['PSF Fiyat'] || row['psf'] || 0),
                stocks: { 'wh1': Number(row['Stok'] || row['stok'] || 0) }
            };
            product.variants.push(newVar);
            addedBarcodeCount++;
        }

        updateDB({ ...db, products: currentProducts });
        setIsUploading(false);

        // Yeni ürün sayısını hesapla (currentProducts içindeki IDs'leri db.products içindekilerle karşılaştır)
        const existingIds = new Set(db.products.map(p => p.id));
        const newProductCount = currentProducts.filter(p => !existingIds.has(p.id)).length;

        let messageText = `İşlem Tamamlandı:\n${addedBarcodeCount} yeni barkod sisteme eklendi.`;
        if (newProductCount > 0) {
            messageText += `\n${newProductCount} yeni ürün kartı oluşturuldu.`;
        }
        if (alreadyExistsCount > 0) {
            messageText += `\n${alreadyExistsCount} barkod zaten sistemde kayıtlı olduğu için atlandı.`;
        }
        if (skippedCodes.length > 0) {
            messageText += `\n\nSistemde bulunamadığı için atlanan ürün kodları (${skippedCodes.length} adet):\n${skippedCodes.slice(0, 5).join(', ')}${skippedCodes.length > 5 ? '...' : ''}`;
        }
        setNotification({ type: 'success', message: messageText });

    };

    const processBulkDeleteData = (data: any[]) => {
        if (userRole !== UserRole.ADMIN) return alert("Yetkiniz yok.");
        let currentProducts = [...db.products];
        let deletedVariantCount = 0;
        let deletedProductCount = 0;

        // Excel'den gelen tüm barkodları bir Set'e alarak hızlı arama yapalım
        const barcodesToDelete = new Set<string>();
        data.forEach((row: any) => {
            const barcode = row['Barkod'] || row['barkod']; // Case insensitive olabilir
            if (barcode) {
                barcodesToDelete.add(String(barcode).trim());
            }
        });

        if (barcodesToDelete.size === 0) {
            setNotification({ type: 'error', message: "Excel dosyasında 'Barkod' sütunu bulunamadı veya boş." });
            return;
        }

        // Ürünleri ve varyantları filtrele
        currentProducts = currentProducts.filter(product => {
            const initialVariantCount = product.variants.length;

            // Silinecek barkoda sahip OLMAYAN varyantları tut
            const keptVariants = product.variants.filter(v => {
                const shouldDelete = v.barcode && barcodesToDelete.has(v.barcode);
                if (shouldDelete) {
                    deletedVariantCount++;
                }
                return !shouldDelete;
            });

            // Ürünün varyantlarını güncelle
            product.variants = keptVariants;

            // Eğer ürünün hiç varyantı kalmadıysa, ürünü de sil (filter'dan false döndür)
            if (keptVariants.length === 0 && initialVariantCount > 0) {
                deletedProductCount++;
                return false;
            }

            return true; // Ürün kalsın
        });

        updateDB({ ...db, products: currentProducts });
        setNotification({ type: 'success', message: `İşlem Tamamlandı:\n${deletedVariantCount} adet varyant (barkod) silindi.\n${deletedProductCount} adet ürün tamamen silindi (hiç varyantı kalmadığı için).` });
    };

    // -------------------------

    const handleAddVariant = (color: string, size: string, barcode: string) => {
        // Barkod tekilliği kontrolü - programın tamamında
        if (barcode !== '') {
            const exists = db.products.some(p => p.variants.some(v => v.barcode === barcode && v.barcode !== ''));
            if (exists) {
                setNotification({ type: 'error', message: "Bu barkod programın tamamında zaten kullanılıyor! Aynı barkod başka bir ürüne veya varyanta eklenemez." });
                return;
            }
            // Aynı ürün içinde de kontrol et
            const existsInCurrent = formData.variants.some(v => v.barcode === barcode && v.barcode !== '');
            if (existsInCurrent) {
                setNotification({ type: 'error', message: "Bu barkod bu ürün içinde zaten kullanılıyor!" });
                return;
            }
        }

        const existingVariant = formData.variants.find(v => v.color === color && v.size === size);
        const initialStocks = existingVariant ? { ...existingVariant.stocks } : {};

        const newVariant: Variant = { id: uuid(), color, size, barcode, stocks: initialStocks };
        setFormData({ ...formData, variants: [...formData.variants, newVariant] });
    };

    const handleUpdateVariantBarcode = (variantId: string, newBarcode: string) => {
        const newVariants = formData.variants.map(v =>
            v.id === variantId ? { ...v, barcode: newBarcode } : v
        );
        setFormData({ ...formData, variants: newVariants });
    };

    const handleValidateVariantBarcode = (variantId: string, barcode: string) => {
        if (barcode === '') return;

        const currentVariant = formData.variants.find(v => v.id === variantId);

        // Programın genelinde (diğer ürünlerde) kontrol et
        const existsInOtherProducts = db.products.some(p =>
            p.id !== formData.id && p.variants.some(v => v.barcode === barcode && v.barcode !== '')
        );

        if (existsInOtherProducts) {
            setNotification({ type: 'error', message: "Bu barkod başka bir üründe zaten kullanılıyor!" });
            handleUpdateVariantBarcode(variantId, '');
            return;
        }

        // Mevcut ürünün içindeki DİĞER varyantlarda kontrol et
        const existsInCurrentProduct = formData.variants.some(v =>
            v.id !== variantId && v.barcode === barcode && v.barcode !== ''
        );

        if (existsInCurrentProduct) {
            setNotification({ type: 'error', message: "Bu barkod bu ürün içinde başka bir varyantta zaten kullanılıyor!" });
            handleUpdateVariantBarcode(variantId, '');
            return;
        }
    };

    const handleUpdateVariantArma = (variantId: string, newArma: string) => {
        const newVariants = formData.variants.map(v =>
            v.id === variantId ? { ...v, arma: newArma || undefined } : v
        );
        setFormData({ ...formData, variants: newVariants });
    };

    const handleDeleteVariant = (variantId: string) => {
        setFormData({ ...formData, variants: formData.variants.filter(v => v.id !== variantId) });
    };

    const handleDuplicateVariant = (variant: Variant) => {
        const newVariant: Variant = {
            ...variant,
            id: uuid(),
            barcode: '', // Kopyalarken barkodu temizle (tekillik için)
            arma: variant.arma,
            costPrice: variant.costPrice,
            salePrice: variant.salePrice,
            stocks: { ...variant.stocks }
        };

        const index = formData.variants.findIndex(v => v.id === variant.id);
        if (index !== -1) {
            const newVariants = [...formData.variants];
            newVariants.splice(index + 1, 0, newVariant);
            setFormData({ ...formData, variants: newVariants });
        } else {
            // Fallback usually shouldn't happen
            setFormData({ ...formData, variants: [...formData.variants, newVariant] });
        }
    };

    const saveNewWarehouse = () => {
        if (newWarehouseName.trim()) {
            const name = newWarehouseName.trim();
            const newWh: Warehouse = { id: uuid(), name };
            const existingWarehouses = (db.warehouses && db.warehouses.length > 0) ? db.warehouses : [{ id: 'wh1', name: 'Merkez Depo' }];
            updateDB({ ...db, warehouses: [...existingWarehouses, newWh] });
            setNotification({ type: 'success', message: `${name} deposu eklendi.` });
            setNewWarehouseName('');
            setIsAddingWarehouse(false);
        }
    };

    const updateStockForGroup = (color: string, size: string, warehouseId: string, qty: number) => {
        // Stok değerini eksiye düşme kontrolü - Ayarlara göre esneklik sağla
        const validQty = db.settings.allowNegativeStock ? qty : Math.max(0, qty);

        const updatedVariants = formData.variants.map(v => {
            if (v.color === color && v.size === size) {
                return { ...v, stocks: { ...v.stocks, [warehouseId]: validQty } };
            }
            return v;
        });
        setFormData({ ...formData, variants: updatedVariants });
    };

    const toggleMarketplaceStatus = async (color: string, size: string, isBlocked: boolean) => {
        // 1. State Güncelle
        const updatedVariants = formData.variants.map(v => {
            if (v.color === color && v.size === size) {
                return { ...v, isMarketplaceDisabled: isBlocked };
            }
            return v;
        });
        setFormData({ ...formData, variants: updatedVariants });

        // 2. Stoğu Anında Gönder (0 veya Gerçek)
        const variantsToSync = updatedVariants.filter(v => v.color === color && v.size === size);

        for (const variant of variantsToSync) {
            if (!variant.barcode) continue;

            const totalStock = Object.values(variant.stocks).reduce((a: number, b: number) => a + b, 0);
            // Bloklandıysa 0 gönder, değilse gerçek stoğu gönder
            const qtyToSend = isBlocked ? 0 : Number(totalStock);
            const settingsToSend = isBlocked ? undefined : db.settings;

            try {
                await syncBarcodeStock(
                    db.apiConfigs,
                    variant.barcode,
                    qtyToSend,
                    settingsToSend,
                    () => setNotification({ type: 'success', message: `${variant.barcode} stok güncelleme başladı...` }),
                    () => setNotification({ type: 'success', message: `${variant.barcode} stok güncellendi.` })
                );
            } catch (err) {
                console.error("Stok switch hatası:", err);
                setNotification({ type: 'error', message: `${variant.barcode} güncellenemedi!` });
            }
        }
    };

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []) as File[];
        if (files.length === 0) return;

        const electron = getElectronBridge();
        if (!electron?.saveProductImage) {
            if (!hasShownDesktopWarning) {
                alert("Görsel yükleme kalıcı kayıt için yalnızca masaüstü uygulamasında kullanılabilir. Lütfen .exe uygulamasını açın.");
                setHasShownDesktopWarning(true);
            }
            if (imageInputRef.current) imageInputRef.current.value = '';
            return;
        }

        if (!formData.productCode || formData.productCode.trim() === '') {
            setNotification({ type: 'error', message: "Görsel yüklemeden önce lütfen geçerli bir Ürün Kodu giriniz!" });
            if (imageInputRef.current) imageInputRef.current.value = '';
            return;
        }

        if (!selectedImageColor) {
            setNotification({ type: 'error', message: "Lütfen önce bir renk seçiniz!" });
            if (imageInputRef.current) imageInputRef.current.value = '';
            return;
        }

        const currentColorVariants = formData.variants.filter(v => v.color === selectedImageColor);
        const existingImages = currentColorVariants[0]?.images || [];

        if (existingImages.length + files.length > 20) {
            setNotification({ type: 'error', message: "Bir renk için en fazla 20 görsel yüklenebilir!" });
            return;
        }

        const validFormats = ['image/png', 'image/jpeg', 'image/jpg'];
        const maxSize = 10 * 1024 * 1024; // 10MB

        const loaders = files.map(file => {
            return new Promise<string>((resolve, reject) => {
                if (!validFormats.includes(file.type)) {
                    setNotification({ type: 'error', message: `${file.name} geçersiz formatta! Sadece PNG, JPG, JPEG desteklenir.` });
                    return resolve('');
                }
                if (file.size > maxSize) {
                    setNotification({ type: 'error', message: `${file.name} 10MB boyut sınırını aşıyor!` });
                    return resolve('');
                }

                const reader = new FileReader();
                reader.onload = async () => {
                    const base64 = reader.result as string;
                    // Prepare filename
                    const ext = file.name.split('.').pop() || 'jpg';
                    const fileName = `img_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.${ext}`;

                    try {
                        const result = await electron.saveProductImage({
                            productCode: formData.productCode,
                            color: selectedImageColor,
                            fileName: fileName,
                            base64Data: base64
                        });

                        if (result.success) {
                            resolve(result.url); // app-img://...
                        } else {
                            setNotification({ type: 'error', message: "Görsel kaydedilemedi: " + result.error });
                            resolve('');
                        }
                    } catch (err) {
                        console.error('Image save error:', err);
                        resolve('');
                    }
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        });

        Promise.all(loaders).then(newImages => {
            const finalNewImages = newImages.filter(img => img !== '');
            if (finalNewImages.length === 0) return;

            setFormData(prev => {
                const variantToUpdate = prev.variants.find(v => v.color === selectedImageColor);
                if (!variantToUpdate) return prev;

                const currentImages = variantToUpdate.images || [];
                const updatedImages = [...currentImages, ...finalNewImages].slice(0, 20);

                const updatedVariants = prev.variants.map(v =>
                    v.color === selectedImageColor ? { ...v, images: updatedImages } : v
                );

                return { ...prev, variants: updatedVariants };
            });

            if (imageInputRef.current) imageInputRef.current.value = '';
        });
    };

    const removeImage = async (color: string, index: number) => {
        const variant = formData.variants.find(v => v.color === color);
        if (!variant || !variant.images) return;

        const imagePath = variant.images[index];

        // Eğer görsel HDD üzerindeyse fiziksel dosyayı da sil
        if (imagePath.startsWith('app-img://')) {
            try {
                const electron = getElectronBridge();
                if (!electron?.deleteProductImage) return;
                await electron.deleteProductImage(imagePath);
            } catch (err) {
                console.error('Delete image file error:', err);
            }
        }

        const updatedVariants = formData.variants.map(v => {
            if (v.color === color && v.images) {
                const newImages = [...v.images];
                newImages.splice(index, 1);
                return { ...v, images: newImages };
            }
            return v;
        });
        setFormData({ ...formData, variants: updatedVariants });
    };

    const openImagesFolder = async (color?: string) => {
        try {
            const electron = getElectronBridge();
            if (!electron?.openProductImagesFolder) {
                setNotification({ type: 'error', message: "Klasör açma özelliği yalnızca masaüstü uygulamasında kullanılabilir." });
                return;
            }

            const result = await electron.openProductImagesFolder({
                productCode: formData.productCode,
                color: color
            });

            if (result && typeof result === 'object' && result.success === false) {
                setNotification({ type: 'error', message: "Klasör açılamadı: " + (result.error || 'Bilinmeyen hata') });
            }
        } catch (err) {
            console.error('Open images folder error:', err);
            setNotification({ type: 'error', message: "Klasör açılırken hata oluştu." });
        }
    };

    return (
        <div className="h-full flex flex-col">
            <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".xlsx, .xls" className="hidden" />
            <input type="file" ref={deleteFileInputRef} onChange={handleDeleteFileChange} accept=".xlsx, .xls" className="hidden" />
            <input type="file" ref={imageInputRef} onChange={handleImageUpload} accept=".png, .jpg, .jpeg" multiple className="hidden" />

            {/* Toolstrip */}
            <div className="flex items-center justify-between mb-2 p-1 bg-gray-100 border-b border-gray-300">
                <div className="flex items-center gap-2">
                    <button onClick={handleOpenAdd} className="desktop-btn desktop-btn-primary">
                        <Plus className="w-3 h-3 mr-1" /> Ürün Ekle
                    </button>
                    <div className="h-4 w-px bg-gray-300 mx-1"></div>
                    <button onClick={handleExport} className="desktop-btn">
                        <FileSpreadsheet className="w-3 h-3 mr-1 text-green-700" /> Excel Rapor (.xlsx)
                    </button>
                    <button onClick={handleManualStockSync} disabled={selectedProductIds.length === 0} className="desktop-btn disabled:text-gray-400">
                        <HardDrive className="w-3 h-3 mr-1 text-blue-600" /> Stok Gönder
                    </button>
                    <button onClick={handleBulkUploadClick} disabled={isUploading} className="desktop-btn">
                        <Upload className="w-3 h-3 mr-1 text-blue-700" /> Toplu Yükle
                    </button>
                    <button onClick={handleDownloadTemplate} className="desktop-btn">
                        <Download className="w-3 h-3 mr-1 text-gray-700" /> Şablon İndir
                    </button>

                    <button
                        onClick={handleBulkDeleteUploadClick}
                        className="desktop-btn text-red-800 border-red-400 bg-red-100 hover:bg-red-200"
                    >
                        <FileMinus className="w-3 h-3 mr-1" />
                        Excel ile Sil
                    </button>
                </div>

                {/* Progress Bar */}
                {isUploading && (
                    <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded">
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-blue-700 font-medium">
                                Ürünler Yükleniyor...
                            </span>
                            <span className="text-xs text-blue-600">
                                {uploadCurrent} / {uploadTotal} ({uploadProgress}%)
                            </span>
                        </div>
                        <div className="w-full bg-blue-100 rounded-full h-2">
                            <div
                                className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-out"
                                style={{ width: `${uploadProgress}%` }}
                            ></div>
                        </div>
                    </div>
                )}
                <div className="flex items-center gap-2 relative">
                    <span className="text-xs text-gray-600">Ölçek:</span>
                    <button
                        onClick={() => setTableZoom(Math.max(0.5, tableZoom - 0.1))}
                        className="desktop-btn text-xs px-2 py-1"
                        title="Küçült"
                    >
                        −
                    </button>
                    <span className="text-xs text-gray-600 min-w-[50px] text-center">{Math.round(tableZoom * 100)}%</span>
                    <button
                        onClick={() => setTableZoom(Math.min(2, tableZoom + 0.1))}
                        className="desktop-btn text-xs px-2 py-1"
                        title="Büyüt"
                    >
                        +
                    </button>
                    <button
                        onClick={() => setTableZoom(1)}
                        className="desktop-btn text-xs px-2 py-1"
                        title="Sıfırla"
                    >
                        100%
                    </button>
                    <div className="h-4 w-px bg-gray-300 mx-1"></div>
                    <span className="text-xs text-gray-600">Ara:</span>
                    <input
                        type="text"
                        className="desktop-input w-48"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                    {exactBarcodeMatch && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setSearchTerm('')}></div>
                            <div className="absolute top-12 left-0 z-50 bg-white border border-blue-300 shadow-xl rounded-lg p-4 w-80 text-sm">
                                <div className="flex justify-between items-start mb-2 border-b pb-2">
                                    <div>
                                        <h4 className="font-bold text-gray-800">{exactBarcodeMatch.product.name}</h4>
                                        <div className="text-xs text-gray-500">{exactBarcodeMatch.variant.barcode} | {exactBarcodeMatch.variant.color} - {exactBarcodeMatch.variant.size}</div>
                                    </div>
                                    <div className="bg-blue-100 text-blue-800 px-2 py-1 rounded font-bold text-xs border border-blue-200">
                                        {exactBarcodeMatch.totalStock} Toplam
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    {(db.warehouses && db.warehouses.length > 0 ? db.warehouses : [{ id: 'wh1', name: 'Merkez Depo' }]).map(wh => {
                                        const qty = exactBarcodeMatch.variant.stocks[wh.id] || 0;
                                        return (
                                            <div key={wh.id} className="flex justify-between items-center bg-gray-50 p-1.5 rounded">
                                                <span className="text-gray-700">{wh.name}</span>
                                                <span className={`font-semibold ${qty > 0 ? 'text-green-600' : 'text-red-500'}`}>{qty} Adet</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>



            {/* DataGrid */}
            <div className="flex-1 overflow-hidden datagrid-container flex flex-col">
                <div className="flex-1 overflow-auto" style={{ zoom: tableZoom }}>
                    <table className="datagrid">
                        <thead>
                            <tr>
                                <th className="w-8 text-center">
                                    <input
                                        type="checkbox"
                                        onChange={(e) => {
                                            if (e.target.checked) setSelectedProductIds(paginatedProducts.map(p => p.id));
                                            else setSelectedProductIds([]);
                                        }}
                                        checked={paginatedProducts.length > 0 && selectedProductIds.length === paginatedProducts.length}
                                    />
                                </th>
                                <th style={{ width: '120px' }}>Ürün Kodu</th>
                                <th>Ürün Adı</th>
                                {db.settings.showProductImages && (
                                    <th style={{ width: '550px', textAlign: 'center' }}>
                                        <div className="flex items-center justify-center gap-1">
                                            <ImageIcon size={14} />
                                            Görseller
                                            <button
                                                onClick={() => updateDB({
                                                    ...db,
                                                    settings: { ...db.settings, showProductImages: false }
                                                })}
                                                className="ml-1 text-gray-400 hover:text-red-500"
                                                title="Sütunu Gizle"
                                            >
                                                <X size={10} />
                                            </button>
                                        </div>
                                    </th>
                                )}
                                <th style={{ width: '80px' }}>Marka</th>
                                <th style={{ width: '100px' }}>Grup</th>
                                <th style={{ width: '80px', textAlign: 'center' }}>Stok</th>
                                <th style={{ width: '80px' }}>Tarih</th>
                                <th style={{ width: '100px', textAlign: 'center' }}>İşlemler</th>
                            </tr>
                        </thead>
                        <tbody>
                            {paginatedProducts.map((product) => {
                                const totalStock = calculateRealTotalStock(product);
                                return (
                                    <tr
                                        key={product.id}
                                        className={`${selectedProductIds.includes(product.id) ? 'bg-blue-50' : 'hover:bg-gray-50 cursor-pointer'}`}
                                        onDoubleClick={() => handleEdit(product)}
                                    >
                                        <td className="text-center">
                                            <input
                                                type="checkbox"
                                                checked={selectedProductIds.includes(product.id)}
                                                onChange={(e) => {
                                                    if (e.target.checked) setSelectedProductIds([...selectedProductIds, product.id]);
                                                    else setSelectedProductIds(selectedProductIds.filter(id => id !== product.id));
                                                }}
                                            />
                                        </td>
                                        <td>{product.productCode}</td>
                                        <td>{product.name}</td>
                                        {db.settings.showProductImages && (
                                            <td className="p-1">
                                                <div className="flex flex-wrap gap-1 justify-center max-w-[540px]">
                                                    {product.variants.reduce((acc: any[], v) => {
                                                        if (v.images && v.images.length > 0 && !acc.find(x => x.color === v.color)) {
                                                            acc.push({ color: v.color, url: v.mainImage || v.images[0] });
                                                        }
                                                        return acc;
                                                    }, []).map((img, idx) => (
                                                        <div
                                                            key={idx}
                                                            className="w-8 h-8 rounded border bg-white overflow-hidden cursor-pointer hover:scale-110 transition-transform shadow-sm relative group"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                // Tüm görselleri topla ve tekilleştir
                                                                const seenUrls = new Set<string>();
                                                                const allImgs: { url: string, color: string }[] = [];
                                                                product.variants.forEach(v => {
                                                                    if (v.images) {
                                                                        v.images.forEach(u => {
                                                                            if (!seenUrls.has(u)) {
                                                                                seenUrls.add(u);
                                                                                allImgs.push({ url: u, color: v.color });
                                                                            }
                                                                        });
                                                                    }
                                                                });
                                                                setAllGalleryImages(allImgs);
                                                                const startIdx = allImgs.findIndex(x => x.url === img.url);
                                                                setCurrentGalleryIndex(startIdx >= 0 ? startIdx : 0);
                                                                setPreviewImage(img.url);
                                                                setPreviewImageColor(img.color);
                                                            }}
                                                        >
                                                            <img src={img.url} alt="" className="w-full h-full object-cover" />
                                                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                                <span className="text-[6px] text-white font-bold uppercase text-center leading-tight px-0.5">{img.color}</span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </td>
                                        )}
                                        <td>{product.brand}</td>
                                        <td>{product.group}</td>
                                        <td className="text-center font-bold">{totalStock}</td>
                                        <td>{product.date ? product.date.split('-').reverse().join('.') : ''}</td>
                                        <td className="text-center">
                                            <button onClick={() => handleEdit(product)} className="text-blue-600 hover:text-blue-800 mr-2" title="Düzenle"><Edit size={14} /></button>
                                            {userRole === UserRole.ADMIN && (
                                                <button onClick={() => handleDelete(product.id)} className="text-red-600 hover:text-red-800" title="Sil"><Trash2 size={14} /></button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                    <div className="bg-white border-t border-gray-300 p-2 flex items-center justify-between select-none">
                        <div className="text-xs text-gray-500">
                            Toplam <strong>{allFilteredProducts.length}</strong> üründen <strong>{(currentPage - 1) * itemsPerPage + 1}-{Math.min(currentPage * itemsPerPage, allFilteredProducts.length)}</strong> arası gösteriliyor
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                                disabled={currentPage === 1}
                                className="p-1 px-2 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-white transition-colors"
                            >
                                <ChevronLeft size={16} />
                            </button>

                            {/* Page Numbers */}
                            <div className="flex items-center gap-1">
                                {Array.from({ length: totalPages }, (_, i) => i + 1)
                                    .filter(p => {
                                        // Show first, last, current, and surrounding pages
                                        return p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2;
                                    })
                                    .reduce((acc: (number | string)[], p, i, arr) => {
                                        if (i > 0 && p !== (arr[i - 1] as number) + 1) {
                                            acc.push('...');
                                        }
                                        acc.push(p);
                                        return acc;
                                    }, [])
                                    .map((p, idx) => (
                                        typeof p === 'number' ? (
                                            <button
                                                key={idx}
                                                onClick={() => setCurrentPage(p)}
                                                className={`min-w-[28px] h-7 flex items-center justify-center text-xs font-medium border rounded transition-colors ${currentPage === p ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'}`}
                                            >
                                                {p}
                                            </button>
                                        ) : (
                                            <span key={idx} className="px-1 text-gray-400">...</span>
                                        )
                                    ))
                                }
                            </div>

                            <button
                                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                                disabled={currentPage === totalPages}
                                className="p-1 px-2 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-white transition-colors"
                            >
                                <ChevronRight size={16} />
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Modal ... (Remaining Code Same) */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[9999] backdrop-blur-[1px]">
                    <div className="bg-[#f0f0f0] border border-gray-500 shadow-2xl w-[1100px] h-[80vh] flex flex-col font-sans text-sm relative">
                        {/* Modal Title Bar */}
                        <div className="h-8 bg-white border-b border-gray-300 flex justify-between items-center px-3 select-none">
                            <span className="font-semibold text-gray-800">{editingProduct ? 'Ürün Kartı Düzenle' : 'Yeni Ürün Kartı'}</span>
                            <button onClick={() => setIsModalOpen(false)} className="hover:bg-red-500 hover:text-white px-2 py-1"><div className="text-lg leading-none">×</div></button>
                        </div>

                        <div className="flex-1 overflow-auto p-2 flex gap-2">
                            {/* Left Pane */}
                            <div className="w-1/3 flex flex-col gap-2 border-r border-gray-300 pr-2 bg-white p-2 border">
                                <div className="bg-gray-100 p-1 font-bold border-b border-gray-300 text-gray-700">Genel Bilgiler</div>
                                <div className="grid grid-cols-1 gap-2">
                                    <div>
                                        <label className="block text-xs text-gray-500">Ürün Kodu</label>
                                        <input className="desktop-input w-full" value={formData.productCode} onChange={e => setFormData({ ...formData, productCode: e.target.value })} autoFocus={false} />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-gray-500">Ürün Adı</label>
                                        <input className="desktop-input w-full" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} />
                                    </div>
                                    <div className="flex gap-2">
                                        <div className="flex-1">
                                            <label className="block text-xs text-gray-500">Marka</label>
                                            <input className="desktop-input w-full" value={formData.brand} onChange={e => setFormData({ ...formData, brand: e.target.value })} />
                                        </div>
                                        <div className="flex-1">
                                            <label className="block text-xs text-gray-500">Grup</label>
                                            <input className="desktop-input w-full" value={formData.group} onChange={e => setFormData({ ...formData, group: e.target.value })} />
                                        </div>
                                    </div>
                                    <div></div>                                    <div>
                                        <label className="block text-xs text-gray-500">Kayıt Tarihi</label>
                                        <input className="desktop-input w-full disabled:bg-gray-100 disabled:text-gray-500" type="date" value={formData.date} disabled={true} />
                                    </div>
                                </div>
                            </div>

                            {/* Right Pane */}
                            <div className="w-2/3 flex flex-col bg-white border border-gray-300">
                                <div className="bg-gray-100 border-b border-gray-300 flex">
                                    <button
                                        onClick={() => setActiveSubPanel('barcode')}
                                        className={`px-4 py-1.5 text-xs font-medium border-r border-gray-300 ${activeSubPanel === 'barcode' ? 'bg-white text-blue-700 border-t-2 border-t-blue-600' : 'text-gray-600 hover:bg-gray-200'}`}
                                    >
                                        Barkod / Varyant
                                    </button>
                                    <button
                                        onClick={() => setActiveSubPanel('stock')}
                                        className={`px-4 py-1.5 text-xs font-medium border-r border-gray-300 ${activeSubPanel === 'stock' ? 'bg-white text-blue-700 border-t-2 border-t-blue-600' : 'text-gray-600 hover:bg-gray-200'}`}
                                    >
                                        Stok ve Fiyat
                                    </button>
                                    <button
                                        onClick={() => {
                                            setActiveSubPanel('images');
                                            if (!selectedImageColor && formData.variants.length > 0) {
                                                setSelectedImageColor(formData.variants[0].color);
                                            }
                                        }}
                                        className={`px-4 py-1.5 text-xs font-medium border-r border-gray-300 ${activeSubPanel === 'images' ? 'bg-white text-blue-700 border-t-2 border-t-blue-600' : 'text-gray-600 hover:bg-gray-200'}`}
                                    >
                                        Görseller
                                    </button>
                                </div>

                                <div className="flex-1 p-2 bg-gray-50 overflow-auto">
                                    {activeSubPanel === 'barcode' && (
                                        <div className="flex flex-col h-full">
                                            <div className="flex gap-2 mb-2 p-2 bg-gray-200 border border-gray-300 items-end">
                                                <div className="flex gap-2 items-end flex-wrap">
                                                    <div>
                                                        <label className="text-xs block">Renk</label>
                                                        <input id="newColor" className="desktop-input w-24" />
                                                    </div>
                                                    <div>
                                                        <label className="text-xs block">Beden</label>
                                                        <input id="newSize" className="desktop-input w-16" />
                                                    </div>
                                                    <div>
                                                        <label className="text-xs block">Barkod</label>
                                                        <input id="newBarcode" className="desktop-input w-32" />
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            const c = (document.getElementById('newColor') as HTMLInputElement).value;
                                                            const s = (document.getElementById('newSize') as HTMLInputElement).value;
                                                            const b = (document.getElementById('newBarcode') as HTMLInputElement).value;
                                                            if (c && s) {
                                                                handleAddVariant(c, s, b);
                                                                (document.getElementById('newColor') as HTMLInputElement).value = '';
                                                                (document.getElementById('newSize') as HTMLInputElement).value = '';
                                                                (document.getElementById('newBarcode') as HTMLInputElement).value = '';
                                                            }
                                                        }}
                                                        className="desktop-btn desktop-btn-primary h-[26px]"
                                                    >Ekle</button>
                                                </div>
                                            </div>
                                            <div
                                                className="flex-1 border border-gray-400 bg-white overflow-auto"
                                                onScroll={(e) => setBarcodeScrollTop((e.target as HTMLDivElement).scrollTop)}
                                            >
                                                <table className="datagrid" style={{ tableLayout: 'fixed' }}>
                                                    <thead>
                                                        <tr>
                                                            <th style={{ width: '120px' }} className="p-1 cursor-pointer hover:bg-gray-200 select-none" onClick={() => {
                                                                if (variantSortBy === 'color') setVariantSortOrder(variantSortOrder === 'asc' ? 'desc' : 'asc');
                                                                else { setVariantSortBy('color'); setVariantSortOrder('asc'); }
                                                            }}>
                                                                <div className="flex flex-col">
                                                                    <div className="flex items-center justify-between">
                                                                        <span>Renk</span>
                                                                        {variantSortBy === 'color' && (variantSortOrder === 'asc' ? '▴' : '▾')}
                                                                    </div>
                                                                    <input
                                                                        placeholder="Ara..."
                                                                        className="w-full text-xs p-0.5 border border-gray-300 rounded text-black font-normal mt-1"
                                                                        value={variantFilterColor}
                                                                        onChange={e => { e.stopPropagation(); setVariantFilterColor(e.target.value); }}
                                                                        onClick={e => e.stopPropagation()}
                                                                    />
                                                                </div>
                                                            </th>
                                                            <th style={{ width: '80px' }} className="p-1 cursor-pointer hover:bg-gray-200 select-none" onClick={() => {
                                                                if (variantSortBy === 'size') setVariantSortOrder(variantSortOrder === 'asc' ? 'desc' : 'asc');
                                                                else { setVariantSortBy('size'); setVariantSortOrder('asc'); }
                                                            }}>
                                                                <div className="flex flex-col">
                                                                    <div className="flex items-center justify-between">
                                                                        <span>Beden</span>
                                                                        {variantSortBy === 'size' && (variantSortOrder === 'asc' ? '▴' : '▾')}
                                                                    </div>
                                                                    <input
                                                                        placeholder="Ara..."
                                                                        className="w-full text-xs p-0.5 border border-gray-300 rounded text-black font-normal mt-1"
                                                                        value={variantFilterSize}
                                                                        onChange={e => { e.stopPropagation(); setVariantFilterSize(e.target.value); }}
                                                                        onClick={e => e.stopPropagation()}
                                                                    />
                                                                </div>
                                                            </th>
                                                            <th style={{ width: '200px' }} className="p-1 cursor-pointer hover:bg-gray-200 select-none" onClick={() => {
                                                                if (variantSortBy === 'barcode') setVariantSortOrder(variantSortOrder === 'asc' ? 'desc' : 'asc');
                                                                else { setVariantSortBy('barcode'); setVariantSortOrder('asc'); }
                                                            }}>
                                                                <div className="flex flex-col">
                                                                    <div className="flex items-center justify-between">
                                                                        <span>Barkod</span>
                                                                        {variantSortBy === 'barcode' && (variantSortOrder === 'asc' ? '▴' : '▾')}
                                                                    </div>
                                                                    <input
                                                                        placeholder="Ara..."
                                                                        className="w-full text-xs p-0.5 border border-gray-300 rounded text-black font-normal mt-1"
                                                                        value={variantFilterBarcode}
                                                                        onChange={e => { e.stopPropagation(); setVariantFilterBarcode(e.target.value); }}
                                                                        onClick={e => e.stopPropagation()}
                                                                    />
                                                                </div>
                                                            </th>
                                                            <th style={{ width: '80px', textAlign: 'right' }}>İşlem</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {(() => {
                                                            const startIndex = Math.max(0, Math.floor(barcodeScrollTop / rowHeight) - buffer);
                                                            const endIndex = Math.min(modalVariantsList.length, Math.floor((barcodeScrollTop + (visibleRows * rowHeight)) / rowHeight) + buffer);

                                                            const paddingTop = startIndex * rowHeight;
                                                            const paddingBottom = (modalVariantsList.length - endIndex) * rowHeight;

                                                            return (
                                                                <>
                                                                    {paddingTop > 0 && <tr style={{ height: paddingTop }}><td colSpan={4} style={{ padding: 0, border: 0 }}></td></tr>}
                                                                    {modalVariantsList.slice(startIndex, endIndex).map(v => (
                                                                        <tr key={v.id} style={{ height: rowHeight }}>
                                                                            <td>{v.color}</td>
                                                                            <td>{v.size}</td>
                                                                            <td className="p-0">
                                                                                <input
                                                                                    type="text"
                                                                                    className="w-full h-full border-0 px-2 bg-transparent focus:bg-blue-50 outline-none text-gray-800"
                                                                                    value={v.barcode}
                                                                                    onChange={(e) => handleUpdateVariantBarcode(v.id, e.target.value)}
                                                                                    onBlur={(e) => handleValidateVariantBarcode(v.id, e.target.value)}
                                                                                />
                                                                            </td>
                                                                            <td className="text-right px-2">
                                                                                <button
                                                                                    onClick={() => handleDuplicateVariant(v)}
                                                                                    className="text-blue-600 hover:text-blue-800 mr-3 inline-flex items-center"
                                                                                    title="Kopyala"
                                                                                >
                                                                                    <Copy size={16} />
                                                                                </button>
                                                                                <button
                                                                                    onClick={() => handleDeleteVariant(v.id)}
                                                                                    className="text-red-600 hover:text-red-800 inline-flex items-center"
                                                                                    title="Sil"
                                                                                >
                                                                                    <Trash2 size={16} />
                                                                                </button>
                                                                            </td>
                                                                        </tr>
                                                                    ))}
                                                                    {paddingBottom > 0 && <tr style={{ height: paddingBottom }}><td colSpan={4} style={{ padding: 0, border: 0 }}></td></tr>}
                                                                </>
                                                            );
                                                        })()}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}

                                    {activeSubPanel === 'stock' && (
                                        <div className="flex flex-col h-full">
                                            <div className="mb-2 p-2 bg-gray-200 border border-gray-300 flex justify-between items-center h-10 gap-2">
                                                <div className="text-[10px] font-bold text-gray-600 uppercase">Stok ve Fiyat Yönetimi</div>
                                                <div className="flex gap-2 items-center">
                                                    <button
                                                        onClick={() => setIsAddingWarehouse(true)}
                                                        className="desktop-btn bg-purple-100 text-purple-700 border-purple-300 flex items-center"
                                                    ><Plus size={14} className="mr-1" />Depo Ekle</button>
                                                    <input
                                                        type="number"
                                                        placeholder="Miktar/Fiyat..."
                                                        className="h-[26px] w-28 border border-gray-400 px-2 rounded text-xs outline-none focus:border-blue-500"
                                                        value={bulkValue}
                                                        onChange={(e) => setBulkValue(e.target.value)}
                                                    />
                                                    <button
                                                        onClick={() => {
                                                            if (bulkValue === '') return;
                                                            const costVal = Number(bulkValue);
                                                            setFormData(prev => ({
                                                                ...prev,
                                                                variants: prev.variants.map(v => ({
                                                                    ...v,
                                                                    costPrice: costVal
                                                                }))
                                                            }));
                                                            setNotification({ type: 'success', message: `Tüm varyantların maliyetleri ${costVal} olarak güncellendi.` });
                                                        }}
                                                        className="desktop-btn bg-amber-100 text-amber-700 border-amber-300"
                                                    >Toplu Maliyet</button>
                                                    <button
                                                        onClick={() => {
                                                            if (bulkValue === '') return;
                                                            const saleVal = Number(bulkValue);
                                                            setFormData(prev => ({
                                                                ...prev,
                                                                variants: prev.variants.map(v => ({
                                                                    ...v,
                                                                    salePrice: saleVal
                                                                }))
                                                            }));
                                                            setNotification({ type: 'success', message: `Tüm varyantların PSF'leri ${saleVal} olarak güncellendi.` });
                                                        }}
                                                        className="desktop-btn bg-green-100 text-green-700 border-green-300"
                                                    >Toplu PSF</button>
                                                    <button
                                                        onClick={() => {
                                                            if (bulkValue === '') return;
                                                            const stockVal = Number(bulkValue);
                                                            const targetWhId = db.warehouses[0]?.id || 'wh1';
                                                            setFormData(prev => ({
                                                                ...prev,
                                                                variants: prev.variants.map(v => ({
                                                                    ...v,
                                                                    stocks: { ...v.stocks, [targetWhId]: stockVal }
                                                                }))
                                                            }));
                                                            setNotification({ type: 'success', message: `Tüm varyantların stokları ${stockVal} olarak güncellendi.` });
                                                        }}
                                                        className="desktop-btn bg-blue-100 text-blue-700 border-blue-300"
                                                    >Toplu Envanter</button>
                                                </div>
                                            </div>
                                            <div
                                                className="flex-1 border border-gray-400 bg-white overflow-auto"
                                                onScroll={(e) => setStockScrollTop((e.target as HTMLDivElement).scrollTop)}
                                            >
                                                <table className="datagrid" style={{ tableLayout: 'fixed', minWidth: '100%' }}>
                                                    <thead>
                                                        <tr>
                                                            <th style={{ width: '40px' }} className="text-center" title="İnternet Satışına Kapat"><Globe size={14} className="mx-auto" /></th>
                                                            <th
                                                                style={{ width: '180px' }}
                                                                className="cursor-pointer hover:bg-gray-200 select-none"
                                                                onClick={() => setVariantStockSortOrder(variantStockSortOrder === 'asc' ? 'desc' : 'asc')}
                                                            >
                                                                <div className="flex items-center justify-between">
                                                                    <span className="truncate">Varyant</span>
                                                                    <span>{variantStockSortOrder === 'asc' ? '▴' : '▾'}</span>
                                                                </div>
                                                            </th>
                                                            <th style={{ width: '80px', textAlign: 'right' }}>Maliyet</th>
                                                            <th style={{ width: '80px', textAlign: 'right' }}>PSF</th>
                                                            {(db.warehouses && db.warehouses.length > 0 ? db.warehouses : [{ id: 'wh1', name: 'Merkez Depo' }]).map(w => (
                                                                <th key={w.id} style={{ width: '130px', textAlign: 'center' }}>
                                                                    <div className="truncate" title={w.name}>{db.warehouses?.length > 1 ? `ENV. (${w.name})` : `ENV. (${w.name})`}</div>
                                                                </th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {(() => {
                                                            const startIndex = Math.max(0, Math.floor(stockScrollTop / rowHeight) - buffer);
                                                            const endIndex = Math.min(modalStockList.length, Math.floor((stockScrollTop + (visibleRows * rowHeight)) / rowHeight) + buffer);

                                                            const paddingTop = startIndex * rowHeight;
                                                            const paddingBottom = (modalStockList.length - endIndex) * rowHeight;

                                                            return (
                                                                <>
                                                                    {paddingTop > 0 && <tr style={{ height: paddingTop }}><td colSpan={(db.warehouses && db.warehouses.length > 0 ? db.warehouses.length : 1) + 4} style={{ padding: 0, border: 0 }}></td></tr>}
                                                                    {modalStockList.slice(startIndex, endIndex).map(([key, v]) => {
                                                                        const rowTotal = Object.values(v.stocks).reduce((a: number, b: number) => a + b, 0);
                                                                        return (
                                                                            <tr key={key} style={{ height: rowHeight }}>
                                                                                <td className="text-center">
                                                                                    <input
                                                                                        type="checkbox"
                                                                                        checked={!!v.isMarketplaceDisabled}
                                                                                        title={v.isMarketplaceDisabled ? "İnternet satışı KAPALI (Stok: 0 gönderiliyor)" : "İnternet satışı AÇIK"}
                                                                                        onChange={(e) => toggleMarketplaceStatus(v.color, v.size, e.target.checked)}
                                                                                        className="cursor-pointer"
                                                                                    />
                                                                                </td>
                                                                                <td className="whitespace-nowrap overflow-hidden text-ellipsis">{v.color} / {v.size}</td>
                                                                                <td className="p-0">
                                                                                    <input
                                                                                        type="number"
                                                                                        className="w-full h-full border-0 px-2 bg-transparent focus:bg-blue-50 outline-none text-gray-800 text-right font-mono"
                                                                                        value={v.costPrice || 0}
                                                                                        onChange={(e) => {
                                                                                            const val = Number(e.target.value);
                                                                                            setFormData({
                                                                                                ...formData,
                                                                                                variants: formData.variants.map(vv => (vv.color === v.color && vv.size === v.size) ? { ...vv, costPrice: val } : vv)
                                                                                            });
                                                                                        }}
                                                                                    />
                                                                                </td>
                                                                                <td className="p-0">
                                                                                    <input
                                                                                        type="number"
                                                                                        className="w-full h-full border-0 px-2 bg-transparent focus:bg-blue-50 outline-none text-gray-800 text-right font-mono"
                                                                                        value={v.salePrice || 0}
                                                                                        onChange={(e) => {
                                                                                            const val = Number(e.target.value);
                                                                                            setFormData({
                                                                                                ...formData,
                                                                                                variants: formData.variants.map(vv => (vv.color === v.color && vv.size === v.size) ? { ...vv, salePrice: val } : vv)
                                                                                            });
                                                                                        }}
                                                                                    />
                                                                                </td>
                                                                                {(db.warehouses && db.warehouses.length > 0 ? db.warehouses : [{ id: 'wh1', name: 'Merkez Depo' }]).map(w => (
                                                                                    <td key={w.id} className="text-center p-0">
                                                                                        <input
                                                                                            type="number"
                                                                                            className="w-full h-full border-0 text-center outline-none focus:bg-blue-50"
                                                                                            value={v.stocks ? (v.stocks[w.id] || 0) : 0}
                                                                                            onChange={(e) => updateStockForGroup(v.color, v.size, w.id, Number(e.target.value))}
                                                                                        />
                                                                                    </td>
                                                                                ))}
                                                                            </tr>
                                                                        );
                                                                    })}
                                                                    {paddingBottom > 0 && <tr style={{ height: paddingBottom }}><td colSpan={(db.warehouses && db.warehouses.length > 0 ? db.warehouses.length : 1) + 4} style={{ padding: 0, border: 0 }}></td></tr>}
                                                                </>
                                                            );
                                                        })()}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}

                                    {activeSubPanel === 'images' && (
                                        <div className="flex flex-col h-full bg-white border border-gray-200 rounded-md overflow-hidden">
                                            <div className="flex border-b border-gray-200">
                                                <div className="w-1/3 border-r border-gray-200 p-2 bg-gray-50 overflow-y-auto max-h-[400px]">
                                                    <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Renk Seçin</p>
                                                    <div className="space-y-1">
                                                        {Array.from(new Set(formData.variants.map(v => v.color))).map(color => (
                                                            <button
                                                                key={color}
                                                                onClick={() => setSelectedImageColor(color)}
                                                                className={`w-full text-left px-3 py-2 text-xs rounded transition-colors ${selectedImageColor === color ? 'bg-blue-600 text-white font-bold' : 'hover:bg-gray-200 text-gray-700 border border-transparent'}`}
                                                            >
                                                                {color}
                                                                <span className="float-right text-[10px] opacity-70">
                                                                    {(formData.variants.find(v => v.color === color)?.images || []).length} / 20
                                                                </span>
                                                            </button>
                                                        ))}
                                                        {formData.variants.length === 0 && (
                                                            <p className="text-xs text-gray-400 italic p-2">Önce varyant ekleyin</p>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="w-2/3 p-4 flex flex-col">
                                                    {selectedImageColor ? (
                                                        <>
                                                            <div className="flex justify-between items-center mb-4">
                                                                <div>
                                                                    <h4 className="font-bold text-gray-800 text-sm">{selectedImageColor} Görselleri</h4>
                                                                    <p className="text-[10px] text-gray-500">Maksimum 20 görsel, PNG/JPG, Maks. 10MB</p>
                                                                </div>
                                                                <div className="flex gap-2">
                                                                    <button
                                                                        onClick={() => imageInputRef.current?.click()}
                                                                        className="desktop-btn desktop-btn-primary"
                                                                        disabled={(formData.variants.find(v => v.color === selectedImageColor)?.images || []).length >= 20}
                                                                    >
                                                                        <Plus size={14} className="mr-1" /> Görsel Yükle
                                                                    </button>
                                                                    <button
                                                                        onClick={() => openImagesFolder(selectedImageColor)}
                                                                        className="desktop-btn bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"
                                                                        title="Klasörü Windows'ta Aç"
                                                                    >
                                                                        <FolderOpen size={14} className="mr-1" /> Klasörü Aç
                                                                    </button>
                                                                </div>
                                                            </div>

                                                            <div className="flex-1 overflow-y-auto">
                                                                <div className="grid grid-cols-4 gap-2">
                                                                    {(formData.variants.find(v => v.color === selectedImageColor)?.images || []).map((img, idx) => {
                                                                        const variant = formData.variants.find(v => v.color === selectedImageColor);
                                                                        const isMain = variant?.mainImage === img || (!variant?.mainImage && idx === 0);

                                                                        return (
                                                                            <div key={idx} className={`group relative aspect-square border-2 ${isMain ? 'border-blue-500 shadow-md' : 'border-gray-100'} rounded-lg overflow-hidden bg-gray-50`}>
                                                                                <img
                                                                                    src={img}
                                                                                    alt=""
                                                                                    className="w-full h-full object-cover cursor-zoom-in"
                                                                                    onClick={() => {
                                                                                        const seenUrls = new Set<string>();
                                                                                        const allImgs: { url: string, color: string }[] = [];
                                                                                        formData.variants.forEach(v => {
                                                                                            if (v.images) {
                                                                                                v.images.forEach(u => {
                                                                                                    if (!seenUrls.has(u)) {
                                                                                                        seenUrls.add(u);
                                                                                                        allImgs.push({ url: u, color: v.color });
                                                                                                    }
                                                                                                });
                                                                                            }
                                                                                        });
                                                                                        setAllGalleryImages(allImgs);
                                                                                        const startIdx = allImgs.findIndex(x => x.url === img);
                                                                                        setCurrentGalleryIndex(startIdx >= 0 ? startIdx : 0);
                                                                                        setPreviewImage(img);
                                                                                        setPreviewImageColor(selectedImageColor);
                                                                                    }}
                                                                                />
                                                                                <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                                    {!isMain && (
                                                                                        <button
                                                                                            onClick={() => {
                                                                                                setFormData(prev => ({
                                                                                                    ...prev,
                                                                                                    variants: prev.variants.map(v => v.color === selectedImageColor ? { ...v, mainImage: img } : v)
                                                                                                }));
                                                                                            }}
                                                                                            className="p-1 bg-blue-600 text-white rounded shadow-lg hover:bg-blue-700"
                                                                                            title="Ana Görsel Yap"
                                                                                        >
                                                                                            <Check size={10} />
                                                                                        </button>
                                                                                    )}
                                                                                    <button
                                                                                        onClick={() => removeImage(selectedImageColor, idx)}
                                                                                        className="p-1 bg-red-600 text-white rounded shadow-lg hover:bg-red-700"
                                                                                        title="Sil"
                                                                                    >
                                                                                        <X size={10} />
                                                                                    </button>
                                                                                </div>

                                                                                {/* Move buttons */}
                                                                                <div className="absolute bottom-1 left-1 right-1 flex justify-between opacity-0 group-hover:opacity-100 transition-opacity">
                                                                                    <button
                                                                                        disabled={idx === 0}
                                                                                        onClick={() => {
                                                                                            const variant = formData.variants.find(v => v.color === selectedImageColor);
                                                                                            if (!variant || !variant.images) return;
                                                                                            const newImgs = [...variant.images];
                                                                                            [newImgs[idx], newImgs[idx - 1]] = [newImgs[idx - 1], newImgs[idx]];
                                                                                            setFormData(prev => ({
                                                                                                ...prev,
                                                                                                variants: prev.variants.map(v => v.color === selectedImageColor ? { ...v, images: newImgs } : v)
                                                                                            }));
                                                                                        }}
                                                                                        className="bg-black/60 text-white p-0.5 rounded hover:bg-black disabled:opacity-30"
                                                                                    >
                                                                                        <ChevronLeft size={10} />
                                                                                    </button>
                                                                                    <span className="text-[8px] bg-black/60 text-white px-1 rounded flex items-center">{idx + 1}</span>
                                                                                    <button
                                                                                        disabled={idx === (variant?.images?.length || 0) - 1}
                                                                                        onClick={() => {
                                                                                            const variant = formData.variants.find(v => v.color === selectedImageColor);
                                                                                            if (!variant || !variant.images) return;
                                                                                            const newImgs = [...variant.images];
                                                                                            [newImgs[idx], newImgs[idx + 1]] = [newImgs[idx + 1], newImgs[idx]];
                                                                                            setFormData(prev => ({
                                                                                                ...prev,
                                                                                                variants: prev.variants.map(v => v.color === selectedImageColor ? { ...v, images: newImgs } : v)
                                                                                            }));
                                                                                        }}
                                                                                        className="bg-black/60 text-white p-0.5 rounded hover:bg-black disabled:opacity-30"
                                                                                    >
                                                                                        <ChevronRight size={10} />
                                                                                    </button>
                                                                                </div>

                                                                                {isMain && (
                                                                                    <div className="absolute top-0 left-0 bg-blue-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-br shadow">
                                                                                        ANA GÖRSEL
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    })}

                                                                    {(formData.variants.find(v => v.color === selectedImageColor)?.images || []).length === 0 && (
                                                                        <div
                                                                            onClick={() => imageInputRef.current?.click()}
                                                                            className="col-span-4 border-2 border-dashed border-gray-300 rounded-xl h-40 flex flex-col items-center justify-center text-gray-400 hover:border-blue-400 hover:text-blue-400 cursor-pointer transition-all bg-gray-50"
                                                                        >
                                                                            <Upload size={32} className="mb-2 opacity-50" />
                                                                            <p className="text-xs font-medium">Bu renk için henüz görsel yüklenmemiş</p>
                                                                            <p className="text-[10px] opacity-70">Görsel yüklemek için tıklayın</p>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <div className="flex flex-col items-center justify-center h-full text-gray-400">
                                                            <ImageIcon size={48} className="mb-2 opacity-20" />
                                                            <p className="text-xs font-medium">Görsel yönetimi için bir renk seçin</p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="p-3 border-t border-gray-300 bg-gray-100 flex justify-end gap-2">
                            <button onClick={() => setIsModalOpen(false)} className="desktop-btn w-24">İptal</button>
                            <button onClick={handleSaveProduct} className="desktop-btn desktop-btn-primary w-24">Kaydet</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Hidden Input for Image Upload */}
            <input
                type="file"
                ref={imageInputRef}
                className="hidden"
                accept="image/png,image/jpeg,image/jpg"
                multiple
                onChange={handleImageUpload}
            />
            {/* Image Preview Modal (Lightbox) */}
            {previewImage && (
                <div
                    className="fixed inset-0 bg-black/90 flex flex-col items-center justify-center z-[10000] p-4 animate-in fade-in duration-300"
                    onClick={() => setPreviewImage(null)}
                >
                    {/* Header Info */}
                    <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-center bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
                        <div>
                            <h3 className="text-white font-extrabold text-xl flex items-center gap-2">
                                <ImageIcon size={24} className="text-blue-400" />
                                {previewImageColor}
                            </h3>
                            <p className="text-gray-300 text-xs font-bold uppercase tracking-widest mt-1">
                                Görsel {currentGalleryIndex + 1} / {allGalleryImages.length}
                            </p>
                        </div>
                        <button
                            onClick={() => setPreviewImage(null)}
                            className="p-3 bg-white/10 hover:bg-white/20 text-white rounded-full transition-all pointer-events-auto"
                        >
                            <X size={28} />
                        </button>
                    </div>

                    {/* Navigation Buttons */}
                    {allGalleryImages.length > 1 && (
                        <>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const newIdx = (currentGalleryIndex - 1 + allGalleryImages.length) % allGalleryImages.length;
                                    setCurrentGalleryIndex(newIdx);
                                    setPreviewImage(allGalleryImages[newIdx].url);
                                    setPreviewImageColor(allGalleryImages[newIdx].color);
                                }}
                                className="absolute left-8 p-6 text-white hover:text-blue-400 transition-colors pointer-events-auto group bg-black/20 rounded-full hover:bg-black/40"
                            >
                                <ChevronLeft size={64} className="group-hover:scale-110 transition-transform" />
                            </button>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const newIdx = (currentGalleryIndex + 1) % allGalleryImages.length;
                                    setCurrentGalleryIndex(newIdx);
                                    setPreviewImage(allGalleryImages[newIdx].url);
                                    setPreviewImageColor(allGalleryImages[newIdx].color);
                                }}
                                className="absolute right-8 p-6 text-white hover:text-blue-400 transition-colors pointer-events-auto group bg-black/20 rounded-full hover:bg-black/40"
                            >
                                <ChevronRight size={64} className="group-hover:scale-110 transition-transform" />
                            </button>
                        </>
                    )}

                    {/* Main Image */}
                    <div
                        className="relative max-w-5xl max-h-full p-4 pointer-events-none flex items-center justify-center transform transition-all duration-300"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <img
                            src={previewImage}
                            className="max-sm:w-full max-h-[85vh] shadow-[0_0_50px_rgba(0,0,0,0.5)] rounded-2xl border-2 border-white/10 pointer-events-auto"
                            alt={previewImageColor || "Ürün Görseli"}
                        />
                    </div>

                    {/* Thumbnails (Optional but nice) */}
                    <div className="absolute bottom-8 left-0 right-0 p-4 flex justify-center gap-2 pointer-events-none">
                        {allGalleryImages.map((img, idx) => (
                            <button
                                key={idx}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setCurrentGalleryIndex(idx);
                                    setPreviewImage(img.url);
                                    setPreviewImageColor(img.color);
                                }}
                                className={`w-12 h-12 rounded-lg border-2 overflow-hidden transition-all pointer-events-auto ${idx === currentGalleryIndex ? 'border-blue-500 scale-125 shadow-lg shadow-blue-500/50' : 'border-white/20 opacity-50 hover:opacity-100 hover:scale-110'}`}
                            >
                                <img src={img.url} className="w-full h-full object-cover" />
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {isAddingWarehouse && (
                <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-sm">
                        <h3 className="text-lg font-bold text-gray-800 mb-4">Yeni Depo Ekle</h3>
                        <input
                            autoFocus
                            type="text"
                            placeholder="Örn: Merkez Depo, Mağaza 1"
                            className="w-full border border-gray-300 rounded-lg p-3 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all mb-4"
                            value={newWarehouseName}
                            onChange={(e) => setNewWarehouseName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && saveNewWarehouse()}
                        />
                        <div className="flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => { setIsAddingWarehouse(false); setNewWarehouseName(''); }}
                                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg font-medium transition-colors"
                            >
                                İptal
                            </button>
                            <button
                                type="button"
                                onClick={saveNewWarehouse}
                                disabled={!newWarehouseName.trim()}
                                className="px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 font-medium transition-colors disabled:opacity-50"
                            >
                                Ekle
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
