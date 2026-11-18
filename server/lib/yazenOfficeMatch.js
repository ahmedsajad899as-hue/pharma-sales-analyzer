// ════════════════════════════════════════════════════════════════════════════
// yazenOfficeMatch.js — مطابقة صفوف «اليزن» في ميركاتو بصفوفها في ملف المكتب.
//
// طلب 2026-11-19: زر «بدون الفارمسي» في تقرير العلميين كان يعزل صفوف ملف المكتب المحسوبة
// للمسوقين بـ«معلومات الزبون». منذ صار مكتب المسوّق يُحسب من صفوف اليزن (officeSource=
// 'warehouse') لم يبقَ له صف في ملف المكتب، فصار الزر بلا أثر. هنا يُطابَق كل صف يزن باسم
// مسوّق بصفّه في ملف المكتب (الطلبية نفسها): الايتم + الكمية + الصيدلية + التاريخ، وطلبية
// اليزن تسبق ملف المكتب غالباً بيوم. شركة على 'yazen' (ScientificCompany.pharmacyExclusionSource)
// تعزل صفوف المكتب المطابقة.
//
// المطابقة ثقيلة نسبياً، فتُحسب في الخلفية بعد كل رفع/حذف وتُحفظ (YazenOfficeMatch)، والتقرير
// يقرأ الجاهز. بصمة النطاق (عدد الصفوف + أكبر id + الملفات + أسماء المسوقين) تقرّر إعادة الحساب.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeItemKey } from './itemResolver.js';
import { areSimilar } from './fuzzyMatch.js';
import { matchHelpers } from './manualDuplicateCheck.js';
import { CONDITION_VARIANT } from './saleFingerprint.js';
import { normalizeRepName } from './repNameMatch.js';
import { PHARMACY_KIND, OFFICE_WAREHOUSE_SQL, isOfficeWarehouseRow } from './pharmacyRep.js';

const DAY = 86400000;
// ملف المكتب يُخزَّن بمنتصف ليل بغداد (21:00 UTC اليوم السابق)، وميركاتو بوقت الساعة كما هو.
const OFFICE_TZ_SHIFT = 3 * 3600000;
/** فرق الأيام (يوم المكتب − يوم اليزن) بالأفضلية: اليوم التالي أولاً. */
export const GAP_PREFERENCE = [1, 0, 2, -1, 3];
/**
 * كمية مختلفة (طلبية تأخر تجهيزها أو جُهّزت جزئياً): حتى 3 أيام بعد اليزن — بشرط ألا تكون
 * في تلك الأيام طلبية يزن أخرى للصيدلية نفسها والايتم نفسه (قاعدة المستخدم 2026-11-19).
 */
const ANY_QTY_GAPS = [1, 0, 2, 3];

const parseRaw = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const isReturn = (s) => String(s.recordType ?? 'sale').trim().toLowerCase() === 'return';
const isConditionFile = (f) => String(f?.mergeGroup ?? '').endsWith(`|${CONDITION_VARIANT}`);

/** «عبد الله» (كلمتان: تُسقط «ال») = «عبدالله» (كلمة): كلاهما «عبدله». */
const pharmKey = (v) => matchHelpers.pharmKey(v).replace(/عبدال/g, 'عبد');

// ── بصمة الايتم: النظامان يكتبان الاسم نفسه بصيغ مختلفة ────────────────────────
// «VOLTAYAT 12.5MG 5SUPP» = «VOLTAYYAT12.5 SUPP»، «DAYTRIX IM 1G 3.5ML 1VIAL» = «DAYTRIX (CEFTRIAXONE) 1G IM».
// الاسم التجاري (بلا حروف مكررة) + التركيز + الشكل + طريق الحقن (IM/IV) إن ذُكرت في الطرفين.
const FORM_GROUPS = [
  [/supp|ovule/, 'supp'], [/vial|amp|inj/, 'inj'], [/tab|caplet/, 'tab'], [/cap/, 'cap'],
  [/susp/, 'susp'], [/syr/, 'syrup'], [/cream|crm/, 'cream'], [/gel/, 'gel'], [/oint/, 'oint'],
  [/drop|damla/, 'drop'], [/spray/, 'spray'], [/sach/, 'sachet'],
];
export function itemSig(name) {
  const s = String(name ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z%])/g, '$1 $2');
  const words = s.match(/[a-z]+/g) ?? [];
  const brand = (words.find(w => w.length >= 3) ?? '').replace(/(.)\1+/g, '$1');
  const strengths = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(mcg|mg|g|iu|ml|%)(?![a-z])/g;
  let m;
  while ((m = re.exec(s))) {
    const v = m[1].replace(',', '.');
    let n = Number(v);
    if (m[2] === 'iu' && /^\d{1,3}\.\d{3}$/.test(v)) n = Number(v.replace('.', '')); // 300.000IU = 300000
    if (m[2] === 'g') n *= 1000;
    if (m[2] !== 'ml') strengths.push(`${n}${m[2] === 'g' ? 'mg' : m[2]}`);
  }
  const nums = new Set((s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter(n => n >= 2));
  const form = FORM_GROUPS.find(([r]) => r.test(s))?.[1] ?? null;
  const route = /\bim\b/.test(s) ? 'im' : /\biv\b/.test(s) ? 'iv' : null;
  return { brand, strengths, nums, form, route };
}

export function sigsMatch(a, b) {
  if (!a.brand || a.brand.length < 4 || a.brand !== b.brand) return false;
  if (a.route && b.route && a.route !== b.route) return false;
  if (a.form && b.form && a.form !== b.form) return false;
  if (a.strengths.length && b.strengths.length) return a.strengths.some(x => b.strengths.includes(x));
  if (!a.nums.size && !b.nums.size) return true;
  for (const n of a.nums) if (b.nums.has(n)) return true;
  return false;
}

// ── الجزء الصافي (بلا قاعدة بيانات) — يُختبر في scripts/test-yazen-match.mjs ──

/**
 * سياق الهوية من الدمج الموجود (طلب 2026-11-19): ما دمجه المستخدم سابقاً يُعدّ الشيء نفسه.
 *  itemRules: fromKey (normalizeItemKey) → [{ toItemId, toKey }] — من ItemMergeRule.
 *  areaAliases: مفتاح منطقة (بلا مسافات) → [مفتاح المنطقة القانونية] — من AreaAlias (الحبيبية → مدينة الصدر).
 */
export const EMPTY_CTX = { itemRules: new Map(), areaAliases: new Map() };

// كل هوية (ايتم/صيدلية) ← رقم صغير مرة واحدة، فمفتاح ذاكرة المقارنة رقم لا نص طويل يُبنى
// ويُحسب hash له مع كل مقارنة (كان ذلك وحده 5.7 من 6 ثوانٍ في القياس).
const internTable = new Map();
function intern(str) {
  let v = internTable.get(str);
  if (v === undefined) {
    if (internTable.size > 1_000_000) internTable.clear();
    v = internTable.size + 1;
    internTable.set(str, v);
  }
  return v;
}

function itemIdentity(itemId, names, ctx) {
  const keys = new Set(names.map(n => normalizeItemKey(n ?? '')).filter(Boolean));
  const ids = new Set(itemId ? [itemId] : []);
  for (const k of [...keys]) {
    for (const r of ctx.itemRules.get(k) ?? []) {
      if (r.toItemId) ids.add(r.toItemId);
      if (r.toKey) keys.add(r.toKey);
    }
  }
  // مفتاح الهوية لذاكرة المقارنة: صفوف الايتم نفسه تتكرر بالآلاف.
  const itemTok = intern([...ids].sort((a, b) => a - b).join(',') + '#' + [...keys].sort().join('|'));
  return { ids, keys, sigs: [...keys].map(itemSig), itemTok };
}

function pharmacyIdentity(pharmacy) {
  return { pharmacy, pharmTok: intern('' + pharmacy) };
}

function areaIdentity(name, ctx) {
  const k = matchHelpers.areaKey(name);
  if (!k) return new Set();
  return new Set([k, ...(ctx.areaAliases.get(k) ?? [])]);
}

/** صف يزن (Sale من ميركاتو مع rawData) ← شكل المطابقة. */
export function prepareYazenRow(s, repId = null, ctx = EMPTY_CTX) {
  const raw = parseRaw(s.rawData);
  return {
    id: s.id, repId, ret: isReturn(s),
    ...itemIdentity(s.itemId ?? null, [s.item?.name, raw['اسم المادة بالمكتب']], ctx),
    qty: Math.abs(Number(s.quantity) || 0),
    bonus: Math.abs(Number(raw.bonus ?? raw['كمية البونص']) || 0),
    ...pharmacyIdentity(pharmKey(raw.pharmacy || s.customer?.name || raw['اسم الشركة'] || '')),
    areas: areaIdentity(s.area?.name, ctx),
    day: matchHelpers.dayOf(s.saleDate),
  };
}

/** صف ملف المكتب (حقول خفيفة، بلا rawData) ← شكل المطابقة. */
export function prepareOfficeRow(s, ctx = EMPTY_CTX) {
  const t = s.saleDate ? new Date(new Date(s.saleDate).getTime() + OFFICE_TZ_SHIFT) : null;
  return {
    id: s.id, ret: isReturn(s),
    ...itemIdentity(s.itemId ?? null, [s.item?.name], ctx),
    qty: Math.abs(Number(s.quantity) || 0),
    ...pharmacyIdentity(pharmKey(s.customer?.name ?? '')),
    areas: areaIdentity(s.area?.name, ctx),
    day: matchHelpers.dayOf(t),
  };
}

/** ميركاتو قد يعدّ البونص ضمن الكمية أو خارجها. */
const sameQty = (y, o) => Math.abs(y.qty - o.qty) < 0.001
  || (y.bonus > 0 && (Math.abs(y.qty + y.bonus - o.qty) < 0.001 || Math.abs(y.qty - y.bonus - o.qty) < 0.001));

// ذاكرة المقارنات أثناء المطابقة: المقارنة التقريبية (Levenshtein) هي الكلفة كلها، وأزواج
// الأسماء نفسها تتكرر عبر الأيام والمراحل. أول تشغيل بلا ذاكرة: 24 ثانية تحجب الخادم.
let memo = null;
function withMemo(fn) {
  const outer = memo;
  memo = outer ?? { ph: new Map(), it: new Map() };
  try { return fn(); } finally { memo = outer; }
}
/** ذاكرة بمفتاحين صغيرين (Map داخل Map): الرقم المركّب الكبير يخرج من نطاق Smi فيبطؤ. */
function cached(map, a, b, compute) {
  let inner = map.get(a);
  if (!inner) { inner = new Map(); map.set(a, inner); }
  let v = inner.get(b);
  if (v === undefined) { v = compute(); inner.set(b, v); }
  return v;
}

function sameItem(y, o) {
  return memo ? cached(memo.it, y.itemTok, o.itemTok, () => sameItemRaw(y, o)) : sameItemRaw(y, o);
}

function sameItemRaw(y, o) {
  for (const id of o.ids) if (y.ids.has(id)) return true; // نفس الايتم أو مدموج إليه
  for (const k of o.keys) if (y.keys.has(k)) return true;
  for (const a of y.keys) for (const b of o.keys) if (areSimilar(a, b)) return true;
  for (const a of y.sigs) for (const b of o.sigs) if (sigsMatch(a, b)) return true;
  return false;
}

// المنطقة لا تمنع: ملف المكتب يكتب منطقة واسعة (مدينة الصدر) واليزن الحي نفسه (الحبيبية،
// الطالبية) — أول تشغيل على الإنتاج: 92 من 136 صفاً فاتت بهذا. تبقى أفضلية بين المرشحين فقط.
function samePharmacy(y, o) {
  const raw = () => matchHelpers.namesMatch(y.pharmacy, o.pharmacy) === true;
  return memo ? cached(memo.ph, y.pharmTok, o.pharmTok, raw) : raw();
}
function areaAgrees(y, o) {
  if (!y.areas.size || !o.areas.size) return true;
  for (const a of y.areas) if (o.areas.has(a)) return true; // نفسها أو مدموجة تحتها
  for (const a of y.areas) for (const b of o.areas) if (matchHelpers.namesMatch(a, b, 0.85) === true) return true;
  return false;
}

/**
 * مطابقة واحد لواحد. الدورة الخارجية على فرق الأيام بالأفضلية، فكل مطابقات «اليوم التالي»
 * تُحسم قبل «اليوم نفسه» — لا يسرق صفٌّ أبعد مطابقةَ صف أقرب.
 * @param {Array} yazen مُحضَّرة بـ prepareYazenRow
 * @param {Array} office مُحضَّرة بـ prepareOfficeRow
 * @returns {Array<{officeSaleId:number, mercatoSaleId:number, marketerRepId:number|null, gapDays:number}>}
 */
export function matchYazenToOffice(yazen, office) {
  return withMemo(() => matchYazenToOfficeRaw(yazen, office));
}

function matchYazenToOfficeRaw(yazen, office) {
  const byDay = new Map();
  for (const o of office) {
    if (o.day == null) continue;
    if (!byDay.has(o.day)) byDay.set(o.day, []);
    byDay.get(o.day).push(o);
  }
  const usedOffice = new Set();
  const doneYazen = new Set();
  const out = [];
  const pass = (gaps, qtyOk) => {
    for (const gap of gaps) {
      for (const y of yazen) {
        if (doneYazen.has(y) || y.day == null) continue;
        const list = byDay.get(y.day + gap * DAY);
        if (!list) continue;
        let pick = null;
        for (const o of list) {
          if (usedOffice.has(o) || o.ret !== y.ret || !qtyOk(y, o)) continue;
          if (!sameItem(y, o) || !samePharmacy(y, o)) continue;
          if (!pick) pick = o;
          if (areaAgrees(y, o)) { pick = o; break; } // المنطقة نفسها أولى من غيرها
        }
        if (pick) {
          usedOffice.add(pick); doneYazen.add(y);
          out.push({ officeSaleId: pick.id, mercatoSaleId: y.id, marketerRepId: y.repId, gapDays: gap });
        }
      }
    }
  };
  pass(GAP_PREFERENCE, sameQty);
  // صف مكتب بكمية مختلفة لا يُنسب لطلبية يزن إن كانت هناك طلبية يزن أخرى قد تكون هي أصله.
  const yazenByDay = new Map();
  for (const y of yazen) if (y.day != null) { if (!yazenByDay.has(y.day)) yazenByDay.set(y.day, []); yazenByDay.get(y.day).push(y); }
  const unambiguous = (y, o) => {
    for (let g = 0; g <= 3; g++) {
      for (const y2 of yazenByDay.get(o.day - g * DAY) ?? []) {
        if (y2 !== y && y2.ret === y.ret && sameItem(y2, o) && samePharmacy(y2, o)) return false;
      }
    }
    return true;
  };
  pass(ANY_QTY_GAPS, unambiguous);
  return out;
}

/**
 * تشخيص: لكل صف يزن لم يُطابَق — أبعد مرحلة بلغها أقرب مرشح في نافذة الأيام.
 * المراحل: noDay (لا صف مكتب في تلك الأيام) → type → item → pharmacy → qty → used.
 */
export function explainUnmatched(yazen, office, matches) {
  return withMemo(() => explainUnmatchedRaw(yazen, office, matches));
}

function explainUnmatchedRaw(yazen, office, matches) {
  const done = new Set(matches.map(m => m.mercatoSaleId));
  const usedOffice = new Set(matches.map(m => m.officeSaleId));
  const byDay = new Map();
  for (const o of office) { if (o.day == null) continue; if (!byDay.has(o.day)) byDay.set(o.day, []); byDay.get(o.day).push(o); }
  const STAGES = ['noDay', 'type', 'item', 'pharmacy', 'qty', 'used'];
  const counts = Object.fromEntries(STAGES.map(s => [s, 0]));
  const samples = [];
  for (const y of yazen) {
    if (done.has(y.id)) continue;
    let best = 0, cand = null;
    for (const gap of GAP_PREFERENCE) {
      for (const o of byDay.get(y.day + gap * DAY) ?? []) {
        let st = 1;
        if (o.ret === y.ret) { st = 2; if (sameItem(y, o)) { st = 3; if (samePharmacy(y, o)) { st = 4; if (sameQty(y, o)) st = 5; } } }
        if (st > best) { best = st; cand = o; }
      }
    }
    counts[STAGES[best]]++;
    if (samples.length < 6 && best >= 2) {
      samples.push({ stage: STAGES[best], yazen: { day: y.day && new Date(y.day).toISOString().slice(0, 10), pharmacy: y.pharmacy, area: [...y.areas].join('/'), keys: [...y.keys], qty: y.qty },
        office: cand && { day: cand.day && new Date(cand.day).toISOString().slice(0, 10), pharmacy: cand.pharmacy, area: [...cand.areas].join('/'), keys: [...cand.keys], qty: cand.qty, used: usedOffice.has(cand.id) } });
    }
  }
  // أعمق: لكل غير مطابَق — هل الصيدلية + الايتم موجودان بفرق أيام أبعد؟ وإلا فأسماء الصيدليات
  // المرشحة (نفس الايتم والكمية داخل النافذة) وأسماء الايتمات الغائبة.
  const gaps = {};
  const pharmPairs = [];
  const itemMisses = [];
  for (const y of yazen) {
    if (done.has(y.id) || y.day == null) continue;
    const same = office.filter(o => o.day != null && o.ret === y.ret && sameItem(y, o) && samePharmacy(y, o));
    if (same.length) {
      const g = Math.min(...same.map(o => Math.round((o.day - y.day) / DAY)), 99);
      const key = same.some(o => sameQty(y, o)) ? `${g}` : `${g}~q`;
      gaps[key] = (gaps[key] ?? 0) + 1;
      continue;
    }
    const near = office.filter(o => o.day != null && o.ret === y.ret && Math.abs((o.day - y.day) / DAY - 1) <= 2 && sameItem(y, o));
    if (near.length) {
      if (pharmPairs.length < 12) pharmPairs.push(`${y.pharmacy}|${[...y.areas].join('/')} ↔ ${[...new Set(near.filter(o => sameQty(y, o)).map(o => `${o.pharmacy}|${[...o.areas].join('/')}`))].slice(0, 3).join(' ; ') || '(qty≠) ' + [...new Set(near.map(o => o.pharmacy))].slice(0, 3).join(' ; ')}`);
    } else if (itemMisses.length < 12) {
      const first = [...y.keys][0]?.split(' ')[0] ?? '';
      const alike = [...new Set(office.filter(o => [...o.keys].some(k => k.startsWith(first.slice(0, 4)))).flatMap(o => [...o.keys]))].slice(0, 3);
      itemMisses.push(`${[...y.keys].join(' / ')} @${y.pharmacy} ⇢ ${alike.join(' ; ') || '—'}`);
    }
  }
  return { counts, samples, gaps, pharmPairs, itemMisses };
}

// ── النطاق: كل ملفات المبيعات (مطابقة واحدة شاملة) ─────────────────────────────
// كان النطاق مكتب صاحب الملف، لكن ملف المكتب الشهري قد يرفعه حساب خارج مكتب من رفع ميركاتو
// (أول تشغيل على الإنتاج: 0/483 لأن ملف المكتب الفعلي في نطاق آخر). المطابقة تتطلب الصيدلية
// والايتم والكمية والتاريخ معاً، فلا خطر يُذكر من خلط ملفات مكاتب أخرى.
export const GLOBAL_SCOPE = 'all';

/** نطاقات الملفات المعطاة (نطاق واحد شامل). */
export async function scopeKeysForFiles(fileIds) {
  return (fileIds || []).length ? [GLOBAL_SCOPE] : [];
}

async function loadScopeFiles(scopeKey) {
  return prisma.uploadedFile.findMany({
    // نفس قاعدة قائمة الملفات (index.js /api/files): كل الأنواع (sales/returns/auto/matrix) عدا هذين.
    where: { NOT: { fileType: { in: ['filter_page', 'pharmacy_net'] } } },
    select: { id: true, sourceSystem: true, mergeGroup: true },
  });
}

/** أسماء المسوقين المطبَّعة (الاسم + روابط أسماء المندوبين) → معرّف المسوّق. */
async function loadMarketerNames() {
  const users = await prisma.user.findMany({
    where: { isActive: true, linkedRepId: { not: null }, linkedRep: { is: { repKind: PHARMACY_KIND } } },
    select: { linkedRepId: true, linkedRep: { select: { name: true } } },
  });
  const repIds = [...new Set(users.map(u => u.linkedRepId))];
  const links = repIds.length
    ? await prisma.sciRepNameLink.findMany({ where: { scientificRepId: { in: repIds } }, select: { fromKey: true, scientificRepId: true } })
    : [];
  const byName = new Map();
  for (const u of users) { const k = normalizeRepName(u.linkedRep?.name ?? ''); if (k && !byName.has(k)) byName.set(k, u.linkedRepId); }
  for (const l of links) if (l.fromKey && !byName.has(l.fromKey)) byName.set(l.fromKey, l.scientificRepId);
  return byName;
}

/** دمج الايتمات (ItemMergeRule) ودمج المناطق (AreaAlias) — الهوية التي قرّرها المستخدم. */
async function loadIdentityContext() {
  const [rules, aliases] = await Promise.all([
    prisma.itemMergeRule.findMany({ select: { fromKey: true, toItemId: true, toName: true } }),
    prisma.areaAlias.findMany({ select: { fromKey: true, area: { select: { name: true } } } }),
  ]);
  const itemRules = new Map();
  for (const r of rules) {
    const k = normalizeItemKey(r.fromKey ?? '');
    if (!k) continue;
    if (!itemRules.has(k)) itemRules.set(k, []);
    itemRules.get(k).push({ toItemId: r.toItemId ?? null, toKey: r.toName ? normalizeItemKey(r.toName) : null });
  }
  const areaAliases = new Map();
  for (const a of aliases) {
    const from = matchHelpers.areaKey(a.fromKey);
    const to = matchHelpers.areaKey(a.area?.name);
    if (!from || !to || from === to) continue;
    if (!areaAliases.has(from)) areaAliases.set(from, []);
    areaAliases.get(from).push(to);
  }
  return { itemRules, areaAliases, size: rules.length + aliases.length };
}

async function scopeFingerprint(files, names) {
  const ids = files.map(f => f.id).sort((a, b) => a - b);
  if (!ids.length) return `v${MATCH_VERSION}|empty`;
  const agg = await prisma.sale.aggregate({ where: { uploadedFileId: { in: ids }, isHidden: false }, _count: { _all: true }, _max: { id: true } });
  const nameSig = [...names.entries()].map(([k, v]) => `${k}=${v}`).sort().join(',');
  let h = 0;
  for (let i = 0; i < nameSig.length; i++) h = (h * 31 + nameSig.charCodeAt(i)) | 0;
  const [rules, aliases] = await Promise.all([prisma.itemMergeRule.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }), prisma.areaAlias.aggregate({ _count: { _all: true }, _max: { id: true } })]);
  const merges = `${rules._count._all}.${rules._max.updatedAt?.getTime() ?? 0}.${aliases._count._all}.${aliases._max.id ?? 0}`;
  return `v${MATCH_VERSION}|${ids.join(',')}|${agg._count._all}|${agg._max.id ?? 0}|${h}|${merges}`;
}

// يُرفع مع أي تغيير في قواعد المطابقة، فيُعاد حساب كل نطاق عند الإقلاع.
const MATCH_VERSION = 8;

const yieldLoop = () => new Promise(r => setImmediate(r));

async function computeScope(scopeKey, { force = false } = {}) {
  const t0 = Date.now();
  const [files, names] = await Promise.all([loadScopeFiles(scopeKey), loadMarketerNames()]);
  const fp = await scopeFingerprint(files, names);
  const prev = await prisma.yazenMatchRun.findUnique({ where: { scopeKey } });
  if (!force && prev?.fingerprint === fp && prev.status === 'idle') return prev;

  await prisma.yazenMatchRun.upsert({
    where: { scopeKey },
    create: { scopeKey, status: 'running', startedAt: new Date() },
    update: { status: 'running', startedAt: new Date(), error: null },
  });
  try {
    const ctx = await loadIdentityContext();
    const mercatoIds = files.filter(f => f.sourceSystem === 'mercato' && !isConditionFile(f)).map(f => f.id);
    const officeIds = files.filter(f => f.sourceSystem !== 'mercato').map(f => f.id);

    // صفوف اليزن بـ SQL أولاً: rawData يُحمَّل لها وحدها لا لكل ميركاتو.
    const yazenIdRows = mercatoIds.length
      ? await prisma.$queryRawUnsafe(
          `SELECT id FROM sales WHERE "uploadedFileId" IN (${mercatoIds.join(',')}) AND "isHidden" = false AND ${OFFICE_WAREHOUSE_SQL}`)
      : [];
    const yazenSales = yazenIdRows.length
      ? await prisma.sale.findMany({
          where: { id: { in: yazenIdRows.map(r => Number(r.id)) } },
          select: {
            id: true, itemId: true, quantity: true, recordType: true, saleDate: true, rawData: true,
            item: { select: { name: true } }, customer: { select: { name: true } }, area: { select: { name: true } },
            representative: { select: { name: true } },
          },
        })
      : [];
    const yazen = [];
    for (const s of yazenSales) {
      if (!isOfficeWarehouseRow(s.rawData)) continue;
      const repId = names.get(normalizeRepName(s.representative?.name ?? ''));
      if (repId == null) continue; // يزن مندوب علمي: يبقى مبيعه هو، لا فارمسي
      yazen.push(prepareYazenRow(s, repId, ctx));
    }

    // كل ملف مكتب يُطابَق وحده: نسخ بيانات المكتب نفسها في ملفات حسابات مختلفة تُعزل كلها،
    // وصف المكتب لا يُستعمل مرتين داخل ملفه.
    let matches = [];
    const days = yazen.map(y => y.day).filter(d => d != null);
    const matchedYazen = new Set();
    if (days.length && officeIds.length) {
      // نطاق التواريخ فقط (لا ايتمات): الايتم قد يختلف معرّفه بين ملفَي النظامين.
      const from = new Date(Math.min(...days) - 2 * DAY);
      const to = new Date(Math.max(...days) + 5 * DAY);
      const fmt = (d) => new Date(d).toISOString().slice(0, 10);
      let biggest = null;
      for (const fileId of officeIds) {
        const office = [];
        const BATCH = 5000;
        let cursor = 0;
        for (;;) {
          const rows = await prisma.sale.findMany({
            where: { uploadedFileId: fileId, isHidden: false, saleDate: { gte: from, lte: to }, id: { gt: cursor } },
            select: {
              id: true, itemId: true, quantity: true, recordType: true, saleDate: true,
              item: { select: { name: true } }, customer: { select: { name: true } }, area: { select: { name: true } },
            },
            orderBy: { id: 'asc' }, take: BATCH,
          });
          for (const r of rows) office.push(prepareOfficeRow(r, ctx));
          if (rows.length < BATCH) break;
          cursor = rows[rows.length - 1].id;
          await yieldLoop();
        }
        if (!office.length) continue;
        await yieldLoop();
        const found = matchYazenToOffice(yazen, office);
        for (const m of found) { matches.push(m); matchedYazen.add(m.mercatoSaleId); }
        console.log(`[yazen-match] file ${fileId}: ${office.length} office rows in window, matched ${found.length}/${yazen.length}`);
        if (!biggest || office.length > biggest.office.length) biggest = { fileId, office, found };
      }
      console.log(`[yazen-match] yazen ${fmt(Math.min(...days))}..${fmt(Math.max(...days))}, office files ${officeIds.length}`);
      if (biggest && biggest.found.length < yazen.length) {
        const why = explainUnmatched(yazen, biggest.office, biggest.found);
        console.log(`[yazen-match] file ${biggest.fileId} unmatched by stage ${JSON.stringify(why.counts)}`);
        console.log(`[yazen-match] same pharmacy+item at gap (days, ~q = qty differs) ${JSON.stringify(why.gaps)}`);
        for (const p of why.pharmPairs) console.log(`[yazen-match] pharm ${p}`);
        for (const p of why.itemMisses) console.log(`[yazen-match] item ${p}`);
      }
    } else {
      console.log(`[yazen-match] ${scopeKey} skipped: yazen days ${days.length}, office files ${officeIds.length}`);
    }

    await prisma.$transaction(async (tx) => {
      // يشمل صفوف النطاقات القديمة (office:N) من قبل النطاق الشامل.
      await tx.yazenOfficeMatch.deleteMany({});
      for (let i = 0; i < matches.length; i += 1000) {
        await tx.yazenOfficeMatch.createMany({ data: matches.slice(i, i + 1000).map(m => ({ ...m, scopeKey })), skipDuplicates: true });
      }
      await tx.yazenMatchRun.deleteMany({ where: { scopeKey: { not: scopeKey } } });
    }, { timeout: 60_000 });
    const ms = Date.now() - t0;
    const run = await prisma.yazenMatchRun.update({
      where: { scopeKey },
      data: { status: 'idle', fingerprint: fp, matched: matchedYazen.size, yazenRows: yazen.length, ms, finishedAt: new Date() },
    });
    console.log(`[yazen-match] ${scopeKey} matched ${matchedYazen.size}/${yazen.length} yazen rows (${matches.length} office rows) in ${ms}ms`);
    return run;
  } catch (e) {
    console.error(`[yazen-match] ${scopeKey} failed:`, e.message);
    await prisma.yazenMatchRun.update({ where: { scopeKey }, data: { status: 'failed', error: String(e.message).slice(0, 500), finishedAt: new Date() } }).catch(() => {});
    throw e;
  }
}

// ── الجدولة: نطاق واحد يعمل في كل لحظة (ذاكرة السيرفر هي القيد) ────────────────

let chain = Promise.resolve();
const running = new Map(); // scopeKey → promise
const timers = new Map();
const lastChecked = new Map(); // scopeKey → آخر فحص بصمة عند القراءة

function runScope(scopeKey, opts) {
  if (running.has(scopeKey)) return running.get(scopeKey);
  const p = chain.then(() => computeScope(scopeKey, opts));
  chain = p.catch(() => {});
  running.set(scopeKey, p);
  p.catch(() => {}).finally(() => running.delete(scopeKey));
  return p;
}

/** يجدول إعادة المطابقة بعد مهلة قصيرة (رفعات متتالية = تشغيل واحد). */
export function scheduleYazenMatch(scopeKey, delayMs = 20_000) {
  if (!scopeKey) return;
  clearTimeout(timers.get(scopeKey));
  timers.set(scopeKey, setTimeout(() => { timers.delete(scopeKey); runScope(scopeKey).catch(() => {}); }, delayMs));
}

/** بعد رفع/حذف في هذه الملفات. لا يرمي أبداً. */
export async function scheduleYazenMatchForFiles(fileIds) {
  try { for (const k of await scopeKeysForFiles(fileIds)) scheduleYazenMatch(k); } catch (e) { console.error('[yazen-match] schedule', e.message); }
}

/** بعد رفع ملف لمستخدم (الملف الجديد قد لا يُعرف معرّفه هنا). */
export function scheduleYazenMatchForUser() {
  scheduleYazenMatch(GLOBAL_SCOPE);
}

/**
 * قبل قراءة المطابقات: نطاق لم يُحسب قطّ يُحسب الآن (مرة واحدة)، ونطاق بصمته قديمة يُجدوَل في
 * الخلفية ويُقرأ آخر ناتج محفوظ — العرض لا ينتظر.
 */
export async function ensureYazenMatches(fileIds) {
  const keys = await scopeKeysForFiles(fileIds);
  const runs = await prisma.yazenMatchRun.findMany({ where: { scopeKey: { in: keys } } });
  const byKey = new Map(runs.map(r => [r.scopeKey, r]));
  for (const k of keys) {
    const r = byKey.get(k);
    if (!r?.finishedAt) { await runScope(k).catch(() => {}); continue; }
    if (running.has(k) || timers.has(k)) continue;
    if (Date.now() - (lastChecked.get(k) ?? 0) < 30_000) continue;
    lastChecked.set(k, Date.now());
    // فحص البصمة في الخلفية: التقرير لا ينتظر عدّ صفوف كل الملفات.
    Promise.all([loadScopeFiles(k), loadMarketerNames()])
      .then(([files, names]) => scopeFingerprint(files, names))
      .then(fp => { if (fp !== r.fingerprint) scheduleYazenMatch(k, 0); })
      .catch(e => console.error('[yazen-match] check', e.message));
  }
}

/** معرّفات صفوف المكتب المطابقة ليزن، من بين المعطاة. */
export async function matchedOfficeSaleIds(saleIds) {
  const ids = [...new Set(saleIds)].filter(Number.isInteger);
  const out = new Set();
  for (let i = 0; i < ids.length; i += 20_000) {
    const rows = await prisma.yazenOfficeMatch.findMany({ where: { officeSaleId: { in: ids.slice(i, i + 20_000) } }, select: { officeSaleId: true } });
    for (const r of rows) out.add(r.officeSaleId);
  }
  return out;
}

/** حالة كل نطاق — لصفحة السوبر أدمن. */
export async function yazenMatchStatus() {
  const runs = await prisma.yazenMatchRun.findMany({ orderBy: { scopeKey: 'asc' } });
  return runs.map(r => ({ ...r, busy: running.has(r.scopeKey) || timers.has(r.scopeKey) }));
}

/** عند الإقلاع: يتخطى الحساب إن لم تتغيّر البصمة. */
export function startYazenMatchOnBoot(delayMs = 60_000) {
  setTimeout(() => { runScope(GLOBAL_SCOPE).catch(() => {}); }, delayMs).unref?.();
}

/** إعادة الحساب فوراً (زر السوبر أدمن). */
export function forceYazenMatch(scopeKey) {
  return runScope(scopeKey, { force: true });
}
