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
const WH_ANY_RE = /(?:^|\s)(?:ال)?(?:مذخر|مذاخر|مخزن)(?:\s*[:：\-]\s*|\s+)(\S.*)$/;
const WH_INTRO_ANY_RE = /(?:^|\s)(?:ال)?(?:مذخر|مذاخر|مخزن)\s*[:：]?$/;
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

/** أسماء مذاخر من ذيل «مذاخر اوزون/شغف، الدواء المتكامل». */
function warehousesFromTail(tail) {
  return tidy(tail).split(/\s*[\/،,|+]\s*|\s+و\s*(?=\S)/).map(cleanWarehouseName).filter(Boolean);
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
    if (list.length) return { list, transit };
  }
  if ((m = t.match(WH_ABBR_RE))) {
    const list = warehousesFromTail(m[1]);
    if (list.length) return { list, transit };
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
  const out = { pharmacy: null, area: null, sure: false, warehouses: [], extra: [] };
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
    if (wh) { out.warehouses.push(wh); used.add(i); return; }
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
  const items = [];
  const unparsed = [];
  const notes = [];
  const headerLines = [];
  let inWhList = false;
  let seenItem = false;
  let transit = false;

  for (const line of lines) {
    const wl = parseWarehouseLine(line);
    if (wl) {
      if (wl.transit) transit = true;
      if (wl.intro) { inWhList = true; continue; }
      wl.list.forEach(addWh);
      inWhList = true;
      continue;
    }
    // قائمة المذاخر: سطر عربي قصير بلا أرقام بعد «عن طريق مذاخر»
    if (inWhList && !HAS_LATIN.test(line) && !HAS_DIGIT.test(line) && line.split(/\s+/).length <= 4) {
      warehousesFromTail(line).forEach(w => addWh(wholeWarehouse(w) || w));
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
    if (whs && (seenItem || headerLines.length)) { whs.forEach(addWh); continue; }
    // الترويسة: كل الأسطر العربية القصيرة قبل أول صنف (حتى 3)
    if (!seenItem && headerLines.length < 3 && line.split(/\s+/).length <= 8) { headerLines.push(line); continue; }
    if (/ترانزيت|ترانسيت/.test(line)) transit = true;
    notes.push(line);
  }

  const h = classifyHeader(headerLines, { areaOf, isKnownPharmacy, wholeWarehouse });
  h.warehouses.forEach(addWh);
  notes.unshift(...h.extra);
  if (transit && !notes.some(n => /ترانزيت|ترانسيت/.test(n))) notes.unshift('ترانزيت');

  const needsAi = !h.pharmacy || unparsed.length > 0 || items.length === 0;
  const cleanText = lines.join('\n');
  return { pharmacy: h.pharmacy, area: h.area, headerSure: h.sure, warehouses, items, unparsed, notes, mentions, needsAi, cleanText };
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
