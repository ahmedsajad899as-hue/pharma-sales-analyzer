// ════════════════════════════════════════════════════════════════════════════
// order-text-parse.js — قراءة حتمية لنصّ الطلبية تُصحّح اجتهاد Gemini (نقي: بلا
// DB وبلا ذكاء). اختباره: npm run test:order-text
//
// لماذا؟ طلبيات الكروبات (2026-10-19، كروب «مبيع الكوديشن») تُكتب بترويسة من
// **عدة أسطر** لا بسطر واحد «صيدلية / منطقة» كما افترض البرومبت:
//     الحرية                ← سطر المنطقة (بلا عنوان)
//     ص. العترة             ← سطر الصيدلية (بادئة «ص»)
//     candexil 10 p          ← أسطر الأصناف
//     مذخر الناقوس           ← المذخر (وأحياناً بلا كلمة «مذخر»: «دواء الكندي»)
// فكان الموديل يُسقط المنطقة، أو يدمج سطرين في خانة الصيدلية («الحرية ص. العترة»)،
// أو يُلصق المذخر بالصيدلية («شمس الرواسي دواء الكندي»). والكمية تُكتب بين قوسين
// «pandev 20 (5)» فقرأها الموديل «pandev» بكمية 20 — أي خلط التركيز بالكمية.
//
// القاعدة هنا: ما يقرّره شكل النص بلا لبس (بادئة «ص»، كلمة «مذخر»، «منطقة»،
// كمية بين قوسين) يُقرَّر بالكود ويَغلِب الموديل. ما فيه لبس يُترك للموديل كما كان.
//
// وقاعدة المناطق (السوبر أدمن + أسماؤها المدموجة AreaAlias) دليل حاسم أيضاً: في
// «مدينة الصدر / هيثم عكلة حنو» بلا «ص» السطر الذي هو منطقة مسجّلة هو المنطقة
// والآخر الصيدلية — وتُكتب المنطقة باسمها القانوني («الاورفلي» ← «مدينة الصدر»).
// ════════════════════════════════════════════════════════════════════════════

import { stripTriggerPrefix, hasTriggerWord } from './order-trigger.js';
import { similarity } from '../../lib/fuzzyMatch.js';

// ─── المذاخر المعروفة في بغداد (قائمة صاحب المشروع، 2026-10-19) ─────────────
// الاسم الأول في كل مجموعة هو الاسم القانوني المعروض؛ البقية صيغ مختصرة له.
// تُكمِّلها أسماء دفتر «رصيد المذاخر» من قاعدة البيانات (isKnownWarehouse).
export const KNOWN_WAREHOUSES = [
  ['الناقوس'],
  ['العناية الطبية', 'العناية'],
  ['الفصول الاربعة', 'الفصول'],
  ['طريق السلام'],
  ['طريق اليسر'],
  ['التفاح الاخضر'],
  ['مزايا'],
  ['سنايا'],
  ['اوزون'],
  ['بلاتين'],
  ['مصدر الدواء'],
  ['اسبرين'],
  ['شغف'],
  ['الدواء المتكامل'],
  ['عدن'],
  ['صلالة'],
  ['العربي'],
  ['ارض البنفسج'],
  ['الكندي', 'دواء الكندي'],
];
// تُبنى عند أول استعمال (normKey يعتمد ثوابت مُعرَّفة أسفل الملف).
let warehouseVariants = null;
const getWarehouseVariants = () => (warehouseVariants ??= KNOWN_WAREHOUSES
  .flatMap(([canon, ...alts]) => [canon, ...alts].map(v => ({ canon, words: normKey(v).split(' ') })))
  .sort((a, b) => b.words.length - a.words.length)); // الأطول أولاً: «العناية الطبية» قبل «العناية»

/** هل كلمتان متطابقتان مع سماح بخطأ إملائي بسيط («الناقوص»، «اوزن»)؟ */
const wordEq = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && similarity(a, b) >= 0.8);

/**
 * أول مذخر معروف يرد في النص (الأسبق موضعاً يغلب — «إن ذُكر أكثر من مذخر يُختار
 * أول اسم مكتوب»). يُعيد الاسم القانوني أو null.
 * @param {{ whole?: boolean }} [o] whole: النص كلّه يجب أن يكون اسم المذخر (سطر بلا عنوان)
 */
export function findKnownWarehouse(text, { whole = false } = {}) {
  const words = normKey(text).split(' ').filter(Boolean);
  if (!words.length) return null;
  for (let i = 0; i < words.length; i++) {
    for (const w of getWarehouseVariants()) {
      const n = w.words.length;
      if (whole && (i !== 0 || n !== words.length)) continue;
      if (i + n > words.length) continue;
      if (w.words.every((x, j) => wordEq(words[i + j], x))) return w.canon;
    }
  }
  return null;
}

// كلمات تبدأ بها الملاحظة بعد اسم المذخر: «مذخر الناقوس بسبب عدم الانضمام الى ميركاتو».
const WAREHOUSE_NOTE_RE = /\s+(?:بسبب|لسبب|لعدم|عدم|لان|لأن|لانه|لأنه|كون|حتى|علمود|الى|إلى|ترانزيت|بدل|بدون|حسب|مع|عن طريق)(?:\s|$).*$/;

/**
 * اسم المذخر من ذيل «مذخر …»: المعروف أولاً، وإلا ما قبل أول كلمة ملاحظة وبحدّ ثلاث كلمات.
 */
export function cleanWarehouseName(tail) {
  const t = tidy(tail);
  if (!t) return null;
  const known = findKnownWarehouse(t);
  if (known) return known;
  const cut = tidy(t.replace(WAREHOUSE_NOTE_RE, ''));
  return cut ? cut.split(/\s+/).slice(0, 3).join(' ') : null;
}

const toLatinDigits = (s) => String(s ?? '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));

/** تطبيع خفيف للمقارنة (لا للعرض). */
export function normKey(s) {
  return toLatinDigits(s)
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[ً-ٟـ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(^|\s)ال/g, '$1')
    .trim().toLowerCase();
}

const tidy = (s) => String(s ?? '')
  .replace(/ـ/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^[.,،;:\-–/|]+/, '')
  .replace(/[.,،;:\-–/|]+$/, '')
  .trim();

// «ص» تُعدّ بادئة فقط متبوعةً بفاصل أو مسافة — وإلا قصّت أول «صباح» أو «صيدلية».
const PH_WORD = String.raw`(?:الصيدلي[ةه]|صيدلي[ةه]|ص)`;
const PH_TAIL = String.raw`(?:\s*[.:：\-/]\s*|\s+)`;
const PHARMACY_LINE_RE = new RegExp(String.raw`^${PH_WORD}${PH_TAIL}(\S.*)$`);
// «الحرية ص. العترة»: منطقة ثم «ص» في منتصف السطر.
const EMBEDDED_PHARMACY_RE = new RegExp(String.raw`^(\S.*?)\s+${PH_WORD}${PH_TAIL}(\S.*)$`);
// «مذخر الناقوس»، «من مذخر النور»، «تم التجهيز من مذخر اسبرين»، «المذخر: اوزون».
const WAREHOUSE_LINE_RE = /(?:^|\s)(?:ال)?(?:مذخر|مذاخر|مخزن|مستودع)(?:\s*[:：\-/]\s*|\s+)(\S.*)$/;
const AREA_LINE_RE = /^(?:ال)?منطق[ةه](?:\s*[:：\-/]\s*|\s+)(\S.*)$/;

const HAS_LATIN = /[a-z]/i;
const HAS_DIGIT = /\d/;
// صنف عربي بكمية بالحروف («بانادول علبتين») سطر صنف لا ترويسة.
const UNIT_WORD_RE = /(علب|حبه|حبة|حبتين|شريط|درزن|دزن|قنين|امبول|أمبول|كرتون)/;

/** أطول عدد كلمات لسطر ترويسة بلا عنوان — أطول من هذا جملة/تعليق لا اسم مكان. */
const MAX_HEADER_WORDS = 5;

/**
 * يصنّف أسطر الطلبية. يُعيد { header, itemLines } حيث header يحمل pharmacy/area/warehouse
 * بثقة حتمية، أو null للحقل الذي لا يقرّره الشكل.
 *
 * @param {string} text
 * @param {{ isKnownWarehouse?: (name:string)=>boolean }} [opts]
 */
export function parseOrderText(text, { isKnownWarehouse: isKnownInDb = () => false, areaOf = () => null } = {}) {
  // سطر بلا عنوان هو مذخر إن كان كلّه اسم مذخر معروف (القائمة الثابتة أو دفتر المذاخر).
  const warehouseOf = (t) => findKnownWarehouse(t, { whole: true }) || (isKnownInDb(t) ? t : null);
  const isKnownWarehouse = (t) => warehouseOf(t) != null;
  const lines = toLatinDigits(text).split(/\r?\n/).map(l => tidy(l)).filter(Boolean);
  // «طلبية» وحدها في سطر، أو ملتصقة بأول سطر الزبون.
  if (lines.length && hasTriggerWord(lines[0])) {
    const rest = tidy(stripTriggerPrefix(lines[0]));
    if (rest) lines[0] = rest; else lines.shift();
  }

  const header = { pharmacy: null, area: null, warehouse: null, pharmacyLines: 0 };
  const itemLines = [];
  const loose = []; // { text, idx } أسطر عربية قصيرة بلا عنوان — منطقة أو مذخر
  let pharmacyIdx = -1;
  let firstItemIdx = -1;

  lines.forEach((line, idx) => {
    let m;
    if ((m = line.match(WAREHOUSE_LINE_RE)) && !HAS_LATIN.test(line)) {
      // «تجهز ترانزيت من مذخر الناقوس بسبب عدم الانضمام…» ← «الناقوس» فقط.
      header.warehouse ??= cleanWarehouseName(m[1]);
      return;
    }
    if ((m = line.match(PHARMACY_LINE_RE))) {
      header.pharmacyLines++;
      if (header.pharmacy == null) { header.pharmacy = tidy(m[1]); pharmacyIdx = idx; }
      return;
    }
    if ((m = line.match(AREA_LINE_RE))) {
      header.area ??= tidy(m[1]);
      return;
    }
    if (HAS_LATIN.test(line) || HAS_DIGIT.test(line) || UNIT_WORD_RE.test(line)) {
      if (firstItemIdx < 0) firstItemIdx = idx;
      itemLines.push(line);
      return;
    }
    if ((m = line.match(EMBEDDED_PHARMACY_RE)) && m[1].split(/\s+/).length <= 4) {
      header.pharmacyLines++;
      if (header.pharmacy == null) {
        header.pharmacy = tidy(m[2]);
        header.area ??= tidy(m[1]);
        pharmacyIdx = idx;
      }
      return;
    }
    if (line.split(/\s+/).length <= MAX_HEADER_WORDS) loose.push({ text: line, idx });
  });

  // «ص النور / الكرخ» في سطر واحد: الذيل بعد الفاصل منطقة.
  if (header.pharmacy) {
    const sep = header.pharmacy.match(/^(.*\S)\s*[-/–]\s*(\S.*)$/);
    if (sep && sep[2].split(/\s+/).length <= 4) {
      header.pharmacy = tidy(sep[1]);
      header.area ??= tidy(sep[2]);
    }
  }

  // الأسطر بلا عنوان قبل أول صنف (عدا المذاخر المعروفة).
  const inHeader = (l) => firstItemIdx < 0 || l.idx < firstItemIdx;
  const headerLoose = loose.filter(l => !isKnownWarehouse(l.text) && inHeader(l));

  // بلا سطر «ص»: سطر هو منطقة مسجّلة + سطر واحد غيره ⇒ ذاك الآخر هو الصيدلية.
  // أكثر من سطر غير منطقة = لبس (صيدلية؟ مذخر؟) فيبقى القرار للموديل.
  if (header.pharmacy == null && header.pharmacyLines === 0) {
    const areaLines = headerLoose.filter(l => areaOf(l.text));
    const others = headerLoose.filter(l => !areaOf(l.text));
    if (areaLines.length >= 1 && others.length === 1) {
      header.area ??= areaOf(areaLines[0].text);
      header.pharmacy = others[0].text;
      header.pharmacyLines = 1;
      pharmacyIdx = others[0].idx;
      // السطر صار صيدلية — لا يُعاد عدّه منطقة/مذخراً أدناه.
      loose.splice(loose.indexOf(others[0]), 1);
    }
  }

  // الأسطر بلا عنوان لا تُحسَم إلا بوجود سطر صيدلية مُعلَّم — بدونه لا نعرف أيّها
  // الصيدلية وأيّها المنطقة، فنترك القرار للموديل كما كان.
  if (header.pharmacy && header.pharmacyLines === 1) {
    for (const { text: t } of loose.filter(l => isKnownWarehouse(l.text))) header.warehouse ??= warehouseOf(t);
    // الأسطر بعد أول صنف لا تُعدّ ترويسة (قد تكون صنفاً عربياً بلا كمية أو تعليقاً)
    // — المذخر هناك يُعرف بكلمة «مذخر» أو بقائمة المذاخر المعروفة فقط.
    const rest = loose.filter(l => !isKnownWarehouse(l.text) && inHeader(l) && !(header.area && areaOf(l.text) === header.area));
    // المنطقة: سطر هو منطقة مسجّلة أولاً، ثم سطر قبل سطر الصيدلية (الشكل الغالب)،
    // ثم سطر بعده.
    const known = rest.filter(l => areaOf(l.text));
    const before = rest.filter(l => l.idx < pharmacyIdx && !known.includes(l));
    const after = rest.filter(l => l.idx > pharmacyIdx && !known.includes(l));
    const leftovers = [];
    for (const l of [...known, ...before, ...after]) {
      if (header.area == null) header.area = areaOf(l.text) || l.text;
      else leftovers.push(l);
    }
    // المنطقة والصيدلية محسومتان بعناوين ⇒ السطر الباقي الوحيد هو المذخر
    // («ص شمس الرواسي / دواء الكندي / منطقة الامين»).
    if (header.warehouse == null && leftovers.length === 1) header.warehouse = leftovers[0].text;
  }

  // المنطقة باسمها القانوني في السوبر أدمن (والمدموجة باسم ما دُمجت تحته).
  if (header.area) header.area = areaOf(header.area) || header.area;

  if (header.pharmacyLines > 1) {
    // أكثر من صيدلية في رسالة واحدة: لا نعرف أي صنف لأيّها — الموديل يقرّر.
    header.pharmacy = null; header.area = null;
  }
  return { header, itemLines };
}

// ─── أسطر الأصناف ───────────────────────────────────────────────────────────
const COUNT_UNIT = String.raw`(?:p|pc|pcs|pack|box|ع|علب[ةه]?|علب|حب[ةه]|شريط)`;
// «(5)»، «(10p)»، «( 10 علبة )» في آخر السطر.
const PAREN_QTY_END = new RegExp(String.raw`\(\s*(\d+)\s*${COUNT_UNIT}?\s*\)\s*$`, 'i');
const PAREN_QTY_START = new RegExp(String.raw`^\(\s*(\d+)\s*${COUNT_UNIT}?\s*\)\s*`, 'i');
// «50+5p»، «10 + 2» في آخر السطر.
const PLUS_QTY_END = new RegExp(String.raw`(?:^|\s)(\d+)\s*\+\s*(\d+)\s*${COUNT_UNIT}?\s*$`, 'i');
// «10 p»، «10p»، «5 علبة» في آخر السطر — الوحدة إلزامية هنا وإلا كان الرقم تركيزاً.
const UNIT_QTY_END = new RegExp(String.raw`(?:^|\s)(\d+)\s*${COUNT_UNIT}\s*$`, 'i');

/**
 * يقرأ الكمية من سطر صنف حين يحدّدها **الشكل** بلا لبس: بين قوسين، أو «ك+ب»،
 * أو رقم متبوع بوحدة عدّ. يُعيد null حين لا شكل صريحاً (الموديل يقرّر).
 * @returns {{ name: string, quantity: number, bonus: number|null } | null}
 */
export function parseItemLine(line) {
  const s = tidy(toLatinDigits(line));
  let m, name, quantity, bonus = null;
  if ((m = s.match(PAREN_QTY_END))) {
    quantity = Number(m[1]); name = s.slice(0, m.index);
  } else if ((m = s.match(PAREN_QTY_START))) {
    quantity = Number(m[1]); name = s.slice(m[0].length);
  } else if ((m = s.match(PLUS_QTY_END))) {
    quantity = Number(m[1]); bonus = Number(m[2]); name = s.slice(0, m.index);
  } else if ((m = s.match(UNIT_QTY_END))) {
    quantity = Number(m[1]); name = s.slice(0, m.index);
  } else {
    return null;
  }
  name = tidy(name)
    // «Devit50» ← «Devit 50»: الالتصاق يُفشل مطابقة الكتالوج («Devit 50,000 IU»).
    .replace(/([a-z]{3,})(\d)/gi, '$1 $2')
    // «50,000» ← «50000»: فاصل الآلاف داخل التركيز يقسمه رقمين عند حارس الجرعة.
    // (النقطة مستثناة: «0.125mg» تركيز عشري لا فاصل آلاف.)
    .replace(/(\d{1,3})[,'](\d{3})(?!\d)/g, '$1$2');
  if (!name || !Number.isFinite(quantity) || quantity <= 0) return null;
  return { name, quantity, bonus };
}

/** أول كلمة لاتينية/عربية ذات معنى في اسم الصنف — مفتاح ربط الصف بسطره. */
function brandOf(s) {
  const m = normKey(s).match(/[a-z؀-ۿ]{3,}/);
  return m ? m[0] : '';
}

/**
 * يُطبّق القراءة الحتمية على صفوف الموديل في مكانها:
 *  • الترويسة (صيدلية/منطقة/مذخر) حين حسمها الشكل.
 *  • الاسم والكمية والبونص لكل صف وُجد سطره وكانت كميته صريحة الشكل.
 * @returns {object[]} الصفوف نفسها
 */
export function reconcileRowsWithText(rows, text, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const { header, itemLines } = parseOrderText(text, opts);

  // سطر أسماء مذاخر بعد الأصناف («سنايا اسبرين منارة» — بدائل التجهيز) قرأه الموديل
  // صنفاً. صفّ **بلا كمية** اسمه عربي ويحوي مذخراً معروفاً = مذخر لا صنف، فيُحذف.
  // الكمية شرط: «اسبرين 10 علبة» دواء حقيقي ويبقى. (حذف في المكان — المستدعون
  // يعتمدون على نفس المصفوفة.)
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const name = String(r?.item ?? '');
    if (r && r.quantity == null && !HAS_LATIN.test(name) && !HAS_DIGIT.test(toLatinDigits(name))
        && findKnownWarehouse(name)) {
      rows.splice(i, 1);
    }
  }

  for (const row of rows) {
    if (header.pharmacy) {
      if (row.pharmacy && normKey(row.pharmacy) !== normKey(header.pharmacy)) row._pharmacyModel = row.pharmacy;
      row.pharmacy = header.pharmacy;
      // منطقة الشكل تغلب؛ وإن لم يحدّدها الشكل فمنطقة الموديل قد تكون سطر المذخر
      // أو اسم الصيدلية نفسه — تُمسح إن طابقت أحدهما.
      if (header.area) row.area = header.area;
      else if (row.area && [header.pharmacy, header.warehouse].some(v => v && normKey(v) === normKey(row.area))) row.area = null;
    }
    if (header.warehouse) row.warehouse = header.warehouse;
    // مذخر الموديل حين لم يحسمه الشكل: يُنظَّف من الملاحظات الملتصقة بنفس القاعدة.
    else if (row.warehouse) row.warehouse = cleanWarehouseName(String(row.warehouse).replace(/^(?:من\s+)?(?:ال)?مذخر\s+/, ''));
  }

  // ربط كل صف بسطره: بالعلامة التجارية، بالترتيب، وكل سطر يُستهلك مرة واحدة.
  const used = new Set();
  for (const row of rows) {
    const brand = brandOf(row.item);
    if (!brand) continue;
    const idx = itemLines.findIndex((l, i) => !used.has(i) && normKey(l).includes(brand));
    if (idx < 0) continue;
    used.add(idx);
    const parsed = parseItemLine(itemLines[idx]);
    if (!parsed) continue;
    if (row._itemId != null && normKey(parsed.name) !== normKey(row.item)) {
      // صفّ طوبِق سابقاً (طلبية قديمة تُعاد قراءتها): ربطه وشركته وسعره من الكتالوج
      // تخصّ الاسم القديم — تُمسح لتُعاد مطابقتها على الاسم المصحّح.
      row._itemId = null; row._scientificCompanyId = null; row._itemMatch = null;
      row.company = null; row.unitPrice = null;
    }
    row.item = parsed.name;
    row.quantity = parsed.quantity;
    // السطر قُرئ كاملاً: لا «+» فيه ⇒ لا بونص. الموديل كان يجعل «(5)» بونصاً.
    row.bonus = parsed.bonus ?? 0;
    // الإجمالي الذي حسبه الموديل على كمية خاطئة لا يصحّ بعد تصحيحها.
    if (row.unitPrice != null) row.total = Number(row.unitPrice) * parsed.quantity;
    else row.total = null;
  }
  return rows;
}
