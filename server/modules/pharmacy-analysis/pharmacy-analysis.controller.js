import { getManagerRoster } from '../../lib/managerRoster.js';
import { computePharmacyAlerts } from './pharmacy-alerts.service.js';
import {
  norm, dedupCrossFile, getScopedSales,
  resolveCompanyItemScope, resolveRepAreaScopeIds, applyRosterFilters,
} from './scoped-sales.js';

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
 * يحوّل قائمة نصوص حدود بحث خام إلى حدود مُحلَّلة: كل نص يُطابَق OR عبر اسم
 * الصيدلية/المنطقة/الايتم/المندوب التجاري مباشرة من صف المبيعة، أو اسم
 * «الشركة الرئيسية»/المندوب العلمي عبر فريق المدير (managerRoster) بنفس نطاق
 * الايتمات/المناطق المستعمل في applyRosterFilters أعلاه — مصدر واحد للمنطق،
 * لا نسخة موازية منه.
 *
 * @returns {Promise<Array<{term:string, itemIds?: number[]|null, areaIds?: Set<number>}>>}
 *   itemIds غائبة = لم يطابق الحدّ اسم شركة، null = طابق شركة بلا تقييد ايتمات.
 */
async function resolveTermsList(rawTerms, user) {
  const terms = [...new Set(rawTerms.map(t => norm(t)).filter(Boolean))];
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

/**
 * فكّ خانة البحث الحرة إلى مرشَّحين: «الأساسي» و«الاحتياطي» عند الحاجة.
 *
 * أغلب أسماء الصيدليات/المناطق هنا مكوَّنة من أكثر من كلمة («طريق السلام»،
 * «حارثية شارع كندي») — فتقسيم كل مسافة إلى حدّ منفصل كان يفكّك اسماً واحداً
 * صحيحاً إلى كلمات OR مستقلة، فيُغرق نتيجة بحث دقيقة بصفوف غير ذات صلة تحوي
 * كلمة واحدة من الاسم فقط (وهذا ما شعر المستخدم أنه «خلل»). الحل: نص بلا
 * فاصلة صريحة يُختبر أولاً كعبارة واحدة كاملة (المرشَّح الأساسي)؛ فإن لم يطابق
 * أي صف إطلاقاً، عندها فقط يُفكَّك لكلماته كحدود OR مستقلة (المرشَّح
 * الاحتياطي) — وهذا بالضبط ما يعنيه «أكثر من اسم بمسافة واحدة». فاصلة صريحة
 * (عربية أو إنجليزية) تبقى نيّة قاطعة بعدة حدود فتُقسَّم عليها فوراً بلا
 * احتياطي.
 *
 * @returns {Promise<{primary: Array, fallback: Array|null}>} كل عنصر بشكل
 *   resolveTermsList أعلاه.
 */
async function resolveSearchCandidates(rawSearch, user) {
  const raw = String(rawSearch || '').trim();
  if (!raw) return { primary: [], fallback: null };

  let primaryStrings, fallbackStrings = null;
  if (/[,،]/.test(raw)) {
    primaryStrings = raw.split(/[,،]+/);
  } else if (/\s/.test(raw)) {
    primaryStrings = [raw];
    fallbackStrings = raw.split(/\s+/);
  } else {
    primaryStrings = [raw];
  }

  const allResolved = await resolveTermsList([...primaryStrings, ...(fallbackStrings || [])], user);
  const byTerm = new Map(allResolved.map(r => [r.term, r]));
  const toResolved = strs => [...new Set(strs.map(s => norm(s)).filter(Boolean))].map(t => byTerm.get(t)).filter(Boolean);

  return {
    primary:  toResolved(primaryStrings),
    fallback: fallbackStrings ? toResolved(fallbackStrings) : null,
  };
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

/** أسماء الصيدليات التي تطابق حدود البحث (أي صف من صفوفها بأي حقل). */
function findMatchingPharmaNames(deduped, searchTerms) {
  const names = new Set();
  for (const s of deduped) {
    if (!names.has(s._pharmaName) && rowMatchesSearch(s, searchTerms)) names.add(s._pharmaName);
  }
  return names;
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
    const userId    = req.user.id;
    const fileIds   = req.query.fileIds || null;
    const search    = req.query.search ? norm(req.query.search) : null;
    const companyId = req.query.companyId ? Number(req.query.companyId) : null;
    const repId     = req.query.repId ? Number(req.query.repId) : null;
    const repUserId = req.query.repUserId ? Number(req.query.repUserId) : null;

    const sales0 = await getScopedSales(userId, fileIds);
    const sales  = await applyRosterFilters(sales0, { companyId, repId, repUserId });

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
    const companyId  = req.query.companyId ? Number(req.query.companyId) : null;
    const repId      = req.query.repId ? Number(req.query.repId) : null;
    const repUserId  = req.query.repUserId ? Number(req.query.repUserId) : null;

    const sales0 = await getScopedSales(userId, fileIds);
    const sales  = await applyRosterFilters(sales0, { companyId, repId, repUserId });

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
      companyId: req.query.companyId ? Number(req.query.companyId) : null,
      repId:     req.query.repId ? Number(req.query.repId) : null,
      repUserId: req.query.repUserId ? Number(req.query.repUserId) : null,
    });
    res.json({ alerts, threshold: thresholdDays, total: alerts.length });
  } catch (e) { next(e); }
}
