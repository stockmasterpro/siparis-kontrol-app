import { Database, ApiConfig, Product, Variant, Order, OrderStatus, Question, QuestionStatus, ReturnClaim } from '../types';
import { resolveCountryCodeFromTrendyolApi, resolveCargoCompanyFromTrendyolApi, orderImportDismissKey } from '../utils/orderUtils';

let globalSyncLock = false;

/**
 * Trendyol Ürün Aktarma (Create/Update Products)
 * POST /suppliers/{supplierId}/v2/products
 */
export const syncProductsToTrendyol = async (config: ApiConfig, products: Product[]): Promise<{ batchRequestId: string } | null> => {
  try {
    const url = `https://api.trendyol.com/sapigw/suppliers/${config.supplierId}/v2/products`;

    // Not: Trendyol API'si çok detaylı veri bekler (brandId, categoryId vb.)
    // Bu basitleştirilmiş bir örnektir.
    const items = products.flatMap(product =>
      product.variants.map(variant => ({
        barcode: variant.barcode,
        title: product.name,
        productMainId: product.productCode,
        brandId: 0, // Kullanıcı tarafından seçilmeli
        categoryId: 0, // Kullanıcı tarafından seçilmeli
        quantity: Object.values(variant.stocks).reduce((a, b) => a + b, 0),
        stockCode: variant.barcode,
        dimensionalWeight: 1,
        description: product.name,
        currencyType: "TRY",
        listPrice: variant.salePrice || product.salePrice, // Varyant PSF Fiyatı veya ürün bazlı fallback
        salePrice: variant.salePrice || product.salePrice, // Varyant PSF Fiyatı veya ürün bazlı fallback
        vatRate: 20,
        cargoCompanyId: 1, // Varsayılan Şirket
        images: [],
        attributes: []
      }))
    );

    if (items.length === 0) return null;

    const response = await fetch(url, {
      method: 'POST',
      headers: getTrendyolHeaders(config),
      body: JSON.stringify({ items })
    });

    if (response.ok) {
      const data = await response.json();
      return { batchRequestId: data.batchRequestId };
    } else {
      const errorMsg = await handleTrendyolError(response);
      throw new Error(`Ürün aktarma hatası: ${errorMsg}`);
    }
  } catch (error) {
    console.error('syncProductsToTrendyol error:', error);
    throw error;
  }
};

/**
 * Toplu İşlem Durumu Sorgulama
 * GET /suppliers/{supplierId}/products/batch-requests/{batchRequestId}
 */
export const checkBatchStatus = async (config: ApiConfig, batchRequestId: string): Promise<any> => {
  try {
    const url = `https://api.trendyol.com/sapigw/suppliers/${config.supplierId}/products/batch-requests/${batchRequestId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: getTrendyolHeaders(config)
    });

    if (response.ok) {
      return await response.json();
    } else {
      const errorMsg = await handleTrendyolError(response);
      throw new Error(`İşlem takibi hatası: ${errorMsg}`);
    }
  } catch (error) {
    console.error('checkBatchStatus error:', error);
    throw error;
  }
};

/**
 * Ürün Silme / Arşivleme (Trendyol'da silme yerine stok 0 yapılır veya satıştan kaldırılır)
 */
export const deleteProductFromTrendyol = async (config: ApiConfig, barcode: string): Promise<boolean> => {
  // Trendyol'da direkt silme yoktur, ürün pasife çekilir veya stok 0 yapılır.
  return await syncSingleBarcodeStock(config, barcode, 0);
};


/**
 * Helper to get Trendyol API headers
 */
const getTrendyolHeaders = (config: ApiConfig) => {
  const auth = btoa(`${config.apiKey}:${config.apiSecret}`);
  return {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
    'User-Agent': `${config.supplierId} - SelfIntegration`
  };
};

/**
 * Helper to handle Trendyol API errors with Turkish descriptions
 */
const handleTrendyolError = async (response: Response): Promise<string> => {
  // Clone response to prevent "body stream already read" error
  const clonedResponse = response.clone();
  let errorText = '';
  try {
    const errorData = await clonedResponse.json();
    errorText = JSON.stringify(errorData);
  } catch {
    try {
      errorText = await response.text();
    } catch {
      errorText = 'Bilinmeyen hata';
    }
  }

  switch (response.status) {
    case 401: return "Yetkisiz Erişim: API Key veya Secret hatalı.";
    case 403: return "Erişim Engellendi: Bu işlem için yetkiniz yok.";
    case 404: return "Bulunamadı: İstediğiniz kaynak mevcut değil.";
    case 429: return "Çok Fazla İstek: Trendyol hız sınırına takıldınız, lütfen biraz bekleyin.";
    case 500: return "Sunucu Hatası: Trendyol sistemlerinde bir sorun oluştu.";
    default: return `Hata (${response.status}): ${errorText}`;
  }
};

/**
 * Rate Limiting Delay
 * Trendyol: 10 saniyede max 50 istek (saniyede 5 istek)
 * Güvenli tarafta kalmak için her istek arasına 200ms koyuyoruz.
 */
const rateLimitDelay = () => new Promise(resolve => setTimeout(resolve, 200));

/**
 * Sends updated stock quantity to Trendyol for a single barcode.
 */
export const syncSingleBarcodeStock = async (
  config: ApiConfig,
  barcode: string,
  quantity: number,
  settings?: any // AppSettings as any to avoid circular import if any, or just any for simplicity here
): Promise<boolean> => {
  if (!barcode || !config) return false;

  // Özel API Ayarı Kontrolü: Bu API için stok gönderimi devre dışıysa atla
  if (config.enableStockSync === false) {
    console.log(`[SYNC-SKIP] ${config.storeName} için stok gönderimi devre dışı.`);
    return true; // Hata vermeden başarılı sayıp diğerlerine devam etmesini sağlıyoruz
  }

  // --- Sanal Stok (Virtual Stock) Mantığı ---
  let finalQuantity = Math.max(0, Math.floor(quantity));

  if (settings && settings.stockSyncSettings?.enabled) {
    const threshold = settings.stockSyncSettings.minStockThreshold || 10;
    const virtualQty = settings.stockSyncSettings.maxStockToSend || 10000;

    if (finalQuantity >= threshold) {
      console.log(`[VIRTUAL-STOCK] Barkod: ${barcode} | Gerçek: ${finalQuantity} >= Eşik: ${threshold}. Trendyol'a ${virtualQty} gönderiliyor.`);
      finalQuantity = virtualQty;
    }
  }

  try {
    await rateLimitDelay();
    const url = `https://api.trendyol.com/sapigw/suppliers/${config.supplierId}/products/price-and-inventory`;

    const payload = {
      items: [
        {
          barcode: barcode,
          quantity: finalQuantity
        }
      ]
    };

    if (config.mode === 'TEST') {
      console.log(`[TEST-SYNC] ${config.storeName} | Barkod: ${barcode} -> Stok: ${quantity}`);
      return true;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: getTrendyolHeaders(config),
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log(`[SYNC-SUCCESS] ${config.storeName} | Barkod: ${barcode} -> Stok: ${quantity} güncellendi.`);
      return true;
    } else {
      const errorMsg = await handleTrendyolError(response);
      console.error(`[SYNC-ERROR] ${config.storeName} | Barkod: ${barcode} | Hata: ${errorMsg}`);
      return false;
    }
  } catch (error) {
    console.error(`[SYNC-ERROR] ${config.storeName} | Barkod: ${barcode} | Exception:`, error);
    return false;
  }
};

/**
 * Sends updated stock quantity to all connected marketplaces.
 */
export const syncBarcodeStock = async (
  apiConfigs: ApiConfig[],
  barcode: string,
  quantity: number,
  settings?: any,
  onStart?: (count: number) => void,
  onEnd?: (count: number) => void
) => {
  if (!barcode || apiConfigs.length === 0) return;

  if (onStart) onStart(1);
  const promises = apiConfigs.map(config => syncSingleBarcodeStock(config, barcode, quantity, settings));
  await Promise.all(promises);
  if (onEnd) onEnd(1);
};

/**
 * Sends a batch of barcodes and their quantities to Trendyol.
 * Supports up to 1000 items per request as per Trendyol API.
 */
export const syncBarcodeStockBatch = async (
  config: ApiConfig,
  items: { barcode: string, quantity: number }[],
  settings?: any
): Promise<boolean> => {
  if (items.length === 0 || !config) return true;
  if (config.enableStockSync === false) return true;

  // Chunk items into segments of 500 (safe limit)
  const chunkSize = 500;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);

    // Virtual stock logic for each item in the chunk
    const payloadItems = chunk.map(item => {
      let finalQuantity = Math.max(0, Math.floor(item.quantity));
      if (settings && settings.stockSyncSettings?.enabled) {
        const threshold = settings.stockSyncSettings.minStockThreshold || 10;
        const virtualQty = settings.stockSyncSettings.maxStockToSend || 10000;
        if (finalQuantity >= threshold) {
          finalQuantity = virtualQty;
        }
      }
      return { barcode: item.barcode, quantity: finalQuantity };
    });

    try {
      if (config.mode === 'TEST') {
        console.log(`[TEST-BATCH-SYNC] ${config.storeName} | ${payloadItems.length} barkod güncelleniyor.`);
      } else {
        await rateLimitDelay();
        const url = `https://api.trendyol.com/sapigw/suppliers/${config.supplierId}/products/price-and-inventory`;
        const response = await fetch(url, {
          method: 'POST',
          headers: getTrendyolHeaders(config),
          body: JSON.stringify({ items: payloadItems })
        });

        if (!response.ok) {
          const errorMsg = await handleTrendyolError(response);
          console.error(`[BATCH-SYNC-ERROR] ${config.storeName} | Hata: ${errorMsg}`);
        }
      }

      // Respect the "1000 per minute" constraint (approx 30s delay between 500-item batches)
      if (items.length > chunkSize) {
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    } catch (error) {
      console.error(`[BATCH-SYNC-ERROR] ${config.storeName} | Exception:`, error);
    }
  }
  return true;
};

/**
 * Sends a batch of barcodes and their quantities to all connected marketplaces.
 */
export const syncBarcodeStockBatchMultiple = async (
  apiConfigs: ApiConfig[],
  items: { barcode: string, quantity: number }[],
  settings?: any,
  onStart?: (count: number) => void,
  onEnd?: (count: number) => void
) => {
  if (items.length === 0 || apiConfigs.length === 0) return;

  if (onStart) onStart(items.length);
  // Perform sync for each store in parallel (Promise.all)
  const promises = apiConfigs.map(config => syncBarcodeStockBatch(config, items, settings));
  await Promise.all(promises);
  if (onEnd) onEnd(items.length);
};

/**
 * Sends order status update to marketplaces.
 * Trendyol: PUT /order/sellers/{sellerId}/shipment-packages/{packageId}
 */
export const syncOrderStatusToMarketplaces = async (
  apiConfigs: ApiConfig[],
  orders: Order[],
  newStatus: OrderStatus,
  invoiceNumber?: string
) => {
  if (orders.length === 0 || apiConfigs.length === 0) return;

  for (const order of orders) {
    const config = apiConfigs.find(c => c.storeName === order.storeName);
    if (!config) continue;

    try {
      console.log(`[SYNC-STATUS] Sipariş: ${order.marketplaceOrderId} -> Durum: ${newStatus} iletiliyor...`);

      if (config.mode === 'TEST') {
        await new Promise(resolve => setTimeout(resolve, 300));
        console.log(`[TEST-SYNC-STATUS] ${order.marketplaceOrderId} durumu güncellendi (TEST MODE).`);
        continue;
      }

      // Map local status to Trendyol status
      let trendyolStatus = '';
      if (newStatus === OrderStatus.PROCESSING) {
        trendyolStatus = 'Picking';
      } else if (newStatus === OrderStatus.DELIVERED) {
        trendyolStatus = 'Invoiced';
      }

      // Eğer statü desteklenmiyorsa veya paket ID yoksa atla
      if (!trendyolStatus || !order.shipmentPackageId) {
        console.warn(`[SYNC-STATUS-SKIP] Sipariş: ${order.marketplaceOrderId} | Statü: ${newStatus} veya Paket ID eksik.`);
        continue;
      }

      await rateLimitDelay();

      // Trendyol API: PUT /integration/order/sellers/{sellerId}/shipment-packages/{packageId}
      // NOT: Mağaza ID (Supplier/Seller ID) URL'de kullanılır.
      // NOT: Picking işlemi için özel payload yapısı gerekir.
      const url = `https://apigw.trendyol.com/integration/order/sellers/${config.supplierId}/shipment-packages/${order.shipmentPackageId}`;

      const payload: any = {
        lines: order.items.map(item => ({
          lineId: parseInt(String(item.orderItemId)),
          quantity: item.quantity
        })),
        status: trendyolStatus,
        params: {} // Picking için boş obje zorunludur
      };

      // Fatura kesildiyse ve Invoiced durumuna alınıyorsa params içine fatura no eklenebilir
      // Ancak rehberde Picking için params: {} belirtilmiş. Invoiced farklı olabilir.
      if (trendyolStatus === 'Invoiced' && invoiceNumber) {
        // Invoiced durumunda yapı farklı olabilir, ancak Picking odaklı düzeltme yapıyoruz.
        // Şimdilik Picking için standart yapıyı koruyoruz.
        // Invoiced için invoiceNumber params içine mi yoksa root'a mı konulmalı dokümandan teyit edilmeli.
        // Mevcut kod root'a koyuyordu, ancak Picking güncellemesi yapıyoruz.
        // Güvenli taraf: Picking ise params boş, Invoiced ise eski mantık (veya o da güncellenmeli ama talep Picking üzerine).
        // Kullanıcının talebi "İşleme Al" (Picking) olduğu için, Invoiced durumunda payload'a invoiceNumber eklemeyi şimdilik
        // payload objesine direkt eklemek yerine params içine eklemek gerekebilir AMA Picking için params boş olmalı.
        // Invoiced durumu için risk almamak adına, Picking ise params boş, değilse (Invoiced) invoiceNumber ekle.
        if (trendyolStatus === 'Invoiced') {
          (payload as any).invoiceNumber = invoiceNumber;
        }
      }

      const response = await fetch(url, {
        method: 'PUT',
        headers: getTrendyolHeaders(config),
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        console.log(`[SYNC-STATUS-SUCCESS] ${order.marketplaceOrderId} durumu Trendyol'da ${trendyolStatus} olarak güncellendi.`);
      } else {
        const errorMsg = await handleTrendyolError(response);
        console.error(`[SYNC-STATUS-ERROR] ${order.marketplaceOrderId} | Hata: ${errorMsg}`);
        throw new Error(`${order.marketplaceOrderId}: ${errorMsg}`);
      }
    } catch (error) {
      console.error(`[SYNC-ERROR] Sipariş durum güncelleme hatası:`, error);
      throw error;
    }
  }
};

/**
 * Legacy Trendyol sipariş listesi (sapigw) — integration API başarısız olursa yedek.
 */
const fetchOrdersFromTrendyolSapigwLegacy = async (
  config: ApiConfig,
  filters: {
    status?: string | string[];
    startDate?: number;
    endDate?: number;
    page?: number;
    size?: number;
    orderNumber?: string;
  }
): Promise<any[]> => {
  await rateLimitDelay();
  const params = new URLSearchParams();
  if (filters.status) {
    if (Array.isArray(filters.status)) {
      filters.status.forEach(s => params.append('status', s));
    } else {
      params.append('status', filters.status);
    }
  }
  if (filters.startDate) params.append('startDate', filters.startDate.toString());
  if (filters.endDate) params.append('endDate', filters.endDate.toString());
  if (filters.page !== undefined) params.append('page', filters.page.toString());
  if (filters.size !== undefined) params.append('size', filters.size.toString());
  if (filters.orderNumber) params.append('orderNumber', filters.orderNumber);
  params.append('orderBy', 'LastUpdateDate');
  params.append('order', 'DESC');

  const url = `https://api.trendyol.com/sapigw/suppliers/${config.supplierId}/orders?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: getTrendyolHeaders(config)
  });

  if (response.ok) {
    const data = await response.json();
    return data.content || [];
  }
  const errorMsg = await handleTrendyolError(response);
  console.error(`[FETCH-ORDERS-ERROR] ${config.storeName} | Hata: ${errorMsg}`);
  throw new Error(errorMsg);
};

/**
 * Fetches orders from Trendyol — öncelik getShipmentPackages (integration/order/sellers/.../orders).
 * @see https://developers.trendyol.com/docs/sipari%C5%9F-paketlerini-%C3%A7ekme-getshipmentpackages
 */
export const fetchOrdersFromTrendyol = async (
  config: ApiConfig,
  filters: {
    status?: string | string[];
    startDate?: number;
    endDate?: number;
    page?: number;
    size?: number;
    orderNumber?: string;
  }
): Promise<any[]> => {
  try {
    await rateLimitDelay();

    const params = new URLSearchParams();
    if (filters.status) {
      if (Array.isArray(filters.status)) {
        filters.status.forEach(s => params.append('status', s));
      } else {
        params.append('status', filters.status);
      }
    }
    if (filters.startDate !== undefined) params.append('startDate', String(filters.startDate));
    if (filters.endDate !== undefined) params.append('endDate', String(filters.endDate));
    if (filters.page !== undefined) params.append('page', String(filters.page));
    if (filters.orderNumber !== undefined) params.append('orderNumber', filters.orderNumber);
    const size = Math.min(filters.size ?? 200, 200);
    params.append('size', String(size));
    params.append('orderByField', 'PackageLastModifiedDate');
    params.append('orderByDirection', 'DESC');

    const url = `https://apigw.trendyol.com/integration/order/sellers/${config.supplierId}/orders?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: getTrendyolHeaders(config)
    });

    if (response.ok) {
      const data = await response.json();
      return data.content || [];
    }

    console.warn(`[FETCH-ORDERS] Integration API HTTP ${response.status}, sapigw yedek deneniyor (${config.storeName})`);
    return await fetchOrdersFromTrendyolSapigwLegacy(config, filters);
  } catch (error) {
    console.warn(`[FETCH-ORDERS] Integration API istisna, sapigw yedek (${config.storeName})`, error);
    return await fetchOrdersFromTrendyolSapigwLegacy(config, filters);
  }
};


/**
 * Updates the product list ensuring that all variants with the same Color and Size
 * share the exact same stock quantity across all warehouses.
 * 
 * @param products Current list of products
 * @param productId ID of the product being updated
 * @param targetColor The color of the variant being updated
 * @param targetSize The size of the variant being updated
 * @param warehouseId The warehouse ID
 * @param newStock The new stock value
 * @returns Updated list of products and the list of affected barcodes
 */
export const updateLocalStockWithConsistency = (
  products: Product[],
  productId: string,
  targetColor: string,
  targetSize: string,
  warehouseId: string,
  newStock: number
): { updatedProducts: Product[], affectedBarcodes: string[] } => {

  let affectedBarcodes: string[] = [];

  const updatedProducts = products.map(p => {
    if (p.id !== productId) return p;

    // Found the product, now iterate variants
    const newVariants = p.variants.map(v => {
      // Check if this variant matches the physical item (Same Color & Size)
      // "Bir ürünün bir renginin bir bedenin birden fazla barkodu olabilir ama stoğu tektir."
      if (v.color === targetColor && v.size === targetSize) {
        if (v.barcode) affectedBarcodes.push(v.barcode);

        return {
          ...v,
          stocks: {
            ...v.stocks,
            [warehouseId]: newStock
          }
        };
      }
      return v;
    });

    return { ...p, variants: newVariants };
  });

  return { updatedProducts, affectedBarcodes };
};

/**
 * Creates a test order in Trendyol STAGE environment
 * Trendyol STAGE ortamında test siparişi oluşturur
 */
export const createTestOrder = async (
  config: ApiConfig,
  orderData: {
    customerFirstName: string;
    customerLastName: string;
    addressText: string;
    city: string;
    district: string;
    phone: string;
    email: string;
    barcode: string;
    quantity: number;
    discountPercentage?: number;
    commercial?: boolean;
    company?: string;
    invoiceTaxNumber?: string;
    invoiceTaxOffice?: string;
    microRegion?: string;
  }
): Promise<{ success: boolean; orderNumber?: string; error?: string }> => {
  try {
    const auth = btoa(`${config.apiKey}:${config.apiSecret}`);
    const url = 'https://stageapigw.trendyol.com/integration/test/order/orders/core';

    const payload = {
      customer: {
        customerFirstName: orderData.customerFirstName,
        customerLastName: orderData.customerLastName
      },
      invoiceAddress: {
        addressText: orderData.addressText,
        city: orderData.city,
        company: orderData.company || '',
        district: orderData.district,
        invoiceFirstName: orderData.customerFirstName,
        invoiceLastName: orderData.customerLastName,
        latitude: "string",
        longitude: "string",
        neighborhood: "",
        phone: orderData.phone,
        postalCode: "",
        email: orderData.email,
        invoiceTaxNumber: orderData.invoiceTaxNumber || '',
        invoiceTaxOffice: orderData.invoiceTaxOffice || ''
      },
      lines: [
        {
          barcode: orderData.barcode,
          quantity: orderData.quantity,
          discountPercentage: orderData.discountPercentage || 0
        }
      ],
      seller: {
        sellerId: parseInt(config.supplierId)
      },
      shippingAddress: {
        addressText: orderData.addressText,
        city: orderData.city,
        company: orderData.company || '',
        district: orderData.district,
        latitude: "string",
        longitude: "string",
        neighborhood: "",
        phone: orderData.phone,
        postalCode: "",
        shippingFirstName: orderData.customerFirstName,
        shippingLastName: orderData.customerLastName,
        email: orderData.email
      },
      commercial: orderData.commercial || false,
      microRegion: orderData.microRegion || ''
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': `${config.supplierId} - SelfIntegration`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Test siparişi oluşturma hatası:', errorText);
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`
      };
    }

    const result = await response.json();

    if (result.orderNumber) {
      console.log(`Test siparişi başarıyla oluşturuldu. Sipariş No: ${result.orderNumber}`);
      return {
        success: true,
        orderNumber: result.orderNumber
      };
    } else {
      return {
        success: false,
        error: 'Sipariş numarası alınamadı'
      };
    }

  } catch (error) {
    console.error('Test siparişi oluşturma hatası:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Bilinmeyen hata'
    };
  }
};

/**
 * Creates a real order in Trendyol LIVE environment
 * Trendyol LIVE ortamında gerçek sipariş oluşturur
 */
export const createRealOrder = async (
  config: ApiConfig,
  orderData: {
    customerFirstName: string;
    customerLastName: string;
    addressText: string;
    city: string;
    district: string;
    phone: string;
    email: string;
    barcode: string;
    quantity: number;
    discountPercentage?: number;
    commercial?: boolean;
    company?: string;
    invoiceTaxNumber?: string;
    invoiceTaxOffice?: string;
    microRegion?: string;
  }
): Promise<{ success: boolean; orderNumber?: string; error?: string }> => {
  try {
    const auth = btoa(`${config.apiKey}:${config.apiSecret}`);
    const url = 'https://apigw.trendyol.com/integration/order/orders/core';

    const payload = {
      customer: {
        customerFirstName: orderData.customerFirstName,
        customerLastName: orderData.customerLastName
      },
      invoiceAddress: {
        addressText: orderData.addressText,
        city: orderData.city,
        company: orderData.company || '',
        district: orderData.district,
        invoiceFirstName: orderData.customerFirstName,
        invoiceLastName: orderData.customerLastName,
        latitude: "string",
        longitude: "string",
        neighborhood: "",
        phone: orderData.phone,
        postalCode: "",
        email: orderData.email,
        invoiceTaxNumber: orderData.invoiceTaxNumber || '',
        invoiceTaxOffice: orderData.invoiceTaxOffice || ''
      },
      lines: [
        {
          barcode: orderData.barcode,
          quantity: orderData.quantity,
          discountPercentage: orderData.discountPercentage || 0
        }
      ],
      seller: {
        sellerId: parseInt(config.supplierId)
      },
      shippingAddress: {
        addressText: orderData.addressText,
        city: orderData.city,
        company: orderData.company || '',
        district: orderData.district,
        latitude: "string",
        longitude: "string",
        neighborhood: "",
        phone: orderData.phone,
        postalCode: "",
        shippingFirstName: orderData.customerFirstName,
        shippingLastName: orderData.customerLastName,
        email: orderData.email
      },
      commercial: orderData.commercial || false,
      microRegion: orderData.microRegion || ''
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': `${config.supplierId} - SelfIntegration`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gerçek sipariş oluşturma hatası:', errorText);
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`
      };
    }

    const result = await response.json();

    if (result.orderNumber) {
      console.log(`Gerçek sipariş başarıyla oluşturuldu. Sipariş No: ${result.orderNumber}`);
      return {
        success: true,
        orderNumber: result.orderNumber
      };
    } else {
      return {
        success: false,
        error: 'Sipariş numarası alınamadı'
      };
    }

  } catch (error) {
    console.error('Gerçek sipariş oluşturma hatası:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Bilinmeyen hata'
    };
  }
};

/**
 * Centralized sync logic for marketplace orders.
 * Fetches new orders, updates statuses, and reconciles stock.
 * 
 * @param db Current database state
 * @param isManual true = kullanıcı "Manuel Sipariş Çek" (otomatik sipariş çekme ayarından bağımsız); false = arka plan zamanlayıcı
 * @returns Updated products and orders, and counts of new items
 */
export const syncMarketplaceOrders = async (
  db: Database,
  isManual = false
): Promise<{
  updatedProducts: Product[],
  updatedOrders: Order[],
  newOrdersAddedCount: number,
  barcodesToSync: { [key: string]: number }
}> => {
  if (db.apiConfigs.length === 0) {
    return {
      updatedProducts: db.products,
      updatedOrders: db.orders,
      newOrdersAddedCount: 0,
      barcodesToSync: {}
    };
  }

  if (globalSyncLock) {
    console.warn('[SYNC-LOCK] Sipariş senkronizasyonu zaten devam ediyor, atlanıyor.');
    return {
      updatedProducts: db.products,
      updatedOrders: db.orders,
      newOrdersAddedCount: 0,
      barcodesToSync: {}
    };
  }
  globalSyncLock = true;
  try {

  let newOrdersAddedCount = 0;
  let currentDbProducts = [...db.products];
  let currentDbOrders = [...db.orders];
  const barcodesToSync: { [key: string]: number } = {};
  const dismissedImport = new Set(db.dismissedOrderImportKeys || []);

  for (const config of db.apiConfigs) {
    if (config.type === 'MANUAL') continue;
    if (config.isOrderSyncEnabled === false) {
      console.log(`[ORDER-SYNC-SKIP] ${config.storeName} için sipariş çekme devre dışı.`);
      continue;
    }

    console.log(`[SYNC-START] Store: ${config.storeName}, Mode: ${config.mode}, Online: ${navigator.onLine}`);

    let content: any[] = [];

    if (config.mode === 'TEST') {
      // SAFEGUARD: If someone has an actual API key but is in TEST mode, they might be confused.
      // We skip mock orders in auto-sync if they have an API key, unless it's a manual sync.
      if (config.apiKey && config.apiKey.length > 5 && !isManual) {
        console.warn(`[SYNC-TEST-MODE-ALERT] Store ${config.storeName} is in TEST mode but has API configuration. Skipping mock orders for auto-sync.`);
        continue;
      }

      // Mock order for testing
      if (isManual || Math.random() > 0.7) {
        let mockVariant = { barcode: 'TEST-BARCODE', color: 'X', size: 'L' };
        let mockProductName = "Test Ürünü";
        let mockPrice = 100;

        if (currentDbProducts.length > 0) {
          const randomProduct = currentDbProducts[Math.floor(Math.random() * currentDbProducts.length)];
          const randomVariant = randomProduct.variants.find(v => v.barcode && v.barcode.length > 0) || randomProduct.variants[0];
          if (randomVariant) {
            mockVariant = randomVariant;
            mockProductName = randomProduct.name;
            mockPrice = randomVariant.salePrice || randomProduct.salePrice; // Varyant PSF veya Ürün PSF
          }
        }

        content = [{
          orderNumber: `TEST-${Math.floor(Math.random() * 1000000)}`,
          customerFirstName: "Test",
          customerLastName: "Müşteri",
          cargoTrackingNumber: `${Math.floor(Math.random() * 10000000)}`,
          orderDate: Date.now(),
          status: 'Created',
          lines: [{
            orderItemId: Math.random().toString(36).substr(2, 9),
            barcode: mockVariant.barcode,
            productName: mockProductName,
            sku: `${mockVariant.color}-${mockVariant.size}`,
            color: mockVariant.color,
            size: mockVariant.size,
            productSize: mockVariant.size,
            quantity: 1,
            unitPrice: mockPrice,
            totalPrice: mockPrice
          }]
        }];
      }
    } else {
      try {
        const fetchDays = db.settings.enableOrderVisibilityLimit 
          ? (db.settings.orderFetchDays || 2) 
          : 30;
        const nowMs = Date.now();
        const horizonMs = fetchDays * 86400000;
        const twoWeeksMs = 14 * 86400000;
        const dedupeKeys = new Set<string>();

        // 1. Yeni Siparişleri Çek (status: 'Created')
        for (let windowEnd = nowMs; windowEnd > nowMs - horizonMs; windowEnd -= twoWeeksMs) {
          const windowStart = Math.max(windowEnd - twoWeeksMs, nowMs - horizonMs);
          let page = 0;
          while (true) {
            const pageOrders = await fetchOrdersFromTrendyol(config, {
              status: 'Created',
              startDate: windowStart,
              endDate: windowEnd,
              page: page,
              size: 200
            });
            if (pageOrders.length === 0) break;
            for (const o of pageOrders) {
              const dedupeKey = `${config.storeName}::${o.orderNumber || ''}::${o.shipmentPackageId ?? o.id ?? ''}`;
              if (dedupeKeys.has(dedupeKey)) continue;
              dedupeKeys.add(dedupeKey);
              content.push(o);
            }
            if (pageOrders.length < 200) break;
            page++;
          }
        }

        // 2. İşleme Alınan Siparişleri Çek (status: 'Picking')
        for (let windowEnd = nowMs; windowEnd > nowMs - horizonMs; windowEnd -= twoWeeksMs) {
          const windowStart = Math.max(windowEnd - twoWeeksMs, nowMs - horizonMs);
          let page = 0;
          while (true) {
            const pageOrders = await fetchOrdersFromTrendyol(config, {
              status: 'Picking',
              startDate: windowStart,
              endDate: windowEnd,
              page: page,
              size: 200
            });
            if (pageOrders.length === 0) break;
            for (const o of pageOrders) {
              const dedupeKey = `${config.storeName}::${o.orderNumber || ''}::${o.shipmentPackageId ?? o.id ?? ''}`;
              if (dedupeKeys.has(dedupeKey)) continue;
              dedupeKeys.add(dedupeKey);
              content.push(o);
            }
            if (pageOrders.length < 200) break;
            page++;
          }
        }

        // 3. Durum Değişikliği Tespiti ve Otomatik Güncelleme
        // Veritabanımızda aktif (NEW veya PROCESSING) olan ama çekilen aktif listesinde bulunmayan siparişlerin
        // güncel durumunu (Kargolandı, İptal, Teslim Edildi) tekil sorgular ile alıp content'e ekleriz.
        const fetchedKeys = new Set(content.map(o => `${config.storeName}::${o.orderNumber}::${o.shipmentPackageId || ''}`));
        
        const activeLocalOrders = currentDbOrders.filter(o => 
          o.storeName === config.storeName &&
          (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING) &&
          !o.id.includes('_OLD_') &&
          // Son 30 güne ait aktif yerel siparişleri kontrol et (aşırı eskilere bakıp API'yi yormamak için)
          (Date.now() - new Date(o.orderDate).getTime() < 30 * 86400000)
        );

        for (const localOrder of activeLocalOrders) {
          const key = `${localOrder.storeName}::${localOrder.marketplaceOrderId}::${localOrder.shipmentPackageId || ''}`;
          if (!fetchedKeys.has(key)) {
            console.log(`[ORDER-SYNC] Aktif listede olmayan sipariş tespit edildi, detay güncelleniyor: ${localOrder.marketplaceOrderId}`);
            try {
              const freshOrders = await fetchOrdersFromTrendyol(config, {
                orderNumber: localOrder.marketplaceOrderId
              });
              if (freshOrders && freshOrders.length > 0) {
                const matchingPkg = freshOrders.find(fo => 
                  !localOrder.shipmentPackageId || !fo.shipmentPackageId || 
                  String(fo.shipmentPackageId) === String(localOrder.shipmentPackageId)
                ) || freshOrders[0];
                
                if (matchingPkg) {
                  content.push(matchingPkg);
                }
              }
            } catch (e) {
              console.error(`[ORDER-SYNC] Tekil sipariş detay hatası (${localOrder.marketplaceOrderId}):`, e);
            }
          }
        }
      } catch (error) {
        console.error(`[SYNC-ERROR] ${config.storeName} |`, error);
      }
    }

    for (const apiOrder of content) {
      const dismissKey = orderImportDismissKey(config.storeName, apiOrder.orderNumber, apiOrder.shipmentPackageId);
      if (dismissedImport.has(dismissKey)) {
        console.log(`[ORDER-SYNC] Kullanıcı silmiş paket atlanıyor: ${dismissKey}`);
        continue;
      }

      // --- [DATE PARSING & OFFSET FIX] ---
      const rawOrderDate = apiOrder.orderDate || apiOrder.createdDate || Date.now();
      const orderTimestamp = typeof rawOrderDate === 'string' ? new Date(rawOrderDate).getTime() : Number(rawOrderDate);
      
      // 3 Saatlik zaman kayması düzeltmesi (Trendyol API timestamp offset sorunu)
      const orderDate = new Date(orderTimestamp - (3 * 3600 * 1000));

      let mappedStatus = OrderStatus.NEW;
      const status = (apiOrder.status || apiOrder.shipmentPackageStatus || '').toString().toLowerCase().trim();

      if (status === 'shipped' || status === 'shipping') mappedStatus = OrderStatus.SHIPPING;
      else if (status === 'delivered' || status === 'completed') mappedStatus = OrderStatus.DELIVERED;
      else if (status === 'cancelled' || status === 'canceled') mappedStatus = OrderStatus.CANCELLED;
      else if (status === 'created' || status === 'new' || status === 'pending') mappedStatus = OrderStatus.NEW;
      else if (status === 'picking' || status === 'processing' || status === 'approved') mappedStatus = OrderStatus.PROCESSING;

      // Arşivlenmiş (_OLD_) olanları hariç tut, aktifi bul + MAĞAZA KONTROLÜ + SHIPMENT PACKAGE ID (Split Shipment support)
      let existingOrderIndex = currentDbOrders.findIndex(o =>
        o.marketplaceOrderId === apiOrder.orderNumber &&
        o.storeName === config.storeName &&
        (!apiOrder.shipmentPackageId || !o.shipmentPackageId || String(o.shipmentPackageId) === String(apiOrder.shipmentPackageId)) &&
        !o.id.includes('_OLD_')
      );

      // Itemları Hazırla
      const orderItems: any[] = (apiOrder.lines || []).map((line: any) => {
        const productName = line.productName || line.name || line.merchantSku || 'Ürün adı mevcut değil';
        let color = line.attributes?.find((attr: any) => ['Renk', 'Color', 'RENK'].includes(attr.attributeName))?.attributeValue || line.productColor || line.color || '';

        // Fallback color from DB
        if (!color && (line.barcode || line.stockCode)) {
          const searchBarcode = line.barcode || line.stockCode;
          const product = currentDbProducts.find(p => p.variants.some(v => v.barcode === searchBarcode));
          if (product) {
            const variant = product.variants.find(v => v.barcode === searchBarcode);
            if (variant) color = variant.color;
          }
        }

        return {
          orderItemId: String(line.orderItemId || line.id),
          barcode: line.barcode || line.stockCode || 'NO-BARCODE',
          productName: productName,
          sku: line.merchantSku,
          color: color,
          size: line.attributes?.find((attr: any) => ['Beden', 'Size', 'BEDEN'].includes(attr.attributeName))?.attributeValue || line.size || '',
          productSize: line.productSize || line.size || '',
          quantity: line.quantity,
          unitPrice: line.price,
          costPrice: (() => {
            const p = currentDbProducts.find(prod => prod.variants.some(v => v.barcode === (line.barcode || line.stockCode)));
            const v = p?.variants.find(varnt => varnt.barcode === (line.barcode || line.stockCode));
            return v?.costPrice || p?.costPrice;
          })(),
          totalPrice: line.price * line.quantity,
          vatRate: line.vatRate,
          commission: line.commission,
          lineGrossAmount: line.lineGrossAmount,
          fullData: line // Satır bazlı ham veriyi sakla
        };
      });

      // --- [STRICT-IMPORT-FILTER v1.6.6] ---
      // Eğer sipariş sistemde YOKSA:
      if (existingOrderIndex === -1) {
        // 1. Statü Kontrolü: Sadece 'Yeni' veya 'İşleme Alınan' siparişleri sisteme ilk kez dahil et.
        if (mappedStatus !== OrderStatus.NEW && mappedStatus !== OrderStatus.PROCESSING) {
          continue;
        }

        // 2. Tarih Kontrolü: Eğer 'Sipariş Çekme Sınırı' aktifse, belirlenen günden eski siparişleri sisteme alma.
        if (db.settings.enableOrderVisibilityLimit) {
          const limitDays = db.settings.orderFetchDays || 2;
          const limitDate = new Date();
          limitDate.setDate(limitDate.getDate() - limitDays);
          limitDate.setHours(0, 0, 0, 0); // O günün başlangıcı (00:00)
          
          if (orderDate.getTime() < limitDate.getTime()) {
            console.log(`[ORDER-SYNC] Tarih sınırına takıldı: ${apiOrder.orderNumber} (${orderDate.toLocaleString()})`);
            continue;
          }
        }
      }

      // --- EXISTING ORDER UPDATE LOGIC ---
      if (existingOrderIndex > -1) {
        const existingOrder = currentDbOrders[existingOrderIndex];

        // Zaten iptal edilmişse işlem yapma
        if (existingOrder.status === OrderStatus.CANCELLED) {
          continue;
        }

        const newCargoCode = String(apiOrder.cargoTrackingNumber || apiOrder.trackingNumber || '-');
        const existingCargoCode = existingOrder.cargoCode || '-';

        // KARGO KODU AYRIMI (Cargo Code Logic)
        // Eğer sipariş numarası aynı ama kargo kodu farklıysa (ve her ikisi de geçerliyse),
        // bu muhtemelen yeni bir paket veya bölünmüş teslimattır.
        // Bunu "güncelleme" olarak değil "yeni sipariş" olarak işletmek için
        // existingOrderIndex'i -1 yapıyoruz.
        if (newCargoCode !== '-' && existingCargoCode !== '-' && newCargoCode !== existingCargoCode) {
          // KARGO KODLARI FARKLI:
          // Eğer API'den gelen durum İptal ise, bu muhtemelen başka bir paketin (veya tarihteki bir parçanın) iptalidir.
          // Bizim aktif (ve farklı kargo kodlu) siparişimizi bozmamalı.
          if (mappedStatus === OrderStatus.CANCELLED) {
            console.log(`[ORDER-SYNC] Sipariş ${apiOrder.orderNumber} için farklı kargo kodlu (${newCargoCode}) İPTAL kaydı atlandı. Aktif sipariş (${existingCargoCode}) korundu.`);
            continue;
          }

          console.log(`[ORDER-UPDATE] Sipariş ${apiOrder.orderNumber} (${config.storeName}) için farklı kargo kodu algılandı. Mevcut: ${existingCargoCode} -> Yeni: ${newCargoCode}. Eski sipariş arşivleniyor, yenisi ekleniyor.`);

          // STOK İADE (Eğer askıda değilse ve daha önce düşülmüşse)
          if (!existingOrder.isSuspended) {
            existingOrder.items.forEach(item => {
              const product = currentDbProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
              if (product) {
                const variant = product.variants.find(v => v.barcode === item.barcode);
                if (variant) {
                  const whId = Object.keys(variant.stocks)[0] || 'wh1';
                  const currentStock = variant.stocks[whId] || 0;
                  const newStock = currentStock + item.quantity;

                  const result = updateLocalStockWithConsistency(currentDbProducts, product.id, variant.color, variant.size, whId, newStock);
                  currentDbProducts = result.updatedProducts;

                  // Stok senkronizasyon listesine ekle - TÜM BARKODLAR
                  const updatedProduct = currentDbProducts.find(p => p.id === product.id);
                  if (updatedProduct) {
                    updatedProduct.variants.forEach(pv => {
                      if (pv.barcode) {
                        const total = Object.values(pv.stocks).reduce((a: number, b: number) => a + b, 0);
                        barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : Number(total);
                      }
                    });
                  }
                }
              }
            });
          }

          // Eski siparişi arşivle (İptal Statüsü + ID değişikliği)
          currentDbOrders[existingOrderIndex].status = OrderStatus.CANCELLED;
          currentDbOrders[existingOrderIndex].id = `${existingOrder.id}_OLD_${Date.now()}`;

          // Yeni sipariş olarak eklenmesi için index'i sıfırla
          existingOrderIndex = -1;
          // Fall through to NEW ORDER LOGIC logic below
        } else {
          // Sadece kargo kodu aynı ise veya biri boş ise güncelleme mantığına devam et

          // [KRİTİK GÜNCELLEME]:
          // Eğer API'den gelen durum İptal ise ve bizim mevcut siparişimizde kargo kodu varsa
          // ama API'den gelen veride kargo kodu yoksa, bu yanılmaya (silmeye) yol açmamalı.
          const isCancelledStatus = mappedStatus === OrderStatus.CANCELLED;
          if (isCancelledStatus && existingCargoCode !== '-' && newCargoCode === '-') {
            console.log(`[ORDER-SYNC] Sipariş ${apiOrder.orderNumber} için kargo kodsuz İPTAL bildirimi atlandı (Mevcut kargo: ${existingCargoCode}).`);
            continue;
          }
          // İçerik değişikliği kontrolü (Adet ve Barkod bazlı)
          const currentQty = existingOrder.items.reduce((a, b) => a + b.quantity, 0);
          const newQty = orderItems.reduce((a, b) => a + b.quantity, 0);
          const existingBarcodes = existingOrder.items.map(i => i.barcode).sort().join(',');
          const newBarcodes = orderItems.map(i => i.barcode).sort().join(',');
          const isContentChanged = currentQty !== newQty || existingBarcodes !== newBarcodes;

          if (isCancelledStatus || isContentChanged) {
            console.log(`[ORDER-UPDATE] Sipariş ${apiOrder.orderNumber} iptal/değişim algılandı. Arşivleniyor...`);

            // 1. STOK İADE (Eğer askıda değilse ve daha önce düşülmüşse)
            if (!existingOrder.isSuspended) {
              existingOrder.items.forEach(item => {
                const product = currentDbProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
                if (product) {
                  const variant = product.variants.find(v => v.barcode === item.barcode);
                  if (variant) {
                    const whId = Object.keys(variant.stocks)[0] || 'wh1';
                    const currentStock = variant.stocks[whId] || 0;
                    const newStock = currentStock + item.quantity;

                    const result = updateLocalStockWithConsistency(currentDbProducts, product.id, variant.color, variant.size, whId, newStock);
                    currentDbProducts = result.updatedProducts;

                    // Stok senkronizasyon listesine ekle - ÖNEMLİ: Tüm varyant barkodlarını ekle
                    const updatedProduct = currentDbProducts.find(p => p.id === product.id);
                    if (updatedProduct) {
                      updatedProduct.variants.forEach(pv => {
                        if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                          const total = Object.values(pv.stocks).reduce((a: number, b: number) => a + b, 0);
                          barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : Number(total);
                        }
                      });
                    }
                  }
                }
              });
            }

            // 2. SİPARİŞİ ARŞİVLE (ID Değiştir, Status Cancelled Yap)
            // Bu sayede aynı marketplaceOrderId ile gelen yeni veri "Yeni Sipariş" gibi işlenecek
            currentDbOrders[existingOrderIndex].status = OrderStatus.CANCELLED;
            currentDbOrders[existingOrderIndex].id = `${existingOrder.id}_OLD_${Date.now()}`;

            // Mevcut siparişi "bulunamadı" durumuna getir ki aşağıda yepyeni bir sipariş olarak eklensin
            existingOrderIndex = -1;
          } else {
            // Sadece statü/kargo güncellemesi ve ürün detayları güncellemesi
            if (existingOrder.status !== mappedStatus) {
              currentDbOrders[existingOrderIndex].status = mappedStatus;
              
              // [FIX] Eğer sipariş kargolandıysa veya teslim edildiyse artık askıda kalmamalı.
              if (mappedStatus === OrderStatus.SHIPPING || mappedStatus === OrderStatus.DELIVERED) {
                if (currentDbOrders[existingOrderIndex].isSuspended) {
                  currentDbOrders[existingOrderIndex].isSuspended = false;
                  currentDbOrders[existingOrderIndex].wasSuspended = true;
                }
              }

              // If it was already resolved, keep it resolved
              if (existingOrder.wasSuspended) {
                currentDbOrders[existingOrderIndex].isSuspended = false;
              }
            }
            const newCargoCode = String(apiOrder.cargoTrackingNumber || apiOrder.trackingNumber || '-');
            if (existingOrder.cargoCode !== newCargoCode && newCargoCode !== '-') {
              currentDbOrders[existingOrderIndex].cargoCode = newCargoCode;
            }
            const resolvedCountry = resolveCountryCodeFromTrendyolApi(apiOrder);
            currentDbOrders[existingOrderIndex].countryCode = resolvedCountry;
            const cargoName = resolveCargoCompanyFromTrendyolApi(apiOrder);
            if (cargoName) {
              currentDbOrders[existingOrderIndex].cargoCompanyName = cargoName;
            }
            currentDbOrders[existingOrderIndex].fullData = apiOrder;

            // HER GÜNCELLEMEDE ÜRÜN DETAYLARINI (isim, renk, beden, fiyat, kdv, komisyon vb.) TAZELE
            currentDbOrders[existingOrderIndex].items = orderItems;

            continue; // Başka işlem yapma, sonraki siparişe geç
          }
        } // Else block closure for cargo code check
      }

      // --- NEW ORDER LOGIC ---
      // (Burası hem gerçekten yeni siparişler için hem de yukarıda arşivlenen değişmiş siparişlerin güncel hali için çalışır)

      // Eğer gelen statü İPTAL ise ve biz zaten yukarıda eskisini iptal edip arşivlediysek,
      // bu "yeni" iptal kaydını tekrar eklemeye gerek yok.
      if (mappedStatus === OrderStatus.CANCELLED) continue;

      // SUSPEND KONTROLÜ: Tüm barkodlar sistemde var mı?
      // "bir barkod tanımlı olmaz ise askıda kalır ... sipariş siparişler sayfasına düşmez"
      const allBarcodesExist = orderItems.every(item =>
        item.barcode && item.barcode !== 'NO-BARCODE' &&
        currentDbProducts.some(p => p.variants.some(v => v.barcode === item.barcode))
      );

      const isSuspended = !allBarcodesExist;

      // STOK DÜŞME (Sadece askıda değilse)
      // "tüm barkodlar tanımlı ise siparişler sayfasına düşer, her bir barkod için tek tek ... stokdan adetleri kadar düşer"
      if (!isSuspended) {
        orderItems.forEach(item => {
          // ÖNEMLİ: Aynı barkoda sahip TÜM ürünleri bul ve stoklarını düşür
          currentDbProducts.forEach(product => {
            const variant = product.variants.find(v => v.barcode === item.barcode);
            if (variant) {
              const targetWhId = 'wh1'; // Merkez Depo
              const currentStock = variant.stocks[targetWhId] || 0;

              // Respect allowNegativeStock setting
              let newStock = currentStock - item.quantity;
              if (db.settings.allowNegativeStock === false && newStock < 0) {
                newStock = 0;
              }

              const result = updateLocalStockWithConsistency(currentDbProducts, product.id, variant.color, variant.size, targetWhId, newStock);
              currentDbProducts = result.updatedProducts;

              // Sync listesine ekle - ÖNEMLİ: Sadece siparişteki barkod değil, 
              // o varyantla (Renk/Beden) eşleşen TÜM barkodları senkronizasyon listesine ekle.
              const updatedProduct = currentDbProducts.find(p => p.id === product.id);
              if (updatedProduct) {
                updatedProduct.variants.forEach(pv => {
                  if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                    const total = Object.values(pv.stocks).reduce((a: number, b: number) => a + b, 0);
                    barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : Number(total);
                  }
                });
              }
            }
          });
        });
      }

      // SİPARİŞİ OLUŞTUR
      let deliveryAddress = '';
      if (apiOrder.shipmentAddress) {
        deliveryAddress = [
          apiOrder.shipmentAddress.address1,
          apiOrder.shipmentAddress.address2,
          apiOrder.shipmentAddress.district,
          apiOrder.shipmentAddress.city
        ].filter(Boolean).join(', ');
      }

      // Fix Shipment Package ID Mapping
      const packageId = apiOrder.shipmentPackageId ? String(apiOrder.shipmentPackageId) : (apiOrder.id ? String(apiOrder.id) : undefined);

      const newOrder: Order = {
        id: Math.random().toString(36).substr(2, 9),
        marketplaceOrderId: apiOrder.orderNumber,
        storeName: config.storeName,
        status: mappedStatus,
        customerName: `${apiOrder.customerFirstName || ''} ${apiOrder.customerLastName || ''}`.trim(),
        customerPhone: apiOrder.customerPhoneNumber || apiOrder.shipmentAddress?.phone,
        customerEmail: apiOrder.customerEmail,
        deliveryAddress: deliveryAddress || undefined,
        cargoCode: String(apiOrder.cargoTrackingNumber || apiOrder.trackingNumber || '-'),
        cargoCompanyName: resolveCargoCompanyFromTrendyolApi(apiOrder) || undefined,
        orderDate: orderDate.toISOString(),
        items: orderItems,
        isSuspended: isSuspended, // Hesaplanan değer
        shipmentPackageId: packageId,
        countryCode: resolveCountryCodeFromTrendyolApi(apiOrder),
        city: apiOrder.shipmentAddress?.city,
        district: apiOrder.shipmentAddress?.district,
        neighborhood: apiOrder.shipmentAddress?.neighborhood,
        postalCode: apiOrder.shipmentAddress?.postalCode || apiOrder.invoiceAddress?.postalCode,
        isCommercial: apiOrder.commercial,
        identityNumber: apiOrder.identityNumber,
        taxNumber: apiOrder.invoiceAddress?.taxNumber || apiOrder.invoiceAddress?.identityNumber || apiOrder.identityNumber,
        taxOffice: apiOrder.invoiceAddress?.taxOffice,
        company: apiOrder.invoiceAddress?.company || apiOrder.shipmentAddress?.company,
        invoiceAddress: apiOrder.invoiceAddress ? [
          apiOrder.invoiceAddress.address1,
          apiOrder.invoiceAddress.address2,
          apiOrder.invoiceAddress.district,
          apiOrder.invoiceAddress.city
        ].filter(Boolean).join(', ') : undefined,
        fullData: apiOrder // API'den gelen tüm veriyi sakla
      };

      // Auto Process Logic if enabled (Active orders only)
      if (db.settings.enableAutoProcessOrders && !isSuspended && mappedStatus === OrderStatus.NEW) {
        newOrder.status = OrderStatus.PROCESSING;
        try {
          // Fire and forget status update
          syncOrderStatusToMarketplaces([config], [newOrder], OrderStatus.PROCESSING).catch(console.error);
        } catch (error) { console.error(error); }
      }

      currentDbOrders.unshift(newOrder);
      newOrdersAddedCount++;
    }
  }

  // Aynı sipariş numarası + mağaza için birden fazla paket kaydı varsa: tüm kalemlerde barkod
  // sistemde tanımlı değilse siparişin hiçbir paketini aktif sayfada bırakma (askıya al);
  // yanlışlıkla stok düşülmüş aktif paket varsa stoğu iade et.
  const itemBarcodeResolved = (barcode: string) =>
    Boolean(
      barcode &&
        barcode !== 'NO-BARCODE' &&
        currentDbProducts.some(p => p.variants.some(v => v.barcode === barcode))
    );

  const orderGroups = new Map<string, typeof currentDbOrders>();
  for (const o of currentDbOrders) {
    if (o.id.includes('_OLD_')) continue;
    const key = `${o.storeName}::${o.marketplaceOrderId || ''}`;
    if (!orderGroups.has(key)) orderGroups.set(key, []);
    orderGroups.get(key)!.push(o);
  }

  for (const siblings of orderGroups.values()) {
    if (siblings.length < 2) continue;

    const mergedItems = siblings.flatMap(o => o.items || []);
    const groupOk =
      mergedItems.length === 0 ||
      mergedItems.every(it => itemBarcodeResolved(String(it.barcode || '')));

    if (groupOk) continue;

    for (const o of siblings) {
      if (o.status === OrderStatus.CANCELLED) continue;

      if (!o.isSuspended) {
        o.items.forEach(item => {
          const product = currentDbProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
          if (product) {
            const variant = product.variants.find(v => v.barcode === item.barcode);
            if (variant) {
              const whId = Object.keys(variant.stocks)[0] || 'wh1';
              const currentStock = variant.stocks[whId] || 0;
              const newStock = currentStock + item.quantity;

              const result = updateLocalStockWithConsistency(
                currentDbProducts,
                product.id,
                variant.color,
                variant.size,
                whId,
                newStock
              );
              currentDbProducts = result.updatedProducts;

              const updatedProduct = currentDbProducts.find(p => p.id === product.id);
              if (updatedProduct) {
                updatedProduct.variants.forEach(pv => {
                  if (pv.barcode) {
                    const total = Object.values(pv.stocks).reduce((a: number, b: number) => a + b, 0);
                    barcodesToSync[pv.barcode] = pv.isMarketplaceDisabled ? 0 : Number(total);
                  }
                });
              }
            }
          }
        });
      }
      o.isSuspended = true;
    }
  }

  // --- FINAL DEDUPLICATION ---
  // Aynı mağaza + sipariş numarası + paket ID'sine sahip mükerrer AKTİF kayıtları temizle.
  // (Özellikle arka plan senkronizasyonu çakışmalarında veya API veri dalgalanmalarında oluşabilir)
  const seenActiveKeys = new Set<string>();
  const finalOrders: Order[] = [];

  for (const o of currentDbOrders) {
    // Arşivlenmiş olanları olduğu gibi koru (zaten ID'leri benzersizleşti)
    if (o.id.includes('_OLD_')) {
      finalOrders.push(o);
      continue;
    }

    const key = `${o.storeName}::${o.marketplaceOrderId}::${o.shipmentPackageId || ''}`;
    if (seenActiveKeys.has(key)) {
      console.warn(`[SYNC-DEDUPE] Mükerrer aktif sipariş temizlendi: ${key}`);
      continue;
    }
    seenActiveKeys.add(key);
    finalOrders.push(o);
  }

  return {
    updatedProducts: currentDbProducts,
    updatedOrders: finalOrders,
    newOrdersAddedCount,
    barcodesToSync
  };
  } finally {
    globalSyncLock = false;
  }
};
/**
 * Trendyol Müşteri Sorularını Çekme
 * GET /suppliers/{supplierId}/questions/filter
 */
async function getProductImageFromUrl(url: string): Promise<string> {
  if (!url || !url.includes('trendyol.com')) return '';
  try {
    const response = await fetch(url);
    if (!response.ok) return '';
    const html = await response.text();
    // Trendyol images are usually in cdn.dsmcdn.com/mnresize/...
    const match = html.match(/https:\/\/cdn\.dsmcdn\.com\/mnresize\/[0-9/]+\/[a-zA-Z0-9_-]+\/[^"]+1_org_zoom\.jpg/);
    if (match) return match[0];

    // Fallback any dsmcdn image
    const fallbackMatch = html.match(/https:\/\/cdn\.dsmcdn\.com\/mnresize\/[^\s"]+/);
    return fallbackMatch ? fallbackMatch[0] : '';
  } catch (e) {
    return '';
  }
}

/**
 * Trendyol Q&A yanıtında ürün linki farklı alan adlarıyla gelebilir.
 */
function pickQuestionProductPageUrl(item: any): string {
  const tryStr = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const keys = [
    'webUrl',
    'WebUrl',
    'productUrl',
    'ProductUrl',
    'productPageUrl',
    'productLink',
    'productWebUrl',
    'link',
    'url',
    'deepLink',
    'deeplink',
    'mobileWebUrl',
    'webLink'
  ];
  for (const k of keys) {
    const u = tryStr(item?.[k]);
    if (u) return u;
  }
  const prod = item?.product;
  if (prod && typeof prod === 'object') {
    for (const k of keys) {
      const u = tryStr(prod[k]);
      if (u) return u;
    }
  }
  return '';
}

function pickQuestionProductContentId(item: any): string {
  const tryId = (v: unknown) => {
    if (v === undefined || v === null) return '';
    return String(v).trim();
  };
  const candidates = [
    item?.productContentId,
    item?.contentId,
    item?.productMainId,
    item?.productId,
    item?.productMainid,
    item?.listingId,
    item?.product?.contentId,
    item?.product?.id,
    item?.product?.productId,
    item?.product?.productMainId,
    item?.product?.listingId
  ];
  for (const c of candidates) {
    const id = tryId(c);
    if (id) return id;
  }
  return '';
}

function trendyolPublicProductUrlFromContentId(contentId: string): string {
  if (!contentId) return '';
  return `https://www.trendyol.com/urun/-p-${encodeURIComponent(contentId)}`;
}

/** Müşterinin sorduğu anın zamanı (senkron zamanı değil). */
function parseTrendyolQuestionTimestamp(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return '';
    let ms = raw;
    // saniye cinsinden epoch (10 hane) vs milisaniye (13 hane)
    if (ms < 1e12) ms = ms * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    const y = d.getUTCFullYear();
    if (y < 2018 || y > 2035) return '';
    return d.toISOString();
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const asNum = Number(trimmed);
    if (!isNaN(asNum) && trimmed === String(asNum)) {
      return parseTrendyolQuestionTimestamp(asNum);
    }
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) return '';
    const y = d.getUTCFullYear();
    if (y < 2018 || y > 2035) return '';
    return d.toISOString();
  }
  return '';
}

function pickQuestionAskedAtIso(item: any): string {
  const keys = [
    'createdDate',
    'CreatedDate',
    'creationDate',
    'CreationDate',
    'questionDate',
    'QuestionDate',
    'askedDate',
    'AskedDate',
    'createDate',
    'CreateDate',
    'createdAt',
    'CreatedAt',
    'questionCreatedDate',
    'customerQuestionDate',
    'questionTime',
    'date'
  ];
  for (const k of keys) {
    const iso = parseTrendyolQuestionTimestamp(item?.[k]);
    if (iso) return iso;
  }
  const nested = item?.question;
  if (nested && typeof nested === 'object') {
    for (const k of keys) {
      const iso = parseTrendyolQuestionTimestamp(nested[k]);
      if (iso) return iso;
    }
  }
  return '';
}

export const syncMarketplaceQuestions = async (config: ApiConfig, status?: QuestionStatus): Promise<Question[]> => {
  if (config.isQuestionSyncEnabled === false) {
    console.log(`[QUESTION-SYNC-SKIP] ${config.storeName} için soru çekme devre dışı.`);
    return [];
  }
  if (globalSyncLock) {
    console.warn('[SYNC-LOCK] Soru senkronizasyonu zaten devam ediyor, atlanıyor.');
    return [];
  }
  globalSyncLock = true;
  try {
    // Note: Official Q&A endpoints use /integration/qna/sellers/{sellerId}/
    const baseUrl = `https://apigw.trendyol.com/integration/qna/sellers/${config.supplierId}/questions/filter`;

    // Construct query params
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    params.append('page', '0');
    params.append('size', '50'); // Fetch last 50 for sync

    const url = `${baseUrl}?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: getTrendyolHeaders(config)
    });

    if (response.ok) {
      const data = await response.json();
      const items = data.content || [];

      const normalizeQuestionImageUrl = (raw: unknown): string => {
        const u = typeof raw === 'string' ? raw.trim() : '';
        if (!u) return '';
        if (u.startsWith('//')) return `https:${u}`;
        if (u.startsWith('http://') || u.startsWith('https://')) return u;
        return `https://cdn.dsmcdn.com${u.startsWith('/') ? '' : '/'}${u}`;
      };

      const questions = items.map((item: any) => {
        const questionImageUrl = item.imageUrl || (item.imageUrls && item.imageUrls.length > 0 ? item.imageUrls[0] : '');
        const directUrl = pickQuestionProductPageUrl(item);
        const contentId = pickQuestionProductContentId(item);
        const fallbackUrl = !directUrl && contentId ? trendyolPublicProductUrlFromContentId(contentId) : '';
        const resolvedPageUrl = directUrl || fallbackUrl;

        const productImg =
          normalizeQuestionImageUrl(item.imageUrl) ||
          normalizeQuestionImageUrl(item.productMainImageUrl) ||
          '';

        return {
          id: `${config.storeName}_${item.id}`,
          marketplaceQuestionId: String(item.id),
          text: item.question || item.text || '',
          answer: item.answer?.text || '',
          status: (item.status as QuestionStatus) || QuestionStatus.WAITING_FOR_ANSWER,
          userName: item.userName || 'Müşteri',
          createdDate: pickQuestionAskedAtIso(item),
          productName: item.productName || 'Bilinmeyen Ürün',
          productImageUrl: productImg,
          productUrl: resolvedPageUrl,
          webUrl: directUrl || undefined,
          productContentId: contentId || undefined,
          storeName: config.storeName,
          isPublic: item.public || false,
          questionImageUrl: normalizeQuestionImageUrl(questionImageUrl)
        };
      });

      return questions;
    } else {
      // If apigw fails, fallback to sapigw if it exists for this endpoint
      console.warn(`[QUESTION-SYNC] apigw failed for ${config.storeName}, status: ${response.status}`);
      return [];
    }
  } catch (error) {
    console.error(`syncMarketplaceQuestions error for ${config.storeName}:`, error);
    return [];
  } finally {
    globalSyncLock = false;
  }
};

/**
 * Trendyol Müşteri Sorusu Cevaplama
 * POST /suppliers/{supplierId}/questions/{id}/answers
 */
export const answerMarketplaceQuestion = async (config: ApiConfig, questionId: string, answerText: string): Promise<boolean> => {
  try {
    const url = `https://apigw.trendyol.com/integration/qna/sellers/${config.supplierId}/questions/${questionId}/answers`;

    const response = await fetch(url, {
      method: 'POST',
      headers: getTrendyolHeaders(config),
      body: JSON.stringify({ text: answerText })
    });

    if (response.ok) {
      console.log(`[ANSWER-SUCCESS] Soru ${questionId} başarıyla cevaplandı.`);
      return true;
    } else {
      const errorMsg = await handleTrendyolError(response);
      throw new Error(`Soru cevaplama hatası: ${errorMsg}`);
    }
  } catch (error) {
    console.error('answerMarketplaceQuestion error:', error);
    throw error;
  }
};

/**
 * Trendyol İade Taleplerini Çekme (Claims)
 * GET /order/sellers/{sellerId}/claims
 */
export const syncMarketplaceClaims = async (config: ApiConfig): Promise<ReturnClaim[]> => {
  if (config.isReturnSyncEnabled === false) {
    console.log(`[RETURN-SYNC-SKIP] ${config.storeName} için iade çekme devre dışı.`);
    return [];
  }
  if (globalSyncLock) {
    console.warn('[SYNC-LOCK] İade senkronizasyonu zaten devam ediyor, atlanıyor.');
    return [];
  }
  globalSyncLock = true;
  try {
    const url = `https://apigw.trendyol.com/integration/order/sellers/${config.supplierId}/claims`;
    let page = 0;
    const size = 100;
    const allClaims: ReturnClaim[] = [];

    while (true) {
      // Sadece aksiyon alınabilir iadeleri çek, ancak 100 ile sınırlama (sayfalı çekim).
      const params = new URLSearchParams({
        claimItemStatus: 'WaitingInAction',
        page: String(page),
        size: String(size)
      });

      const response = await fetch(`${url}?${params.toString()}`, {
        method: 'GET',
        headers: getTrendyolHeaders(config)
      });

      if (!response.ok) {
        console.warn(`[CLAIM-SYNC] apigw failed for ${config.storeName}, status: ${response.status}`);
        break;
      }

      const data = await response.json();
      const content = data.content || [];
      if (content.length === 0) break;

      const flattened: ReturnClaim[] = [];
      for (const claimPackage of content) {
        const packageItems = claimPackage.items || [];
        for (const packageItem of packageItems) {
          const orderLine = packageItem.orderLine || {};
          const claimItems = packageItem.claimItems || [];

          let imageUrl = orderLine.productImageUrl || claimPackage.productImageUrl || claimPackage.imageUrl || '';
          if (imageUrl && typeof imageUrl === 'string') {
            if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
            else if (!imageUrl.startsWith('http')) imageUrl = 'https://cdn.dsmcdn.com' + (imageUrl.startsWith('/') ? '' : '/') + imageUrl;
          }

          const productUrl = orderLine.productUrl || claimPackage.productUrl || '';

          for (const claimLine of claimItems) {
            const reasonObj = claimLine.customerClaimItemReason || {};
            const lineStatusRaw = claimLine.claimItemStatus;
            const lineStatus =
              typeof lineStatusRaw === 'string'
                ? lineStatusRaw
                : (lineStatusRaw?.name || 'UNKNOWN');

            const cargoTrackingNumber = claimPackage.cargoTrackingNumber ? String(claimPackage.cargoTrackingNumber).trim() : '';
            // İade gönderi kodu olmayan kayıtları alma (yurtdışı/eksik kayıtları elemek için).
            if (!cargoTrackingNumber) {
              continue;
            }

            flattened.push({
              id: `${config.storeName}_${claimPackage.id}_${claimLine.id || orderLine.id || Math.random().toString(36).slice(2)}`,
              claimId: String(claimPackage.id),
              claimLineItemId: claimLine.id ? String(claimLine.id) : undefined,
              customerName: `${claimPackage.customerFirstName || ''} ${claimPackage.customerLastName || ''}`.trim() || 'Müşteri',
              orderNumber: String(claimPackage.orderNumber || ''),
              barcode: String(orderLine.barcode || claimPackage.barcode || 'NO-BARCODE'),
              productName: orderLine.productName || claimPackage.productName || 'Bilinmeyen Ürün',
              productImageUrl: imageUrl,
              productUrl: productUrl || undefined,
              reason: reasonObj.name || claimPackage.customerClaimReason || 'Belirtilmedi',
              description: claimLine.customerNote || claimLine.note || claimPackage.customerClaimDescription || '',
              status: (claimPackage.status || lineStatus || 'UNKNOWN').toUpperCase(),
              claimItemStatus: lineStatus?.toUpperCase(),
              returnQuantity: Number(orderLine.quantity || claimLine.quantity || 1) || 1,
              orderLineItemId: claimLine.orderLineItemId ? String(claimLine.orderLineItemId) : undefined,
              cargoTrackingNumber,
              color: orderLine.productColor || undefined,
              size: orderLine.productSize || undefined,
              storeName: config.storeName,
              claimDate: claimPackage.claimDate ? new Date(claimPackage.claimDate).toISOString() : new Date().toISOString()
            });
          }
        }
      }

      // Product image backfill from product page link when API image is missing.
      await Promise.all(flattened.map(async (claim) => {
        if (!claim.productImageUrl && claim.productUrl) {
          const img = await getProductImageFromUrl(claim.productUrl);
          if (img) claim.productImageUrl = img;
        }
      }));

      allClaims.push(...flattened);
      if (content.length < size) break;
      page++;
    }

    return allClaims;
  } catch (error) {
    console.error(`syncMarketplaceClaims error for ${config.storeName}:`, error);
    return [];
  } finally {
    globalSyncLock = false;
  }
};

/**
 * Trendyol İade Talebi Onaylama
 * PUT /order/sellers/{sellerId}/claims/{claimId}/approve
 */
export const approveMarketplaceClaim = async (config: ApiConfig, claimId: string, claimLineItemIdList: string[]): Promise<boolean> => {
  try {
    const url = `https://apigw.trendyol.com/integration/order/sellers/${config.supplierId}/claims/${claimId}/items/approve`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: getTrendyolHeaders(config),
      body: JSON.stringify({
        claimLineItemIdList,
        params: {}
      })
    });

    if (response.ok) {
      console.log(`[APPROVE-SUCCESS] İade ${claimId} başarıyla onaylandı.`);
      return true;
    } else {
      const errorMsg = await handleTrendyolError(response);
      throw new Error(`İade onaylama hatası: ${errorMsg}`);
    }
  } catch (error) {
    console.error('approveMarketplaceClaim error:', error);
    throw error;
  }
};
