// ════════════════════════════════════════════════════════════════════════════
// rep-orders.invoice.js — قراءة صورة فاتورة المذخر ومطابقتها بطلبية.
//
// المسار: صورة مُشارَكة (من كروب المذخر بواتساب) ← extractInvoiceRows (نفس قارئ
// فواتير المبيعات: Qwen-VL واحتياطه Claude) ← تُقيَّم طلبيات المُشاهِد في آخر
// 30 يوماً: الصيدلية + المذخر + قرب التاريخ + تطابق الأصناف ← أفضل مرشّح يُختار
// تلقائياً إن كان واثقاً ومتقدّماً بوضوح على الثاني.
//
// الحفظ (applyInvoice) منفصل وبتأكيد من المستخدم: يُرفق الصورة، ويكتب الكمية
// المجهّزة فعلاً لكل سطر، فتصير الطلبية «مجهّزة».
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { similarity } from '../../lib/fuzzyMatch.js';
import { pharmacyKey } from '../../lib/pharmacyKey.js';
import { extractInvoiceRows } from '../sales/sales.service.js';
import { loadViewer, orderScopeWhere, getVisibleOrder, INVOICE_DIR } from './rep-orders.service.js';

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
export async function readInvoice(reqUser, file) {
  if (!file) throw new AppError('لا توجد صورة', 400);
  purgeStalePending();
  const viewer = await loadViewer(reqUser);

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

  const lineIds = new Set(order.lines.map(l => l.id));
  const lines = (Array.isArray(body?.lines) ? body.lines : []).filter(l => lineIds.has(Number(l.lineId)));
  const url = `/uploads/rep-orders/${finalName}`;

  await prisma.$transaction([
    prisma.repOrder.update({
      where: { id: order.id },
      data: {
        invoiceImage: url,
        invoiceNumber: body?.invoiceNumber ? String(body.invoiceNumber).slice(0, 60) : order.invoiceNumber,
        status: 'prepared', preparedAt: new Date(), preparedById: viewer.id,
      },
    }),
    ...lines.map(l => prisma.repOrderLine.update({
      where: { id: Number(l.lineId) },
      data: { preparedQty: Math.max(0, Math.floor(Number(l.preparedQty) || 0)), preparedBonus: Math.max(0, Math.floor(Number(l.preparedBonus) || 0)) },
    })),
  ]);

  if (order.invoiceImage && path.basename(order.invoiceImage) !== finalName) {
    fs.promises.unlink(path.join(INVOICE_DIR, path.basename(order.invoiceImage))).catch(() => {});
  }
  return { invoiceImage: url };
}
