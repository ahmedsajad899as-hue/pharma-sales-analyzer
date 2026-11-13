// ════════════════════════════════════════════════════════════════════════════
// rep-orders.import.js — «📥 استيراد من الفايبر» في صفحة طلبيات المذاخر.
//
// الفايبر لا يسمح لأي بوت بقراءة كروب عادي، وقاعدة بيانات Viber Desktop مشفّرة
// (فُحصت 2026-11-13) — فالطلبيات تدخل بطريقتين: لصق نص الرسائل، أو سكرين شوت
// يُنسخ نصّه بالذكاء. الطريقتان تنتهيان بنفس المحلّل (viber-order-parse.js) ثم:
//   • مطابقة الأصناف بالكتالوج (enrichRowsFromCatalog)
//   • مطابقة المذاخر بدليل المذاخر (matchWarehouse) — الأول أساسي والباقي احتياط
//   • المندوب: اسم المرسل (من السكرين شوت) ← ما اختاره المستخدم لنفس المرسل سابقاً
//     ← تخمين المواد والمنطقة (attachScientificRepGuess)
//   • كشف التكرار: داخل الدفعة + طلبيات آخر 3 أيام في نطاق المُشاهِد
//
// **لا يُنشئ شيئاً** — يُعيد مسوّدات تراجعها الواجهة، ثم تُحفظ بـ POST /api/rep-orders
// العادي (مع حقول المصدر) وتُرسل بمسار «إرسال عبر البوت» الموجود.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { callAI } from '../../lib/geminiAi.js';
import { getManagerRoster } from '../../lib/managerRoster.js';
import { buildRepIndex, matchRepName, repCoreKey } from '../../lib/repNameMatch.js';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import { normKey } from '../orders/order-text-parse.js';
import { extractOrderRowsFromText, loadKnownWarehouseKeys, loadKnownAreaIndex } from '../orders/order-extract.js';
import { enrichRowsFromCatalog, attachScientificRepGuess } from '../orders/orders.service.js';
import { matchWarehouse, warehouseReady } from '../warehouse-dispatch/dispatch.core.js';
import { loadViewer, teamUserIds, orderScopeWhere, cleanText } from './rep-orders.service.js';
import { parseViberOrder, orderFingerprint, splitPasteIntoOrders } from './viber-order-parse.js';

const MAX_BLOCKS = 40;
const MAX_BLOCK_LEN = 2500;
const MAX_SHOTS = 8;
const DUP_DAYS = 3;

// ─── المندوبون المتاحون للمُشاهِد ─────────────────────────────────────────────

async function loadTeam(viewer) {
  const ids = await teamUserIds(viewer);
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true, username: true, role: true },
  });
  const list = users.map(u => ({ id: u.id, name: u.displayName?.trim() || u.username, role: u.role }));
  return { ids: new Set(ids), list, index: buildRepIndex(list) };
}

/** ما اختاره المستخدم لنفس اسم المرسل في استيراد سابق ← نفس المندوب. */
async function learnedSenders(viewer, senders) {
  const keys = [...new Set(senders.filter(Boolean))];
  if (!keys.length) return new Map();
  const rows = await prisma.repOrder.findMany({
    where: { AND: [{ sourceSender: { in: keys } }, await orderScopeWhere(viewer)] },
    select: { sourceSender: true, createdById: true },
    orderBy: { id: 'desc' },
    take: 500,
  });
  const map = new Map();
  for (const r of rows) if (!map.has(r.sourceSender)) map.set(r.sourceSender, r.createdById);
  return map;
}

// ─── التكرار ─────────────────────────────────────────────────────────────────

async function recentFingerprints(viewer) {
  const since = new Date(Date.now() - DUP_DAYS * 86_400_000);
  const orders = await prisma.repOrder.findMany({
    where: { AND: [{ createdAt: { gte: since } }, await orderScopeWhere(viewer)] },
    select: { id: true, pharmacyName: true, sourceHash: true, createdAt: true, status: true, lines: { select: { itemName: true, quantity: true, bonusQty: true } } },
    orderBy: { id: 'desc' },
    take: 1500,
  });
  const byFp = new Map();
  for (const o of orders) {
    const info = { id: o.id, pharmacyName: o.pharmacyName, createdAt: o.createdAt, status: o.status };
    const fp = orderFingerprint({ pharmacy: o.pharmacyName, items: o.lines });
    if (fp && !byFp.has(fp)) byFp.set(fp, info);
    if (o.sourceHash && !byFp.has(o.sourceHash)) byFp.set(o.sourceHash, info);
  }
  return byFp;
}

// ─── الدمج مع الذكاء ─────────────────────────────────────────────────────────

const brand = (s) => (normKey(s).match(/[a-z؀-ۿ]{3,}/) || [''])[0];

/**
 * ما لم يحسمه الشكل يُقرأ بالذكاء (نفس برومبت طلبيات البوت). المحلّل يغلب حيث حسم:
 * الصيدلية بـ«ص»، وكمية كل صنف قُرئ سطره.
 */
async function withAiFallback(parsed) {
  if (!parsed.needsAi) return { ...parsed, readBy: 'parser' };
  let rows = [];
  try { rows = await extractOrderRowsFromText(parsed.cleanText); }
  catch (e) { console.error('[viber-import] الذكاء:', e?.message); }
  if (!rows.length) return { ...parsed, readBy: 'parser', aiFailed: true };

  const sure = new Map(parsed.items.map(i => [brand(i.name), i]));
  const items = [];
  for (const r of rows) {
    const b = brand(r.item);
    const p = b && sure.get(b);
    if (p) { items.push(p); sure.delete(b); continue; }
    if (r.quantity > 0) items.push({ name: r.item, quantity: Number(r.quantity), bonus: Number(r.bonus) || 0 });
  }
  for (const p of sure.values()) items.push(p); // صنف حسمه المحلّل ولم يذكره الموديل
  const first = rows[0] || {};
  return {
    ...parsed,
    items,
    pharmacy: parsed.headerSure ? parsed.pharmacy : (first.pharmacy || parsed.pharmacy),
    area: parsed.headerSure && parsed.area ? parsed.area : (first.area || parsed.area),
    warehouses: parsed.warehouses.length ? parsed.warehouses : (first.warehouse ? [first.warehouse] : []),
    readBy: 'ai',
  };
}

// ─── المسوّدة ────────────────────────────────────────────────────────────────

/**
 * @param {{ text:string, sender?:string|null, partial?:boolean }[]} messages
 * @param {'viber-paste'|'viber-shot'} source
 */
async function buildDrafts(reqUser, messages, source) {
  const viewer = await loadViewer(reqUser);
  const [knownWh, areas, team, recent] = await Promise.all([
    loadKnownWarehouseKeys(), loadKnownAreaIndex(), loadTeam(viewer), recentFingerprints(viewer),
  ]);
  const areaOf = (t) => areas.get(normalizeAreaName(t)) ?? null;
  const isKnownWarehouse = (t) => knownWh.has(normKey(t));

  const parsedAll = await Promise.all(messages.map(async (m) => {
    const p = parseViberOrder(m.text, { areaOf, isKnownWarehouse });
    // رسالة بلا أي صنف ولا سطر ملتبس = دردشة/منشن وحده ← ليست طلبية (بلا كلفة ذكاء)
    if (!p.items.length && !p.unparsed.length) return null;
    return { msg: m, parsed: await withAiFallback(p) };
  }));
  const found = parsedAll.filter(Boolean);
  const learned = await learnedSenders(viewer, found.map(f => f.msg.sender));

  const seenInBatch = new Map();
  const drafts = [];
  for (const [i, { msg, parsed }] of found.entries()) {
    const rows = parsed.items.map(it => ({ item: it.name, quantity: it.quantity, bonus: it.bonus, area: parsed.area, unitPrice: null, total: null }));
    await enrichRowsFromCatalog(rows, viewer.id);

    const lines = rows.map((r, j) => ({
      itemId: r._itemId ?? null,
      itemName: r.item,
      writtenAs: parsed.items[j]?.name ?? r.item,
      quantity: Number(r.quantity) || 0,
      bonusQty: Number(r.bonus) || 0,
      matched: Boolean(r._itemId),
      suggestions: r._itemId ? [] : (r._itemMatch?.suggestions || []).slice(0, 4)
        .map(s => ({ id: s.id, name: s.name })).filter(s => s.id && s.name),
    }));

    // المذاخر: كل ما ذُكر في الرسالة بترتيبه (الواجهة تعرضها ليختار المستخدم من تذهب له
    // الطلبية) — الأول المطابَق أساسي، والباقي احتياط. غير الموجود في الدليل يُعرض اسماً فقط.
    const mentioned = [];
    for (const name of parsed.warehouses) {
      const w = await matchWarehouse(name, viewer);
      if (w ? mentioned.some(x => x.id === w.id) : mentioned.some(x => !x.id && x.name === name)) continue;
      mentioned.push(w ? { id: w.id, name: w.name, ready: warehouseReady(w) } : { id: null, name, ready: false });
    }
    const whMatched = mentioned.filter(m => m.id);
    const whUnmatched = mentioned.filter(m => !m.id).map(m => m.name);
    const primary = whMatched[0] ?? null;

    // المندوب
    let rep = null;
    let repWhy = null;
    const sender = cleanText(msg.sender, 80);
    if (sender && learned.has(sender) && team.ids.has(learned.get(sender))) {
      rep = team.list.find(u => u.id === learned.get(sender)) ?? null;
      repWhy = 'learned';
    }
    if (!rep && sender) {
      const m = matchRepName(sender, team.index);
      if (m.status === 'exact') { rep = m.rep; repWhy = 'sender'; }
    }
    let repCandidates = [];
    if (!rep) {
      await attachScientificRepGuess(rows, viewer);
      const named = rows.map(r => r.scientificRep).filter(Boolean);
      const uniq = [...new Set(named.map(repCoreKey))];
      if (uniq.length === 1) {
        const hit = team.list.find(u => repCoreKey(u.name) === uniq[0]);
        if (hit) { rep = hit; repWhy = 'guess'; }
      }
      const ids = new Set();
      for (const r of rows) for (const c of (r._repCandidates || [])) if (c.id > 0 && team.ids.has(c.id)) ids.add(c.id);
      repCandidates = team.list.filter(u => ids.has(u.id)).map(u => ({ id: u.id, name: u.name }));
    }

    // التكرار
    const sourceHash = orderFingerprint({ pharmacy: parsed.pharmacy, items: parsed.items });
    const canonFp = orderFingerprint({ pharmacy: parsed.pharmacy, items: lines.map(l => ({ name: l.itemName, quantity: l.quantity, bonus: l.bonusQty })) });
    const duplicateOf = (sourceHash && recent.get(sourceHash)) || (canonFp && recent.get(canonFp)) || null;
    const batchKey = sourceHash || canonFp;
    const dupInBatch = batchKey && seenInBatch.has(batchKey) ? seenInBatch.get(batchKey) : null;
    if (batchKey && !seenInBatch.has(batchKey)) seenInBatch.set(batchKey, i);

    const warnings = [];
    if (msg.partial) warnings.push('مقطوعة في الصورة — راجع الأصناف');
    if (parsed.aiFailed) warnings.push('تعذّرت قراءة بعض الأسطر — أكملها يدوياً');
    if (parsed.unparsed.length && parsed.readBy !== 'ai') warnings.push(`لم تُقرأ: ${parsed.unparsed.join(' · ')}`);
    if (!parsed.headerSure) warnings.push('راجع اسم الصيدلية والمنطقة');

    drafts.push({
      key: `${Date.now().toString(36)}-${i}`,
      source,
      sourceText: msg.text,
      sender,
      mentions: parsed.mentions,
      readBy: parsed.readBy,
      pharmacyName: parsed.pharmacy ?? '',
      areaName: parsed.area ?? '',
      warehouseId: primary?.id ?? null,
      warehouseName: primary?.name ?? whUnmatched[0] ?? '',
      backupWarehouseIds: whMatched.slice(1).map(w => w.id),
      mentionedWarehouses: mentioned,
      notes: parsed.notes.join(' — '),
      lines,
      repUserId: rep?.id ?? null,
      repName: rep?.name ?? null,
      repWhy,
      repCandidates,
      sourceHash,
      duplicateOf: duplicateOf ? { id: duplicateOf.id, pharmacyName: duplicateOf.pharmacyName, createdAt: duplicateOf.createdAt, status: duplicateOf.status } : null,
      dupInBatch: dupInBatch != null,
      warnings,
    });
  }
  return { drafts, team: team.list.map(u => ({ id: u.id, name: u.name })) };
}

// ─── النص ────────────────────────────────────────────────────────────────────

/** body.blocks: لصقات منفصلة (كل Ctrl+V كتلة). لصقة فيها عدة طلبيات تُقسَّم. */
export async function importFromText(reqUser, body) {
  const raw = Array.isArray(body?.blocks) ? body.blocks : [body?.text];
  const messages = raw
    .map(b => String(b ?? '').slice(0, MAX_BLOCK_LEN * 4))
    .flatMap(splitPasteIntoOrders)
    .filter(t => t.trim())
    .slice(0, MAX_BLOCKS)
    .map(text => ({ text: text.slice(0, MAX_BLOCK_LEN), sender: null }));
  if (!messages.length) throw new AppError('الصق نص طلبية واحدة على الأقل', 400);
  return buildDrafts(reqUser, messages, 'viber-paste');
}

// ─── السكرين شوت ─────────────────────────────────────────────────────────────

const SHOT_PROMPT = `هذه لقطة شاشة لمحادثة كروب (فايبر/واتساب) فيها طلبيات أدوية يرسلها مندوبون.
انسخ نص **كل فقاعة رسالة** كما هو حرفياً — بلا تصحيح ولا ترجمة ولا اختصار — مع الحفاظ على تقسيم الأسطر داخل الفقاعة.

القواعد:
- أسماء الأدوية الإنجليزية والأرقام والأقواس وعلامات + و * تُنسخ كما هي تماماً («Potafast 10(+1)»، «Amoklavin 625mg *20(+2)»).
- اسم المرسل يظهر أعلى الفقاعة بلون مختلف. إن لم يظهر فوق الفقاعة ضع sender: null.
- الرسالة المرسلة من صاحب الشاشة (عليها علامة صحّ ✓ للتسليم) ضع لها outgoing: true.
- المنشنات (@اسم) انسخها في أسطرها كما هي.
- تجاهل: الوقت، «Yesterday/Today»، أزرار التفاعل والقلوب، فقاعات الصور بلا نص، رسائل النظام، شريط الكتابة.
- فقاعة مقطوعة عند أعلى أو أسفل الصورة: انسخ الظاهر منها وضع partial: true.

أعِد **مصفوفة JSON فقط** بلا أي نص قبلها أو بعدها وبلا أسوار \`\`\`، بترتيب الفقاعات من الأعلى للأسفل:
[{"sender": "اسم المرسل أو null", "outgoing": false, "partial": false, "text": "نص الفقاعة\\nبأسطرها"}]`;

function parseJsonArray(reply) {
  const s = String(reply ?? '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try { const v = JSON.parse(s.slice(a, b + 1)); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

/** files: صور multer (memoryStorage). كل صورة نداء ذكاء واحد ينسخ الفقاعات، ثم نفس مسار النص. */
export async function importFromScreenshots(reqUser, files) {
  const list = (Array.isArray(files) ? files : []).slice(0, MAX_SHOTS);
  if (!list.length) throw new AppError('أرفق سكرين شوت واحداً على الأقل', 400);
  const perShot = await Promise.all(list.map(async (f) => {
    const data = f.buffer ? f.buffer.toString('base64') : fs.readFileSync(f.path).toString('base64');
    try {
      const reply = await callAI(
        [SHOT_PROMPT, { inlineData: { mimeType: f.mimetype || 'image/jpeg', data } }],
        { timeoutMs: 90_000, feature: 'viber-screenshot' },
      );
      return parseJsonArray(reply);
    } catch (e) {
      console.error('[viber-import] قراءة السكرين شوت:', String(e?.message || '').slice(0, 200));
      return null;
    } finally {
      if (f.path) fs.promises.unlink(f.path).catch(() => {});
    }
  }));
  if (perShot.every(x => x == null)) throw new AppError('تعذّرت قراءة الصور — أعد المحاولة', 502);

  // الفقاعة بلا اسم بعد فقاعة لنفس الجهة = نفس المرسل (الفايبر يكتب الاسم على أول رسالة فقط)
  const messages = [];
  for (const bubbles of perShot) {
    let last = null;
    for (const b of (bubbles || [])) {
      const text = String(b?.text ?? '').trim();
      if (!text) continue;
      const own = b?.outgoing === true;
      const named = String(b?.sender ?? '').trim();
      const sender = own ? null : (named && named.toLowerCase() !== 'null' ? named : last);
      if (!own && sender) last = sender;
      if (own) last = null;
      messages.push({ text: text.slice(0, MAX_BLOCK_LEN), sender, partial: b?.partial === true });
    }
  }
  if (!messages.length) return { drafts: [], team: [] };
  return buildDrafts(reqUser, messages.slice(0, MAX_BLOCKS), 'viber-shot');
}

// ─── الرد للفايبر ────────────────────────────────────────────────────────────

/** يسجّل أن رد الطلبية نُسخ للفايبر (فلتر «بانتظار الرد»). */
export async function markFeedbackCopied(reqUser, id) {
  const viewer = await loadViewer(reqUser);
  const order = await prisma.repOrder.findFirst({ where: { AND: [{ id: Number(id) }, await orderScopeWhere(viewer)] }, select: { id: true } });
  if (!order) throw new AppError('الطلبية غير موجودة', 404, 'NOT_FOUND');
  const at = new Date();
  await prisma.repOrder.update({ where: { id: order.id }, data: { feedbackCopiedAt: at } });
  return { feedbackCopiedAt: at };
}
