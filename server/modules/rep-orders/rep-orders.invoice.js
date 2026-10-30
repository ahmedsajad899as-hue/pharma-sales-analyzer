// ════════════════════════════════════════════════════════════════════════════
// rep-orders.invoice.js — قراءة صورة فاتورة المذخر ومطابقتها بطلبية.
//
// المسار: صورة مُشارَكة (من كروب المذخر بواتساب) ← extractInvoiceRows (نفس قارئ
// فواتير المبيعات: Qwen-VL واحتياطه Claude) ← تُقيَّم طلبيات المُشاهِد في آخر
// 30 يوماً: الصيدلية + المذخر + قرب التاريخ + تطابق الأصناف ← أفضل مرشّح يُختار
// تلقائياً إن كان واثقاً ومتقدّماً بوضوح على الثاني.
//
// الحفظ (applyInvoice) منفصل وبتأكيد من المستخدم: يُرفق الصورة كـ«صورة التجهيز»
// (preparedImage — فاتورة المذخر)، ويكتب الكمية المجهّزة فعلاً لكل سطر، فتصير
// الطلبية «مجهّزة». invoiceImage ليس للفاتورة: هو ختم الصيدلية مع الطلبية.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { similarity } from '../../lib/fuzzyMatch.js';
import { pharmacyKey } from '../../lib/pharmacyKey.js';
import { extractInvoiceRows } from '../sales/sales.service.js';
import { loadViewer, orderScopeWhere, getVisibleOrder, recordPreparation, INVOICE_DIR } from './rep-orders.service.js';

const LOOKBACK_DAYS = 30;
const AUTO_MIN_SCORE = 60;   // أدنى ثقة للاختيار التلقائي
const AUTO_MIN_GAP = 15;     // وفارقه عن المرشّح الثاني
const ITEM_MATCH_MIN = 0.62;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

// صورة قُرئت ولم تُحفظ بعد تبقى باسم pending-*، وتُحذف بعد يوم إن لم يُؤكَّد حفظها.
const PENDING_RE = /^pending-([a-f0-9]{32})\.jpg$/;

function purgeStalePending() {
  fs.promises.readdir(INVOICE_DIR).then(names => Promise.all(names.filter(n => PENDING_RE.test(n)).map(async n => {
    const p = path.join(INVOICE_DIR, n);
    const st = await fs.promises.stat(p);
    if (Date.now() - st.mtimeMs > PENDING_TTL_MS) await fs.promises.unlink(p);
  }))).catch(() => {});
}

// اسم صنف للمطابقة: حروف لاتينية/عربية موحّدة وأرقام، بلا رموز.
function itemKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function nameSim(a, b) {
  const ka = itemKey(a), kb = itemKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  // أول كلمة (الاسم التجاري) تحمل معظم التمييز: «Panadol extra 500» ↔ «panadol extra tab»
  const fa = ka.split(' ')[0], fb = kb.split(' ')[0];
  const whole = similarity(ka, kb);
  const first = fa.length >= 3 && fb.length >= 3 ? similarity(fa, fb) : 0;
  const contains = ka.includes(kb) || kb.includes(ka) ? 0.9 : 0;
  return Math.max(whole, contains, first * 0.92);
}

function placeSim(a, b) {
  const ka = pharmacyKey(a), kb = pharmacyKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  if (ka.includes(kb) || kb.includes(ka)) return 0.9;
  return similarity(ka, kb);
}

function parseInvoiceDate(s) {
  const m = String(s ?? '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** يربط أسطر الطلبية بأسطر الفاتورة (جشع: الأعلى تشابهاً أولاً، كل سطر مرة واحدة). */
function mapLines(orderLines, invItems) {
  const pairs = [];
  orderLines.forEach((l, i) => invItems.forEach((it, j) => {
    const s = nameSim(l.itemName, it.item);
    if (s >= ITEM_MATCH_MIN) pairs.push({ i, j, s });
  }));
  pairs.sort((a, b) => b.s - a.s);
  const byLine = new Map(), usedInv = new Set();
  for (const p of pairs) {
    if (byLine.has(p.i) || usedInv.has(p.j)) continue;
    byLine.set(p.i, p); usedInv.add(p.j);
  }
  return { byLine, usedInv };
}

export function scoreOrder(order, inv) {
  const pharm = inv.pharmacy ? placeSim(order.pharmacyName, inv.pharmacy) : 0;
  const wh = inv.warehouse ? placeSim(order.warehouseName, inv.warehouse) : 0;
  let dateScore = 0.5; // بلا تاريخ مقروء: محايد
  if (inv.date) {
    const days = (inv.date - order.orderDate) / 86_400_000;
    dateScore = days < -1.5 ? 0 : Math.max(0, 1 - Math.max(0, days) / 7);
  }
  const { byLine } = mapLines(order.lines, inv.items);
  const denom = Math.max(order.lines.length, inv.items.length) || 1;
  const itemsScore = byLine.size / denom;
  const score = Math.round(pharm * 40 + wh * 15 + dateScore * 15 + itemsScore * 30);
  return { score, byLine };
}

/**
 * @returns {{ token, invoice, candidates, autoOrderId }}
 */
// ميزة اشتراك يمنحها السوبر أدمن لكل حساب من «المميزات» (OPT_IN_FEATURES في featureConfig.ts):
// مفعّلة فقط إن وُجدت في permissions.enabledFeatures ولم تُعطَّل — نفس isFeatureEnabled في الواجهة
const AI_READ_FEATURE = 'rep_orders_ai_read';
async function canAiRead(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { permissions: true } });
  try {
    const p = JSON.parse(u?.permissions || '{}');
    return !(p.disabledFeatures ?? []).includes(AI_READ_FEATURE) && (p.enabledFeatures ?? []).includes(AI_READ_FEATURE);
  } catch { return false; }
}

export async function readInvoice(reqUser, file) {
  if (!file) throw new AppError('لا توجد صورة', 400);
  purgeStalePending();
  const viewer = await loadViewer(reqUser);
  if (!(await canAiRead(viewer.id))) {
    fs.promises.unlink(file.path).catch(() => {});
    throw new AppError('قراءة الفاتورة بالذكاء غير مفعّلة لحسابك', 403);
  }

  const token = path.basename(file.path).match(PENDING_RE)?.[1];
  let rows;
  try {
    const buf = await fs.promises.readFile(file.path);
    rows = await extractInvoiceRows([{ mimeType: 'image/jpeg', base64: buf.toString('base64') }]);
  } catch (e) {
    // الصورة تبقى pending ليُكمَل الربط يدوياً حتى لو فشلت القراءة
    return { token, invoice: null, candidates: [], autoOrderId: null, readError: e.message || 'تعذّرت قراءة الفاتورة' };
  }

  const head = rows.find(r => r.pharmacy) || rows[0] || {};
  const invoice = {
    pharmacy: head.pharmacy || null,
    warehouse: rows.find(r => r.warehouse)?.warehouse || null,
    area: head.area || null,
    dateText: rows.find(r => r.date)?.date || null,
    invoiceNumber: rows.find(r => r.invoiceNumber)?.invoiceNumber ? String(rows.find(r => r.invoiceNumber).invoiceNumber) : null,
    items: rows.filter(r => r.item).map(r => ({ item: String(r.item), quantity: Math.round(Number(r.quantity) || 0), bonus: Math.round(Number(r.bonus) || 0) })),
  };
  const inv = { ...invoice, date: parseInvoiceDate(invoice.dateText) };

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const orders = await prisma.repOrder.findMany({
    where: { AND: [await orderScopeWhere(viewer), { orderDate: { gte: since } }, { status: { not: 'cancelled' } }] },
    include: { lines: { orderBy: { id: 'asc' } } },
    take: 1500,
  });

  const scored = orders.map(o => ({ o, ...scoreOrder(o, inv) })).sort((a, b) => b.score - a.score).slice(0, 6);
  const candidates = scored.map(({ o, score, byLine }) => ({
    orderId: o.id,
    score,
    lines: o.lines.map((l, i) => {
      const p = byLine.get(i);
      const it = p ? inv.items[p.j] : null;
      return { lineId: l.id, itemName: l.itemName, quantity: l.quantity, bonusQty: l.bonusQty, invoiceItem: it?.item ?? null, preparedQty: it ? it.quantity : 0, preparedBonus: it ? it.bonus : 0 };
    }),
    // أصناف في الفاتورة لم تُطابق أي سطر في هذه الطلبية
    extraItems: inv.items.filter((_, j) => ![...byLine.values()].some(p => p.j === j)),
  }));

  const [best, second] = scored;
  const autoOrderId = best && best.score >= AUTO_MIN_SCORE && (!second || best.score - second.score >= AUTO_MIN_GAP) ? best.o.id : null;

  return { token, invoice, candidates, autoOrderId };
}

/**
 * يُرفق صورة قُرئت (token) بالطلبية ويكتب الكميات المجهّزة فعلاً.
 * @param {{ token:string, invoiceNumber?:string, lines?:{lineId:number, preparedQty:number, preparedBonus?:number}[] }} body
 */
export async function applyInvoice(reqUser, id, body) {
  const viewer = await loadViewer(reqUser);
  const order = await getVisibleOrder(viewer, id);
  const token = String(body?.token ?? '');
  if (!/^[a-f0-9]{32}$/.test(token)) throw new AppError('صورة غير صالحة', 400);
  const pendingPath = path.join(INVOICE_DIR, `pending-${token}.jpg`);
  const finalName = `${token}.jpg`;
  try {
    await fs.promises.rename(pendingPath, path.join(INVOICE_DIR, finalName));
  } catch {
    throw new AppError('انتهت صلاحية الصورة — أعد مشاركتها', 410);
  }

  const url = `/uploads/rep-orders/${finalName}`;
  // فاتورة المذخر الذي أُرسلت له الطلبية — قد تغطي جزءاً منها فقط (الباقي يُرسل للتالي)
  const r = await recordPreparation(viewer, order.id, {
    warehouseId: body?.warehouseId || null,
    lines: Array.isArray(body?.lines) ? body.lines : [],
    image: url,
    invoiceNumber: body?.invoiceNumber ?? null,
  });
  return { preparedImage: url, ...r };
}

// ─── فاتورة تصل للبوت من حساب مربوط (تلكرام/فايبر/واتساب) ───────────────────
// (طلب صاحب المشروع 2026-10-31) صورة الفاتورة في البوت نوعان: تجهيز طلبية من
// «طلبيات المذاخر» أو مبيعات/طلبية لملف الكوديشن. bot-order-flow يقرأها مرة واحدة
// ثم يسأل هنا أولاً: طابقت طلبية مذاخر مفتوحة بثقة ⇒ تُثبَّت عليها، وإلا تكمل للكوديشن.

/** أسطر extractInvoiceRows ← شكل الفاتورة الذي يفهمه scoreOrder. */
function invoiceFromRows(rows) {
  const head = rows.find(r => r.pharmacy) || rows[0] || {};
  const num = rows.find(r => r.invoiceNumber)?.invoiceNumber;
  return {
    pharmacy: head.pharmacy || null,
    warehouse: rows.find(r => r.warehouse)?.warehouse || null,
    date: parseInvoiceDate(rows.find(r => r.date)?.date),
    invoiceNumber: num ? String(num) : null,
    items: rows.filter(r => r.item).map(r => ({ item: String(r.item), quantity: Math.round(Number(r.quantity) || 0), bonus: Math.round(Number(r.bonus) || 0) })),
  };
}

/**
 * أقرب طلبية مذاخر لم تكتمل (نطاق الحساب، آخر 30 يوماً) لفاتورة البوت.
 * forcedOrderId = رقم الطلبية مكتوباً مع الصورة («#16») ⇒ تلك الطلبية بلا شرط ثقة.
 * يعيد null إن لم تُطابق بثقة، أو لم يطابق أي صنف (لا نسجّل «رفضاً» بفاتورة لا تخصّها).
 * @returns {Promise<{ order, byLine, inv, score } | null>}
 */
export async function matchBotInvoice(userId, rows, { forcedOrderId = null } = {}) {
  const viewer = await loadViewer({ id: userId });
  const inv = invoiceFromRows(rows);
  if (!inv.items.length) return null;
  const scope = await orderScopeWhere(viewer);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const orders = await prisma.repOrder.findMany({
    where: forcedOrderId
      ? { AND: [scope, { id: Number(forcedOrderId) }, { status: { not: 'cancelled' } }] }
      : { AND: [scope, { orderDate: { gte: since } }, { status: 'pending' }] },
    include: { lines: { orderBy: { id: 'asc' } } },
    take: 1500,
  });
  const scored = orders.map(o => ({ order: o, inv, ...scoreOrder(o, inv) })).sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || !best.byLine.size) return null;
  if (forcedOrderId) return best;
  return best.score >= AUTO_MIN_SCORE && (!second || best.score - second.score >= AUTO_MIN_GAP) ? best : null;
}

/** يحفظ صورة فاتورة البوت ويسجّل تجهيزها على الطلبية المطابقة (نفس مسار رفعها من الصفحة). */
export async function attachBotInvoice(userId, match, imageBuffer) {
  const { order, byLine, inv } = match;
  await fs.promises.mkdir(INVOICE_DIR, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  await fs.promises.writeFile(path.join(INVOICE_DIR, name), imageBuffer);
  const url = `/uploads/rep-orders/${name}`;

  // المذخر: اسمه المطبوع قرأه الذكاء وقد يشبه مذخراً آخر («السلام» ⇐ «طريق السلام» —
  // طلبية #20 ثُبّتت على احتياط لم تُرسل له قط)، فلا يغلب المذاخر التي أُرسلت لها فعلاً:
  //  • أُرسلت لمذخر وتنتظر ردّه ⇒ أحدها؛ الاسم يرجّح بينها فقط، وإلا أحدثها إرسالاً.
  //  • لم تُرسل لأحد ⇒ اسم مطابق تماماً بين مذاخرها، وإلا آخر مذخر/الأساسي.
  const byName = async (ids, min) => {
    if (!inv.warehouse || !ids.length) return null;
    const whs = await prisma.orderWarehouse.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const [a, b] = whs.map(w => ({ id: w.id, s: placeSim(w.name, inv.warehouse) })).sort((x, y) => y.s - x.s);
    return a && a.s >= min && (!b || a.s - b.s >= 0.15) ? a.id : null;
  };
  const awaiting = (await prisma.repOrderSend.findMany({
    where: { orderId: order.id, warehouseId: { not: null }, outcome: { in: ['sent', 'partial'] } },
    orderBy: { id: 'desc' }, select: { warehouseId: true },
  })).map(s => s.warehouseId);
  const warehouseId = awaiting.length
    ? (await byName([...new Set(awaiting)], 0.85)) ?? awaiting[0]
    : (await byName([...new Set([order.warehouseId, ...order.backupWarehouseIds].filter(Boolean))], 1))
      ?? order.lastSentWarehouseId ?? order.warehouseId ?? null;

  const lines = order.lines.map((l, i) => {
    const it = byLine.has(i) ? inv.items[byLine.get(i).j] : null;
    return { lineId: l.id, preparedQty: it ? it.quantity : 0, preparedBonus: it ? it.bonus : 0 };
  });
  const r = await recordPreparation({ id: userId }, order.id, { warehouseId, lines, image: url, invoiceNumber: inv.invoiceNumber });
  const wh = warehouseId ?? order.lastSentWarehouseId ?? order.warehouseId;
  const whName = wh ? (await prisma.orderWarehouse.findUnique({ where: { id: wh }, select: { name: true } }))?.name : order.warehouseName;
  return { ...r, image: url, warehouseName: whName ?? order.warehouseName, matchedLines: byLine.size, totalLines: order.lines.length };
}
