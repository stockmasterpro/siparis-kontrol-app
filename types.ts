
export enum UserRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
}

export enum OrderStatus {
  NEW = 'Yeni Sipariş',
  PROCESSING = 'İşleme Alındı',
  SHIPPING = 'Taşıma Durumunda',
  DELIVERED = 'Teslim Edildi',
  CANCELLED = 'İptal Edildi',
}

export enum QuestionStatus {
  WAITING_FOR_ANSWER = 'WAITING_FOR_ANSWER',
  ANSWERED = 'ANSWERED',
  REJECTED = 'REJECTED',
}

export interface User {
  id: string;
  username: string;
  password: string; // In real app, hash this
  role: UserRole;
  name: string;
}

export interface Warehouse {
  id: string;
  name: string;
}

export interface Variant {
  id: string;
  color: string;
  size: string;
  barcode: string;
  arma?: string; // Arma alanı
  isMarketplaceDisabled?: boolean; // İnternet satışına kapalı mı?
  stocks: Record<string, number>; // warehouseId -> quantity
  images?: string[]; // Array of base64 strings or file paths
  mainImage?: string; // Ana görsel yolu
  costPrice?: number; // Varyant Maliyet Fiyatı
  salePrice?: number; // Varyant PSF Fiyatı
}

export interface Product {
  id: string;
  productCode: string;
  name: string;
  brand: string;
  group: string;
  costPrice: number; // Maliyet Fiyatı
  salePrice: number; // PSF (Perakende) Fiyatı
  date: string;
  variants: Variant[];
}

export interface OrderItem {
  orderItemId?: string; // Trendyol API order item ID
  barcode: string;
  productName: string;
  sku: string;
  color: string;
  size: string;
  productSize: string; // From marketplace API (e.g. Trendyol size)
  quantity: number;
  unitPrice: number; // PSF Fiyatı or API Sale Price
  costPrice?: number; // Added to track cost at time of sale
  totalPrice: number;
  vatRate?: number; // KDV Oranı
  commission?: number; // Komisyon Oranı
  lineGrossAmount?: number; // Brüt Fiyat (İndirimsiz)
  fullData?: any; // Satır bazlı ham veri
}

export interface Order {
  id: string;
  marketplaceOrderId: string;
  storeName: string; // From API config
  status: OrderStatus;
  customerName: string;
  customerPhone?: string; // New Field
  deliveryAddress?: string; // New Field
  cargoCode: string;
  orderDate: string;
  items: OrderItem[];
  cancelledItems?: OrderItem[]; // Track partially cancelled items
  isSuspended?: boolean; // If barcode not found in system
  isPrinted?: boolean; // Track if order has been printed
  wasSuspended?: boolean; // If order was previously suspended and resolved
  shipmentPackageId?: string; // Trendyol/Hepsiburada shipment package identifier
  countryCode?: string;
  city?: string; // İl
  district?: string; // İlçe
  neighborhood?: string; // Mahalle
  taxNumber?: string; // Vergi Numarası / T.C.
  taxOffice?: string; // Vergi Dairesi
  company?: string; // Şirket Adı
  invoiceAddress?: string; // Fatura Adresi (Tam metin)
  customerEmail?: string; // Müşteri E-posta
  isCommercial?: boolean; // Kurumsal Fatura mı?
  identityNumber?: string; // T.C. Kimlik No
  postalCode?: string; // Posta Kodu
  fullData?: any; // API'den gelen ham verinin tamamı (İleride lazım olursa diye)
}

export interface ReturnRecord {
  id: string;
  orderId: string;
  marketplaceOrderId: string;
  customerName: string;
  item: OrderItem;
  returnQuantity: number;
  returnDate: string;
  reason?: string;
}

export interface Question {
  id: string;
  text: string;
  answer?: string;
  status: QuestionStatus;
  userName: string;
  createdDate: string;
  productName: string;
  productImageUrl: string;
  productUrl?: string;
  storeName: string;
  marketplaceQuestionId: string;
  isPublic?: boolean;
  questionImageUrl?: string; // Müşterinin eklediği görsel
}

export interface ReturnClaim {
  id: string; // Internal ID
  claimId: string; // Marketplace Claim ID
  claimLineItemId?: string; // Marketplace Claim Line Item ID
  customerName: string;
  orderNumber: string;
  barcode: string;
  productName: string;
  productImageUrl: string;
  productUrl?: string;
  reason: string;
  description: string;
  status: string; // Claim/package status
  claimItemStatus?: string; // Line item status (Created, WaitingInAction, ...)
  returnQuantity: number;
  orderLineItemId?: string;
  cargoTrackingNumber?: string;
  color?: string;
  size?: string;
  storeName: string;
  claimDate: string;
}

export interface QuickAnswer {
  id: string;
  title: string;
  text: string;
}

export interface ApiConfig {
  id: string;
  storeName: string; // Acts as identifier
  type: 'TRENDYOL' | 'MANUAL';
  apiKey?: string;
  apiSecret?: string;
  supplierId?: string;
  mode?: 'LIVE' | 'TEST';
  enableStockSync?: boolean; // Stok gönderimi açık/kapalı
  isOrderSyncEnabled?: boolean; // Sipariş çekme açık/kapalı
  isQuestionSyncEnabled?: boolean; // Soru çekme açık/kapalı
  isReturnSyncEnabled?: boolean; // İade çekme açık/kapalı
  color?: string; // Dashboard için renk
}

export interface AppSettings {
  autoFetchIntervalMinutes: number;
  enableAutoStockSync: boolean; // New Setting
  enableAutoOrderFetch: boolean; // New Setting
  enableAutoProcessOrders: boolean; // Otomatik İşleme Al
  sessionTimeoutMinutes: number; // Oturum zaman aşımı (dakika)
  enableSessionTimeout: boolean; // Oturum zaman aşımı aktif/pasif
  orderFetchDays: number; // Sipariş çekme zaman aralığı (gün)
  stockSyncSettings: {
    enabled: boolean;
    minStockThreshold: number;
    maxStockToSend: number;
  };
  notifications?: {
    newOrderNotification: boolean;
    orderUpdateNotification: boolean;
    returnNotification: boolean; // New
    questionNotification: boolean; // New
    systemNotification: boolean;
    soundEnabled: boolean;
    windowsEnabled: boolean;
    orderSoundPath?: string;
    returnSoundPath?: string;
    questionSoundPath?: string;
    systemSoundPath?: string;
    updateSoundPath?: string;
  };
  printTemplate: {
    showOrderNo: boolean;
    showCargo: boolean;
    fontSize: number;
    barcodeFormat: 'CODE128' | 'QR';
  };
  requirePasswordLogin: boolean;
  aoiRequiresKey: boolean;
  showProductImages: boolean; // Ürün listesinde görsel sütunu gösterilsin mi?
  firstTimeSetup: boolean;
  licenseKey?: string; // NEW: Global license key
  lastTrialNotifyDate?: string; // NEW: To avoid multiple trial pings in one day
  productsPerPage?: number | 'all'; // Sayfa başına ürün sayısı ('all' veya sayı)
  showLowStockDetails?: boolean; // NEW: Ana sayfada stok detaylarını göster (Renk/Beden)
  allowNegativeStock?: boolean; // NEW: Stok sıfırın altına düşebilsin mi?
  enableOrderVisibilityLimit?: boolean; // NEW: Sipariş sayfası görünürlük kısıtlaması (2 gün vs)
  questionFetchIntervalMinutes: number; // New
  enableAutoQuestionFetch: boolean; // New
  returnFetchIntervalMinutes: number; // New
  enableAutoReturnFetch: boolean; // New
  quickAnswers: QuickAnswer[]; // New
  enableReturnExceptionReport: boolean; // Iade onayında bulunamayan kayıtlar için rapor indirilsin mi?
  columnWidths?: Record<string, number>; // NEW: Tablo sütun genişlikleri (kalıcılık için)
}

export interface Database {
  users: User[];
  currentUser: User | null;
  products: Product[];
  orders: Order[];
  returns: ReturnRecord[];
  apiConfigs: ApiConfig[];
  warehouses: Warehouse[];
  settings: AppSettings;
  trialStartDate?: string; // NEW: Track start of trial
  lastSeenDate?: string; // NEW: Track last known valid date for time-travel detection
  questions: Question[]; // New
  returnClaims: ReturnClaim[]; // New
}
