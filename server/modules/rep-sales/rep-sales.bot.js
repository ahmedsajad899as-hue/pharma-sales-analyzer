// ════════════════════════════════════════════════════════════════════════════
// rep-sales.bot.js — «مبيعي …» من البوت ← «مبيعات المندوبين».
//
// قرار المستخدم 2026-11-04: رسالة البوت تُسجَّل مبيعاً للمندوب في الصفحة نفسها، وبنفس قاعدتها:
// بلا صورة «غير مؤكد» يؤكده المندوب لاحقاً، ومع صورة الفاتورة مؤكد مباشرةً. السعر من الكتالوج.
// الاستخراج نفسه (نص أو صورة + مطابقة الكتالوج) يجري في bot-order-flow.js.
// ════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import prisma from '../../lib/prisma.js';
import { normalizeArabic } from '../../lib/itemResolver.js';
import { buildRepIndex, matchRepName } from '../../lib/repNameMatch.js';
import { isFieldRole } from '../../lib/surveyDoctors.js';
import { parseExcelDate } from '../sales/sales.service.js';
import { buildLines, cleanText, loadViewer, parseDay, teamUserIds } from '../rep-orders/rep-orders.service.js';
import { SALE_IMAGE_DIR } from './rep-sales.service.js';

const EXAMPLE = 'مبيعي\nصيدلية النور - الكرخ\nبانادول 5 علبة';

/**
 * يقسّم صفوف الرسالة إلى مبيعات: كل صورة وفاتورة وصيدلية مبيع مستقل. الصف بلا صيدلية أو
 * كمية يُهمَل، لأن الصفحة لا تقبل مبيعاً بلا صيدلية.
 * @returns {{groups: Array<{imageIndex:number|null, rows:Array}>, skipped:number}}
 */
export function groupBotRows(rows = []) {
  const groups = new Map();
  let skipped = 0;
  for (const r of rows) {
    if (!cleanText(r.pharmacy) || !(Math.floor(Number(r.quantity)) > 0)) { skipped++; continue; }
    const imageIndex = Number.isInteger(r._imageIndex) ? r._imageIndex : null;
    const key = [imageIndex ?? '', cleanText(r.invoiceNumber) ?? '', normalizeArabic(r.pharmacy)].join('|');
    if (!groups.has(key)) groups.set(key, { imageIndex, rows: [] });
    groups.get(key).rows.push(r);
  }
  return { groups: [...groups.values()], skipped };
}

/** بصمة الرسالة. النص بلا صورة يُفصل باليوم: المبيع نفسه قد يتكرر فعلاً في يوم آخر. */
export function botSaleHash({ repUserId, sourceText, mediaKeys = [], now = new Date() }) {
  const text = String(sourceText ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const day = mediaKeys.length ? '' : now.toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`rep-sale|${repUserId}|${text}|${[...mediaKeys].map(String).sort().join(',')}|${day}`).digest('hex');
}

/**
 * صاحب المبيع: عضو الكروب المربوط بحسابه، ثم الحساب المربوط بالكروب إن كان مندوباً، ثم تطابق
 * تام لاسم المرسِل بمندوبي مكتب الحساب. الالتباس لا يُخمَّن: المبيع يُحسب لصاحبه.
 * @returns {Promise<number|null>}
 */
export async function resolveBotSaleRep({ user, senderRep = null, senderName = null }) {
  if (senderRep?.id) return senderRep.id;
  if (isFieldRole(user.role)) return user.id;
  if (!senderName) return null;
  const viewer = await loadViewer(user);
  const or = [{ id: { in: await teamUserIds(viewer) } }];
  if (viewer.officeId) or.push({ officeId: viewer.officeId });
  const candidates = await prisma.user.findMany({ where: { isActive: true, OR: or }, select: { id: true, role: true, displayName: true, username: true } });
  const reps = candidates.filter(u => isFieldRole(u.role)).map(u => ({ id: u.id, name: u.displayName || u.username }));
  const m = matchRepName(senderName, buildRepIndex(reps));
  return m.status === 'exact' ? m.rep.id : null;
}

async function saveInvoiceImage(buffer) {
  await fs.promises.mkdir(SALE_IMAGE_DIR, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  await fs.promises.writeFile(path.join(SALE_IMAGE_DIR, name), buffer);
  return `/uploads/rep-sales/${name}`;
}

const saleDayOf = (rows) => {
  const raw = rows.find(r => r.date)?.date;
  const d = raw ? parseExcelDate(raw) : null;
  return parseDay(d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);
};

/**
 * يحفظ صفوف رسالة بوت مبيعاتٍ للمندوب، ويعيد نصّ الردّ.
 * @param {object} p
 * @param {object} p.user الحساب المربوط بالكروب
 * @param {object|null} [p.senderRep] عضو الكروب المربوط بحساب مندوب
 * @param {string|null} [p.senderName]
 * @param {string|null} [p.sourceText]
 * @param {string[]} [p.mediaKeys]
 * @param {Array} p.rows صفوف بعد مطابقة الكتالوج
 * @param {Buffer[]} [p.imageBuffers] صور الفواتير بترتيب _imageIndex
 * @returns {Promise<string>}
 */
export async function ingestBotRepSales({ user, senderRep = null, senderName = null, sourceText = null, mediaKeys = [], rows, imageBuffers = [] }) {
  const repUserId = await resolveBotSaleRep({ user, senderRep, senderName });
  if (!repUserId) {
    return '⚠️ لم أتعرّف على المندوب صاحب هذا المبيع، فلم يُسجَّل. اربط حسابك بالكروب، أو سجّله من صفحة «مبيعات المندوبين».';
  }

  const sourceHash = botSaleHash({ repUserId, sourceText, mediaKeys });
  if (await prisma.repSale.findFirst({ where: { sourceHash }, select: { id: true } })) {
    return '🔁 هذا المبيع مُسجَّل مسبقاً — لم يُكرَّر.';
  }

  const { groups, skipped } = groupBotRows(rows);
  const prepared = [];
  for (const g of groups) {
    const lines = await buildLines(g.rows.map(r => ({
      itemId: r._itemId, itemName: r.item, companyName: r.company, quantity: r.quantity, bonusQty: r.bonus,
    })));
    if (lines.length) prepared.push({ ...g, lines });
  }
  if (!prepared.length) {
    return `⚠️ لم أجد صنفاً بكمية واسم صيدلية، فلم يُسجَّل شيء. اكتب مثلاً:\n${EXAMPLE}`;
  }

  const rep = await prisma.user.findUnique({ where: { id: repUserId }, select: { officeId: true, displayName: true, username: true } });
  const now = new Date();
  const data = [];
  for (const g of prepared) {
    // صورة واحدة بلا فهرس (تلكرام/فايبر) تخص كل صفوف الرسالة.
    const buffer = imageBuffers[g.imageIndex ?? 0] ?? null;
    const invoiceImage = buffer ? await saveInvoiceImage(buffer) : null;
    data.push({
      officeId: rep?.officeId ?? user.officeId ?? null,
      createdById: repUserId,
      saleDate: saleDayOf(g.rows),
      pharmacyName: cleanText(g.rows[0].pharmacy, 160),
      areaName: cleanText(g.rows.find(r => r.area)?.area, 120),
      warehouseName: cleanText(g.rows.find(r => r.warehouse)?.warehouse, 120),
      invoiceNumber: cleanText(g.rows.find(r => r.invoiceNumber)?.invoiceNumber, 60),
      notes: 'سُجّل من البوت',
      status: invoiceImage ? 'confirmed' : 'pending',
      invoiceImage,
      confirmedAt: invoiceImage ? now : null,
      confirmedById: invoiceImage ? repUserId : null,
      sourceHash,
      lines: g.lines,
    });
  }
  await prisma.$transaction(data.map(({ lines, ...head }) => prisma.repSale.create({ data: { ...head, lines: { create: lines } } })));

  const confirmed = data.filter(d => d.status === 'confirmed').length;
  const pending = data.length - confirmed;
  const allLines = data.flatMap(d => d.lines);
  const out = [`✅ سُجّل في «مبيعات المندوبين» باسم ${rep?.displayName || rep?.username || 'المندوب'}: ${data.length} مبيع · ${allLines.length} صنف`];
  if (confirmed) out.push(`• ${confirmed} مؤكد بصورة الفاتورة`);
  if (pending) out.push(`• ${pending} غير مؤكد — لا يُحسب حتى يؤكَّد من الصفحة أو تُرفق صورة فاتورته`);
  const noPrice = allLines.filter(l => l.unitPrice == null).length;
  if (noPrice) out.push(`ℹ️ ${noPrice} صنف بلا سعر من الكتالوج — تُحسب كميته لا قيمته.`);
  const noArea = data.filter(d => !d.areaName).length;
  if (noArea) out.push(`ℹ️ ${noArea} مبيع بلا منطقة.`);
  if (skipped) out.push(`⚠️ أُهمل ${skipped} سطر بلا كمية أو صيدلية.`);
  return out.join('\n');
}
