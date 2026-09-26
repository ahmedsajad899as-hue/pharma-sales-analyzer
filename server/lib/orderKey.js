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
 * الفعلي (لا عدد الأسطر) لكل مذخر — نفس منطق countDistinctOrders، لكن
 * مبوَّباً باسم المذخر (مطبَّعاً للتجميع، مع إبقاء أول تهجئة خام وُجدت
 * للعرض). صف بلا رقم طلبية يُحتسب طلبية منفردة (كـ countDistinctOrders).
 */
export function groupOrdersByWarehouse(sales) {
  const seenOrderKeys = new Set();
  const byNorm = new Map(); // normalized warehouse -> { name, orderCount }
  let unkeyedIndex = 0;
  for (const s of sales) {
    const key = orderKeyFromRawData(s.rawData);
    const dedupeKey = key ?? `__unkeyed_${unkeyedIndex++}`;
    if (seenOrderKeys.has(dedupeKey)) continue;
    seenOrderKeys.add(dedupeKey);

    const displayName = warehouseNameFromRawData(s.rawData);
    const normKey = normLoose(displayName) || '—';
    if (!byNorm.has(normKey)) byNorm.set(normKey, { name: displayName || 'غير محدد', orderCount: 0 });
    byNorm.get(normKey).orderCount += 1;
  }
  return [...byNorm.values()].sort((a, b) => b.orderCount - a.orderCount);
}
