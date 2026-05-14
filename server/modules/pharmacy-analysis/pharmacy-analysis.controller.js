import prisma from '../../lib/prisma.js';

// Normalise Arabic text for fuzzy matching
function norm(s = '') {
  return String(s).trim()
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildFileFilter(fileIds) {
  if (!fileIds) return {};
  const ids = String(fileIds).split(',').map(Number).filter(Boolean);
  if (!ids.length) return {};
  return ids.length === 1 ? { uploadedFileId: ids[0] } : { uploadedFileId: { in: ids } };
}

function buildUserFilter(userId) {
  return userId ? { userId } : {};
}

// Convert stored value to IQD (multiply by exchangeRate if file currency is USD)
function toIQD(value, uploadedFile) {
  if (!uploadedFile) return value || 0;
  const rate = uploadedFile.exchangeRate || 1500;
  const mode = uploadedFile.currencyMode || uploadedFile.detectedCurrency || 'IQD';
  return mode === 'USD' ? (value || 0) * rate : (value || 0);
}

// ── GET /api/pharmacy-analysis/pharmacies ─────────────────────
export async function listPharmacies(req, res, next) {
  try {
    const userId  = req.user.id;
    const fileIds = req.query.fileIds || null;
    const search  = req.query.search ? norm(req.query.search) : null;

    const sales = await prisma.sale.findMany({
      where: { ...buildUserFilter(userId), ...buildFileFilter(fileIds) },
      select: {
        id: true,
        quantity: true,
        totalValue: true,
        saleDate: true,
        recordType: true,
        customer:     { select: { id: true, name: true } },
        area:         { select: { id: true, name: true } },
        item:         { select: { id: true, name: true } },
        representative: { select: { id: true, name: true } },
        uploadedFile: { select: { currencyMode: true, exchangeRate: true, detectedCurrency: true } },
        rawData:  true,
      },
    });

    // Group by pharmacy name (from customer or rawData)
    const map = new Map(); // pharmacyName → { ... }

    // Deduplicate: same row appearing in multiple uploaded files
    const seenSales = new Set();

    for (const s of sales) {
      // Resolve pharmacy name: customer.name → rawData.pharmacyName → rawData.customer
      let pharmaName = s.customer?.name;
      if (!pharmaName && s.rawData) {
        try {
          const raw = JSON.parse(s.rawData);
          pharmaName = raw.pharmacyName || raw.pharmacy || raw.customer || raw.Customer || raw['اسم الصيدلية'] || raw['الصيدلية'] || raw['العميل'] || null;
        } catch {}
      }
      if (!pharmaName) continue;

      // Skip duplicates from overlapping uploaded files (recordType included in key)
      const dedupKey = [norm(pharmaName), norm(s.item?.name || ''), s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : '', s.quantity, s.totalValue, s.recordType || 'sale'].join('|');
      if (seenSales.has(dedupKey)) continue;
      seenSales.add(dedupKey);

      const areaName = s.area?.name || '';

      if (search && !norm(pharmaName).includes(search) && !norm(areaName).includes(search)) continue;

      if (!map.has(pharmaName)) {
        map.set(pharmaName, {
          name: pharmaName,
          areaName,
          repName: s.representative?.name || '',
          totalOrders: 0,
          totalQty: 0,
          totalValue: 0,
          returnsOrders: 0,
          returnsQty: 0,
          returnsValue: 0,
          firstOrder: null,
          lastOrder: null,
          items: new Map(), // itemName → { qty, value, count }
        });
      }
      const p = map.get(pharmaName);
      const iqd = toIQD(s.totalValue, s.uploadedFile);
      if (!p.areaName && areaName) p.areaName = areaName;
      if (!p.repName && s.representative?.name) p.repName = s.representative.name;

      const isReturn = s.recordType === 'return';
      if (isReturn) {
        p.returnsOrders++;
        p.returnsQty   += s.quantity;
        p.returnsValue += iqd;
      } else {
        p.totalOrders++;
        p.totalQty   += s.quantity;
        p.totalValue += iqd;
        if (!p.firstOrder || new Date(s.saleDate) < new Date(p.firstOrder)) p.firstOrder = s.saleDate;
        if (!p.lastOrder  || new Date(s.saleDate) > new Date(p.lastOrder))  p.lastOrder  = s.saleDate;
        const iName = s.item?.name || 'غير محدد';
        if (!p.items.has(iName)) p.items.set(iName, { qty: 0, value: 0, count: 0 });
        const ip = p.items.get(iName);
        ip.qty   += s.quantity;
        ip.value += iqd;
        ip.count++;
      }
    }

    const now = Date.now();
    const result = [...map.values()].map(p => ({
      name:          p.name,
      areaName:      p.areaName,
      repName:       p.repName || '',
      totalOrders:   p.totalOrders,
      totalQty:      p.totalQty,
      totalValue:    Math.round(p.totalValue),
      returnsQty:    p.returnsQty,
      returnsValue:  Math.round(p.returnsValue),
      firstOrder:    p.firstOrder,
      lastOrder:     p.lastOrder,
      itemCount:     p.items.size,
      daysSinceLast: p.lastOrder ? Math.floor((now - new Date(p.lastOrder).getTime()) / 86400000) : 9999,
      topItems: [...p.items.entries()]
        .sort((a, b) => b[1].qty - a[1].qty)
        .slice(0, 5)
        .map(([name, d]) => ({ name, qty: d.qty, value: Math.round(d.value), count: d.count })),
    })).sort((a, b) => b.totalValue - a.totalValue);

    res.json({ pharmacies: result, total: result.length });
  } catch (e) { next(e); }
}

// ── GET /api/pharmacy-analysis/pharmacy/:name ─────────────────
export async function pharmacyDetail(req, res, next) {
  try {
    const userId      = req.user.id;
    const pharmaQuery = norm(req.params.name);
    const fileIds     = req.query.fileIds || null;
    const itemFilter  = req.query.item ? norm(req.query.item) : null;

    const sales = await prisma.sale.findMany({
      where: { ...buildUserFilter(userId), ...buildFileFilter(fileIds) },
      select: {
        id: true, quantity: true, totalValue: true, saleDate: true, recordType: true,
        customer:     { select: { id: true, name: true } },
        area:         { select: { id: true, name: true } },
        item:         { select: { id: true, name: true } },
        representative: { select: { id: true, name: true } },
        uploadedFile: { select: { currencyMode: true, exchangeRate: true, detectedCurrency: true } },
        rawData: true,
      },
      orderBy: { saleDate: 'desc' },
    });

    const rows = sales.filter(s => {
      let pharmaName = s.customer?.name;
      if (!pharmaName && s.rawData) {
        try {
          const raw = JSON.parse(s.rawData);
          pharmaName = raw.pharmacyName || raw.pharmacy || raw.customer || raw.Customer || raw['اسم الصيدلية'] || raw['الصيدلية'] || raw['العميل'] || null;
        } catch {}
      }
      if (!pharmaName || !norm(pharmaName).includes(pharmaQuery)) return false;
      if (itemFilter) {
        const iName = s.item?.name || '';
        if (!norm(iName).includes(itemFilter)) return false;
      }
      return true;
    }).map(s => {
      let pharmaName = s.customer?.name;
      if (!pharmaName && s.rawData) {
        try {
          const raw = JSON.parse(s.rawData);
          pharmaName = raw.pharmacyName || raw.pharmacy || raw.customer || raw.Customer || raw['اسم الصيدلية'] || raw['الصيدلية'] || raw['العميل'] || null;
        } catch {}
      }
      return {
        id: s.id,
        pharmaName,
        itemName:   s.item?.name || 'غير محدد',
        areaName:   s.area?.name || '',
        repName:    s.representative?.name || '',
        quantity:   s.quantity,
        totalValue: Math.round(toIQD(s.totalValue, s.uploadedFile)),
        saleDate:   s.saleDate,
        recordType: s.recordType,
      };
    });

    // Group by item
    const byItem = new Map();
    // Deduplicate rows from multiple overlapping uploaded files
    const seenRows = new Set();
    const dedupedRows = rows.filter(r => {
      const k = [norm(r.pharmaName), norm(r.itemName), r.saleDate ? new Date(r.saleDate).toISOString().slice(0, 10) : '', r.quantity, r.totalValue, r.recordType, norm(r.repName)].join('|');
      if (seenRows.has(k)) return false;
      seenRows.add(k);
      return true;
    });
    for (const r of dedupedRows) {
      if (!byItem.has(r.itemName)) byItem.set(r.itemName, { name: r.itemName, orders: [], totalQty: 0, totalValue: 0 });
      const b = byItem.get(r.itemName);
      b.orders.push({ date: r.saleDate, qty: r.quantity, value: r.totalValue, rep: r.repName, type: r.recordType });
      b.totalQty   += r.quantity;
      b.totalValue += r.totalValue;
    }

    res.json({
      pharmacyName: req.params.name,
      totalOrders: dedupedRows.length,
      orders: dedupedRows,
      byItem: [...byItem.values()].sort((a, b) => b.totalQty - a.totalQty),
    });
  } catch (e) { next(e); }
}

// ── GET /api/pharmacy-analysis/items ─────────────────────────
export async function listItems(req, res, next) {
  try {
    const userId  = req.user.id;
    const fileIds = req.query.fileIds || null;
    const search  = req.query.search ? norm(req.query.search) : null;

    const sales = await prisma.sale.findMany({
      where: { ...buildUserFilter(userId), ...buildFileFilter(fileIds) },
      select: {
        quantity: true, totalValue: true, saleDate: true,
        item:         { select: { id: true, name: true } },
        customer:     { select: { id: true, name: true } },
        area:         { select: { id: true, name: true } },
        uploadedFile: { select: { currencyMode: true, exchangeRate: true, detectedCurrency: true } },
        rawData:  true,
      },
    });

    const map = new Map(); // itemName → { pharmacies, totalQty, totalValue, ... }
    const seenItemSales = new Set();
    for (const s of sales) {
      const iName = s.item?.name || 'غير محدد';
      if (search && !norm(iName).includes(search)) continue;

      // Deduplicate rows from overlapping uploaded files
      let _pharmaDedup = s.customer?.name;
      if (!_pharmaDedup && s.rawData) { try { const _r = JSON.parse(s.rawData); _pharmaDedup = _r.pharmacyName || _r.pharmacy || _r.customer || _r.Customer || _r['اسم الصيدلية'] || _r['الصيدلية'] || _r['العميل'] || null; } catch {} }
      const dedupKey = [norm(iName), norm(_pharmaDedup || ''), s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : '', s.quantity, s.totalValue].join('|');
      if (seenItemSales.has(dedupKey)) continue;
      seenItemSales.add(dedupKey);

      const iqdVal = toIQD(s.totalValue, s.uploadedFile);
      if (!map.has(iName)) map.set(iName, { name: iName, pharmacies: new Map(), totalQty: 0, totalValue: 0, firstOrder: s.saleDate, lastOrder: s.saleDate });
      const it = map.get(iName);
      it.totalQty   += s.quantity;
      it.totalValue += iqdVal;
      if (new Date(s.saleDate) < new Date(it.firstOrder)) it.firstOrder = s.saleDate;
      if (new Date(s.saleDate) > new Date(it.lastOrder))  it.lastOrder  = s.saleDate;

      let pharmaName = s.customer?.name;
      if (!pharmaName && s.rawData) {
        try {
          const raw = JSON.parse(s.rawData);
          pharmaName = raw.pharmacyName || raw.pharmacy || raw.customer || raw.Customer || raw['اسم الصيدلية'] || raw['الصيدلية'] || raw['العميل'] || null;
        } catch {}
      }
      pharmaName = pharmaName || 'غير محدد';

      if (!it.pharmacies.has(pharmaName)) it.pharmacies.set(pharmaName, { name: pharmaName, areaName: s.area?.name || '', qty: 0, value: 0 });
      const ph = it.pharmacies.get(pharmaName);
      ph.qty   += s.quantity;
      ph.value += iqdVal;
    }

    const result = [...map.values()].map(it => ({
      name:          it.name,
      totalQty:      it.totalQty,
      totalValue:    Math.round(it.totalValue),
      pharmacyCount: it.pharmacies.size,
      firstOrder:    it.firstOrder,
      lastOrder:     it.lastOrder,
      topPharmacies: [...it.pharmacies.values()].sort((a, b) => b.qty - a.qty).slice(0, 5),
    })).sort((a, b) => b.totalQty - a.totalQty);

    res.json({ items: result, total: result.length });
  } catch (e) { next(e); }
}

// ── GET /api/pharmacy-analysis/item/:name ─────────────────────
export async function itemDetail(req, res, next) {
  try {
    const userId     = req.user.id;
    const itemQuery  = norm(req.params.name);
    const fileIds    = req.query.fileIds || null;

    const sales = await prisma.sale.findMany({
      where: { ...buildUserFilter(userId), ...buildFileFilter(fileIds) },
      select: {
        id: true, quantity: true, totalValue: true, saleDate: true, recordType: true,
        item:           { select: { id: true, name: true } },
        customer:       { select: { id: true, name: true } },
        area:           { select: { id: true, name: true } },
        representative: { select: { id: true, name: true } },
        uploadedFile:   { select: { currencyMode: true, exchangeRate: true, detectedCurrency: true } },
        rawData: true,
      },
      orderBy: { saleDate: 'desc' },
    });

    const filteredRows = sales.filter(s => norm(s.item?.name || '').includes(itemQuery));

    // Deduplicate rows from overlapping uploaded files
    const seenItemDetail = new Set();
    const rows = filteredRows.filter(s => {
      let _pn = s.customer?.name;
      if (!_pn && s.rawData) { try { const _r = JSON.parse(s.rawData); _pn = _r.pharmacyName || _r.pharmacy || _r.customer || _r.Customer || _r['اسم الصيدلية'] || _r['الصيدلية'] || _r['العميل'] || null; } catch {} }
      const k = [norm(s.item?.name || ''), norm(_pn || ''), s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : '', s.quantity, s.totalValue, s.recordType, norm(s.representative?.name || '')].join('|');
      if (seenItemDetail.has(k)) return false;
      seenItemDetail.add(k);
      return true;
    });

    // Group by pharmacy
    const byPharma = new Map();
    for (const s of rows) {
      let pharmaName = s.customer?.name;
      if (!pharmaName && s.rawData) {
        try {
          const raw = JSON.parse(s.rawData);
          pharmaName = raw.pharmacyName || raw.pharmacy || raw.customer || raw.Customer || raw['اسم الصيدلية'] || raw['الصيدلية'] || raw['العميل'] || null;
        } catch {}
      }
      pharmaName = pharmaName || 'غير محدد';

      if (!byPharma.has(pharmaName)) {
        byPharma.set(pharmaName, {
          name: pharmaName,
          areaName: s.area?.name || '',
          orders: [],
          totalQty: 0,
          totalValue: 0,
          lastOrder: s.saleDate,
        });
      }
      const p = byPharma.get(pharmaName);
      const iqd2 = Math.round(toIQD(s.totalValue, s.uploadedFile));
      p.orders.push({ date: s.saleDate, qty: s.quantity, value: iqd2, rep: s.representative?.name || '', type: s.recordType });
      p.totalQty   += s.quantity;
      p.totalValue += iqd2;
      if (new Date(s.saleDate) > new Date(p.lastOrder)) p.lastOrder = s.saleDate;
    }

    res.json({
      itemName:     req.params.name,
      totalOrders:  rows.length,
      pharmacies:   [...byPharma.values()].sort((a, b) => b.totalQty - a.totalQty),
    });
  } catch (e) { next(e); }
}

// ── GET /api/pharmacy-analysis/alerts ─────────────────────────
export async function getAlerts(req, res, next) {
  try {
    const userId      = req.user.id;
    const fileIds     = req.query.fileIds || null;
    const thresholdDays = parseInt(req.query.days || '30');

    const sales = await prisma.sale.findMany({
      where: { ...buildUserFilter(userId), ...buildFileFilter(fileIds) },
      select: {
        quantity: true, totalValue: true, saleDate: true,
        item:         { select: { name: true } },
        customer:     { select: { name: true } },
        area:         { select: { name: true } },
        uploadedFile: { select: { currencyMode: true, exchangeRate: true, detectedCurrency: true } },
        rawData:  true,
      },
    });

    // For each pharmacy × item pair, find last order date
    const map = new Map(); // `pharma|||item` → { pharmaName, itemName, areaName, lastOrder, totalQty, orderCount }
    const seenAlerts = new Set();
    for (const s of sales) {
      const iName = s.item?.name || 'غير محدد';
      let pharmaName = s.customer?.name;
      if (!pharmaName && s.rawData) {
        try {
          const raw = JSON.parse(s.rawData);
          pharmaName = raw.pharmacyName || raw.pharmacy || raw.customer || raw.Customer || raw['اسم الصيدلية'] || raw['الصيدلية'] || raw['العميل'] || null;
        } catch {}
      }
      if (!pharmaName) continue;

      // Deduplicate rows from overlapping uploaded files
      const dedupKey = [norm(pharmaName), norm(iName), s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : '', s.quantity, s.totalValue].join('|');
      if (seenAlerts.has(dedupKey)) continue;
      seenAlerts.add(dedupKey);

      const key = `${pharmaName}|||${iName}`;
      if (!map.has(key)) {
        map.set(key, { pharmaName, itemName: iName, areaName: s.area?.name || '', lastOrder: s.saleDate, totalQty: 0, orderCount: 0 });
      }
      const e = map.get(key);
      e.totalQty   += s.quantity;
      e.orderCount++;
      if (new Date(s.saleDate) > new Date(e.lastOrder)) e.lastOrder = s.saleDate;
    }

    const now = Date.now();
    const alerts = [...map.values()]
      .map(e => ({
        ...e,
        totalQty: e.totalQty,
        daysSinceLast: Math.floor((now - new Date(e.lastOrder).getTime()) / 86400000),
      }))
      .filter(e => e.daysSinceLast >= thresholdDays)
      .sort((a, b) => b.daysSinceLast - a.daysSinceLast);

    res.json({ alerts, threshold: thresholdDays, total: alerts.length });
  } catch (e) { next(e); }
}
