// ════════════════════════════════════════════════════════════════════════════
// invoiceCards.js — «بطاقة» نموذج فاتورة لكل مذخر (جدول WarehouseInvoiceCard).
//
// كل مذخر يطبع فواتيره بتصميم ثابت. حين يتعرّف نداء الاتجاه على المذخر (يُسأل عنه في
// نفس النداء بلا كلفة إضافية)، تُقرأ الفاتورة ببرومبت مختصر + بطاقة ذلك المذخر بدل
// INVOICE_PROMPT العام (~2,550 token). مذخر بلا بطاقة ⇒ المسار العام كما كان.
//
// مقيس 2026-11-10 على 13 فاتورة حقيقية (طريق السلام ×8، العناية المتميزة ×5)، مرتين:
// العام 25/26 صحيحة بـ~3,650 token إدخال، البطاقة 25/26 بـ~1,850 — كلفة القراءة
// 0.006$ ← 0.0037$. والتعرّف على المذخر 18/18 (مع «غيره» للمذاخر بلا بطاقة).
//
// bonusStyle قاعدة **للكود** لا للموديل: 'column' = البونص عمود («البيان: 3+»)
// فالأسطر المكرّرة لنفس المادة مبيع حقيقي ولا تُطوى بونصاً (foldBonusRows كان يحوّل
// «SELADRENALIN 4 + 1» المدفوعين إلى 4 + بونص 1).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

/**
 * البرومبت المختصر — يسبق نصّ البطاقة. **مخرجات مضغوطة**: الترويسة مرة واحدة والأصناف
 * مصفوفات، بدل تكرار الصيدلية/التاريخ/الرقم في كل صف. الإخراج أغلى بـ5 أضعاف من الإدخال،
 * ومقيس 2026-11-10 (13 فاتورة × 5): الإخراج 613 ← 269 token، القراءة 0.0037$ ← 0.0024$،
 * والدقة 62/65 (الأخطاء الثلاثة تهجئة اسم واحد، لا أرقام). يُحوَّل بـ parseCardReply.
 */
export const CARD_BASE_PROMPT = `اقرأ فاتورة/طلبية مذخر الأدوية في الصورة.
أعِد **كائن JSON واحداً فقط** بلا أي نص قبله أو بعده، بهذا الشكل بالضبط:
{"h":{"warehouse":"اسم المذخر","pharmacy":"اسم الصيدلية فقط","area":"منطقة الصيدلية أو null","date":"YYYY-MM-DD","invoiceNumber":"22287","box_customer":[ymin,xmin,ymax,xmax],"box_header":[ymin,xmin,ymax,xmax]},
 "r":[["اسم المادة كاملاً",الكمية,البونص,سعر_الوحدة,مجموع_السطر,السعر_مطبوع,[ymin,xmin,ymax,xmax]]]}
- h: بيانات الترويسة **مرة واحدة**. r: صف لكل سطر صنف بالترتيب: [item, quantity, bonus, unitPrice, total, priceShown(true/false), box].
- item: انسخ الاسم كاملاً كما طُبع (الاسم + التركيز + الشكل).
- pharmacy: الاسم فقط بلا «ص»/«صيدلية»/«صيدليه» وبلا المنطقة. area: منطقة الصيدلية المشترية فقط، لا عنوان المذخر.
- الأرقام بلا فواصل آلاف. ما لا تجده = null، لا تختلق.
- الصناديق بمقياس 0-1000 (سطر الصنف / كتلة الزبون / كتلة الترويسة)، أو null.

`;

/**
 * يحوّل الرد المضغوط إلى نفس صفوف INVOICE_PROMPT (الترويسة مكرّرة في كل صف) كي يمرّ
 * باقي المسار بلا تغيير. ردّ بشكل المصفوفة القديم يُقبل أيضاً (fallback).
 */
export function parseCardReply(text, parseArray) {
  const raw = String(text ?? '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      if (o && Array.isArray(o.r)) {
        const h = o.h || {};
        return o.r.filter(Array.isArray).map(([item, quantity, bonus, unitPrice, total, priceShown, box]) => ({
          item, quantity, bonus, unitPrice, total, priceShown, box: box ?? null,
          warehouse: h.warehouse ?? null, pharmacy: h.pharmacy ?? null, area: h.area ?? null,
          date: h.date ?? null, invoiceNumber: h.invoiceNumber ?? null,
          box_customer: h.box_customer ?? null, box_header: h.box_header ?? null,
        }));
      }
    } catch { /* يسقط للمحلّل القديم */ }
  }
  return parseArray(raw) || [];
}

// البطاقات الأولى (مختبَرة 2026-11-10). تُزرع في الجدول إن غابت ولا تُستبدل إن عُدّلت.
const DEFAULT_CARDS = [
  {
    name: 'طريق السلام',
    bonusStyle: 'row',
    prompt: `نموذج فواتير مذخر «طريق السلام» (TAREEQ AL-SALAM، شعار TAS) — ثابت لكل فواتيره:
- warehouse = «طريق السلام».
- الزبون في أول خانة مستديرة أعلى يمين الفاتورة بعد «السيد :» بالشكل «صيدلية ‹اسم› / ‹منطقة›». إن كانت المنطقة «بغداد - ‹حي›» فالمنطقة هي الحيّ. الخانتان تحتها («المندوب :» و«اسم المجهز :») أشخاص من المذخر وليست الزبون.
- رقم الفاتورة بعد «الرقم :» (6 أرقام)، والتاريخ بعد «التاريخ :» بصيغة YYYY/MM/DD. أهمِل «الوقت» و«سوبرفايزر» و«منظم الفاتورة» و«فاتورة : مبيع» و«أجل».
- أعمدة الجدول من اليمين: ت، المادة، الكمية، السعر (سعر الوحدة)، القيمة (مجموع السطر)، رقم الوجبة، تاريخ النفاذ. الأصناف تنتهي عند «***** انتهى *****».
- **البونص سطر مستقل** يكرّر نفس المادة مباشرةً تحت سطرها المدفوع، وخانة «القيمة» فيه فارغة (السعر مطبوع لكنه ليس بيعاً). أعِد سطر البونص صفاً مستقلاً كما هو: quantity = كميته، bonus = 0، total = null، priceShown = false. **ولا تُضف كميته إلى bonus السطر المدفوع** — bonus السطر المدفوع يبقى 0 (الجمع يتم لاحقاً).
- المبالغ بفاصل آلاف «'» («137'150» = 137150).`,
  },
  {
    name: 'العناية المتميزة',
    bonusStyle: 'column',
    prompt: `نموذج مذخر «أدوية العناية المتميزة» — مستند «طلبية مكاتب» يُصوَّر غالباً من شاشة كمبيوتر — ثابت لكل طلبياته:
- warehouse = «العناية المتميزة».
- الزبون سطر واحد بعد «اسم العميل :» بالشكل «ص ‹اسم الصيدلية› - ‹المنطقة› [محافظة] م ‹اسم المندوب›». **كل ما بين «ص» والشرطة «-» هو اسم الصيدلية كاملاً** مهما كان عدد كلماته («النبأ العظيم»، «سرمد قاسم الهاشمي») — لا تقسمه. area = ما بعد الشرطة وقبل « م » (إن كان «‹مدينة› ‹محافظة›» فالمنطقة هي المدينة)، وما بعد « م » اسم مندوب **يُهمَل كلياً**.
- رقم الفاتورة بعد «رقم الفاتورة :» (5 أرقام بجانب الباركود)، والتاريخ بعد «تاريخ ووقت الطباعة :» بصيغة DD-MM-YYYY أو DD/MM/YYYY.
- أعمدة الجدول من اليمين: #، المادة، الكمية، الإفرادي (سعر الوحدة)، **البيان (= البونص، يُكتب «3+» أو «10+» ⇒ bonus = 3 أو 10)**، اسم الشركة (company)، نوع المادة (أهمِله).
- **لا يوجد عمود مجموع للسطر:** total = الكمية × الإفرادي، و priceShown = true.
- قد تتكرّر نفس المادة في سطرين وكلاهما مسعّر — كلاهما بيع مدفوع، أعِدهما صفّين.
- المبالغ بفاصل آلاف «,» («25,565» = 25565). «اجمالي الكمية» و«قيمة الطلبية» تحت الجدول ليست أصنافاً.`,
  },
];

const CACHE_MS = 5 * 60_000;
let cache = null; // { at, cards }
let seeded = false;

/** البطاقات المفعّلة. لا ترمي — فشل القاعدة يعني «بلا بطاقات» فيبقى المسار العام. */
export async function loadInvoiceCards() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cards;
  let cards = [];
  try {
    if (!seeded) {
      await prisma.warehouseInvoiceCard.createMany({ data: DEFAULT_CARDS, skipDuplicates: true });
      seeded = true;
    }
    cards = await prisma.warehouseInvoiceCard.findMany({
      where: { enabled: true },
      select: { id: true, name: true, prompt: true, bonusStyle: true },
      orderBy: { id: 'asc' },
    });
  } catch (e) {
    console.error('[invoice-cards] تعذّر تحميل البطاقات:', String(e?.message || '').slice(0, 160));
  }
  cache = { at: Date.now(), cards };
  return cards;
}

const norm = (s) => String(s ?? '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[^\p{L}\p{N}]+/gu, '');

/** يطابق جواب الموديل («2|طريق السلام») ببطاقة، أو null («غيره» أو اسم غير معروف). */
export function matchCard(cards, answer) {
  const a = norm(answer);
  if (!a || a.includes(norm('غيره'))) return null;
  return cards.find(c => { const n = norm(c.name); return n && (a.includes(n) || n.includes(a)); }) || null;
}

/** عدّاد استعمال للوحة لاحقاً — لا ينتظر ولا يرمي. */
export function noteCardUse(card) {
  if (!card?.id) return;
  prisma.warehouseInvoiceCard.update({
    where: { id: card.id }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  }).catch(() => {});
}
