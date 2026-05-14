
import { Order } from '../types';

/** İki harf ISO ülke kodu (API bazen boşluk veya yanlış uzunluk gönderebilir) */
export function pickIsoCountryCode(value: unknown): string | undefined {
  const s = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s/g, '');
  if (s.length === 2 && /^[A-Z]{2}$/.test(s)) return s;
  return undefined;
}

const PHONE_PREFIX_TO_COUNTRY: [string, string][] = [
  ['966', 'SA'],
  ['971', 'AE'],
  ['974', 'QA'],
  ['965', 'KW'],
  ['968', 'OM'],
  ['973', 'BH'],
  ['994', 'AZ'],
  ['420', 'CZ'],
  ['421', 'SK'],
  ['40', 'RO'],
  ['359', 'BG'],
  ['380', 'UA'],
  ['30', 'GR'],
  ['90', 'TR']
].sort((a, b) => b[0].length - a[0].length);

export function inferCountryFromPhoneDigits(digits: string): string | undefined {
  const d = digits.replace(/\D/g, '');
  if (!d || d.length < 10) return undefined;
  const normalized = d.startsWith('00') ? d.slice(2) : d;
  for (const [prefix, code] of PHONE_PREFIX_TO_COUNTRY) {
    if (normalized.startsWith(prefix)) return code;
  }
  return undefined;
}

/** Mikro ihracat / yurt dışı aracılık: invoiceAddress çoğu zaman DSM İstanbul + TR (Trendyol dokümantasyonu) */
function isTrendyolCrossBorderHubInvoice(fd: any, inv: any): boolean {
  if (!inv && !fd) return false;
  if (fd?.micro === true || fd?.is4P === true || fd?.['3pByTrendyol'] === true) return true;
  const blob = `${inv?.fullAddress || ''} ${inv?.address1 || ''} ${inv?.company || ''}`.toUpperCase();
  return blob.includes('DSM') && (pickIsoCountryCode(inv?.countryCode) === 'TR' || !inv?.countryCode);
}

type CountryResolvePayload = {
  countryCode?: string;
  fullData?: any;
  customerPhone?: string;
  deliveryAddress?: string;
  invoiceAddress?: string;
};

/**
 * Ülke: Trendyol yanıtındaki countryCode alanları (öncelik sevkiyat adresi).
 * Mikro ihracat / is4P / 3pByTrendyol / DSM faturada invoice countryCode kullanılmaz.
 */
export function resolveCountryCodeFromPayload(p: CountryResolvePayload): string {
  const fd = p.fullData || {};
  const ship = fd.shipmentAddress;
  const inv = fd.invoiceAddress;
  const hubInvoice = isTrendyolCrossBorderHubInvoice(fd, inv);

  const rootCode = pickIsoCountryCode(fd.countryCode);
  const shipCode = pickIsoCountryCode(ship?.countryCode) || pickIsoCountryCode(ship?.country);
  const invCode = pickIsoCountryCode(inv?.countryCode) || pickIsoCountryCode(inv?.country);
  const stored = pickIsoCountryCode(p.countryCode);

  const firstLineCountryCode = (): string | undefined => {
    const lines = fd.lines;
    if (!Array.isArray(lines)) return undefined;
    for (const line of lines) {
      const c =
        pickIsoCountryCode(line?.shipmentAddress?.countryCode) ||
        pickIsoCountryCode(line?.countryCode) ||
        pickIsoCountryCode(line?.shipmentAddress?.country);
      if (c) return c;
    }
    return undefined;
  };

  const lineCode = firstLineCountryCode();

  // 1) Sevkiyat adresi (asıl müşteri ülkesi)
  if (shipCode && shipCode !== 'TR') return shipCode;
  // 2) Satır bazlı countryCode
  if (lineCode && lineCode !== 'TR') return lineCode;
  // 3) Paket kökü countryCode (API bazen buraya yazar)
  if (rootCode && rootCode !== 'TR') return rootCode;

  if (!hubInvoice) {
    if (shipCode) return shipCode;
    if (lineCode) return lineCode;
    if (rootCode) return rootCode;
    if (invCode) return invCode;
    if (stored) return stored;
  } else {
    if (shipCode) return shipCode;
    if (lineCode) return lineCode;
    if (rootCode) return rootCode;
    if (stored && stored !== 'TR') return stored;
  }

  const phone = String(p.customerPhone || fd.customerPhoneNumber || ship?.phone || inv?.phone || '').replace(/\D/g, '');
  const fromPhone = inferCountryFromPhoneDigits(phone);
  if (fromPhone) return fromPhone;

  if (!hubInvoice && invCode) return invCode;

  return shipCode || lineCode || rootCode || stored || 'TR';
}

export function resolveCargoCompanyFromTrendyolApi(api: any): string {
  if (!api || typeof api !== 'object') return '';
  const hist = Array.isArray(api.shipmentPackageHistories) ? api.shipmentPackageHistories[0] : null;
  const candidates = [
    api.cargoProviderName,
    api.cargoCompanyName,
    api.cargoCompany,
    api.lastMileCargoCompany,
    hist?.cargoCompanyName,
    hist?.cargoCompany,
    hist?.cargoProviderName
  ];
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (s) return s;
  }
  return '';
}

export function resolveCountryCodeFromTrendyolApi(apiOrder: any): string {
  return resolveCountryCodeFromPayload({
    countryCode: apiOrder?.countryCode,
    fullData: apiOrder,
    customerPhone: apiOrder?.customerPhoneNumber
  });
}

export function getEffectiveOrderCountryCode(order: Order): string {
  return resolveCountryCodeFromPayload({
    countryCode: order.countryCode,
    fullData: order.fullData,
    customerPhone: order.customerPhone,
    deliveryAddress: order.deliveryAddress,
    invoiceAddress: order.invoiceAddress
  });
}

export const COUNTRY_LIST = [
    { name: 'Almanya', code: 'DE' },
    { name: 'Amerika Birleşik Devletleri', code: 'US' },
    { name: 'Amerikan Samoası', code: 'AS' },
    { name: 'Amerikan Virgin Adaları', code: 'VI' },
    { name: 'Andorra', code: 'AD' },
    { name: 'Angola', code: 'AO' },
    { name: 'Anguilla', code: 'AI' },
    { name: 'Antigua Ve Barbuda', code: 'AG' },
    { name: 'Arjantin', code: 'AR' },
    { name: 'Arnavutluk', code: 'AL' },
    { name: 'Avustralya', code: 'AU' },
    { name: 'Avusturya', code: 'AT' },
    { name: 'Azerbaycan', code: 'AZ' },
    { name: 'Bahama Adaları', code: 'BS' },
    { name: 'Bahreyn', code: 'BH' },
    { name: 'Bangladeş', code: 'BD' },
    { name: 'Barbados', code: 'BB' },
    { name: 'Batı Samoa', code: 'WS' },
    { name: 'Belçika', code: 'BE' },
    { name: 'Belize', code: 'BZ' },
    { name: 'Benin', code: 'BJ' },
    { name: 'Bermuda', code: 'BM' },
    { name: 'Bhutan', code: 'BT' },
    { name: 'Birleşik Arap Emirlikleri', code: 'AE' },
    { name: 'Bolivya', code: 'BO' },
    { name: 'Bosna Hersek', code: 'BA' },
    { name: 'Botswana', code: 'BW' },
    { name: 'Brezilya', code: 'BR' },
    { name: 'Britanya Hint Okyanusu Bölgesi', code: 'IO' },
    { name: 'Brunei', code: 'BN' },
    { name: 'Bulgaristan', code: 'BG' },
    { name: 'Burkina Faso', code: 'BF' },
    { name: 'Burundi', code: 'BI' },
    { name: 'Cape Verde', code: 'CV' },
    { name: 'Cayman Adaları', code: 'KY' },
    { name: 'Cezayir', code: 'DZ' },
    { name: 'Christmas Adası', code: 'CX' },
    { name: 'Cibuti', code: 'DJ' },
    { name: 'Cocos (Keeling) Adaları', code: 'CC' },
    { name: 'Cook Adası', code: 'CK' },
    { name: 'Çad', code: 'TD' },
    { name: 'Çekya', code: 'CZ' },
    { name: 'Çin', code: 'CN' },
    { name: 'Danimarka', code: 'DK' },
    { name: 'Doğu Timor', code: 'TL' },
    { name: 'Dominik Cumhuriyeti', code: 'DO' },
    { name: 'Dominika', code: 'DM' },
    { name: 'Ekvador', code: 'EC' },
    { name: 'Ekvator Ginesi', code: 'GQ' },
    { name: 'El Salvador', code: 'SV' },
    { name: 'Endonezya', code: 'ID' },
    { name: 'Eritre', code: 'ER' },
    { name: 'Ermenistan', code: 'AM' },
    { name: 'Estonya', code: 'EE' },
    { name: 'Etiyopya', code: 'ET' },
    { name: 'Falkland Adaları', code: 'FK' },
    { name: 'Faroe Adaları', FO: 'FO' },
    { name: 'Fas', code: 'MA' },
    { name: 'Fiji', code: 'FJ' },
    { name: 'Fildişi Kıyısı', code: 'CI' },
    { name: 'Filipinler', code: 'PH' },
    { name: 'Finlandiya', code: 'FI' },
    { name: 'Fransa', code: 'FR' },
    { name: 'Fransız Polinezyası', code: 'PF' },
    { name: 'Gabon', code: 'GA' },
    { name: 'Gambiya', code: 'GM' },
    { name: 'Gana', code: 'GH' },
    { name: 'Gibraltar', code: 'GI' },
    { name: 'Gine', code: 'GN' },
    { name: 'Gine-Bissau', code: 'GW' },
    { name: 'Grenada', code: 'GD' },
    { name: 'Grönland', code: 'GL' },
    { name: 'Guam', code: 'GU' },
    { name: 'Guatemala', code: 'GT' },
    { name: 'Guyana', code: 'GY' },
    { name: 'Güney Afrika', code: 'ZA' },
    { name: 'Güney Georgia ve Güney Sandwich Adaları', code: 'GS' },
    { name: 'Güney Kıbrıs', code: 'CY' },
    { name: 'Güney Kore', code: 'KR' },
    { name: 'Gürcistan', code: 'GE' },
    { name: 'Haiti', code: 'HT' },
    { name: 'Hırvatistan', code: 'HR' },
    { name: 'Hindistan', code: 'IN' },
    { name: 'Hollanda', code: 'NL' },
    { name: 'Honduras', code: 'HN' },
    { name: 'Hong Kong', code: 'HK' },
    { name: 'Irak', code: 'IQ' },
    { name: 'İngiliz Virgin Adaları', code: 'VG' },
    { name: 'İngiltere', code: 'GB' },
    { name: 'İrlanda', code: 'IE' },
    { name: 'İspanya', code: 'ES' },
    { name: 'İsveç', code: 'SE' },
    { name: 'İsviçre', code: 'CH' },
    { name: 'İtalya', code: 'IT' },
    { name: 'İzlanda', code: 'IS' },
    { name: 'Jamaika', code: 'JM' },
    { name: 'Japonya', code: 'JP' },
    { name: 'Kamboçya', code: 'KH' },
    { name: 'Kamerun', code: 'CM' },
    { name: 'Kanada', code: 'CA' },
    { name: 'Karadağ', code: 'ME' },
    { name: 'Katar', code: 'QA' },
    { name: 'Kazakistan', code: 'KZ' },
    { name: 'Kenya', code: 'KE' },
    { name: 'Kırgızistan', code: 'KG' },
    { name: 'Kiribati', code: 'KI' },
    { name: 'Kolombiya', code: 'CO' },
    { name: 'Komorlar', code: 'KM' },
    { name: 'Kongo', code: 'CG' },
    { name: 'Kosta Rika', code: 'CR' },
    { name: 'Kuveyt', code: 'KW' },
    { name: 'Kuzey Kıbrıs Tc', code: 'KK' },
    { name: 'Kuzey Makedonya', code: 'MK' },
    { name: 'Kuzey Marina Adaları', code: 'MP' },
    { name: 'Laos', code: 'LA' },
    { name: 'Lesotho', code: 'LS' },
    { name: 'Letonya', code: 'LV' },
    { name: 'Liberya', code: 'LR' },
    { name: 'Liechtenstein', code: 'LI' },
    { name: 'Litvanya', code: 'LT' },
    { name: 'Lübnan', code: 'LB' },
    { name: 'Lüksemburg', code: 'LU' },
    { name: 'Macaristan', code: 'HU' },
    { name: 'Madagaskar', code: 'MG' },
    { name: 'Makao', code: 'MO' },
    { name: 'Malavi', code: 'MW' },
    { name: 'Maldiv Adaları', code: 'MV' },
    { name: 'Malezya', code: 'MY' },
    { name: 'Malta', code: 'MT' },
    { name: 'Marshall Adaları', code: 'MH' },
    { name: 'Mauritius', code: 'MU' },
    { name: 'Meksika', code: 'MX' },
    { name: 'Mıanmar', code: 'MM' },
    { name: 'Mısır', code: 'EG' },
    { name: 'Mikronezya Federal Devletleri', code: 'FM' },
    { name: 'Moğolistan', code: 'MN' },
    { name: 'Moldova Cumhuriyeti', code: 'MD' },
    { name: 'Montserrat', code: 'MS' },
    { name: 'Moritanya', code: 'MR' },
    { name: 'Mozambik', code: 'MZ' },
    { name: 'Namibia', code: 'NA' },
    { name: 'Nauru', code: 'NR' },
    { name: 'Nepal', code: 'NP' },
    { name: 'Nijer', code: 'NE' },
    { name: 'Nijerya', code: 'NG' },
    { name: 'Nikaragua', code: 'NI' },
    { name: 'Norfolk Adası', code: 'NF' },
    { name: 'Norveç', code: 'NO' },
    { name: 'Özbekistan', code: 'UZ' },
    { name: 'Pakistan', code: 'PK' },
    { name: 'Palau Adaları', code: 'PW' },
    { name: 'Panama', code: 'PA' },
    { name: 'Papua-Yeni Gine', code: 'PG' },
    { name: 'Paraguay', code: 'PY' },
    { name: 'Peru', code: 'PE' },
    { name: 'Polonya', code: 'PL' },
    { name: 'Portekiz', code: 'PT' },
    { name: 'Romanya', code: 'RO' },
    { name: 'Ruanda', code: 'RW' },
    { name: 'Saint Helena', code: 'SH' },
    { name: 'Saint Pierre and Miquelon', code: 'PM' },
    { name: 'San Marino', code: 'SM' },
    { name: 'Santa Kitts Ve Nevis', code: 'KN' },
    { name: 'Santa Lucia', code: 'LC' },
    { name: 'Santa Vincent Ve Grenadines', code: 'VC' },
    { name: 'Sao Tome', code: 'ST' },
    { name: 'Senegal', code: 'SN' },
    { name: 'Seyşeller', code: 'SC' },
    { name: 'Sırbistan', code: 'XS' },
    { name: 'Sierra Leone', code: 'SL' },
    { name: 'Singapur', code: 'SG' },
    { name: 'Slovakya', code: 'SK' },
    { name: 'Slovenya', code: 'SI' },
    { name: 'Solomon Adalary', code: 'SB' },
    { name: 'Sri Lanka', code: 'LK' },
    { name: 'Surinam', code: 'SR' },
    { name: 'Suudi Arabistan', code: 'SA' },
    { name: 'Svaziland', code: 'SZ' },
    { name: 'Şili', code: 'CL' },
    { name: 'Tacikistan', code: 'TJ' },
    { name: 'Tanzanya', code: 'TZ' },
    { name: 'Tayland', code: 'TH' },
    { name: 'Tayvan', code: 'TW' },
    { name: 'Togo', code: 'TG' },
    { name: 'Tonga', code: 'TO' },
    { name: 'Trinidad Ve Tobago', code: 'TT' },
    { name: 'Tunus', code: 'TN' },
    { name: 'Tuvalu', code: 'TV' },
    { name: 'Türkiye', code: 'TR' },
    { name: 'Türkmenistan', code: 'TM' },
    { name: 'Uganda', code: 'UG' },
    { name: 'Ukrayna', code: 'UA' },
    { name: 'Umman', code: 'OM' },
    { name: 'Uruguay', code: 'UY' },
    { name: 'Ürdün', code: 'JO' },
    { name: 'Vanuatu', code: 'VU' },
    { name: 'Vatikan', code: 'VA' },
    { name: 'Vietnam', code: 'VN' },
    { name: 'Yeni Kaledonya', code: 'NC' },
    { name: 'Yeni Zelanda', code: 'NZ' },
    { name: 'Yunanistan', code: 'GR' },
    { name: 'Zambiya', code: 'ZM' }
];

export const isInternationalOrder = (order: Partial<Order>) => {
    return getEffectiveOrderCountryCode(order as Order) !== 'TR';
};
