import prisma from '../../lib/prisma.js';
import { getManagerRoster } from '../../lib/managerRoster.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';
import { computePharmacyAlerts } from './pharmacy-alerts.service.js';
import { norm, dedupCrossFile, getScopedSales } from './scoped-sales.js';

// ── GET /api/pharmacy-analysis/roster ──────────────────────────
// «الشركة الرئيسية ← المندوب» — نفس فريق المدير المعروض في تحليل الكولات
// (getManagerRoster، مصدر واحد مشترك)، لا كل شركة/مندوب ظهر عرَضاً في ملفات
// الفارمسي نت. قائمة قصيرة ومُنظَّمة بدل كل شركات النظام.
export async function getRoster(req, res, next) {
  try {
    const roster = await getManagerRoster(req.user);
    res.json(roster);
  } catch (e) { next(e); }
}

/**
 * ايتمات نطاق «شركة رئيسية» بعينها: مدير الشركة (company_manager) صاحب
 * التعيين الأساسي (isPrimary) هو مصدر UserItemAssignment — لا مطابقة اسم
 * الشركة في عمود الإكسل. مُستخرَجة لتُستعمل من applyRosterFilters (اختيار
 * الشريط) ومن resolveSearchTerms (كتابة اسم الشركة في خانة البحث) معاً.
 *
 * @returns {Promise<{valid: boolean, itemIds: number[]|null}>} valid=false يعني
 *   شركة بلا مدير قابل للتحديد؛ itemIds=null (مع valid=true) يعني بلا تقييد.
 */
async function resolveCompanyItemScope(companyId) {
  const mgrAssignment = await prisma.userCompanyAssignment.findFirst({
    where: { companyId, isPrimary: true, user: { role: 'company_manager', isActive: true } },
    select: { userId: true },
  });
  if (!mgrAssignment) return { valid: false, itemIds: null };
  const itemIds = await resolveEffectiveItemIds(mgrAssignment.userId);
  return { valid: true, itemIds };
}

/**
 * مناطق «مندوب علمي» بعينه — بنفس منطق توسيع الاسم المطبَّع المستخدم في
 * resolveSciRepSales، لأن نفس المنطقة قد تتكرر بمعرّفات مختلفة عبر
 * الحسابات/الملفات (راجع مذكرة duplicate-area-bug). مُستخرَجة لنفس سبب
 * resolveCompanyItemScope أعلاه.
 */
async function resolveRepAreaScopeIds(repId) {
  const areaLinks = await prisma.scientificRepArea.findMany({ where: { scientificRepId: repId }, select: { areaId: true } });
  const directIds = areaLinks.map(a => a.areaId);
  const areaIdSet = new Set(directIds);
  if (directIds.length > 0) {
    const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
    const directSet = new Set(directIds);
    const assignedNorms = new Set(allAreas.filter(a => directSet.has(a.id)).map(a => norm(a.name)));
    for (const a of allAreas) if (assignedNorms.has(norm(a.name))) areaIdSet.add(a.id);
  }
  return areaIdSet;
}

/**
 * فلترة «الشركة الرئيسية»/«المندوب» على صفوف Sale المُحمَّلة مسبقاً (getScopedSales).
 *
 * كل «شركة» في الشريط هي نطاق مدير شركة (company_manager) بعينه ضمن نفس
 * المكتب — لا نص «الشركة» الحر في عمود الإكسل. اختيار مندوب دون شركة (حسابات
 * بلا هيكل مكتب) يستعمل ايتمات المندوب نفسه.
 *
 * @param {Array} sales
 * @param {{companyId?: number|null, repId?: number|null, repUserId?: number|null}} opts
 */
async function applyRosterFilters(sales, { companyId, repId, repUserId }) {
  let allowedItemIds = null; // null = بلا تقييد
  if (companyId) {
    const scope = await resolveCompanyItemScope(companyId);
    if (!scope.valid) return []; // شركة بلا مدير قابل للتحديد — لا نُظهر بيانات غير موثوقة النطاق
    allowedItemIds = scope.itemIds;
  } else if (repUserId) {
    allowedItemIds = await resolveEffectiveItemIds(repUserId);
  }

  if (allowedItemIds) { // null = بلا تقييد (كل الايتمات)
    const idSet = new Set(allowedItemIds);
    sales = sales.filter(s => idSet.has(s.itemId));
  }

  if (repId) {
    const areaIdSet = await resolveRepAreaScopeIds(repId);
    sales = sales.filter(s => areaIdSet.has(s.areaId));
  }

  return sales;
}

/**
 * فكّ خانة البحث الحرة إلى حدود مستقلة (يفصلها الفاصلة العربية أو
 * الإنجليزية) — «ابحث عن أكثر من اسم دفعة واحدة». كل حدّ يُطابَق OR عبر: اسم
 * الصيدلية/المنطقة/الايتم/المندوب التجاري مباشرة من صف المبيعة، أو اسم
 * «الشركة الرئيسية»/المندوب العلمي عبر فريق المدير (managerRoster) بنفس نطاق
 * الايتمات/المناطق المستعمل في applyRosterFilters أعلاه — مصدر واحد للمنطق،
 * لا نسخة موازية منه.
 *
 * @returns {Promise<Array<{term:string, itemIds?: number[]|null, areaIds?: Set<number>}>>}
 *   itemIds غائبة = لم يطابق الحدّ اسم شركة، null = طابق شركة بلا تقييد ايتمات.
 */
async function resolveSearchTerms(rawSearch, user) {
  const terms = String(rawSearch || '').split(/[,،]+/).map(t => norm(t)).filter(Boolean);
  if (terms.length === 0) return [];

  const { reps, companies } = await getManagerRoster(user);

  return Promise.all(terms.map(async term => {
    const matchedCompanies = companies.filter(c => norm(c.name).includes(term));
    const matchedReps      = reps.filter(r => r.linkedRepId && norm(r.name).includes(term));

    let itemIds; // undefined = لا شركة طابقت؛ null = طابقت شركة بلا تقييد؛ Array = طابقت شركة/أكثر بتقييد
    for (const c of matchedCompanies) {
      const scope = await resolveCompanyItemScope(c.id);
      if (!scope.valid) continue;
      if (scope.itemIds == null) itemIds = null;
      else if (itemIds !== null) itemIds = [...new Set([...(itemIds || []), ...scope.itemIds])];
    }

    let areaIds; // undefined = لا مندوب علمي طابق
    for (const r of matchedReps) {
      const ids = await resolveRepAreaScopeIds(r.linkedRepId);
      areaIds = areaIds ? new Set([...areaIds, ...ids]) : ids;
    }

    return { term, itemIds, areaIds };
  }));
}

/** هل يطابق صف مبيعة واحد أيّاً من حدود البحث (OR بين الحدود، وOR بين حقول كل حدّ)؟ */
function rowMatchesSearch(s, searchTerms) {
  if (searchTerms.length === 0) return true;
  const normArea = norm(s._areaName);
  return searchTerms.some(({ term, itemIds, areaIds }) => {
    if (s._normPharma.includes(term)) return true;
    if (normArea.includes(term)) return true;
    if (s._normItem.includes(term)) return true;
    if (s._normRep.includes(term)) return true;
    if (itemIds !== undefined && (itemIds === null || itemIds.includes(s.itemId))) return true;
    if (areaIds && areaIds.has(s.areaId)) return true;
    return false;
  });
}

// ── GET /api/pharmacy-analysis/pharmacies ─────────────────────
export async function listPharmacies(req, res, next) {
  try {
    const userId    = req.user.id;
    const fileIds   = req.query.fileIds || null;
    const companyId = req.query.companyId ? Number(req.query.companyId) : null;
    const repId     = req.query.repId ? Number(req.query.repId) : null;
    const repUserId = req.query.repUserId ? Number(req.query.repUserId) : null;

    const tStart = Date.now();
    const [sales0, searchTerms] = await Promise.all([
      getScopedSales(userId, fileIds),
      resolveSearchTerms(req.query.search, req.user),
    ]);
    const tLoad = Date.now();

    const sales = await applyRosterFilters(sales0, { companyId, repId, repUserId });

    // Group by pharmacy name (from customer or rawData)
    const map = new Map(); // pharmacyName → { ... }

    // التكرار يُطوى عبر الملفات المتداخلة فقط — قبل البحث، ليبقى القرار عالمياً
    // لا محصوراً بنتيجة البحث الحالية.
    const deduped = dedupCrossFile(
      sales.filter(s => s._pharmaName),
      s => [s._normPharma, s._normItem, s._day, s.quantity, s.totalValue, s.recordType || 'sale'].join('|'),
    );
    const tDedup = Date.now();

    // بحث ذكي متعدد الحدود: يحدَّد أولاً أي الصيدليات «تطابق» (عبر أي صف من
    // صفوفها بأي حقل)، ثم يُبنى إجمالي كل صيدلية مطابقة من كل صفوفها كاملة —
    // لا من الصفوف المطابقة وحدها، فلا يظهر إجمالي جزئي (مثلاً: قيمة ايتم واحد
    // فقط) حين يكون سبب المطابقة ايتماً أو مندوباً لا اسم الصيدلية نفسه.
    let matchingPharmaNames = null;
    if (searchTerms.length > 0) {
      matchingPharmaNames = new Set();
      for (const s of deduped) {
        if (!matchingPharmaNames.has(s._pharmaName) && rowMatchesSearch(s, searchTerms)) {
          matchingPharmaNames.add(s._pharmaName);
        }
      }
    }

    for (const s of deduped) {
      const pharmaName = s._pharmaName;
      const areaName = s._areaName;

      if (matchingPharmaNames && !matchingPharmaNames.has(pharmaName)) continue;

      if (!map.has(pharmaName)) {
        map.set(pharmaName, {
          name: pharmaName,
          areaName,
          repName: s._repName,
          totalOrders: 0,
          totalQty: 0,
          totalValue: 0,
          returnsOrders: 0,
          returnsQty: 0,
          returnsValue: 0,
          firstOrder: null,
          lastOrder: null,
          firstTs: Infinity,
          lastTs: -Infinity,
          items: new Map(), // itemName → { qty, value, count }
        });
      }
      const p = map.get(pharmaName);
      const iqd = s._iqd;
      if (!p.areaName && areaName) p.areaName = areaName;
      if (!p.repName && s._repName) p.repName = s._repName;

      const isReturn = s._isReturn;
      const iName = s._itemName || 'غير محدد';
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
        if (s._ts < p.firstTs) { p.firstTs = s._ts; p.firstOrder = s.saleDate; }
        if (s._ts > p.lastTs)  { p.lastTs  = s._ts; p.lastOrder  = s.saleDate; }
        if (!p.items.has(iName)) p.items.set(iName, { qty: 0, value: 0, count: 0 });
        const ip = p.items.get(iName);
        ip.qty   += s.quantity;
        ip.value += iqd;
        ip.count++;
      }
    }

    const tAgg = Date.now();
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
      daysSinceLast: p.lastOrder ? Math.floor((now - p.lastTs) / 86400000) : 9999,
      topItems: [...p.items.entries()]
        .sort((a, b) => b[1].qty - a[1].qty)
        .slice(0, 5)
        .map(([name, d]) => ({ name, qty: d.qty, value: Math.round(d.value), count: d.count })),
    })).sort((a, b) => b.totalValue - a.totalValue);

    const payload = JSON.stringify({ pharmacies: result, total: result.length });
    const tDone = Date.now();
    console.log(`[pharmacy-net:list] load=${tLoad - tStart}ms dedup=${tDedup - tLoad}ms agg=${tAgg - tDedup}ms build+json=${tDone - tAgg}ms payload=${Math.round(payload.length / 1024)}KB pharmacies=${result.length}`);
    res.type('application/json').send(payload);
  } catch (e) { next(e); }
}

// ── GET /api/pharmacy-analysis/pharmacy/:name ─────────────────
export async function pharmacyDetail(req, res, next) {
  try {
    const userId      = req.user.id;
    const pharmaQuery = norm(req.params.name);
    const fileIds     = req.query.fileIds || null;
    const itemFilter  = req.query.item ? norm(req.query.item) : null;
    const companyId   = req.query.companyId ? Number(req.query.companyId) : null;
    const repId       = req.query.repId ? Number(req.query.repId) : null;
    const repUserId   = req.query.repUserId ? Number(req.query.repUserId) : null;

    let sales = await getScopedSales(userId, fileIds);
    sales = await applyRosterFilters(sales, { companyId, repId, repUserId });

    const matching = sales.filter(s => {
      if (!s._pharmaName || !s._normPharma.includes(pharmaQuery)) return false;
      if (itemFilter && !s._normItem.includes(itemFilter)) return false;
      return true;
    });

    const dedupedRows = dedupCrossFile(
      matching,
      s => [s._normPharma, s._normItem, s._day, s.quantity, Math.round(s._iqd), s.recordType, s._normRep].join('|'),
    ).map(s => ({
      id: s.id,
      pharmaName: s._pharmaName,
      itemName:   s._itemName || 'غير محدد',
      areaName:   s._areaName,
      repName:    s._repName,
      quantity:   s.quantity,
      totalValue: Math.round(s._iqd),
      saleDate:   s.saleDate,
      recordType: s.recordType,
      uploadedFileId: s.uploadedFileId,
    }));

    // Group by item
    const byItem = new Map();
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
      s => [s._normItem, s._normPharma, s._day, s.quantity, s.totalValue].join('|'),
    );
    for (const s of deduped) {
      const iName = s._itemName || 'غير محدد';
      if (search && !s._normItem.includes(search)) continue;

      const iqdVal = s._iqd;
      if (!map.has(iName)) map.set(iName, { name: iName, pharmacies: new Map(), totalQty: 0, totalValue: 0, firstOrder: s.saleDate, lastOrder: s.saleDate, firstTs: s._ts, lastTs: s._ts });
      const it = map.get(iName);
      it.totalQty   += s.quantity;
      it.totalValue += iqdVal;
      if (s._ts < it.firstTs) { it.firstTs = s._ts; it.firstOrder = s.saleDate; }
      if (s._ts > it.lastTs)  { it.lastTs  = s._ts; it.lastOrder  = s.saleDate; }

      const pharmaName = s._pharmaName || 'غير محدد';

      if (!it.pharmacies.has(pharmaName)) it.pharmacies.set(pharmaName, { name: pharmaName, areaName: s._areaName, qty: 0, value: 0 });
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

    const filteredRows = sales.filter(s => s._normItem.includes(itemQuery));

    const rows = dedupCrossFile(
      filteredRows,
      s => [s._normItem, s._normPharma, s._day, s.quantity, s.totalValue, s.recordType, s._normRep].join('|'),
    );

    // Group by pharmacy
    const byPharma = new Map();
    for (const s of rows) {
      const pharmaName = s._pharmaName || 'غير محدد';

      if (!byPharma.has(pharmaName)) {
        byPharma.set(pharmaName, {
          name: pharmaName,
          areaName: s._areaName,
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
          firstTs: Infinity,
          lastOrder: s.saleDate,
          lastTs: s._ts,
        });
      }
      const p = byPharma.get(pharmaName);
      const iqd2 = Math.round(s._iqd);
      const isReturn = s._isReturn;
      p.orders.push({ date: s.saleDate, qty: s.quantity, value: iqd2, rep: s._repName, type: s.recordType });
      p.totalQty   += s.quantity;
      if (!p.areaName && s._areaName) p.areaName = s._areaName;
      if (!p.repName && s._repName) p.repName = s._repName;
      if (isReturn) {
        p.returnQty   += s.quantity;
        p.returnValue += iqd2;
      } else {
        p.saleQty     += s.quantity;
        p.saleValue   += iqd2;
        p.orderCount++;
        if (s._ts < p.firstTs) { p.firstTs = s._ts; p.firstOrder = s.saleDate; }
      }
      p.totalValue += iqd2;
      if (s._ts > p.lastTs) { p.lastTs = s._ts; p.lastOrder = s.saleDate; }
    }

    res.json({
      itemName:     req.params.name,
      totalOrders:  rows.length,
      pharmacies:   [...byPharma.values()]
        .sort((a, b) => b.totalQty - a.totalQty)
        .map(({ firstTs, lastTs, ...p }) => p), // حقول داخلية للمقارنة فقط
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
