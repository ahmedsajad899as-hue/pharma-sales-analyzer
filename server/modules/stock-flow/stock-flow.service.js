/**
 * Stock Flow Service — «تحريك المذاخر»
 *
 * كل عدّتين متتاليتين (بالتاريخ) لنفس المذخر (StockCount) تشكّلان دورة واحدة:
 *   الكمية المتحركة = الافتتاحي + التعزيز − الثانوي
 *   التعزيز يُشتق تلقائياً من StockMovement (direction='in', صفحة رصيد
 *   المذاخر) الواقعة بين تاريخي العدّتين — بلا إدخال يدوي مكرَّر.
 *   مباشر (مذخر) = المتحركة − تجاري − علمي (تجاري/علمي تُرفعان بملف Excel
 *   مستقل لكل فريق، ويُربطان بالدورة عبر WarehouseTeamSale.asOfDate = تاريخ
 *   العدّة الختامية للدورة).
 *
 * مطابقة أسماء المذاخر في ملفات الفرق تُعيد استعمال نفس محرّك «رصيد المذاخر»
 * (classifyWarehouseRows / makeWarehouseResolver / saveWarehouseNameLinks) —
 * هوية مذخر واحدة موحّدة في كل الصفحة، بلا محرّك مطابقة مواز يمكن أن ينحرف عنه.
 */

import * as XLSX from 'xlsx';
import prisma from '../../lib/prisma.js';
import { classifyWarehouseRows, makeWarehouseResolver } from '../stock-ledger/stock-ledger.service.js';
import { getWarehouses } from '../stock-ledger/stock-ledger.repository.js';
import * as repo from './stock-flow.repository.js';

export const TEAMS = new Set(['commercial', 'scientific']);

// ═══════════════════════════════════════════════════════════════
//  1. تحليل ملف مبيعات فريق (صيغة بسيطة: عمود مذخر + عمود كمية)
// ═══════════════════════════════════════════════════════════════
const WAREHOUSE_ALIASES = [
  'المذخر', 'مذخر', 'اسم المذخر', 'المخزن', 'مخزن', 'اسم المخزن',
  'المستودع', 'مستودع', 'warehouse', 'warehouse name', 'store', 'depot',
];
const QTY_ALIASES = [
  'الكمية', 'كمية', 'الكمية المباعة', 'كمية المبيعات', 'مبيع', 'المبيع',
  'qty', 'quantity', 'sold', 'sold qty', 'total',
];

const normHeader = (h) => String(h ?? '').trim().toLowerCase();
function findCol(headers, aliases) {
  const lower = headers.map(normHeader);
  const al = aliases.map(a => a.toLowerCase());
  let idx = lower.findIndex(h => al.includes(h));
  if (idx === -1) idx = lower.findIndex(h => al.some(a => h.includes(a)));
  return idx === -1 ? null : headers[idx];
}

/** يحلّل ملف Excel بعمودين: المذخر + الكمية — رقم إجمالي واحد لكل مذخر بالدورة */
export function parseTeamSalesFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], warnings: ['الملف فارغ'], skipped: 0 };
  const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!json.length) return { rows: [], warnings: ['لا توجد صفوف في الملف'], skipped: 0 };

  const headers = Object.keys(json[0]);
  const whCol = findCol(headers, WAREHOUSE_ALIASES);
  const qtyCol = findCol(headers, QTY_ALIASES);
  if (!whCol || !qtyCol) {
    return {
      rows: [],
      warnings: [`تعذّر إيجاد عمود ${!whCol ? 'المذخر' : 'الكمية'} — الأعمدة المطلوبة: المذخر، الكمية`],
      skipped: 0,
    };
  }

  const rows = [];
  let skipped = 0;
  for (const raw of json) {
    const warehouse = String(raw[whCol] ?? '').trim();
    const qty = Math.abs(parseFloat(String(raw[qtyCol] ?? '0').replace(/,/g, '')) || 0);
    if (!warehouse || qty <= 0) { skipped++; continue; }
    rows.push({ warehouse, qty });
  }
  return { rows, warnings: [], skipped, colMap: { warehouse: whCol, qty: qtyCol } };
}

// ═══════════════════════════════════════════════════════════════
//  2. مطابقة + حفظ مبيعات الفرق
// ═══════════════════════════════════════════════════════════════
/** أسماء مذاخر تحتاج تأكيد المستخدم — معاينة فقط، لا تحفظ شيئاً (نفس محرّك رصيد المذاخر) */
export async function classifyTeamSalesRows(rows, writeId) {
  return classifyWarehouseRows(rows.map(r => ({ warehouse: r.warehouse, region: null })), writeId);
}

/**
 * يحفظ صفوف ملف فريق واحد (تجاري أو علمي) لدورة تنتهي بتاريخ asOfDate.
 * صفوف نفس المذخر تُجمَع في رقم واحد؛ رفع لاحق لنفس (مذخر+تاريخ+فريق) يستبدل
 * القيمة القديمة (تصحيح رفع خاطئ) لا يضيف إليها.
 */
export async function commitTeamSales({ writeId, team, asOfDate, rows, sourceLabel }) {
  if (!TEAMS.has(team)) throw new Error('فريق غير صالح');
  if (!rows.length) throw new Error('لا توجد صفوف');

  const [existing, links] = await Promise.all([
    getWarehouses(writeId),
    prisma.warehouseNameLink.findMany({ where: { userId: writeId }, select: { fromKey: true, warehouseId: true } }),
  ]);
  const wh = makeWarehouseResolver(existing, writeId, links);

  const byWarehouse = new Map(); // كائن المذخر (من المُحلّل) ← مجموع الكمية
  for (const r of rows) {
    const w = wh.resolve(r.warehouse, null);
    if (!w) continue;
    byWarehouse.set(w, (byWarehouse.get(w) || 0) + Number(r.qty || 0));
  }
  await wh.flush();

  let saved = 0;
  for (const [w, qty] of byWarehouse) {
    if (!w.id || qty <= 0) continue;
    await repo.upsertTeamSale({ userId: writeId, warehouseId: w.id, asOfDate, team, qty, sourceLabel });
    saved++;
  }

  const report = wh.report();
  const unmatched = (report.created.length || report.fuzzyLinked.length || report.healed.length) ? report : null;
  return { saved, rowCount: rows.length, unmatched };
}

export async function upsertTeamSale({ writeId, warehouseId, asOfDate, team, qty }) {
  if (!TEAMS.has(team)) throw new Error('فريق غير صالح');
  if (!Number.isInteger(warehouseId)) throw new Error('اختر مذخر');
  if (!(qty >= 0)) throw new Error('كمية غير صالحة');
  return repo.upsertTeamSale({ userId: writeId, warehouseId, asOfDate, team, qty, sourceLabel: 'إدخال يدوي' });
}

export async function removeTeamSale(id, readIds) {
  const row = await repo.findTeamSale(id, readIds);
  if (!row) throw new Error('غير موجود');
  await repo.deleteTeamSale(id);
  return row;
}

// ═══════════════════════════════════════════════════════════════
//  3. نقاط العدّ (الستوك الافتتاحي/الثانوي)
// ═══════════════════════════════════════════════════════════════
export async function upsertCount({ writeId, warehouseId, countDate, qty, note }) {
  if (!Number.isInteger(warehouseId)) throw new Error('اختر مذخر');
  if (!(qty >= 0)) throw new Error('كمية غير صالحة');
  return repo.upsertCount({ userId: writeId, warehouseId, countDate, qty, note });
}

/** نقاط عدّ مذخر واحد — يتحقق أن المذخر ضمن دفاتر القراءة المسموحة قبل الإرجاع */
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
//  4. بناء الدورات — الحساب الكامل
// ═══════════════════════════════════════════════════════════════
/**
 * @param {number[]} readIds دفاتر تُقرأ (raq resolveLedgerScope)
 * @returns {{cycles: object[], openCycles: object[], unlinkedTeamSales: object[]}}
 *   cycles: دورات مغلقة (عدّتان متتاليتان) بكامل التوزيع.
 *   openCycles: آخر عدّة لكل مذخر بلا تالية بعد — قيد التقدم، بلا توزيع.
 *   unlinkedTeamSales: صفوف مبيعات فرق مرفوعة لتاريخ لا يطابق أي عدّة ختامية بعد.
 */
export async function buildCycles(readIds) {
  const warehouses = await getWarehouses(readIds);
  if (!warehouses.length) return { cycles: [], openCycles: [], unlinkedTeamSales: [], warehouses: [] };

  const warehouseIds = warehouses.map(w => w.id);
  const whById = new Map(warehouses.map(w => [w.id, w]));

  const [counts, inMovements, teamSales] = await Promise.all([
    repo.getCounts(warehouseIds),
    repo.getInMovements(warehouseIds),
    repo.getTeamSales(warehouseIds),
  ]);

  const countsByWarehouse = new Map();
  for (const c of counts) {
    if (!countsByWarehouse.has(c.warehouseId)) countsByWarehouse.set(c.warehouseId, []);
    countsByWarehouse.get(c.warehouseId).push(c);
  }
  const inByWarehouse = new Map();
  for (const m of inMovements) {
    if (!inByWarehouse.has(m.warehouseId)) inByWarehouse.set(m.warehouseId, []);
    inByWarehouse.get(m.warehouseId).push(m);
  }
  const teamByKey = new Map(); // `${warehouseId}|${+asOfDate}|${team}` ← qty
  for (const t of teamSales) teamByKey.set(`${t.warehouseId}|${+new Date(t.asOfDate)}|${t.team}`, t.qty);

  // تواريخ إغلاق فعلية (عدّة تالية موجودة) — لتحديد صفوف الفرق «غير المربوطة بعد»
  const closeDateKeys = new Set();

  const cycles = [];
  const openCycles = [];

  for (const [warehouseId, list] of countsByWarehouse) {
    const wh = whById.get(warehouseId);
    const whMovements = inByWarehouse.get(warehouseId) || [];

    for (let i = 0; i < list.length - 1; i++) {
      const open = list[i], close = list[i + 1];
      closeDateKeys.add(`${warehouseId}|${+close.countDate}`);

      const reinforcement = whMovements
        .filter(m => m.movementDate >= open.countDate && m.movementDate < close.countDate)
        .reduce((s, m) => s + m.qty, 0);

      const movedQty = open.qty + reinforcement - close.qty;
      const commercialQty = teamByKey.get(`${warehouseId}|${+close.countDate}|commercial`) ?? 0;
      const scientificQty = teamByKey.get(`${warehouseId}|${+close.countDate}|scientific`) ?? 0;
      const directQty = movedQty - commercialQty - scientificQty;

      cycles.push({
        warehouseId, warehouse: wh.name, region: wh.region,
        openId: open.id, openDate: open.countDate, opening: open.qty,
        closeId: close.id, closeDate: close.countDate, closing: close.qty,
        reinforcement, movedQty, commercialQty, scientificQty, directQty,
      });
    }

    const last = list[list.length - 1];
    if (last) {
      const reinforcementSoFar = whMovements
        .filter(m => m.movementDate >= last.countDate)
        .reduce((s, m) => s + m.qty, 0);
      openCycles.push({
        warehouseId, warehouse: wh.name, region: wh.region,
        openId: last.id, openDate: last.countDate, opening: last.qty, reinforcementSoFar,
      });
    }
  }

  const unlinkedTeamSales = teamSales
    .filter(t => !closeDateKeys.has(`${t.warehouseId}|${+new Date(t.asOfDate)}`))
    .map(t => ({
      id: t.id, warehouseId: t.warehouseId, warehouse: whById.get(t.warehouseId)?.name ?? '—',
      asOfDate: t.asOfDate, team: t.team, qty: t.qty, sourceLabel: t.sourceLabel,
    }));

  cycles.sort((a, b) => new Date(b.closeDate) - new Date(a.closeDate));
  openCycles.sort((a, b) => a.warehouse.localeCompare(b.warehouse, 'ar'));

  return { cycles, openCycles, unlinkedTeamSales, warehouses };
}
