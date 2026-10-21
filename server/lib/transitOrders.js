// ════════════════════════════════════════════════════════════════════════════
// transitOrders.js — طلبيات «الترانزيت» في ملف مبيعات المكتب (طلب 2026-10-21).
// ────────────────────────────────────────────────────────────────────────────
// المندوب يطلب لصيدلية معيّنة عبر مذخر لا يملك ستوكاً، فيُرسل المكتب الطلبية
// للمذخر ليحوّلها هو للصيدلية كما هي. في ملف المكتب يظهر الصف كمبيع لمذخر
// (صنف الزبون «مذخر») والصيدلية الحقيقية مكتوبة في الملاحظات:
//   «ترانزيت إلى ص/ احمد رعد صالح» · «ترانزيت الى صيدلية العامرية المركزية / الفلوجة»
//
// القاعدة:
//   • يبقى الصف ضمن مبيع المكتب الكلي ومبيعه للمذاخر كما هو — لا نسخ ولا نقل.
//   • ويُحتسب أيضاً للمندوب العلمي/التيم ليدر ككوديشن: منطقة الصيدلية (من
//     الملاحظة، وإلا من بحث اسمها في السستم) ∩ مناطق المندوب، والايتم ∩ ايتماته.
//     لا مندوب علمي في ملف المكتب، فالنسب بالشركة/الايتم/المنطقة وحدها.
//   • «معلومات الزبون» علمي أو تجاري فقط — «فارماسي» مستبعد.
//   • البونص المرسل ترانزيت («فري ترانزيت»، أو قيمة صفر) يُهمل.
//
// كل هذا وقت القراءة من rawData المحفوظ — فيسري رجعياً على الملفات المرفوعة سابقاً.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { isWarehouseSaleRow } from './orderKey.js';
import { normalizeArabic, normalizeAreaName } from './itemResolver.js';
import { loadCustomerMatchMaster, resolveOne } from './invoiceCustomerMatch.js';
import { pharmacyKey } from './pharmacyKey.js';

const TRANSIT_RE = /ترانز[يى]?ت|transit/i;
const NOTE_KEY_RE = /ملاحظ|ملاحض|note|remark|comment/i;
const INFO_KEY_RE = /(معلومات|بيانات|تفاصيل|وصف)\s*(ال)?(زبون|عميل)|customer\s*info/i;
// بونص: «فري ترانزيت…»، «ترانزيت بونص…».
const FREE_RE = /(^|[\s(\-/])(فري|free|مجاني|مجانا|بونص|bonus|هديه|هدية)(?=$|[\s)\-/])/i;

/** شرط Prisma يضيّق الاستعلام لصفوف فيها كلمة ترانزيت قبل الفحص الكامل. */
export const TRANSIT_DB_FILTER = {
  OR: [
    { rawData: { contains: 'ترانز' } },
    { rawData: { contains: 'transit', mode: 'insensitive' } },
  ],
};

/**
 * يستخرج الصيدلية والمنطقة من نص الملاحظة. نقيّ.
 * «ترانزيت الى صيدلية العامرية المركزية / الفلوجة» → { pharmacy:'العامرية المركزية', areaHint:'الفلوجة' }
 * @returns {{pharmacy:string, areaHint:string}|null} null إن لم يكن النص ترانزيت
 */
export function parseTransitNote(note) {
  const s = String(note ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(TRANSIT_RE);
  if (!m) return null;
  let rest = s.slice(m.index + m[0].length)
    .replace(/^[\s:：\-–/.]+/, '')
    .replace(/^(?:إلى|الى|ألى|إلي|الي|ل(?=\s|ص))\s*/, '')
    // تعليمات شحن ملحقة: «… ترسل مع الطلبية»
    .replace(/\s*(?:ترسل|يرسل|تُرسل|ترسال)(?:\s.*)?$/, '')
    .replace(/^(?:(?:ال)?صيدلي[ةه]\s*[/.:\-]?|ص\s*[/.:\-]|ص\s+)\s*/, '')
    .trim();
  // «الشفاء (الكرادة)» — ما بين القوسين منطقة.
  let paren = '';
  rest = rest.replace(/[(（]([^)）]*)[)）]/g, (_, inner) => { paren = paren || inner.trim(); return ' '; }).trim();
  const parts = rest.split(/\s*[/\\|،,\-–]\s*/).map(p => p.trim()).filter(Boolean);
  const pharmacy = parts[0] || '';
  const areaHint = [paren, ...parts.slice(1)].filter(Boolean).join(' - ');
  return { pharmacy, areaHint };
}

/**
 * هل صف Sale طلبية ترانزيت تُحتسب للمندوبين؟ نقيّ.
 * @param {string} rawDataJson Sale.rawData
 * @param {number|null} totalValue Sale.totalValue — صفر = بونص يُهمل
 * @returns {{note:string, pharmacy:string, areaHint:string, customerInfo:string}|null}
 */
export function parseTransitRow(rawDataJson, totalValue = null) {
  if (!rawDataJson || !TRANSIT_RE.test(rawDataJson)) return null;
  let raw;
  try { raw = JSON.parse(rawDataJson); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const keys = Object.keys(raw);
  const noteKeys = keys.filter(k => NOTE_KEY_RE.test(k));
  const note = (noteKeys.length ? noteKeys : keys)
    .map(k => raw[k]).find(v => typeof v === 'string' && TRANSIT_RE.test(v));
  if (!note) return null;

  // موجّهة إلى مذخر (صنف الزبون).
  if (!isWarehouseSaleRow(rawDataJson)) return null;

  // معلومات الزبون: علمي أو تجاري، لا فارماسي.
  const infoKey = keys.find(k => INFO_KEY_RE.test(k));
  const infoRaw = infoKey ? String(raw[infoKey] ?? '').trim() : '';
  const info = normalizeArabic(infoRaw).toLowerCase();
  if (!info || /فارم|pharm/.test(info) || !/علمي|تجاري/.test(info)) return null;

  if (FREE_RE.test(note)) return null;
  if (totalValue != null && !(Number(totalValue) > 0)) return null;

  const parsed = parseTransitNote(note);
  if (!parsed) return null;
  return { note: note.trim(), ...parsed, customerInfo: infoRaw };
}

// ── منطقة الصيدلية ────────────────────────────────────────────────────────────

const PLACE_TTL_MS = 10 * 60_000;
let placeMemo = new Map();
let placeMemoAt = 0;

/**
 * مكان الصيدلية لكل ملاحظة: المنطقة المكتوبة أولاً، ثم صيدليات السيرفي (نفس
 * مطابِق طلبيات البوت)، ثم سجلّ المبيعات (أكثر منطقة بيع لنفس اسم الصيدلية في
 * الملفات المعطاة، إن غلبت بوضوح).
 * @returns {Promise<Map<string, {pharmacy:string, areaId:number|null, areaName:string, areaNorm:string, how:string}>>}
 *   المفتاح = placeKey(t)
 */
async function resolvePlaces(transits, lookupFileIds) {
  if (Date.now() - placeMemoAt > PLACE_TTL_MS) { placeMemo = new Map(); placeMemoAt = Date.now(); }
  const out = new Map();
  const pending = [];
  for (const t of transits) {
    const k = placeKey(t);
    if (out.has(k)) continue;
    if (placeMemo.has(k)) out.set(k, placeMemo.get(k));
    else { out.set(k, null); pending.push(t); }
  }
  if (!pending.length) return out;

  const m = await loadCustomerMatchMaster();
  const areaIdOf = (name) => m.areaByKey.get(normalizeAreaName(name))?.id ?? null;
  const unresolved = [];
  for (const t of pending) {
    const r = resolveOne(t.pharmacy, t.areaHint, m);
    const place = { pharmacy: r.pharmacy || t.pharmacy, areaId: null, areaName: '', areaNorm: '', how: '' };
    if (r.area) Object.assign(place, { areaId: areaIdOf(r.area), areaName: r.area, areaNorm: normalizeArabic(r.area), how: r.matched ? 'survey' : 'note' });
    out.set(placeKey(t), place);
    if (!place.areaName) unresolved.push({ t, place });
  }

  if (unresolved.length && lookupFileIds?.length) {
    const byKey = await salesAreaByPharmacy(unresolved.map(u => pharmacyKey(u.t.pharmacy)).filter(Boolean), lookupFileIds);
    for (const { place, t } of unresolved) {
      const hit = byKey.get(pharmacyKey(t.pharmacy));
      if (hit) Object.assign(place, { areaId: hit.areaId, areaName: hit.areaName, areaNorm: normalizeArabic(hit.areaName), how: 'sales' });
    }
  }
  for (const t of pending) placeMemo.set(placeKey(t), out.get(placeKey(t)));
  return out;
}

const placeKey = (t) => `${t.pharmacy}|${t.areaHint}`;

/** اسم الصيدلية ← المنطقة الغالبة في المبيعات (≥60% من صفوفه) ضمن الملفات. */
async function salesAreaByPharmacy(keys, fileIds) {
  const wanted = new Set(keys);
  const out = new Map();
  if (!wanted.size) return out;
  const groups = await prisma.sale.groupBy({
    by: ['customerId', 'areaId'],
    where: { uploadedFileId: { in: fileIds }, isHidden: false, customerId: { not: null } },
    _count: { _all: true },
  });
  const customerIds = [...new Set(groups.map(g => g.customerId))];
  const customers = customerIds.length
    ? await prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } })
    : [];
  const keyOfCustomer = new Map();
  for (const c of customers) {
    const k = pharmacyKey(c.name);
    if (wanted.has(k)) keyOfCustomer.set(c.id, k);
  }
  const tally = new Map(); // key → Map(areaId → count)
  for (const g of groups) {
    const k = keyOfCustomer.get(g.customerId);
    if (!k) continue;
    if (!tally.has(k)) tally.set(k, new Map());
    const t = tally.get(k);
    t.set(g.areaId, (t.get(g.areaId) || 0) + g._count._all);
  }
  const areaIds = [...new Set([...tally.values()].flatMap(t => [...t.keys()]))];
  const areas = areaIds.length
    ? await prisma.area.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true } })
    : [];
  const areaName = new Map(areas.map(a => [a.id, a.name]));
  for (const [k, t] of tally) {
    const usable = [...t].filter(([id]) => areaName.has(id) && areaName.get(id) !== 'غير محدد');
    const total = usable.reduce((a, [, n]) => a + n, 0);
    const [bestId, bestN] = usable.sort((a, b) => b[1] - a[1])[0] || [];
    if (bestId && bestN / total >= 0.6) out.set(k, { areaId: bestId, areaName: areaName.get(bestId) });
  }
  return out;
}

/**
 * صفوف الترانزيت في ملفات المكتب المعطاة، كلٌّ مع مكان الصيدلية:
 * row.transit = { note, pharmacy, areaId, areaName, areaNorm, how, customerInfo }.
 * areaNorm فارغ = لم تُعرف منطقة الصيدلية (لا تُنسب لمندوب).
 *
 * @param {{officeFileIds:number[], lookupFileIds?:number[], where?:object, select:object}} opts
 *   where يُضاف بـ AND (تاريخ/ايتمات/حجب)، lookupFileIds لبحث منطقة الصيدلية في المبيعات.
 */
export async function loadTransitSales({ officeFileIds, lookupFileIds = officeFileIds, where = null, select }) {
  if (!officeFileIds?.length) return [];
  const rows = await prisma.sale.findMany({
    where: {
      AND: [
        { uploadedFileId: { in: officeFileIds }, isHidden: false, recordType: 'sale' },
        TRANSIT_DB_FILTER,
        ...(where ? [where] : []),
      ],
    },
    select: { ...select, id: true, rawData: true, totalValue: true },
  });
  const hits = [];
  for (const r of rows) {
    const t = parseTransitRow(r.rawData, r.totalValue);
    if (t) hits.push({ r, t });
  }
  if (!hits.length) return [];
  const places = await resolvePlaces(hits.map(h => h.t), lookupFileIds);
  return hits.map(({ r, t }) => {
    const p = places.get(placeKey(t)) || { pharmacy: t.pharmacy, areaId: null, areaName: '', areaNorm: '', how: '' };
    return { ...r, transit: { note: t.note, customerInfo: t.customerInfo, ...p } };
  });
}

/** يفصل ملفات المكتب عن ميركاتو (في JS — NULL هو ملف المكتب). */
export async function officeFileIdsOf(fileIds) {
  if (!fileIds?.length) return [];
  const files = await prisma.uploadedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, sourceSystem: true } });
  return files.filter(f => f.sourceSystem !== 'mercato').map(f => f.id);
}
