// ════════════════════════════════════════════════════════════════════════════
// order-extract.js — استخراج صفوف طلبية من نصّ عربي حرّ عبر Gemini.
//
// الطلبية المكتوبة في كروب ليست فاتورة: لا رقم فاتورة ولا مذخر ولا جدول أعمدة،
// والكميات بصيغ حرة («٥ علبة»، «علبتين»). لذلك برومبت خاص — لكنه يعيد **نفس شكل
// صف** مخرجات extractInvoiceRows بالضبط، فشبكة المراجعة في ManualSalesModal
// وinsertManualSales يقبلانه بلا أي تحويل. (حقل القيمة اسمه total لا totalValue.)
//
// مسار الصور لا يمرّ من هنا إطلاقاً: صورة فاتورة مذخر تُرسَل للبوت هي بالضبط ما
// كُتب له extractInvoiceRows (بصناديق التكبير وكل شيء)، فيُعاد استخدامه حرفياً مع
// الكابشن كـextraContext.
//
// لا شيء هنا يكتب في قاعدة البيانات — الاستخراج يُنتج صفوفاً غير محفوظة فقط.
// ════════════════════════════════════════════════════════════════════════════

import { callGeminiSmart } from '../ai-assistant/ai-assistant.controller.js';
import { parseInvoiceJson, splitPharmacyArea, isCopiedFromPrompt } from '../sales/sales.service.js';
import { normalizeItemKey } from '../../lib/itemResolver.js';
import { MAX_ORDER_TEXT_LEN, stripTriggerPrefix } from './order-trigger.js';
import { reconcileRowsWithText, normKey, KNOWN_WAREHOUSES } from './order-text-parse.js';
import prisma from '../../lib/prisma.js';

// أسماء المذاخر المعروفة (دفتر رصيد المذاخر) — تكشف سطر مذخر كُتب بلا كلمة «مذخر»
// («دواء الكندي»). عامة بلا نطاق حساب: الاسم وحده لا يكشف بيانات، والخطأ الوحيد
// الممكن تصنيف سطر كمذخر وهو ما يراه المراجِع.
const WAREHOUSE_CACHE_MS = 10 * 60_000;
let warehouseCache = null; // { at, keys:Set }
async function loadKnownWarehouseKeys() {
  if (warehouseCache && Date.now() - warehouseCache.at < WAREHOUSE_CACHE_MS) return warehouseCache.keys;
  const keys = new Set();
  try {
    const [whs, links] = await Promise.all([
      prisma.stockWarehouse.findMany({ select: { name: true } }),
      prisma.warehouseNameLink.findMany({ select: { fromName: true } }),
    ]);
    for (const w of whs) keys.add(normKey(w.name));
    for (const l of links) keys.add(normKey(l.fromName));
    keys.delete('');
  } catch (e) {
    console.error('[orders] تعذّر تحميل أسماء المذاخر:', e?.message);
  }
  warehouseCache = { at: Date.now(), keys };
  return keys;
}

/**
 * البرومبت. قواعده المشتركة مع INVOICE_PROMPT (sales.service.js) منقولة حرفياً —
 * تكرار الترويسة، null بلا اختلاق، أرقام بلا فواصل، بادئات الصيدلية، فصل
 * «الاسم - المنطقة» — كي لا يفترق المستخرجان مع الوقت.
 * `todayISO` يُحقَن لأن الموديل لا يعرف تاريخ اليوم ولا يجوز أن يخمّنه.
 */
export const buildOrderTextPrompt = (todayISO) => `أنت خبير في قراءة طلبيات الصيدليات المكتوبة بالعربية العراقية في كروبات المبيعات (واتس اب/تلكرام/فايبر).

النص المرفق **طلبية** أرسلها مندوب أو صيدلي — وليس فاتورة مطبوعة. يُكتب بحرّية: سطر للصيدلية ثم سطر لكل صنف، أو كل شيء في سطر واحد. أسماء الأدوية كثيراً ما تُكتب بالإنجليزية داخل نص عربي. الكميات تُكتب بصيغ متعدّدة («٥ علبة»، «5 ع»، «علبتين»، «درزن»، «10 حبة»).

تاريخ اليوم هو ${todayISO} — استخدمه لحلّ أي تاريخ نسبي («اليوم»، «امس»، «باچر»). لا تخمّن تاريخ اليوم من عندك.

استخرج لكل صنف مذكور في الطلبية صفاً واحداً.

أعِد **مصفوفة JSON فقط** (JSON array) — بلا أي نص أو شرح قبلها أو بعدها وبلا أسوار \`\`\` — كل عنصر يمثّل صنفاً واحداً بهذا الشكل بالضبط:
[
  {
    "item": "اسم المادة كما كُتب",
    "company": "الشركة المصنّعة أو null",
    "quantity": 5,
    "unitPrice": null,
    "total": null,
    "bonus": 0,
    "customerHeader": "سطر الزبون من الترويسة كما كُتب حرفياً",
    "pharmacy": "اسم الصيدلية فقط",
    "warehouse": null,
    "area": "منطقة الصيدلية أو null",
    "date": "${todayISO}",
    "invoiceNumber": null
  }
]

قواعد صارمة:
- **اسم المادة (item):** انسخه كما كُتب كاملاً بلا اختصار (الاسم + التركيز + الشكل إن ذُكرت). لا تُصحّح الأسماء ولا تستبدلها بأسماء تجارية تعرفها — انسخ ما كُتب.
- **لا تنقل الاسم بين الأبجديتين إطلاقاً:** إن كُتب بالعربية فأعِده بالعربية كما هو حرفاً بحرف («اوغمنتين» تبقى «اوغمنتين» ولا تصبح Augmentin، و«فولتارين جل» تبقى «فولتارين جل»)، وإن كُتب باللاتينية فأعِده باللاتينية. الاسم يُطابَق لاحقاً بكتالوك مكتوب بنفس هيئة ما يكتبه المندوبون، فأي ترجمة أو نقل حروف تُفقد المطابقة.
- **لا تُدخل الكمية في اسم المادة:** في «زنتاك 20 علبة» اسم المادة «زنتاك» والكمية 20 — لا تجعل الاسم «زنتاك 20». أمّا التركيز الملتصق بالاسم فهو جزء منه («AMOXIL 500MG»، «كونكور 5 ملغم») ويُميَّز بأن بعده وحدة تركيز (ملغم/mg/ml/غم) لا وحدة عدّ (علبة/حبة/شريط/درزن).
- **الكمية (quantity):** رقم المعدودات. «علبتين» = 2، «درزن» = 12. إن لم تُذكر كمية لصنفٍ فاجعلها null **ولا تحذف الصف** — المراجِع يكملها بنفسه، وحذف السطر يُخفيه عنه.
- **الرقم بين قوسين في آخر السطر هو الكمية:** في «‹مادة› 20 (5)» الكمية 5 والرقم 20 تركيز يبقى في الاسم («‹مادة› 20»)، و«(10p)» أو «10 p» كمية 10. لا تضع ما بين القوسين في اسم المادة ولا في البونص.
- **البونص (bonus):** الكمية المجانية إن ذُكرت («+1»، «بونص 2»، «10+1» تعني كمية 10 وبونص 1). إن لم تُذكر فاجعلها 0.
- **الأسعار:** طلبيات الكروبات غالباً بلا أسعار، لكن **رقماً يأتي بعد الكمية ووحدتها هو سعر الوحدة** — في «زنتاك 20 علبة 9500» الكمية 20 وسعر الوحدة 9500. لا تُسقط مثل هذا الرقم. إن لم يُذكر سعر فاجعل unitPrice و total كلاهما null، وإن ذُكر سعر الوحدة فقط فاترك total null.
- **customerHeader إلزامي وهو أهمّ حقل:** الطلبية تبدأ عادةً بسطر يحمل **اسم الصيدلية ومنطقتها**، ثم تأتي بعده أسطر الأصناف. انسخ **ذلك السطر وحده** هنا حرفاً بحرف بلا حذف ولا تنظيف ولا إعادة ترتيب (بالمنطقة والفاصل والبادئات إن وُجدت).
  • هو **قيمة ترويسة تتكرّر كما هي في كل صف** — ليس سطر هذا الصنف.
  • **ممنوع منعاً باتاً** أن يحتوي اسم مادة أو كمية أو سعراً أو كلمة عدّ (علبة/حبة/شريط/درزن). إن وجدت نفسك تكتب فيه اسم دواء فقد أخطأت الحقل.
  • إن لم يوجد سطر زبون في الطلبية إطلاقاً فاجعله null.
  مثال كامل — لهذه الطلبية:
    طلبيه
    سر الدواء/ الحارثية
    Pantactive40.  50
    Nospactive.     20
    مذخر الناقوس
  (ملاحظة: أسماء المذاخر — مثل ${KNOWN_WAREHOUSES.map(g => g[0]).join('، ')} — **ليست أصنافاً أبداً** ولو جاءت في سطر وحدها بعد الأصناف؛ لا تُعِد لها صفاً.)
  تكون قيمة customerHeader في **كلا** الصفّين هي «سر الدواء/ الحارثية» بالضبط، و warehouse = «الناقوس»، والصفّان يختلفان في item و quantity فقط.
- **اسم الصيدلية (pharmacy):** الاسم الفعلي فقط، بلا أي بادئة أو لقب قبله مثل: "ص"، "ص."، "صيدلية"، "الصيدلية"، "صيدليه"، "زبون"، "الزبون"، "عميل"، "العميل"، "اسم"، "الاسم"، "د"، "دكتور"، وبلا المنطقة (انظر القاعدة التالية).
- **فصل الصيدلية عن المنطقة:** كثيراً ما يُكتب اسم الصيدلية والمنطقة معاً مفصولين بشرطة «-» أو «/»، مثل «صيدلية النور - الكرخ» أو «سر الدواء/ الحارثية». **الجزء الأول دائماً هو اسم الصيدلية (pharmacy)، والجزء الأخير بعد الفاصل هو المنطقة (area).**
- **لا تُسقِط اسم الصيدلية أبداً مهما بدا غريباً:** أسماء الصيدليات في العراق كثيراً ما تكون جُملاً أو إضافات («سر الدواء»، «بيت الدواء»، «شفاء العليل»، «ابو احمد») — هذه **أسماء صيدليات** لا عناوين ولا كلام زائد. ممنوع منعاً باتاً أن تضع المنطقة في حقل pharmacy وتحذف الاسم: في «سر الدواء/ الحارثية» تكون pharmacy = «سر الدواء» و area = «الحارثية»، **وليس** pharmacy = «الحارثية».
- **الترويسة قد تكون عدّة أسطر:** سطر المنطقة وحده (بلا «ص»)، ثم سطر الصيدلية الذي يبدأ بـ«ص» أو «ص.» أو «صيدلية»، وقد يأتي سطر مذخر. الصيدلية هي ما بعد «ص» فقط — **لا تدمج سطر المنطقة ولا سطر المذخر في اسم الصيدلية**.
- **المذخر (warehouse):** إن ذُكر مذخر صراحةً في الطلبية (سطر مثل «مذخر الناقوس» أو «من مذخر النور» أو «تم التجهيز من مذخر …») فضَعه هنا بلا كلمة «مذخر» — أي «الناقوس». وإن لم يُذكر مذخر إطلاقاً فاجعله null. **لا تضع اسم الصيدلية ولا المنطقة في هذا الحقل أبداً.**
- **تكرار الترويسة:** اسم الصيدلية والمنطقة والتاريخ تُذكر مرة واحدة أعلى الطلبية وتنطبق على كل أصنافها — **كرّرها في كل صف**.
- الأرقام أرقام حقيقية بلا فواصل آلاف ولا رموز عملة (مثال: 99000 وليس "99,000")، وحوّل الأرقام الهندية ٠١٢٣٤٥٦٧٨٩ إلى أرقام عادية.
- إن لم تجد قيمة حقلٍ فاجعلها null — لا تختلق ولا تخمّن قيماً.
- التاريخ بصيغة YYYY-MM-DD.
- **إن لم يكن النص طلبية فعلية** (أي أصناف وكميات لصيدلية) — تحية، سؤال، تعليق، رقم هاتف، كلام إداري، تأكيد استلام — **فأعِد مصفوفة فارغة [] ولا تختلق أي صف**.
- **قائمة أسماء أدوية بلا أي كميات ليست طلبية** — أعِد [].`;

/** يحوّل الأرقام الهندية إلى عادية ثم إلى رقم، أو null. */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
                     .replace(/[^\d.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const str = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || s.toLowerCase() === 'null' ? null : s;
};

// كلمات العدّ التي لا تظهر أبداً في سطر زبون سليم — وجودها دليل أن الموديل نسخ
// سطر مادة في حقل الترويسة.
const UNIT_WORD_RE = /(علب|حب|شريط|درزن|قنين|امبول|أمبول|box|strip|vial)/i;

/**
 * هل هذا السطر سطر زبون فعلاً؟ يُرفض إن حمل اسم المادة أو كلمة عدّ.
 * الأرقام وحدها لا تكفي للرفض — «صيدلية 14 رمضان» اسم صيدلية حقيقي.
 */
function isCustomerHeader(line, itemName) {
  const s = cleanName(line);
  if (!s) return false;
  if (UNIT_WORD_RE.test(s)) return false;
  const it = cleanName(itemName);
  if (it && it.length >= 3 && s.toLowerCase().includes(it.toLowerCase())) return false;
  return true;
}

// الموديل يُدخل أحياناً تطويلاً عربياً داخل الاسم («دافـلون» بدل «دافلون»). التطويل
// محرف تزييني بلا معنى دلالي، وitemResolver.normalizeArabic يُسقطه عند المطابقة —
// لكن الاسم المحفوظ والمعروض في شبكة المراجعة يبقى غريباً، فنُسقطه من المصدر.
const cleanName = (s) => {
  const out = String(s ?? '')
    .replace(/\u0640/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // ترقيم طرفي يلتقطه الموديل من الطلبيات المكتوبة بسرعة («Pantactive40.»،
    // «دافلون،»). الترقيم داخل الاسم يبقى سليماً («B-12»، «No.2»).
    .replace(/^[.,،;:\-\u2013]+/, '')
    .replace(/[.,،;:]+$/, '')
    .trim();
  return out === '' ? null : out;
};

/**
 * يستخرج صفوف طلبية من نص حرّ. لا يرمي عند فشل الذكاء — يُعيد [] ويترك القرار
 * للمستدعي (bot-order-flow يردّ برسالة عربية مفهومة بدل خطأ تقني في الكروب).
 *
 * @param {string} text
 * @param {{ todayISO?: string }} [opts]
 * @returns {Promise<object[]>} صفوف بنفس شكل مخرجات extractInvoiceRows
 */
export async function extractOrderRowsFromText(text, { todayISO } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > MAX_ORDER_TEXT_LEN) return [];

  const today = todayISO || new Date().toISOString().slice(0, 10);

  let reply;
  try {
    // سلّم الموديلات الافتراضي بلا تثبيت: التعليق في ai-assistant.controller.js
    // قاس هذا السلّم بالذات على قراءة الفواتير العربية ويحذّر من الترقية العمياء.
    reply = await callGeminiSmart(
      [buildOrderTextPrompt(today), `نصّ الطلبية:\n«${raw}»`],
      { timeoutMs: 45_000, thinkingBudget: 0, feature: 'bot-order-text' },
    );
  } catch (err) {
    console.error('[orders] Gemini فشل في قراءة نص الطلبية:', String(err?.message || '').slice(0, 200));
    return [];
  }

  const rows = [];
  for (const r of parseInvoiceJson(reply)) {
    const item = cleanName(r.item);
    if (!item) continue; // صنف بلا اسم لا معنى له في الشبكة


    // الفصل يجري هنا على **السطر الخام** لا على اجتهاد الموديل في حقل pharmacy:
    // جُرِّب فعلياً أن Gemini قد يضع المنطقة في حقل الصيدلية ويُسقط الاسم كلياً
    // («سر الدواء/ الحارثية» → pharmacy: «الحارثية»). splitPharmacyArea كود
    // حتمي مُختبَر، فتقديمه على الموديل يُخرج القرار من دائرة الاحتمال.
    // الفصل يجري على **سطر الترويسة الخام** لا على اجتهاد الموديل في حقل
    // pharmacy، لكن مع حارس: جُرِّب فعلياً أن Gemini يتأرجح بين وضع سطر الزبون
    // وسطر المادة في هذا الحقل. فإن حمل السطر اسم المادة أو كلمة عدّ فهو السطر
    // الخطأ ويُهمَل، ونرجع لحقل pharmacy. ترك الخانة فارغة ليملأها المراجِع
    // أسلم من كتابة اسم دواء في خانة الصيدلية.
    const header = isCustomerHeader(r.customerHeader, item)
      ? cleanName(stripTriggerPrefix(r.customerHeader))
      : null;
    const split = header
      ? splitPharmacyArea(header, r.area)
      : splitPharmacyArea(r.pharmacy, r.area);
    // حارس النسخ من المثال: صيدلية موجودة في نصّ البرومبت (مثال «سر الدواء/
    // الحارثية») لكنها غائبة عن رسالة المرسِل نفسها لم تُقرأ من الطلبية.
    const tight = (v) => normalizeItemKey(v).replace(/\s+/g, '');
    if (split.pharmacy && isCopiedFromPrompt(split.pharmacy, buildOrderTextPrompt(today))
        && !tight(raw).includes(tight(split.pharmacy))) {
      console.error('[orders] رُفضت صيدلية منسوخة من مثال البرومبت:', split.pharmacy);
      split.pharmacy = '';
      split.area = '';
    }
    rows.push({
      item,
      company:       cleanName(r.company),
      quantity:      num(r.quantity),
      unitPrice:     num(r.unitPrice),
      total:         num(r.total),
      bonus:         num(r.bonus) ?? 0,
      pharmacy:      cleanName(split.pharmacy),
      warehouse:     cleanName(r.warehouse),
      area:          cleanName(split.area),
      date:          str(r.date) || today,
      invoiceNumber: str(r.invoiceNumber),
      // لا صورة ⇒ لا صناديق تكبير. المودال يتجاهل القيم الفارغة أصلاً.
      _imageIndex:   null,
      _box:          null,
      _boxCustomer:  null,
      _boxHeader:    null,
    });
  }

  return applyTextParse(rows, raw);
}

/** نسخة القراءة الحتمية — تُخزَّن في payload فتُعاد قراءة الطلبيات الأقدم عند فتحها. */
// 2 (2026-10-19): قائمة المذاخر المعروفة + قصّ الملاحظة بعد اسم المذخر.
// 3: صفّ بلا كمية اسمه مذخر معروف («سنايا اسبرين منارة») يُحذف.
export const TEXT_PARSE_VERSION = 3;

/**
 * القراءة الحتمية للنصّ تغلب اجتهاد الموديل حيث يحسم الشكل: ترويسة متعدّدة الأسطر
 * (منطقة / «ص» صيدلية / مذخر) وكمية بين قوسين. راجع order-text-parse.js.
 * تُطبَّق على صفوف **الموديل الخام** فقط (قبل مطابقة الكتالوج) — على صفوف مُطابَقة
 * كانت ستستبدل اسم الكتالوج بالاسم المكتوب.
 */
export async function applyTextParse(rows, text) {
  const known = await loadKnownWarehouseKeys();
  return reconcileRowsWithText(rows, text, {
    isKnownWarehouse: (t) => {
      const k = normKey(t);
      return known.has(k) || known.has(normKey(t.replace(/^(?:دواء|ادوية|أدوية)\s+/, '')));
    },
  });
}
