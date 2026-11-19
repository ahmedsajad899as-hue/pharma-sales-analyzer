// ════════════════════════════════════════════════════════════════════════════
// group-context.js — ما يُعرف من **الكروب نفسه** حين لا تذكره الطلبية (2026-11-17).
//
// كروبات المحافظات («ديوانية مكتب النسق») لا يكتب فيها المندوب المنطقة — الكروب هو
// المنطقة. ولا يُربط رقمه بحساب غالباً، لكن اسمه في واتساب («Ameer Madher») هو اسم
// مندوب مسجّل في تلك المحافظة بالعربي («امير مضر»). فـ:
//  • areaFromTitle      — منطقة/محافظة مسجّلة يحملها اسم الكروب ← منطقة الصفوف الفارغة.
//  • sameNameAcrossScripts — «Ameer Madher» ≡ «امير مضر» بهيكل الحروف الساكنة.
//  • fillFromGroupContext  — يطبّقهما على صفوف لم تُحسم، ولا يطغى على ما حُسم.
// الدوال الأولى نقية (اختبارها: npm run test:group-context).
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import { provinceIdByNameKey } from '../../lib/repGuessRules.js';
import { loadKnownAreaIndex } from './order-extract.js';

// ─── اسم الكروب ← منطقة/محافظة ───────────────────────────────────────────────

/**
 * أطول تتابع كلمات من اسم الكروب يطابق منطقة مسجّلة أولاً ثم محافظة.
 * @param {string} title
 * @param {Map<string,string>} areaIndex  مفتاح normalizeAreaName ← الاسم القانوني
 * @param {Map<string,{id:number,name:string}>} provinceIndex مفتاح ← المحافظة
 * @returns {{ area: string, provinceId: number|null, kind: 'area'|'province' } | null}
 */
export function areaFromTitle(title, areaIndex, provinceIndex) {
  const words = normalizeAreaName(String(title ?? '')).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const grams = [];
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) grams.push(words.slice(i, i + n).join(' '));
  }
  // المنطقة المسجّلة أولاً: «الديوانية» صفّ Area (مركز محافظة القادسية)، بينما اسم
  // المحافظة «القادسية» يصطدم بحيّ في الكرخ — وضعه في خانة المنطقة يقترح مندوبي بغداد.
  for (const k of grams) {
    if (k.length < 3) continue;
    const a = areaIndex.get(k);
    if (a) return { area: a, provinceId: null, kind: 'area' };
  }
  for (const k of grams) {
    const p = provinceIndex.get(k);
    if (p) return { area: p.name, provinceId: p.id, kind: 'province' };
  }
  return provinceFromLatinTitle(title, provinceIndex);
}

// هيكل اسم مكان: «ة/ه» الختامية تُسقط («البصرة» BSR = «Basra» BSR = «Basrah»).
const placeSkeleton = (w) => wordSkeleton(w).replace(/H$/, '');

/**
 * اسم كروب لاتيني («Basra nasq»، 2026-11-19): هيكل الحروف الساكنة يطابق محافظة بالعربي.
 * المحافظات فقط (قائمة قصيرة) — هيكل ثلاثة حروف يصطدم بمئات المناطق. هيكل أقصر من 3
 * حروف لا يُعتمد، وأكثر من محافظة بنفس الهيكل = لا حسم.
 */
export function provinceFromLatinTitle(title, provinceIndex) {
  const words = String(title ?? '').toLowerCase().match(/[a-z]+/g) || [];
  if (!words.length) return null;
  const provs = [...provinceIndex].map(([k, p]) => ({ sk: String(k).split(/\s+/).map(placeSkeleton).join(''), p }));
  for (let n = Math.min(2, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const sk = words.slice(i, i + n).filter(w => w !== 'al' && w !== 'el').map(placeSkeleton).join('');
      if (sk.length < 3) continue;
      const ids = new Map(provs.filter(x => x.sk === sk).map(x => [x.p.id, x.p]));
      if (ids.size === 1) {
        const p = [...ids.values()][0];
        return { area: p.name, provinceId: p.id, kind: 'province' };
      }
    }
  }
  return null;
}

// ─── الاسم بين الأبجديتين ────────────────────────────────────────────────────
// هيكل الحروف الساكنة بفئات متسامحة (د/ض/ذ/ظ/ز فئة، ك/ق/خ/غ/گ فئة…)؛ الحروف
// الصائتة وأشباهها (ا و ي ع ء ة / a e i o u y w) تُسقط، والمكرّر يُطوى.
const AR_CLASS = {
  'ب': 'B', 'پ': 'B', 'ت': 'T', 'ط': 'T', 'ث': 'T',
  'د': 'D', 'ض': 'D', 'ذ': 'D', 'ظ': 'D', 'ز': 'D',
  'س': 'S', 'ص': 'S', 'ش': 'S', 'ك': 'K', 'ق': 'K', 'خ': 'K', 'غ': 'K', 'گ': 'K',
  'ج': 'J', 'چ': 'S', 'ح': 'H', 'ه': 'H', 'ف': 'F', 'ڤ': 'F',
  'ل': 'L', 'م': 'M', 'ن': 'N', 'ر': 'R',
};
const LAT_DIGRAPH = [['sh', 'S'], ['ch', 'S'], ['kh', 'K'], ['gh', 'K'], ['th', 'T'], ['dh', 'D'], ['ph', 'F']];
const LAT_CLASS = {
  b: 'B', p: 'B', t: 'T', d: 'D', z: 'D', s: 'S', c: 'K', k: 'K', q: 'K', g: 'K', x: 'K',
  j: 'J', h: 'H', f: 'F', v: 'F', l: 'L', m: 'M', n: 'N', r: 'R',
};

const collapse = (s) => s.replace(/(.)\1+/g, '$1');

/** هيكل كلمة واحدة (عربية أو لاتينية). */
export function wordSkeleton(word) {
  let w = String(word ?? '').toLowerCase().replace(/[ً-ٟـ]/g, '');
  if (/[a-z]/.test(w)) {
    // «Al-» / «El-» أداة تعريف لا جزء من الاسم.
    w = w.replace(/^(?:al|el)-/, '');
    for (const [dg, c] of LAT_DIGRAPH) w = w.split(dg).join(c);
    return collapse([...w].map(ch => LAT_CLASS[ch] ?? (/[A-Z]/.test(ch) ? ch : '')).join(''));
  }
  // «ال» التعريف + «عبدال…» تُترك كما هي (تُقرأ «Abdul…»/«Abdal…» بنفس الهيكل).
  w = w.replace(/^ال(?=..)/, '');
  return collapse([...w].map(ch => AR_CLASS[ch] ?? '').join(''));
}

/** «Ameer Madher» ← ['MR','MDR']. الكلمات بلا ساكن («Ali» الصائتة؟) تُسقط. */
export function nameSkeleton(name) {
  return String(name ?? '')
    .replace(/[^\p{L}\s-]/gu, ' ')
    .split(/[\s]+/).filter(Boolean)
    .map(wordSkeleton).filter(Boolean);
}

/**
 * هل الاسمان لشخص واحد ولو بأبجديتين؟ تطابق هيكل أول كلمتين على الأقل (بالترتيب)
 * — كلمة واحدة («Ali») تطابق مئات الأسماء فلا تكفي.
 */
export function sameNameAcrossScripts(a, b) {
  const x = nameSkeleton(a), y = nameSkeleton(b);
  const n = Math.min(x.length, y.length);
  if (n < 2) return false;
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  // هيكل قصير جداً (حرفان للاسمين معاً) لبس أكثر منه دليل.
  return x.slice(0, n).join('').length >= 4;
}

/**
 * من المرشّحين: من اسمه يطابق اسم المرسل. يُعيد المرشّح الوحيد أو null.
 * provinceId: إن عُرفت المحافظة من الكروب ضُيِّق عليها أولاً.
 * @param {{ id:number, name:string, provinces:Set<number> }[]} candidates
 */
export function pickRepBySenderName(senderName, candidates, provinceId = null) {
  if (!String(senderName ?? '').trim()) return null;
  let hits = candidates.filter(c => sameNameAcrossScripts(senderName, c.name));
  if (provinceId != null && hits.length) {
    const inProv = hits.filter(c => c.provinces.has(provinceId));
    if (inProv.length) hits = inProv;
  }
  return hits.length === 1 ? hits[0] : null;
}

// ─── التطبيق على صفوف الطلبية ────────────────────────────────────────────────

const CACHE_MS = 10 * 60_000;
let provinceCache = null; // { at, byKey: Map<key,{id,name}> }
async function loadProvinceIndex() {
  if (provinceCache && Date.now() - provinceCache.at < CACHE_MS) return provinceCache.byKey;
  const provinces = await prisma.province.findMany({ select: { id: true, name: true, aliases: true } });
  const idByKey = provinceIdByNameKey(provinces, normalizeAreaName);
  const byId = new Map(provinces.map(p => [p.id, p]));
  const byKey = new Map([...idByKey].map(([k, id]) => [k, { id, name: byId.get(id).name }]));
  provinceCache = { at: Date.now(), byKey };
  return byKey;
}

/** مندوبو مكتب الحساب مع محافظاتهم (تعيين محافظة + فريق محافظة + مناطق داخل محافظة). */
async function loadOfficeReps(user) {
  const officeWhere = user.officeId ? { officeId: user.officeId } : { id: user.id };
  const [reps, teamAssigns] = await Promise.all([
    prisma.user.findMany({
      where: { role: 'scientific_rep', isActive: true, ...officeWhere },
      select: {
        id: true, username: true, displayName: true,
        provinceAssignments: { select: { provinceId: true } },
        areaAssignments: { select: { area: { select: { provinceId: true } } } },
      },
    }),
    user.officeId
      ? prisma.provinceRepAssignment.findMany({
          where: { isActive: true, team: { officeId: user.officeId, isActive: true }, rep: { isActive: true } },
          select: { repUserId: true, team: { select: { provinceId: true } }, rep: { select: { id: true, username: true, displayName: true } } },
        })
      : Promise.resolve([]),
  ]);
  const byId = new Map();
  const add = (u) => {
    if (!byId.has(u.id)) byId.set(u.id, { id: u.id, name: u.displayName?.trim() || u.username, provinces: new Set() });
    return byId.get(u.id);
  };
  for (const r of reps) {
    const c = add(r);
    r.provinceAssignments.forEach(p => c.provinces.add(p.provinceId));
    r.areaAssignments.forEach(a => a.area?.provinceId != null && c.provinces.add(a.area.provinceId));
  }
  for (const t of teamAssigns) add(t.rep).provinces.add(t.team.provinceId);
  return [...byId.values()];
}

/**
 * يملأ من سياق الكروب ما لم تحسمه الطلبية. لا يرمي ولا يطغى:
 *  • row.area الفارغة ← منطقة/محافظة من اسم الكروب (_areaSource = 'group').
 *  • row.scientificRep الفارغة ← المندوب الذي يطابق اسمُه اسمَ المرسل (_repSource = 'sender').
 * يُستدعى مرتين: للمنطقة قبل تخمين المندوب، وللمندوب بعده.
 */
export async function fillAreaFromGroup(rows, chatTitle) {
  if (!rows?.length || !String(chatTitle ?? '').trim() || rows.every(r => r.area)) return null;
  try {
    const [areaIndex, provinceIndex] = await Promise.all([loadKnownAreaIndex(), loadProvinceIndex()]);
    const hit = areaFromTitle(chatTitle, areaIndex, provinceIndex);
    if (!hit) return null;
    for (const r of rows) if (!r.area) { r.area = hit.area; r._areaSource = 'group'; }
    return hit;
  } catch (e) {
    console.error('[orders] منطقة من اسم الكروب:', e?.message);
    return null;
  }
}

/**
 * صفّ ينتظر مندوباً: فارغ، أو حُسم بـ«التيم ليدر» احتياطاً (_repPick='leader') — ذاك ليس
 * دليلاً بل ملء خانة، ومرسل الطلبية المسجّل مندوباً في المحافظة أولى منه (#220: المرسل
 * «Ibrahim Mohsen» = «ابراهيم محسن نعمة» والتخمين كتب قائد الفريق لأن الصنف لم يُربط).
 * مندوب حسمه تعيين الصنف لا يُمسّ — الايتمات تحدّد المندوب.
 */
export const repSlotOpen = (r) => !r?.scientificRep || r._repPick === 'leader';

export async function fillRepFromSenderName(rows, { user, senderName, chatTitle }) {
  if (!rows?.length || !user || !String(senderName ?? '').trim() || !rows.some(repSlotOpen)) return null;
  try {
    const [candidates, provinceIndex, areaIndex] = await Promise.all([loadOfficeReps(user), loadProvinceIndex(), loadKnownAreaIndex()]);
    const hit = areaFromTitle(chatTitle, areaIndex, provinceIndex);
    let provinceId = hit?.provinceId ?? null;
    if (hit?.kind === 'area') {
      const a = await prisma.area.findFirst({ where: { name: hit.area, provinceId: { not: null } }, select: { provinceId: true } });
      provinceId = a?.provinceId ?? null;
    }
    const rep = pickRepBySenderName(senderName, candidates, provinceId);
    if (!rep) return null;
    for (const r of rows) {
      if (!repSlotOpen(r)) continue;
      r.scientificRep = rep.name; r._repSource = 'sender'; delete r._repPick;
    }
    return rep;
  } catch (e) {
    console.error('[orders] مندوب من اسم المرسل:', e?.message);
    return null;
  }
}

/**
 * المنطقة من **المندوب** حين لم تأتِ من النص ولا من اسم الكروب (كروب البصرة، 2026-11-19:
 * المرسل «Murtadha Khalid» = «مرتضى خالد نعيم» مندوب البصرة، والمنطقة بقيت فارغة).
 * مندوب في محافظة واحدة ← اسم المحافظة. أكثر من محافظة = لا حسم. للصفوف الفارغة فقط.
 * نقي: pickAreaFromRep للاختبار.
 */
export function pickAreaFromRep(repName, candidates, provinceNameById) {
  const key = normalizeAreaName(String(repName ?? '')).trim();
  if (!key) return null;
  const hits = candidates.filter(c => normalizeAreaName(c.name).trim() === key);
  if (hits.length !== 1 || hits[0].provinces.size !== 1) return null;
  return provinceNameById.get([...hits[0].provinces][0]) ?? null;
}

export async function fillAreaFromRep(rows, { user }) {
  if (!rows?.length || !user || !rows.some(r => r && !r.area && r.scientificRep)) return null;
  try {
    const [candidates, provinceIndex] = await Promise.all([loadOfficeReps(user), loadProvinceIndex()]);
    const nameById = new Map([...provinceIndex.values()].map(p => [p.id, p.name]));
    let filled = 0;
    for (const r of rows) {
      if (!r || r.area || !r.scientificRep) continue;
      const area = pickAreaFromRep(r.scientificRep, candidates, nameById);
      if (area) { r.area = area; r._areaSource = 'rep'; filled++; }
    }
    return filled;
  } catch (e) {
    console.error('[orders] منطقة من المندوب:', e?.message);
    return null;
  }
}
