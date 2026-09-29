/**
 * Stock Flow Service — «تحريك المذاخر»
 *
 * لكل زوج (مذخر × ايتم): كل عدّتين متتاليتين (بالتاريخ) من StockCount تشكّلان
 * دورة واحدة — الأولى = الستوك الافتتاحي، الثانية = الستوك الثانوي:
 *   الكمية المتحركة = الافتتاحي + التعزيز − الثانوي
 *   التعزيز يُشتق تلقائياً من StockMovement (direction='in', صفحة رصيد
 *   المذاخر) الواقعة بين تاريخي العدّتين لنفس الزوج — بلا إدخال مكرَّر.
 *   مباشر (مذخر) = المتحركة − تجاري − علمي (تجاري/علمي تُرفعان بملف Excel
 *   مستقل لكل فريق، ويُربطان بالدورة عبر WarehouseTeamSale.asOfDate = تاريخ
 *   العدّة الختامية للدورة).
 *
 * الاستيراد (ستوك افتتاحي/ثانوي أو مبيعات فريق) يُعيد استعمال محرّكيّ المطابقة
 * الكاملين من «رصيد المذاخر»: مذاخر (classifyWarehouseRows/makeWarehouseResolver)
 * وايتمات+شركات+ميركاتو معاً (classifyMovementRows)، وقارئيّ الملفات
 * (parseMovementFile للملف الطولي، readStockFileRows لملف Stock الموجود سلفاً
 * بصفحة «ستوك المذاخر») — هوية مذخر/ايتم واحدة موحّدة في كل الصفحة، بلا محرّك
 * مطابقة مواز يمكن أن ينحرف عنه.
 */

import prisma from '../../lib/prisma.js';
import {
  classifyMovementRows, makeWarehouseResolver, parseMovementFile, readStockFileRows,
} from '../stock-ledger/stock-ledger.service.js';
import { getWarehouses } from '../stock-ledger/stock-ledger.repository.js';
import { loadResolutionContext, resolveItemName, normalizeItemKey } from '../../lib/itemResolver.js';
import * as repo from './stock-flow.repository.js';

export const TEAMS = new Set(['commercial', 'scientific']);

// ═══════════════════════════════════════════════════════════════
//  1. تحليل الملفات — إعادة استعمال محرّكيّ «رصيد المذاخر» كما هما
// ═══════════════════════════════════════════════════════════════
/** ملف طولي (مذخر/منطقة/شركة/ايتم/كمية/تاريخ) — يُستعمل لكل من ستوك الافتتاحي/الثانوي ومبيعات الفرق */
export function parseLongFormatFile(buffer, defaultDate) {
  return parseMovementFile(buffer, defaultDate);
}

/** صفوف ملف Stock محفوظ سلفاً (نفس صفحة «ستوك المذاخر») — مصدر بديل للاستيراد */
export async function readExistingStockFile(userId, salesDataFileId) {
  return readStockFileRows(userId, salesDataFileId);
}

/** تصنيف موحّد (مذاخر + ايتمات + شركات معاً) — معاينة قبل الحفظ لأي مصدر */
export async function classifyRows(rows, writeId) {
  return classifyMovementRows({ rows, userId: writeId });
}

// ═══════════════════════════════════════════════════════════════
//  2. حسم المذاخر + الايتمات إلى صفوف نهائية (بلا كتابة StockMovement)
// ═══════════════════════════════════════════════════════════════
async function loadItemCtx(userId) {
  try {
    const assigns = await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
    return await loadResolutionContext({ scientificCompanyIds: assigns.map(a => a.companyId), userId });
  } catch { return { catalog: [], catalogById: new Map(), aliasMap: new Map() }; }
}

/** يحسم اسم ايتم واحد إلى {itemKey, itemName, itemId} عبر كتالوج الشركة — alias/exact/high فقط تُطابَق صامتة */
async function resolveItemOnce(itemName, ctx) {
  const trimmed = String(itemName ?? '').trim();
  if (!trimmed) return null;
  let canonicalName = trimmed, itemId = null;
  try {
    const r = await resolveItemName(trimmed, ctx);
    if (r?.canonicalItem && ['alias', 'exact', 'high'].includes(r.confidence)) {
      canonicalName = r.canonicalItem.name;
      itemId = r.canonicalItem.id;
    }
  } catch { /* لا يمنع الاستيراد */ }
  return { itemKey: normalizeItemKey(canonicalName), itemName: canonicalName, itemId };
}

/**
 * يحسم صفوف {warehouse, region, itemName, companyName, qty} إلى صفوف نهائية
 * {warehouseId, itemKey, itemName, companyName, itemId, qty} مجمَّعة (صفوف نفس
 * الزوج مذخر+ايتم داخل نفس الاستيراد تُجمَع برقم واحد) — بلا أي أثر على
 * StockMovement/StockBalance (تُكتب لاحقاً في StockCount أو WarehouseTeamSale).
 */
async function resolveRows(rows, writeId) {
  const [existing, links, ctx] = await Promise.all([
    getWarehouses(writeId),
    prisma.warehouseNameLink.findMany({ where: { userId: writeId }, select: { fromKey: true, warehouseId: true } }),
    loadItemCtx(writeId),
  ]);
  const wh = makeWarehouseResolver(existing, writeId, links);
  const itemCache = new Map();

  const byKey = new Map();
  for (const r of rows) {
    const w = wh.resolve(r.warehouse, r.region);
    if (!w) continue;
    const rawItem = String(r.itemName ?? '').trim();
    if (!rawItem) continue;
    const ikey = normalizeItemKey(rawItem);
    let item = itemCache.get(ikey);
    if (!item) { item = await resolveItemOnce(rawItem, ctx); itemCache.set(ikey, item); }
    if (!item) continue;
    const qty = Number(r.qty) || 0;
    if (qty <= 0) continue;

    const groupKey = w; // مرجع كائن — يُحسم لاحقاً بعد flush()
    const mapKey = `${item.itemKey}`;
    if (!byKey.has(groupKey)) byKey.set(groupKey, new Map());
    const perWh = byKey.get(groupKey);
    const acc = perWh.get(mapKey);
    if (acc) acc.qty += qty;
    else perWh.set(mapKey, { ...item, companyName: r.companyName ? String(r.companyName).trim() : null, qty });
  }
  await wh.flush();

  const resolved = [];
  for (const [w, perWh] of byKey) {
    if (!w.id) continue;
    for (const row of perWh.values()) resolved.push({ warehouseId: w.id, ...row });
  }
  return { resolved, report: wh.report() };
}

// ═══════════════════════════════════════════════════════════════
//  3. الستوك (الافتتاحي/الثانوي) — استيراد بالجملة لكل مذخر × ايتم
// ═══════════════════════════════════════════════════════════════
export async function ingestStockCountRows({ writeId, countDate, rows }) {
  if (!rows.length) throw new Error('لا توجد صفوف');
  const { resolved, report } = await resolveRows(rows, writeId);
  if (!resolved.length) throw new Error('لم يُطابَق أي صف بمذخر أو ايتم صالح — تأكد من أعمدة المذخر والايتم والكمية');

  let saved = 0;
  for (const row of resolved) {
    await repo.upsertCount({
      userId: writeId, warehouseId: row.warehouseId, itemKey: row.itemKey, itemName: row.itemName,
      companyName: row.companyName, itemId: row.itemId, countDate, qty: row.qty, note: null,
    });
    saved++;
  }
  const hasIssues = report.created.length || report.fuzzyLinked.length || report.healed.length;
  return { saved, rowCount: rows.length, warehouseCount: new Set(resolved.map(r => r.warehouseId)).size, unmatched: hasIssues ? report : null };
}

/** إدخال يدوي لزوج واحد (مذخر معروف الـid + اسم ايتم حر يُحسم عبر الكتالوج) */
export async function manualCount({ writeId, warehouseId, itemName, countDate, qty, note }) {
  if (!Number.isInteger(warehouseId)) throw new Error('اختر مذخر');
  if (!(qty >= 0)) throw new Error('كمية غير صالحة');
  const ctx = await loadItemCtx(writeId);
  const item = await resolveItemOnce(itemName, ctx);
  if (!item) throw new Error('اكتب اسم الايتم');
  return repo.upsertCount({ userId: writeId, warehouseId, ...item, companyName: null, countDate, qty, note: note ?? null });
}

export async function listCountsForWarehouse(readIds, warehouseId) {
  const warehouses = await getWarehouses(readIds);
  if (!warehouses.some(w => w.id === warehouseId)) return [];
  return repo.getCounts([warehouseId]);
}

export async function removeCount(id, readIds) {
  const row = await repo.findCount(id, readIds);
  if (!row) throw new Error('غير موجود');
  await repo.deleteCount(id);
  return row;
}

// ═══════════════════════════════════════════════════════════════
//  4. مبيعات الفرق (تجاري/علمي) — استيراد بالجملة لكل مذخر × ايتم
// ═══════════════════════════════════════════════════════════════
export async function ingestTeamSaleRows({ writeId, team, asOfDate, rows, sourceLabel }) {
  if (!TEAMS.has(team)) throw new Error('فريق غير صالح');
  if (!rows.length) throw new Error('لا توجد صفوف');
  const { resolved, report } = await resolveRows(rows, writeId);
  if (!resolved.length) throw new Error('لم يُطابَق أي صف بمذخر أو ايتم صالح — تأكد من أعمدة المذخر والايتم والكمية');

  let saved = 0;
  for (const row of resolved) {
    await repo.upsertTeamSale({
      userId: writeId, warehouseId: row.warehouseId, itemKey: row.itemKey, itemName: row.itemName,
      companyName: row.companyName, itemId: row.itemId, asOfDate, team, qty: row.qty, sourceLabel,
    });
    saved++;
  }
  const hasIssues = report.created.length || report.fuzzyLinked.length || report.healed.length;
  return { saved, rowCount: rows.length, warehouseCount: new Set(resolved.map(r => r.warehouseId)).size, unmatched: hasIssues ? report : null };
}

export async function manualTeamSale({ writeId, warehouseId, itemName, asOfDate, team, qty }) {
  if (!TEAMS.has(team)) throw new Error('فريق غير صالح');
  if (!Number.isInteger(warehouseId)) throw new Error('اختر مذخر');
  if (!(qty >= 0)) throw new Error('كمية غير صالحة');
  const ctx = await loadItemCtx(writeId);
  const item = await resolveItemOnce(itemName, ctx);
  if (!item) throw new Error('اكتب اسم الايتم');
  return repo.upsertTeamSale({ userId: writeId, warehouseId, ...item, companyName: null, asOfDate, team, qty, sourceLabel: 'إدخال يدوي' });
}

export async function removeTeamSale(id, readIds) {
  const row = await repo.findTeamSale(id, readIds);
  if (!row) throw new Error('غير موجود');
  await repo.deleteTeamSale(id);
  return row;
}

// ═══════════════════════════════════════════════════════════════
//  5. بناء الدورات — الحساب الكامل لكل زوج (مذخر × ايتم)
// ═══════════════════════════════════════════════════════════════
/**
 * @param {number[]} readIds دفاتر تُقرأ (راجع resolveLedgerScope)
 * @returns {{cycles: object[], openCycles: object[], unlinkedTeamSales: object[], teamSales: object[]}}
 *   cycles: دورات مغلقة (عدّتان متتاليتان لنفس مذخر+ايتم) بكامل التوزيع.
 *   openCycles: آخر عدّة لكل زوج بلا تالية بعد — قيد التقدم، بلا توزيع.
 *   unlinkedTeamSales / teamSales: صفوف مبيعات الفرق (teamSales = الكل، unlinkedTeamSales = ما لا يطابق أي عدّة ختامية بعد).
 */
export async function buildCycles(readIds) {
  const warehouses = await getWarehouses(readIds);
  if (!warehouses.length) return { cycles: [], openCycles: [], unlinkedTeamSales: [], teamSales: [], warehouses: [] };

  const warehouseIds = warehouses.map(w => w.id);
  const whById = new Map(warehouses.map(w => [w.id, w]));

  const [counts, inMovements, teamSales] = await Promise.all([
    repo.getCounts(warehouseIds),
    repo.getInMovements(warehouseIds),
    repo.getTeamSales(warehouseIds),
  ]);

  // تجميع حسب زوج (مذخر × ايتم)
  const pairKey = (warehouseId, itemKey) => `${warehouseId}|${itemKey}`;
  const countsByPair = new Map();
  for (const c of counts) {
    const k = pairKey(c.warehouseId, c.itemKey);
    if (!countsByPair.has(k)) countsByPair.set(k, []);
    countsByPair.get(k).push(c);
  }
  const inByPair = new Map();
  for (const m of inMovements) {
    const k = pairKey(m.warehouseId, m.itemKey);
    if (!inByPair.has(k)) inByPair.set(k, []);
    inByPair.get(k).push(m);
  }
  const teamByKey = new Map(); // `${warehouseId}|${itemKey}|${+asOfDate}|${team}` ← qty
  for (const t of teamSales) teamByKey.set(`${t.warehouseId}|${t.itemKey}|${+new Date(t.asOfDate)}|${t.team}`, t.qty);

  // تواريخ إغلاق فعلية (عدّة تالية موجودة) — لتحديد صفوف الفرق «غير المربوطة بعد»
  const closeDateKeys = new Set();

  const cycles = [];
  const openCycles = [];

  for (const [key, list] of countsByPair) {
    list.sort((a, b) => new Date(a.countDate) - new Date(b.countDate));
    const first = list[0];
    const wh = whById.get(first.warehouseId);
    const pairMovements = inByPair.get(key) || [];

    for (let i = 0; i < list.length - 1; i++) {
      const open = list[i], close = list[i + 1];
      closeDateKeys.add(`${key}|${+close.countDate}`);

      const reinforcement = pairMovements
        .filter(m => m.movementDate >= open.countDate && m.movementDate < close.countDate)
        .reduce((s, m) => s + m.qty, 0);

      const movedQty = open.qty + reinforcement - close.qty;
      const commercialQty = teamByKey.get(`${key}|${+close.countDate}|commercial`) ?? 0;
      const scientificQty = teamByKey.get(`${key}|${+close.countDate}|scientific`) ?? 0;
      const directQty = movedQty - commercialQty - scientificQty;

      cycles.push({
        warehouseId: first.warehouseId, warehouse: wh.name, region: wh.region,
        itemKey: first.itemKey, itemName: open.itemName, companyName: open.companyName,
        openId: open.id, openDate: open.countDate, opening: open.qty,
        closeId: close.id, closeDate: close.countDate, closing: close.qty,
        reinforcement, movedQty, commercialQty, scientificQty, directQty,
      });
    }

    const last = list[list.length - 1];
    const reinforcementSoFar = pairMovements
      .filter(m => m.movementDate >= last.countDate)
      .reduce((s, m) => s + m.qty, 0);
    openCycles.push({
      warehouseId: last.warehouseId, warehouse: wh.name, region: wh.region,
      itemKey: last.itemKey, itemName: last.itemName, companyName: last.companyName,
      openId: last.id, openDate: last.countDate, opening: last.qty, reinforcementSoFar,
    });
  }

  const teamSalesAll = teamSales.map(t => ({
    id: t.id, warehouseId: t.warehouseId, warehouse: whById.get(t.warehouseId)?.name ?? '—',
    region: whById.get(t.warehouseId)?.region ?? '', itemKey: t.itemKey, itemName: t.itemName,
    asOfDate: t.asOfDate, team: t.team, qty: t.qty, sourceLabel: t.sourceLabel, uploadedAt: t.uploadedAt,
    linked: closeDateKeys.has(`${t.warehouseId}|${t.itemKey}|${+new Date(t.asOfDate)}`),
  }));
  const unlinkedTeamSales = teamSalesAll.filter(t => !t.linked);

  cycles.sort((a, b) => new Date(b.closeDate) - new Date(a.closeDate));
  openCycles.sort((a, b) => a.warehouse.localeCompare(b.warehouse, 'ar') || a.itemName.localeCompare(b.itemName, 'ar'));

  return { cycles, openCycles, unlinkedTeamSales, teamSales: teamSalesAll, warehouses };
}
