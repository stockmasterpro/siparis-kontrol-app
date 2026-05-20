
import React, { useState, useMemo, useEffect } from 'react';
import { Database, OrderStatus } from '../types';
import { getEffectiveOrderCountryCode } from '../utils/orderUtils';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line } from 'recharts';
import { Download, X, Check, Filter, ChevronDown } from 'lucide-react';
import * as XLSX from 'xlsx';



interface DashboardProps {
  db: Database;
}

const getLocalMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const Dashboard: React.FC<DashboardProps> = ({ db }) => {
  const [selectedMonth, setSelectedMonth] = useState<string>(getLocalMonth());
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [reportStartDate, setReportStartDate] = useState('');
  const [reportEndDate, setReportEndDate] = useState('');
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [isCountryDropdownOpen, setIsCountryDropdownOpen] = useState(false);
  const [showAllPriority, setShowAllPriority] = useState(false);
  const [trendMonthCount, setTrendMonthCount] = useState(6);

  const PRIORITY_COUNTRIES = [
    { name: 'Türkiye', code: 'TR' },
    { name: 'Suudi Arabistan', code: 'SA' },
    { name: 'Romanya', code: 'RO' },
    { name: 'Yunanistan', code: 'GR' },
    { name: 'Azerbaycan', code: 'AZ' },
    { name: 'B.A.E.', code: 'AE' },
    { name: 'Katar', code: 'QA' },
    { name: 'Kuveyt', code: 'KW' },
    { name: 'Umman', code: 'OM' },
    { name: 'Bulgaristan', code: 'BG' },
    { name: 'Moldova', code: 'MD' },
    { name: 'Sırbistan', code: 'RS' },
    { name: 'Ukrayna', code: 'UA' }
  ];

  // Initialize selectedCountries once
  useEffect(() => {
    // Default: Hepsi seçili değil (Filtre yok = Hepsi) 
    // Ama kullanıcı "Tümünü Seç/Kaldır" istediği için başlangıçta boş veya hepsi olabilir.
    // Kullanıcının "varsayılan hepsi seçili kaldır" talebine göre: 
    // Muhtemelen boş bırakıp "Boş = Hepsi" yapmak yerine, tam tersi kontrol sağlamak istiyor.
    // Ben başlangıçta PRİORİTY + olanları seçili getireceğim.
  }, []);

  const validBarcodesSet = useMemo(() => {
    const barcodes = new Set<string>();
    db.products.forEach(p => {
      if (p.variants) {
        p.variants.forEach(v => {
          if (v.barcode) {
            barcodes.add(v.barcode);
          }
        });
      }
    });
    return barcodes;
  }, [db.products]);

  const totalProducts = db.products.length;

  // --- Ay Bazlı Filtreleme ---
  const filteredOrders = useMemo(() => {
    let baseOrders = db.orders.filter(o => {
      if (o.isSuspended || o.status === OrderStatus.CANCELLED) return false;
      // Barkodları tanımlı mı kontrolü
      return o.items.every(item => item.barcode && item.barcode !== 'NO-BARCODE' && validBarcodesSet.has(item.barcode));
    });

    // Ülke: yalnızca API'den türetilen countryCode (fullData dahil)
    if (selectedCountries.length > 0) {
      baseOrders = baseOrders.filter(o => {
        const codeUpper = getEffectiveOrderCountryCode(o).toUpperCase();
        return selectedCountries.some(code => codeUpper === code.toUpperCase());
      });
    }

    if (!selectedMonth) return baseOrders;

    const [year, month] = selectedMonth.split('-');
    let filtered = baseOrders.filter(o => {
      const d = new Date(o.orderDate);
      return d.getFullYear() === parseInt(year) && (d.getMonth() + 1) === parseInt(month);
    });

    return filtered;
  }, [db.orders, selectedMonth, selectedCountries, validBarcodesSet]);

  const filteredReturns = useMemo(() => {
    let baseReturns = db.returns;

    if (selectedCountries.length > 0) {
      baseReturns = baseReturns.filter(r => {
        const order = db.orders.find(o => o.id === r.orderId);
        if (!order) return false;
        const codeUpper = getEffectiveOrderCountryCode(order).toUpperCase();
        return selectedCountries.some(code => codeUpper === code.toUpperCase());
      });
    }

    if (!selectedMonth) return baseReturns;
    const [year, month] = selectedMonth.split('-');

    return baseReturns.filter(r => {
      const d = new Date(r.returnDate);
      return d.getFullYear() === parseInt(year) && (d.getMonth() + 1) === parseInt(month);
    });
  }, [db.returns, db.orders, selectedMonth, selectedCountries]);

  // GLOBAL STATS (Filtered by month)
  const totalOrders = filteredOrders.length;
  const pendingOrders = filteredOrders.filter(o => o.status === OrderStatus.NEW).length;

  const grossRevenue = useMemo(() => {
    return filteredOrders
      .filter(o => o.status !== OrderStatus.CANCELLED)
      .reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.totalPrice, 0), 0);
  }, [filteredOrders]);

  const totalReturnsValue = useMemo(() => {
    return filteredOrders.reduce((total, order) => {
      const linkedReturns = db.returns.filter(r => r.orderId === order.id);
      return total + linkedReturns.reduce((sum, r) => sum + (r.item.unitPrice * r.returnQuantity), 0);
    }, 0);
  }, [filteredOrders, db.returns]);

  const totalRevenue = grossRevenue - totalReturnsValue;

  // --- Günlük İstatistik Hesaplama Yardımcısı ---
  const getStatsForDate = (dateStr: string, orders: typeof filteredOrders) => {
    const dayOrders = orders.filter(o => {
      if (o.status === OrderStatus.CANCELLED) return false;
      const d = new Date(o.orderDate);
      const localDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return localDateStr === dateStr;
    });

    const dailyGross = dayOrders.reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.totalPrice, 0), 0);

    const dailyReturns = dayOrders.reduce((total, order) => {
      const linkedReturns = db.returns.filter(r => r.orderId === order.id);
      return total + linkedReturns.reduce((sum, r) => sum + (r.item.unitPrice * r.returnQuantity), 0);
    }, 0);

    return {
      revenue: dailyGross - dailyReturns,
      count: dayOrders.length
    };
  };

  const { todayStats, yesterdayStats } = useMemo(() => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const yesterdayNode = new Date(now);
    yesterdayNode.setDate(yesterdayNode.getDate() - 1);
    const yesterdayStr = `${yesterdayNode.getFullYear()}-${String(yesterdayNode.getMonth() + 1).padStart(2, '0')}-${String(yesterdayNode.getDate()).padStart(2, '0')}`;

    return {
      todayStats: getStatsForDate(todayStr, filteredOrders),
      yesterdayStats: getStatsForDate(yesterdayStr, filteredOrders)
    };
  }, [filteredOrders, db.returns]);

  const todayRevenue = todayStats.revenue;
  const yesterdayRevenue = yesterdayStats.revenue;
  const todayCount = todayStats.count;
  const yesterdayCount = yesterdayStats.count;

  // --- Mağaza Bazlı Analiz (Filtreli) ---
  const storeAnalytics = useMemo(() => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const yesterdayNode = new Date(now);
    yesterdayNode.setDate(yesterdayNode.getDate() - 1);
    const yesterdayStr = `${yesterdayNode.getFullYear()}-${String(yesterdayNode.getMonth() + 1).padStart(2, '0')}-${String(yesterdayNode.getDate()).padStart(2, '0')}`;

    return db.apiConfigs.map(config => {
      const storeOrders = filteredOrders.filter(o => o.storeName === config.storeName);
      const storePendingOrders = storeOrders.filter(o => o.status === OrderStatus.NEW).length;

      const storeGrossRevenue = storeOrders
        .filter(o => o.status !== OrderStatus.CANCELLED)
        .reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.totalPrice, 0), 0);

      const storeOrderIds = new Set(storeOrders.map(o => o.id));
      const linkedReturns = db.returns.filter(r => storeOrderIds.has(r.orderId));
      const storeReturnsValue = linkedReturns.reduce((acc, r) => acc + (r.item.unitPrice * r.returnQuantity), 0);

      const tStats = getStatsForDate(todayStr, storeOrders);
      const yStats = getStatsForDate(yesterdayStr, storeOrders);

      return {
        storeName: config.storeName,
        totalOrders: storeOrders.length,
        pendingOrders: storePendingOrders,
        revenue: storeGrossRevenue - storeReturnsValue,
        todayRevenue: tStats.revenue,
        yesterdayRevenue: yStats.revenue,
        todayCount: tStats.count,
        yesterdayCount: yStats.count
      };
    });
  }, [db.apiConfigs, filteredOrders, db.returns]);

  // --- Real Data Aggregation ---
  // 1. Günlük Satış Özeti (Dinamik)
  const chartDays = useMemo(() => {
    if (selectedMonth) {
      const [year, month] = selectedMonth.split('-');
      const y = parseInt(year);
      const m = parseInt(month) - 1;
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      return Array.from({ length: daysInMonth }, (_, i) => {
        return `${y}-${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
      });
    } else {
      const days = [];
      const today = new Date();
      for (let i = 14; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      }
      return days;
    }
  }, [selectedMonth]);

  const dailyChartData = useMemo(() => {
    return chartDays.map(dateStr => {
      const dateObj = new Date(dateStr);
      const dayName = selectedMonth
        ? dateStr.split('-')[2]
        : dateObj.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });

      const dayData: any = { name: dayName, date: dateStr };

      db.apiConfigs.forEach(config => {
        const dayOrders = db.orders.filter(o => {
          if (o.isSuspended || o.storeName !== config.storeName || o.status === OrderStatus.CANCELLED) return false;

          // Barkodları tanımlı mı kontrolü
          const allBarcodesExist = o.items.every(item =>
            item.barcode && item.barcode !== 'NO-BARCODE' && validBarcodesSet.has(item.barcode)
          );
          if (!allBarcodesExist) return false;

          // Apply Country Filter
          if (selectedCountries.length > 0) {
            const codeUpper = getEffectiveOrderCountryCode(o).toUpperCase();
            const isMatch = selectedCountries.some(code => codeUpper === code.toUpperCase());
            if (!isMatch) return false;
          }

          const d = new Date(o.orderDate);
          const localDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          return localDateStr === dateStr;
        });

        const dailyGross = dayOrders.reduce((acc, o) => acc + o.items.reduce((sum, i) => sum + i.totalPrice, 0), 0);
        const dayOrderIds = new Set(dayOrders.map(o => o.id));
        const linkedReturns = db.returns.filter(r => dayOrderIds.has(r.orderId));
        const dailyReturnsDeduction = linkedReturns.reduce((acc, r) => acc + (r.item.unitPrice * r.returnQuantity), 0);

        dayData[config.storeName] = dailyGross - dailyReturnsDeduction;
      });

      return dayData;
    });
  }, [chartDays, db.orders, db.apiConfigs, db.returns, selectedMonth, selectedCountries, validBarcodesSet]);

  const chartMonths = useMemo(() => {
    const months = [];
    let referenceDate = new Date();
    if (selectedMonth) {
      const [year, month] = selectedMonth.split('-');
      referenceDate = new Date(parseInt(year), parseInt(month) - 1, 1);
    }

    for (let i = trendMonthCount - 1; i >= 0; i--) {
      const d = new Date(referenceDate);
      d.setMonth(d.getMonth() - i);
      const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const monthName = d.toLocaleDateString('tr-TR', { month: 'short', year: 'numeric' });
      months.push({ yearMonth, monthName });
    }
    return months;
  }, [selectedMonth, trendMonthCount]);

  const monthlyTrendData = useMemo(() => {
    return chartMonths.map(month => {
      const monthData: any = { name: month.monthName };

      db.apiConfigs.forEach(config => {
        const monthOrders = db.orders.filter(o => {
          if (o.isSuspended || o.storeName !== config.storeName || o.status === OrderStatus.CANCELLED) return false;

          // Barkodları tanımlı mı kontrolü
          const allBarcodesExist = o.items.every(item =>
            item.barcode && item.barcode !== 'NO-BARCODE' && validBarcodesSet.has(item.barcode)
          );
          if (!allBarcodesExist) return false;

          // Apply Country Filter
          if (selectedCountries.length > 0) {
            const codeUpper = getEffectiveOrderCountryCode(o).toUpperCase();
            const isMatch = selectedCountries.some(code => codeUpper === code.toUpperCase());
            if (!isMatch) return false;
          }

          const d = new Date(o.orderDate);
          const yM = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          return yM === month.yearMonth;
        });

        const monthlyGross = monthOrders.reduce((acc, o) => acc + o.items.reduce((sum, i) => sum + i.totalPrice, 0), 0);
        const monthOrderIds = new Set(monthOrders.map(o => o.id));
        const linkedReturns = db.returns.filter(r => monthOrderIds.has(r.orderId));
        const monthlyReturnsDeduction = linkedReturns.reduce((acc, r) => acc + (r.item.unitPrice * r.returnQuantity), 0);

        monthData[config.storeName] = monthlyGross - monthlyReturnsDeduction;
      });

      return monthData;
    });
  }, [chartMonths, db.orders, db.apiConfigs, db.returns, selectedCountries, validBarcodesSet]);

  // --- Ay Seçenekleri ---
  const getMonthOptions = () => {
    const months = [];
    const currentDate = new Date();
    const startDate = db.trialStartDate ? new Date(db.trialStartDate) : new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
    let rollingDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);

    while (rollingDate >= new Date(startDate.getFullYear(), startDate.getMonth(), 1)) {
      const yearMonth = `${rollingDate.getFullYear()}-${String(rollingDate.getMonth() + 1).padStart(2, '0')}`;
      const monthName = rollingDate.toLocaleDateString('tr-TR', { year: 'numeric', month: 'long' });
      months.push({ value: yearMonth, label: monthName });
      rollingDate.setMonth(rollingDate.getMonth() - 1);
      if (months.length > 60) break;
    }
    return months;
  };

  // --- Stok Azalma Analizi ---
  const criticalStockProducts = useMemo(() => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentOrders = db.orders.filter(o => {
      if (o.isSuspended || o.status === OrderStatus.CANCELLED) return false;
      if (new Date(o.orderDate) < thirtyDaysAgo) return false;

      // Barkodları tanımlı mı kontrolü
      return o.items.every(item => item.barcode && item.barcode !== 'NO-BARCODE' && validBarcodesSet.has(item.barcode));
    });

    const productSales: { [barcode: string]: number } = {};
    recentOrders.forEach(order => {
      order.items.forEach(item => {
        if (item.barcode && item.barcode !== 'NO-BARCODE') {
          productSales[item.barcode] = (productSales[item.barcode] || 0) + item.quantity;
        }
      });
    });

    const getVariantStock = (v: any): number => {
      if (!v.stocks) return 0;
      return Object.values(v.stocks).reduce<number>((a, b) => a + (Number(b) || 0), 0);
    };

    const criticalItems: any[] = [];
    db.products.forEach(product => {
      product.variants.forEach(variant => {
        const stock = getVariantStock(variant);
        const sales = productSales[variant.barcode] || 0;
        if (stock < sales && (stock > 0 || sales > 0)) {
          criticalItems.push({
            id: variant.id,
            productCode: product.productCode,
            name: product.name,
            variantName: `${variant.color}/${variant.size}`,
            barcode: variant.barcode,
            stock,
            sales,
            depletionRate: (sales / 30).toFixed(1),
            daysOfStock: sales > 0 ? Math.floor(stock / (sales / 30)) : Infinity
          });
        }
      });
    });

    return criticalItems.sort((a, b) => a.daysOfStock - b.daysOfStock).slice(0, 15);
  }, [db.orders, db.products, validBarcodesSet]);

  // --- Rapor Oluşturma ---
  const generateExcelReport = () => {
    if (!reportStartDate || !reportEndDate) {
      alert("Lütfen başlangıç ve bitiş tarihlerini seçin.");
      return;
    }

    const start = new Date(reportStartDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(reportEndDate);
    end.setHours(23, 59, 59, 999);

    if (start > end) {
      alert("Başlangıç tarihi bitiş tarihinden büyük olamaz.");
      return;
    }

    const reportOrders = db.orders.filter(o => {
      if (o.isSuspended || o.status === OrderStatus.CANCELLED) return false;
      
      // Barkodları tanımlı mı kontrolü
      const allBarcodesExist = o.items.every(item =>
        item.barcode && item.barcode !== 'NO-BARCODE' && validBarcodesSet.has(item.barcode)
      );
      if (!allBarcodesExist) return false;

      const orderDate = new Date(o.orderDate);
      const isDateMatch = orderDate >= start && orderDate <= end;
      if (!isDateMatch) return false;

      // Apply active country filters if any
      if (selectedCountries.length > 0) {
        const codeUpper = getEffectiveOrderCountryCode(o).toUpperCase();
        return selectedCountries.some(code => codeUpper === code.toUpperCase());
      }
      return true;
    });

    if (reportOrders.length === 0) {
      alert("Seçilen tarih aralığında ve filtrelerde satış/sipariş bulunamadı.");
      return;
    }

    const groupedData: Record<string, any> = {};
    const cList = [
      { name: 'Almanya', code: 'DE' },
      { name: 'Suudi Arabistan', code: 'SA' },
      { name: 'Romanya', code: 'RO' },
      { name: 'Yunanistan', code: 'GR' },
      { name: 'Azerbaycan', code: 'AZ' },
      { name: 'B.A.E.', code: 'AE' },
      { name: 'Katar', code: 'QA' },
      { name: 'Kuveyt', code: 'KW' },
      { name: 'Umman', code: 'OM' },
      { name: 'Bulgaristan', code: 'BG' },
      { name: 'Moldova', code: 'MD' },
      { name: 'Sırbistan', code: 'RS' },
      { name: 'Ukrayna', code: 'UA' },
      { name: 'Türkiye', code: 'TR' }
    ];

    reportOrders.forEach(order => {
      const countryCode = getEffectiveOrderCountryCode(order);
      const countryName = cList.find(c => c.code === countryCode)?.name || countryCode;

      order.items.forEach(item => {
        // Group by Store, Country and Barcode
        const key = `${order.storeName}_${countryCode}_${item.barcode}`;
        if (!groupedData[key]) {
          groupedData[key] = {
            'Mağaza': order.storeName,
            'Ülke': countryName,
            'Ürün Adı': item.productName,
            'Barkod': item.barcode,
            'Renk': item.color || '-',
            'Beden': item.size || '-',
            'Toplam Adet': 0,
            'Toplam Ciro': 0
          };
        }
        groupedData[key]['Toplam Adet'] += item.quantity;
        groupedData[key]['Toplam Ciro'] += item.totalPrice;
      });
    });

    const worksheet = XLSX.utils.json_to_sheet(Object.values(groupedData));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Satış Raporu");
    XLSX.writeFile(workbook, `Satis_Raporu_Ozet.xlsx`);
    setIsReportModalOpen(false);
  };

  // --- Ülke Bazlı Analiz ---
  const countryAnalytics = useMemo(() => {
    const stats: Record<string, { code: string, name: string, count: number, revenue: number }> = {};
    const cList = [
      { name: 'Almanya', code: 'DE' },
      { name: 'Suudi Arabistan', code: 'SA' },
      { name: 'Romanya', code: 'RO' },
      { name: 'Yunanistan', code: 'GR' },
      { name: 'Azerbaycan', code: 'AZ' },
      { name: 'B.A.E.', code: 'AE' },
      { name: 'Katar', code: 'QA' },
      { name: 'Kuveyt', code: 'KW' },
      { name: 'Umman', code: 'OM' },
      { name: 'Bulgaristan', code: 'BG' },
      { name: 'Moldova', code: 'MD' },
      { name: 'Sırbistan', code: 'RS' },
      { name: 'Ukrayna', code: 'UA' },
      { name: 'Türkiye', code: 'TR' }
    ];

    filteredOrders.forEach(order => {
      const code = getEffectiveOrderCountryCode(order);
      if (!stats[code]) {
        const countryName = cList.find(c => c.code === code)?.name || code;
        stats[code] = { code, name: countryName, count: 0, revenue: 0 };
      }
      stats[code].count += 1;
      stats[code].revenue += order.items.reduce((sum, item) => sum + item.totalPrice, 0);
    });

    return Object.values(stats).sort((a, b) => b.revenue - a.revenue);
  }, [filteredOrders]);

  return (
    <div className="space-y-6">
      {/* Ay Filtresi */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
        <div className="flex items-center gap-4">
          <label className="text-gray-700 font-medium">Ay Seçin:</label>
          <select
            className="border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
          >
            <option value="">Tüm Zamanlar</option>
            {getMonthOptions().map(month => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>
          {selectedMonth && (
            <button
              className="text-blue-600 hover:text-blue-800 text-sm"
              onClick={() => setSelectedMonth('')}
            >
              Filtreyi Temizle
            </button>
          )}

          <div className="flex-1"></div>

          {/* Ülkeler Çoklu Seçim Dropdown */}
          <div className="relative">
            <button
              onClick={() => setIsCountryDropdownOpen(!isCountryDropdownOpen)}
              className={`flex items-center gap-2 px-4 py-2 border rounded font-medium transition-all ${selectedCountries.length > 0 ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}
            >
              <Filter size={18} className={selectedCountries.length > 0 ? 'text-blue-500' : 'text-gray-400'} />
              <span>Ülkeler {selectedCountries.length > 0 ? `(${selectedCountries.length})` : '(Tümü)'}</span>
              <ChevronDown size={16} className={`transition-transform ${isCountryDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {isCountryDropdownOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsCountryDropdownOpen(false)}></div>
                <div className="absolute right-0 mt-2 w-72 bg-white rounded-xl shadow-2xl border border-gray-200 z-50 overflow-hidden animate-in fade-in zoom-in duration-200">
                  <div className="p-3 bg-gray-50 border-b border-gray-100 flex justify-between items-center">
                    <span className="text-xs font-bold text-gray-500 uppercase">Ülke Seçimi</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          const allCodes = Array.from(new Set([
                            ...PRIORITY_COUNTRIES.map(c => c.code),
                            ...db.orders.map(o => getEffectiveOrderCountryCode(o)).filter(c => c && c !== 'TR')
                          ]));
                          setSelectedCountries(allCodes as string[]);
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
                  </div>
                  <div className="max-h-80 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                    {/* Priority Countries */}
                    {PRIORITY_COUNTRIES.map(country => (
                      <label key={country.code} className="flex items-center gap-3 p-2 hover:bg-blue-50 rounded-lg cursor-pointer transition-colors group">
                        <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${selectedCountries.includes(country.code) ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300 group-hover:border-blue-400'}`}>
                          {selectedCountries.includes(country.code) && <Check size={12} className="text-white" strokeWidth={4} />}
                        </div>
                        <input
                          type="checkbox"
                          className="hidden"
                          checked={selectedCountries.includes(country.code)}
                          onChange={() => {
                            if (selectedCountries.includes(country.code)) {
                              setSelectedCountries(selectedCountries.filter(c => c !== country.code));
                            } else {
                              setSelectedCountries([...selectedCountries, country.code]);
                            }
                          }}
                        />
                        <span className={`text-sm ${selectedCountries.includes(country.code) ? 'text-blue-700 font-semibold' : 'text-gray-700'}`}>
                          {country.name}
                        </span>
                        {country.code === 'TR' && <span className="ml-auto text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded">Yerel</span>}
                      </label>
                    ))}

                    {/* Diğer Ülkeler */}
                    {db.orders
                      .map(o => getEffectiveOrderCountryCode(o))
                      .filter((c, i, a) => c && c !== 'TR' && !PRIORITY_COUNTRIES.some(p => p.code === c) && a.indexOf(c) === i)
                      .map(code => (
                        <label key={code} className="flex items-center gap-3 p-2 hover:bg-blue-50 rounded-lg cursor-pointer transition-colors group">
                          <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${selectedCountries.includes(code!) ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300 group-hover:border-blue-400'}`}>
                            {selectedCountries.includes(code!) && <Check size={12} className="text-white" strokeWidth={4} />}
                          </div>
                          <input
                            type="checkbox"
                            className="hidden"
                            checked={selectedCountries.includes(code!)}
                            onChange={() => {
                              if (selectedCountries.includes(code!)) {
                                setSelectedCountries(selectedCountries.filter(c => c !== code));
                              } else {
                                setSelectedCountries([...selectedCountries, code!]);
                              }
                            }}
                          />
                          <span className={`text-sm ${selectedCountries.includes(code!) ? 'text-blue-700 font-semibold' : 'text-gray-700'}`}>
                            {code}
                          </span>
                        </label>
                      ))
                    }
                  </div>
                </div>
              </>
            )}
          </div>

          <button
            onClick={() => setIsReportModalOpen(true)}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded font-medium transition-colors"
          >
            <Download size={18} /> Excel Raporu Al
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-gray-500 text-sm font-medium">Toplam Ürün</h3>
          <p className="text-3xl font-bold text-gray-800 mt-2">{totalProducts}</p>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-gray-500 text-sm font-medium">Toplam Sipariş</h3>
          <p className="text-3xl font-bold text-gray-800 mt-2">{totalOrders}</p>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-gray-500 text-sm font-medium">Bekleyen Sipariş</h3>
          <p className="text-3xl font-bold text-orange-600 mt-2">{pendingOrders}</p>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-gray-500 text-sm font-medium">Net Ciro</h3>
          <p className="text-3xl font-bold text-green-600 mt-2">{totalRevenue.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ₺</p>
          <div className="mt-4 flex flex-col gap-1 text-sm border-t pt-3">
            <div className="flex justify-between">
              <span className="text-gray-500">Bugün:</span>
              <span className="font-semibold text-green-600">{todayRevenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Dün:</span>
              <span className="font-semibold text-green-600">{yesterdayRevenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
            </div>
          </div>
        </div>
      </div>

      {/* Mağaza Bazlı İstatistikler */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {storeAnalytics.map((store, index) => (
          <div key={store.storeName} className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
            <h3 className="text-lg font-bold text-gray-800 mb-4">{store.storeName}</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-gray-600 text-sm">Toplam Sipariş</span>
                <span className="font-semibold text-blue-600">{store.totalOrders}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600 text-sm">Bekleyen Sipariş</span>
                <span className="font-semibold text-orange-500">{store.pendingOrders}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600 text-sm">Ciro</span>
                <span className="font-semibold text-green-600">{store.revenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 text-sm border-t pt-3">
              <div className="flex justify-between items-center text-xs opacity-80">
                <span className="text-gray-500 italic">Bugünkü Sipariş</span>
                <span className="font-bold text-gray-700">{store.todayCount} Adet</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Bugünkü Ciro</span>
                <span className="font-semibold text-green-600">{store.todayRevenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
              </div>
              <div className="h-px bg-gray-100 my-1"></div>
              <div className="flex justify-between items-center text-xs opacity-80">
                <span className="text-gray-500 italic">Dünkü Sipariş</span>
                <span className="font-bold text-gray-700">{store.yesterdayCount} Adet</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Dünkü Ciro</span>
                <span className="font-semibold text-green-600">{store.yesterdayRevenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 h-96">
          <h3 className="text-lg font-bold text-gray-800 mb-4">Günlük Satış Tablosu</h3>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dailyChartData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip formatter={(value) => `${Number(value).toLocaleString('tr-TR')} ₺`} />
              <Legend />
              {db.apiConfigs.map((config, index) => {
                const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
                const color = config.color || colors[index % colors.length];
                return (
                  <Bar
                    key={config.storeName}
                    dataKey={config.storeName}
                    name={config.storeName}
                    fill={color}
                    radius={[4, 4, 0, 0]}
                  />
                );
              })}
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 h-96">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-bold text-gray-800">Aylık Ciro Trendi</h3>
            <div className="flex bg-gray-100 p-1 rounded-lg">
              <button
                onClick={() => setTrendMonthCount(6)}
                className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${trendMonthCount === 6 ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                6 Ay
              </button>
              <button
                onClick={() => setTrendMonthCount(12)}
                className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${trendMonthCount === 12 ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                12 Ay
              </button>
            </div>
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={monthlyTrendData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip formatter={(value) => `${Number(value).toLocaleString('tr-TR')} ₺`} />
              <Legend />
              {db.apiConfigs.map((config, index) => {
                const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
                const color = config.color || colors[index % colors.length];
                return (
                  <Line
                    key={config.storeName}
                    type="monotone"
                    dataKey={config.storeName}
                    name={config.storeName}
                    stroke={color}
                    strokeWidth={2}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Ülke Bazlı Satış Dağılımı */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        <h3 className="text-lg font-bold text-gray-800 mb-4">Ülke Bazlı Satış Dağılımı</h3>
        {countryAnalytics.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-gray-500 text-sm border-b">
                  <th className="pb-3 font-medium">Ülke</th>
                  <th className="pb-3 font-medium">Sipariş</th>
                  <th className="pb-3 font-medium">Ciro</th>
                  <th className="pb-3 font-medium text-right">Pay</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {countryAnalytics.map((country) => (
                  <tr key={country.code} className="group hover:bg-gray-50 transition-colors">
                    <td className="py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-xs">
                          {country.code}
                        </div>
                        <span className="font-medium text-gray-700">{country.name}</span>
                      </div>
                    </td>
                    <td className="py-3 text-gray-600">{country.count} Adet</td>
                    <td className="py-3 font-semibold text-green-600">{country.revenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</td>
                    <td className="py-3 text-right">
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-xs font-bold text-gray-400">
                          {((country.revenue / (grossRevenue || 1)) * 100).toFixed(1)}%
                        </span>
                        <div className="w-24 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                          <div 
                            className="bg-blue-500 h-full rounded-full" 
                            style={{ width: `${(country.revenue / (grossRevenue || 1)) * 100}%` }}
                          ></div>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-gray-400">
            Veri bulunamadı.
          </div>
        )}
      </div>

      {/* Stok Azalma Uyarısı */}
      <div className={`rounded-xl p-6 ${criticalStockProducts.length > 0 ? 'bg-red-50 border border-red-200' : 'bg-green-50 border border-green-200'}`}>
        <div className="flex items-center gap-2 mb-4">
          <div className={`w-3 h-3 rounded-full ${criticalStockProducts.length > 0 ? 'bg-red-500 animate-pulse' : 'bg-green-500'}`}></div>
          <h3 className={`text-lg font-bold ${criticalStockProducts.length > 0 ? 'text-red-800' : 'text-green-800'}`}>
            {criticalStockProducts.length > 0 ? '⚠️ Stok Azalma Uyarısı' : '✅ Stok Durumu İyi'}
          </h3>
        </div>

        {criticalStockProducts.length > 0 ? (
          <>
            <p className="text-red-700 text-sm mb-4">
              Aşağıdaki ürünlerin stokları son 30 gündeki satış hızına göre kritik seviyede. Stok takibi yapılmalıdır.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {criticalStockProducts.map((p, idx) => (
                <div key={idx} className="flex flex-col p-3 bg-white rounded-lg border border-red-100 shadow-sm">
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <p className="font-bold text-gray-800 text-sm">{p.name}</p>
                      <p className="text-xs text-red-600 font-mono">{p.productCode}</p>
                      {db.settings.showLowStockDetails && (
                        <p className="text-xs font-bold text-blue-700 mt-1">
                          Varyant: <span className="underline">{p.variantName}</span> ({p.barcode})
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-bold text-red-700">{p.daysOfStock} Günlük Stok</p>
                      <p className="text-[10px] text-gray-500">Ort. {p.depletionRate} Satış/Gün</p>
                    </div>
                  </div>
                  <div className="mt-2 w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-red-500 h-full rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(100, (p.stock / p.sales) * 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between mt-1 text-[10px] font-medium text-gray-500">
                    <span>Mevcut: {p.stock}</span>
                    <span>30 Gün Satış: {p.sales}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 p-8 space-y-2">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center text-green-600">
              <Check size={24} />
            </div>
            <p className="text-sm font-medium">Stok Durumu İyi</p>
            <p className="text-xs text-center">Kritik düzeyde azalan ürün bulunmuyor.</p>
          </div>
        )}
      </div>

      {/* Rapor Modal */}
      {isReportModalOpen && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
          <div className="bg-white p-6 rounded-xl shadow-xl w-[400px]">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-gray-800">Excel Satış Raporu</h3>
              <button
                onClick={() => setIsReportModalOpen(false)}
                className="text-gray-500 hover:bg-gray-100 p-1 rounded-full"
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Başlangıç Tarihi</label>
                <input
                  type="date"
                  className="w-full border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500"
                  value={reportStartDate}
                  onChange={(e) => setReportStartDate(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bitiş Tarihi</label>
                <input
                  type="date"
                  className="w-full border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500"
                  value={reportEndDate}
                  onChange={(e) => setReportEndDate(e.target.value)}
                />
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setIsReportModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                İptal
              </button>
              <button
                onClick={generateExcelReport}
                className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg"
              >
                Raporu İndir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
