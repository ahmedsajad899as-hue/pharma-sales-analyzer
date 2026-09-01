/**
 * Stock Ledger Service — دفتر رصيد المذاخر
 *
 *   المتبقي = آخر ستوك افتتاحي مرفوع
 *           + التعزيزات الداخلة للمذخر بعد تاريخه
 *           − المبيع الخارج من المذخر إلى الصيدليات بعد تاريخه
 *
 * مبدأ التنفيذ: StockBalance مُشتق بالكامل. كل عملية (رفع/حذف/إدخال يدوي)
 * تنتهي بـ recomputeBalances() التي تعيد بناء الأرصدة من الصفر من StockMovement،
 * فلا يوجد تعديل تراكمي يمكن أن ينحرف.
 */

import * as XLSX from 'xlsx';
import prisma from '../../lib/prisma.js';
import {
  resolveColumns, detectHeaderRow, parseNumeric, parseExcelDate,
} from '../sales/sales.service.js';
import {
  normalizeArabic, normalizeAreaName, normalizeItemKey,
  loadResolutionContext, resolveItemName,
} from '../../lib/itemResolver.js';
import { areSimilar, similarity } from '../../lib/fuzzyMatch.js';
import { flattenStockMatrix } from '../../lib/stockMatrix.js';
import { isPlaceholderCompanyValue } from '../../lib/companyResolver.js';
import * as repo from './stock-ledger.repository.js';

// COLUMN_ALIASES.customer يضع «صيدلية/زبون» قبل «مذخر»، وresolveColumns يأخذ أول
// تطابق — فملف فيه العمودان معاً يُرجِع الصيدلية. لذلك للمذخر قائمة خاصة تُفحص أولاً.
const WAREHOUSE_ALIASES = [
  'المذخر', 'مذخر', 'اسم المذخر', 'المخزن', 'مخزن', 'اسم المخزن',
  'المستودع', 'مستودع', 'اسم المستودع', 'المجهز', 'اسم المجهز',
  'warehouse', 'warehouse name', 'store', 'store name', 'depot', 'depot name',
];

const DIRECTIONS = { baseline: 'baseline', in: 'in', out: 'out' };

// ═══════════════════════════════════════════════════════════════
//  1. تحليل ملف الحركات (صيغة طولية)
// ═══════════════════════════════════════════════════════════════

/** يبحث عن ترويسة المذخر بالتطابق التام ثم الجزئي، وإلا يعود لـ customer العام */
function resolveWarehouseCol(headers, fallbackCustomerCol) {
  const lower = headers.map(h => String(h).toLowerCase().trim());
  const aliases = WAREHOUSE_ALIASES.map(a => a.toLowerCase().trim());
  const exact = lower.findIndex(h => aliases.includes(h));
  if (exact !== -1) return headers[exact];
  const partial = lower.findIndex(h => aliases.some(a => h.includes(a)));
  if (partial !== -1) return headers[partial];
  return fallbackCustomerCol;
}

/**
 * يحلّل ملف Excel طولي: المذخر | المنطقة | الشركة | الايتم | الكمية | التاريخ
 * @returns {{rows: object[], headers: string[], colMap: object, skipped: number}}
 */
export function parseMovementFile(buffer, defaultDate) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], headers: [], colMap: {}, skipped: 0 };

  // يتخطى صفوف العنوان/الشعار التي تسبق الترويسة الحقيقية
  const headerRow = detectHeaderRow(ws, {});
  const json = XLSX.utils.sheet_to_json(ws, { range: headerRow, defval: '' });
  if (!json.length) return { rows: [], headers: [], colMap: {}, skipped: 0 };

  const headers = Object.keys(json[0]);
  const cm = resolveColumns(headers, {});
  const whCol = resolveWarehouseCol(headers, cm.customer);
  const colMap = {
    warehouse: whCol, region: cm.area, item: cm.item,
    quantity: cm.quantity, company: cm.company, date: cm.date,
  };

  const rows = [];
  let skipped = 0;
  for (const raw of json) {
    const warehouse = String(raw[whCol] ?? '').trim();
    const itemName = String(raw[cm.item] ?? '').trim();
    const qty = Math.abs(parseNumeric(raw[cm.quantity]));
    if (!warehouse || !itemName || qty <= 0) { skipped++; continue; }
    rows.push({
      warehouse,
      region: String(raw[cm.area] ?? '').trim(),
      itemName,
      companyName: (raw[cm.company] && !isPlaceholderCompanyValue(raw[cm.company])) ? String(raw[cm.company]).trim() : null,
      qty,
      movementDate: parseExcelDate(raw[cm.date]) ?? defaultDate,
      rawRow: raw,
    });
  }
  return { rows, headers, colMap, skipped };
}

// ═══════════════════════════════════════════════════════════════
//  2. مطابقة المذاخر
// ═══════════════════════════════════════════════════════════════

const whKey = (s) => normalizeArabic(String(s ?? '')).toLowerCase();
const regKey = (s) => normalizeAreaName(String(s ?? '')) || '';

/**
 * منطقة «فاسدة»: بقايا خلل تحليل قديم انجمدت في StockWarehouse.region ولا تُصحَّح
 * تلقائياً بعدها أبداً (المطابقة بالاسم تعيد استعمال السجل القديم كما هو). الأنماط:
 * فارغة/'غير محدد'، أو شظية حرف واحد/حرفين من دمج خلايا فاشل (راجع stockParser.ts)،
 * أو عنوان/اسم ملف الستوك نفسه استُعمل احتياطياً بدل اسم منطقة حقيقي ("ستوك ...").
 */
function looksLikeBadRegion(region) {
  const r = String(region ?? '').trim();
  if (!r || r === 'غير محدد') return true;
  if (r.length <= 2) return true;
  // \b لا يعمل بعد حرف عربي (\w في JS لا يشمل العربية) — لهذا فحص مسافة/نهاية صريح
  if (/^ستوك(?:\s|$)/.test(r)) return true;
  return false;
}

/**
 * قاموس مذاخر قابل للتوسع أثناء الاستيراد.
 * المطابقة: (المنطقة + الاسم) تام ← الاسم تام ووحيد بغضّ النظر عن المنطقة
 * ← تشابه داخل نفس المنطقة ← إنشاء جديد.
 * الصفوف غير المطابقة لا تُسقط أبداً: يُنشأ لها مذخر وتُبلَّغ للمراجعة.
 */
function makeWarehouseResolver(existing, userId) {
  const byKey = new Map();     // `${regionKey}||${nameKey}` ← warehouse
  const byRegion = new Map();  // regionKey ← warehouse[]
  const toCreate = [];
  const toHeal = new Map();    // warehouseId ← warehouse (منطقته صُحّحت، تحتاج تحديث بقاعدة البيانات)
  const fuzzyLinked = [];
  const created = [];

  const index = (w) => {
    byKey.set(w.regionKey + '||' + w.nameKey, w);
    if (!byRegion.has(w.regionKey)) byRegion.set(w.regionKey, []);
    byRegion.get(w.regionKey).push(w);
  };
  for (const w of existing) index(w);

  /**
   * تصحيح ذاتي: مذخر موجود منطقته فاسدة (مجمّدة من استيراد قديم معطوب)، وهذا الصف
   * يحمل منطقة صريحة وسليمة لنفس المذخر — يُصحَّح فوراً بدل تجميد الخطأ للأبد.
   * لا يُصحَّح إن كانت المنطقة الحالية تبدو سليمة أصلاً (تفادي التذبذب بين صياغتين).
   */
  function maybeHeal(w, rawRegion) {
    if (!w.id) return; // مذخر معلّق لم يُنشأ بعد — سيُنشأ بمنطقته الصحيحة مباشرة
    const incoming = String(rawRegion ?? '').trim();
    if (!incoming || looksLikeBadRegion(incoming) || !looksLikeBadRegion(w.region)) return;
    w.region = incoming;
    w.regionKey = regKey(incoming);
    toHeal.set(w.id, w);
  }

  function resolve(name, region) {
    const nk = whKey(name);
    const rk = regKey(region);
    if (!nk) return null;

    const exact = byKey.get(rk + '||' + nk);
    if (exact) return exact;

    // نص «المنطقة» غير موحّد بين المصادر: الستوك الافتتاحي يأخذه حرفياً من عنوان
    // عمود ملف Stock (قد يكون "ستوك العمارة 15-5")، بينما ملف الحركات أو الإدخال
    // اليدوي غالباً يكتب نصاً أبسط ("العمارة") أو يتركه فارغاً. طالما اسم المذخر
    // نفسه مطابق تماماً ووحيد في كل حسابات المستخدم، هذا التفاوت في نص المنطقة
    // وحده لا يجب أن يُنشئ مذخراً مكرراً بلا ستوك افتتاحي. عند وجود أكثر من مذخر
    // بهذا الاسم في مناطق مختلفة (لبس حقيقي) يستمر للمطابقة بالتشابه ثم الإنشاء.
    const sameName = [...byKey.values()].filter(w => w.nameKey === nk);
    if (sameName.length === 1) {
      maybeHeal(sameName[0], region);
      return sameName[0];
    }

    // تشابه داخل نفس المنطقة — يُقبل فقط عند وجود مرشّح واحد
    const pool = rk ? (byRegion.get(rk) ?? []) : [...byKey.values()];
    const cands = pool.filter(w => areSimilar(name, w.name));
    if (cands.length === 1) {
      fuzzyLinked.push({
        raw: region ? name + ' (' + region + ')' : name,
        matchedTo: cands[0].name + ' — ' + cands[0].region,
      });
      maybeHeal(cands[0], region);
      return cands[0];
    }

    // مذخر جديد — يُنشأ ويُبلَّغ عنه للمراجعة مع أقرب الأسماء
    const suggestions = pool
      .map(w => ({ name: w.name, region: w.region, score: similarity(name, w.name) }))
      .filter(s => s.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const pending = {
      id: null, userId, name: String(name).trim(), nameKey: nk,
      region: String(region ?? '').trim() || 'غير محدد', regionKey: rk,
    };
    index(pending);
    toCreate.push(pending);
    created.push({ name: pending.name, region: pending.region, suggestions });
    return pending;
  }

  /** ينشئ المذاخر الجديدة في قاعدة البيانات، ويحفظ تصحيحات المنطقة الذاتية */
  async function flush() {
    for (const w of toCreate) {
      if (w.id) continue;
      const row = await prisma.stockWarehouse.upsert({
        where: { userId_regionKey_nameKey: { userId, regionKey: w.regionKey, nameKey: w.nameKey } },
        update: {},
        create: { userId, name: w.name, nameKey: w.nameKey, region: w.region, regionKey: w.regionKey },
      });
      w.id = row.id;
    }
    for (const w of toHeal.values()) {
      await prisma.stockWarehouse.update({
        where: { id: w.id },
        data: { region: w.region, regionKey: w.regionKey },
      });
    }
  }

  return { resolve, flush, report: () => ({ fuzzyLinked, created, healed: [...toHeal.values()].map(w => ({ name: w.name, region: w.region })) }) };
}

// ═══════════════════════════════════════════════════════════════
//  3. الاستيعاب (ingestion) — مسار موحّد لكل المصادر
// ═══════════════════════════════════════════════════════════════

/**
 * @param {object}   p
 * @param {number}   p.userId
 * @param {'baseline'|'in'|'out'} p.kind
 * @param {string}   p.name          اسم الدفعة
 * @param {Date}     p.movementDate  تاريخ سريان الدفعة
 * @param {number?}  p.sourceFileId  SalesDataFile المصدر (للستوك الافتتاحي)
 * @param {Array}    p.rows          {warehouse, region, itemName, companyName, qty, movementDate?, rawRow?}
 */
export async function ingestRows({ userId, kind, name, movementDate, sourceFileId = null, rows }) {
  const direction = DIRECTIONS[kind];
  if (!direction) throw new Error('نوع الدفعة غير صالح');
  if (!rows.length) throw new Error('لا توجد صفوف صالحة في الملف');

  const existing = await repo.getWarehouses(userId);
  const wh = makeWarehouseResolver(existing, userId);

  // ربط الايتمات بكتالوج الشركة — نفس محرّك ملفات المبيعات، فتلتقي أسماء الستوك
  // وأسماء المبيعات على نفس Item.id. وitemKey يبقى مفتاح المطابقة الفعلي حتى لو
  // لم يوجد الايتم في الكتالوج.
  let ctx = { catalog: [], catalogById: new Map(), aliasMap: new Map() };
  try {
    const assigns = await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
    ctx = await loadResolutionContext({ scientificCompanyIds: assigns.map(a => a.companyId), userId });
  } catch { /* الكتالوج اختياري */ }

  const itemIdCache = new Map();
  async function linkItem(itemName) {
    const key = normalizeItemKey(itemName);
    if (itemIdCache.has(key)) return itemIdCache.get(key);
    let itemId = null;
    try {
      const r = await resolveItemName(itemName, ctx);
      if (r?.canonicalItem && ['alias', 'exact', 'high'].includes(r.confidence)) itemId = r.canonicalItem.id;
    } catch { /* لا يمنع الاستيراد */ }
    itemIdCache.set(key, itemId);
    return itemId;
  }

  const prepared = [];
  for (const r of rows) {
    const w = wh.resolve(r.warehouse, r.region);
    if (!w) continue;
    prepared.push({
      w,
      itemKey: normalizeItemKey(r.itemName),
      itemName: String(r.itemName).trim(),
      companyName: r.companyName ?? null,
      itemId: await linkItem(r.itemName),
      qty: r.qty,
      movementDate: r.movementDate ?? movementDate,
      rawRow: r.rawRow ? JSON.stringify(r.rawRow) : null,
    });
  }
  await wh.flush();

  const batch = await repo.createBatch({ userId, kind, name, sourceFileId, movementDate });
  const movements = prepared.map(p => ({
    batchId: batch.id, userId, warehouseId: p.w.id,
    itemKey: p.itemKey, itemName: p.itemName, companyName: p.companyName, itemId: p.itemId,
    qty: p.qty, direction, movementDate: p.movementDate, rawRow: p.rawRow,
  }));
  await repo.bulkInsertMovements(movements);

  const warehouseIds = [...new Set(movements.map(m => m.warehouseId))];
  await recomputeBalances(userId, warehouseIds);

  // تقرير المراجعة: مذاخر جديدة، مذاخر رُبطت بالتشابه، وايتمات تحرّكت بلا ستوك افتتاحي
  const unmatched = { ...wh.report(), itemsWithoutBaseline: [] };
  if (direction !== 'baseline' && warehouseIds.length) {
    const orphans = await prisma.stockBalance.findMany({
      where: { userId, warehouseId: { in: warehouseIds }, openingAt: null },
      select: { itemName: true, outQty: true, warehouse: { select: { name: true, region: true } } },
      take: 200,
    });
    unmatched.itemsWithoutBaseline = orphans.map(o => ({
      itemName: o.itemName, warehouse: o.warehouse.name, region: o.warehouse.region, qty: o.outQty,
    }));
  }
  const hasIssues = unmatched.created.length || unmatched.fuzzyLinked.length || unmatched.itemsWithoutBaseline.length || unmatched.healed.length;
  await repo.finalizeBatch(batch.id, { rowCount: movements.length, unmatched: hasIssues ? unmatched : null });

  return {
    batchId: batch.id,
    rowCount: movements.length,
    warehouseCount: warehouseIds.length,
    unmatched: hasIssues ? unmatched : null,
  };
}

/** استيراد الستوك الافتتاحي من ملف Stock موجود (SalesDataFile) */
export async function ingestBaselineFromStockFile({ userId, salesDataFileId, movementDate }) {
  const file = await prisma.salesDataFile.findFirst({ where: { id: salesDataFileId, userId } });
  if (!file) throw new Error('الملف غير موجود');
  const rows = flattenStockMatrix(file);
  if (!rows.length) throw new Error('لم يُعثر على كميات في هذا الملف');
  return ingestRows({
    userId, kind: 'baseline',
    name: 'ستوك افتتاحي: ' + file.name,
    movementDate, sourceFileId: file.id, rows,
  });
}

// ═══════════════════════════════════════════════════════════════
//  4. إعادة حساب الأرصدة — قلب الميزة
// ═══════════════════════════════════════════════════════════════

const pairId = (warehouseId, itemKey) => warehouseId + String.fromCharCode(0) + itemKey;

/**
 * يعيد بناء StockBalance من الصفر لنطاق المذاخر المحدد (أو كل مذاخر المستخدم).
 *
 * لكل زوج (مذخر + ايتم):
 *   opening/openingAt = أحدث حركة baseline (بالتاريخ ثم بالـ id عند التساوي)
 *   inQty / outQty    = مجموع الحركات من openingAt فصاعداً (أو الكل إن لا افتتاحي)
 *   remaining         = opening + inQty − outQty
 *
 * هذا يحقق «التصفير الجزئي»: ستوك جديد لزوج ⟵ يصير هو الافتتاحي وتُهمل الحركات
 * الأقدم منه؛ والأزواج غير الواردة في الملف الجديد لا تتأثر لأن آخر baseline لها
 * لم يتغيّر.
 */
export function computeBalanceRows(userId, baselineRows, flowRows) {
  const base = new Map();
  for (const m of baselineRows) {
    const k = pairId(m.warehouseId, m.itemKey);
    const prev = base.get(k);
    const newer = !prev
      || m.movementDate > prev.openingAt
      || (+m.movementDate === +prev.openingAt && m.id > prev.sortId);
    if (newer) {
      base.set(k, {
        warehouseId: m.warehouseId, itemKey: m.itemKey, itemName: m.itemName,
        companyName: m.companyName, itemId: m.itemId,
        opening: m.qty, openingAt: m.movementDate, sortId: m.id,
      });
    }
  }

  const agg = new Map();
  for (const m of flowRows) {
    const k = pairId(m.warehouseId, m.itemKey);
    const b = base.get(k);
    if (b && m.movementDate < b.openingAt) continue; // أقدم من الافتتاحي ⟵ يُهمل
    let a = agg.get(k);
    if (!a) {
      a = {
        warehouseId: m.warehouseId, itemKey: m.itemKey, itemName: m.itemName,
        companyName: m.companyName, itemId: m.itemId,
        inQty: 0, outQty: 0, lastMovementAt: m.movementDate,
      };
      agg.set(k, a);
    }
    if (m.direction === 'in') a.inQty += m.qty; else a.outQty += m.qty;
    if (m.movementDate > a.lastMovementAt) a.lastMovementAt = m.movementDate;
  }

  const rows = [];
  for (const k of new Set([...base.keys(), ...agg.keys()])) {
    const b = base.get(k);
    const a = agg.get(k);
    const src = b ?? a;
    const opening = b?.opening ?? 0;
    const inQty = a?.inQty ?? 0;
    const outQty = a?.outQty ?? 0;
    rows.push({
      userId,
      warehouseId: src.warehouseId,
      itemKey: src.itemKey,
      // الاسم/الشركة من الافتتاحي أولاً (أدق)، وإلا من الحركة
      itemName: b?.itemName ?? a?.itemName ?? src.itemKey,
      companyName: b?.companyName ?? a?.companyName ?? null,
      itemId: b?.itemId ?? a?.itemId ?? null,
      opening,
      openingAt: b?.openingAt ?? null,
      inQty,
      outQty,
      remaining: opening + inQty - outQty,
      lastMovementAt: a?.lastMovementAt ?? b?.openingAt ?? null,
    });
  }
  return rows;
}

/** يقرأ حركات النطاق على دفعات (حدّ للذاكرة) ثم يستدعي الحساب النقي */
export async function recomputeBalances(userId, warehouseIds = null) {
  const scope = { userId, ...(warehouseIds?.length ? { warehouseId: { in: warehouseIds } } : {}) };
  const CHUNK = 5000;
  const SELECT = {
    id: true, warehouseId: true, itemKey: true, itemName: true,
    companyName: true, itemId: true, qty: true, movementDate: true, direction: true,
  };

  const scanAll = async (where) => {
    const out = [];
    let cursor = 0;
    for (;;) {
      const page = await prisma.stockMovement.findMany({
        where, select: SELECT, orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: CHUNK,
      });
      if (!page.length) break;
      out.push(...page);
      cursor = page[page.length - 1].id;
      if (page.length < CHUNK) break;
    }
    return out;
  };

  const [baselineRows, flowRows] = await Promise.all([
    scanAll({ ...scope, direction: 'baseline' }),
    scanAll({ ...scope, direction: { in: ['in', 'out'] } }),
  ]);

  const rows = computeBalanceRows(userId, baselineRows, flowRows);

  // استبدال ذرّي: حذف النطاق ثم إعادة الإدراج — الأرصدة مُشتقة بالكامل
  const ops = [prisma.stockBalance.deleteMany({ where: scope })];
  for (let i = 0; i < rows.length; i += 2000) {
    ops.push(prisma.stockBalance.createMany({ data: rows.slice(i, i + 2000) }));
  }
  await prisma.$transaction(ops);
  return rows.length;
}

// ═══════════════════════════════════════════════════════════════
//  5. التنبيهات
// ═══════════════════════════════════════════════════════════════

/**
 * نفس تسمية الشدة المستعملة في «رادار النقص» بصفحة Stock.
 * التنبيه يُطلق بالنسبة من الستوك الأصلي أو بالكمية الثابتة — أيهما تحقق أولاً.
 */
export function severityOf(remaining, opening, { pct, qty }) {
  if (remaining <= 0) return 'out';
  if (remaining <= qty / 2) return 'critical';
  if (remaining <= qty) return 'low';
  if (opening > 0 && remaining <= opening * (pct / 100)) return 'low';
  return null;
}

const SEV_ORDER = { out: 0, critical: 1, low: 2 };

/** الايتمات التي يجب عمل طلبية جديدة لها، مجمّعة حسب المذخر */
export async function buildAlerts(userId, { pct = 20, qty = 10, region = null, warehouseId = null } = {}) {
  const balances = await prisma.stockBalance.findMany({
    where: {
      userId,
      ...(warehouseId ? { warehouseId } : {}),
      ...(region ? { warehouse: { region } } : {}),
    },
    include: { warehouse: { select: { id: true, name: true, region: true } } },
  });

  const byWarehouse = new Map();
  const totals = { out: 0, critical: 0, low: 0 };

  for (const b of balances) {
    const sev = severityOf(b.remaining, b.opening, { pct, qty });
    if (!sev) continue;
    totals[sev]++;
    if (!byWarehouse.has(b.warehouseId)) {
      byWarehouse.set(b.warehouseId, {
        warehouseId: b.warehouseId, warehouse: b.warehouse.name, region: b.warehouse.region,
        items: [], counts: { out: 0, critical: 0, low: 0 },
      });
    }
    const g = byWarehouse.get(b.warehouseId);
    g.counts[sev]++;
    g.items.push({
      itemKey: b.itemKey, itemName: b.itemName, companyName: b.companyName,
      opening: b.opening, inQty: b.inQty, outQty: b.outQty, remaining: b.remaining,
      // الكمية المقترحة للطلبية = ما استُهلك فعلاً منذ الستوك الافتتاحي
      suggestedQty: Math.max(0, Math.round(b.opening + b.inQty - b.remaining)),
      pctLeft: b.opening > 0 ? Math.round((b.remaining / b.opening) * 100) : 0,
      lastMovementAt: b.lastMovementAt,
      severity: sev,
    });
  }

  const groups = [...byWarehouse.values()];
  for (const g of groups) {
    g.items.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.remaining - b.remaining);
    g.total = g.items.length;
  }
  groups.sort((a, b) =>
    (b.counts.out - a.counts.out)
    || (b.counts.critical - a.counts.critical)
    || String(a.region).localeCompare(String(b.region), 'ar')
    || String(a.warehouse).localeCompare(String(b.warehouse), 'ar'));

  return {
    groups, totals,
    totalItems: totals.out + totals.critical + totals.low,
    thresholds: { pct, qty },
  };
}

/** حذف دفعة ثم إعادة حساب المذاخر التي كانت تخصّها */
export async function removeBatch(userId, batchId) {
  const batch = await repo.getBatchById(batchId, userId);
  if (!batch) throw new Error('الدفعة غير موجودة');
  const warehouseIds = await repo.getBatchWarehouseIds(batchId);
  await repo.deleteBatch(batchId, userId);
  await recomputeBalances(userId, warehouseIds);
  return { warehouseIds };
}
