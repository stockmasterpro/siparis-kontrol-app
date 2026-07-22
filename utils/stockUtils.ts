import { Variant, Warehouse } from '../types';

/**
 * Pazar yerlerine gönderilecek senkronize edilebilir (syncable) stok miktarını hesaplar.
 * Eğer varyant tamamen internet satışına kapatılmışsa (isMarketplaceDisabled) 0 döner.
 * Eğer belirli bir depo internet satışına kapatılmışsa (syncDisabled) o deponun stoğunu hesaplamaya dahil etmez.
 */
export const getSyncableStock = (variant: Variant, warehouses: Warehouse[]): number => {
  if (variant.isMarketplaceDisabled) {
    return 0;
  }
  
  if (!variant.stocks) return 0;

  return Object.entries(variant.stocks).reduce((total, [whId, quantity]) => {
    const wh = warehouses.find(w => w.id === whId);
    if (wh && wh.syncDisabled) {
      return total; // Exclude stock of this warehouse
    }
    return total + (Number(quantity) || 0);
  }, 0);
};

/**
 * Varyantın içerideki toplam gerçek stoğunu hesaplar (UI'da Envanter sütununda vs. göstermek için).
 * İnternet satışına kapalı depolar da bu toplama dahildir.
 */
export const getTotalStock = (variant: Variant): number => {
  if (!variant.stocks) return 0;
  return Object.values(variant.stocks).reduce<number>((a, b) => a + (Number(b) || 0), 0);
};

/**
 * Belirli bir API/Pazaryeri bağlantısına özel stok hesaplar.
 * Eğer o API özel bir depoya bağlıysa, sadece o deponun stoğunu döndürür.
 * (Bağlı deponun kendisi de syncDisabled kontrolüne tabidir).
 */
export const getSyncableStockForApi = (variant: Variant, apiConfig: any, warehouses: Warehouse[]): number => {
  if (variant.isMarketplaceDisabled) return 0;
  if (!variant.stocks) return 0;

  // API belirli bir depoya bağlıysa:
  if (apiConfig && apiConfig.linkedWarehouseId) {
    const whId = apiConfig.linkedWarehouseId;
    const wh = warehouses.find(w => w.id === whId);
    
    // Eğer depo bulunamadıysa veya internete kapalıysa 0 döndür
    if (!wh || wh.syncDisabled) {
      return 0;
    }
    
    return Number(variant.stocks[whId]) || 0;
  }

  // Aksi halde eski mantıkla (tüm açık depoların toplamı) dön:
  return getSyncableStock(variant, warehouses);
};
