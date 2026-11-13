// ════════════════════════════════════════════════════════════════════════════
// rep-orders.import.js — «📥 استيراد من الفايبر» في صفحة طلبيات المذاخر.
//
// الفايبر لا يسمح لأي بوت بقراءة كروب عادي، وقاعدة بيانات Viber Desktop مشفّرة
// (فُحصت 2026-11-13) — فالطلبيات تدخل بطريقتين: لصق نص الرسائل، أو سكرين شوت
// يُنسخ نصّه بالذكاء. الطريقتان تنتهيان بنفس المحلّل (viber-order-parse.js) ثم:
//   • مطابقة الأصناف بالكتالوج (enrichRowsFromCatalog)
//   • مطابقة المذاخر بدليل المذاخر (matchWarehouse) — الأول أساسي والباقي احتياط
//   • المندوب: اسم المرسل (من السكرين شوت) ← ما اختاره المستخدم لنفس المرسل سابقاً
//     ← المندوب العلمي صاحب منطقة الطلبية (loadRepScope)
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
import { isPharmacyRep } from '../../lib/pharmacyRep.js';
import { resolveEffectiveAreaIds, userHasAllAreas } from '../../lib/areaScope.js';
import { normKey } from '../orders/order-text-parse.js';
import { loadKnownWarehouseKeys, loadKnownAreaIndex } from '../orders/order-extract.js';
import { enrichRowsFromCatalog } from '../orders/orders.service.js';
import { matchWarehouse, warehouseReady } from '../warehouse-dispatch/dispatch.core.js';
import { loadViewer, teamUserIds, orderScopeWhere, warehouseScopeWhere, cleanText } from './rep-orders.service.js';
import { parseViberOrder, orderFingerprint, splitPasteIntoOrders } from './viber-order-parse.js';

const MAX_BLOCKS = 40;
const MAX_BLOCK_LEN = 2500;
const MAX_SHOTS = 8;
const DUP_DAYS = 3;

// ─── المندوبون المتاحون للمُشاهِد ─────────────────────────────────────────────

/**
 * المندوبون الذين تُحسب لهم طلبيات الفايبر: **العلميون** في فريق صاحب الحساب الذي يستورد
 * (مدير الشركة) — لا المسوقون (سجل مندوب repKind='pharmacy') ولا المدراء. طلبية يرسلها
 * مسوق في الكروب تُنسب للعلمي صاحب المنطقة والايتم (طلب صاحب المشروع 2026-11-13).
 */
async function loadTeam(viewer) {
  const ids = await teamUserIds(viewer);
  const users = await prisma.user.findMany({
    where: { id: { in: ids, not: viewer.id }, isActive: true, role: { in: ['scientific_rep', 'team_leader'] } },
    select: { id: true, displayName: true, username: true, role: true, linkedRep: { select: { repKind: true } } },
  });
  const list = users
    .filter(u => !isPharmacyRep(u.linkedRep))
    .map(u => ({ id: u.id, name: u.displayName?.trim() || u.username, role: u.role }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return { ids: new Set(list.map(u => u.id)), list, index: buildRepIndex(list) };
}

/**
 * مفتاح منطقة مرن للمطابقة بين ما كُتب في الطلبية واسم المنطقة المعيّنة للمندوب:
 * بلا «شارع/حي/منطقة» وبلا «ال» وبلا مسافات — «شارع فلسطين» = «فلسطين»، «يوسفية» = «اليوسفيه».
 */
const looseArea = (s) => normalizeAreaName(String(s ?? ''))
  .replace(/(^|\s)(?:شارع|حي|منطقه|منطقة|محله|محلة|قرب|مقابل)(?=\s)/g, ' ')
  .replace(/(^|\s)ال/g, '$1')
  .replace(/\s+/g, '');
const areaMatches = (repKeys, orderKey) => {
  if (!orderKey) return false;
  if (repKeys.has(orderKey)) return true;
  for (const k of repKeys) if (k.length >= 4 && orderKey.length >= 4 && (k.includes(orderKey) || orderKey.includes(k))) return true;
  return false;
};

/**
 * لكل مندوب علمي في الفريق: مفاتيح أسماء مناطقه الفعلية (resolveEffectiveAreaIds = التعيين
 * اليدوي + سجل المندوب + المحافظات)، وهل عنده راية «كل المناطق»، وايتماته (حسابه + سجله).
 * بالاسم المطبَّع لا بالمعرّف: نفس اسم المنطقة صفوف مستقلة لكل حساب.
 */
async function loadRepScope(team) {
  const ids = team.list.map(u => u.id);
  if (!ids.length) return new Map();
  const [perRep, users] = await Promise.all([
    Promise.all(ids.map(async id => ({ id, all: await userHasAllAreas(id), areaIds: await resolveEffectiveAreaIds(id) }))),
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, itemAssignments: { select: { itemId: true } }, linkedRep: { select: { items: { select: { itemId: true } } } } },
    }),
  ]);
  const allIds = [...new Set(perRep.filter(r => !r.all).flatMap(r => r.areaIds))];
  const areas = allIds.length ? await prisma.area.findMany({ where: { id: { in: allIds } }, select: { id: true, name: true } }) : [];
  const keyById = new Map(areas.map(a => [a.id, normalizeAreaName(a.name)]));
  const itemsById = new Map(users.map(u => [u.id, new Set([
    ...u.itemAssignments.map(x => x.itemId), ...(u.linkedRep?.items ?? []).map(x => x.itemId),
  ])]));
  return new Map(perRep.map(r => [r.id, {
    all: r.all,
    areas: new Set(r.all ? [] : r.areaIds.map(id => keyById.get(id)).filter(Boolean).map(looseArea).filter(Boolean)),
    items: itemsById.get(r.id) ?? new Set(),
  }]));
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

// ─── ما لم يحسمه الشكل: الكتالوج بدل الذكاء ──────────────────────────────────
// (طلب صاحب المشروع 2026-11-13: لصق الفايبر بلا استهلاك ذكاء — المحلّل + بيانات المكتب)

/**
 * سطر صنف برقم مجرّد في آخره («Potafast 10»، «Devit 50»): الشكل وحده لا يفرّق بين
 * الكمية والتركيز، فيحسمه الكتالوج — الاسم كاملاً بالرقم صنفٌ معروف ⇒ الرقم تركيز (يبقى
 * للمستخدم)؛ الاسم بلا الرقم صنفٌ معروف ⇒ الرقم كمية.
 * سطر لم يُحسم يصير صنفاً بكمية فارغة يكمله المستخدم بالبحث الذكي — لا نداء ذكاء.
 */
async function resolveWithCatalog(parsed, userId) {
  const items = [...parsed.items];
  const still = [];
  for (const line of parsed.unparsed) {
    const m = String(line).trim().match(/^(.*?[a-z].*?)\s*[*×x]?\s*(\d+)\s*(?:p|pc|pcs|ع|علبة|علب)?\s*$/i);
    if (m) {
      const whole = [{ item: line.trim() }];
      const bare = [{ item: m[1].trim() }];
      try { await enrichRowsFromCatalog(whole, userId, { linkOnly: true }); await enrichRowsFromCatalog(bare, userId, { linkOnly: true }); }
      catch { /* بلا كتالوج يبقى السطر للمستخدم */ }
      if (!whole[0]._itemId && bare[0]._itemId) { items.push({ name: m[1].trim(), quantity: Number(m[2]), bonus: 0 }); continue; }
    }
    still.push(line);
  }
  // ما بقي: صنف بلا كمية — يظهر بخانة بحث وكمية فارغة
  for (const line of still) items.push({ name: String(line).trim(), quantity: 0, bonus: 0, unsure: true });
  return { ...parsed, items, unparsed: still, readBy: 'parser' };
}

// ─── المسوّدة ────────────────────────────────────────────────────────────────

/**
 * @param {{ text:string, sender?:string|null, partial?:boolean }[]} messages
 * @param {'viber-paste'|'viber-shot'} source
 */
async function buildDrafts(reqUser, messages, source) {
  const viewer = await loadViewer(reqUser);
  const [knownWh, areas, team, recent, directory, pastPharmacies] = await Promise.all([
    loadKnownWarehouseKeys(), loadKnownAreaIndex(), loadTeam(viewer), recentFingerprints(viewer),
    // «تعليم» المحلّل من بيانات المكتب: دليل مذاخر الحساب، وأسماء صيدليات طلبياته السابقة
    warehouseScopeWhere(viewer).then(where => prisma.orderWarehouse.findMany({ where, select: { name: true } })),
    orderScopeWhere(viewer).then(where => prisma.repOrder.findMany({ where, select: { pharmacyName: true }, distinct: ['pharmacyName'], orderBy: { id: 'desc' }, take: 4000 })),
  ]);
  const areaOf = (t) => areas.get(normalizeAreaName(t)) ?? null;
  const repScope = await loadRepScope(team);
  const dirKeys = new Set(directory.map(w => normKey(String(w.name).replace(/مذخر|مذاخر/g, ''))).filter(Boolean));
  const isKnownWarehouse = (t) => knownWh.has(normKey(t)) || dirKeys.has(normKey(t));
  const phKeys = new Set(pastPharmacies.map(o => normKey(o.pharmacyName)).filter(k => k && k.length >= 3));
  const isKnownPharmacy = (t) => phKeys.has(normKey(t));

  const parsedAll = await Promise.all(messages.map(async (m) => {
    const p = parseViberOrder(m.text, { areaOf, isKnownWarehouse, isKnownPharmacy });
    // رسالة بلا أي صنف ولا سطر ملتبس = دردشة/منشن وحده ← ليست طلبية
    if (!p.items.length && !p.unparsed.length) return null;
    return { msg: m, parsed: await resolveWithCatalog(p, viewer.id) };
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
      companyName: r.company ?? null,
      unitPrice: r.unitPrice ?? null,
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

    // المندوب العلمي = صاحب **منطقة** الطلبية في فريق المستورد (طلب صاحب المشروع 2026-11-13):
    //   • مندوب واحد معيّنة له المنطقة ⇒ يُختار مباشرة
    //   • أكثر من واحد ⇒ تحسمه الايتمات (من تُعيَّن له أصناف الطلبية)، وإلا يبقى الاختيار بينهم
    //   • المرشّحون (★) أصحاب المنطقة فقط — لا يُقترح مندوب بلا المنطقة
    // اسم المرسل/ما اختير له سابقاً يُقبل فقط إن كان من أصحاب المنطقة (أو المنطقة غير معروفة).
    // الأولوية: المندوب العلمي صاحب المنطقة، وإن لم يوجد فالتيم ليدر صاحبها (طلب صاحب المشروع 2026-11-14)
    const areaKey = looseArea(parsed.area || '');
    const covers = (u) => areaMatches(repScope.get(u.id)?.areas ?? new Set(), areaKey);
    const sci = team.list.filter(u => u.role === 'scientific_rep');
    const leaders = team.list.filter(u => u.role === 'team_leader');
    let pool = areaKey ? sci.filter(covers) : [];
    let leaderPick = false;
    if (areaKey && !pool.length) { pool = leaders.filter(covers); leaderPick = pool.length > 0; }
    if (areaKey && !pool.length) pool = sci.filter(u => repScope.get(u.id)?.all);
    const itemIds = new Set(rows.map(r => r._itemId).filter(Boolean));
    if (pool.length > 1 && itemIds.size) {
      const byItems = pool.filter(u => [...itemIds].some(id => repScope.get(u.id)?.items.has(id)));
      if (byItems.length) pool = byItems;
    }
    // سجلّ تشخيص (PM2) — يُقرأ عبر SSH حين لا يُختار المندوب المتوقَّع
    if (!pool.length || pool.length > 1) {
      console.log(`[viber-import] rep viewer=${viewer.id} area="${parsed.area}" key=${areaKey} pool=${pool.map(u => u.name).join('|') || '-'} team=${team.list.map(u => `${u.name}:${u.role}:${[...(repScope.get(u.id)?.areas ?? [])].slice(0, 12).join(',')}`).join(' ; ')}`);
    }
    const repCandidates = pool.map(u => ({ id: u.id, name: u.name }));
    const inPool = (id) => !areaKey || pool.some(u => u.id === id);

    let rep = null;
    let repWhy = null;
    const sender = cleanText(msg.sender, 80);
    if (sender && learned.has(sender) && team.ids.has(learned.get(sender)) && inPool(learned.get(sender))) {
      rep = team.list.find(u => u.id === learned.get(sender)) ?? null;
      repWhy = 'learned';
    }
    if (!rep && sender) {
      const m = matchRepName(sender, team.index);
      if (m.status === 'exact' && inPool(m.rep.id)) { rep = m.rep; repWhy = 'sender'; }
    }
    if (!rep && pool.length === 1) { rep = pool[0]; repWhy = leaderPick ? 'leader' : 'area'; }
    const repNote = rep || pool.length > 1 ? null
      : !parsed.area ? 'لم تُعرف المنطقة'
      : `«${parsed.area}» غير معيّنة لمندوب علمي أو تيم ليدر في فريقك`;

    // التكرار
    const sourceHash = orderFingerprint({ pharmacy: parsed.pharmacy, items: parsed.items });
    const canonFp = orderFingerprint({ pharmacy: parsed.pharmacy, items: lines.map(l => ({ name: l.itemName, quantity: l.quantity, bonus: l.bonusQty })) });
    const duplicateOf = (sourceHash && recent.get(sourceHash)) || (canonFp && recent.get(canonFp)) || null;
    const batchKey = sourceHash || canonFp;
    const dupInBatch = batchKey && seenInBatch.has(batchKey) ? seenInBatch.get(batchKey) : null;
    if (batchKey && !seenInBatch.has(batchKey)) seenInBatch.set(batchKey, i);

    const warnings = [];
    if (msg.partial) warnings.push('مقطوعة في الصورة — راجع الأصناف');
    if (parsed.unparsed.length) warnings.push(`أكمل الكمية: ${parsed.unparsed.join(' · ')}`);
    if (!parsed.pharmacy) warnings.push('لم تُعرف الصيدلية — اكتبها');
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
      repNote,
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
