import prisma from '../../lib/prisma.js';
import { computePharmacyAlerts } from './pharmacy-alerts.service.js';
import { buildItemScopeFilter } from '../../lib/itemScope.js';

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

// يتحقق من أن المستخدم يملك أو يُشارَك معه (FileUserShare) كل fileId مطلوب —
// ضروري الآن بعد أن صارت ملفات pharmacy_net قابلة للتعميم من موظف المكتب على
// مدير المكتب/الشركة؛ سابقاً كان buildUserFilter({userId}) وحده يكفي لأن كل
// ملف كان يخص صاحبه فقط. المصفوفة المُتحقَّق منها فقط هي ما يُستخدم في
// uploadedFileId — فلا يمكن لأي مستخدم تمرير fileId لملف غيره غير المُشارَك معه.
async function resolveFileScope(userId, fileIds) {
  if (!fileIds) return userId ? { userId } : {};
  const ids = String(fileIds).split(',').map(Number).filter(Boolean);
  if (!ids.length) return userId ? { userId } : {};
  const accessible = await prisma.uploadedFile.findMany({
    where: { id: { in: ids }, OR: [{ userId }, { fileShares: { some: { userId } } }] },
    select: { id: true },
  });
  const verifiedIds = accessible.map(f => f.id);
  if (!verifiedIds.length) return { id: -1 }; // لا صلاحية على أي من الملفات المطلوبة
  return { uploadedFileId: { in: verifiedIds } };
}

const SALE_DETAIL_SELECT = {
  id: true, quantity: true, totalValue: true, saleDate: true, recordType: true,
  uploadedFileId: true,
  customer:       { select: { id: true, name: true } },
  area:           { select: { id: true, name: true } },
  item:           { select: { id: true, name: true } },
  representative: { select: { id: true, name: true } },
  uploadedFile:   { select: { currencyMode: true, exchangeRate: true, detectedCurrency: true } },
};

const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

// إسقاط التكرار **عبر الملفات المتداخلة فقط** — نفس خوارزمية تقرير المندوبين
// العلميين (scientific-reps.service.js) حرفياً، لئلا يختلف الرقمان.
//
// نجمع الصفوف بمفتاح مركّب، ثم لكل مفتاح نُبقي صفوف **الملف الذي يحتوي أكثر
// عدد من التكرارات وحده**. هذا يطوي تداخل «ملف كل العراق + ملف المنطقة» ويُبقي
// كل طلبية حقيقية مكررة داخل الملف الواحد — وبيانات الأدوية تكرر الكميات
// المستديرة (10/50/100) لنفس الصيدلية في اليوم نفسه بشكل مشروع تماماً.
//
// كانت نسخة Pharmacy Net تُسقط أي صفّين متطابقَي القيم بصرف النظر عن الملف،
// فتبتلع عشرات آلاف الطلبيات الحقيقية من ملف واحد بلا أي تداخل أصلاً.
function dedupCrossFile(rows, keyOf) {
  const keyToFileRows = new Map(); // key → Map(uploadedFileId → rows[])
  for (const r of rows) {
    const key = keyOf(r);
    let fileMap = keyToFileRows.get(key);
    if (!fileMap) { fileMap = new Map(); keyToFileRows.set(key, fileMap); }
    const fid = r.uploadedFileId ?? 0;
    const arr = fileMap.get(fid);
    if (arr) arr.push(r); else fileMap.set(fid, [r]);
  }
  const kept = new Set();
  for (const fileMap of keyToFileRows.values()) {
    let best = null;
    for (const fileRows of fileMap.values()) {
      if (!best || fileRows.length > best.length) best = fileRows;
    }
    if (best) for (const r of best) kept.add(r);
  }
  return rows.filter(r => kept.has(r)); // يحافظ على ترتيب الإدخال (saleDate desc)
}

// كل تبويب في الصفحة (الصيدليات/الايتمات) وكل فتح تفصيل صيدلية/ايتم كانا
// يعيدون نفس استعلام المبيعات الكامل للنطاق من الصفر — بما فيه فحص صلاحية
// الملفات و buildItemScopeFilter (الذي بدوره قد يجلب *كل* صفوف Item) — ثم
// يعيدون معالجتها بالكامل في JS (parse + تطبيع + dedup) في كل نقرة. هذا ما
// كان يُشعِر بالبطء عند التنقل بين الصيدليات/المناطق وفتح التفاصيل. الآن
// تُخزَّن نتيجة الجلب (قبل التجميع الخاص بكل تبويب) لمدة قصيرة لكل
// (مستخدم × اختيار ملفات) — فالنقرات المتتالية على نفس الاختيار تصيب
// الكاش بدل تكرار كل الاستعلامات، بلا أي تغيير في منطق dedup/التجميع نفسه.
const SALES_CACHE_TTL_MS = 15000;
const salesCache = new Map(); // `${userId}|${fileIds}` -> { expiresAt, promise }

async function getScopedSales(userId, fileIds) {
  const key = `${userId}|${fileIds || ''}`;
  const hit = salesCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;

  const promise = (async () => {
    const [itemScope, fileScope] = await Promise.all([
      buildItemScopeFilter(userId),
      resolveFileScope(userId, fileIds),
    ]);
    const where = { isHidden: false, ...fileScope, ...itemScope };
    const sales = await prisma.sale.findMany({
      where,
      select: SALE_DETAIL_SELECT,
      orderBy: { saleDate: 'desc' },
    });

    // rawData = صف الإكسل الأصلي كاملاً كـJSON لكل صف. على ملف بـ48 ألف صف هو
    // أضخم ما يُنقل من قاعدة البيانات في كل طلب، ولا يُستعمل إلا كخطة بديلة
    // لاسم الصيدلية حين لا يكون للصف عميل مرتبط. فنجلبه لتلك الصفوف وحدها —
    // وفي ملف يُقرأ فيه عمود العميل صحيحاً لا يُجلب إطلاقاً.
    // (customerId=null هو نفس شرط الخطة البديلة عملياً: findOrCreateCustomer
    // لا يُستدعى إلا باسم غير فارغ، فلا وجود لعميل بلا اسم.)
    let rawById = null;
    if (sales.some(s => !s.customer?.name)) {
      const rawRows = await prisma.sale.findMany({
        where:  { ...where, customerId: null },
        select: { id: true, rawData: true },
      });
      rawById = new Map(rawRows.map(r => [r.id, r.rawData]));
    }

    // اسم الصيدلية يُحسَب مرة واحدة هنا بدل أن يُعاد حسابه (parse + سلسلة ||)
    // لكل صف في كل مسار استهلاك — كان pharmacyDetail وحده يحسبه مرتين لكل صف.
    for (const s of sales) {
      let pharmaName = s.customer?.name || null;
      const rawJson = pharmaName ? null : rawById?.get(s.id);
      if (rawJson) {
        try {
          const raw = JSON.parse(rawJson);
          pharmaName = raw.pharmacyName || raw.pharmacy || raw.customer || raw.Customer || raw['اسم الصيدلية'] || raw['الصيدلية'] || raw['العميل'] || null;
        } catch {}
      }
      s._pharmaName = pharmaName;
    }
    return sales;
  })();

  const entry = { expiresAt: Date.now() + SALES_CACHE_TTL_MS, promise };
  salesCache.set(key, entry);
  promise.catch(() => salesCache.delete(key)); // لا تُخزَّن نتيجة فاشلة
  setTimeout(() => { if (salesCache.get(key) === entry) salesCache.delete(key); }, SALES_CACHE_TTL_MS + 2000);
  return promise;
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

    const sales = await getScopedSales(userId, fileIds);

    // Group by pharmacy name (from customer or rawData)
    const map = new Map(); // pharmacyName → { ... }

    // التكرار يُطوى عبر الملفات المتداخلة فقط — قبل البحث، ليبقى القرار عالمياً
    // لا محصوراً بنتيجة البحث الحالية.
    const deduped = dedupCrossFile(
      sales.filter(s => s._pharmaName),
      s => [norm(s._pharmaName), norm(s.item?.name || ''), dayKey(s.saleDate), s.quantity, s.totalValue, s.recordType || 'sale'].join('|'),
    );

    for (const s of deduped) {
      const pharmaName = s._pharmaName;
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
      const iName = s.item?.name || 'غير محدد';
      if (isReturn) {
        p.returnsOrders++;
        p.returnsQty   += s.quantity;
        p.returnsValue += iqd;
        if (!p.items.has(iName)) p.items.set(iName, { qty: 0, value: 0, count: 0 });
        const ip = p.items.get(iName);
        ip.qty   += s.quantity;
        ip.value += iqd;
        ip.count++;
      } else {
        p.totalOrders++;
        p.totalQty   += s.quantity;
        p.totalValue += iqd;
        if (!p.firstOrder || new Date(s.saleDate) < new Date(p.firstOrder)) p.firstOrder = s.saleDate;
        if (!p.lastOrder  || new Date(s.saleDate) > new Date(p.lastOrder))  p.lastOrder  = s.saleDate;
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
      // كان يُحسب من firstOrder — فيظهر عمود «الأيام» 174 يوماً لصيدلية آخر
      // طلبية لها قبل 16 يوماً، ويُلوّن صيدليات نشطة بالأحمر.
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

    const sales = await getScopedSales(userId, fileIds);

    const rows = sales.filter(s => {
      if (!s._pharmaName || !norm(s._pharmaName).includes(pharmaQuery)) return false;
      if (itemFilter) {
        const iName = s.item?.name || '';
        if (!norm(iName).includes(itemFilter)) return false;
      }
      return true;
    }).map(s => {
      return {
        id: s.id,
        pharmaName: s._pharmaName,
        itemName:   s.item?.name || 'غير محدد',
        areaName:   s.area?.name || '',
        repName:    s.representative?.name || '',
        quantity:   s.quantity,
        totalValue: Math.round(toIQD(s.totalValue, s.uploadedFile)),
        saleDate:   s.saleDate,
        recordType: s.recordType,
        uploadedFileId: s.uploadedFileId,
      };
    });

    // Group by item
    const byItem = new Map();
    const dedupedRows = dedupCrossFile(
      rows,
      r => [norm(r.pharmaName), norm(r.itemName), dayKey(r.saleDate), r.quantity, r.totalValue, r.recordType, norm(r.repName)].join('|'),
    );
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

    const sales = await getScopedSales(userId, fileIds);

    const map = new Map(); // itemName → { pharmacies, totalQty, totalValue, ... }
    const deduped = dedupCrossFile(
      sales,
      s => [norm(s.item?.name || 'غير محدد'), norm(s._pharmaName || ''), dayKey(s.saleDate), s.quantity, s.totalValue].join('|'),
    );
    for (const s of deduped) {
      const iName = s.item?.name || 'غير محدد';
      if (search && !norm(iName).includes(search)) continue;

      const iqdVal = toIQD(s.totalValue, s.uploadedFile);
      if (!map.has(iName)) map.set(iName, { name: iName, pharmacies: new Map(), totalQty: 0, totalValue: 0, firstOrder: s.saleDate, lastOrder: s.saleDate });
      const it = map.get(iName);
      it.totalQty   += s.quantity;
      it.totalValue += iqdVal;
      if (new Date(s.saleDate) < new Date(it.firstOrder)) it.firstOrder = s.saleDate;
      if (new Date(s.saleDate) > new Date(it.lastOrder))  it.lastOrder  = s.saleDate;

      const pharmaName = s._pharmaName || 'غير محدد';

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

    const sales = await getScopedSales(userId, fileIds);

    const filteredRows = sales.filter(s => norm(s.item?.name || '').includes(itemQuery));

    const rows = dedupCrossFile(
      filteredRows,
      s => [norm(s.item?.name || ''), norm(s._pharmaName || ''), dayKey(s.saleDate), s.quantity, s.totalValue, s.recordType, norm(s.representative?.name || '')].join('|'),
    );

    // Group by pharmacy
    const byPharma = new Map();
    for (const s of rows) {
      const pharmaName = s._pharmaName || 'غير محدد';

      if (!byPharma.has(pharmaName)) {
        byPharma.set(pharmaName, {
          name: pharmaName,
          areaName: s.area?.name || '',
          repName: '',
          orders: [],
          totalQty: 0,
          saleQty: 0,
          returnQty: 0,
          totalValue: 0,
          saleValue: 0,
          returnValue: 0,
          orderCount: 0,
          firstOrder: null,
          lastOrder: s.saleDate,
        });
      }
      const p = byPharma.get(pharmaName);
      const iqd2 = Math.round(toIQD(s.totalValue, s.uploadedFile));
      const isReturn = s.recordType === 'return';
      p.orders.push({ date: s.saleDate, qty: s.quantity, value: iqd2, rep: s.representative?.name || '', type: s.recordType });
      p.totalQty   += s.quantity;
      if (!p.areaName && s.area?.name) p.areaName = s.area.name;
      if (!p.repName && s.representative?.name) p.repName = s.representative.name;
      if (isReturn) {
        p.returnQty   += s.quantity;
        p.returnValue += iqd2;
      } else {
        p.saleQty     += s.quantity;
        p.saleValue   += iqd2;
        p.orderCount++;
        if (!p.firstOrder || new Date(s.saleDate) < new Date(p.firstOrder)) p.firstOrder = s.saleDate;
      }
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
    // الحساب في pharmacy-alerts.service.js — مشترك مع المُجدوِل الذي يرسل
    // الإشعارات التلقائية، فلا يختلف ما يُعرض عمّا يُرسَل.
    const thresholdDays = parseInt(req.query.days || '30');
    const alerts = await computePharmacyAlerts(req.user.id, {
      fileIds: req.query.fileIds || null,
      thresholdDays,
    });
    res.json({ alerts, threshold: thresholdDays, total: alerts.length });
  } catch (e) { next(e); }
}
