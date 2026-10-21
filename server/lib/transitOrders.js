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
import { loadCustomerMatchMaster, matchArea, matchPharmacy } from './invoiceCustomerMatch.js';
import { pharmacyKey } from './pharmacyKey.js';
import { buildProvinceLookup, matchProvinceName, extractRawColumnValue, PROVINCE_COLUMN_ALIASES } from './provinces.js';

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
  // محافظة الصف نفسه (محافظة المذخر — والترانزيت يمرّ غالباً بمذخر مدينة الصيدلية).
  const rowProvince = extractRawColumnValue(raw, PROVINCE_COLUMN_ALIASES) || '';
  return { note: note.trim(), ...parsed, rowProvince, customerInfo: infoRaw };
}

// ── منطقة الصيدلية ────────────────────────────────────────────────────────────

const PLACE_TTL_MS = 10 * 60_000;
let placeMemo = new Map();
let placeMemoAt = 0;

/**
 * خرائط المحافظات: اسم/بديل مطبَّع ← محافظة، معرّف ← محافظة، اسم منطقة مطبَّع ←
 * محافظاتها، ومعرّف منطقة ← اسمها (لمنطقة المذخر في صف الملف).
 */
async function loadProvinceIndex() {
  const [provinces, areas] = await Promise.all([
    prisma.province.findMany({ select: { id: true, name: true, aliases: true } }),
    prisma.area.findMany({ select: { id: true, name: true, provinceId: true } }),
  ]);
  const byName = buildProvinceLookup(provinces);
  const byId = new Map(provinces.map(p => [p.id, p]));
  const ofArea = new Map(); // normalizeAreaName → Set(provinceId)
  const nameById = new Map();
  for (const a of areas) {
    nameById.set(a.id, a.name);
    if (!a.provinceId) continue;
    const k = normalizeAreaName(a.name);
    if (!ofArea.has(k)) ofArea.set(k, new Set());
    ofArea.get(k).add(a.provinceId);
  }
  return { byName, byId, ofArea, nameById };
}

/** محافظة منطقة المذخر (Sale.areaId للصف) — فقط حين تدلّ على محافظة واحدة. */
function warehouseProvince(t, pIdx) {
  const name = pIdx.nameById?.get(t.warehouseAreaId);
  if (!name) return null;
  const ps = pIdx.ofArea.get(normalizeAreaName(name));
  if (ps?.size === 1) return pIdx.byId?.get([...ps][0]) ?? null;
  return matchProvinceName(name, pIdx.byName); // منطقة باسم المحافظة نفسها («الديوانية»)
}

/**
 * يفصل المحافظة عن تلميح المنطقة/ذيل اسم الصيدلية:
 * «النموذجية / الديوانية» أو «النموذجية الديوانية» → محافظة القادسية.
 * المنطقة التي تحمل اسم المحافظة نفسه (مركزها) تبقى تلميحاً للمنطقة أيضاً.
 */
function splitProvince(t, pIdx) {
  let province = null;
  let pharmacy = t.pharmacy;
  for (const part of String(t.areaHint || '').split(' - ')) {
    const p = matchProvinceName(part, pIdx.byName);
    if (p) { province = p; break; }
  }
  const words = pharmacy.split(/\s+/);
  for (const n of [2, 1]) {
    if (words.length <= n) continue;
    const p = matchProvinceName(words.slice(-n).join(' '), pIdx.byName);
    if (p) {
      province = province || p;
      pharmacy = words.slice(0, -n).join(' ');
      return { province, pharmacy, areaHint: [t.areaHint, words.slice(-n).join(' ')].filter(Boolean).join(' - ') };
    }
  }
  return { province, pharmacy, areaHint: t.areaHint };
}

const isBaghdad = (p) => p?.name === 'بغداد';

/**
 * مكان الصيدلية لكل ملاحظة. الترتيب:
 *   1. المنطقة المكتوبة في الملاحظة.
 *   2. صيدليات السيرفي (نفس مطابِق طلبيات البوت).
 *   3. سجلّ المبيعات: أكثر منطقة بيع لنفس اسم الصيدلية، إن غلبت بوضوح.
 *
 * 2 و3 بحث بالاسم وحده، والأسماء تتكرّر بين المدن («النموذجية» في بغداد وفي
 * الديوانية). فلا يُقبل ناتجهما إلا إن وافق ما تقوله الملاحظة:
 *   • ذكرت محافظة: منطقة من نفس المحافظة فقط. وإلا تُنسب الطلبية للمحافظة
 *     وحدها (لمندوبي تلك المحافظة).
 *   • ذكرت منطقة لم تُعرف: لا يُقبل بحث بالاسم أصلاً (يذهب لـ«بلا مندوب»).
 * @returns {Promise<Map<string, {pharmacy, areaId, areaName, areaNorm, provinceId, provinceName, how}>>}
 *   المفتاح = placeKey(t)
 */
/**
 * منطقة مقبولة مع محافظة الملاحظة: نفس المحافظة. محافظتها مجهولة تُقبل من نصّ
 * الملاحظة فقط (explicit)، لا من بحث بالاسم.
 */
const provinceFit = (pIdx) => (areaName, province, explicit) => {
  if (!province) return true;
  const ps = pIdx.ofArea.get(normalizeAreaName(areaName)) ?? new Set();
  return ps.size ? ps.has(province.id) : explicit;
};

/**
 * الخطوتان 1 و2 (الملاحظة ثم السيرفي) — نقيّة، تُختبر بفهارس مصنوعة.
 * @param m    فهرس buildMasterIndex (invoiceCustomerMatch)
 * @param pIdx { byName: buildProvinceLookup(...), ofArea: Map(normalizeAreaName → Set(provinceId)) }
 * @returns {{place:object, sp:object, needsSales:boolean}}
 */
export function placeFromNote(t, m, pIdx) {
  const fitsProvince = provinceFit(pIdx);
  const sp = splitProvince(t, pIdx);
  // محافظة الطلبية: من الملاحظة، وإلا من منطقة المذخر، وإلا من عمود المحافظة في الصف.
  // تقيّد البحث بالاسم (السيرفي/المبيعات) لا المنطقة المكتوبة في الملاحظة.
  const whProv = sp.province ? null : warehouseProvince(t, pIdx);
  const rowProv = sp.province || whProv ? null : matchProvinceName(t.rowProvince, pIdx.byName);
  sp.searchProvince = sp.province || whProv || rowProv;
  const provinceFrom = sp.province ? 'note' : whProv ? 'warehouse' : rowProv ? 'row' : '';
  // حين لا تُعرف منطقة الصيدلية تُحتسب الطلبية للمحافظة. بغداد مندوبوها بالمناطق،
  // فتُحتسب فيها لمن أُسنِدت له محافظة بغداد كاملة فقط (provinceStrict).
  const place = {
    pharmacy: sp.pharmacy || t.pharmacy, areaId: null, areaName: '', areaNorm: '',
    provinceId: sp.searchProvince?.id ?? null, provinceName: sp.searchProvince?.name ?? '',
    provinceStrict: isBaghdad(sp.searchProvince), provinceFrom, how: '',
  };
  const setArea = (areaName, how) => Object.assign(place, {
    areaId: m.areaByKey.get(normalizeAreaName(areaName))?.id ?? null, areaName, areaNorm: normalizeArabic(areaName), how,
  });

  // 1) المنطقة المكتوبة.
  if (sp.areaHint) {
    const a = matchArea(sp.areaHint, m);
    if (a && fitsProvince(a.name, sp.province, true)) { setArea(a.name, 'note'); return { place, sp, needsSales: false }; }
  }
  // منطقة مكتوبة غير معروفة (ليست محافظة): لا تخمين بالاسم.
  const hintIsOnlyProvince = !!sp.province && String(sp.areaHint || '').split(' - ')
    .every(p => !p.trim() || matchProvinceName(p, pIdx.byName));
  if (sp.areaHint && !hintIsOnlyProvince) { place.how = 'unknown-area'; return { place, sp, needsSales: false }; }

  // 2) السيرفي.
  const pm = matchPharmacy(sp.pharmacy, '', m);
  if (pm.match?.areaName) {
    const a = matchArea(pm.match.areaName, m);
    const areaName = a ? a.name : pm.match.areaName;
    if (fitsProvince(areaName, sp.searchProvince, false)) {
      place.pharmacy = pm.match.name;
      setArea(areaName, 'survey');
      return { place, sp, needsSales: false };
    }
  }
  return { place, sp, needsSales: true };
}

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

  const [m, pIdx] = await Promise.all([loadCustomerMatchMaster(), loadProvinceIndex()]);
  const unresolved = [];
  for (const t of pending) {
    const { place, sp, needsSales } = placeFromNote(t, m, pIdx);
    out.set(placeKey(t), place);
    if (needsSales) unresolved.push({ sp, place });
  }
  const fitsProvince = provinceFit(pIdx);

  // 3) سجلّ المبيعات.
  if (unresolved.length && lookupFileIds?.length) {
    const byKey = await salesAreaByPharmacy(unresolved.map(u => pharmacyKey(u.sp.pharmacy)).filter(Boolean), lookupFileIds);
    for (const { place, sp } of unresolved) {
      const hit = byKey.get(pharmacyKey(sp.pharmacy));
      if (hit && fitsProvince(hit.areaName, sp.searchProvince, false)) {
        Object.assign(place, { areaId: hit.areaId, areaName: hit.areaName, areaNorm: normalizeArabic(hit.areaName), how: 'sales' });
      } else if (place.provinceId) {
        place.how = 'province';
      }
    }
  } else {
    for (const { place } of unresolved) if (place.provinceId) place.how = 'province';
  }
  for (const t of pending) placeMemo.set(placeKey(t), out.get(placeKey(t)));
  return out;
}

const placeKey = (t) => `${t.pharmacy}|${t.areaHint}|${t.rowProvince || ''}|${t.warehouseAreaId ?? ''}`;

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
 * row.transit = { note, pharmacy, areaId, areaName, areaNorm, provinceId, provinceName, how, customerInfo }.
 * areaNorm فارغ مع provinceId = تُعرف المحافظة وحدها (تُنسب لمندوبي المحافظة؛
 * provinceStrict = بغداد: لمن أُسنِدت له المحافظة كاملة فقط).
 * الاثنان فارغان = لم يُعرف المكان (لا تُنسب لمندوب).
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
    select: { ...select, id: true, rawData: true, totalValue: true, areaId: true },
  });
  const hits = [];
  for (const r of rows) {
    const t = parseTransitRow(r.rawData, r.totalValue);
    if (t) hits.push({ r, t: { ...t, warehouseAreaId: r.areaId } });
  }
  if (!hits.length) return [];
  const places = await resolvePlaces(hits.map(h => h.t), lookupFileIds);
  return hits.map(({ r, t }) => {
    const p = places.get(placeKey(t)) || { pharmacy: t.pharmacy, areaId: null, areaName: '', areaNorm: '', provinceId: null, provinceName: '', provinceStrict: false, provinceFrom: '', how: '' };
    return { ...r, transit: { note: t.note, customerInfo: t.customerInfo, ...p } };
  });
}

/** يفصل ملفات المكتب عن ميركاتو (في JS — NULL هو ملف المكتب). */
export async function officeFileIdsOf(fileIds) {
  if (!fileIds?.length) return [];
  const files = await prisma.uploadedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, sourceSystem: true } });
  return files.filter(f => f.sourceSystem !== 'mercato').map(f => f.id);
}
