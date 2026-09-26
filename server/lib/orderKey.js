// ════════════════════════════════════════════════════════════════════════════
// orderKey.js — عدد الطلبيات الفعلي ضمن صفوف Sale (لا عدد أسطر المبيعات).
//
// صف الملف الأصلي فيه سطر منفصل لكل صنف ضمن نفس الطلبية (نفس رقم الطلبية/التاريخ
// والوقت/الصيدلية/المذخر يتكرر عبر عدة أسطر صنف مختلف) — فعدّ الأسطر مباشرة كان
// سيُضخّم عدد الطلبيات الحقيقي. رقم الطلبية والمذخر لا يقابلهما عمود Sale مُهيكَل
// (يعيشان في rawData فقط — راجع ذاكرة project_pharma_manual_invoice_sales)، فاستخراج
// المفتاح يمرّ عبر rawData حصراً. نفس مجموعات الأسماء البديلة المستعملة في تصدير
// Excel (ReportsPage.tsx buildSheet/buildMergedSheet) كي لا يفترق المصدران عن بعض.
// ════════════════════════════════════════════════════════════════════════════

const ORDER_NO_ALIASES  = ['رقم الفاتورة', 'رقم الفاتوره', 'رقم طلبية المذخر', 'رقم طلبيه المذخر', 'رقم الطلبية', 'رقم الطلبيه', 'رقم الطلب'];
const WAREHOUSE_ALIASES = ['المذخر', 'اسم المذخر', 'المخزن', 'اسم المخزن', 'المستودع', 'اسم المستودع'];
const PHARMACY_ALIASES  = ['الصيدلية', 'اسم الصيدلية', 'العميل', 'اسم العميل', 'الزبون', 'اسم الزبون', 'اسم الشركة', 'اسم الشركه'];
const DATE_ALIASES       = ['التاريخ', 'تاريخ', 'تاريخ البيع', 'تاريخ الفاتورة', 'تاريخ الطلب', 'تاريخ العملية',
  'أنشات بتاريخ', 'انشات بتاريخ', 'أنشأت بتاريخ', 'انشأت بتاريخ', 'تاريخ الانشاء', 'تاريخ الإنشاء'];

const normLoose = (s) => String(s ?? '').trim().toLowerCase()
  .replace(/[أإآٱ]/g, 'ا').replace(/[ةه]/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[ً-ٟ]/g, '').replace(/\s+/g, ' ');

const pick = (raw, aliases) => {
  for (const key of Object.keys(raw)) {
    if (aliases.some(a => a.toLowerCase() === key.trim().toLowerCase())) {
      const v = raw[key];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return '';
};

/** مفتاح طلبية من نص rawData الخام لصف Sale — null إن تعذّر (JSON غير صالح أو بلا رقم طلبية). */
export function orderKeyFromRawData(rawData) {
  if (!rawData) return null;
  let raw;
  try { raw = JSON.parse(rawData); } catch { return null; }
  const orderNo = pick(raw, ORDER_NO_ALIASES);
  if (!orderNo) return null;
  const dateVal   = pick(raw, DATE_ALIASES);
  const warehouse = normLoose(pick(raw, WAREHOUSE_ALIASES));
  const pharmacy  = normLoose(pick(raw, PHARMACY_ALIASES));
  return `${orderNo}|${dateVal}|${pharmacy}|${warehouse}`;
}

/**
 * عدد الطلبيات الفعلية ضمن مجموعة صفوف Sale — صفوف نفس الطلبية (عدة أصناف) تُحسب
 * كطلبية واحدة. صف بلا مفتاح (rawData مفقود/بلا رقم طلبية) يُحتسب كطلبية منفردة
 * بدل تجاهله أو دمجه خطأً بصفوف أخرى بلا مفتاح أيضاً.
 */
export function countDistinctOrders(sales) {
  const keys = new Set();
  let unkeyed = 0;
  for (const s of sales) {
    const key = orderKeyFromRawData(s.rawData);
    if (key) keys.add(key); else unkeyed++;
  }
  return keys.size + unkeyed;
}

/** اسم المذخر كما ورد حرفياً في rawData (بدون تطبيع) — للعرض فقط. */
export function warehouseNameFromRawData(rawData) {
  if (!rawData) return '';
  let raw;
  try { raw = JSON.parse(rawData); } catch { return ''; }
  return pick(raw, WAREHOUSE_ALIASES);
}

/**
 * يجمّع صفوف Sale حسب المذخر الذي مرّت عبره الطلبية، ويُرجع عدد الطلبيات
 * الفعلي (لا عدد الأسطر) وصافي القيمة لكل مذخر.
 *
 * عدد الطلبيات يُحسب من orderRows حصراً (نفس منطق countDistinctOrders —
 * صفوف نفس الطلبية «عدة أصناف» تُحسب كطلبية واحدة، وصف بلا رقم طلبية
 * يُحتسب طلبية منفردة) — orderRows يُفترض أن تستثني صفوف الإرجاع (لا
 * "طلبية جديدة"). القيمة تُحسب من valueRows بشكل منفصل (كل الصفوف تُجمع
 * بلا استبعاد تكرار — القيمة لا تُضخَّم بتكرار السطر، كل سطر صنف مساهمته
 * الفعلية)، وتُمرَّر مُطبَّعة مسبقاً بإشارة موجبة/سالبة (مبيع/إرجاع) عبر
 * حقل value على كل صف — هكذا يبقى الناتج صافياً حين تحوي valueRows صفوف
 * إرجاع أيضاً. القيمتان تُبوَّبان باسم المذخر نفسه (نفس normLoose) كي لا
 * يفترق التبويبان عن بعض.
 */
export function groupOrdersByWarehouse(orderRows, valueRows = orderRows) {
  const byNorm = new Map(); // normalized warehouse -> { name, orderCount, value }
  const bucket = (rawData) => {
    const displayName = warehouseNameFromRawData(rawData);
    const normKey = normLoose(displayName) || '—';
    if (!byNorm.has(normKey)) byNorm.set(normKey, { name: displayName || 'غير محدد', orderCount: 0, value: 0 });
    return byNorm.get(normKey);
  };

  const seenOrderKeys = new Set();
  let unkeyedIndex = 0;
  for (const s of orderRows) {
    const key = orderKeyFromRawData(s.rawData);
    const dedupeKey = key ?? `__unkeyed_${unkeyedIndex++}`;
    if (seenOrderKeys.has(dedupeKey)) continue;
    seenOrderKeys.add(dedupeKey);
    bucket(s.rawData).orderCount += 1;
  }

  for (const s of valueRows) {
    bucket(s.rawData).value += Number(s.value) || 0;
  }

  return [...byNorm.values()].sort((a, b) => b.orderCount - a.orderCount);
}
