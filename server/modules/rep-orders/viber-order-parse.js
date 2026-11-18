// ════════════════════════════════════════════════════════════════════════════
// viber-order-parse.js — قراءة حتمية لطلبية منسوخة من كروب الفايبر (نقي: بلا DB
// وبلا ذكاء). اختباره: npm run test:viber-order
//
// شكل كروب «مبيعات فارما…» (2026-11-13) يختلف عن كروبات البوت:
//     حي الجامعة/ص.دوائكم الراقي      ← منطقة / «ص.» صيدلية في سطر واحد بلا مسافة
//     Potafast 10(+1)                  ← الكمية ثم البونص بين قوسين بعلامة +
//     Amoklavin 625mg *20(+2)          ← «*» قبل الكمية
//     Pantactive 40mg*5(+1) test order ← ملاحظة بعد الكمية
//     عن طريق مذاخر                    ← ثم مذخر في كل سطر: الأول أساسي والباقي احتياط
//     اوزون / شغف / الدواء المتكامل
//     @Ahmed Sajad  @عمر ليدر الكرخ     ← منشنات: تلميح لا أصناف
// محلّل البوت (order-text-parse.js) يقرأ مذخراً واحداً ويعدّ المنشن اللاتيني صنفاً،
// فلم يُوسَّع هو (مستعمل في كل الكروبات ومختبَر) — بل يُعاد استعمال أدواته هنا.
//
// ما لا يحسمه الشكل يُعاد null/needsAi ويقرّره الذكاء في rep-orders.import.js.
// ════════════════════════════════════════════════════════════════════════════

import { parseItemLine, findKnownWarehouse, cleanWarehouseName, normKey } from '../orders/order-text-parse.js';

const toLatinDigits = (s) => String(s ?? '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));

const tidy = (s) => String(s ?? '')
  .replace(/[‎‏‪-‮⁦-⁩]/g, '') // علامات الاتجاه التي يلصقها الفايبر
  .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, '') // 🟢 وأخواتها قبل اسم المذخر
  .replace(/ـ/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^[.,،;:\-–/|]+/, '')
  .replace(/[.,،;:\-–/|]+$/, '')
  .trim();

const HAS_LATIN = /[a-z]/i;
const HAS_DIGIT = /\d/;
const HAS_ARABIC = /[؀-ۿ]/;

// ─── أسطر تُهمَل ─────────────────────────────────────────────────────────────
const MENTION_RE = /^@|@$/;
const TIME_RE = /^\d{1,2}:\d{2}(?:\s*(?:am|pm|ص|م))?$/i;
const DAY_RE = /^(?:yesterday|today|أمس|امس|اليوم|البارحة)$/i;

// ─── المذخر ──────────────────────────────────────────────────────────────────
// «عن طريق مذاخر» / «مذخر:» وحدها ← ما بعدها قائمة مذاخر سطراً سطراً.
// «عن طريق مذخر طريق السلام»، «مذاخر اوزون/شغف».
// بأي كلمة قبلها: «ترانزيت مذخر الضامن»، «تجهز من مذخر اسبرين» («بالمذخر» داخل جملة لا يُعدّ)
// «مدخر» بالدال خطأ إملائي شائع في الكروب (2026-11-14: «مدخر الفصول الاربعة او مذخر منارة»)
const WH_ANY_RE = /(?:^|\s)(?:ال)?(?:مذخر|مذاخر|مدخر|مداخر|مخزن)(?:\s*[:：\-]\s*|\s+)(\S.*)$/;
const WH_INTRO_ANY_RE = /(?:^|\s)(?:ال)?(?:مذخر|مذاخر|مدخر|مداخر|مخزن)\s*[:：]?$/;
// «م. صلالة، ناقوس» — «م.» اختصار مذخر (بنقطة أو : أو / حصراً كي لا يُقصّ اسم يبدأ بميم)
const WH_ABBR_RE = /^م\s*[.:\/]\s*(\S.*)$/;

// ─── الصيدلية ────────────────────────────────────────────────────────────────
const PH_PREFIX_RE = /^(?:الصيدلي[ةه]|صيدلي[ةه]|ص)\s*[.:\-]?\s*(\S.*)$/;
const PH_PREFIX_STRICT_RE = /^(?:الصيدلي[ةه]|صيدلي[ةه]|ص)(?:\s*[.:\-]\s*|\s+)(\S.*)$/;
// «حي الجامعة» ← «الجامعة» (اسم المنطقة كما في السوبر أدمن)
const AREA_PREFIX_RE = /^(?:حي|منطق[ةه]|منطقه)\s+(\S.*)$/;

/**
 * سطر صنف بأشكال الفايبر. يجرّب أشكال محلّل البوت أولاً ثم أشكال هذا الكروب.
 * @returns {{ name:string, quantity:number, bonus:number, note:string|null } | null}
 */
export function parseViberItemLine(line) {
  const s = tidy(toLatinDigits(line));
  if (!s || !HAS_LATIN.test(s)) return null;
  const clean = (n) => tidy(String(n).replace(/[*×]\s*$/, ''));
  let m;

  // «Potafast 10(+1)»، «Amoklavin 625mg *20(+2)»، «Pantactive 40mg*5(+1) test order»
  if ((m = s.match(/^(.*?)\s*[*×]?\s*(\d+)\s*\(\s*\+\s*(\d+)\s*\)\s*(.*)$/))) {
    const name = clean(m[1]);
    if (HAS_LATIN.test(name)) return { name, quantity: Number(m[2]), bonus: Number(m[3]), note: tidy(m[4]) || null };
  }

  const base = parseItemLine(s);
  if (base) return { name: clean(base.name), quantity: base.quantity, bonus: base.bonus ?? 0, note: null };

  // «Pantactive 40mg 10+3 كاش» — ك+ب ثم ملاحظة
  if ((m = s.match(/^(.*?[a-z].*?)\s+[*×]?\s*(\d+)\s*\+\s*(\d+)\s+(\D.*)$/i))) {
    return { name: clean(m[1]), quantity: Number(m[2]), bonus: Number(m[3]), note: tidy(m[4]) || null };
  }
  // «Amoklavin 625mg *20» — النجمة تحسم أن الرقم كمية
  if ((m = s.match(/^(.*?[a-z].*?)\s*[*×]\s*(\d+)\s*(.*)$/i))) {
    return { name: clean(m[1]), quantity: Number(m[2]), bonus: 0, note: tidy(m[3]) || null };
  }
  // «Pantactive 20mg 10» — رقم مجرّد بعد تركيز مكتوب في الاسم = كمية.
  // بلا تركيز سابق («Devit 50») الرقم قد يكون التركيز نفسه ← يُترك للذكاء.
  if ((m = s.match(/^(.*?[a-z].*?\d.*?)\s+(\d+)$/i)) && /\d\s*(?:mg|mcg|g|ml|iu|%)\b/i.test(m[1])) {
    return { name: clean(m[1]), quantity: Number(m[2]), bonus: 0, note: null };
  }
  return null;
}

// ─── ملاحظات لاتينية لا أصناف ────────────────────────────────────────────────
// «Reorder» / «Test order» سطراً وحده = وصف للطلبية (2026-11-18: كانت تصير صنفاً بكمية فارغة)
const LATIN_NOTE_RE = /^(?:re[\s-]?order|test(?:\s*order)?|new\s*order|first\s*order|repeat(?:\s*order)?|order|urgent|cash|credit|sample|samples|bonus|offer|ok|done|note|notes|pending|returned?)$/i;
export const isLatinNoteLine = (line) => {
  const s = tidy(line).replace(/[!.?]+$/, '').trim();
  return Boolean(s) && !HAS_DIGIT.test(s) && LATIN_NOTE_RE.test(s);
};

// ─── طلبية مكتوبة جملةً ──────────────────────────────────────────────────────
// «تم سحب amoklavine 1g 30 قطعة عن طريق مذخر ادوية ارض البنفسج»
// «تم بيع Amoklavin 1g 10 قطع ل صيدلية سر الدواء من مذخر مصدر الدواء»
// «10 قطع ل صيدليه سر الدواء من مذخر مصدر الدواء» (اسم الصنف في السطر الذي قبله)
const VERB_RE = /(?:^|\s)(?:تم\s+|راح\s+)?(?:سحب|بيع|تسليم|تجهيز|صرف|توزيع|بعت|سحبت|بعنا|سحبنا)(?=\s|$)/g;
const VERB_ONLY_RE = /^(?:تم|راح)?\s*(?:سحب|بيع|تسليم|تجهيز|صرف|توزيع|بعت|سحبت|بعنا|سحبنا)(?:\s+(?:ل|لل|من|الى|إلى))?$/;
const UNIT = '(?:قطع[ةه]?|علب[ةه]?|علب|باكيت|باكيتات|كارتون|حب[ةه]|شريط|pcs?|box(?:es)?)';
const UNIT_QTY_RE = new RegExp(`(\\d+)\\s*${UNIT}(?=\\s|$|[.,،)])`, 'i');
const UNIT_WORD_RE = new RegExp(`(?:^|\\s)${UNIT}(?=\\s|$)`, 'gi');
// «ل صيدلية X»، «لصيدلية X»، «الى صيدلية X» — الحرف قبل «صيدلية» هو ما يفرّقها عن ترويسة «صيدلية الرتاج»
const PH_MARK_RE = /(?:^|\s)(?:(?:ل|لـ)\s*|(?:الى|إلى|الي)\s+)(?:ال)?صيدلي[ةه]\s+/;
const PH_MARK_ANY_RE = /(?:^|\s)(?:(?:ل|لـ)\s*|(?:الى|إلى|الي)\s+)?(?:ال)?صيدلي[ةه]\s+/;
const WH_MARK_RE = /(?:^|\s)(?:(?:من|عن\s+طريق|عبر|بواسطة|من\s+قبل)\s+)?(?:ال)?(?:مذخر|مذاخر|مدخر|مداخر|مخزن)\s+/;
const BONUS_RE = /(?:\(\s*\+\s*(\d+)\s*\)|\+\s*(\d+)|بونص\s*(\d+))/;
const CONC_RE = /\d\s*(?:mg|mcg|g|gm|ml|iu|%)\b/i;

/**
 * سطر طلبية مكتوب جملةً عربية فيها الصنف والكمية والصيدلية والمذخر.
 * @returns {{ item: {name,quantity,bonus}|null, qty: number|null, bonus: number, pharmacy: string|null, warehouses: string[], note: string|null } | null}
 *   item = صنف كامل؛ qty بلا item = كمية لاسم صنف في السطر السابق. null = ليس هذا الشكل.
 */
export function parseSentenceLine(line) {
  const s = tidy(toLatinDigits(line));
  if (!s) return null;
  const latin = HAS_LATIN.test(s);
  const hasVerb = new RegExp(VERB_RE.source).test(s);
  const unitQty = s.match(UNIT_QTY_RE);
  const phAt = s.search(latin ? PH_MARK_ANY_RE : PH_MARK_RE);
  const whAt = s.search(WH_MARK_RE);
  // بلا لاتيني: سطر بكمية ووحدة («10 قطع …»)، أو «لصيدلية X» مع مذخر/فعل — لا ترويسة عادية
  if (!latin && !unitQty && !(phAt >= 0 && (whAt >= 0 || hasVerb))) return null;
  if (latin && !hasVerb && !unitQty && phAt < 0 && whAt < 0) return null;

  // تقطيع على العلامات: [قبلها = الصنف] [صيدلية …] [مذخر …] بأي ترتيب
  const marks = [['ph', phAt], ['wh', whAt]].filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  const head = tidy(s.slice(0, marks.length ? marks[0][1] : s.length));
  let pharmacy = null;
  const warehouses = [];
  const whRaw = [];
  marks.forEach(([kind, at], i) => {
    const seg = s.slice(at, i + 1 < marks.length ? marks[i + 1][1] : s.length);
    if (kind === 'ph') pharmacy = tidy(seg.replace(PH_MARK_ANY_RE, ' ').replace(VERB_RE, ' ').replace(UNIT_WORD_RE, ' ')) || null;
    else { warehouses.push(...warehousesFromTail(seg.replace(WH_MARK_RE, ' '))); whRaw.push(...splitWhTail(seg.replace(WH_MARK_RE, ' '))); }
  });

  let rest = head.replace(VERB_RE, ' ');
  let bonus = 0;
  const b = rest.match(BONUS_RE);
  if (b) { bonus = Number(b[1] ?? b[2] ?? b[3]) || 0; rest = rest.replace(BONUS_RE, ' '); }
  let qty = null;
  const uq = rest.match(UNIT_QTY_RE);
  if (uq) { qty = Number(uq[1]); rest = rest.replace(UNIT_QTY_RE, ' '); }
  rest = rest.replace(UNIT_WORD_RE, ' ');
  // ما بقي: كلمات الصنف (لاتيني/أرقام) والباقي العربي ملاحظة
  const toks = tidy(rest).split(/\s+/).filter(Boolean);
  const itemToks = toks.filter(t => !HAS_ARABIC.test(t));
  const noteToks = toks.filter(t => HAS_ARABIC.test(t));
  if (qty == null && itemToks.length) {
    const last = itemToks[itemToks.length - 1];
    const first = itemToks[0];
    // «amoklavine 1g 30» — رقم مجرّد بعد تركيز مكتوب؛ «30 amoklavine 1g» — رقم قبل الاسم
    if (/^\d+$/.test(last) && itemToks.length > 1 && CONC_RE.test(itemToks.slice(0, -1).join(' '))) { qty = Number(last); itemToks.pop(); }
    else if (/^\d+$/.test(first) && itemToks.length > 1) { qty = Number(first); itemToks.shift(); }
  }
  const name = tidy(itemToks.join(' ').replace(/[*×]\s*$/, ''));
  const note = tidy(noteToks.join(' ')) || null;
  if (latin && HAS_LATIN.test(name) && qty > 0) return { item: { name, quantity: qty, bonus }, qty: null, bonus, pharmacy, warehouses, whRaw, note };
  if (!latin && qty > 0) return { item: null, qty, bonus, pharmacy, warehouses, whRaw, note };
  if (!latin && pharmacy) return { item: null, qty: null, bonus, pharmacy, warehouses, whRaw, note };
  return null;
}

/** أسماء المذاخر من ذيل «مذاخر اوزون/شغف، الدواء المتكامل» **كما كُتبت** (بلا مطابقة بالقائمة المعروفة). */
export function splitWhTail(tail) {
  // «X او مذخر Y» / «X أو Y» = مذخر بديل: الأول أساسي والباقي احتياط
  return tidy(tail)
    .split(/\s*[\/،,|+]\s*|\s+(?:او|أو|ولا|والا|وإلا)\s+|\s+و\s*(?=\S)/)
    .map(p => tidy(p).replace(/^(?:من\s+)?(?:ال)?(?:مذخر|مذاخر|مدخر|مداخر|مخزن)\s*[:：]?\s*/, ''))
    .map(p => tidy(p).split(/\s+/).slice(0, 4).join(' '))
    .filter(Boolean);
}

/** نفس الأسماء مطبَّعة على القائمة المعروفة (لمطابقة دليل المذاخر في وضع «مذاخر»). */
function warehousesFromTail(tail) {
  return splitWhTail(tail).map(cleanWarehouseName).filter(Boolean);
}

/**
 * سطر مذخر بكل أشكاله المكتوبة في الكروب:
 *   «مذخر طريق السلام»، «عن طريق مذخر الناقوس»، «ترانزيت مذخر الضامن»، «تجهز من مذخر اسبرين»،
 *   «المذخر: اوزون»، «م. صلالة، ناقوس» (م. = مذخر)، و«عن طريق مذاخر» وحدها (القائمة في الأسطر التالية).
 * الكلمة قبل «مذخر» لا تُشترط (كانت «ترانزيت» تُسقط السطر كله). «بالمذخر» داخل جملة لا يُعدّ.
 * @returns {{ intro?: true, list?: string[], transit?: boolean } | null}
 */
export function parseWarehouseLine(line) {
  const t = tidy(line);
  if (!t || HAS_LATIN.test(t)) return null;
  const transit = /ترانزيت|ترانسيت/.test(t);
  let m;
  if (WH_INTRO_ANY_RE.test(t)) return { intro: true, transit };
  if ((m = t.match(WH_ANY_RE))) {
    const list = warehousesFromTail(m[1]);
    if (list.length) return { list, raw: splitWhTail(m[1]), transit };
  }
  if ((m = t.match(WH_ABBR_RE))) {
    const list = warehousesFromTail(m[1]);
    if (list.length) return { list, raw: splitWhTail(m[1]), transit };
  }
  return null;
}

/** «ص» أو «صيدلية» وحدها بين فاصلين: «ص / هدير حمادي سلوم / يوسفية» ← الجزء التالي هو الصيدلية. */
const PH_WORD_ONLY_RE = /^(?:ال)?(?:صيدلي[ةه]|ص)$/;

/**
 * يصنّف أجزاء الترويسة (سطر أو أكثر قبل أول صنف، مقسّمة على / | -) إلى صيدلية ومنطقة
 * ومذخر بالأدلة بالترتيب:
 *   1. بادئة «ص» / «صيدلية» (ملتصقة بالاسم أو وحدها قبل الاسم)
 *   2. قوائم معروفة: المناطق المسجّلة (وأسماؤها المدموجة)، المذاخر (الثابتة + دليل الحساب)،
 *      وأسماء صيدليات طلبيات سابقة — «تعليم» المحلّل من بيانات المكتب نفسه
 *   3. «حي X» / «منطقة X» = منطقة
 *   4. ما بقي: أوله الصيدلية ثم المنطقة (الشكل الغالب «صيدلية - مكانها»)
 * @returns {{ pharmacy:string|null, area:string|null, sure:boolean, warehouses:string[], extra:string[] }}
 */
export function classifyHeader(lines, { areaOf = () => null, isKnownPharmacy = () => false, wholeWarehouse = () => null } = {}) {
  const parts = lines.flatMap(l => tidy(l).split(/\s*[\/|\\]\s*|\s+[-–]\s+|\s*،\s*/)).map(tidy).filter(Boolean);
  const used = new Set();
  const out = { pharmacy: null, area: null, sure: false, warehouses: [], warehousesRaw: [], extra: [] };
  const areaName = (p) => { const m = p.match(AREA_PREFIX_RE); return m ? tidy(m[1]) : p; };

  // 1. بادئة الصيدلية
  for (let i = 0; i < parts.length && out.pharmacy == null; i++) {
    const p = parts[i];
    if (PH_WORD_ONLY_RE.test(p) && parts[i + 1]) {
      used.add(i); used.add(i + 1);
      out.pharmacy = tidy(parts[i + 1].replace(PH_PREFIX_RE, '$1')); out.sure = true;
    } else if (PH_PREFIX_STRICT_RE.test(p) || (parts.length > 1 && /^ص\s*\./.test(p))) {
      used.add(i);
      out.pharmacy = tidy(p.match(PH_PREFIX_RE)[1]); out.sure = true;
    } else if (PH_WORD_ONLY_RE.test(p)) {
      used.add(i);
    }
  }
  // 2-3. القوائم المعروفة
  let areaKnown = false;
  parts.forEach((p, i) => {
    if (used.has(i)) return;
    const wh = wholeWarehouse(p);
    if (wh) { out.warehouses.push(wh); out.warehousesRaw.push(p); used.add(i); return; }
    const canon = areaOf(areaName(p));
    if (out.area == null && (canon || AREA_PREFIX_RE.test(p))) {
      out.area = canon || areaName(p); areaKnown = Boolean(canon); used.add(i); return;
    }
    if (out.pharmacy == null && isKnownPharmacy(p)) { out.pharmacy = p; out.sure = true; used.add(i); }
  });
  // 4. الباقي بالموضع
  const left = parts.filter((_, i) => !used.has(i));
  for (const p of left) {
    if (out.pharmacy == null) {
      out.pharmacy = p;
      // صيدلية بلا بادئة تُحسم إن كانت الوحيدة بجانب منطقة معروفة، أو الجزء الوحيد أصلاً
      out.sure = (areaKnown && left.length === 1) || parts.length === 1;
    } else if (out.area == null) {
      out.area = areaOf(areaName(p)) || areaName(p);
    } else out.extra.push(p);
  }
  return out;
}

/** للتوافق مع الاختبارات والمستدعين القدامى: سطر ترويسة واحد. */
export function splitHeaderLine(line, areaOf = () => null) {
  const r = classifyHeader([line], { areaOf });
  return { pharmacy: r.pharmacy, area: r.area, sure: r.sure };
}

/**
 * @param {string} text  رسالة واحدة (طلبية واحدة)
 * @param {{ areaOf?: (s:string)=>string|null, isKnownWarehouse?: (s:string)=>boolean, isKnownPharmacy?: (s:string)=>boolean }} [opts]
 * @returns {{
 *   pharmacy:string|null, area:string|null, headerSure:boolean,
 *   warehouses:string[], items:{name:string,quantity:number,bonus:number}[],
 *   unparsed:string[], notes:string[], mentions:string[], needsAi:boolean, cleanText:string
 * }}
 */
export function parseViberOrder(text, { areaOf = () => null, isKnownWarehouse = () => false, isKnownPharmacy = () => false } = {}) {
  const raw = toLatinDigits(text).split(/\r?\n/).map(tidy).filter(Boolean);
  const mentions = [];
  const lines = [];
  for (const l of raw) {
    if (MENTION_RE.test(l)) { mentions.push(tidy(l.replace(/@/g, ''))); continue; }
    if (TIME_RE.test(l) || DAY_RE.test(l)) continue;
    lines.push(l);
  }

  const wholeWarehouse = (t) => findKnownWarehouse(t, { whole: true }) || (isKnownWarehouse(t) ? t : null);
  // سطر أسماء مذاخر معروفة كلها بلا كلمة «مذخر»: «سنايا، اسبرين»
  const knownWarehouseList = (t) => {
    const ps = tidy(t).split(/\s*[\/،,|]\s*/).map(tidy).filter(Boolean);
    const ws = ps.map(wholeWarehouse);
    return ps.length && ws.every(Boolean) ? ws : null;
  };
  const warehouses = [];
  const addWh = (w) => { if (w && !warehouses.some(x => normKey(x) === normKey(w))) warehouses.push(w); };
  // المذاخر كما كُتبت في الرسالة (وضع «لكوديشن» يحفظها هكذا؛ المطابقة بالدليل لوضع «مذاخر»)
  const written = [];
  const addWritten = (w) => { const t = tidy(w); if (t && !written.some(x => normKey(x) === normKey(t))) written.push(t); };
  const items = [];
  const unparsed = [];
  const notes = [];
  const headerLines = [];
  let inWhList = false;
  let seenItem = false;
  let transit = false;
  let sentencePharmacy = null;
  /** سطر جملة: الصنف والكمية والصيدلية والمذخر منه. كمية بلا اسم تُكمل آخر سطر صنف بلا كمية. */
  const applySentence = (sen) => {
    if (sen.item) { items.push(sen.item); seenItem = true; }
    else if (sen.qty) {
      if (unparsed.length) { items.push({ name: unparsed.pop(), quantity: sen.qty, bonus: sen.bonus }); seenItem = true; }
      else notes.push(`${sen.qty}${sen.bonus ? `+${sen.bonus}` : ''}`);
    }
    sen.warehouses.forEach(w => addWh(wholeWarehouse(w) || w));
    (sen.whRaw || []).forEach(addWritten);
    if (sen.pharmacy && !sentencePharmacy) sentencePharmacy = sen.pharmacy;
    if (sen.note) notes.push(sen.note);
  };

  for (const line of lines) {
    // «تم سحب» / «تم بيع» وحدها: وصف لا ترويسة (كانت تصير اسم صيدلية حين تسبق الاسم)
    if (VERB_ONLY_RE.test(line)) { notes.push(line); continue; }
    if (isLatinNoteLine(line)) { notes.push(line); continue; }
    if (!HAS_LATIN.test(line)) {
      const sen = parseSentenceLine(line);
      if (sen) { applySentence(sen); inWhList = false; continue; }
    }
    const wl = parseWarehouseLine(line);
    if (wl) {
      if (wl.transit) transit = true;
      if (wl.intro) { inWhList = true; continue; }
      wl.list.forEach(addWh);
      (wl.raw || []).forEach(addWritten);
      inWhList = true;
      continue;
    }
    // قائمة المذاخر: سطر عربي قصير بلا أرقام بعد «عن طريق مذاخر»
    if (inWhList && !HAS_LATIN.test(line) && !HAS_DIGIT.test(line) && line.split(/\s+/).length <= 4) {
      warehousesFromTail(line).forEach(w => addWh(wholeWarehouse(w) || w));
      splitWhTail(line).forEach(addWritten);
      continue;
    }
    inWhList = false;

    if (HAS_LATIN.test(line) || (HAS_DIGIT.test(line) && seenItem)) {
      const it = parseViberItemLine(line);
      if (it) {
        seenItem = true;
        items.push({ name: it.name, quantity: it.quantity, bonus: it.bonus });
        if (it.note) notes.push(it.note);
        continue;
      }
      // «تم سحب amoklavine 1g 30 قطعة عن طريق مذخر …» — جملة فيها الصنف والكمية
      const sen = parseSentenceLine(line);
      if (sen) { applySentence(sen); continue; }
      // «+class A لوصفات الدكتور اكرم…»: جملة عربية فيها كلمة لاتينية = ملاحظة لا صنف
      const arabicWords = (line.match(/[؀-ۿ]{2,}/g) || []).length;
      // «د.قاسم محمد | Cardio»: اسم طبيب واختصاصه، أو أي سطر عربي-لاتيني بلا رقم = ملاحظة كذلك
      if (arabicWords >= 3 || /^(?:د|دكتور|الدكتور)\s*[.:]?\s*\S/.test(line) || (!HAS_DIGIT.test(line) && arabicWords >= 1)) {
        notes.push(line); continue;
      }
      seenItem = true;
      unparsed.push(line);
      continue;
    }

    const whs = knownWarehouseList(line);
    if (whs && (seenItem || headerLines.length)) { whs.forEach(addWh); tidy(line).split(/\s*[\/،,|]\s*/).map(tidy).filter(Boolean).forEach(addWritten); continue; }
    // الترويسة: كل الأسطر العربية القصيرة قبل أول صنف (حتى 3)
    if (!seenItem && headerLines.length < 3 && line.split(/\s+/).length <= 8) { headerLines.push(line); continue; }
    // الطلبية قد تبدأ بالأصناف ثم «صيدلية الرتاج» (2026-11-14): بعد الأصناف يُعدّ السطر ترويسة
    // فقط بدليل صريح — بادئة «ص/صيدلية»، أو منطقة مسجّلة، أو صيدلية من طلبيات سابقة —
    // كي لا تصير ملاحظة («كل قائمة وحد تجهز») اسمَ صيدلية.
    if (seenItem && headerLines.length < 3 && line.split(/\s+/).length <= 8 && (
      PH_PREFIX_STRICT_RE.test(line) || PH_WORD_ONLY_RE.test(line.split(/\s*[\/|\-–]\s*/)[0])
      || line.split(/\s*[\/|\-–]\s*/).some(p => areaOf(tidy(p).replace(AREA_PREFIX_RE, '$1')) || isKnownPharmacy(tidy(p)))
    )) { headerLines.push(line); continue; }
    if (/ترانزيت|ترانسيت/.test(line)) transit = true;
    notes.push(line);
  }

  // «ل صيدلية X» داخل جملة يحسم الصيدلية؛ أسطر الترويسة الباقية تصير منطقة/ملاحظة
  if (sentencePharmacy && !headerLines.some(l => PH_PREFIX_STRICT_RE.test(l))) headerLines.unshift(`ص ${sentencePharmacy}`);
  const h = classifyHeader(headerLines, { areaOf, isKnownPharmacy, wholeWarehouse });
  h.warehouses.forEach(addWh);
  h.warehousesRaw.forEach(addWritten);
  notes.unshift(...h.extra);
  if (transit && !notes.some(n => /ترانزيت|ترانسيت/.test(n))) notes.unshift('ترانزيت');

  const needsAi = !h.pharmacy || unparsed.length > 0 || items.length === 0;
  const cleanText = lines.join('\n');
  return { pharmacy: h.pharmacy, area: h.area, headerSure: h.sure, warehouses, warehousesWritten: written, items, unparsed, notes, mentions, needsAi, cleanText };
}

/**
 * بصمة الطلبية لكشف التكرار (سكرين شوتات متداخلة، لصق مرتين): الصيدلية + الأصناف
 * بكمياتها، مرتّبة ومطبّعة — مستقلّة عن الملاحظات والمذاخر والمسافات.
 */
export function orderFingerprint({ pharmacy, items }) {
  const ph = normKey(pharmacy || '').replace(/\s+/g, '');
  const its = (items || [])
    .map(i => `${normKey(i.name || i.itemName || '').replace(/\s+/g, '')}:${Number(i.quantity) || 0}+${Number(i.bonus ?? i.bonusQty) || 0}`)
    .sort();
  if (!ph && !its.length) return null;
  return `${ph}|${its.join(',')}`;
}

/**
 * يقسّم لصقة فيها أكثر من طلبية: سطر فارغ يتبعه سطر ترويسة (عربي بلا لاتيني)
 * بعد كتلة فيها أصناف يبدأ طلبية جديدة. لصقة رسالة واحدة تبقى كتلة واحدة.
 */
export function splitPasteIntoOrders(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let cur = [];
  let curHasItem = false;
  let prevBlank = false;
  for (const l of lines) {
    const t = tidy(l);
    if (!t) { prevBlank = true; continue; }
    const looksHeader = HAS_ARABIC.test(t) && !HAS_LATIN.test(t) && !HAS_DIGIT.test(t)
      && !parseWarehouseLine(t) && !MENTION_RE.test(t) && !findKnownWarehouse(t, { whole: true });
    if (curHasItem && looksHeader && (prevBlank || PH_PREFIX_STRICT_RE.test(t) || /\//.test(t))) {
      blocks.push(cur.join('\n'));
      cur = []; curHasItem = false;
    }
    cur.push(l);
    if (HAS_LATIN.test(t) && !MENTION_RE.test(t)) curHasItem = true;
    prevBlank = false;
  }
  if (cur.length) blocks.push(cur.join('\n'));
  // كتلة بلا أي صنف («كل قائمة وحد تجهز» / «ترانزيت مذخر الضامن» بعد سطر فارغ) ذيل
  // الطلبية السابقة لا طلبية جديدة — كانت تُفصل فيضيع المذخر والملاحظة.
  const hasItem = (b) => b.split(/\r?\n/).some(l => { const t = tidy(l); return HAS_LATIN.test(t) && !MENTION_RE.test(t); });
  const merged = [];
  for (const b of blocks.map(x => x.trim()).filter(Boolean)) {
    if (merged.length && !hasItem(b)) merged[merged.length - 1] += `\n${b}`;
    else merged.push(b);
  }
  return merged;
}

/**
 * نسخ عدة رسائل من واتساب يُلصق كل رسالة بترويسة «[التاريخ، الوقت] المرسل: نص السطر الأول»:
 *   [11/13, 4:52 PM] اوردين: صيدلية ماجد حميد - شارع فلسطين
 *   PANTACTIVE 20MG 28TAB 10
 *   [11/13, 8:22 PM] اوردين: صيدلية نور عبدالله الزلزلي - المشتل
 * وصيغة التصدير/أندرويد: «11/13/26, 4:52 PM - اوردين: …». كل ترويسة تبدأ رسالة جديدة
 * ومرسلها = اسم المندوب (يُستعمل لتذكّر مندوبه). نص بلا ترويسات ⇒ null (فايبر/رسالة واحدة).
 * @returns {{ sender: string, text: string }[] | null}
 */
const WA_HEAD_RE = /^\s*[\u200e\u200f]*\[(\d{1,4}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?,?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?\s?[Mm]\.?|ص|م)?)\]\s*([^:\n]{1,60}?):\s?(.*)$/;
const WA_EXPORT_RE = /^\s*[\u200e\u200f]*(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{2,4},?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?\s?[Mm]\.?|ص|م)?)\s+-\s+([^:\n]{1,60}?):\s?(.*)$/;

export function splitWhatsAppMessages(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(WA_HEAD_RE) || l.match(WA_EXPORT_RE);
    if (m) {
      if (cur) out.push(cur);
      cur = { sender: tidy(m[2]), lines: [m[3]] };
    } else if (cur) {
      cur.lines.push(l);
    } else if (tidy(l)) {
      // نص قبل أول ترويسة (بقية رسالة لم تُحدَّد) — رسالة بلا مرسل
      cur = { sender: null, lines: [l] };
    }
  }
  if (cur) out.push(cur);
  if (!out.some(x => x.sender)) return null;
  return out
    .map(x => ({ sender: x.sender, text: x.lines.join('\n').trim() }))
    .filter(x => x.text && !/^<(?:Media omitted|تم استبعاد الوسائط)>$/i.test(x.text));
}
