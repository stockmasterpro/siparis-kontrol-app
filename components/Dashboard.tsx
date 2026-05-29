
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
  const [filterType, setFilterType] = useState<'day' | 'month' | 'year' | 'range'>('month');
  const [selectedDay, setSelectedDay] = useState<string>(new Date().toISOString().split('T')[0]);
  const [selectedMonth, setSelectedMonth] = useState<string>(getLocalMonth());
  const [selectedYear, setSelectedYear] = useState<string>(new Date().getFullYear().toString());
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
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

  // --- Tarih Bazlı Filtreleme ---
  const filteredOrders = useMemo(() => {
    let baseOrders = db.orders.filter(o => {
      if (o.isSuspended || o.isDeleted) return false;
      // İptal edilmiş ve iadesi olmayan siparişleri filtrele (iade edilenler toplam siparişte kalmalı)
      if (o.status === OrderStatus.CANCELLED && !db.returns.some(r => r.orderId === o.id)) return false;
      
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

    if (filterType === 'day') {
      if (!selectedDay) return baseOrders;
      return baseOrders.filter(o => {
        const d = new Date(o.orderDate);
        const dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return dayStr === selectedDay;
      });
    } else if (filterType === 'month') {
      if (!selectedMonth) return baseOrders;
      const [year, month] = selectedMonth.split('-');
      return baseOrders.filter(o => {
        const d = new Date(o.orderDate);
        return d.getFullYear() === parseInt(year) && (d.getMonth() + 1) === parseInt(month);
      });
    } else if (filterType === 'year') {
      if (!selectedYear) return baseOrders;
      const yr = parseInt(selectedYear);
      return baseOrders.filter(o => {
        const d = new Date(o.orderDate);
        return d.getFullYear() === yr;
      });
    } else if (filterType === 'range') {
      if (!startDate && !endDate) return baseOrders;
      return baseOrders.filter(o => {
        const d = new Date(o.orderDate);
        if (startDate && d < new Date(startDate)) return false;
        if (endDate) {
          const endLimit = new Date(endDate);
          endLimit.setHours(23, 59, 59, 999);
          if (d > endLimit) return false;
        }
        return true;
      });
    }

    return baseOrders;
  }, [db.orders, filterType, selectedDay, selectedMonth, selectedYear, startDate, endDate, selectedCountries, validBarcodesSet, db.returns]);

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

    if (filterType === 'day') {
      if (!selectedDay) return baseReturns;
      return baseReturns.filter(r => {
        const d = new Date(r.returnDate);
        const dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return dayStr === selectedDay;
      });
    } else if (filterType === 'month') {
      if (!selectedMonth) return baseReturns;
      const [year, month] = selectedMonth.split('-');
      return baseReturns.filter(r => {
        const d = new Date(r.returnDate);
        return d.getFullYear() === parseInt(year) && (d.getMonth() + 1) === parseInt(month);
      });
    } else if (filterType === 'year') {
      if (!selectedYear) return baseReturns;
      const yr = parseInt(selectedYear);
      return baseReturns.filter(r => {
        const d = new Date(r.returnDate);
        return d.getFullYear() === yr;
      });
    } else if (filterType === 'range') {
      if (!startDate && !endDate) return baseReturns;
      return baseReturns.filter(r => {
        const d = new Date(r.returnDate);
        if (startDate && d < new Date(startDate)) return false;
        if (endDate) {
          const endLimit = new Date(endDate);
          endLimit.setHours(23, 59, 59, 999);
          if (d > endLimit) return false;
        }
        return true;
      });
    }

    return baseReturns;
  }, [db.returns, db.orders, filterType, selectedDay, selectedMonth, selectedYear, startDate, endDate, selectedCountries]);

  // GLOBAL STATS (Filtered by selected range/period)
  const totalOrders = filteredOrders.length;
  
  const cancelledOrdersCount = useMemo(() => {
    let baseOrders = db.orders.filter(o => {
      if (o.isSuspended) return false;
      // Sadece iptal edilmiş ve iadesi olmayanlar
      if (!(o.status === OrderStatus.CANCELLED && !db.returns.some(r => r.orderId === o.id))) return false;
      return o.items.every(item => item.barcode && item.barcode !== 'NO-BARCODE' && validBarcodesSet.has(item.barcode));
    });

    if (selectedCountries.length > 0) {
      baseOrders = baseOrders.filter(o => {
        const codeUpper = getEffectiveOrderCountryCode(o).toUpperCase();
        return selectedCountries.some(code => codeUpper === code.toUpperCase());
      });
    }

    if (filterType === 'day') {
      if (!selectedDay) return 0;
      return baseOrders.filter(o => {
        const d = new Date(o.orderDate);
        const dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return dayStr === selectedDay;
      }).length;
    } else if (filterType === 'month') {
      if (!selectedMonth) return baseOrders.length;
      const [year, month] = selectedMonth.split('-');
      return baseOrders.filter(o => {
        const d = new Date(o.orderDate);
        return d.getFullYear() === parseInt(year) && (d.getMonth() + 1) === parseInt(month);
      }).length;
    } else if (filterType === 'year') {
      if (!selectedYear) return 0;
      const yr = parseInt(selectedYear);
      return baseOrders.filter(o => {
        const d = new Date(o.orderDate);
        return d.getFullYear() === yr;
      }).length;
    } else if (filterType === 'range') {
      if (!startDate && !endDate) return baseOrders.length;
      return baseOrders.filter(o => {
        const d = new Date(o.orderDate);
        if (startDate && d < new Date(startDate)) return false;
        if (endDate) {
          const endLimit = new Date(endDate);
          endLimit.setHours(23, 59, 59, 999);
          if (d > endLimit) return false;
        }
        return true;
      }).length;
    }

    return baseOrders.length;
  }, [db.orders, filterType, selectedDay, selectedMonth, selectedYear, startDate, endDate, selectedCountries, validBarcodesSet, db.returns]);

  const returnedOrdersCount = useMemo(() => {
    return filteredOrders.filter(o => db.returns.some(r => r.orderId === o.id)).length;
  }, [filteredOrders, db.returns]);

  const netOrdersCount = totalOrders - returnedOrdersCount;

  const pendingOrders = filteredOrders.filter(o => o.status === OrderStatus.NEW).length;
  const shippingOrdersCount = filteredOrders.filter(o => o.status === OrderStatus.SHIPPING).length;
  const deliveredOrdersCount = filteredOrders.filter(o => o.status === OrderStatus.DELIVERED).length;

  const grossRevenue = useMemo(() => {
    return filteredOrders
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
      if (o.isSuspended) return false;
      const d = new Date(o.orderDate);
      const localDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return localDateStr === dateStr;
    });

    const dayTotalOrders = dayOrders.filter(o => !(o.status === OrderStatus.CANCELLED && !db.returns.some(r => r.orderId === o.id)));
    const dayReturned = dayTotalOrders.filter(o => db.returns.some(r => r.orderId === o.id));

    const dailyGross = dayTotalOrders.reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.totalPrice, 0), 0);

    const dailyReturns = dayTotalOrders.reduce((total, order) => {
      const linkedReturns = db.returns.filter(r => r.orderId === order.id);
      return total + linkedReturns.reduce((sum, r) => sum + (r.item.unitPrice * r.returnQuantity), 0);
    }, 0);

    return {
      grossRevenue: dailyGross,
      returnsValue: dailyReturns,
      revenue: dailyGross - dailyReturns,
      totalCount: dayTotalOrders.length,
      netCount: dayTotalOrders.length - dayReturned.length
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
  const todayCount = todayStats.netCount;
  const yesterdayCount = yesterdayStats.netCount;

  // --- Mağaza Bazlı Analiz (Filtreli) ---
  const storeAnalytics = useMemo(() => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const yesterdayNode = new Date(now);
    yesterdayNode.setDate(yesterdayNode.getDate() - 1);
    const yesterdayStr = `${yesterdayNode.getFullYear()}-${String(yesterdayNode.getMonth() + 1).padStart(2, '0')}-${String(yesterdayNode.getDate()).padStart(2, '0')}`;

    return db.apiConfigs.map(config => {
      const storeOrders = filteredOrders.filter(o => o.storeName === config.storeName);
      const storeTotalOrdersList = storeOrders.filter(o => !(o.status === OrderStatus.CANCELLED && !db.returns.some(r => r.orderId === o.id)));
      
      const totalItemsQty = storeTotalOrdersList.reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.quantity, 0), 0);

      const storePendingCount = storeTotalOrdersList.filter(o => o.status === OrderStatus.NEW).length;
      const storePendingQty = storeTotalOrdersList.filter(o => o.status === OrderStatus.NEW).reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.quantity, 0), 0);

      const storeShippingCount = storeTotalOrdersList.filter(o => o.status === OrderStatus.SHIPPING).length;
      const storeShippingQty = storeTotalOrdersList.filter(o => o.status === OrderStatus.SHIPPING).reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.quantity, 0), 0);

      const storeDeliveredCount = storeTotalOrdersList.filter(o => o.status === OrderStatus.DELIVERED).length;
      const storeDeliveredQty = storeTotalOrdersList.filter(o => o.status === OrderStatus.DELIVERED).reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.quantity, 0), 0);

      const storeGrossRevenue = storeTotalOrdersList.reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.totalPrice, 0), 0);

      const storeOrderIds = new Set(storeTotalOrdersList.map(o => o.id));
      const linkedReturns = db.returns.filter(r => storeOrderIds.has(r.orderId));
      const storeReturnsValue = linkedReturns.reduce((acc, r) => acc + (r.item.unitPrice * r.returnQuantity), 0);
      const returnedItemsQty = linkedReturns.reduce((acc, r) => acc + r.returnQuantity, 0);

      const netItemsQty = totalItemsQty - returnedItemsQty;

      // Count cancelled orders for this store using the same logic (keeping soft-deleted cancelled orders)
      let storeCancelledOrdersBase = db.orders.filter(o => {
        if (o.isSuspended || o.storeName !== config.storeName) return false;
        if (!(o.status === OrderStatus.CANCELLED && !db.returns.some(r => r.orderId === o.id))) return false;
        return o.items.every(item => item.barcode && item.barcode !== 'NO-BARCODE' && validBarcodesSet.has(item.barcode));
      });
      if (selectedCountries.length > 0) {
        storeCancelledOrdersBase = storeCancelledOrdersBase.filter(o => {
          const codeUpper = getEffectiveOrderCountryCode(o).toUpperCase();
          return selectedCountries.some(code => codeUpper === code.toUpperCase());
        });
      }

      let filteredCancelledOrders = storeCancelledOrdersBase;
      if (filterType === 'day') {
        if (selectedDay) {
          filteredCancelledOrders = storeCancelledOrdersBase.filter(o => {
            const d = new Date(o.orderDate);
            const dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            return dayStr === selectedDay;
          });
        }
      } else if (filterType === 'month') {
        if (selectedMonth) {
          const [year, month] = selectedMonth.split('-');
          filteredCancelledOrders = storeCancelledOrdersBase.filter(o => {
            const d = new Date(o.orderDate);
            return d.getFullYear() === parseInt(year) && (d.getMonth() + 1) === parseInt(month);
          });
        }
      } else if (filterType === 'year') {
        if (selectedYear) {
          const yr = parseInt(selectedYear);
          filteredCancelledOrders = storeCancelledOrdersBase.filter(o => {
            const d = new Date(o.orderDate);
            return d.getFullYear() === yr;
          });
        }
      } else if (filterType === 'range') {
        filteredCancelledOrders = storeCancelledOrdersBase.filter(o => {
          const d = new Date(o.orderDate);
          if (startDate && d < new Date(startDate)) return false;
          if (endDate) {
            const endLimit = new Date(endDate);
            endLimit.setHours(23, 59, 59, 999);
            if (d > endLimit) return false;
          }
          return true;
        });
      }

      const cancelledItemsQty = filteredCancelledOrders.reduce((acc, order) => acc + order.items.reduce((sum, item) => sum + item.quantity, 0), 0);

      const tStats = getStatsForDate(todayStr, storeOrders);
      const yStats = getStatsForDate(yesterdayStr, storeOrders);

      return {
        storeName: config.storeName,
        totalOrders: totalItemsQty,
        cancelledOrders: cancelledItemsQty,
        returnedOrders: returnedItemsQty,
        netOrders: netItemsQty,
        pendingOrders: storePendingQty,
        pendingOrdersCount: storePendingCount,
        shippingOrders: storeShippingQty,
        shippingOrdersCount: storeShippingCount,
        deliveredOrders: storeDeliveredQty,
        deliveredOrdersCount: storeDeliveredCount,
        grossRevenue: storeGrossRevenue,
        returnsValue: storeReturnsValue,
        revenue: storeGrossRevenue - storeReturnsValue,
        todayRevenue: tStats.revenue,
        yesterdayRevenue: yStats.revenue,
        todayCount: tStats.netCount,
        yesterdayCount: yStats.netCount
      };
    });
  }, [db.apiConfigs, filteredOrders, db.returns, selectedCountries, filterType, selectedDay, selectedMonth, selectedYear, startDate, endDate, validBarcodesSet]);

  // --- Real Data Aggregation ---
  // 1. Günlük Satış Özeti (Dinamik)
  const chartDays = useMemo(() => {
    if (filterType === 'month' && selectedMonth) {
      const [year, month] = selectedMonth.split('-');
      const y = parseInt(year);
      const m = parseInt(month) - 1;
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      return Array.from({ length: daysInMonth }, (_, i) => {
        return `${y}-${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
      });
    } else if (filterType === 'range' && startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const days = [];
      let temp = new Date(start);
      let limit = 0;
      while (temp <= end && limit < 90) {
        days.push(`${temp.getFullYear()}-${String(temp.getMonth() + 1).padStart(2, '0')}-${String(temp.getDate()).padStart(2, '0')}`);
        temp.setDate(temp.getDate() + 1);
        limit++;
      }
      return days;
    } else if (filterType === 'day' && selectedDay) {
      const days = [];
      const targetDate = new Date(selectedDay);
      for (let i = 14; i >= 0; i--) {
        const d = new Date(targetDate);
        d.setDate(d.getDate() - i);
        days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      }
      return days;
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
  }, [selectedMonth, filterType, startDate, endDate, selectedDay]);

  const dailyChartData = useMemo(() => {
    return chartDays.map(dateStr => {
      const dateObj = new Date(dateStr);
      const dayName = (filterType === 'month' && selectedMonth)
        ? dateStr.split('-')[2]
        : dateObj.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });

      const dayData: any = { name: dayName, date: dateStr };

      db.apiConfigs.forEach(config => {
        const dayOrders = db.orders.filter(o => {
          if (o.isSuspended || o.isDeleted || o.storeName !== config.storeName) return false;
          // İptal edilmiş ve iadesi olmayanları filtrele
          if (o.status === OrderStatus.CANCELLED && !db.returns.some(r => r.orderId === o.id)) return false;

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

        const returnedCount = dayOrders.filter(o => db.returns.some(r => r.orderId === o.id)).length;
        const netOrdersCount = dayOrders.length - returnedCount;

        dayData[config.storeName] = dailyGross - dailyReturnsDeduction;
        dayData[`${config.storeName}_netOrders`] = netOrdersCount;
      });

      return dayData;
    });
  }, [chartDays, db.orders, db.apiConfigs, db.returns, filterType, selectedMonth, selectedCountries, validBarcodesSet]);

  const chartMonths = useMemo(() => {
    const months = [];
    let referenceDate = new Date();
    if (filterType === 'month' && selectedMonth) {
      const [year, month] = selectedMonth.split('-');
      referenceDate = new Date(parseInt(year), parseInt(month) - 1, 1);
    } else if (filterType === 'day' && selectedDay) {
      referenceDate = new Date(selectedDay);
    } else if (filterType === 'range' && endDate) {
      referenceDate = new Date(endDate);
    }

    for (let i = trendMonthCount - 1; i >= 0; i--) {
      const d = new Date(referenceDate);
      d.setMonth(d.getMonth() - i);
      const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const monthName = d.toLocaleDateString('tr-TR', { month: 'short', year: 'numeric' });
      months.push({ yearMonth, monthName });
    }
    return months;
  }, [selectedMonth, filterType, selectedDay, endDate, trendMonthCount]);

  const monthlyTrendData = useMemo(() => {
    return chartMonths.map(month => {
      const monthData: any = { name: month.monthName };

      db.apiConfigs.forEach(config => {
        const monthOrders = db.orders.filter(o => {
          if (o.isSuspended || o.isDeleted || o.storeName !== config.storeName) return false;
          // İptal edilmiş ve iadesi olmayanları filtrele
          if (o.status === OrderStatus.CANCELLED && !db.returns.some(r => r.orderId === o.id)) return false;

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

  const getYearOptions = () => {
    const years = [];
    const currentYear = new Date().getFullYear();
    for (let yr = currentYear; yr >= currentYear - 5; yr--) {
      years.push({ value: yr.toString(), label: yr.toString() });
    }
    return years;
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
      if (o.isSuspended) return false;
      // İptal edilmiş ve iadesi olmayanları filtrele (iade edilenler rapora insin)
      if (o.status === OrderStatus.CANCELLED && !db.returns.some(r => r.orderId === o.id)) return false;
      
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
            'Toplam Sipariş Adet': 0,
            'Toplam Sipariş Ciro': 0,
            'Toplam İade Adet': 0,
            'Toplam İade Ciro': 0,
            'Net Sipariş Adet': 0,
            'Net Sipariş Ciro': 0
          };
        }

        const itemReturns = db.returns.filter(r => r.orderId === order.id && r.item.barcode === item.barcode);
        const itemReturnedQty = itemReturns.reduce((sum, r) => sum + r.returnQuantity, 0);
        const itemReturnedCiro = itemReturns.reduce((sum, r) => sum + (r.item.unitPrice * r.returnQuantity), 0);

        groupedData[key]['Toplam Sipariş Adet'] += item.quantity;
        groupedData[key]['Toplam Sipariş Ciro'] += item.totalPrice;
        groupedData[key]['Toplam İade Adet'] += itemReturnedQty;
        groupedData[key]['Toplam İade Ciro'] += itemReturnedCiro;
        groupedData[key]['Net Sipariş Adet'] = groupedData[key]['Toplam Sipariş Adet'] - groupedData[key]['Toplam İade Adet'];
        groupedData[key]['Net Sipariş Ciro'] = groupedData[key]['Toplam Sipariş Ciro'] - groupedData[key]['Toplam İade Ciro'];
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
    const stats: Record<string, { code: string, name: string, count: number, quantity: number, revenue: number }> = {};
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
        stats[code] = { code, name: countryName, count: 0, quantity: 0, revenue: 0 };
      }
      stats[code].count += 1;
      stats[code].quantity += order.items.reduce((sum, item) => sum + item.quantity, 0);
      stats[code].revenue += order.items.reduce((sum, item) => sum + item.totalPrice, 0);
    });

    return Object.values(stats).sort((a, b) => b.revenue - a.revenue);
  }, [filteredOrders]);

  return (
    <div className="space-y-6">
      {/* Tarih Filtresi Segment Grubu */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-gray-700 font-medium text-sm">Filtre Türü:</span>
            <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
              <button
                type="button"
                onClick={() => setFilterType('day')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${filterType === 'day' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`}
              >
                Günlük
              </button>
              <button
                type="button"
                onClick={() => setFilterType('month')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${filterType === 'month' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`}
              >
                Aylık
              </button>
              <button
                type="button"
                onClick={() => setFilterType('year')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${filterType === 'year' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`}
              >
                Yıllık
              </button>
              <button
                type="button"
                onClick={() => setFilterType('range')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${filterType === 'range' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`}
              >
                Tarih Aralığı
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {filterType === 'day' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 font-medium">Gün Seçin:</span>
                <input
                  type="date"
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                  value={selectedDay}
                  onChange={(e) => setSelectedDay(e.target.value)}
                />
              </div>
            )}

            {filterType === 'month' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 font-medium">Ay Seçin:</span>
                <select
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-[150px]"
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
              </div>
            )}

            {filterType === 'year' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 font-medium">Yıl Seçin:</span>
                <select
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-[100px]"
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(e.target.value)}
                >
                  {getYearOptions().map(yr => (
                    <option key={yr.value} value={yr.value}>
                      {yr.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {filterType === 'range' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 font-medium">Aralık:</span>
                <input
                  type="date"
                  className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
                <span className="text-gray-400 text-xs font-semibold">ve</span>
                <input
                  type="date"
                  className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            )}
          </div>

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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Toplam Ürün */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-gray-500 text-sm font-medium">Toplam Ürün</h3>
          <p className="text-3xl font-bold text-gray-800 mt-2">{totalProducts}</p>
        </div>

        {/* Bekleyen Sipariş & Durum Takibi */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-gray-500 text-sm font-medium">Bekleyen ve Sevk Durumları</h3>
          <div className="mt-2 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-gray-500 text-sm">Bekleyen Sipariş</span>
              <span className="font-bold text-orange-600 text-lg">{pendingOrders}</span>
            </div>
            <div className="flex justify-between items-center border-t pt-1">
              <span className="text-gray-500 text-xs">Taşıma Durumunda</span>
              <span className="font-bold text-blue-500 text-sm">{shippingOrdersCount}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500 text-xs">Teslim Edilenler</span>
              <span className="font-bold text-green-600 text-sm">{deliveredOrdersCount}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500 text-xs">İptal Sipariş</span>
              <span className="font-bold text-red-600 text-sm">{cancelledOrdersCount}</span>
            </div>
          </div>
        </div>

        {/* Sipariş İstatistikleri */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-gray-500 text-sm font-medium">Sipariş İstatistikleri</h3>
          <div className="mt-2 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-gray-500 text-sm">Toplam Sipariş Adeti</span>
              <span className="font-bold text-blue-600 text-lg">{totalOrders}</span>
            </div>
            <div className="flex justify-between items-center border-t pt-1">
              <span className="text-gray-500 text-xs">Net Sipariş Adeti</span>
              <span className="font-bold text-indigo-600 text-sm">{netOrdersCount}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500 text-xs">İade Sipariş Adeti</span>
              <span className="font-bold text-orange-600 text-sm">{returnedOrdersCount}</span>
            </div>
          </div>
        </div>

        {/* Ciro İstatistikleri */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-gray-500 text-sm font-medium">Ciro İstatistikleri</h3>
          <div className="mt-2 space-y-1">
            <div className="flex justify-between items-center">
              <span className="text-gray-500 text-xs">Brüt Ciro:</span>
              <span className="font-semibold text-gray-700 text-sm">{grossRevenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500 text-xs text-red-500">İade Ciro:</span>
              <span className="font-semibold text-red-600 text-sm">{totalReturnsValue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
            </div>
            <div className="flex justify-between items-center border-t pt-1">
              <span className="text-gray-700 font-semibold text-xs">Net Ciro:</span>
              <span className="font-bold text-green-600 text-sm">{totalRevenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
            </div>
          </div>
          <div className="mt-2 flex flex-col gap-1 text-[11px] border-t pt-2">
            <div className="flex justify-between">
              <span className="text-gray-500">Bugün Net:</span>
              <span className="font-semibold text-green-600">{todayRevenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Dün Net:</span>
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
            
            {/* Sipariş Kırılımı */}
            <div className="grid grid-cols-2 gap-2 text-xs border-b pb-3 mb-3">
              <div>
                <span className="text-gray-500 block">Toplam Ürün Adeti</span>
                <span className="font-bold text-blue-600 text-sm">{store.totalOrders}</span>
              </div>
              <div>
                <span className="text-gray-500 block">Net Ürün Adeti</span>
                <span className="font-bold text-indigo-600 text-sm">{store.netOrders}</span>
              </div>
              <div>
                <span className="text-gray-500 block">İade Ürün Adeti</span>
                <span className="font-bold text-orange-600 text-sm">{store.returnedOrders}</span>
              </div>
              <div>
                <span className="text-gray-500 block">İptal Ürün Adeti</span>
                <span className="font-bold text-red-600 text-sm">{store.cancelledOrders}</span>
              </div>
            </div>

            {/* Ciro Kırılımı */}
            <div className="grid grid-cols-3 gap-1 text-[11px] border-b pb-3 mb-3">
              <div>
                <span className="text-gray-500 block">Brüt Ciro</span>
                <span className="font-bold text-gray-700">{store.grossRevenue.toLocaleString('tr-TR', { maximumFractionDigits: 0 })} ₺</span>
              </div>
              <div>
                <span className="text-gray-500 block text-red-500">İade Ciro</span>
                <span className="font-bold text-red-600">{store.returnsValue.toLocaleString('tr-TR', { maximumFractionDigits: 0 })} ₺</span>
              </div>
              <div>
                <span className="text-gray-500 block text-green-600 font-semibold">Net Ciro</span>
                <span className="font-bold text-green-600">{store.revenue.toLocaleString('tr-TR', { maximumFractionDigits: 0 })} ₺</span>
              </div>
            </div>

            {/* Durum Kırılımı */}
            <div className="space-y-1.5 text-xs mb-3 border-b pb-3">
              <div className="flex justify-between items-center">
                <span className="text-gray-600 font-medium">Bekleyen Sipariş</span>
                <span className="font-semibold text-orange-500">{(store as any).pendingOrders} Adet / {(store as any).pendingOrdersCount} Sipariş</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600 font-medium">Taşıma Durumunda</span>
                <span className="font-semibold text-blue-500">{(store as any).shippingOrders || 0} Adet / {(store as any).shippingOrdersCount || 0} Sipariş</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600 font-medium">Teslim Edilenler</span>
                <span className="font-semibold text-green-600">{(store as any).deliveredOrders || 0} Adet / {(store as any).deliveredOrdersCount || 0} Sipariş</span>
              </div>
            </div>

            {/* Bugün/Dün Karşılaştırması */}
            <div className="mt-4 flex flex-col gap-2 text-xs border-t pt-3">
              <div className="flex justify-between items-center opacity-85">
                <span className="text-gray-500 italic">Bugünkü Sipariş</span>
                <span className="font-bold text-gray-700">{store.todayCount} Net Adet</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Bugünkü Net Ciro</span>
                <span className="font-semibold text-green-600">{store.todayRevenue.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺</span>
              </div>
              <div className="h-px bg-gray-100 my-1"></div>
              <div className="flex justify-between items-center opacity-85">
                <span className="text-gray-500 italic">Dünkü Sipariş</span>
                <span className="font-bold text-gray-700">{store.yesterdayCount} Net Adet</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Dünkü Net Ciro</span>
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
              <Tooltip
                formatter={(value, name, props) => {
                  const netOrders = props.payload[`${name}_netOrders`] || 0;
                  return [`${Number(value).toLocaleString('tr-TR')} ₺ (${netOrders} Net Sipariş)`, name];
                }}
              />
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
                  <th className="pb-3 font-medium">Satış Adeti</th>
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
                    <td className="py-3 text-gray-600">{country.count} Sipariş</td>
                    <td className="py-3 text-gray-600">{country.quantity} Adet</td>
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
