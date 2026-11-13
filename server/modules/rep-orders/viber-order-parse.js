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
const WH_INTRO_ONLY_RE = /^(?:(?:عن\s+طريق|من|عبر|على)\s+)?(?:ال)?(?:مذخر|مذاخر|مخزن)\s*[:：]?$/;
// «عن طريق مذخر طريق السلام»، «مذاخر اوزون/شغف».
const WH_INLINE_RE = /^(?:(?:عن\s+طريق|من|عبر|على)\s+)?(?:ال)?(?:مذخر|مذاخر|مخزن)(?:\s*[:：\-]\s*|\s+)(\S.*)$/;

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
  return tidy(tail).split(/\s*[\/،,|]\s*|\s+و\s*(?=\S)/).map(cleanWarehouseName).filter(Boolean);
}

/**
 * يفصل سطر الترويسة «حي الجامعة/ص.دوائكم الراقي» أو «ماجد حميد - شارع فلسطين».
 * @returns {{ pharmacy:string|null, area:string|null, sure:boolean }}
 */
export function splitHeaderLine(line, areaOf = () => null) {
  const parts = tidy(line).split(/\s*[\/|]\s*|\s+[-–]\s+/).map(tidy).filter(Boolean);
  if (!parts.length) return { pharmacy: null, area: null, sure: false };
  const areaName = (p) => { const m = p.match(AREA_PREFIX_RE); return m ? tidy(m[1]) : p; };

  const phIdx = parts.findIndex(p => PH_PREFIX_STRICT_RE.test(p) || (parts.length > 1 && /^ص\s*\./.test(p)));
  if (phIdx >= 0) {
    const pharmacy = tidy(parts[phIdx].match(PH_PREFIX_RE)[1]);
    const rest = parts.filter((_, i) => i !== phIdx);
    const raw = rest.length ? areaName(rest[0]) : null;
    return { pharmacy, area: raw ? (areaOf(raw) || raw) : null, sure: true };
  }
  if (parts.length === 1) {
    const p = parts[0];
    // «حي الجامعة» وحده سطر منطقة لا صيدلية
    if (AREA_PREFIX_RE.test(p)) return { pharmacy: null, area: areaOf(areaName(p)) || areaName(p), sure: false };
    return { pharmacy: p, area: null, sure: true };
  }
  // بلا «ص»: الجزء الذي هو منطقة مسجّلة (أو يبدأ بـ«حي») هو المنطقة، والآخر الصيدلية
  const areaIdx = parts.findIndex(p => AREA_PREFIX_RE.test(p) || areaOf(areaName(p)));
  if (areaIdx >= 0) {
    const raw = areaName(parts[areaIdx]);
    const pharmacy = parts.find((_, i) => i !== areaIdx) ?? null;
    return { pharmacy, area: areaOf(raw) || raw, sure: Boolean(pharmacy) };
  }
  // «ماجد حميد - شارع فلسطين»: الشكل الغالب صيدلية ثم مكانها — يراجعه المستخدم في الجدول
  return { pharmacy: parts[0], area: parts.slice(1).join(' - '), sure: false };
}

/**
 * @param {string} text  رسالة واحدة (طلبية واحدة)
 * @param {{ areaOf?: (s:string)=>string|null, isKnownWarehouse?: (s:string)=>boolean }} [opts]
 * @returns {{
 *   pharmacy:string|null, area:string|null, headerSure:boolean,
 *   warehouses:string[], items:{name:string,quantity:number,bonus:number}[],
 *   unparsed:string[], notes:string[], mentions:string[], needsAi:boolean, cleanText:string
 * }}
 */
export function parseViberOrder(text, { areaOf = () => null, isKnownWarehouse = () => false } = {}) {
  const raw = toLatinDigits(text).split(/\r?\n/).map(tidy).filter(Boolean);
  const mentions = [];
  const lines = [];
  for (const l of raw) {
    if (MENTION_RE.test(l)) { mentions.push(tidy(l.replace(/@/g, ''))); continue; }
    if (TIME_RE.test(l) || DAY_RE.test(l)) continue;
    lines.push(l);
  }

  const wholeWarehouse = (t) => findKnownWarehouse(t, { whole: true }) || (isKnownWarehouse(t) ? t : null);
  const warehouses = [];
  const addWh = (w) => { if (w && !warehouses.some(x => normKey(x) === normKey(w))) warehouses.push(w); };
  const items = [];
  const unparsed = [];
  const notes = [];
  const headerLines = [];
  let inWhList = false;
  let seenItem = false;

  for (const line of lines) {
    let m;
    if (!HAS_LATIN.test(line) && WH_INTRO_ONLY_RE.test(line)) { inWhList = true; continue; }
    if (!HAS_LATIN.test(line) && (m = line.match(WH_INLINE_RE))) {
      warehousesFromTail(m[1]).forEach(addWh);
      inWhList = true;
      continue;
    }
    // قائمة المذاخر: سطر عربي قصير بلا أرقام بعد «عن طريق مذاخر»
    if (inWhList && !HAS_LATIN.test(line) && !HAS_DIGIT.test(line) && line.split(/\s+/).length <= 4) {
      addWh(wholeWarehouse(line) || cleanWarehouseName(line));
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
      if (arabicWords >= 3) { notes.push(line); continue; }
      seenItem = true;
      unparsed.push(line);
      continue;
    }

    if (!seenItem && !headerLines.length) { headerLines.push(line); continue; }
    const wh = wholeWarehouse(line);
    if (wh) { addWh(wh); continue; }
    if (!seenItem && headerLines.length === 1 && line.split(/\s+/).length <= 5) { headerLines.push(line); continue; }
    notes.push(line);
  }

  // الترويسة: سطر واحد «منطقة/ص.صيدلية»، أو سطران (منطقة ثم صيدلية أو العكس)
  let pharmacy = null, area = null, headerSure = false;
  if (headerLines.length === 1) {
    ({ pharmacy, area, sure: headerSure } = splitHeaderLine(headerLines[0], areaOf));
  } else if (headerLines.length === 2) {
    const a = splitHeaderLine(headerLines[0], areaOf);
    const b = splitHeaderLine(headerLines[1], areaOf);
    const aIsPh = PH_PREFIX_STRICT_RE.test(headerLines[0]);
    const bIsPh = PH_PREFIX_STRICT_RE.test(headerLines[1]);
    if (bIsPh && !aIsPh) { pharmacy = b.pharmacy; area = b.area || a.area || a.pharmacy; headerSure = true; }
    else if (aIsPh && !bIsPh) { pharmacy = a.pharmacy; area = a.area || b.area || b.pharmacy; headerSure = true; }
    else { pharmacy = a.pharmacy; area = a.area || b.area || b.pharmacy; headerSure = false; }
  }
  // سطر المنطقة الذي هو في الحقيقة اسم مذخر معروف
  if (area && wholeWarehouse(area)) { addWh(wholeWarehouse(area)); area = null; }

  const needsAi = !pharmacy || unparsed.length > 0 || items.length === 0;
  const cleanText = lines.join('\n');
  return { pharmacy, area, headerSure, warehouses, items, unparsed, notes, mentions, needsAi, cleanText };
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
      && !WH_INTRO_ONLY_RE.test(t) && !WH_INLINE_RE.test(t) && !MENTION_RE.test(t) && !findKnownWarehouse(t, { whole: true });
    if (curHasItem && looksHeader && (prevBlank || PH_PREFIX_STRICT_RE.test(t) || /\//.test(t))) {
      blocks.push(cur.join('\n'));
      cur = []; curHasItem = false;
    }
    cur.push(l);
    if (HAS_LATIN.test(t) && !MENTION_RE.test(t)) curHasItem = true;
    prevBlank = false;
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.map(b => b.trim()).filter(Boolean);
}
