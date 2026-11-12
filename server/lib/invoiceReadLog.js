// ════════════════════════════════════════════════════════════════════════════
// invoiceReadLog.js — سجلّ لكل صورة فاتورة قُرئت بالذكاء (جدول InvoiceReadLog):
// الصورة (نسخة مصغّرة)، المرسل والحساب، التاريخ، وكل نداءاتها مجموعة — توكنز وكلفة.
// يُعرض في لوحة الماستر ← استهلاك الذكاء ← «🖼️ الصور المحلَّلة».
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import prisma from './prisma.js';
import { downscaleJpeg, isJpeg } from './invoiceImage.js';
import { isPdf } from './invoicePdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INVOICE_READ_DIR = path.join(__dirname, '..', '..', 'uploads', 'invoice-reads');
const KEEP_DAYS = 60;
const MAX_PDF_BYTES = 4 * 1024 * 1024; // فاتورة PDF تُحفظ كما هي لتُفتح من السجل

// $ لكل مليون token (إدخال، إخراج — التفكير يُحاسَب إخراجاً). أسعار Gemini الحالية.
const PRICES = {
  'gemini-3.8-flash':      [0.75, 3.75],
  'gemini-3.5-flash-lite': [0.30, 2.50],
};
export function costOf(model, promptTokens, outputTokens) {
  const key = Object.keys(PRICES).find(k => String(model || '').startsWith(k));
  const [pi, po] = PRICES[key] || PRICES['gemini-3.8-flash'];
  return (promptTokens * pi + outputTokens * po) / 1e6;
}

const short = (v, n = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };

/**
 * يحفظ سجلّ صورة واحدة. لا يرمي ولا يُنتظر (fire-and-forget من extractInvoiceRows).
 * @param {object} p
 * @param {object} [p.ctx]   { source, userId, userName, senderName, chatTitle } من المستدعي
 * @param {object[]} p.calls ما جمعه aiCallScope لهذه الصورة
 * @param {Buffer} [p.image] الصورة الأصلية (تُحفظ مصغّرة) أو ملف PDF (يُحفظ كما هو)
 * @param {object} [p.extra]  حقول إضافية تُدمج في details: { orient, pdf, purpose, gate }
 * @param {object} [p.header] { pharmacy, warehouse } بدل المأخوذ من الصفوف (الفحص السريع بلا أصناف)
 * @param {string} [p.retryPart] ما أُعيد بالأقوى في «تلقائي»: rows | customer | full | text
 */
export async function saveInvoiceReadLog({ ctx = {}, calls = [], image = null, rows = [], card = null, mode = null, retried = false, retryPart = null, ok = true, error = null, durationMs = 0, readKey = null, kind = 'photo', sourceText = null, readBy = null, extra = null, header = null }) {
  try {
    const promptTokens = calls.reduce((a, c) => a + (c.promptTokens || 0), 0);
    const outputTokens = calls.reduce((a, c) => a + (c.outputTokens || 0), 0);
    const costUsd = calls.reduce((a, c) => a + costOf(c.model, c.promptTokens || 0, c.outputTokens || 0), 0);
    const first = rows.find(r => r?.pharmacy) || rows[0] || {};
    const pharmacy = header?.pharmacy ?? first.pharmacy;
    const warehouse = header?.warehouse ?? first.warehouse;
    const more = extra ? Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && v !== '')) : {};
    const log = await prisma.invoiceReadLog.create({
      data: {
        source: short(ctx.source, 40) || 'unknown',
        kind,
        sourceText: short(sourceText, 4000),
        readBy: short(readBy, 20),
        userId: Number.isInteger(ctx.userId) ? ctx.userId : null,
        userName: short(ctx.userName, 120),
        senderName: short(ctx.senderName, 120),
        chatTitle: short(ctx.chatTitle, 160),
        warehouse: short(warehouse, 120),
        card: short(card?.name, 120),
        mode: short(mode, 20),
        retried: Boolean(retried),
        retryPart: short(retryPart, 40),
        pharmacy: short(pharmacy, 160),
        area: short(first.area, 120),
        rowCount: rows.length,
        calls: calls.length,
        promptTokens, outputTokens,
        costUsd,
        durationMs: Math.round(durationMs || 0),
        ok: Boolean(ok),
        error: short(error, 300),
        readKey,
        details: rows.length || Object.keys(more).length ? {
          invoiceNumber: short(first.invoiceNumber, 40),
          date: short(first.date, 20),
          items: rows.slice(0, 60).map(r => [short(r.item, 120), r.quantity ?? null, r.bonus ?? null, r.unitPrice ?? null, r.totalValue ?? r.total ?? null]),
          ...more,
        } : undefined,
      },
    });
    if (image && isJpeg(image)) {
      let thumb = image;
      try { thumb = downscaleJpeg(image, 1280); } catch { /* الأصل كما هو */ }
      await fs.promises.mkdir(INVOICE_READ_DIR, { recursive: true });
      const name = `${log.id}.jpg`;
      await fs.promises.writeFile(path.join(INVOICE_READ_DIR, name), thumb);
      await prisma.invoiceReadLog.update({ where: { id: log.id }, data: { imageFile: name } });
    } else if (image && isPdf(image) && image.length <= MAX_PDF_BYTES) {
      await fs.promises.mkdir(INVOICE_READ_DIR, { recursive: true });
      const name = `${log.id}.pdf`;
      await fs.promises.writeFile(path.join(INVOICE_READ_DIR, name), image);
      await prisma.invoiceReadLog.update({ where: { id: log.id }, data: { imageFile: name } });
    }
  } catch (e) {
    console.error('[invoice-read-log] تعذّر الحفظ:', String(e?.message || '').slice(0, 160));
  }
}

/**
 * يربط سجلات الصور بالطلبيات التي أُنشئت منها (ingestBotOrder): لمن ذهبت، ومن حُوِّلت له.
 * @param {object[]} rows   صفوف الطلبية كما قُرئت (تحمل _readKey)
 * @param {object[]} orders [{ orderId, userId, name, forwarded, rows }]
 * لا يرمي ولا يُنتظر. السجل يُكتب بلا انتظار أثناء القراءة، فإن لم يوجد بعد يُعاد مرة بعد 3 ث.
 */
export function linkInvoiceReadLogs(orders) {
  const byKey = new Map();
  for (const o of orders) {
    for (const r of o.rows || []) {
      if (!r?._readKey) continue;
      if (!byKey.has(r._readKey)) byKey.set(r._readKey, new Map());
      byKey.get(r._readKey).set(o.orderId, { orderId: o.orderId, userId: o.userId ?? null, name: o.name || null, forwarded: Boolean(o.forwarded) });
    }
  }
  if (!byKey.size) return;
  const run = async (attempt) => {
    let missing = false;
    for (const [readKey, m] of byKey) {
      try {
        const log = await prisma.invoiceReadLog.findFirst({ where: { readKey }, select: { id: true, routedTo: true } });
        if (!log) { missing = true; continue; }
        const prev = Array.isArray(log.routedTo) ? log.routedTo : [];
        const merged = [...prev.filter(p => !m.has(p.orderId)), ...m.values()];
        await prisma.invoiceReadLog.update({ where: { id: log.id }, data: { routedTo: merged } });
        byKey.delete(readKey);
      } catch (e) {
        console.error('[invoice-read-log] link:', String(e?.message || '').slice(0, 120));
      }
    }
    if (missing && attempt === 0) setTimeout(() => run(1), 3000);
  };
  run(0);
}

/**
 * سجلّ طلبية مكتوبة (نص كروب): يلصق _readKey بصفوفها لربطها بالطلبيات المُنشأة، ويتخطّى
 * الرسائل التي لم تكلّف شيئاً ولم تُنتج أصنافاً (دردشة رفضها المحلل بلا ذكاء).
 */
export function logTextOrderRead({ ctx = {}, text = '', calls = [], rows = [], readBy = null, mode = null, error = null, durationMs = 0 }) {
  if (!rows.length && !calls.length && !error) return;
  const readKey = randomUUID();
  for (const r of rows) if (r && typeof r === 'object') r._readKey = readKey;
  saveInvoiceReadLog({
    ctx, calls, rows, mode, readKey, durationMs,
    kind: 'text', sourceText: text, readBy: readBy || (calls.length ? 'ai' : null),
    ok: !error && rows.length > 0,
    error: error || (rows.length ? null : 'ليست طلبية'),
  });
}

/** يحذف السجلات الأقدم من KEEP_DAYS وصورها (القرص 89% — لا تتراكم الصور). */
async function prune() {
  try {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000);
    const old = await prisma.invoiceReadLog.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true, imageFile: true }, take: 500 });
    if (!old.length) return;
    for (const o of old) if (o.imageFile) fs.promises.unlink(path.join(INVOICE_READ_DIR, path.basename(o.imageFile))).catch(() => {});
    await prisma.invoiceReadLog.deleteMany({ where: { id: { in: old.map(o => o.id) } } });
  } catch (e) {
    console.error('[invoice-read-log] prune:', e?.message);
  }
}

export async function listInvoiceReadLogs({ days = 7, page = 1, pageSize = 50, kind = null } = {}) {
  prune();
  const d = Math.min(Math.max(parseInt(days) || 7, 1), KEEP_DAYS);
  // «صور الفواتير» تشمل ملفات PDF (فواتير أيضاً، بلا صورة)
  const where = { createdAt: { gte: new Date(Date.now() - d * 86400_000) }, ...(kind === 'photo' ? { kind: { in: ['photo', 'pdf'] } } : kind === 'text' ? { kind } : {}) };
  const take = Math.min(Math.max(parseInt(pageSize) || 50, 10), 200);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;
  const [rows, total, sums] = await Promise.all([
    prisma.invoiceReadLog.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
    prisma.invoiceReadLog.count({ where }),
    prisma.invoiceReadLog.aggregate({ where, _sum: { promptTokens: true, outputTokens: true, costUsd: true, calls: true } }),
  ]);
  return {
    rows: rows.map(r => ({ ...r, hasImage: Boolean(r.imageFile), imageFile: undefined, readKey: undefined })),
    total, page: Math.floor(skip / take) + 1, pageSize: take,
    sums: {
      images: total,
      calls: sums._sum.calls || 0,
      tokens: (sums._sum.promptTokens || 0) + (sums._sum.outputTokens || 0),
      costUsd: sums._sum.costUsd || 0,
    },
  };
}

export async function invoiceReadImagePath(id) {
  const log = await prisma.invoiceReadLog.findUnique({ where: { id: Number(id) }, select: { imageFile: true } });
  if (!log?.imageFile) return null;
  const p = path.join(INVOICE_READ_DIR, path.basename(log.imageFile));
  return fs.existsSync(p) ? p : null;
}
