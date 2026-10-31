// ════════════════════════════════════════════════════════════════════════════
// manualDuplicateCheck.js — «هل هذه الفاتورة/الطلبية محفوظة سابقاً؟» قبل الحفظ.
//
// بصمة الملف التراكمي (saleFingerprint.js) تُسقط إعادة الإرسال الحرفية فقط، وهي
// لا تكفي هنا لثلاثة أسباب مُشاهَدة:
//   1) طلبية بوت بلا رقم فاتورة تُحفظ برقم تركيبي `BOT-<id>` — يختلف في كل مرة.
//   2) قراءة Gemini الثانية لنفس الصورة تخرج بسعر/إجمالي/نص تاريخ مختلف قليلاً.
//   3) الطلبية تصل نصّاً (ناقصة: بلا تاريخ ولا رقم) ثم صورةً (كاملة) أو بالعكس —
//      محتوى مختلف فعلاً لنفس الطلبية.
// فهنا مطابقة تقريبية **للعرض والتنبيه فقط** (قراءة فقط، لا تحذف ولا تمنع):
// رقم الفاتورة أولاً، ثم الصيدلية + المنطقة + التاريخ + الأصناف بكمياتها + الشركة.
//
// ويُقارَن أيضاً بملفات ميركاتو: المندوب قد يرفع صورة فاتورة طلبية جُهّزت عبر
// ميركاتو أصلاً فتُحتسب مرتين. والعكس (الكوديشن محفوظ قبل رفع إكسل ميركاتو)
// يكشفه flagConditionRowsInMercato في عرض ملف الكوديشن.
//
// النتيجة لكل فاتورة واردة (مجموعة صفوف) ولكل صف: duplicate | partial | possible.
// الصف المطابق يُعلَّم وحده — فطلبية نصية بصنفين حُفظت ثم وصلت صورتها بخمسة
// أصناف ⇒ صنفان «مكرر» وثلاثة جديدة.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeArabic, normalizeAreaName, normalizeItemKey, loadResolutionContext, resolveItemNameSync } from './itemResolver.js';
import { similarity, areSimilar } from './fuzzyMatch.js';
import { UNDATED_CUTOFF } from './salesMonths.js';
import { CONDITION_VARIANT } from './saleFingerprint.js';
import { cleanPharmacyName, parseExcelDate } from '../modules/sales/sales.service.js';

const DAY = 86400000;
const SOURCE_LABEL = {
  'telegram-order': 'بوت تلكرام', 'viber-order': 'بوت فايبر', 'whatsapp-order': 'بوت واتساب',
  'warehouse-gap-template': 'إكسل اللكوديشن', 'manual-invoice': 'فاتورة يدوية',
};

/** رقم فاتورة حقيقي مطبَّع، أو '' للرقم التركيبي/الفارغ. */
function realInvoice(v) {
  const s = String(v ?? '').trim();
  if (!s || /^BOT-/i.test(s)) return '';
  return s.replace(/[\s#:/\\-]+/g, '').replace(/^0+(?=\d)/, '').toLowerCase();
}

const pharmKey = (v) => normalizeArabic(cleanPharmacyName(String(v ?? ''))).toLowerCase().replace(/\s+/g, '');
const areaKey  = (v) => {
  const s = String(v ?? '').trim();
  return !s || s === 'غير محدد' ? '' : normalizeAreaName(s).replace(/\s+/g, '');
};
// «المنارة - بغداد» (ميركاتو) = «مذخر المنارة» (البوت): تُسقط لاحقة المحافظة وكلمة «مذخر» و«ال».
const whKey    = (v) => normalizeArabic(String(v ?? '').split(/\s+-\s+/)[0])
  .toLowerCase().replace(/مذاخر|مذخر/g, ' ').split(/\s+/).map(t => t.replace(/^ال(?=..)/, '')).join('');
const compKey  = (v) => normalizeArabic(String(v ?? '')).toLowerCase().replace(/\s+/g, '');

/** true | false | null (لا يُعرف — أحد الطرفين فارغ). */
function namesMatch(a, b, minSim = 0.8) {
  if (!a || !b) return null;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 4 && l.includes(s)) return true;
  return similarity(a, b) >= minSim;
}

const dayOf = (d) => {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  if (isNaN(t) || t < UNDATED_CUTOFF) return null;
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
};

/** 'same' (±1 يوم) | 'near' (≤7) | 'far' | null (تاريخ مفقود في أحد الطرفين). */
function dateRelation(a, b) {
  if (a == null || b == null) return null;
  const diff = Math.abs(a - b) / DAY;
  return diff <= 1 ? 'same' : diff <= 7 ? 'near' : 'far';
}

const fmtDay = (ms) => (ms == null ? '' : new Date(ms).toISOString().slice(0, 10));
const parseRaw = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

/** هل صنفان واردان/محفوظان هما المادة نفسها؟ معرّف الكتالوج، ثم الاسم القانوني، ثم التشابه بحارس الجرعة. */
function itemsMatch(inc, ex) {
  if (inc.itemId && ex.itemId && inc.itemId === ex.itemId) return true;
  for (const k of inc.keys) if (ex.keys.has(k)) return true;
  for (const a of inc.keys) for (const b of ex.keys) if (areSimilar(a, b)) return true;
  return false;
}

/**
 * يقابل أصناف فاتورة واردة بأصناف طلبية محفوظة (كل صنف محفوظ يُستعمل مرة).
 * نفس الكمية أولاً كي لا «يسرق» صنفٌ بكمية مختلفة مطابقةَ الصنف الصحيح.
 */
function matchItems(incItems, exItems) {
  const used = new Set();
  const pairs = new Map(); // incoming index → { ex, sameQty }
  for (const pass of ['qty', 'any']) {
    incItems.forEach((inc, i) => {
      if (pairs.has(i)) return;
      const j = exItems.findIndex((ex, jj) => !used.has(jj)
        && (pass === 'any' || Math.abs(ex.qty - inc.qty) < 0.001)
        && itemsMatch(inc, ex));
      if (j >= 0) { used.add(j); pairs.set(i, { ex: exItems[j], sameQty: Math.abs(exItems[j].qty - incItems[i].qty) < 0.001 }); }
    });
  }
  return pairs;
}

/**
 * يقارن فاتورة واردة بطلبية محفوظة. يُرجع null إن لم يكن بينهما ما يُذكر.
 */
function compareOrder(inc, ex) {
  const invSame = Boolean(inc.invoice && ex.invoice && inc.invoice === ex.invoice);
  // رقم طلبية ميركاتو ليس رقم فاتورة المذخر المصوَّرة — اختلافهما لا يعني طلبيتين.
  const invBoth = Boolean(inc.invoice && ex.invoice && !ex.mercato);
  const pharm   = namesMatch(inc.pharmacy, ex.pharmacy);
  if (!invSame && pharm !== true) return null;  // بلا رقم مطابق: الصيدلية شرط
  // مذخر مختلف = طلبية أخرى (الصيدلية تطلب الأصناف نفسها من مذخرين) — حتى مع رقم مطابق،
  // فأرقام الفواتير تتكرّر بين المذاخر.
  const wh      = namesMatch(inc.warehouse, ex.warehouseKey, 0.85);
  if (wh === false) return null;
  const area    = namesMatch(inc.area, ex.area, 0.85);
  // الطرف بلا تاريخ (طلبية نصية) يُقاس بلحظة وصوله/حفظه بدلاً منه — كي لا
  // تُطابَق طلبية من شهر مضى لمجرد تشابه الصيدلية والأصناف.
  const date    = dateRelation(inc.day ?? inc.fallbackDay, ex.day ?? ex.savedDay);
  const exactDate = inc.day != null && ex.day != null;

  const pairs = matchItems(inc.items, ex.items);
  const matched = pairs.size;
  const sameQty = [...pairs.values()].filter(p => p.sameQty).length;
  if (!invSame && matched === 0) return null;

  const companyAgree = [...pairs.entries()].some(([i, p]) =>
    inc.items[i].company && p.ex.company && namesMatch(inc.items[i].company, p.ex.company, 0.85));

  let level = null;
  if (invSame) {
    // رقم الفاتورة يتكرّر بين مذخرين — يكفيه دليل واحد مؤيِّد.
    if (date !== 'far' && (pharm !== false || matched > 0)) level = 'duplicate';
    else level = 'possible';
  } else {
    if (area === false) return null;
    if (date === 'far') return null;
    // رقمان حقيقيان مختلفان من نفس الصيدلية = فاتورتان مختلفتان عادةً؛ لا تُعدّ
    // مكررة إلا إن تطابقت كل الأصناف بكمياتها في اليوم نفسه.
    if (invBoth) {
      if (exactDate && date === 'same' && sameQty === inc.items.length && sameQty === ex.items.length) level = 'possible';
      else return null;
    } else {
      const need = Math.max(1, Math.ceil(0.6 * Math.min(inc.items.length, ex.items.length)));
      level = sameQty >= need ? 'duplicate' : 'possible';
    }
  }

  // مكررة لكن الواردة تحمل أصنافاً زائدة ⇒ جزئية (الزائد جديد).
  if (level === 'duplicate' && matched < inc.items.length) level = 'partial';

  const reasons = [];
  if (invSame) reasons.push('نفس رقم الفاتورة');
  if (pharm) reasons.push('نفس الصيدلية');
  if (area) reasons.push('نفس المنطقة');
  if (wh) reasons.push('نفس المذخر');
  if (date === 'same') reasons.push(exactDate ? 'نفس التاريخ' : 'بنفس اليوم');
  else if (date === 'near') reasons.push('تاريخ قريب');
  if (matched) reasons.push(`${sameQty === matched ? matched : `${matched} (${sameQty} بنفس الكمية)`} من ${inc.items.length} أصناف مطابقة`);
  if (companyAgree) reasons.push('نفس الشركة');

  const score = (invSame ? 100 : 0) + sameQty * 10 + matched * 3 + (pharm ? 5 : 0)
    + (date === 'same' ? 3 : date === 'near' ? 1 : 0) + (area ? 2 : 0);
  return { level, reasons, pairs, score };
}

/** يبني «فاتورة» للمقارنة من صفوف واردة (طلب الفحص). */
function buildIncomingOrder(groupKey, rows, ctx, fallbackDay) {
  const first = rows.find(r => r.invoiceNumber) || rows[0];
  const day = dayOf(rows.map(r => (r.date ? parseExcelDate(r.date) : null)).find(Boolean) || null);
  return {
    group:    groupKey,
    invoice:  realInvoice(first.invoiceNumber),
    rawInvoice: String(first.invoiceNumber ?? '').trim(),
    pharmacy: pharmKey(rows.find(r => r.pharmacy)?.pharmacy),
    area:     areaKey(rows.find(r => r.area)?.area),
    warehouse: whKey(rows.find(r => r.warehouse)?.warehouse),
    warehouseKey: whKey(rows.find(r => r.warehouse)?.warehouse),
    day,
    fallbackDay,
    items: rows.map(r => {
      const name = String(r.item ?? '').trim();
      const res = ctx ? resolveItemNameSync(name, ctx) : null;
      const canon = res?.canonicalItem && ['alias', 'exact', 'high'].includes(res.confidence) ? res.canonicalItem : null;
      return {
        index:   r._index,
        itemId:  r.itemId ?? canon?.id ?? null,
        keys:    new Set([normalizeItemKey(name), canon ? normalizeItemKey(canon.name) : null].filter(Boolean)),
        qty:     Math.abs(Number(r.quantity) || 0),
        company: compKey(r.company),
      };
    }),
  };
}

const isConditionGroup = (mergeGroup) => String(mergeGroup ?? '').endsWith(`|${CONDITION_VARIANT}`);
/** ملف ميركاتو «حقيقي» (إكسل ميركاتو) لا ملف الكوديشن الذي يشاركه sourceSystem. */
const isMercatoFile = (f) => f.sourceSystem === 'mercato' && !isConditionGroup(f.mergeGroup);

/**
 * الملفات التي يُقارَن بها: ملفات الكوديشن وملفات ميركاتو للحساب (كل العملات)
 * + ملف الوجهة المختار إن كان ملفاً قائماً.
 */
async function candidateFiles(userId, target) {
  const or = [{ userId, sourceSystem: 'mercato' }, { userId, mergeGroup: { endsWith: `|${CONDITION_VARIANT}` } }];
  if (target?.fileId) or.push({ id: Number(target.fileId), userId });
  return prisma.uploadedFile.findMany({ where: { OR: or }, select: { id: true, originalName: true, sourceSystem: true, mergeGroup: true } });
}

/**
 * يجمع صفوف الملفات المحفوظة طلبياتٍ للمقارنة.
 * هوية الطلبية: الرقم الحقيقي، وإلا (الرفعة + الصيدلية + اليوم) — صفوف الطلبية
 * الواحدة تُحفظ في رفعة واحدة دائماً.
 */
async function loadSavedOrders(files, dateOr, take = 30000) {
  const sales = await prisma.sale.findMany({
    where: {
      uploadedFileId: { in: files.map(f => f.id) }, isHidden: false, recordType: 'sale',
      OR: dateOr,
    },
    select: {
      id: true, quantity: true, saleDate: true, createdAt: true, rawData: true, uploadedFileId: true,
      mergeBatchId: true, itemId: true,
      item: { select: { name: true } }, area: { select: { name: true } }, customer: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
    take,
  });

  const fileById = new Map(files.map(f => [f.id, f]));
  const orders = new Map();
  for (const s of sales) {
    const raw = parseRaw(s.rawData);
    const invRaw = String(raw.invoiceNumber ?? raw['رقم طلبية المذخر'] ?? raw['رقم الفاتورة'] ?? '').trim();
    const pharmacyName = String(raw.pharmacy || s.customer?.name || raw['اسم الشركة'] || '').trim();
    const inv = realInvoice(invRaw);
    const pk = pharmKey(pharmacyName);
    const day = dayOf(s.saleDate);
    const key = inv ? `${s.uploadedFileId}|i:${inv}` : `${s.uploadedFileId}|b:${s.mergeBatchId ?? ''}|${invRaw}|${pk}|${day ?? ''}`;
    let o = orders.get(key);
    if (!o) {
      const file = fileById.get(s.uploadedFileId);
      o = {
        fileId: s.uploadedFileId, fileName: file?.originalName || '',
        mercato: file ? isMercatoFile(file) : false,
        invoice: inv, rawInvoice: /^BOT-/i.test(invRaw) ? '' : invRaw,
        pharmacy: pk, pharmacyName,
        area: areaKey(s.area?.name), areaName: s.area?.name && s.area.name !== 'غير محدد' ? s.area.name : '',
        warehouse: String(raw.warehouse ?? raw['اسم المذخر'] ?? '').trim(),
        warehouseKey: whKey(raw.warehouse ?? raw['اسم المذخر']),
        rep: String(raw['اسم المندوب'] ?? raw.scientificRep ?? '').trim(),
        source: SOURCE_LABEL[raw.source] || '',
        day, savedDay: dayOf(s.createdAt), savedAt: s.createdAt,
        items: [],
      };
      orders.set(key, o);
    }
    const itemName = s.item?.name || '';
    o.items.push({
      saleId: s.id, itemId: s.itemId, name: itemName,
      keys: new Set([normalizeItemKey(itemName), raw['اسم المادة بالمكتب'] ? normalizeItemKey(raw['اسم المادة بالمكتب']) : null].filter(Boolean)),
      qty: Number(s.quantity) || 0,
      company: compKey(raw.company || raw['الصنف']),
    });
  }
  return [...orders.values()];
}

/** وصف الطلبية المحفوظة المطابِقة كما تُعرض للمستخدم. */
const describeMatch = (ex) => ({
  inBatch: false,
  fileId: ex.fileId, fileName: ex.fileName, mercato: ex.mercato,
  invoiceNumber: ex.rawInvoice, date: fmtDay(ex.day), savedAt: ex.savedAt,
  pharmacy: ex.pharmacyName, area: ex.areaName, warehouse: ex.warehouse, rep: ex.rep, source: ex.source,
  itemCount: ex.items.length,
});

/**
 * @param {object} p
 * @param {Array<{group?:string, invoiceNumber?:string, date?:string, pharmacy?:string, area?:string,
 *                 item:string, company?:string, quantity:number}>} p.rows
 * @param {object} [p.target]  نفس target في /api/sales/manual
 * @param {number} p.userId
 * @param {Date}   [p.receivedAt] لحظة وصول الطلبية (بديل التاريخ حين لا يُذكر)
 * @returns {Promise<{groups: object[], rows: object[], checkedFiles: number}>}
 */
export async function checkManualDuplicates({ rows, target = {}, userId, receivedAt = null }) {
  const out = { groups: [], rows: [], checkedFiles: 0 };
  if (!userId || !Array.isArray(rows) || rows.length === 0) return out;

  const incomingRows = rows
    .map((r, i) => ({ ...r, _index: i }))
    .filter(r => String(r.item ?? '').trim() && Number(r.quantity) > 0);
  if (!incomingRows.length) return out;

  // ── سياق توحيد الأصناف (نفس محرّك الحفظ) ──
  const sciCompanyIds = (await prisma.userCompanyAssignment.findMany({
    where: { userId }, select: { companyId: true },
  })).map(c => c.companyId);
  const ctx = await loadResolutionContext({ scientificCompanyIds: sciCompanyIds, userId }).catch(() => null);

  const fallbackDay = dayOf(receivedAt || new Date());
  const byGroup = new Map();
  for (const r of incomingRows) {
    const g = String(r.group ?? (realInvoice(r.invoiceNumber) || pharmKey(r.pharmacy) || 'g'));
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }
  const incoming = [...byGroup.entries()].map(([g, rs]) => buildIncomingOrder(g, rs, ctx, fallbackDay));

  // ── الطلبيات المحفوظة: نافذة زمنية حول تواريخ الواردة (لا كل الملف) ──
  const files = await candidateFiles(userId, target);
  out.checkedFiles = files.length;
  const existing = [];
  if (files.length) {
    const days = incoming.map(o => o.day).filter(d => d != null);
    const anyUndated = incoming.some(o => o.day == null);
    const dateOr = [];
    if (days.length) {
      dateOr.push({ saleDate: { gte: new Date(Math.min(...days) - 10 * DAY), lte: new Date(Math.max(...days) + 11 * DAY) } });
    }
    // واردة بلا تاريخ تُقارَن بما حُفظ أو بِيع حول لحظة وصولها.
    if (anyUndated || !days.length) {
      const from = new Date((fallbackDay ?? Date.now()) - 10 * DAY);
      dateOr.push({ saleDate: { gte: from } }, { createdAt: { gte: from } });
    }
    // المحفوظ بلا تاريخ (علامة 1970) يُقارَن بلحظة حفظه.
    dateOr.push({ saleDate: { lt: UNDATED_CUTOFF }, createdAt: { gte: new Date(Date.now() - 60 * DAY) } });

    existing.push(...await loadSavedOrders(files, dateOr));
  }

  // ── المقارنة: بالمحفوظ، ثم بالفواتير السابقة في نفس الطلب (صورتان لنفس الفاتورة) ──
  const rowFlags = new Map(); // row index → flag
  incoming.forEach((inc, gi) => {
    let best = null;
    for (const ex of existing) {
      const c = compareOrder(inc, ex);
      if (c && (!best || c.score > best.c.score)) best = { c, ex, inBatch: false };
    }
    for (let pj = 0; pj < gi; pj++) {
      const prev = incoming[pj];
      const exLike = { ...prev, savedDay: prev.fallbackDay, items: prev.items.map(it => ({ ...it, name: '' })) };
      const c = compareOrder(inc, exLike);
      if (c && c.level !== 'possible' && (!best || c.score > best.c.score)) best = { c, ex: exLike, inBatch: true };
    }
    if (!best) return;

    const { c, ex, inBatch } = best;
    out.groups.push({
      group: inc.group,
      level: c.level,
      reasons: c.reasons,
      matchedCount: c.pairs.size,
      itemCount: inc.items.length,
      match: inBatch ? { inBatch: true, group: ex.group } : describeMatch(ex),
    });
    const rowLevel = c.level === 'possible' ? 'possible' : 'duplicate';
    for (const [i, p] of c.pairs) {
      const idx = inc.items[i].index;
      if (!rowFlags.has(idx)) {
        rowFlags.set(idx, { index: idx, level: rowLevel, group: inc.group, sameQty: p.sameQty, existingQty: p.ex.qty, existingItem: p.ex.name || null, mercato: !inBatch && ex.mercato });
      }
    }
  });
  out.rows = [...rowFlags.values()];
  return out;
}

/** للاختبار فقط (scripts/test-manual-duplicates.mjs). */
export const __test = { compareOrder, buildIncomingOrder, realInvoice, pharmKey, areaKey, dayOf, whKey };

/** سطر تنبيه قصير لردّ البوت، أو '' إن لم يوجد تكرار يُذكر. */
export function duplicateWarningText(result) {
  const g = (result?.groups || []).filter(x => !x.match.inBatch && x.level !== 'possible');
  if (!g.length) return '';
  const lines = g.slice(0, 3).map(x => {
    const m = x.match;
    const what = [m.invoiceNumber && `${m.mercato ? 'طلبية' : 'فاتورة'} ${m.invoiceNumber}`, m.pharmacy, m.date, m.mercato && m.warehouse].filter(Boolean).join(' · ');
    // طلبية جُهّزت عبر ميركاتو ثم رُفعت صورتها — محسوبة أصلاً في مبيع ميركاتو.
    const where = m.mercato ? 'محسوبة أصلاً في مبيع ميركاتو' : 'محفوظة سابقاً';
    return x.level === 'partial'
      ? `• ${x.matchedCount} من ${x.itemCount} أصناف ${where} (${what})`
      : `• ${where} بالكامل (${what})`;
  });
  return `\n\n⚠️ تنبيه تكرار — راجعها قبل الحفظ:\n${lines.join('\n')}`;
}

/**
 * العكس: صفوف ملف الكوديشن (بوت/فواتير) المحسوبة أيضاً في إكسل ميركاتو المرفوع
 * بعدها — المندوب صوّر فاتورة طلبية جهّزها ميركاتو. يُعلِّم كل صف مطابق بـ
 * `mercatoMatch` (للتنبيه في العرض؛ الحذف قرار المالك من الشيت نفسه).
 * صفوف الترانزيت والصفوف بلا تاريخ لا تُفحص.
 * @param {Array<{rows: object[]}>} sheets  ناتج loadConditionSheets (يُعدَّل في مكانه)
 * @param {number} ownerId  مالك ملف الكوديشن — ملفات ميركاتو الشقيقة له
 * @returns {Promise<number>} عدد الصفوف المعلَّمة
 */
export async function flagConditionRowsInMercato(sheets, ownerId) {
  if (!ownerId) return 0;
  const byId = new Map();
  for (const s of sheets) for (const r of s.rows) {
    if (!r.transit && r.date && r.item && Number(r.quantity) > 0) byId.set(r.id, r);
  }
  if (!byId.size) return 0;

  const files = (await prisma.uploadedFile.findMany({
    where: { userId: ownerId, sourceSystem: 'mercato' },
    select: { id: true, originalName: true, sourceSystem: true, mergeGroup: true },
  })).filter(isMercatoFile);
  if (!files.length) return 0;

  const groups = new Map();
  for (const r of byId.values()) {
    const inv = realInvoice(r.invoice);
    const k = inv ? `i:${inv}` : `${r.date}|${pharmKey(r.pharmacy)}|${r.rep ?? ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...r, invoiceNumber: r.invoice, _index: r.id });
  }
  const incoming = [...groups.entries()].map(([k, rs]) => buildIncomingOrder(k, rs, null, null)).filter(o => o.day != null);
  if (!incoming.length) return 0;

  const days = incoming.map(o => o.day);
  const mercatoOrders = await loadSavedOrders(files, [
    { saleDate: { gte: new Date(Math.min(...days) - 8 * DAY), lte: new Date(Math.max(...days) + 9 * DAY) } },
  ], 80000);
  // فهرس باليوم والرقم كي لا تُقارَن كل طلبية بكل ميركاتو الشهر.
  const byDay = new Map();
  const byInv = new Map();
  for (const o of mercatoOrders) {
    if (o.day != null) { if (!byDay.has(o.day)) byDay.set(o.day, []); byDay.get(o.day).push(o); }
    if (o.invoice) { if (!byInv.has(o.invoice)) byInv.set(o.invoice, []); byInv.get(o.invoice).push(o); }
  }

  let flagged = 0;
  for (const inc of incoming) {
    const cands = new Set(inc.invoice ? byInv.get(inc.invoice) || [] : []);
    for (let d = -7; d <= 7; d++) for (const o of byDay.get(inc.day + d * DAY) || []) cands.add(o);
    let best = null;
    for (const ex of cands) {
      const c = compareOrder(inc, ex);
      if (c && (!best || c.score > best.c.score)) best = { c, ex };
    }
    if (!best) continue;
    const { c, ex } = best;
    const match = { ...describeMatch(ex), level: c.level === 'possible' ? 'possible' : 'duplicate', reasons: c.reasons };
    for (const [i, p] of c.pairs) {
      const row = byId.get(inc.items[i].index);
      if (!row || row.mercatoMatch) continue;
      row.mercatoMatch = { ...match, sameQty: p.sameQty, mercatoQty: p.ex.qty };
      flagged++;
    }
  }
  return flagged;
}
