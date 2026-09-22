import { Database, ApiConfig, Product, Variant, Order, OrderStatus, Question, QuestionStatus, ReturnClaim } from '../types';
import { resolveCountryCodeFromTrendyolApi, resolveCargoCompanyFromTrendyolApi, orderImportDismissKey } from '../utils/orderUtils';
import { getSyncableStock, getTotalStock } from '../utils/stockUtils';

let globalSyncLock = false;

/**
 * Safe fetch wrapper for marketplace requests.
 * In Electron desktop app, routes through the main process IPC ('marketplace-fetch')
 * which uses Node.js native network stack, completely bypassing browser CORS and preflight restrictions.
 */
export async function safeMarketplaceFetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  body: any;
  json: () => Promise<any>;
  text: () => Promise<string>;
}> {
  const method = options.method || 'GET';
  const headers = options.headers || {};
  let body = options.body;

  // 1. Try window.electron?.marketplaceFetch
  try {
    const electron = (typeof window !== 'undefined' ? (window as any).electron : null);
    if (electron && typeof electron.marketplaceFetch === 'function') {
      const result = await electron.marketplaceFetch({ url, method, headers, body });
      if (result && typeof result.ok === 'boolean') {
        const bodyVal = result.body;
        return {
          ok: result.ok,
          status: result.status,
          statusText: result.statusText || '',
          body: bodyVal,
          json: async () => (typeof bodyVal === 'object' && bodyVal !== null ? bodyVal : JSON.parse(bodyVal || '{}')),
          text: async () => (typeof bodyVal === 'string' ? bodyVal : JSON.stringify(bodyVal || ''))
        };
      }
    }
  } catch (err) {
    console.warn('[SAFE-FETCH-ELECTRON-ERROR]', err);
  }

  // 2. Try window.require('electron')?.ipcRenderer
  try {
    if (typeof window !== 'undefined' && typeof (window as any).require === 'function') {
      const electron = (window as any).require('electron');
      const ipc = electron?.ipcRenderer;
      if (ipc && typeof ipc.invoke === 'function') {
        const result = await ipc.invoke('marketplace-fetch', { url, method, headers, body });
        if (result && typeof result.ok === 'boolean') {
          const bodyVal = result.body;
          return {
            ok: result.ok,
            status: result.status,
            statusText: result.statusText || '',
            body: bodyVal,
            json: async () => (typeof bodyVal === 'object' && bodyVal !== null ? bodyVal : JSON.parse(bodyVal || '{}')),
            text: async () => (typeof bodyVal === 'string' ? bodyVal : JSON.stringify(bodyVal || ''))
          };
        }
      }
    }
  } catch (err) {
    // Ignore fallback error
  }

  // 3. Fallback to standard web fetch
  const stringBody = body !== undefined && body !== null
    ? (typeof body === 'string' ? body : JSON.stringify(body))
    : undefined;

  const res = await fetch(url, {
    method,
    headers,
    body: stringBody
  });

  const contentType = res.headers.get('content-type') || '';
  let parsedBody: any = null;
  let textBody: string = '';
  try {
    if (contentType.includes('application/json')) {
      parsedBody = await res.json();
    } else {
      textBody = await res.text();
    }
  } catch {
    // Ignore parsing error
  }

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    body: parsedBody ?? textBody,
    json: async () => parsedBody ?? (textBody ? JSON.parse(textBody) : {}),
    text: async () => textBody || (parsedBody ? JSON.stringify(parsedBody) : '')
  };
}


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
        quantity: getTotalStock(variant),
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
const handleTrendyolError = async (response: Response | any): Promise<string> => {
  let errorText = '';
  try {
    if (typeof response.clone === 'function') {
      const clonedResponse = response.clone();
      const errorData = await clonedResponse.json();
      errorText = JSON.stringify(errorData);
    } else if (typeof response.json === 'function') {
      const errorData = await response.json();
      errorText = JSON.stringify(errorData);
    }
  } catch {
    try {
      if (typeof response.text === 'function') {
        errorText = await response.text();
      } else {
        errorText = String(response.body || 'Bilinmeyen hata');
      }
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

  if (config.type !== 'TRENDYOL') {
    return await syncBarcodeStockBatch(config, [{ barcode, quantity }], settings);
  }

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
  items: { barcode: string, quantity: number, salePrice?: number, listPrice?: number }[],
  settings?: any
): Promise<boolean> => {
  if (items.length === 0 || !config) return true;
  if (config.enableStockSync === false) return true;

  if (config.type === 'HEPSIBURADA') {
    return await syncBarcodeStockBatchHepsiburada(config, items, settings);
  }
  if (config.type === 'PAZARAMA') {
    return await syncBarcodeStockBatchPazarama(config, items, settings);
  }
  if (config.type === 'N11') {
    return await syncBarcodeStockBatchN11(config, items, settings);
  }
  if (config.type === 'AMAZON') {
    return await syncBarcodeStockBatchAmazon(config, items, settings);
  }
  if (config.type === 'IDEFIX') {
    return await syncBarcodeStockBatchIdefix(config, items, settings);
  }
  if (config.type === 'MANUAL') {
    return true;
  }

  // Chunk items into segments of 500 (safe limit) for Trendyol
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

      if (config.type === 'TRENDYOL') {
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

        const url = `https://apigw.trendyol.com/integration/order/sellers/${config.supplierId}/shipment-packages/${order.shipmentPackageId}`;

        const payload: any = {
          lines: order.items.map(item => ({
            lineId: parseInt(String(item.orderItemId)),
            quantity: item.quantity
          })),
          status: trendyolStatus,
          params: {}
        };

        if (trendyolStatus === 'Invoiced' && invoiceNumber) {
          (payload as any).invoiceNumber = invoiceNumber;
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
      } else if (config.type === 'PAZARAMA') {
        if (newStatus === OrderStatus.PROCESSING) {
          try {
            const accessToken = await getPazaramaAccessToken(config);
            const ordNum = Number(order.marketplaceOrderId);
            const payload = {
              orderNumber: isNaN(ordNum) ? order.marketplaceOrderId : ordNum,
              status: 12 // Siparişiniz Hazırlanıyor
            };
            const response = await fetch('https://isortagimapi.pazarama.com/order/updateOrderStatusList', {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(payload)
            });
            if (response.ok) {
              console.log(`[SYNC-STATUS-SUCCESS] Pazarama siparişi ${order.marketplaceOrderId} durumu 12 (Hazırlanıyor) yapıldı.`);
            } else {
              const errMsg = await handlePazaramaError(response);
              console.warn(`[SYNC-STATUS-WARN] Pazarama durum güncelleme uyarısı (${order.marketplaceOrderId}): ${errMsg}`);
            }
          } catch (pazErr) {
            console.error(`[SYNC-STATUS-ERROR] Pazarama durum güncelleme hatası:`, pazErr);
          }
        } else {
          console.log(`[SYNC-STATUS] Pazarama siparişi (${order.marketplaceOrderId}) yerel olarak ${newStatus} durumuna alındı.`);
        }
      } else if (config.type === 'HEPSIBURADA') {
        if (newStatus === OrderStatus.PROCESSING) {
          try {
            const baseUrl = getHepsiburadaBaseUrl(config);
            const headers = getHepsiburadaHeaders(config);
            const url = `${baseUrl}/packages/merchantid/${config.supplierId.trim()}`;
            
            const lineItemRequests = (order.items || []).map((it: any) => ({
              id: it.orderItemId,
              quantity: it.quantity || 1
            }));

            if (lineItemRequests.length > 0) {
              const payload = {
                parcelQuantity: 1,
                deci: 1,
                lineItemRequests: lineItemRequests
              };

              const response = await safeMarketplaceFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
              });

              if (response.ok) {
                console.log(`[SYNC-STATUS-SUCCESS] Hepsiburada siparişi ${order.marketplaceOrderId} paketlendi ve gönderime hazır yapıldı.`);
              } else {
                const errText = await response.text();
                console.warn(`[SYNC-STATUS-WARN] Hepsiburada paketleme yanıtı (${order.marketplaceOrderId}): ${response.status} - ${errText}`);
              }
            } else {
              console.log(`[SYNC-STATUS] Hepsiburada siparişi (${order.marketplaceOrderId}) yerel olarak ${newStatus} durumuna alındı.`);
            }
          } catch (hbPackErr) {
            console.error(`[SYNC-STATUS-ERROR] Hepsiburada paketleme hatası:`, hbPackErr);
          }
        } else {
          console.log(`[SYNC-STATUS] Hepsiburada siparişi (${order.marketplaceOrderId}) yerel olarak ${newStatus} durumuna alındı.`);
        }
      } else if (config.type === 'N11') {
        if (newStatus === OrderStatus.PROCESSING) {
          try {
            const lineIds = (order.items || [])
              .map((it: any) => Number(it.orderItemId))
              .filter((id: number) => !isNaN(id) && id > 0);

            if (lineIds.length > 0) {
              const url = 'https://api.n11.com/rest/order/v1/update';
              const payload = {
                lines: lineIds.map((id: number) => ({ lineId: id })),
                status: 'Picking'
              };

              const response = await safeMarketplaceFetch(url, {
                method: 'PUT',
                headers: getN11Headers(config),
                body: JSON.stringify(payload)
              });

              if (response.ok) {
                console.log(`[SYNC-STATUS-SUCCESS] N11 siparişi ${order.marketplaceOrderId} kalemleri Picking durumuna alındı.`);
              } else {
                const errText = await handleN11Error(response);
                console.warn(`[SYNC-STATUS-WARN] N11 durum güncelleme yanıtı (${order.marketplaceOrderId}): ${errText}`);
              }
            }
          } catch (n11Err) {
            console.error(`[SYNC-STATUS-ERROR] N11 durum güncelleme hatası:`, n11Err);
          }
        } else {
          console.log(`[SYNC-STATUS] N11 siparişi (${order.marketplaceOrderId}) yerel olarak ${newStatus} durumuna alındı.`);
        }
      } else if (config.type === 'IDEFIX') {
        const vendorId = (config.supplierId || '').trim();
        const shipmentId = order.shipmentPackageId || order.marketplaceOrderId;
        if (vendorId && shipmentId && newStatus === OrderStatus.PROCESSING) {
          try {
            const url = `https://merchantapi.idefix.com/oms/${vendorId}/${shipmentId}/update-shipment-status`;
            const response = await safeMarketplaceFetch(url, {
              method: 'POST',
              headers: getIdefixHeaders(config),
              body: JSON.stringify({
                status: 'picking',
                invoiceNumber: ''
              })
            });
            if (response.ok) {
              console.log(`[SYNC-STATUS-SUCCESS] İdefix siparişi ${order.marketplaceOrderId} (Shipment: ${shipmentId}) picking durumuna alındı.`);
            } else {
              console.warn(`[SYNC-STATUS-WARN] İdefix durum güncelleme yanıtı: ${response.status}`);
            }
          } catch (idefixErr) {
            console.error(`[SYNC-STATUS-ERROR] İdefix durum güncelleme hatası:`, idefixErr);
          }
        } else {
          console.log(`[SYNC-STATUS] İdefix siparişi (${order.marketplaceOrderId}) yerel olarak ${newStatus} durumuna alındı.`);
        }
      } else {
        // Diğer pazaryerleri için statü senkronizasyonu yerel olarak loglanır
        console.log(`[SYNC-STATUS] ${config.type} siparişi (${order.marketplaceOrderId}) yerel olarak ${newStatus} durumuna alındı.`);
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
            ...(v.stocks || {}),
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

    const isHbRealTest = config.type === 'HEPSIBURADA' && Boolean(config.supplierId);

    if (config.mode === 'TEST' && !isHbRealTest) {
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
        if (config.type === 'TRENDYOL') {
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

        // 2.5. Taşıma Durumundaki Siparişleri Çek (status: 'Shipped')
        const shippedFetchDays = db.settings.shippedOrderFetchDays ?? 14;
        const shippedHorizonMs = shippedFetchDays * 86400000;
        for (let windowEnd = nowMs; windowEnd > nowMs - shippedHorizonMs; windowEnd -= twoWeeksMs) {
          const windowStart = Math.max(windowEnd - twoWeeksMs, nowMs - shippedHorizonMs);
          let page = 0;
          while (true) {
            const pageOrders = await fetchOrdersFromTrendyol(config, {
              status: 'Shipped',
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
          (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING || o.status === OrderStatus.SHIPPING) &&
          !o.id.includes('_OLD_') &&
          // Son 30 güne ait aktif ve taşıma durumundaki yerel siparişleri kontrol et (aşırı eskilere bakıp API'yi yormamak için)
          (Date.now() - new Date(o.orderDate).getTime() < 30 * 86400000)
        );

        for (const localOrder of activeLocalOrders) {
          const key = `${localOrder.storeName}::${localOrder.marketplaceOrderId}::${localOrder.shipmentPackageId || ''}`;
          if (!fetchedKeys.has(key)) {
            console.log(`[ORDER-SYNC] Aktif/Taşıma durumunda olup listede olmayan sipariş tespit edildi, detay güncelleniyor: ${localOrder.marketplaceOrderId}`);
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
        } else if (config.type === 'HEPSIBURADA') {
          const hbOrders = await fetchOrdersFromHepsiburada(config, { size: 100 });
          hbOrders.forEach(o => content.push(o));

          // HB için yerel veritabanında aktif veya kargoda olup listede dönmemiş siparişlerin güncel durumunu tekil sorgula
          const fetchedHbKeys = new Set(hbOrders.map(o => `${config.storeName}::${o.orderNumber}`));
          const activeLocalHbOrders = currentDbOrders.filter((o: any) =>
            o.storeName === config.storeName &&
            (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING || o.status === OrderStatus.SHIPPING) &&
            !o.id.includes('_OLD_') &&
            (Date.now() - new Date(o.orderDate).getTime() < 30 * 86400000)
          );

          for (const localOrder of activeLocalHbOrders) {
            const key = `${localOrder.storeName}::${localOrder.marketplaceOrderId}`;
            if (!fetchedHbKeys.has(key)) {
              try {
                const freshHb = await fetchOrdersFromHepsiburada(config, { orderNumber: localOrder.marketplaceOrderId });
                if (freshHb && freshHb.length > 0) {
                  content.push(freshHb[0]);
                }
              } catch (e) {
                console.error(`[HB-ORDER-SYNC] Tekil sipariş kontrol hatası (${localOrder.marketplaceOrderId}):`, e);
              }
            }
          }
        } else if (config.type === 'N11') {
          const seenN11Keys = new Set<string>();

          // 1. Yeni siparişler (Created)
          try {
            const createdOrders = await fetchOrdersFromN11(config, { status: 'Created', size: 100 });
            for (const o of createdOrders) {
              const key = `${o.orderNumber}::${o.shipmentPackageId || ''}`;
              if (!seenN11Keys.has(key)) {
                seenN11Keys.add(key);
                content.push(o);
              }
            }
          } catch (n11CrErr) {
            console.warn(`[SYNC-N11-CREATED-WARN]`, n11CrErr);
          }

          // 2. Hazırlanan / Onaylı siparişler (Picking)
          try {
            const pickingOrders = await fetchOrdersFromN11(config, { status: 'Picking', size: 100 });
            for (const o of pickingOrders) {
              const key = `${o.orderNumber}::${o.shipmentPackageId || ''}`;
              if (!seenN11Keys.has(key)) {
                seenN11Keys.add(key);
                content.push(o);
              }
            }
          } catch (n11PickErr) {
            console.warn(`[SYNC-N11-PICKING-WARN]`, n11PickErr);
          }

          // 3. Kargodaki siparişler (Shipped)
          const shippedFetchDays = db.settings.shippedOrderFetchDays ?? 14;
          const shippedStartDate = Date.now() - (shippedFetchDays * 86400000);
          try {
            const shippedOrders = await fetchOrdersFromN11(config, { status: 'Shipped', startDate: shippedStartDate, size: 100 });
            for (const o of shippedOrders) {
              const key = `${o.orderNumber}::${o.shipmentPackageId || ''}`;
              if (!seenN11Keys.has(key)) {
                seenN11Keys.add(key);
                content.push(o);
              }
            }
          } catch (n11ShipErr) {
            console.warn(`[SYNC-N11-SHIPPED-WARN]`, n11ShipErr);
          }

          // 4. Yerel veritabanında aktif veya kargoda olup listede dönmemiş siparişleri tekil sorgula
          const activeLocalN11Orders = currentDbOrders.filter((o: any) =>
            o.storeName === config.storeName &&
            (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING || o.status === OrderStatus.SHIPPING) &&
            !o.id.includes('_OLD_') &&
            (Date.now() - new Date(o.orderDate).getTime() < 30 * 86400000)
          );

          for (const localOrder of activeLocalN11Orders) {
            const hasOrderKey = Array.from(seenN11Keys).some(k => k.startsWith(`${localOrder.marketplaceOrderId}::`));
            if (!hasOrderKey) {
              try {
                const freshN11 = await fetchOrdersFromN11(config, { orderNumber: localOrder.marketplaceOrderId });
                if (freshN11 && freshN11.length > 0) {
                  for (const fo of freshN11) {
                    content.push(fo);
                  }
                }
              } catch (e) {
                console.error(`[N11-SYNC] Tekil sipariş kontrol hatası (${localOrder.marketplaceOrderId}):`, e);
              }
            }
          }
        } else if (config.type === 'AMAZON') {
          let pageOrders = await fetchOrdersFromAmazon(config, { status: 'Unshipped', size: 50 });
          pageOrders.forEach(o => content.push(o));
          pageOrders = await fetchOrdersFromAmazon(config, { status: 'PartiallyShipped', size: 50 });
          pageOrders.forEach(o => content.push(o));
        } else if (config.type === 'PAZARAMA') {
          const seenPazaramaKeys = new Set<string>();
          // 1. Genel / Aktif siparişleri çek (filtre verilmeden)
          try {
            const pazaramaOrders = await fetchOrdersFromPazarama(config, {
              size: 100
            });
            for (const o of pazaramaOrders) {
              const key = `${o.orderNumber}::${o.shipmentPackageId || ''}`;
              if (!seenPazaramaKeys.has(key)) {
                seenPazaramaKeys.add(key);
                content.push(o);
              }
            }
          } catch (pazGenErr) {
            console.warn(`[SYNC-PAZARAMA-WARN] Genel çekim:`, pazGenErr);
          }

          // 2. Kargodaki (Taşıma Durumundaki) siparişleri de çek (status: 5)
          const shippedFetchDays = db.settings.shippedOrderFetchDays ?? 14;
          const shippedStartDate = Date.now() - (shippedFetchDays * 86400000);
          try {
            const shippedOrders = await fetchOrdersFromPazarama(config, {
              status: 5,
              startDate: shippedStartDate,
              size: 100
            });
            for (const o of shippedOrders) {
              const key = `${o.orderNumber}::${o.shipmentPackageId || ''}`;
              if (!seenPazaramaKeys.has(key)) {
                seenPazaramaKeys.add(key);
                content.push(o);
              }
            }
          } catch (pazShippedErr) {
            console.warn(`[SYNC-PAZARAMA-SHIPPED-WARN]`, pazShippedErr);
          }

          // 3. İptal Edilen Siparişleri Çek (status: 6 ve status: 13)
          for (const cStatus of [6, 13]) {
            try {
              const cancelledOrders = await fetchOrdersFromPazarama(config, {
                status: cStatus,
                startDate: shippedStartDate,
                size: 100
              });
              for (const o of cancelledOrders) {
                const key = `${o.orderNumber}::${o.shipmentPackageId || ''}`;
                if (!seenPazaramaKeys.has(key)) {
                  seenPazaramaKeys.add(key);
                  content.push(o);
                }
              }
            } catch (pazCancelErr) {
              console.warn(`[SYNC-PAZARAMA-CANCEL-WARN] (${cStatus}):`, pazCancelErr);
            }
          }

          // 4. Pazarama için yerel veritabanında aktif veya kargoda olup listede dönmemiş siparişlerin güncel durumunu tekil sorgula
          const activeLocalPazaramaOrders = currentDbOrders.filter((o: any) =>
            o.storeName === config.storeName &&
            (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING || o.status === OrderStatus.SHIPPING) &&
            !o.id.includes('_OLD_') &&
            (Date.now() - new Date(o.orderDate).getTime() < 30 * 86400000)
          );

          for (const localOrder of activeLocalPazaramaOrders) {
            const hasOrderKey = Array.from(seenPazaramaKeys).some(k => k.startsWith(`${localOrder.marketplaceOrderId}::`));
            if (!hasOrderKey) {
              try {
                console.log(`[PAZARAMA-SYNC] Aktif olup listede olmayan sipariş tekil sorgulanıyor: ${localOrder.marketplaceOrderId}`);
                const freshPaz = await fetchOrdersFromPazarama(config, { orderNumber: localOrder.marketplaceOrderId });
                if (freshPaz && freshPaz.length > 0) {
                  for (const fo of freshPaz) {
                    content.push(fo);
                  }
                }
              } catch (e) {
                console.error(`[PAZARAMA-SYNC] Tekil sipariş kontrol hatası (${localOrder.marketplaceOrderId}):`, e);
              }
            }
          }
        } else if (config.type === 'IDEFIX') {
          const seenIdefixKeys = new Set<string>();

          // 1. Yeni ve Hazırlanmaya Başlanabilir Siparişler (shipment_ready, created, shipment_picking)
          for (const st of ['shipment_ready', 'created', 'shipment_picking']) {
            try {
              const orders = await fetchOrdersFromIdefix(config, { state: st, limit: 50 });
              for (const o of orders) {
                const key = `${o.orderNumber}::${o.shipmentPackageId || ''}`;
                if (!seenIdefixKeys.has(key)) {
                  seenIdefixKeys.add(key);
                  content.push(o);
                }
              }
            } catch (err) {
              console.warn(`[SYNC-IDEFIX-WARN] (${st}):`, err);
            }
          }

          // 2. Kargodaki Siparişler (shipment_in_cargo)
          try {
            const shippedOrders = await fetchOrdersFromIdefix(config, { state: 'shipment_in_cargo', limit: 50 });
            for (const o of shippedOrders) {
              const key = `${o.orderNumber}::${o.shipmentPackageId || ''}`;
              if (!seenIdefixKeys.has(key)) {
                seenIdefixKeys.add(key);
                content.push(o);
              }
            }
          } catch (err) {
            console.warn(`[SYNC-IDEFIX-SHIPPED-WARN]:`, err);
          }

          // 3. Yerel veritabanında aktif veya kargoda olup listede dönmemiş İdefix siparişlerini tekil sorgula
          const activeLocalIdefixOrders = currentDbOrders.filter((o: any) =>
            o.storeName === config.storeName &&
            (o.status === OrderStatus.NEW || o.status === OrderStatus.PROCESSING || o.status === OrderStatus.SHIPPING) &&
            !o.id.includes('_OLD_') &&
            (Date.now() - new Date(o.orderDate).getTime() < 30 * 86400000)
          );

          for (const localOrder of activeLocalIdefixOrders) {
            const hasOrderKey = Array.from(seenIdefixKeys).some(k => k.startsWith(`${localOrder.marketplaceOrderId}::`));
            if (!hasOrderKey) {
              try {
                const freshIdefix = await fetchOrdersFromIdefix(config, { orderNumber: localOrder.marketplaceOrderId });
                if (freshIdefix && freshIdefix.length > 0) {
                  for (const fo of freshIdefix) {
                    content.push(fo);
                  }
                }
              } catch (e) {
                console.error(`[IDEFIX-SYNC] Tekil sipariş kontrol hatası (${localOrder.marketplaceOrderId}):`, e);
              }
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
      
      // 3 Saatlik zaman kayması düzeltmesi (SADECE Trendyol API timestamp offset sorunu için)
      const orderDate = config.type === 'TRENDYOL'
        ? new Date(orderTimestamp - (3 * 3600 * 1000))
        : new Date(orderTimestamp);

      let mappedStatus = OrderStatus.NEW;
      const status = (apiOrder.status || apiOrder.shipmentPackageStatus || '').toString().toLowerCase().trim();

      const isShippingStatus = 
        status === 'shipped' ||
        status === 'shipping' ||
        status === 'undelivered' ||
        status === 'kargolandi' ||
        status === 'kargolandı' ||
        status === 'kargoda' ||
        status === 'kargoya verildi' ||
        status === 'kargoya_verildi' ||
        status === 'siparişiniz kargoya verildi' ||
        status === 'siparisiniz kargoya verildi' ||
        status === 'intransit' ||
        status === 'in_transit' ||
        status === 'in transit' ||
        status === 'tasimada' ||
        status === 'taşıma durumunda' ||
        status === 'tasima durumunda' ||
        status === 'sevk edildi' ||
        status === 'shipment_in_cargo' ||
        status === '5' ||
        status === '14';

      const isDeliveredStatus = 
        status === 'delivered' ||
        status === 'completed' ||
        status === 'teslim_edildi' ||
        status === 'teslim edildi' ||
        status === 'teslimedildi' ||
        status === 'tamamlandı' ||
        status === 'tamamlandi' ||
        status === 'shipment_delivered' ||
        status === 'shipment_approved' ||
        status === '11';

      const isCancelledStatus = 
        status === 'cancelled' ||
        status === 'canceled' ||
        status === 'iptal' ||
        status === 'iptal_edildi' ||
        status === 'iptal edildi' ||
        status === 'siparişiniz iptal edildi' ||
        status === 'siparisiniz iptal edildi' ||
        status === 'tedarik edilemedi' ||
        status === 'tedarik_edilemedi' ||
        status === 'shipment_cancelled' ||
        status === 'shipment_unsupplied' ||
        status === '6' ||
        status === '13' ||
        status === '18' ||
        status.includes('cancel') ||
        status.includes('iptal');

      const isProcessingStatus = 
        status === 'picking' ||
        status === 'processing' ||
        status === 'approved' ||
        status === 'packed' ||
        status === 'readytoship' ||
        status === 'ready_to_ship' ||
        status === 'gönderime hazır' ||
        status === 'gonderime hazir' ||
        status === 'hazırlanıyor' ||
        status === 'hazirlaniyor' ||
        status === 'siparişiniz hazırlanıyor' ||
        status === 'siparisiniz hazirlaniyor' ||
        status === 'waitingforshipment' ||
        status === 'onaylandı' ||
        status === 'onaylandi' ||
        status === 'shipment_picking' ||
        status === 'shipment_invoiced' ||
        status === '12';

      const isNewStatus = 
        status === 'created' ||
        status === 'new' ||
        status === 'pending' ||
        status === 'unpacked' ||
        status === 'open' ||
        status === 'yeni' ||
        status === 'alındı' ||
        status === 'siparişiniz alındı' ||
        status === 'siparisiniz alindi' ||
        status === 'shipment_ready' ||
        status === '1' ||
        status === '2' ||
        status === '3';

      if (isShippingStatus) mappedStatus = OrderStatus.SHIPPING;
      else if (isDeliveredStatus) mappedStatus = OrderStatus.DELIVERED;
      else if (isCancelledStatus) mappedStatus = OrderStatus.CANCELLED;
      else if (isProcessingStatus) mappedStatus = OrderStatus.PROCESSING;
      else if (isNewStatus) mappedStatus = OrderStatus.NEW;

      // Ülke ve Kargo Firması Belirleme (Trendyol vs Diğer Pazaryerleri)
      // Ülke gelmediğinde varsayılan 'TR' atanır
      const resolvedCountry = config.type === 'TRENDYOL'
        ? resolveCountryCodeFromTrendyolApi(apiOrder)
        : (apiOrder.countryCode || apiOrder.shipmentAddress?.countryCode || 'TR');

      const resolvedCargoCompany = config.type === 'TRENDYOL'
        ? resolveCargoCompanyFromTrendyolApi(apiOrder)
        : (apiOrder.cargoCompanyName || resolveCargoCompanyFromTrendyolApi(apiOrder) || undefined);

      // Arşivlenmiş (_OLD_) olanları hariç tut, aktifi bul + MAĞAZA KONTROLÜ + SHIPMENT PACKAGE ID (Split Shipment support)
      let existingOrderIndex = currentDbOrders.findIndex(o =>
        o.marketplaceOrderId === apiOrder.orderNumber &&
        o.storeName === config.storeName &&
        (!apiOrder.shipmentPackageId || !o.shipmentPackageId || String(o.shipmentPackageId) === String(apiOrder.shipmentPackageId)) &&
        !o.id.includes('_OLD_')
      );

      // Itemları Hazırla
      const orderItems: any[] = (apiOrder.lines || []).map((line: any) => {
        let productName = line.productName || line.name || '';
        let color = line.attributes?.find((attr: any) => ['Renk', 'Color', 'RENK'].includes(attr.attributeName))?.attributeValue || line.productColor || line.color || '';

        const candidateSet = new Set<string>();
        const addCandidate = (val: any) => {
          if (!val) return;
          const s = String(val).trim();
          if (s && s !== 'NO-BARCODE') {
            candidateSet.add(s);
          }
        };

        addCandidate(line.barcode);
        addCandidate(line.merchantSku);
        addCandidate(line.sku);
        addCandidate(line.hbSku);
        addCandidate(line.rawBarcode);
        addCandidate(line.extractedTailBarcode);
        addCandidate(line.stockCode);
        addCandidate(line.StockCode);
        addCandidate(line.fullData?.productBarcode);
        addCandidate(line.fullData?.barcode);
        addCandidate(line.fullData?.Barcode);
        addCandidate(line.fullData?.merchantSKU);
        addCandidate(line.fullData?.merchantSku);
        addCandidate(line.fullData?.sku);
        addCandidate(line.fullData?.stockCode);
        addCandidate(line.fullData?.StockCode);

        // Also if any candidate has hyphen, extract parts
        for (const cand of Array.from(candidateSet)) {
          if (cand.includes('-')) {
            const parts = cand.split('-');
            const tail = parts[parts.length - 1].trim();
            if (tail) addCandidate(tail);
          }
        }

        const searchCandidates = Array.from(candidateSet);
        const searchCandidatesLower = searchCandidates.map(c => c.toLowerCase());

        // 1. DIRECT VARIANT MATCH: Check if any candidate matches variant barcode or variant arma/sku
        let matchedProduct = currentDbProducts.find(p =>
          p.variants.some(v => {
            const vb = String(v.barcode || '').trim().toLowerCase();
            const va = String((v as any).arma || (v as any).data?.arma || '').trim().toLowerCase();
            return searchCandidatesLower.some(c => (vb && c === vb) || (va && c === va));
          })
        );
        let matchedVariant = matchedProduct?.variants.find(v => {
          const vb = String(v.barcode || '').trim().toLowerCase();
          const va = String((v as any).arma || (v as any).data?.arma || '').trim().toLowerCase();
          return searchCandidatesLower.some(c => (vb && c === vb) || (va && c === va));
        });

        // 2. PRODUCT MATCH: If not directly found, match product by productCode or candidate prefix or name
        if (!matchedProduct) {
          matchedProduct = currentDbProducts.find(p => {
            const pcode = String(p.productCode || '').trim().toLowerCase();
            const pname = String(p.name || '').trim().toLowerCase();
            if (!pcode && !pname) return false;

            const codeMatch = pcode && searchCandidatesLower.some(c => 
              c === pcode || 
              c.startsWith(pcode + ' ') || 
              c.startsWith(pcode + '-') ||
              (pcode === 'tps' && (c.includes('tp sort') || c.includes('tpsort')))
            );
            if (codeMatch) return true;

            const nameMatch = pname && (
              String(line.productName || '').toLowerCase().includes(pname) ||
              pname.includes(String(line.productName || '').toLowerCase())
            );
            return nameMatch;
          });
        }

        // 3. If Product is matched but Variant not yet matched, find variant by size & color:
        if (!matchedVariant && matchedProduct && matchedProduct.variants.length > 0) {
          const lineSize = String(line.attributes?.find((attr: any) => ['Beden', 'Size', 'BEDEN'].includes(attr.attributeName))?.attributeValue || line.size || line.productSize || '').trim().toLowerCase();
          const rawLineCol = String(color || line.color || line.productColor || '').trim().toLowerCase();
          const cleanLineCol = rawLineCol.split(/\s+/).pop() || rawLineCol;

          // Try matching both size and color
          let sizeAndColMatched = matchedProduct.variants.find(v => {
            const vs = String(v.size || '').trim().toLowerCase();
            const vc = String(v.color || '').trim().toLowerCase();
            const sizeOk = !lineSize || vs === lineSize;
            const colOk = !cleanLineCol || vc === cleanLineCol || vc === rawLineCol || vc.includes(cleanLineCol) || cleanLineCol.includes(vc);
            return sizeOk && colOk;
          });

          // Fallback: match size only
          let sizeOnlyMatched = matchedProduct.variants.find(v => {
            const vs = String(v.size || '').trim().toLowerCase();
            return lineSize && vs === lineSize;
          });

          matchedVariant = sizeAndColMatched || sizeOnlyMatched || matchedProduct.variants[0];
        }

        // Fallback color from DB
        if (!color && matchedVariant) {
          color = matchedVariant.color;
        }

        // Fallback productName from DB if marketplace is empty or generic
        if ((!productName || productName === 'Ürün' || productName === 'Ürün adı mevcut değil') && matchedProduct) {
          productName = matchedProduct.name;
        }
        if (!productName) {
          productName = line.merchantSku || 'Ürün adı mevcut değil';
        }

        // Effective Barcode:
        // Hepsiburada için kullanıcı kuralı: "hepsi burada da hem satıcı stok kodu hem sku hemde barkod bilgisi var bir üründe,
        // hepsiburada da satıcı stok kodu bizim programda sku ya yazılıyor bu normal ama hb deki sku (HBCV...) bizde barkod olarak gözüksün"
        const effectiveBarcode = (config.type === 'HEPSIBURADA' && line.hbSku)
          ? line.hbSku
          : (matchedVariant?.barcode
             || (line.barcode && line.barcode !== 'NO-BARCODE' ? line.barcode : '')
             || searchCandidates[0]
             || 'NO-BARCODE');

        const effectiveSku = line.merchantSku || line.sku || (matchedVariant as any)?.arma || matchedProduct?.productCode || '';

        return {
          orderItemId: String(line.orderItemId || line.id || line.OrderItemId || Math.random().toString(36).substr(2, 9)),
          barcode: effectiveBarcode,
          productName: productName,
          sku: effectiveSku,
          merchantSku: line.merchantSku || effectiveSku,
          hbSku: line.hbSku,
          rawBarcode: line.rawBarcode || (line.fullData?.productBarcode ? String(line.fullData.productBarcode) : undefined),
          matchedVariantBarcode: matchedVariant?.barcode,
          color: color,
          size: line.attributes?.find((attr: any) => ['Beden', 'Size', 'BEDEN'].includes(attr.attributeName))?.attributeValue || line.size || matchedVariant?.size || '',
          productSize: line.productSize || line.size || matchedVariant?.size || '',
          quantity: Number(line.quantity || line.amount || 1),
          unitPrice: Number(line.price ?? line.unitPrice ?? line.UnitPrice ?? 0),
          costPrice: matchedVariant?.costPrice || matchedProduct?.costPrice || 0,
          totalPrice: (Number(line.price ?? line.unitPrice ?? line.UnitPrice ?? 0)) * (Number(line.quantity || line.amount || 1)),
          vatRate: Number(line.vatRate || line.VatRate || 0),
          commission: line.commission,
          lineGrossAmount: line.lineGrossAmount,
          fullData: line // Satır bazlı ham veriyi sakla
        };
      });

      // --- [STRICT-IMPORT-FILTER v1.6.6] ---
      // Eğer sipariş sistemde YOKSA:
      if (existingOrderIndex === -1) {
        // 1. Statü Kontrolü: 'Yeni', 'İşleme Alınan', 'Taşıma Durumunda' veya 'Teslim Edildi' siparişleri sisteme dahil et.
        if (mappedStatus !== OrderStatus.NEW && mappedStatus !== OrderStatus.PROCESSING && mappedStatus !== OrderStatus.SHIPPING && mappedStatus !== OrderStatus.DELIVERED) {
          continue;
        }

        // 2. Tarih Kontrolü: Eğer 'Sipariş Çekme Sınırı' aktifse, belirlenen günden eski siparişleri sisteme alma.
        // Taşıma durumundaki veya teslim edilmiş siparişler için db.settings.shippedOrderFetchDays (varsayılan 14 gün) dikkate alınır.
        if (db.settings.enableOrderVisibilityLimit) {
          const limitDays = (mappedStatus === OrderStatus.SHIPPING || mappedStatus === OrderStatus.DELIVERED)
            ? (db.settings.shippedOrderFetchDays ?? 14)
            : (db.settings.orderFetchDays || 2);
          const limitDate = new Date();
          limitDate.setDate(limitDate.getDate() - limitDays);
          limitDate.setHours(0, 0, 0, 0); // O günün başlangıcı (00:00)
          
          if (orderDate.getTime() < limitDate.getTime()) {
            console.log(`[ORDER-SYNC] Tarih sınırına takıldı (${mappedStatus}): ${apiOrder.orderNumber} (${orderDate.toLocaleString()})`);
            continue;
          }
        }
      }

      // --- EXISTING ORDER UPDATE LOGIC ---
      if (existingOrderIndex > -1) {
        const existingOrder = currentDbOrders[existingOrderIndex];

        // BOŞ SİPARİŞİ KURTARMA (Eski hatalı çekimden kalan 0 kalemli siparişleri düzeltme)
        if ((!existingOrder.items || existingOrder.items.length === 0) && orderItems.length > 0) {
          console.log(`[ORDER-RECOVER] Sipariş ${apiOrder.orderNumber} veritabanında boş kalemlerle kayıtlıydı. Kayıt temizlenip baştan eksiksiz işleniyor...`);
          currentDbOrders.splice(existingOrderIndex, 1);
          existingOrderIndex = -1;
        }
      }

      if (existingOrderIndex > -1) {
        const existingOrder = currentDbOrders[existingOrderIndex];

        // Zaten iptal edilmişse işlem yapma
        if (existingOrder.status === OrderStatus.CANCELLED) {
          continue;
        }

        // [KRİTİK - TRENDYOL MANTIĞI]: Teslim edilmiş siparişler ASLA iptale düşürülemez veya teslim edildi alanından kaldırılamaz!
        if (existingOrder.status === OrderStatus.DELIVERED) {
          const newCargo = String(apiOrder.cargoTrackingNumber || apiOrder.trackingNumber || '-');
          if (newCargo !== '-' && (!existingOrder.cargoCode || existingOrder.cargoCode === '-')) {
            existingOrder.cargoCode = newCargo;
          }
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
                  const mainWhId = config.linkedWarehouseId || (db.warehouses && db.warehouses.length > 0 ? db.warehouses[0].id : 'wh1');
                  const currentStock = variant.stocks[mainWhId] || 0;
                  const newStock = currentStock + item.quantity;

                  const result = updateLocalStockWithConsistency(currentDbProducts, product.id, variant.color, variant.size, mainWhId, newStock);
                  currentDbProducts = result.updatedProducts;

                  // Stok senkronizasyon listesine ekle - TÜM BARKODLAR
                  const updatedProduct = currentDbProducts.find(p => p.id === product.id);
                  if (updatedProduct) {
                    updatedProduct.variants.forEach(pv => {
                      if (pv.barcode) {
                        barcodesToSync[pv.barcode] = getSyncableStock(pv, db.warehouses || []);
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
          // Sadece daha önce kargoya teslim edilmiş (SHIPPING) ve Trendyol split shipment olan durumlarda,
          // kargo kodsuz gelen farklı paket iptalleri aktif siparişi etkilemesin.
          // Henüz kargolanmamış (NEW veya PROCESSING) veya HB/Pazarama siparişlerinde müşteri iptali her zaman geçerlidir.
          const isCancelledStatus = mappedStatus === OrderStatus.CANCELLED;
          if (isCancelledStatus && existingOrder.status === OrderStatus.SHIPPING && config.type === 'TRENDYOL' && existingCargoCode !== '-' && newCargoCode === '-') {
            console.log(`[ORDER-SYNC] Kargodaki sipariş ${apiOrder.orderNumber} için kargo kodsuz İPTAL bildirimi atlandı (Mevcut kargo: ${existingCargoCode}).`);
            continue;
          }
          // İçerik değişikliği kontrolü (Adet ve Barkod bazlı)
          const currentQty = existingOrder.items.reduce((a, b) => a + b.quantity, 0);
          const newQty = orderItems.reduce((a, b) => a + b.quantity, 0);
          const isContentChanged = currentQty !== newQty || (
            !orderItems.every(ni => existingOrder.items.some(ei => 
              ei.barcode === ni.barcode || 
              (ei.sku && ni.sku && ei.sku.toLowerCase() === ni.sku.toLowerCase()) ||
              (ei.orderItemId && ni.orderItemId && String(ei.orderItemId) === String(ni.orderItemId))
            ))
          );

          if (isCancelledStatus) {
            console.log(`[ORDER-UPDATE] Sipariş ${apiOrder.orderNumber} (${config.storeName}) tamamen iptal edildi. Statü güncelleniyor ve stoklar depoya iade ediliyor...`);

            // 1. STOK İADE (Eğer askıda değilse ve daha önce düşülmüşse)
            if (!existingOrder.isSuspended) {
              existingOrder.items.forEach((item, index) => {
                const product = currentDbProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
                if (product) {
                  const variant = product.variants.find(v => v.barcode === item.barcode);
                  if (variant) {
                    let restored = false;
                    const fulfillmentKey = `${item.barcode}_${index}`;
                    const itemFulfillments = existingOrder.fulfillmentInfo?.itemsFulfillment?.[fulfillmentKey];

                    if (itemFulfillments && itemFulfillments.length > 0) {
                      itemFulfillments.forEach(f => {
                        const targetWh = (db.warehouses || []).find(w => w.name === f.whName) || db.warehouses?.[0];
                        const whId = targetWh ? targetWh.id : (config.linkedWarehouseId || 'wh1');
                        const currentWhStock = variant.stocks[whId] || 0;
                        const newStock = currentWhStock + f.qty;
                        const result = updateLocalStockWithConsistency(currentDbProducts, product.id, variant.color, variant.size, whId, newStock);
                        currentDbProducts = result.updatedProducts;
                        restored = true;
                      });
                    }

                    if (!restored) {
                      const warehouses = db.warehouses && db.warehouses.length > 0 ? db.warehouses : [{ id: 'wh1' } as any];
                      const mainWhId = config.linkedWarehouseId || warehouses.find(w => w.isDefault || w.isCenter)?.id || warehouses[0].id;
                      const currentStock = variant.stocks[mainWhId] || 0;
                      const newStock = currentStock + item.quantity;

                      const result = updateLocalStockWithConsistency(currentDbProducts, product.id, variant.color, variant.size, mainWhId, newStock);
                      currentDbProducts = result.updatedProducts;
                    }

                    // Stok senkronizasyon listesine ekle - TÜM VARYANT BARKODLARINI EKLE
                    const updatedProduct = currentDbProducts.find(p => p.id === product.id);
                    if (updatedProduct) {
                      updatedProduct.variants.forEach(pv => {
                        if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                          barcodesToSync[pv.barcode] = getSyncableStock(pv, db.warehouses || []);
                        }
                      });
                    }
                  }
                }
              });
            }

            // 2. SİPARİŞİ İPTAL ET (Orijinal ID'yi koru, sadece status'ü CANCELLED yap!)
            currentDbOrders[existingOrderIndex].status = OrderStatus.CANCELLED;

            // Eğer yeni kargo kodu varsa güncelle
            const rawUpdatedCargo = (apiOrder.cargoTrackingNumber && apiOrder.cargoTrackingNumber !== '-')
              ? apiOrder.cargoTrackingNumber
              : (apiOrder.trackingNumber && apiOrder.trackingNumber !== '-')
                ? apiOrder.trackingNumber
                : (apiOrder.shipmentPackageId && apiOrder.shipmentPackageId !== '-' && config.type === 'HEPSIBURADA')
                  ? apiOrder.shipmentPackageId
                  : '-';
            const updatedCargoCode = String(rawUpdatedCargo);
            if (updatedCargoCode !== '-') {
              currentDbOrders[existingOrderIndex].cargoCode = updatedCargoCode;
            }

            continue; // Sipariş tamamen iptal edildiği için sonraki kayda geç.
          } else if (isContentChanged) {
            console.log(`[ORDER-UPDATE] Sipariş ${apiOrder.orderNumber} içerik değişikliği (kısmi iptal vb.) algılandı. Arşivleniyor...`);

            // 1. STOK İADE (Eğer askıda değilse ve daha önce düşülmüşse)
            if (!existingOrder.isSuspended) {
              existingOrder.items.forEach(item => {
                const product = currentDbProducts.find(p => p.variants.some(v => v.barcode === item.barcode));
                if (product) {
                  const variant = product.variants.find(v => v.barcode === item.barcode);
                  if (variant) {
                    const mainWhId = config.linkedWarehouseId || (db.warehouses && db.warehouses.length > 0 ? db.warehouses[0].id : 'wh1');
                    const currentStock = variant.stocks[mainWhId] || 0;
                    const newStock = currentStock + item.quantity;

                    const result = updateLocalStockWithConsistency(currentDbProducts, product.id, variant.color, variant.size, mainWhId, newStock);
                    currentDbProducts = result.updatedProducts;

                    // Stok senkronizasyon listesine ekle - ÖNEMLİ: Tüm varyant barkodlarını ekle
                    const updatedProduct = currentDbProducts.find(p => p.id === product.id);
                    if (updatedProduct) {
                      updatedProduct.variants.forEach(pv => {
                        if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                          barcodesToSync[pv.barcode] = getSyncableStock(pv, db.warehouses || []);
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
              const isDowngrade = existingOrder.status === OrderStatus.SHIPPING &&
                                  (mappedStatus === OrderStatus.NEW || mappedStatus === OrderStatus.PROCESSING);
              if (!isDowngrade) {
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
            }
            const rawNewCargo = (apiOrder.cargoTrackingNumber && apiOrder.cargoTrackingNumber !== '-')
              ? apiOrder.cargoTrackingNumber
              : (apiOrder.trackingNumber && apiOrder.trackingNumber !== '-')
                ? apiOrder.trackingNumber
                : (apiOrder.shipmentPackageId && apiOrder.shipmentPackageId !== '-' && config.type === 'HEPSIBURADA')
                  ? apiOrder.shipmentPackageId
                  : '-';
            const newCargoCode = String(rawNewCargo);
            if (newCargoCode !== '-' && (existingOrder.cargoCode === '-' || !existingOrder.cargoCode || existingOrder.cargoCode !== newCargoCode)) {
              currentDbOrders[existingOrderIndex].cargoCode = newCargoCode;
            }
            currentDbOrders[existingOrderIndex].countryCode = resolvedCountry;
            if (resolvedCargoCompany) {
              currentDbOrders[existingOrderIndex].cargoCompanyName = resolvedCargoCompany;
            }
            currentDbOrders[existingOrderIndex].fullData = apiOrder;

            // HER GÜNCELLEMEDE ÜRÜN DETAYLARINI (isim, renk, beden, fiyat, kdv, komisyon vb.) TAZELE
            currentDbOrders[existingOrderIndex].items = orderItems;

            // Eğer daha önce askıdaysa ve artık tüm barkodlar sistemde varsa askıdan çıkar
            if (currentDbOrders[existingOrderIndex].isSuspended) {
              const nowAllBarcodesExist = orderItems.every(item => {
                if (!item.barcode || item.barcode === 'NO-BARCODE') return false;
                const cleanB = String(item.barcode).trim().toLowerCase();
                const cleanSku = String(item.sku || '').trim().toLowerCase();
                const cleanMatchedB = String(item.matchedVariantBarcode || '').trim().toLowerCase();
                const cleanRawB = String(item.rawBarcode || '').trim().toLowerCase();
                const cleanHbSku = String(item.hbSku || '').trim().toLowerCase();
                return currentDbProducts.some(p =>
                  p.variants.some(v => {
                    const vb = String(v.barcode || '').trim().toLowerCase();
                    const va = String((v as any).arma || (v as any).data?.arma || '').trim().toLowerCase();
                    return (vb && (vb === cleanB || vb === cleanSku || (cleanMatchedB && vb === cleanMatchedB) || (cleanRawB && vb === cleanRawB) || (cleanHbSku && vb === cleanHbSku))) ||
                           (va && (va === cleanB || va === cleanSku || (cleanMatchedB && va === cleanMatchedB) || (cleanRawB && va === cleanRawB) || (cleanHbSku && va === cleanHbSku)));
                  }) || (p.productCode && (String(p.productCode).trim().toLowerCase() === cleanB || (cleanSku && cleanSku.includes(String(p.productCode).trim().toLowerCase()))))
                );
              });
              if (nowAllBarcodesExist) {
                currentDbOrders[existingOrderIndex].isSuspended = false;
                currentDbOrders[existingOrderIndex].wasSuspended = true;
                console.log(`[ORDER-SYNC] Askıdaki sipariş (${apiOrder.orderNumber}) SKU/Barkod eşleşmesi ile çözüldü, askıdan çıkarıldı.`);
              }
            }

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
      const allBarcodesExist = orderItems.every(item => {
        if (!item.barcode || item.barcode === 'NO-BARCODE') return false;
        const cleanB = String(item.barcode).trim().toLowerCase();
        const cleanSku = String(item.sku || '').trim().toLowerCase();
        const cleanMatchedB = String(item.matchedVariantBarcode || '').trim().toLowerCase();
        const cleanRawB = String(item.rawBarcode || '').trim().toLowerCase();
        const cleanHbSku = String(item.hbSku || '').trim().toLowerCase();
        return currentDbProducts.some(p =>
          p.variants.some(v => {
            const vb = String(v.barcode || '').trim().toLowerCase();
            const va = String((v as any).arma || (v as any).data?.arma || '').trim().toLowerCase();
            return (vb && (vb === cleanB || vb === cleanSku || (cleanMatchedB && vb === cleanMatchedB) || (cleanRawB && vb === cleanRawB) || (cleanHbSku && vb === cleanHbSku))) ||
                   (va && (va === cleanB || va === cleanSku || (cleanMatchedB && va === cleanMatchedB) || (cleanRawB && va === cleanRawB) || (cleanHbSku && va === cleanHbSku)));
          }) || (p.productCode && (String(p.productCode).trim().toLowerCase() === cleanB || (cleanSku && cleanSku.includes(String(p.productCode).trim().toLowerCase()))))
        );
      });

      const isSuspended = !allBarcodesExist;

      let orderFulfillmentInfo = {
        isOutOfStock: false,
        warehouseInitials: [] as string[],
        warehouseNames: [] as string[],
        itemsFulfillment: {} as Record<string, { whName: string, whInitial: string, qty: number }[]>
      };
      const usedWhInitials = new Set<string>();
      const usedWhNames = new Set<string>();

      // STOK DÜŞME (Sadece askıda değilse)
      // "tüm barkodlar tanımlı ise siparişler sayfasına düşer, her bir barkod için tek tek ... stokdan adetleri kadar düşer"
      if (!isSuspended) {
        orderItems.forEach((item, index) => {
          let totalAvailableStockForItem = 0;
          currentDbProducts.forEach(product => {
            const variant = product.variants.find(v => 
              v.barcode === item.barcode ||
              (item.matchedVariantBarcode && v.barcode === item.matchedVariantBarcode) ||
              (item.rawBarcode && v.barcode === item.rawBarcode) ||
              (item.hbSku && v.barcode === item.hbSku) ||
              (item.sku && (v.barcode === item.sku || (v as any).arma === item.sku)) ||
              (item.color && item.size && v.color === item.color && v.size === item.size)
            );
            if (variant) {
                const whList = db.warehouses || [];
                totalAvailableStockForItem += whList.reduce((sum, wh) => sum + (variant.stocks[wh.id] || 0), 0);
            }
          });

          if (totalAvailableStockForItem < item.quantity) {
             orderFulfillmentInfo.isOutOfStock = true;
          }

          // ÖNEMLİ: Siparişteki bu kaleme (item) karşılık gelen TEK doğru varyantı bul (mükerrer düşümü engelle)
          let matchedProduct: any = null;
          let matchedVariant: any = null;

          // 1. Aşama: Barkod veya SKU ile kesin eşleşme
          for (const product of currentDbProducts) {
            const v = product.variants.find(v => 
              (item.barcode && item.barcode !== 'NO-BARCODE' && v.barcode === item.barcode) ||
              (item.matchedVariantBarcode && v.barcode === item.matchedVariantBarcode) ||
              (item.rawBarcode && v.barcode === item.rawBarcode) ||
              (item.hbSku && v.barcode === item.hbSku) ||
              (item.sku && (v.barcode === item.sku || (v as any).arma === item.sku))
            );
            if (v) {
              matchedProduct = product;
              matchedVariant = v;
              break; // Tek doğru eşleşme bulundu
            }
          }

          // 2. Aşama: Eğer barkod/SKU ile bulunamadıysa, ürün adı ve Renk+Beden ile eşleşme
          if (!matchedVariant && item.color && item.size) {
            for (const product of currentDbProducts) {
              const nameMatch = !item.productName || (product.name && item.productName.toLowerCase().includes(product.name.toLowerCase()));
              if (nameMatch) {
                const v = product.variants.find(v => v.color === item.color && v.size === item.size);
                if (v) {
                  matchedProduct = product;
                  matchedVariant = v;
                  break;
                }
              }
            }
          }

          if (matchedProduct && matchedVariant) {
            const product = matchedProduct;
            const variant = matchedVariant;
            let remainingQty = item.quantity;
            let warehouses = db.warehouses && db.warehouses.length > 0 ? [...db.warehouses] : [{ id: 'wh1', name: 'Depo 1' } as any];
            warehouses = warehouses.filter(w => !w.syncDisabled);
            if (warehouses.length === 0) warehouses = [{ id: 'wh1', name: 'Depo 1' } as any];
            
            // SORT WAREHOUSES: Bağlı depo varsa İLK SIRADA (1. öncelik), 
            // yetmezse veya yoksa diğer depolar öncelik sırasına (priority) göre taranır.
            warehouses.sort((a, b) => {
                if (config.linkedWarehouseId) {
                    if (a.id === config.linkedWarehouseId) return -1;
                    if (b.id === config.linkedWarehouseId) return 1;
                }
                const prioA = a.priority ?? 999;
                const prioB = b.priority ?? 999;
                return prioA - prioB;
            });

            const fulfillmentForThisItem: { whName: string, whInitial: string, qty: number }[] = [];

            for (const wh of warehouses) {
              if (remainingQty <= 0) break;
              // En güncel varyantı bul
              const currentVariant = currentDbProducts.find(p => p.id === product.id)?.variants.find(v => 
                v.barcode === variant.barcode ||
                (v.color === variant.color && v.size === variant.size)
              );
              if (!currentVariant) continue;

              const currentWhStock = currentVariant.stocks[wh.id] || 0;
              if (currentWhStock > 0) {
                const deduct = Math.min(currentWhStock, remainingQty);
                const newStock = currentWhStock - deduct;
                remainingQty -= deduct;
                const result = updateLocalStockWithConsistency(currentDbProducts, product.id, variant.color, variant.size, wh.id, newStock);
                currentDbProducts = result.updatedProducts;

                const words = wh.name.split(' ').filter(w => w.trim().length > 0);
                let initial = '?';
                if (words.length >= 2) initial = (words[0][0] + words[1][0]).toUpperCase();
                else if (words.length === 1) initial = words[0].substring(0, 2).toUpperCase();
                else if (wh.name.length > 0) initial = wh.name.substring(0, 2).toUpperCase();

                usedWhInitials.add(initial);
                usedWhNames.add(wh.name);
                fulfillmentForThisItem.push({ whName: wh.name, whInitial: initial, qty: deduct });
              }
            }

            orderFulfillmentInfo.itemsFulfillment[`${item.barcode}_${index}`] = fulfillmentForThisItem;

            // Sync listesine ekle
            const updatedProduct = currentDbProducts.find(p => p.id === product.id);
            if (updatedProduct) {
              updatedProduct.variants.forEach(pv => {
                if (pv.color === variant.color && pv.size === variant.size && pv.barcode) {
                  barcodesToSync[pv.barcode] = getSyncableStock(pv, db.warehouses || []);
                }
              });
            }
          }
        });

        orderFulfillmentInfo.warehouseInitials = Array.from(usedWhInitials);
        orderFulfillmentInfo.warehouseNames = Array.from(usedWhNames);
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
        cargoCode: (apiOrder.cargoTrackingNumber && apiOrder.cargoTrackingNumber !== '-')
          ? String(apiOrder.cargoTrackingNumber)
          : (apiOrder.trackingNumber && apiOrder.trackingNumber !== '-')
            ? String(apiOrder.trackingNumber)
            : (apiOrder.shipmentPackageId && apiOrder.shipmentPackageId !== '-' && config.type === 'HEPSIBURADA')
              ? String(apiOrder.shipmentPackageId)
              : '-',
        cargoCompanyName: resolvedCargoCompany || undefined,
        orderDate: orderDate.toISOString(),
        items: orderItems,
        isSuspended: isSuspended, // Hesaplanan değer
        shipmentPackageId: packageId,
        countryCode: resolvedCountry,
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
        fullData: apiOrder, // API'den gelen tüm veriyi sakla
        fulfillmentInfo: !isSuspended ? orderFulfillmentInfo : undefined // Siparişin stok düşüm bilgisi
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
                    barcodesToSync[pv.barcode] = getSyncableStock(pv, db.warehouses || []);
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
  if (config.type !== 'TRENDYOL' && config.type !== 'PAZARAMA' && config.type !== 'HEPSIBURADA' && config.type !== 'N11' && config.type !== 'IDEFIX') {
    return [];
  }
  if (globalSyncLock) {
    console.warn('[SYNC-LOCK] Soru senkronizasyonu zaten devam ediyor, atlanıyor.');
    return [];
  }
  globalSyncLock = true;
  try {
    if (config.type === 'HEPSIBURADA') {
      try {
        if (!config.supplierId) return [];
        const isSit = config.mode === 'TEST';
        const baseUrl = isSit 
          ? 'https://api-asktoseller-merchant-sit.hepsiburada.com' 
          : 'https://api-asktoseller-merchant.hepsiburada.com';
        
        const username = (config.apiKey || config.supplierId || '').trim();
        const password = (config.apiSecret || '').trim();
        const auth = btoa(`${username}:${password}`);
        const userAgent = (config.userAgent || 'woddijeans_dev').trim();

        let hbStatusParam = '';
        if (status === QuestionStatus.WAITING_FOR_ANSWER) {
          hbStatusParam = '&status=WaitingForAnswer';
        } else if (status === QuestionStatus.ANSWERED) {
          hbStatusParam = '&status=Answered';
        }

        const url = `${baseUrl}/api/v1.0/issues?page=1&size=50${hbStatusParam}`;
        const headers = {
          'Authorization': `Basic ${auth}`,
          'merchantId': config.supplierId.trim(),
          'User-Agent': userAgent,
          'Accept': 'application/json'
        };

        const response = await safeMarketplaceFetch(url, { method: 'GET', headers });
        if (!response.ok) {
          console.warn(`[QUESTION-SYNC-HB] ${config.storeName} HTTP ${response.status}`);
          return [];
        }

        const resData = await response.json();
        const items = Array.isArray(resData?.data) ? resData.data : (Array.isArray(resData) ? resData : []);
        const questions: Question[] = items.map((item: any) => {
          const conversations = Array.isArray(item.conversations) ? item.conversations : [];
          const lastMsg = conversations.length > 0 ? conversations[conversations.length - 1] : null;
          const isWaiting = item.status === 'WaitingForAnswer' || (lastMsg && lastMsg.from === 'Customer');
          const isAnswered = item.status === 'Answered' || (!isWaiting && conversations.some((c: any) => c.from === 'Merchant'));

          const merchantAnswer = conversations.length > 0 
            ? ([...conversations].reverse().find((c: any) => c.from === 'Merchant')?.content || [...conversations].reverse().find((c: any) => c.from === 'Merchant')?.message || '') 
            : '';
          
          const lastCustomerMsg = conversations.length > 0
            ? ([...conversations].reverse().find((c: any) => c.from === 'Customer')?.content || [...conversations].reverse().find((c: any) => c.from === 'Customer')?.message || '')
            : '';

          const issueNum = String(item.issueNumber || item.id || '');
          const product = item.product || {};
          const rawImg = product.imageUrl || '';
          const fixedImg = rawImg ? rawImg.replace('{size}', '400') : '';

          return {
            id: `${config.storeName}_${issueNum}`,
            marketplaceQuestionId: issueNum,
            text: item.lastContent || lastCustomerMsg || (conversations[0]?.content) || (conversations[0]?.message) || '',
            answer: merchantAnswer,
            status: isWaiting ? QuestionStatus.WAITING_FOR_ANSWER : (isAnswered ? QuestionStatus.ANSWERED : QuestionStatus.WAITING_FOR_ANSWER),
            userName: item.customer?.name || item.customerId || 'Müşteri',
            createdDate: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
            productName: product.name || 'Hepsiburada Ürünü',
            productImageUrl: fixedImg,
            barcode: product.stockCode || product.sku || undefined,
            webUrl: product.url || (product.sku ? `https://www.hepsiburada.com/ara?q=${encodeURIComponent(product.sku)}` : undefined),
            storeName: config.storeName,
            isPublic: true,
            questionImageUrl: ''
          };
        });

        return questions;
      } catch (hbErr) {
        console.error(`[QUESTION-SYNC-HB-ERROR] ${config.storeName}:`, hbErr);
        return [];
      }
    } else if (config.type === 'PAZARAMA') {
      try {
        const accessToken = await getPazaramaAccessToken(config);
        const url = 'https://isortagimapi.pazarama.com/QuestionAnswer/getApprovalAnswersByMerchantSearch';
        let qStatus: number | null = null;
        if (status === QuestionStatus.WAITING_FOR_ANSWER) qStatus = 0;
        else if (status === QuestionStatus.ANSWERED) qStatus = 1;

        const payload = {
          barcode: null,
          topicId: null,
          questionStartDate: null,
          questionEndDate: null,
          questionStatus: qStatus,
          pageIndex: 1,
          pageSize: 50
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          const resData = await response.json();
          const items = resData?.data?.approvalAnswersByMerchantSearchs || resData?.data || [];
          const questions: Question[] = items.map((item: any) => {
            const isAnswered = item.questionStatus === 1 || Boolean(item.answer);
            const barcodeVal = item.barcode ? String(item.barcode).trim() : '';
            return {
              id: `${config.storeName}_${item.questionId}`,
              marketplaceQuestionId: String(item.questionId),
              text: item.question || '',
              answer: item.answer || '',
              status: isAnswered ? QuestionStatus.ANSWERED : QuestionStatus.WAITING_FOR_ANSWER,
              userName: item.maskedUserName || 'Müşteri',
              createdDate: item.questionDate ? new Date(item.questionDate).toISOString() : new Date().toISOString(),
              productName: item.productName || 'Pazarama Ürünü',
              productImageUrl: item.productImageUrl || '',
              barcode: barcodeVal || undefined,
              webUrl: barcodeVal 
                ? `https://www.pazarama.com/arama?q=${encodeURIComponent(barcodeVal)}` 
                : (item.productName ? `https://www.pazarama.com/arama?q=${encodeURIComponent(item.productName)}` : undefined),
              storeName: config.storeName,
              isPublic: true,
              questionImageUrl: ''
            };
          });
          return questions;
        } else {
          console.warn(`[QUESTION-SYNC-PAZARAMA] ${config.storeName} hata: ${response.status}`);
          return [];
        }
      } catch (pazErr) {
        console.error(`[QUESTION-SYNC-PAZARAMA-ERROR] ${config.storeName}:`, pazErr);
        return [];
      }
    } else if (config.type === 'N11') {
      return await syncN11Questions(config, status);
    } else if (config.type === 'IDEFIX') {
      return await syncIdefixQuestions(config, status);
    }

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
 * Pazaryeri Müşteri Sorusu Cevaplama
 * Trendyol: POST /suppliers/{supplierId}/questions/{id}/answers
 * Pazarama: PUT /QuestionAnswer/sellerAnswer
 */
export const answerMarketplaceQuestion = async (config: ApiConfig, questionId: string, answerText: string): Promise<boolean> => {
  if (config.type === 'TRENDYOL') {
    try {
      const url = `https://apigw.trendyol.com/integration/qna/sellers/${config.supplierId}/questions/${questionId}/answers`;

      const response = await safeMarketplaceFetch(url, {
        method: 'POST',
        headers: getTrendyolHeaders(config),
        body: JSON.stringify({ text: answerText })
      });

      if (response.ok) {
        console.log(`[ANSWER-SUCCESS] Soru ${questionId} başarıyla cevaplandı.`);
        return true;
      } else {
        const errorMsg = await response.text();
        throw new Error(`Soru cevaplama hatası (${response.status}): ${errorMsg}`);
      }
    } catch (error) {
      console.error('answerMarketplaceQuestion error:', error);
      throw error;
    }
  } else if (config.type === 'PAZARAMA') {
    try {
      const accessToken = await getPazaramaAccessToken(config);
      const url = `https://isortagimapi.pazarama.com/QuestionAnswer/sellerAnswer`;

      const response = await safeMarketplaceFetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          questionId: questionId,
          text: answerText
        })
      });

      if (response.ok) {
        console.log(`[ANSWER-PAZARAMA-SUCCESS] Pazarama sorusu ${questionId} başarıyla cevaplandı.`);
        return true;
      } else {
        const errorMsg = await response.text();
        throw new Error(`Pazarama soru cevaplama hatası (${response.status}): ${errorMsg}`);
      }
    } catch (error) {
      console.error('answerMarketplaceQuestion Pazarama error:', error);
      throw error;
    }
  } else if (config.type === 'HEPSIBURADA') {
    try {
      if (!config.supplierId) {
        throw new Error('Hepsiburada satıcı kimliği (Merchant ID) eksik.');
      }
      const isSit = config.mode === 'TEST';
      const baseUrl = isSit 
        ? 'https://api-asktoseller-merchant-sit.hepsiburada.com' 
        : 'https://api-asktoseller-merchant.hepsiburada.com';
      
      const username = (config.apiKey || config.supplierId || '').trim();
      const password = (config.apiSecret || '').trim();
      const auth = typeof Buffer !== 'undefined'
        ? Buffer.from(`${username}:${password}`).toString('base64')
        : btoa(unescape(encodeURIComponent(`${username}:${password}`)));
      const userAgent = (config.userAgent || 'woddijeans_dev').trim();

      const url = `${baseUrl}/api/v1.0/issues/${questionId}/answer`;
      const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}${Date.now()}`;
      const multipartBody = 
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="Answer"\r\n\r\n` +
        `${answerText.trim()}\r\n` +
        `--${boundary}--\r\n`;

      const response = await safeMarketplaceFetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'merchantId': config.supplierId.trim(),
          'User-Agent': userAgent,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: multipartBody
      });

      if (response.ok || response.status === 201) {
        console.log(`[ANSWER-HB-SUCCESS] Hepsiburada soru ${questionId} başarıyla cevaplandı.`);
        return true;
      } else {
        const errorData = await response.text();
        let errorDetail = '';
        try {
          const parsed = JSON.parse(errorData);
          if (parsed?.errors && Array.isArray(parsed.errors)) {
            errorDetail = parsed.errors.map((e: any) => e.message || e.internalMessage).filter(Boolean).join(', ');
          } else if (parsed?.message) {
            errorDetail = parsed.message;
          }
        } catch {}
        const errorMsg = errorDetail ? `${errorDetail} (${response.status})` : `HTTP ${response.status}: ${errorData}`;
        throw new Error(`Hepsiburada soru cevaplama hatası: ${errorMsg}`);
      }
    } catch (error) {
      console.error('answerMarketplaceQuestion Hepsiburada error:', error);
      throw error;
    }
  } else if (config.type === 'N11') {
    return await answerN11Question(config, questionId, answerText);
  } else if (config.type === 'IDEFIX') {
    return await answerIdefixQuestion(config, questionId, answerText);
  } else {
    throw new Error(`${config.type} için soru cevaplama API desteği bulunmamaktadır.`);
  }
};

/**
 * Pazaryeri İade Taleplerini Çekme (Claims)
 * Trendyol: GET /order/sellers/{sellerId}/claims
 * Hepsiburada: GET /claims/merchantid/{merchantId}
 * Pazarama: POST /api/Order/GetRefund
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
    if (config.type === 'TRENDYOL') {
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
    } else if (config.type === 'HEPSIBURADA') {
      if (!config.supplierId) return [];
      const baseUrl = getHepsiburadaBaseUrl(config);
      const headers = getHepsiburadaHeaders(config);
      const url = `${baseUrl}/claims/merchantid/${config.supplierId}?offset=0&limit=100`;
      const response = await safeMarketplaceFetch(url, { method: 'GET', headers });
      if (!response.ok) {
        const err = await handleHepsiburadaError(response);
        console.warn(`[FETCH-HB-CLAIMS] ${config.storeName} | ${err}`);
        return [];
      }
      const data = await response.json();
      const rawList = Array.isArray(data) ? data : (data?.data || data?.items || []);
      const claims: ReturnClaim[] = [];
      const completedStatuses = new Set([
        'ACCEPTED', 'APPROVED', 'REFUNDED', 'REJECTED',
        'CANCELLED', 'CANCELED', 'COMPLETED', 'CLOSED',
        'RESOLVED', 'FINALIZED'
      ]);

      for (const item of rawList) {
        const itemStatus = String(item.status || item.claimStatus || '').toUpperCase();
        if (completedStatuses.has(itemStatus)) {
          continue; // Hariç tut: Zaten sonuçlanmış / iadesi tamamlanmış HB talepleri
        }

        const claimNumber = String(item.claimNumber || item.claimId || item.id || '');
        const lines = item.lineItems || item.items || item.claimItems || [item];
        for (const line of lines) {
          const lineStatus = String(line.status || line.claimStatus || itemStatus || '').toUpperCase();
          if (completedStatuses.has(lineStatus)) {
            continue; // Hariç tut: Bu kalem zaten sonuçlanmış
          }

          const lineId = String(line.lineItemId || line.id || claimNumber);
          const normalizedStatus = lineStatus || 'WAITING_FOR_APPROVE';

          claims.push({
            id: `${config.storeName}_${claimNumber}_${lineId}`,
            claimId: claimNumber,
            claimLineItemId: lineId,
            customerName: item.customerName || item.customer?.name || 'Müşteri',
            orderNumber: String(item.orderNumber || line.orderNumber || ''),
            barcode: String(line.barcode || line.merchantSku || line.sku || 'NO-BARCODE'),
            productName: line.productName || line.title || 'Hepsiburada Ürünü',
            productImageUrl: line.productImageUrl || line.imageUrl || '',
            productUrl: line.productUrl || undefined,
            reason: line.customerClaimReason || line.reason || item.reason || 'İade Talebi',
            description: line.customerNote || item.description || '',
            status: normalizedStatus,
            claimItemStatus: normalizedStatus,
            returnQuantity: Number(line.quantity || 1),
            orderLineItemId: line.orderLineItemId ? String(line.orderLineItemId) : undefined,
            cargoTrackingNumber: item.cargoTrackingNumber || item.barcode || '-',
            color: line.color || undefined,
            size: line.size || undefined,
            storeName: config.storeName,
            claimDate: item.claimDate || item.createdDate ? new Date(item.claimDate || item.createdDate).toISOString() : new Date().toISOString()
          });
        }
      }
      return claims;
    } else if (config.type === 'PAZARAMA') {
      try {
        const accessToken = await getPazaramaAccessToken(config);
        const url = `https://isortagimapi.pazarama.com/order/getRefund`;
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
        const tomorrow = new Date(now.getTime() + (24 * 60 * 60 * 1000));
        const formatYMD = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        const response = await safeMarketplaceFetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: {
            pageSize: 50,
            pageNumber: 1,
            refundStatus: 1,
            requestStartDate: formatYMD(thirtyDaysAgo),
            requestEndDate: formatYMD(tomorrow)
          }
        });
        if (response.ok) {
          const data = await response.json();
          const items = data?.data?.refundList || data?.refundList || data?.data || data?.Data?.Refunds || [];
          const claims: ReturnClaim[] = [];
          for (const item of items) {
            const refundId = String(item.refundId || item.RefundId || item.id || '');
            const barcode = String(item.productCode || item.ProductCode || item.productStockCode || item.ProductStockCode || item.stockCode || item.StockCode || item.barcode || 'NO-BARCODE');
            claims.push({
              id: `${config.storeName}_${refundId}`,
              claimId: refundId,
              claimLineItemId: refundId,
              customerName: item.customerName || item.CustomerName || 'Müşteri',
              customerPhoneNumber: item.customerPhoneNumber || item.CustomerPhoneNumber,
              orderNumber: String(item.orderNumber || item.OrderNumber || ''),
              barcode,
              productName: item.productName || item.ProductName || 'Pazarama Ürünü',
              productImageUrl: item.productImageUrl || item.ProductImageUrl || '',
              productUrl: item.productUrl || item.ProductUrl || undefined,
              reason: item.refundStatusName || item.RefundStatusName || item.description || 'İade Talebi',
              description: item.description || item.Description || '',
              status: 'WAITING_FOR_APPROVE',
              claimItemStatus: 'WAITING_FOR_APPROVE',
              returnQuantity: Number(item.quantity || item.Quantity || 1),
              orderLineItemId: item.orderItemId ? String(item.orderItemId) : undefined,
              cargoTrackingNumber: item.shipmentCode || item.ShipmentCode || item.cargoTrackingNumber || '-',
              color: item.color || item.Color || undefined,
              size: item.size || item.Size || undefined,
              storeName: config.storeName,
              claimDate: item.refundDate || item.RefundDate || item.createdDate ? new Date(item.refundDate || item.RefundDate || item.createdDate).toISOString() : new Date().toISOString()
            });
          }
          return claims;
        } else {
          console.warn(`[FETCH-PAZARAMA-CLAIMS] ${config.storeName} | ${response.status}`);
          return [];
        }
      } catch (e) {
        console.error(`[FETCH-PAZARAMA-CLAIMS-ERROR] ${config.storeName}:`, e);
        return [];
      }
    } else if (config.type === 'N11') {
      return await syncN11Claims(config);
    } else if (config.type === 'IDEFIX') {
      return await syncIdefixClaims(config);
    }
    return [];
  } catch (error) {
    console.error(`syncMarketplaceClaims error for ${config.storeName}:`, error);
    return [];
  } finally {
    globalSyncLock = false;
  }
};

/**
 * Pazaryeri İade Talebi Onaylama
 * Trendyol: PUT /order/sellers/{sellerId}/claims/{claimId}/items/approve
 * Hepsiburada: POST /claims/number/{claimId}/accept
 * Pazarama: POST /order/updateRefund
 */
export const approveMarketplaceClaim = async (config: ApiConfig, claimId: string, claimLineItemIdList: string[]): Promise<boolean> => {
  try {
    if (config.type === 'TRENDYOL') {
      const url = `https://apigw.trendyol.com/integration/order/sellers/${config.supplierId}/claims/${claimId}/items/approve`;

      const response = await safeMarketplaceFetch(url, {
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
    } else if (config.type === 'HEPSIBURADA') {
      const baseUrl = getHepsiburadaBaseUrl(config);
      const headers = getHepsiburadaHeaders(config);
      const url = `${baseUrl}/claims/number/${claimId}/accept`;
      const response = await safeMarketplaceFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ FinalizedWith: 'Refund' })
      });
      if (response.ok || response.status === 200 || response.status === 204) {
        console.log(`[APPROVE-HB-SUCCESS] Hepsiburada iade ${claimId} onaylandı.`);
        return true;
      } else {
        const errorMsg = await handleHepsiburadaError(response);
        const lowerErr = (errorMsg || '').toLowerCase();
        // Eğer HB tarafında bu talep zaten onaylanmış/kapatılmışsa veya geçersiz durumdaysa, yerel listeden temizlenebilmesi için başarılı say
        if (lowerErr.includes('already') || lowerErr.includes('zaten') || lowerErr.includes('accepted') || lowerErr.includes('refund') || lowerErr.includes('closed') || response.status === 400) {
          console.warn(`[APPROVE-HB-ALREADY-RESOLVED] Hepsiburada iade ${claimId} zaten sonuçlanmış: ${errorMsg}`);
          return true;
        }
        throw new Error(`Hepsiburada iade onaylama hatası: ${errorMsg}`);
      }
    } else if (config.type === 'PAZARAMA') {
      const accessToken = await getPazaramaAccessToken(config);
      const url = `https://isortagimapi.pazarama.com/order/updateRefund`;
      const response = await safeMarketplaceFetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: {
          refundId: claimId,
          status: 2 // Tedarikçi Tarafından Onaylandı
        }
      });
      if (response.ok) {
        console.log(`[APPROVE-PAZARAMA-SUCCESS] Pazarama iade ${claimId} onaylandı.`);
        return true;
      } else {
        const errorMsg = await handlePazaramaError(response);
        throw new Error(`Pazarama iade onaylama hatası: ${errorMsg}`);
      }
    } else if (config.type === 'N11') {
      return await approveN11Claim(config, claimId);
    } else if (config.type === 'IDEFIX') {
      return await approveIdefixClaim(config, claimId, claimLineItemIdList);
    }
    return true;
  } catch (error) {
    console.error('approveMarketplaceClaim error:', error);
    throw error;
  }
};
// --- HEPSIBURADA INTEGRATION ---

export function getHepsiburadaBaseUrl(config: ApiConfig): string {
  return config.mode === 'TEST'
    ? 'https://oms-external-sit.hepsiburada.com'
    : 'https://oms-external.hepsiburada.com';
}

export function getHepsiburadaListingBaseUrl(config: ApiConfig): string {
  return config.mode === 'TEST'
    ? 'https://listing-external-sit.hepsiburada.com'
    : 'https://listing-external.hepsiburada.com';
}

export function getHepsiburadaHeaders(config: ApiConfig) {
  const username = (config.apiKey || config.supplierId || '').trim();
  const password = (config.apiSecret || '').trim();
  const auth = btoa(`${username}:${password}`);
  const userAgent = (config.userAgent || 'woddijeans_dev').trim();
  return {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': userAgent
  };
}

async function handleHepsiburadaError(response: any): Promise<string> {
  let errorText = '';
  try {
    if (typeof response.json === 'function') {
      const errorData = await response.json();
      errorText = typeof errorData === 'string' ? errorData : JSON.stringify(errorData);
    } else if (response.body) {
      errorText = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    }
  } catch {
    try {
      if (typeof response.text === 'function') {
        errorText = await response.text();
      }
    } catch {
      errorText = 'Bilinmeyen hata';
    }
  }
  return `Hata (${response.status}): ${errorText || response.statusText || 'Bilinmeyen hata'}`;
}

function extractHbProperties(item: any): { color: string; size: string } {
  let color = item.color || '';
  let size = item.size || item.attribute || '';
  if (Array.isArray(item.properties)) {
    for (const prop of item.properties) {
      const pName = String(prop.name || prop.key || '').toLowerCase();
      const pVal = String(prop.value || prop.val || '');
      if (pName.includes('renk') || pName.includes('color')) {
        color = color || pVal;
      }
      if (pName.includes('beden') || pName.includes('size')) {
        size = size || pVal;
      }
    }
  } else if (item.properties && typeof item.properties === 'object') {
    color = color || item.properties['Renk'] || item.properties['renk'] || item.properties['Color'] || '';
    size = size || item.properties['Beden'] || item.properties['beden'] || item.properties['Size'] || '';
  }
  return { color, size };
}

function normalizeHepsiburadaPackage(pkg: any) {
  const ship = pkg.shippingAddress || pkg.deliveryAddress || {};
  const inv = pkg.invoiceAddress || pkg.billingAddress || {};
  const cust = pkg.customer || {};
  const rawItems = pkg.items || pkg.lineItems || [];
  
  const lines = rawItems.map((item: any) => {
    const { color, size } = extractHbProperties(item);
    const rawBarcodeValue = String(item.productBarcode || item.barcode || item.Barcode || item.fullData?.productBarcode || item.fullData?.barcode || '').trim();
    const rawMerchantSku = String(item.merchantSKU || item.merchantSku || item.fullData?.merchantSKU || item.fullData?.merchantSku || '').trim();
    const rawHbSku = String(item.hbSku || item.sku || item.fullData?.hbSku || item.fullData?.sku || '').trim();
    const rawStockCode = String(item.stockCode || item.StockCode || item.fullData?.stockCode || item.fullData?.StockCode || '').trim();

    let extractedTailBarcode = '';
    if (rawMerchantSku.includes('-')) {
      const parts = rawMerchantSku.split('-');
      const lastPart = parts[parts.length - 1].trim();
      if (/^\d{8,14}$/.test(lastPart)) {
        extractedTailBarcode = lastPart;
      }
    }

    // Kullanıcı kuralı: "hepsiburada da satıcı stok kodu bizim programda sku ya yazılıyor bu normal ama hb deki sku (HBCV...) bizde barkod olarak gözüksün"
    const barcode = rawHbSku || rawBarcodeValue || extractedTailBarcode || rawMerchantSku || rawStockCode || 'NO-BARCODE';
    const merchantSku = rawMerchantSku || rawStockCode || rawHbSku || rawBarcodeValue || '';
    const productName = item.productName || item.title || item.name || item.skuDescription || item.merchantSkuDescription || item.merchantSKU || item.merchantSku || 'Ürün';

    return {
      orderItemId: String(item.lineItemId || item.id || item.orderItemId || Math.random().toString(36).substr(2, 9)),
      barcode, // Hepsiburada SKU'su (HBCV...) programda barkod olarak görünür
      merchantSku, // Satıcı Stok Kodu
      sku: rawMerchantSku || rawStockCode || rawHbSku || '', // Programdaki SKU = Satıcı Stok Kodu
      hbSku: rawHbSku,
      rawBarcode: rawBarcodeValue,
      extractedTailBarcode,
      productName,
      quantity: Number(item.quantity || item.qty || 1),
      price: Number(item.price?.amount ?? item.price ?? item.unitPrice ?? item.salePrice ?? 0),
      vatRate: Number(item.vat?.rate ?? item.vatRate ?? item.taxRate ?? 0),
      color,
      size,
      fullData: item
    };
  });

  const customerFirstName = ship.recipientName || ship.name || pkg.recipientName || cust.name || 'Müşteri';
  const customerPhoneNumber = ship.phoneNumber || ship.phone || pkg.shippingPhoneNumber || pkg.phoneNumber || cust.phone;
  const customerEmail = ship.email || pkg.customerEmail || pkg.email || cust.email;

  const shipAddress1 = ship.address || ship.addressDetail || pkg.shippingAddressDetail || pkg.deliveryAddress || [ship.address1, ship.district || ship.town || pkg.shippingTown || pkg.shippingDistrict, ship.city || pkg.shippingCity].filter(Boolean).join(', ');
  const shipCity = ship.city || pkg.shippingCity || '';
  const shipDistrict = ship.district || ship.town || pkg.shippingTown || pkg.shippingDistrict || '';
  const shipPostalCode = ship.postalCode || pkg.shippingPostalCode || '';
  const shipCountryCode = ship.countryCode || ship.country || pkg.shippingCountryCode || 'TR';

  const invAddress1 = inv.address || inv.addressDetail || pkg.billingAddressDetail || pkg.billingAddress || [inv.address1, inv.district || inv.town || pkg.billingTown, inv.city || pkg.billingCity].filter(Boolean).join(', ');
  const invCity = inv.city || pkg.billingCity || shipCity;
  const invDistrict = inv.district || inv.town || pkg.billingTown || pkg.billingDistrict || shipDistrict;
  const taxNumber = inv.taxNumber || inv.identityNumber || pkg.taxNumber || pkg.identityNumber || pkg.identityNo;
  const taxOffice = inv.taxOffice || pkg.taxOffice;
  const company = inv.company || inv.title || pkg.companyName || pkg.billingCompany;

  const packageNumber = String(
    pkg.packageNumber ||
    pkg.PackageNumber ||
    pkg.packetNumber ||
    pkg.PacketNumber ||
    pkg.id ||
    pkg.Id ||
    ''
  );
  const cargoTrackingNumber =
    pkg.barcode ||
    pkg.Barcode ||
    pkg.cargoBarcode ||
    pkg.CargoBarcode ||
    pkg.cargoTrackingNumber ||
    pkg.CargoTrackingNumber ||
    pkg.trackingNumber ||
    pkg.TrackingNumber ||
    pkg.cargoTrackingBarcode ||
    pkg.CargoTrackingBarcode ||
    pkg.deliveryNumber ||
    pkg.DeliveryNumber ||
    pkg.deliveryNo ||
    pkg.cargoCode ||
    pkg.CargoCode ||
    pkg.shipmentCode ||
    pkg.ShipmentCode ||
    pkg.shippingNumber ||
    pkg.ShippingNumber ||
    pkg.shippingDetails?.barcode ||
    pkg.shippingDetails?.trackingNumber ||
    pkg.shippingDetails?.cargoBarcode ||
    pkg.shippingDetails?.cargoTrackingNumber ||
    pkg.shippingDetails?.cargoCode ||
    (packageNumber && packageNumber !== '-' ? packageNumber : undefined) ||
    '-';

  const cargoCompany =
    pkg.cargoCompany ||
    pkg.CargoCompany ||
    pkg.cargoProviderName ||
    pkg.CargoProviderName ||
    pkg.carrierName ||
    pkg.CarrierName ||
    pkg.cargoCompanyModel?.name ||
    pkg.shippingDetails?.cargoCompany ||
    undefined;

  const extractedOrderNumber = String(
    pkg.orderNumber ||
    (Array.isArray(pkg.orderNumbers) && pkg.orderNumbers[0]) ||
    pkg.OrderNumber ||
    (Array.isArray(pkg.OrderNumbers) && pkg.OrderNumbers[0]) ||
    (rawItems.length > 0 && (rawItems[0].orderNumber || rawItems[0].OrderNumber)) ||
    (typeof pkg.email === 'string' && pkg.email.includes('_') ? pkg.email.split('_')[0] : '') ||
    pkg.packageNumber ||
    pkg.PackageNumber ||
    ''
  );

  return {
    orderNumber: extractedOrderNumber,
    shipmentPackageId: packageNumber ? packageNumber : undefined,
    status: pkg.status || 'Packed',
    cargoTrackingNumber,
    cargoCompanyName: cargoCompany,
    orderDate: pkg.orderDate || pkg.createdDate || pkg.sendDate || Date.now(),
    customerFirstName,
    customerLastName: '',
    customerPhoneNumber,
    customerEmail,
    shipmentAddress: {
      address1: shipAddress1,
      city: shipCity,
      district: shipDistrict,
      postalCode: shipPostalCode,
      countryCode: shipCountryCode
    },
    invoiceAddress: {
      address1: invAddress1,
      city: invCity,
      district: invDistrict,
      taxNumber,
      taxOffice,
      company
    },
    lines,
    fullData: pkg
  };
}

function normalizeHepsiburadaOrder(ord: any) {
  const ship = ord.shippingAddress || ord.deliveryAddress || {};
  const inv = ord.invoiceAddress || ord.billingAddress || ord.invoice?.address || ord.invoice || {};
  const cust = ord.customer || {};
  const rawItems = (ord.items && ord.items.length > 0)
    ? ord.items
    : (ord.orderItems && ord.orderItems.length > 0)
      ? ord.orderItems
      : (ord.lines && ord.lines.length > 0)
        ? ord.lines
        : (ord.sku || ord.merchantSKU || ord.merchantSku || ord.name ? [ord] : []);

  const lines = rawItems.map((item: any) => {
    const { color, size } = extractHbProperties(item);
    const rawBarcodeValue = String(item.productBarcode || item.barcode || item.Barcode || item.fullData?.productBarcode || item.fullData?.barcode || '').trim();
    const rawMerchantSku = String(item.merchantSKU || item.merchantSku || item.fullData?.merchantSKU || item.fullData?.merchantSku || '').trim();
    const rawHbSku = String(item.hbSku || item.sku || item.fullData?.hbSku || item.fullData?.sku || '').trim();
    const rawStockCode = String(item.stockCode || item.StockCode || item.fullData?.stockCode || item.fullData?.StockCode || '').trim();

    let extractedTailBarcode = '';
    if (rawMerchantSku.includes('-')) {
      const parts = rawMerchantSku.split('-');
      const lastPart = parts[parts.length - 1].trim();
      if (/^\d{8,14}$/.test(lastPart)) {
        extractedTailBarcode = lastPart;
      }
    }

    // Kullanıcı kuralı: "hepsiburada da satıcı stok kodu bizim programda sku ya yazılıyor bu normal ama hb deki sku (HBCV...) bizde barkod olarak gözüksün"
    const barcode = rawHbSku || rawBarcodeValue || extractedTailBarcode || rawMerchantSku || rawStockCode || 'NO-BARCODE';
    const merchantSku = rawMerchantSku || rawStockCode || rawHbSku || rawBarcodeValue || '';
    const productName = item.name || item.productName || item.skuDescription || item.merchantSkuDescription || item.title || item.product?.name || ord.name || ord.productName || item.merchantSKU || item.merchantSku || 'Ürün';

    return {
      orderItemId: String(item.id || item.lineItemId || item.orderItemId || Math.random().toString(36).substr(2, 9)),
      barcode, // Hepsiburada SKU'su (HBCV...) programda barkod olarak görünür
      merchantSku, // Satıcı Stok Kodu
      sku: rawMerchantSku || rawStockCode || rawHbSku || '', // Programdaki SKU = Satıcı Stok Kodu
      hbSku: rawHbSku,
      rawBarcode: rawBarcodeValue,
      extractedTailBarcode,
      productName,
      quantity: Number(item.quantity || item.qty || 1),
      price: Number(item.price?.amount ?? item.unitPrice?.amount ?? item.price ?? item.unitPrice ?? item.salePrice ?? 0),
      vatRate: Number(item.vat?.rate ?? item.vatRate ?? item.vat ?? item.taxRate ?? 0),
      color,
      size,
      fullData: item
    };
  });

  const customerFirstName = ord.customerName || cust.name || ship.recipientName || ship.name || ord.recipientName || 'Müşteri';
  const customerPhoneNumber = cust.phone || ship.phoneNumber || ship.phone || ord.shippingPhoneNumber;
  const customerEmail = cust.email || ship.email || ord.email;

  const shipAddress1 = ship.address || ship.addressDetail || ord.shippingAddressDetail || [ship.address1, ship.district || ship.town, ship.city].filter(Boolean).join(', ');
  const shipCity = ship.city || ord.shippingCity || '';
  const shipDistrict = ship.district || ship.town || ord.shippingDistrict || '';
  const shipPostalCode = ship.postalCode || ord.shippingPostalCode || '';
  const shipCountryCode = ship.countryCode || ship.country || 'TR';

  const invAddress1 = inv.address || inv.addressDetail || ord.billingAddress || [inv.address1, inv.district || inv.town, inv.city].filter(Boolean).join(', ');
  const invCity = inv.city || ord.billingCity || shipCity;
  const invDistrict = inv.district || inv.town || ord.billingDistrict || shipDistrict;
  const taxNumber = inv.taxNumber || inv.identityNumber || inv.turkishIdentityNumber || ord.invoice?.turkishIdentityNumber || ord.taxNumber;
  const taxOffice = inv.taxOffice || ord.invoice?.taxOffice || ord.taxOffice;
  const company = inv.company || inv.title || ord.companyName;

  const firstItem = rawItems[0] || {};
  const packageNumber =
    ord.packageNumber ||
    ord.PackageNumber ||
    ord.packetNumber ||
    ord.PacketNumber ||
    ord.hbPackageNumber ||
    ord.deliveryNumber ||
    ord.DeliveryNumber ||
    ord.deliveryNo ||
    firstItem.packageNumber ||
    firstItem.PackageNumber ||
    firstItem.packetNumber ||
    firstItem.PacketNumber ||
    firstItem.packageNo ||
    firstItem.hbPackageNumber ||
    firstItem.deliveryNumber ||
    firstItem.deliveryNo ||
    undefined;

  const cargoTrackingBarcode =
    ord.cargoTrackingNumber ||
    ord.CargoTrackingNumber ||
    ord.cargoBarcode ||
    ord.CargoBarcode ||
    ord.trackingNumber ||
    ord.TrackingNumber ||
    ord.cargoTrackingBarcode ||
    ord.CargoTrackingBarcode ||
    ord.cargoCode ||
    ord.CargoCode ||
    ord.shipmentCode ||
    ord.ShipmentCode ||
    ord.shippingNumber ||
    ord.ShippingNumber ||
    ord.shippingDetails?.barcode ||
    ord.shippingDetails?.trackingNumber ||
    ord.shippingDetails?.cargoBarcode ||
    ord.shippingDetails?.cargoTrackingNumber ||
    ord.shippingDetails?.cargoCode ||
    firstItem.cargoTrackingNumber ||
    firstItem.CargoTrackingNumber ||
    firstItem.cargoBarcode ||
    firstItem.CargoBarcode ||
    firstItem.trackingNumber ||
    firstItem.TrackingNumber ||
    firstItem.cargoCode ||
    firstItem.CargoCode ||
    firstItem.shipmentCode ||
    firstItem.ShipmentCode ||
    firstItem.shippingNumber ||
    firstItem.shippingDetails?.barcode ||
    firstItem.shippingDetails?.trackingNumber ||
    (packageNumber && packageNumber !== '-' ? String(packageNumber) : undefined) ||
    '-';

  const cargoCompany =
    ord.cargoCompany ||
    ord.CargoCompany ||
    ord.cargoProviderName ||
    ord.CargoProviderName ||
    ord.carrierName ||
    ord.CarrierName ||
    ord.cargoCompanyModel?.name ||
    ord.shippingDetails?.cargoCompany ||
    firstItem.cargoCompany ||
    firstItem.CargoCompany ||
    firstItem.carrierName ||
    firstItem.cargoProviderName ||
    firstItem.cargoCompanyModel?.name ||
    undefined;

  let hbStatus = ord.status || ord.orderStatus || ord.state;
  if (rawItems.length > 0) {
    const allCancelled = rawItems.every((it: any) => {
      const st = String(it.status || it.lineItemStatus || it.state || '').toLowerCase();
      return st.includes('cancel') || st.includes('iptal') || st === '6' || st === '13';
    });
    if (allCancelled) {
      hbStatus = 'Cancelled';
    } else if (!hbStatus) {
      hbStatus = firstItem.status || firstItem.lineItemStatus || 'Unpacked';
    }
  }
  if (!hbStatus) hbStatus = 'Unpacked';
  if (String(hbStatus).toLowerCase().includes('cancel') || String(hbStatus).toLowerCase().includes('iptal')) {
    hbStatus = 'Cancelled';
  }

  return {
    orderNumber: String(ord.orderNumber || ord.id || ''),
    shipmentPackageId: packageNumber ? String(packageNumber) : undefined,
    status: hbStatus,
    cargoTrackingNumber: cargoTrackingBarcode,
    cargoCompanyName: cargoCompany,
    orderDate: ord.orderDate || ord.createdDate || Date.now(),
    customerFirstName,
    customerLastName: '',
    customerPhoneNumber,
    customerEmail,
    shipmentAddress: {
      address1: shipAddress1,
      city: shipCity,
      district: shipDistrict,
      postalCode: shipPostalCode,
      countryCode: shipCountryCode
    },
    invoiceAddress: {
      address1: invAddress1,
      city: invCity,
      district: invDistrict,
      taxNumber,
      taxOffice,
      company
    },
    lines,
    fullData: ord
  };
}

export const fetchOrdersFromHepsiburada = async (
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
  if (!config.supplierId) {
    console.warn(`[FETCH-ORDERS-HEPSIBURADA] ${config.storeName} için Merchant ID (supplierId) eksik.`);
    return [];
  }

  await rateLimitDelay();
  const baseUrl = getHepsiburadaBaseUrl(config);
  const supplierId = config.supplierId.trim();
  const headers = getHepsiburadaHeaders(config);
  const allResults: any[] = [];
  const seenKeys = new Set<string>();

  // 0. Tekil Sipariş Sorgusu (orderNumber verildiyse)
  if (filters.orderNumber) {
    try {
      const singleUrl = `${baseUrl}/orders/merchantid/${supplierId}/ordernumber/${encodeURIComponent(filters.orderNumber)}`;
      const singleRes = await safeMarketplaceFetch(singleUrl, { method: 'GET', headers });
      if (singleRes.ok) {
        const ordData = await singleRes.json();
        if (ordData && (ordData.orderNumber || ordData.id)) {
          return [normalizeHepsiburadaOrder(ordData)];
        }
      }
    } catch (err) {
      console.error(`[FETCH-HB-SINGLE-ORDER-ERROR] ${config.storeName} (${filters.orderNumber}):`, err);
    }
    return [];
  }

  // Sipariş Detayı Zenginleştirme Yardımcısı (cache ile tekrarlı istekleri önler)
  const orderDetailCache = new Map<string, any>();
  const fetchSingleOrderDetail = async (orderNum: string): Promise<any | null> => {
    if (!orderNum) return null;
    if (orderDetailCache.has(orderNum)) return orderDetailCache.get(orderNum);
    try {
      await rateLimitDelay();
      const detUrl = `${baseUrl}/orders/merchantid/${supplierId}/ordernumber/${encodeURIComponent(orderNum)}`;
      const detRes = await safeMarketplaceFetch(detUrl, { method: 'GET', headers });
      if (detRes.ok) {
        const data = await detRes.json();
        if (data && (data.orderNumber || data.id)) {
          orderDetailCache.set(orderNum, data);
          return data;
        }
      }
    } catch (e) {
      console.warn(`[FETCH-HB-DETAIL-WARN] ${config.storeName} (${orderNum}):`, e);
    }
    return null;
  };

  const statusFilter = filters.status
    ? (Array.isArray(filters.status) ? filters.status.map(s => String(s).toLowerCase()) : [String(filters.status).toLowerCase()])
    : null;

  const shouldFetchOpen = !statusFilter || statusFilter.some(s => ['open', 'created', 'unpacked', 'new'].includes(s));
  const shouldFetchPacked = !statusFilter || statusFilter.some(s => ['packed', 'readytoship', 'processing', 'waitingforshipment'].includes(s));
  const shouldFetchShipped = !statusFilter || statusFilter.some(s => ['shipped', 'intransit', 'shipping'].includes(s));
  const shouldFetchDelivered = !statusFilter || statusFilter.some(s => ['delivered', 'completed'].includes(s));
  const shouldFetchCancelled = !statusFilter || statusFilter.some(s => ['cancelled', 'canceled', 'iptal'].includes(s));

  // 1. Paketlenmiş / Gönderime Hazır Siparişleri Çek (/packages/merchantid/{merchantId})
  // HB kuralı: Limit en fazla 10 olabilir.
  if (shouldFetchPacked) {
    try {
      for (let pOffset = 0; pOffset <= 50; pOffset += 10) {
        await rateLimitDelay();
        const pkgUrl = `${baseUrl}/packages/merchantid/${supplierId}?offset=${pOffset}&limit=10`;
        const pkgRes = await safeMarketplaceFetch(pkgUrl, { method: 'GET', headers });
        if (!pkgRes.ok) break;
        const data = await pkgRes.json();
        const pkgList = Array.isArray(data) ? data : (data?.data || data?.items || []);
        if (!pkgList || pkgList.length === 0) break;

        for (const p of pkgList) {
          const rawPItems = p.items || p.lineItems || [];
          const orderNum = String(
            p.orderNumber ||
            (p.orderNumbers && p.orderNumbers[0]) ||
            p.OrderNumber ||
            (rawPItems.length > 0 && (rawPItems[0].orderNumber || rawPItems[0].OrderNumber)) ||
            (typeof p.email === 'string' && p.email.includes('_') ? p.email.split('_')[0] : '') ||
            ''
          );
          let norm: any;
          if (rawPItems.length > 0) {
            norm = normalizeHepsiburadaPackage(p);
          } else {
            const detail = await fetchSingleOrderDetail(orderNum);
            if (detail) {
              norm = normalizeHepsiburadaOrder(detail);
              norm.shipmentPackageId = String(p.packageNumber || p.PackageNumber || p.id || norm.shipmentPackageId || '');
              norm.cargoTrackingNumber = p.barcode || p.Barcode || norm.cargoTrackingNumber;
              norm.cargoCompanyName = p.cargoCompany || p.CargoCompany || norm.cargoCompanyName;
            } else {
              norm = normalizeHepsiburadaPackage(p);
            }
          }
          norm.status = 'Packed';
          const key = `${norm.orderNumber}::${norm.shipmentPackageId || ''}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            allResults.push(norm);
          }
        }
        if (pkgList.length < 10) break;
      }
    } catch (err) {
      console.error(`[FETCH-HB-PACKAGES-ERROR] ${config.storeName}:`, err);
    }
  }

  // 2. Paketlenecek (Açık / Henüz Paketlenmemiş) Siparişleri Çek (/orders/merchantid/{merchantId})
  if (shouldFetchOpen) {
    try {
      await rateLimitDelay();
      const ordUrl = `${baseUrl}/orders/merchantid/${supplierId}?offset=0&limit=50`;
      const ordRes = await safeMarketplaceFetch(ordUrl, { method: 'GET', headers });
      if (ordRes.ok) {
        const data = await ordRes.json();
        const ordList = Array.isArray(data) ? data : (data?.items || data?.data || []);
        const groupedOrders: Record<string, any> = {};
        for (const rawItem of ordList) {
          const orderNum = String(rawItem.orderNumber || rawItem.id || '');
          if (!orderNum) continue;
          if (!groupedOrders[orderNum]) {
            groupedOrders[orderNum] = {
              ...rawItem,
              items: (rawItem.items && rawItem.items.length > 0) ? [...rawItem.items] : [rawItem]
            };
          } else {
            if (rawItem.items && Array.isArray(rawItem.items)) {
              groupedOrders[orderNum].items.push(...rawItem.items);
            } else {
              groupedOrders[orderNum].items.push(rawItem);
            }
          }
        }

        for (const o of Object.values(groupedOrders)) {
          const norm = normalizeHepsiburadaOrder(o);
          norm.status = 'Open';
          // Eğer bu sipariş zaten paketlenmişler arasında kargo koduyla çekildiyse mükerrer/eksik ekleme yapma
          if (allResults.some(r => r.orderNumber === norm.orderNumber)) {
            continue;
          }
          const key = `${norm.orderNumber}::${norm.shipmentPackageId || ''}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            allResults.push(norm);
          }
        }
      }
    } catch (err) {
      console.error(`[FETCH-HB-ORDERS-ERROR] ${config.storeName}:`, err);
    }
  }

  // 3. Kargodaki / Taşıma Durumundaki Siparişleri Çek (/packages/merchantid/{merchantId}/shipped)
  if (shouldFetchShipped) {
    try {
      for (let sOffset = 0; sOffset <= 50; sOffset += 50) {
        await rateLimitDelay();
        const shippedUrl = `${baseUrl}/packages/merchantid/${supplierId}/shipped?offset=${sOffset}&limit=50`;
        const shippedRes = await safeMarketplaceFetch(shippedUrl, { method: 'GET', headers });
        if (!shippedRes.ok) break;
        const data = await shippedRes.json();
        const list = Array.isArray(data) ? data : (data?.items || data?.data || []);
        if (!list || list.length === 0) break;

        for (const p of list) {
          const rawPItems = p.items || p.lineItems || [];
          const orderNum = String(
            p.OrderNumber ||
            p.orderNumber ||
            (p.OrderNumbers && p.OrderNumbers[0]) ||
            (p.orderNumbers && p.orderNumbers[0]) ||
            (rawPItems.length > 0 && (rawPItems[0].orderNumber || rawPItems[0].OrderNumber)) ||
            (typeof p.email === 'string' && p.email.includes('_') ? p.email.split('_')[0] : '') ||
            ''
          );
          const detail = await fetchSingleOrderDetail(orderNum);
          let norm: any;
          if (detail) {
            norm = normalizeHepsiburadaOrder(detail);
          } else {
            norm = normalizeHepsiburadaPackage(p);
          }
          norm.status = 'Shipped';
          norm.shipmentPackageId = String(p.PackageNumber || p.packageNumber || p.Id || p.id || norm.shipmentPackageId || '');
          norm.cargoTrackingNumber = p.Barcode || p.barcode || norm.cargoTrackingNumber;
          norm.cargoCompanyName = p.CargoCompany || p.cargoCompany || norm.cargoCompanyName;

          const key = `${norm.orderNumber}::${norm.shipmentPackageId || ''}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            allResults.push(norm);
          }
        }
        if (list.length < 50) break;
      }
    } catch (err) {
      console.error(`[FETCH-HB-SHIPPED-ERROR] ${config.storeName}:`, err);
    }
  }

  // 4. Teslim Edilen Siparişleri Çek (/packages/merchantid/{merchantId}/delivered)
  if (shouldFetchDelivered) {
    try {
      for (let dOffset = 0; dOffset <= 50; dOffset += 50) {
        await rateLimitDelay();
        const delivUrl = `${baseUrl}/packages/merchantid/${supplierId}/delivered?offset=${dOffset}&limit=50`;
        const delivRes = await safeMarketplaceFetch(delivUrl, { method: 'GET', headers });
        if (!delivRes.ok) break;
        const data = await delivRes.json();
        const list = Array.isArray(data) ? data : (data?.items || data?.data || []);
        if (!list || list.length === 0) break;

        for (const p of list) {
          const rawPItems = p.items || p.lineItems || [];
          const orderNum = String(
            p.OrderNumber ||
            p.orderNumber ||
            (p.OrderNumbers && p.OrderNumbers[0]) ||
            (p.orderNumbers && p.orderNumbers[0]) ||
            (rawPItems.length > 0 && (rawPItems[0].orderNumber || rawPItems[0].OrderNumber)) ||
            (typeof p.email === 'string' && p.email.includes('_') ? p.email.split('_')[0] : '') ||
            ''
          );
          const detail = await fetchSingleOrderDetail(orderNum);
          let norm: any;
          if (detail) {
            norm = normalizeHepsiburadaOrder(detail);
          } else {
            norm = normalizeHepsiburadaPackage(p);
          }
          norm.status = 'Delivered';
          norm.shipmentPackageId = String(p.PackageNumber || p.packageNumber || p.Id || p.id || norm.shipmentPackageId || '');
          norm.cargoTrackingNumber = p.Barcode || p.barcode || norm.cargoTrackingNumber;
          norm.cargoCompanyName = p.CargoCompany || p.cargoCompany || norm.cargoCompanyName;

          const key = `${norm.orderNumber}::${norm.shipmentPackageId || ''}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            allResults.push(norm);
          }
        }
        if (list.length < 50) break;
      }
    } catch (err) {
      console.error(`[FETCH-HB-DELIVERED-ERROR] ${config.storeName}:`, err);
    }
  }

  // 5. İptal Edilen Siparişleri Çek (/orders/merchantid/{merchantId}/cancelled)
  if (shouldFetchCancelled) {
    try {
      for (let cOffset = 0; cOffset <= 50; cOffset += 50) {
        await rateLimitDelay();
        const cancelUrl = `${baseUrl}/orders/merchantid/${supplierId}/cancelled?offset=${cOffset}&limit=50`;
        const cancelRes = await safeMarketplaceFetch(cancelUrl, { method: 'GET', headers });
        if (!cancelRes.ok) break;
        const data = await cancelRes.json();
        const list = Array.isArray(data) ? data : (data?.items || data?.data || []);
        if (!list || list.length === 0) break;

        const groupedCancelled: Record<string, any> = {};
        for (const rawItem of list) {
          const orderNum = String(rawItem.orderNumber || rawItem.id || '');
          if (!orderNum) continue;
          if (!groupedCancelled[orderNum]) {
            groupedCancelled[orderNum] = {
              ...rawItem,
              items: (rawItem.items && rawItem.items.length > 0) ? [...rawItem.items] : [rawItem]
            };
          } else {
            if (rawItem.items && Array.isArray(rawItem.items)) {
              groupedCancelled[orderNum].items.push(...rawItem.items);
            } else {
              groupedCancelled[orderNum].items.push(rawItem);
            }
          }
        }

        for (const o of Object.values(groupedCancelled)) {
          const norm = normalizeHepsiburadaOrder(o);
          norm.status = 'Cancelled';
          const key = `${norm.orderNumber}::${norm.shipmentPackageId || ''}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            allResults.push(norm);
          }
        }
        if (list.length < 50) break;
      }
    } catch (err) {
      console.error(`[FETCH-HB-CANCELLED-ERROR] ${config.storeName}:`, err);
    }
  }

  return allResults;
};

export async function syncBarcodeStockBatchHepsiburada(
  config: ApiConfig,
  items: { barcode: string, quantity: number }[],
  settings?: any
): Promise<boolean> {
   if (items.length === 0 || !config || !config.supplierId) return true;
   if (config.enableStockSync === false) {
      console.log(`[HB-STOCK-SYNC-SKIP] ${config.storeName} için stok senkronizasyonu devre dışı.`);
      return true;
   }

   const chunkSize = 500;
   const baseUrl = getHepsiburadaListingBaseUrl(config);
   const url = `${baseUrl}/listings/merchantid/${config.supplierId.trim()}/stock-uploads`;

   let allSuccess = true;

   for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      const payload = chunk.map(item => {
         let finalQuantity = Math.max(0, Math.floor(item.quantity));
         if (settings && settings.stockSyncSettings?.enabled) {
            const threshold = settings.stockSyncSettings.minStockThreshold || 10;
            const virtualQty = settings.stockSyncSettings.maxStockToSend || 10000;
            if (finalQuantity >= threshold) {
               console.log(`[HB-VIRTUAL-STOCK] ${item.barcode} | Gerçek Stok: ${finalQuantity} >= Eşik: ${threshold} -> Limit: ${virtualQty} gönderiliyor.`);
               finalQuantity = virtualQty;
            }
         }

         const cleanCode = (item.barcode || '').trim();
         const isHbSku = cleanCode.toUpperCase().startsWith('HBV') || cleanCode.toUpperCase().startsWith('HBCV');

         const stockObj: any = {
            availableStock: finalQuantity
         };
         if (isHbSku) {
            stockObj.hepsiburadaSku = cleanCode;
         } else {
            stockObj.merchantSku = cleanCode;
         }
         return stockObj;
      });

      try {
         await rateLimitDelay();
         console.log(`[HB-STOCK-SYNC] ${config.storeName} (${config.mode || 'PROD'}) -> ${payload.length} ürün stok güncellemesi gönderiliyor:`, payload);
         const response = await safeMarketplaceFetch(url, {
            method: 'POST',
            headers: getHepsiburadaHeaders(config),
            body: payload
         });
         if (response.ok) {
            const resJson = await response.json().catch(() => ({}));
            console.log(`[HB-STOCK-SYNC-SUCCESS] ${config.storeName} | Yanıt:`, resJson);
         } else {
            allSuccess = false;
            const errorMsg = await handleHepsiburadaError(response);
            console.error(`[HB-STOCK-SYNC-ERROR] ${config.storeName} | Hata: ${errorMsg}`);
         }
      } catch (err) {
         allSuccess = false;
         console.error(`[HB-STOCK-SYNC-EXCEPTION] ${config.storeName}:`, err);
      }
   }
   return allSuccess;
};

// --- N11 INTEGRATION ---

const getN11Headers = (config: ApiConfig) => {
  return {
    'appkey': (config.apiKey || '').trim(),
    'appsecret': (config.apiSecret || '').trim(),
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
};

const handleN11Error = async (response: any): Promise<string> => {
  let errorText = '';
  try {
    if (typeof response.json === 'function') {
      const errorData = await response.json();
      errorText = typeof errorData === 'string' ? errorData : JSON.stringify(errorData);
    } else if (typeof response.text === 'function') {
      errorText = await response.text();
    } else if (response.body) {
      errorText = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    }
  } catch {
    errorText = 'Bilinmeyen hata';
  }
  return `Hata (${response.status || 'bilinmiyor'}): ${errorText || 'Yanıt alınamadı'}`;
};

function normalizeN11Order(pkg: any) {
  const ship = pkg.shippingAddress || {};
  const inv = pkg.billingAddress || {};
  const rawLines = pkg.lines || [];

  const lines = rawLines.map((line: any) => {
    let color = '';
    let size = '';
    if (Array.isArray(line.variantAttributes)) {
      for (const va of line.variantAttributes) {
        const vName = String(va.name || '').toLowerCase();
        if (vName.includes('renk') || vName.includes('color')) {
          color = String(va.value || '');
        } else if (vName.includes('beden') || vName.includes('numara') || vName.includes('size') || vName.includes('ölçü') || vName.includes('ebat')) {
          size = String(va.value || '');
        }
      }
    }

    const barcode = String(line.stockCode || line.productId || 'NO-BARCODE');
    const merchantSku = line.stockCode ? String(line.stockCode) : undefined;
    const price = Number(line.price || line.dueAmount || line.sellerInvoiceAmount || 0);

    return {
      orderItemId: String(line.id || line.orderLineId || line.lineId || line.stockCode || Math.random().toString(36).substr(2, 9)),
      barcode,
      merchantSku,
      productName: line.productName || 'N11 Ürünü',
      quantity: Number(line.quantity || 1),
      price,
      vatRate: 0,
      color,
      size,
      productImageUrl: '',
      fullData: line
    };
  });

  const orderNum = String(pkg.orderNumber || '');
  const packageId = String(pkg.id || orderNum);
  const status = String(pkg.shipmentPackageStatus || 'Created');

  const shipAddrText = ship.address || [ship.neighborhood, ship.district, ship.city].filter(Boolean).join(' ') || '';
  const invAddrText = inv.address || [inv.neighborhood, inv.district, inv.city].filter(Boolean).join(' ') || '';

  let orderDateVal = pkg.lastModifiedDate || Date.now();
  if (Array.isArray(pkg.packageHistories) && pkg.packageHistories.length > 0) {
    const createdHist = pkg.packageHistories.find((h: any) => h.status === 'Created');
    if (createdHist && createdHist.createdDate) {
      orderDateVal = createdHist.createdDate;
    } else if (pkg.packageHistories[0].createdDate) {
      orderDateVal = pkg.packageHistories[0].createdDate;
    }
  }

  const fullName = (pkg.customerfullName || ship.fullName || inv.fullName || 'N11 Müşteri').trim();
  const phone = ship.gsm || inv.gsm || '';

  return {
    orderNumber: orderNum,
    shipmentPackageId: packageId,
    status,
    cargoTrackingNumber: pkg.cargoTrackingNumber || '-',
    cargoCompanyName: pkg.cargoProviderName || undefined,
    orderDate: orderDateVal,
    customerFirstName: fullName,
    customerLastName: '',
    customerPhoneNumber: phone,
    customerEmail: pkg.customerEmail || undefined,
    shipmentAddress: {
      address1: shipAddrText,
      city: ship.city || '',
      district: ship.district || '',
      postalCode: ship.postalCode || '',
      countryCode: 'TR'
    },
    invoiceAddress: {
      address1: invAddrText,
      city: inv.city || '',
      district: inv.district || '',
      taxNumber: pkg.taxId || pkg.tcIdentityNumber || inv.tcId || inv.taxId,
      taxOffice: pkg.taxOffice || inv.taxHouse,
      company: inv.fullName || fullName
    },
    lines,
    fullData: pkg
  };
}

export const fetchOrdersFromN11 = async (
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
  const page = (filters.page || 0);
  const limit = Math.min(filters.size || 50, 100);
  
  let url = `https://api.n11.com/rest/delivery/v1/shipmentPackages?page=${page}&size=${limit}&orderByDirection=DESC`;
  
  if (filters.status) {
    if (Array.isArray(filters.status)) {
      url += `&status=${filters.status[0]}`; 
    } else {
      url += `&status=${filters.status}`;
    }
  }

  if (filters.orderNumber) {
    url += `&orderNumber=${encodeURIComponent(filters.orderNumber)}`;
  }

  if (filters.startDate) {
    url += `&startDate=${filters.startDate}`;
  }
  if (filters.endDate) {
    url += `&endDate=${filters.endDate}`;
  }

  try {
    const response = await safeMarketplaceFetch(url, {
      method: 'GET',
      headers: getN11Headers(config)
    });

    if (response.ok) {
      const data = typeof response.json === 'function' ? await response.json() : response.body;
      const content = data?.content || (Array.isArray(data) ? data : (data?.data || []));
      return Array.isArray(content) ? content.map(normalizeN11Order) : [];
    }
    const errorMsg = await handleN11Error(response);
    console.error(`[FETCH-ORDERS-N11] ${config.storeName} | Hata: ${errorMsg}`);
  } catch (err) {
    console.error(`[FETCH-ORDERS-N11] ${config.storeName} | Bağlantı Hatası:`, err);
  }
  return [];
};

export async function syncBarcodeStockBatchN11(
  config: ApiConfig,
  items: { barcode: string, quantity: number, salePrice?: number, listPrice?: number }[],
  settings?: any
): Promise<boolean> {
   if (items.length === 0 || !config) return true;
   if (config.enableStockSync === false) return true;

   const validItems = items.filter(it => it.barcode && it.barcode !== 'NO-BARCODE');
   if (validItems.length === 0) return true;

   const chunkSize = 1000;
   for (let i = 0; i < validItems.length; i += chunkSize) {
      const chunk = validItems.slice(i, i + chunkSize);
      const skus = chunk.map(item => {
         let finalQuantity = Math.max(0, Math.floor(item.quantity));
         if (settings && settings.stockSyncSettings?.enabled) {
            const threshold = settings.stockSyncSettings.minStockThreshold || 10;
            const virtualQty = settings.stockSyncSettings.maxStockToSend || 10000;
            if (finalQuantity >= threshold) finalQuantity = virtualQty;
         }
         return {
            stockCode: String(item.barcode).trim(), 
            quantity: finalQuantity
         };
      });

      const payload = {
         payload: {
            integrator: config.storeName || 'Entegrasyon',
            skus
         }
      };

      try {
         if (config.mode === 'TEST') {
            console.log(`[TEST-N11-SYNC] ${skus.length} items:`, payload);
            continue;
         }
         await rateLimitDelay();
         const url = `https://api.n11.com/ms/product/tasks/price-stock-update`;
         const response = await safeMarketplaceFetch(url, {
            method: 'POST',
            headers: getN11Headers(config),
            body: JSON.stringify(payload)
         });
         if (!response.ok) {
            console.error('[N11-STOCK-SYNC-ERROR]', await handleN11Error(response));
         } else {
            console.log(`[N11-STOCK-SYNC-SUCCESS] ${config.storeName}: ${skus.length} ürün stok güncellendi.`);
         }
      } catch (err) {
         console.error('[N11-STOCK-SYNC-EXCEPTION]', err);
      }
   }
   return true;
};

function escapeN11Xml(unsafe: any): string {
  if (unsafe === undefined || unsafe === null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function callN11SoapService(endpointUrl: string, bodyXml: string): Promise<string> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sch="http://www.n11.com/ws/schemas">
  <soapenv:Header/>
  <soapenv:Body>
    ${bodyXml}
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await safeMarketplaceFetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Accept': 'text/xml, application/xml'
    },
    body: envelope
  });

  if (typeof response.text === 'function') {
    return await response.text();
  }
  return typeof response.body === 'string' ? response.body : JSON.stringify(response.body || '');
}

function parseXmlElements(xmlStr: string, tagName: string): Record<string, string>[] {
  const results: Record<string, string>[] = [];
  // Namespace prefix'lerini destekle (örn: <ns2:productQuestion>, <sch:productQuestion>, <productQuestion>)
  const regex = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tagName}>`, 'gi');
  let match;
  while ((match = regex.exec(xmlStr)) !== null) {
    const innerXml = match[1];
    // Tag adındaki namespace prefix'ini temizleyip alan adını al (örn: <sch:id> -> id)
    const fieldRegex = /<(?:[a-zA-Z0-9_]+:)?([a-zA-Z0-9_]+)[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?\1>/g;
    let fieldMatch;
    const item: Record<string, string> = {};
    while ((fieldMatch = fieldRegex.exec(innerXml)) !== null) {
      item[fieldMatch[1]] = fieldMatch[2].trim();
    }
    results.push(item);
  }
  return results;
}

// N11 Soru Senkronizasyonu (ProductService - GetProductQuestionList)
export async function syncN11Questions(config: ApiConfig, status?: QuestionStatus): Promise<Question[]> {
  try {
    const qStatus = status === QuestionStatus.ANSWERED ? 'CLOSED' : 'OPEN';
    const bodyXml = `
      <sch:GetProductQuestionListRequest>
        <auth>
          <appKey>${escapeN11Xml(config.apiKey)}</appKey>
          <appSecret>${escapeN11Xml(config.apiSecret)}</appSecret>
        </auth>
        <productQuestionSearch>
          <status>${qStatus}</status>
        </productQuestionSearch>
        <pagingData>
          <currentPage>0</currentPage>
          <pageSize>50</pageSize>
        </pagingData>
      </sch:GetProductQuestionListRequest>`;

    const xmlResponse = await callN11SoapService('https://api.n11.com/ws/ProductService.wsdl', bodyXml);

    // N11 SOAP Fault veya Error kontrolü
    if (xmlResponse.includes('<faultstring>') || xmlResponse.includes('<soapenv:Fault>') || xmlResponse.includes('<errorCode>')) {
      const faultMatch = xmlResponse.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i) ||
                         xmlResponse.match(/<errorMessage[^>]*>([\s\S]*?)<\/errorMessage>/i);
      const errMsg = faultMatch ? faultMatch[1].trim() : 'N11 SOAP Servis Hatası';
      console.error(`[QUESTION-SYNC-N11-ERROR] ${config.storeName}:`, errMsg);
      throw new Error(`N11 Soru Çekme Hatası: ${errMsg}`);
    }

    const parsedQuestions = parseXmlElements(xmlResponse, 'productQuestion');

    const questions: Question[] = parsedQuestions.map(item => {
      const qId = item.id || item.productQuestionId || item.questionId || Math.random().toString(36).substring(2);
      const isAnswered = Boolean(item.answer && item.answer.trim().length > 0);
      const productId = item.productId || '';
      const productTitle = item.productTitle || 'N11 Ürünü';
      return {
        id: `${config.storeName}_${qId}`,
        marketplaceQuestionId: String(qId),
        text: item.question || item.questionSubject || '',
        answer: item.answer || '',
        status: isAnswered ? QuestionStatus.ANSWERED : QuestionStatus.WAITING_FOR_ANSWER,
        userName: item.buyerEmail || item.fullName || 'N11 Müşteri',
        createdDate: item.questionDate ? new Date(item.questionDate).toISOString() : new Date().toISOString(),
        productName: productTitle,
        productImageUrl: '',
        barcode: productId || undefined,
        webUrl: productId ? `https://www.n11.com/arama?q=${encodeURIComponent(productId)}` : undefined,
        storeName: config.storeName,
        isPublic: true,
        questionImageUrl: ''
      };
    });

    return questions;
  } catch (err) {
    console.error(`[QUESTION-SYNC-N11-ERROR] ${config.storeName}:`, err);
    throw err;
  }
}

// N11 Soru Cevaplama (ProductService - SaveProductAnswer)
export async function answerN11Question(config: ApiConfig, questionId: string, answerText: string): Promise<boolean> {
  try {
    const bodyXml = `
      <sch:SaveProductAnswerRequest>
        <auth>
          <appKey>${escapeN11Xml(config.apiKey)}</appKey>
          <appSecret>${escapeN11Xml(config.apiSecret)}</appSecret>
        </auth>
        <productQuestionId>${escapeN11Xml(questionId)}</productQuestionId>
        <answer>${escapeN11Xml(answerText)}</answer>
      </sch:SaveProductAnswerRequest>`;

    const xmlResponse = await callN11SoapService('https://api.n11.com/ws/ProductService.wsdl', bodyXml);
    if (xmlResponse.includes('<status>success</status>') || xmlResponse.includes('success')) {
      console.log(`[ANSWER-N11-SUCCESS] N11 sorusu ${questionId} başarıyla cevaplandı.`);
      return true;
    } else {
      throw new Error(`N11 soru cevaplama başarısız: ${xmlResponse}`);
    }
  } catch (err) {
    console.error(`[ANSWER-N11-ERROR] Soru ${questionId}:`, err);
    throw err;
  }
}

// N11 İade Talepleri Senkronizasyonu (ReturnService - ClaimReturnList)
export async function syncN11Claims(config: ApiConfig): Promise<ReturnClaim[]> {
  try {
    const bodyXml = `
      <sch:ClaimReturnListRequest>
        <auth>
          <appKey>${escapeN11Xml(config.apiKey)}</appKey>
          <appSecret>${escapeN11Xml(config.apiSecret)}</appSecret>
        </auth>
        <searchData>
          <status>ALL</status>
        </searchData>
        <pagingData>
          <currentPage>0</currentPage>
        </pagingData>
      </sch:ClaimReturnListRequest>`;

    const xmlResponse = await callN11SoapService('https://api.n11.com/ws/ReturnService.wsdl', bodyXml);
    const parsedReturns = parseXmlElements(xmlResponse, 'claimReturn');

    const completedStatuses = new Set([
      'APPROVED', 'ACCEPTED', 'REFUNDED', 'REJECTED',
      'CANCELLED', 'CANCELED', 'COMPLETED', 'CLOSED', 'DENIED', 'MANUAL_REFUND'
    ]);

    const claims: ReturnClaim[] = [];
    for (const item of parsedReturns) {
      const claimStatus = String(item.status || 'REQUESTED').toUpperCase();
      if (completedStatuses.has(claimStatus)) {
        continue;
      }

      const claimId = String(item.claimReturnId || item.id || '');
      const barcode = String(item.skuId || item.productId || 'NO-BARCODE');

      claims.push({
        id: `${config.storeName}_${claimId}`,
        claimId,
        claimLineItemId: claimId,
        customerName: item.buyerName || 'N11 Müşteri',
        customerPhoneNumber: item.buyerPhone || undefined,
        orderNumber: String(item.orderNumber || ''),
        barcode,
        productName: item.productName || 'N11 Ürünü',
        productImageUrl: '',
        productUrl: item.productId ? `https://www.n11.com/arama?q=${encodeURIComponent(item.productId)}` : undefined,
        reason: item.returnReasonType || 'İade Talebi',
        description: item.returnReasonDescription || '',
        status: claimStatus || 'WAITING_FOR_APPROVE',
        claimItemStatus: claimStatus || 'WAITING_FOR_APPROVE',
        returnQuantity: Number(item.quantity || 1),
        orderLineItemId: item.skuId ? String(item.skuId) : undefined,
        cargoTrackingNumber: item.trackingNumber || item.sellerCampaignNumber || '-',
        color: undefined,
        size: undefined,
        storeName: config.storeName,
        claimDate: item.requestDate ? new Date(item.requestDate).toISOString() : new Date().toISOString()
      });
    }

    return claims;
  } catch (err) {
    console.error(`[CLAIM-SYNC-N11-ERROR] ${config.storeName}:`, err);
    return [];
  }
}

// N11 İade Onaylama (ReturnService - ClaimReturnApprove)
export async function approveN11Claim(config: ApiConfig, claimId: string): Promise<boolean> {
  try {
    const bodyXml = `
      <sch:ClaimReturnApproveRequest>
        <auth>
          <appKey>${escapeN11Xml(config.apiKey)}</appKey>
          <appSecret>${escapeN11Xml(config.apiSecret)}</appSecret>
        </auth>
        <claimCancelId>${escapeN11Xml(claimId)}</claimCancelId>
        <claimReturnId>${escapeN11Xml(claimId)}</claimReturnId>
      </sch:ClaimReturnApproveRequest>`;

    const xmlResponse = await callN11SoapService('https://api.n11.com/ws/ReturnService.wsdl', bodyXml);
    if (xmlResponse.includes('<status>success</status>') || xmlResponse.includes('success')) {
      console.log(`[APPROVE-N11-SUCCESS] N11 iade ${claimId} başarıyla onaylandı.`);
      return true;
    } else {
      throw new Error(`N11 iade onaylama başarısız: ${xmlResponse}`);
    }
  } catch (err) {
    console.error(`[APPROVE-N11-ERROR] İade ${claimId}:`, err);
    throw err;
  }
}

// --- AMAZON SP-API INTEGRATION ---

const getAmazonAccessToken = async (config: ApiConfig): Promise<string> => {
  if (!config.apiKey || !config.apiSecret || !config.refreshToken) {
    throw new Error('Amazon eksik yetkilendirme bilgileri (Client ID, Secret, Refresh Token).');
  }
  
  const url = 'https://api.amazon.com/auth/o2/token';
  const body = new URLSearchParams();
  body.append('grant_type', 'refresh_token');
  body.append('refresh_token', config.refreshToken);
  body.append('client_id', config.apiKey);
  body.append('client_secret', config.apiSecret);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error('Amazon Access Token alınamadı.');
  }

  const data = await response.json();
  return data.access_token;
};

const handleAmazonError = async (response: Response): Promise<string> => {
  let errorText = '';
  try {
    const errorData = await response.json();
    errorText = JSON.stringify(errorData);
  } catch {
    try {
      errorText = await response.text();
    } catch {
      errorText = 'Bilinmeyen hata';
    }
  }
  return `Hata (${response.status}): ${errorText}`;
};

export const fetchOrdersFromAmazon = async (
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
  
  try {
    const accessToken = await getAmazonAccessToken(config);
    let url = `https://sellingpartnerapi-eu.amazon.com/orders/v0/orders?MarketplaceIds=A33AVAJ2PDY3EV`; // Default to Turkey (A33AVAJ2PDY3EV)
    
    // Add default status filtering for Amazon Unshipped and PartiallyShipped
    if (filters.status) {
      if (Array.isArray(filters.status)) {
        url += `&OrderStatuses=${filters.status.join(',')}`;
      } else {
        url += `&OrderStatuses=${filters.status}`;
      }
    } else {
      url += `&OrderStatuses=Unshipped,PartiallyShipped`;
    }
    
    // CreatedAfter is required by Amazon SP-API if NextToken is not present
    const createdAfter = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();
    url += `&CreatedAfter=${createdAfter}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      return data?.payload?.Orders || [];
    }
    
    const errorMsg = await handleAmazonError(response);
    console.error(`[FETCH-ORDERS-AMAZON] ${config.storeName} | Hata: ${errorMsg}`);
  } catch (err) {
    console.error(`[FETCH-ORDERS-AMAZON] ${config.storeName} | Bağlantı Hatası:`, err);
  }
  return [];
};

export async function syncBarcodeStockBatchAmazon(
  config: ApiConfig,
  items: { barcode: string, quantity: number }[],
  settings?: any
): Promise<boolean> {
   if (items.length === 0 || !config) return true;
   if (config.enableStockSync === false) return true;

   try {
     let accessToken = '';
     if (config.mode !== 'TEST') {
       accessToken = await getAmazonAccessToken(config);
     }

     for (const item of items) {
        let finalQuantity = Math.max(0, Math.floor(item.quantity));
        if (settings && settings.stockSyncSettings?.enabled) {
          const threshold = settings.stockSyncSettings.minStockThreshold || 10;
          const virtualQty = settings.stockSyncSettings.maxStockToSend || 10000;
          if (finalQuantity >= threshold) finalQuantity = virtualQty;
        }

        if (config.mode === 'TEST') {
          console.log(`[TEST-AMAZON-SYNC] SKU: ${item.barcode}, Qty: ${finalQuantity}`);
          continue;
        }
        
        await rateLimitDelay();
        
        // Amazon Listings Items API v2021-08-01
        const sellerId = config.supplierId || 'DEFAULT_SELLER';
        const sku = encodeURIComponent(item.barcode);
        const url = `https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/${sellerId}/${sku}`;
        
        // SP-API JSON payload for patching quantity
        const payload = {
          productType: 'PRODUCT',
          patches: [
            {
              op: 'replace',
              path: '/attributes/fulfillment_availability',
              value: [{
                fulfillment_channel_code: 'DEFAULT',
                quantity: finalQuantity
              }]
            }
          ]
        };

        const response = await fetch(url, {
          method: 'PATCH',
          headers: {
            'x-amz-access-token': accessToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          console.error(`[AMAZON-STOCK-SYNC] SKU ${item.barcode} hatası:`, await handleAmazonError(response));
        }
     }
   } catch (err) {
     console.error(`[AMAZON-STOCK-SYNC-ERROR]`, err);
   }
   return true;
};

// --- PAZARAMA API INTEGRATION ---

export async function getPazaramaAccessToken(config: ApiConfig): Promise<string> {
  if (!config.apiKey || !config.apiSecret) {
    throw new Error('Pazarama eksik yetkilendirme bilgileri (Client ID, Client Secret).');
  }
  
  const url = 'https://isortagimgiris.pazarama.com/connect/token';
  const body = new URLSearchParams();
  body.append('grant_type', 'client_credentials');
  body.append('scope', 'merchantgatewayapi.fullaccess');
  body.append('client_id', config.apiKey.trim());
  body.append('client_secret', config.apiSecret.trim());
  
  const auth = btoa(`${config.apiKey.trim()}:${config.apiSecret.trim()}`);

  const response = await safeMarketplaceFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`
    },
    body: body.toString()
  });

  if (!response.ok) {
    let errText = '';
    try {
      errText = await response.text();
    } catch {
      errText = 'Token alınamadı';
    }
    console.error(`[PAZARAMA-TOKEN-ERROR] ${response.status}: ${errText}`);
    throw new Error(`Pazarama Access Token alınamadı: ${errText}`);
  }

  const data = await response.json();
  const token = data?.access_token || data?.accessToken || data?.data?.access_token || data?.data?.accessToken;
  if (!token) {
    throw new Error(`Pazarama token cevabında access_token bulunamadı: ${JSON.stringify(data)}`);
  }
  return token;
}

async function handlePazaramaError(response: any): Promise<string> {
  let errorText = '';
  try {
    if (typeof response.json === 'function') {
      const errorData = await response.json();
      errorText = typeof errorData === 'string' ? errorData : JSON.stringify(errorData);
    } else if (response.body) {
      errorText = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    }
  } catch {
    try {
      if (typeof response.text === 'function') {
        errorText = await response.text();
      }
    } catch {
      errorText = 'Bilinmeyen hata';
    }
  }
  return `Hata (${response.status}): ${errorText || response.statusText || 'Bilinmeyen hata'}`;
}

function normalizePazaramaOrder(ord: any) {
  const ship = ord.shipmentAddress || ord.ShipmentAddress || {};
  const inv = ord.billingAddress || ord.BillingAddress || ord.invoiceAddress || ord.InvoiceAddress || {};
  const rawItems = ord.items || ord.Items || ord.orderItems || ord.OrderItems || ord.orderDetail || [];

  let firstCargoName: string | undefined;
  let firstCargoTracking: string | undefined;

  const lines = rawItems.map((item: any) => {
    const prod = item.product || item.Product || {};
    const salePriceObj = item.salePrice || item.SalePrice;
    const priceVal = typeof salePriceObj === 'object' && salePriceObj !== null
      ? Number(salePriceObj.value ?? salePriceObj.amount ?? 0)
      : Number(salePriceObj ?? item.price ?? item.Price ?? item.unitPrice ?? 0);

    if (item.cargoTrackingNumber && !firstCargoTracking) {
      firstCargoTracking = item.cargoTrackingNumber;
    }
    if (item.cargoProviderName && !firstCargoName) {
      firstCargoName = item.cargoProviderName;
    }

    const cargoObj = item.cargo || item.Cargo || {};
    const cargoTracking = cargoObj.trackingNumber || cargoObj.TrackingNumber || item.shipmentCode || item.ShipmentCode || '';
    const cargoCompany = cargoObj.companyName || cargoObj.CompanyName || ord.cargoProviderName || ord.CargoProviderName || '';

    if (!firstCargoName && cargoCompany) firstCargoName = cargoCompany;
    if (!firstCargoTracking && cargoTracking) firstCargoTracking = cargoTracking;

    // Pazarama'da product.code barkod, product.stockCode stok kodu/SKU'dur
    const barcode = String(prod.code || prod.stockCode || item.stockCode || item.StockCode || item.barcode || item.Barcode || item.merchantSku || 'NO-BARCODE');
    const merchantSku = prod.stockCode || prod.code || item.stockCode || item.StockCode || item.merchantSku || item.barcode;
    const productName = prod.name || prod.Name || item.productName || item.ProductName || item.name || item.title || 'Ürün';
    const vatRate = Number(prod.vatRate ?? item.vatRate ?? item.VatRate ?? 0);

    // Renk ve beden seçenekleri (variantOptionDisplay örn: "Kırmızı - L")
    let color = item.color || item.Color || '';
    let size = item.size || item.Size || '';
    if (!color && !size && prod.variantOptionDisplay) {
      const parts = String(prod.variantOptionDisplay).split('-').map((s: string) => s.trim());
      if (parts.length >= 2) {
        color = parts[0];
        size = parts.slice(1).join(' - ');
      } else if (parts.length === 1) {
        size = parts[0];
      }
    }

    return {
      orderItemId: String(item.orderItemId || item.OrderItemId || item.id || Math.random().toString(36).substr(2, 9)),
      barcode,
      merchantSku,
      productName,
      quantity: Number(item.quantity || item.Quantity || item.amount || 1),
      price: priceVal,
      vatRate,
      color,
      size,
      productImageUrl: prod.imageURL || prod.imageUrl || item.productImageUrl || '',
      fullData: item
    };
  });

  const shipAddrText = ship.displayAddressText || ship.addressDetail || ship.addressText || ship.AddressText || ship.address || [ship.districtName || ship.district || ship.District, ship.cityName || ship.city || ship.City].filter(Boolean).join(', ');
  const invAddrText = inv.displayAddressText || inv.addressDetail || inv.addressText || inv.AddressText || inv.address || [inv.districtName || inv.district || inv.District, inv.cityName || inv.city || inv.City].filter(Boolean).join(', ');

  const orderNum = String(ord.orderNumber || ord.OrderNumber || ord.orderId || ord.id || '');

  // Pazarama API'sinde kök ord.orderStatus değeri çoğu zaman 3 ("Siparişiniz Alındı") olarak sabit kalır.
  // Gerçek sipariş durumu, kalemlerin (rawItems) orderItemStatus değerlerine göre çözümlenmelidir:
  // 11: Teslim Edildi, 5: Kargoda, 12: Hazırlanıyor, 3: Sipariş Alındı, 6/13: İptal, 7/8/10: İade (teslimat sonrası)
  let resolvedStatus = '3';
  let resolvedStatusName = 'Siparişiniz Alındı';

  const rootStatusNum = Number(ord.orderStatus);
  const rootStatusNameLower = String(ord.orderStatusName || '').toLowerCase();
  const rootIsCancelled = [6, 13, 18].includes(rootStatusNum) ||
    rootStatusNameLower.includes('iptal') ||
    rootStatusNameLower.includes('cancel');

  if (rawItems.length > 0) {
    const itemStatuses = rawItems.map((it: any) => Number(it.orderItemStatus || it.OrderItemStatus || it.status || 0));
    
    // 1. Teslim edilmiş veya teslimat sonrası iade açılmış siparişler -> Teslim Edildi (11) (Trendyol mantığı gibi korunur)
    if (itemStatuses.some((st: number) => st === 11 || st === 7 || st === 8 || st === 10)) {
      resolvedStatus = '11';
      resolvedStatusName = 'Teslim Edildi';
    }
    // 2. Kargodaki siparişler -> Kargoya Verildi / Taşıma Durumunda (5)
    else if (itemStatuses.some((st: number) => st === 5 || st === 14)) {
      resolvedStatus = '5';
      resolvedStatusName = 'Siparişiniz Kargoya Verildi';
    }
    // 3. Hazırlanan siparişler -> Hazırlanıyor (12)
    else if (itemStatuses.some((st: number) => st === 12)) {
      resolvedStatus = '12';
      resolvedStatusName = 'Siparişiniz Hazırlanıyor';
    }
    // 4. Kök statü iptal veya tüm kalemler iptal edilmişse -> İptal Edildi (6)
    else if (rootIsCancelled || itemStatuses.every((st: number) => st === 6 || st === 13 || st === 18)) {
      resolvedStatus = '6';
      resolvedStatusName = 'Siparişiniz İptal Edildi';
    }
    // 5. Siparişiniz Alındı (3) veya kök statü
    else {
      resolvedStatus = String(ord.orderStatus || '3');
      resolvedStatusName = ord.orderStatusName || 'Siparişiniz Alındı';
    }
  } else {
    if (rootIsCancelled) {
      resolvedStatus = '6';
      resolvedStatusName = 'Siparişiniz İptal Edildi';
    } else {
      resolvedStatus = ord.orderStatusName || (ord.orderStatus != null ? String(ord.orderStatus) : '3');
      resolvedStatusName = ord.orderStatusName || 'Siparişiniz Alındı';
    }
  }

  return {
    orderNumber: orderNum,
    shipmentPackageId: String(ord.shipmentPackageId || ord.packageId || ord.id || orderNum),
    status: resolvedStatusName || resolvedStatus,
    cargoTrackingNumber: ord.cargoTrackingNumber || ord.CargoTrackingNumber || ord.shipmentCode || ord.ShipmentCode || ord.cargoCode || ord.CargoCode || firstCargoTracking || '-',
    cargoCompanyName: ord.cargoProviderName || ord.CargoProviderName || ord.cargoCompany || ord.CargoCompany || ord.cargoCompanyName || firstCargoName || undefined,
    orderDate: ord.orderDate || ord.OrderDate || ord.createdDate || ord.CreatedDate || Date.now(),
    customerFirstName: ord.customerName || ord.CustomerName || ord.recipientName || `${ord.customerFirstName || ord.CustomerFirstName || ''} ${ord.customerLastName || ord.CustomerLastName || ''}`.trim() || 'Müşteri',
    customerLastName: '',
    customerPhoneNumber: ord.customerPhoneNumber || ord.phoneNumber || ord.PhoneNumber || ship.phoneNumber || ship.PhoneNumber || ship.phone,
    customerEmail: ord.customerEmail || ord.CustomerEmail || ord.email || ord.Email,
    shipmentAddress: {
      address1: shipAddrText,
      city: ship.cityName || ship.city || ship.City,
      district: ship.districtName || ship.district || ship.District,
      postalCode: ship.postalCode || ship.PostalCode,
      countryCode: ship.countryCode || ship.CountryCode || 'TR'
    },
    invoiceAddress: {
      address1: invAddrText,
      city: inv.cityName || inv.city || inv.City,
      district: inv.districtName || inv.district || inv.District,
      taxNumber: inv.taxNumber || inv.TaxNumber || inv.identityNumber,
      taxOffice: inv.taxOffice || inv.TaxOffice,
      company: inv.companyName || inv.CompanyName || inv.company
    },
    lines,
    fullData: ord
  };
}

export const fetchOrdersFromPazarama = async (
  config: ApiConfig,
  filters: {
    status?: string | number | (string | number)[];
    startDate?: number;
    endDate?: number;
    page?: number;
    size?: number;
    orderNumber?: string;
  }
): Promise<any[]> => {
  await rateLimitDelay();
  
  try {
    const accessToken = await getPazaramaAccessToken(config);
    const url = `https://isortagimapi.pazarama.com/order/getOrdersForApi`;
    
    const now = new Date();
    const formatYMD = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // Pazarama en fazla 30 günlük tarih aralığı kabul eder (ORD105 kuralı)
    const maxHorizonMs = 28 * 24 * 60 * 60 * 1000;
    const requestedStart = filters.startDate ? Number(filters.startDate) : (now.getTime() - (14 * 24 * 60 * 60 * 1000));
    const safeStart = Math.max(requestedStart, now.getTime() - maxHorizonMs);
    const startDate = formatYMD(new Date(safeStart));
    const endDate = filters.endDate 
      ? formatYMD(new Date(filters.endDate))
      : formatYMD(new Date(now.getTime() + (24 * 60 * 60 * 1000)));

    const payload: any = {
      pageSize: Math.min(filters.size || 50, 100),
      pageNumber: (filters.page || 0) + 1,
      startDate: startDate,
      endDate: endDate
    };

    if (filters.status !== undefined && filters.status !== null) {
      payload.orderStatus = typeof filters.status === 'string' && !isNaN(Number(filters.status))
        ? Number(filters.status)
        : filters.status;
    }
    if (filters.orderNumber) {
      payload.orderNumber = Number(filters.orderNumber) || filters.orderNumber;
    }

    const response = await safeMarketplaceFetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      if (data && data.success === false) {
        console.warn(`[FETCH-ORDERS-PAZARAMA] ${config.storeName} Uyarı:`, data.message || data.userMessage);
        return [];
      }
      const rawOrders = data?.data || data?.Data?.Orders || data?.Data || data?.orders || [];
      return Array.isArray(rawOrders) ? rawOrders.map(normalizePazaramaOrder) : [];
    }
    
    const errorMsg = await handlePazaramaError(response);
    console.error(`[FETCH-ORDERS-PAZARAMA] ${config.storeName} | Hata: ${errorMsg}`);
  } catch (err) {
    console.error(`[FETCH-ORDERS-PAZARAMA] ${config.storeName} | Bağlantı Hatası:`, err);
  }
  return [];
};

export async function syncBarcodeStockBatchPazarama(
  config: ApiConfig,
  items: { barcode: string, quantity: number, salePrice?: number, listPrice?: number }[],
  settings?: any
): Promise<boolean> {
   if (items.length === 0 || !config) return true;
   if (config.enableStockSync === false) return true;

   const validItems = items.filter(it => it.barcode && it.barcode !== 'NO-BARCODE');
   if (validItems.length === 0) {
     console.log(`[PAZARAMA-STOCK-SYNC] Gönderilecek geçerli barkod bulunamadı.`);
     return true;
   }

   try {
     let accessToken = '';
     if (config.mode !== 'TEST') {
       accessToken = await getPazaramaAccessToken(config);
     }

     const chunkSize = 250;
     for (let i = 0; i < validItems.length; i += chunkSize) {
        const chunk = validItems.slice(i, i + chunkSize);
        
        const payloadItems = chunk.map(item => {
           let finalQuantity = Math.max(0, Math.floor(item.quantity));
           if (settings && settings.stockSyncSettings?.enabled) {
              const threshold = settings.stockSyncSettings.minStockThreshold ?? 10;
              const virtualQty = settings.stockSyncSettings.maxStockToSend ?? 10000;
              if (finalQuantity >= threshold) finalQuantity = virtualQty;
           }
           const price = Math.max(1, Number(item.salePrice || item.listPrice || 100));
           return {
              code: String(item.barcode).trim(), 
              stockCount: finalQuantity,
              listPrice: Math.max(1, Number(item.listPrice || price)),
              salePrice: price
           };
        });

        const payload = {
           items: payloadItems
        };

        if (config.mode === 'TEST') {
          console.log(`[TEST-PAZARAMA-SYNC] ${payloadItems.length} items:`, payload);
          continue;
        }
        
        await rateLimitDelay();
        
        const url = `https://isortagimapi.pazarama.com/product/updatePriceAndInventory-v2`;
        const response = await safeMarketplaceFetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errText = await handlePazaramaError(response);
          console.error(`[PAZARAMA-STOCK-SYNC] Hata:`, errText);
          throw new Error(`Pazarama stok güncelleme hatası: ${errText}`);
        }

        const resData = await response.json().catch(() => null);
        if (resData && resData.success === false) {
          const errMsg = resData.message || resData.userMessage || 'Pazarama stok güncellenemedi.';
          console.error(`[PAZARAMA-STOCK-SYNC-FAIL]`, errMsg);
          throw new Error(`Pazarama stok güncelleme hatası: ${errMsg}`);
        }

        console.log(`[PAZARAMA-STOCK-SYNC] Başarılı (${config.storeName}): ${payloadItems.length} barkod güncellendi. BatchId:`, resData?.data);
     }

   } catch (err) {
     console.error(`[PAZARAMA-STOCK-SYNC-ERROR]`, err);
     throw err;
   }
   return true;
};

// --- IDEFIX INTEGRATION ---

export function getIdefixHeaders(config: ApiConfig) {
  const apiKey = (config.apiKey || '').trim();
  const apiSecret = (config.apiSecret || '').trim();
  const token = typeof Buffer !== 'undefined'
    ? Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')
    : btoa(`${apiKey}:${apiSecret}`);
  return {
    'X-API-KEY': token,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

async function handleIdefixError(response: any): Promise<string> {
  let errorText = '';
  try {
    if (typeof response.json === 'function') {
      const errorData = await response.json();
      errorText = typeof errorData === 'string' ? errorData : JSON.stringify(errorData);
    } else if (response.body) {
      errorText = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    } else if (typeof response.text === 'function') {
      errorText = await response.text();
    }
  } catch {
    errorText = 'Bilinmeyen hata';
  }
  return `Hata (${response.status || 'bilinmiyor'}): ${errorText || 'Yanıt alınamadı'}`;
}

function normalizeIdefixOrder(shipment: any) {
  const ship = shipment.shippingAddress || {};
  const inv = shipment.invoiceAddress || {};
  const rawItems = shipment.items || [];

  const lines = rawItems.map((item: any) => {
    let color = '';
    let size = '';
    if (Array.isArray(item.productAttributes)) {
      for (const attr of item.productAttributes) {
        const aName = String(attr.attributeName || '').toLowerCase();
        if (aName.includes('renk') || aName.includes('color')) {
          color = String(attr.attributeValueName || '');
        } else if (aName.includes('beden') || aName.includes('numara') || aName.includes('size') || aName.includes('ölçü') || aName.includes('ebat')) {
          size = String(attr.attributeValueName || '');
        }
      }
    }

    const barcode = String(item.barcode || item.merchantSku || item.productCode || item.erpId || 'NO-BARCODE');
    const merchantSku = item.merchantSku || item.productCode || item.barcode;
    const price = Number(item.discountedTotalPrice || item.price || item.vendorAmount || 0);

    return {
      orderItemId: String(item.id || Math.random().toString(36).substr(2, 9)),
      barcode,
      merchantSku: merchantSku ? String(merchantSku) : undefined,
      productName: item.productName || 'İdefix Ürünü',
      quantity: Number(item.quantity || 1),
      price,
      vatRate: Number(item.vatRate || 0),
      color,
      size,
      productImageUrl: item.image ? item.image.replace('{size}', '400') : '',
      fullData: item
    };
  });

  const orderNum = String(shipment.orderNumber || '');
  const shipmentId = String(shipment.id || orderNum);
  const status = String(shipment.status || 'shipment_ready');

  const shipAddrText = ship.fullAddress || ship.address1 || [ship.neighboorhood, ship.county, ship.city].filter(Boolean).join(' ') || '';
  const invAddrText = inv.fullAddress || inv.address1 || [inv.neighboorhood, inv.county, inv.city].filter(Boolean).join(' ') || '';

  const orderDateVal = shipment.orderDate 
    ? new Date(shipment.orderDate).getTime() 
    : (shipment.createdAt ? new Date(shipment.createdAt).getTime() : Date.now());

  const fullName = (ship.fullName || `${ship.firstName || ''} ${ship.lastName || ''}`.trim() || shipment.customerContactName || 'İdefix Müşteri').trim();
  const phone = ship.phone || inv.phone || '';

  return {
    orderNumber: orderNum,
    shipmentPackageId: shipmentId,
    status,
    cargoTrackingNumber: shipment.cargoTrackingNumber || '-',
    cargoCompanyName: shipment.cargoCompany || shipment.cargoProfileName || undefined,
    orderDate: orderDateVal,
    customerFirstName: fullName,
    customerLastName: '',
    customerPhoneNumber: phone,
    customerEmail: shipment.customerContactMail || undefined,
    shipmentAddress: {
      address1: shipAddrText,
      city: ship.city || '',
      district: ship.county || ship.neighboorhood || '',
      postalCode: ship.postalCode || '',
      countryCode: ship.countryCode || 'TR'
    },
    invoiceAddress: {
      address1: invAddrText,
      city: inv.city || '',
      district: inv.county || inv.neighboorhood || '',
      taxNumber: inv.taxNumber || inv.identificationNumber || '',
      taxOffice: inv.taxOffice || '',
      company: inv.company || inv.fullName || fullName
    },
    lines,
    fullData: shipment
  };
}

export const fetchOrdersFromIdefix = async (
  config: ApiConfig,
  filters: {
    state?: string;
    page?: number;
    limit?: number;
    orderNumber?: string;
    startDate?: string;
    endDate?: string;
  }
): Promise<any[]> => {
  await rateLimitDelay();
  const vendorId = (config.supplierId || '').trim();
  if (!vendorId) {
    console.error(`[FETCH-ORDERS-IDEFIX] ${config.storeName} | Satıcı ID (Vendor ID) eksik.`);
    return [];
  }

  const page = filters.page || 1;
  const limit = Math.min(filters.limit || 50, 50);
  let url = `https://merchantapi.idefix.com/oms/${vendorId}/list?page=${page}&limit=${limit}&sortDirection=desc`;

  if (filters.state) {
    url += `&state=${encodeURIComponent(filters.state)}`;
  }
  if (filters.orderNumber) {
    url += `&orderNumber=${encodeURIComponent(filters.orderNumber)}`;
  }

  try {
    const response = await safeMarketplaceFetch(url, {
      method: 'GET',
      headers: getIdefixHeaders(config)
    });

    if (response.ok) {
      const data = typeof response.json === 'function' ? await response.json() : response.body;
      const rawItems = data?.items || (Array.isArray(data) ? data : []);
      return Array.isArray(rawItems) ? rawItems.map(normalizeIdefixOrder) : [];
    }
    const errorMsg = await handleIdefixError(response);
    console.error(`[FETCH-ORDERS-IDEFIX] ${config.storeName} | Hata: ${errorMsg}`);
  } catch (err) {
    console.error(`[FETCH-ORDERS-IDEFIX] ${config.storeName} | Bağlantı Hatası:`, err);
  }
  return [];
};

export async function syncBarcodeStockBatchIdefix(
  config: ApiConfig,
  items: { barcode: string, quantity: number, salePrice?: number, listPrice?: number }[],
  settings?: any
): Promise<boolean> {
  if (items.length === 0 || !config) return true;
  if (config.enableStockSync === false) return true;

  const vendorId = (config.supplierId || '').trim();
  if (!vendorId) {
    console.error(`[IDEFIX-STOCK-SYNC] ${config.storeName} | Satıcı ID (Vendor ID) eksik.`);
    return false;
  }

  const validItems = items.filter(it => it.barcode && it.barcode !== 'NO-BARCODE');
  if (validItems.length === 0) return true;

  const chunkSize = 500;
  for (let i = 0; i < validItems.length; i += chunkSize) {
    const chunk = validItems.slice(i, i + chunkSize);
    const payloadItems = chunk.map(item => {
      let finalQuantity = Math.max(0, Math.floor(item.quantity));
      if (settings && settings.stockSyncSettings?.enabled) {
        const threshold = settings.stockSyncSettings.minStockThreshold || 10;
        const virtualQty = settings.stockSyncSettings.maxStockToSend || 10000;
        if (finalQuantity >= threshold) finalQuantity = virtualQty;
      }
      const price = Math.max(1, Number(item.salePrice || item.listPrice || 100));
      return {
        barcode: String(item.barcode).trim(),
        inventoryQuantity: finalQuantity,
        price: price,
        comparePrice: Math.max(0, Number(item.listPrice || 0)),
        maximumPurchasableQuantity: 0,
        deliveryDuration: 1,
        deliveryType: 'regular'
      };
    });

    const payload = { items: payloadItems };

    try {
      if (config.mode === 'TEST') {
        console.log(`[TEST-IDEFIX-SYNC] ${payloadItems.length} items:`, payload);
        continue;
      }
      await rateLimitDelay();
      const url = `https://merchantapi.idefix.com/pim/catalog/${vendorId}/inventory-upload`;
      const response = await safeMarketplaceFetch(url, {
        method: 'POST',
        headers: getIdefixHeaders(config),
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        console.error('[IDEFIX-STOCK-SYNC-ERROR]', await handleIdefixError(response));
      } else {
        console.log(`[IDEFIX-STOCK-SYNC-SUCCESS] ${config.storeName}: ${payloadItems.length} ürün stok güncellendi.`);
      }
    } catch (err) {
      console.error('[IDEFIX-STOCK-SYNC-EXCEPTION]', err);
    }
  }
  return true;
}

export async function syncIdefixQuestions(config: ApiConfig, status?: QuestionStatus): Promise<Question[]> {
  const vendorId = (config.supplierId || '').trim();
  if (!vendorId) return [];

  const questions: Question[] = [];

  // 1. Müşteri (Ürün) Soruları
  try {
    const url = `https://merchantapi.idefix.com/pim/vendor/${vendorId}/question/filter?page=1&limit=50&sort=newest`;
    const response = await safeMarketplaceFetch(url, {
      method: 'GET',
      headers: getIdefixHeaders(config)
    });
    if (response.ok) {
      const data = typeof response.json === 'function' ? await response.json() : response.body;
      const rawList = data?.items || (Array.isArray(data) ? data : []);
      for (const item of rawList) {
        const qId = String(item.id || '');
        const answers = Array.isArray(item.productQuestionAnswer) ? item.productQuestionAnswer : [];
        const isAnswered = answers.length > 0;
        const lastAns = isAnswered ? (answers[answers.length - 1]?.answerBody || '') : '';
        questions.push({
          id: `${config.storeName}_${qId}`,
          marketplaceQuestionId: qId,
          text: item.question || '',
          answer: lastAns,
          status: isAnswered ? QuestionStatus.ANSWERED : QuestionStatus.WAITING_FOR_ANSWER,
          userName: item.customerName || 'İdefix Müşteri',
          createdDate: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
          productName: item.product || 'İdefix Ürünü',
          productImageUrl: '',
          storeName: config.storeName,
          isPublic: true,
          questionImageUrl: ''
        });
      }
    }
  } catch (qErr) {
    console.warn(`[IDEFIX-PRODUCT-QUESTIONS-ERROR]`, qErr);
  }

  // 2. Sipariş Soruları
  try {
    const sStatus = status === QuestionStatus.ANSWERED ? 'answered' : (status === QuestionStatus.WAITING_FOR_ANSWER ? 'unanswered' : undefined);
    let url = `https://merchantapi.idefix.com/pim/vendor/${vendorId}/order-question/filter?page=1&limit=50&sort=newest`;
    if (sStatus) url += `&status=${sStatus}`;

    const response = await safeMarketplaceFetch(url, {
      method: 'GET',
      headers: getIdefixHeaders(config)
    });
    if (response.ok) {
      const data = typeof response.json === 'function' ? await response.json() : response.body;
      const rawList = data?.items || (Array.isArray(data) ? data : []);
      for (const item of rawList) {
        const qId = String(item.id || '');
        const isAnswered = Boolean(item.isReadMessage) && Boolean(item.lastMessage);
        questions.push({
          id: `${config.storeName}_order_${qId}`,
          marketplaceQuestionId: `order_${qId}`,
          text: `${item.reason ? `[${item.reason}] ` : ''}${item.lastMessage || 'Sipariş Sorusu'}`,
          answer: '',
          status: isAnswered ? QuestionStatus.ANSWERED : QuestionStatus.WAITING_FOR_ANSWER,
          userName: item.customerName || 'İdefix Müşteri',
          createdDate: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
          productName: item.orderNumber ? `Sipariş: ${item.orderNumber}` : 'İdefix Siparişi',
          productImageUrl: '',
          barcode: item.productCode || undefined,
          storeName: config.storeName,
          isPublic: false,
          questionImageUrl: ''
        });
      }
    }
  } catch (ordQErr) {
    console.warn(`[IDEFIX-ORDER-QUESTIONS-ERROR]`, ordQErr);
  }

  return questions;
}

export async function answerIdefixQuestion(config: ApiConfig, questionId: string, answerText: string): Promise<boolean> {
  const vendorId = (config.supplierId || '').trim();
  if (!vendorId) throw new Error('İdefix Satıcı ID (Vendor ID) eksik.');

  const isOrderQuestion = questionId.startsWith('order_');
  const cleanId = isOrderQuestion ? questionId.replace('order_', '') : questionId;

  if (isOrderQuestion) {
    const url = `https://merchantapi.idefix.com/pim/vendor/${vendorId}/order-question/${cleanId}/answer`;
    const response = await safeMarketplaceFetch(url, {
      method: 'POST',
      headers: getIdefixHeaders(config),
      body: JSON.stringify({
        answer_body: answerText,
        type: 1
      })
    });
    if (response.ok) {
      console.log(`[ANSWER-IDEFIX-SUCCESS] İdefix sipariş sorusu ${cleanId} cevaplandı.`);
      return true;
    }
    const err = await handleIdefixError(response);
    throw new Error(`İdefix sipariş sorusu cevaplama hatası: ${err}`);
  } else {
    const url = `https://merchantapi.idefix.com/pim/vendor/${vendorId}/question/${cleanId}/answer`;
    const response = await safeMarketplaceFetch(url, {
      method: 'POST',
      headers: getIdefixHeaders(config),
      body: JSON.stringify({
        answer_body: answerText
      })
    });
    if (response.ok) {
      console.log(`[ANSWER-IDEFIX-SUCCESS] İdefix ürün sorusu ${cleanId} cevaplandı.`);
      return true;
    }
    const err = await handleIdefixError(response);
    throw new Error(`İdefix ürün sorusu cevaplama hatası: ${err}`);
  }
}

export async function syncIdefixClaims(config: ApiConfig): Promise<ReturnClaim[]> {
  const vendorId = (config.supplierId || '').trim();
  if (!vendorId) return [];

  try {
    const url = `https://merchantapi.idefix.com/oms/${vendorId}/claim-list?page=1&limit=50`;
    const response = await safeMarketplaceFetch(url, {
      method: 'GET',
      headers: getIdefixHeaders(config)
    });

    if (!response.ok) {
      console.warn(`[FETCH-IDEFIX-CLAIMS] ${config.storeName} | ${response.status}`);
      return [];
    }

    const data = typeof response.json === 'function' ? await response.json() : response.body;
    const rawShipments = data?.items || (Array.isArray(data) ? data : []);
    const claims: ReturnClaim[] = [];

    const completedStatuses = new Set(['approved', 'decline', 'vendor_decline_request']);

    for (const shipment of rawShipments) {
      const claimId = String(shipment.id || '');
      const rawItems = shipment.items || [shipment];

      for (const item of rawItems) {
        const itemState = String(item.state || 'ready').toLowerCase();
        if (completedStatuses.has(itemState)) continue;

        const lineId = String(item.id || item.orderLineId || claimId);
        const barcode = String(item.barcode || item.productCode || item.merchantSku || 'NO-BARCODE');

        claims.push({
          id: `${config.storeName}_${claimId}_${lineId}`,
          claimId,
          claimLineItemId: lineId,
          customerName: shipment.customerName || 'İdefix Müşteri',
          orderNumber: String(shipment.orderNumber || ''),
          barcode,
          productName: item.productName || 'İdefix Ürünü',
          productImageUrl: item.productImage ? item.productImage.replace('{size}', '400') : '',
          productUrl: undefined,
          reason: item.customerReason || item.vendorReason || item.stateName || 'İade Talebi',
          description: item.customerNote || item.vendorNote || item.note || '',
          status: 'WAITING_FOR_APPROVE',
          claimItemStatus: 'WAITING_FOR_APPROVE',
          returnQuantity: Number(item.quantity || 1),
          orderLineItemId: item.orderLineId ? String(item.orderLineId) : undefined,
          cargoTrackingNumber: shipment.cargoTrackingNumber || shipment.cargoKey || '-',
          color: undefined,
          size: undefined,
          storeName: config.storeName,
          claimDate: shipment.createdAt ? new Date(shipment.createdAt).toISOString() : new Date().toISOString()
        });
      }
    }
    return claims;
  } catch (err) {
    console.error(`[CLAIM-SYNC-IDEFIX-ERROR] ${config.storeName}:`, err);
    return [];
  }
}

export async function approveIdefixClaim(config: ApiConfig, claimId: string, claimLineItemIdList?: string[]): Promise<boolean> {
  const vendorId = (config.supplierId || '').trim();
  if (!vendorId) throw new Error('İdefix Satıcı ID (Vendor ID) eksik.');

  const lineIds = (claimLineItemIdList && claimLineItemIdList.length > 0)
    ? claimLineItemIdList
    : [claimId];

  try {
    // 1. Önce Satıcıya Ulaştı Bildirimi (claim-delivered-to-vendor)
    try {
      const deliveredUrl = `https://merchantapi.idefix.com/oms/${vendorId}/${claimId}/claim-delivered-to-vendor`;
      await safeMarketplaceFetch(deliveredUrl, {
        method: 'POST',
        headers: getIdefixHeaders(config),
        body: JSON.stringify({
          claimLineIds: lineIds.map(id => Number(id) || 0)
        })
      });
    } catch (dErr) {
      console.warn(`[IDEFIX-CLAIM-DELIVERED-WARN] ${claimId}:`, dErr);
    }

    // 2. İade Onayı (claim-approve)
    const approveUrl = `https://merchantapi.idefix.com/oms/${vendorId}/${claimId}/claim-approve`;
    const response = await safeMarketplaceFetch(approveUrl, {
      method: 'POST',
      headers: getIdefixHeaders(config),
      body: JSON.stringify({
        claimLineIds: lineIds.map(String)
      })
    });

    if (response.ok) {
      console.log(`[APPROVE-IDEFIX-SUCCESS] İdefix iade ${claimId} onaylandı.`);
      return true;
    }
    const err = await handleIdefixError(response);
    throw new Error(`İdefix iade onaylama hatası: ${err}`);
  } catch (err) {
    console.error(`[APPROVE-IDEFIX-ERROR] İade ${claimId}:`, err);
    throw err;
  }
}

// --- AUTO ALLOCATE PENDING ORDERS ---
export const autoAllocatePendingOrders = (db: any): any => {
    let updatedOrders = [...db.orders];
    let currentDbProducts = [...db.products];
    let madeChanges = false;
    
    updatedOrders = updatedOrders.map(order => {
        if (!order.fulfillmentInfo?.isOutOfStock) return order;
        // İptal edilmiş veya teslim edilmiş siparişler için işlem yapma
        if (order.status === 'İptal Edildi' || order.status === 'Teslim Edildi' || order.status === 'İade Edildi' || order.status === 'Tamamlandı') return order;
        
        let stillOutOfStock = false;
        const newFulfillmentInfo = { 
            ...order.fulfillmentInfo, 
            itemsFulfillment: { ...order.fulfillmentInfo.itemsFulfillment },
            warehouseInitials: [...order.fulfillmentInfo.warehouseInitials],
            warehouseNames: [...order.fulfillmentInfo.warehouseNames]
        };
        
        order.items.forEach((item: any, index: number) => {
            const currentItemFulfillments = [...(newFulfillmentInfo.itemsFulfillment[`${item.barcode}_${index}`] || [])];
            let fulfilledQty = currentItemFulfillments.reduce((sum: number, f: any) => sum + f.qty, 0);
            let remainingQty = item.quantity - fulfilledQty;
            
            if (remainingQty > 0) {
                // Deneme yap
                const orderConfig = (db.apiConfigs || []).find((c: any) => c.storeName === order.storeName);
                let warehouses = db.warehouses && db.warehouses.length > 0 ? [...db.warehouses] : [{ id: 'wh1', name: 'Depo 1' }];
                warehouses = warehouses.filter((w: any) => !w.syncDisabled);
                warehouses.sort((a: any, b: any) => {
                    if (orderConfig?.linkedWarehouseId) {
                        if (a.id === orderConfig.linkedWarehouseId) return -1;
                        if (b.id === orderConfig.linkedWarehouseId) return 1;
                    }
                    const prioA = a.priority ?? 999;
                    const prioB = b.priority ?? 999;
                    return prioA - prioB;
                });
                
                for (const wh of warehouses) {
                    if (remainingQty <= 0) break;
                    
                    const product = currentDbProducts.find(p => p.variants.some((v: any) => v.barcode === item.barcode));
                    if (!product) continue;
                    const variant = product.variants.find((v: any) => v.barcode === item.barcode);
                    if (!variant) continue;
                    
                    const currentWhStock = variant.stocks[wh.id] || 0;
                    if (currentWhStock > 0) {
                        const deduct = Math.min(currentWhStock, remainingQty);
                        const newStock = currentWhStock - deduct;
                        remainingQty -= deduct;
                        
                        // In integration.ts updateLocalStockWithConsistency is used, I should call it. 
                        // Wait, updateLocalStockWithConsistency is in integration.ts but is it exported or accessible here? Yes, it's defined in integration.ts.
                        const result = updateLocalStockWithConsistency(currentDbProducts, product.id, variant.color, variant.size, wh.id, newStock);
                        currentDbProducts = result.updatedProducts;
                        
                        const words = wh.name.split(' ').filter((w: string) => w.trim().length > 0);
                        let initial = '?';
                        if (words.length >= 2) initial = (words[0][0] + words[1][0]).toUpperCase();
                        else if (words.length === 1) initial = words[0].substring(0, 2).toUpperCase();
                        else if (wh.name.length > 0) initial = wh.name.substring(0, 2).toUpperCase();
                        
                        const existing = currentItemFulfillments.find(f => f.whName === wh.name);
                        if (existing) existing.qty += deduct;
                        else currentItemFulfillments.push({ whName: wh.name, whInitial: initial, qty: deduct });
                        
                        if (!newFulfillmentInfo.warehouseInitials.includes(initial)) newFulfillmentInfo.warehouseInitials.push(initial);
                        if (!newFulfillmentInfo.warehouseNames.includes(wh.name)) newFulfillmentInfo.warehouseNames.push(wh.name);
                        
                        madeChanges = true;
                    }
                }
            }
            
            newFulfillmentInfo.itemsFulfillment[`${item.barcode}_${index}`] = currentItemFulfillments;
            if (remainingQty > 0) {
                stillOutOfStock = true;
            }
        });
        
        newFulfillmentInfo.isOutOfStock = stillOutOfStock;
        return { ...order, fulfillmentInfo: newFulfillmentInfo };
    });
    
    if (madeChanges) {
        return { ...db, orders: updatedOrders, products: currentDbProducts };
    }
    return db;
};
