/**
 * crossFileDedup — إسقاط التكرار **عبر الملفات المتداخلة فقط**.
 *
 * الاستيراد لا يُسقط أي صف (bulkCreateSales بلا skipDuplicates، و Sale بلا قيد
 * فريد)، فطبقة التحليل هي التي تمنع عدّ الطلبية الواحدة مرتين حين يحمل ملفان
 * نشطان الصفوف نفسها (ملف «كل العراق» + ملف المنطقة مثلاً).
 *
 * الفخّ الذي وقع فيه أكثر من موديول: إسقاط كل التكرارات بمفتاح واحد عالمياً.
 * ذلك يطوي التداخل صحيحاً، لكنه يحذف أيضاً طلبيات حقيقية متطابقة القيم **داخل
 * الملف الواحد** — وبيانات الأدوية تكرر الكميات المستديرة (10/50/100) بنفس
 * السعر لنفس الصيدلية في اليوم نفسه بشكل مشروع تماماً. النتيجة كانت نقصاً
 * صامتاً بعشرات آلاف الطلبيات من ملف واحد بلا أي تداخل أصلاً.
 *
 * الطريقة الصحيحة (المعتمدة في تقرير المندوبين العلميين ثم في Pharmacy Net):
 * نجمع الصفوف بمفتاح مركّب، ثم لكل مفتاح نُبقي صفوف **الملف الذي يحتوي أكثر
 * عدد من التكرارات وحده**.
 *
 * @param {Array<{uploadedFileId?: number|null}>} rows
 * @param {(row: any) => string} keyOf مفتاح المحتوى (بلا معرّف الملف)
 * @returns {Array} الصفوف المُبقاة، بترتيب الإدخال نفسه
 */
export function dedupCrossFile(rows, keyOf) {
  const keyToFileRows = new Map(); // key → Map(uploadedFileId → rows[])
  for (const r of rows) {
    const key = keyOf(r);
    let fileMap = keyToFileRows.get(key);
    if (!fileMap) { fileMap = new Map(); keyToFileRows.set(key, fileMap); }
    const fid = r.uploadedFileId ?? 0;
    const arr = fileMap.get(fid);
    if (arr) arr.push(r); else fileMap.set(fid, [r]);
  }
  const kept = new Set();
  for (const fileMap of keyToFileRows.values()) {
    let best = null;
    for (const fileRows of fileMap.values()) {
      if (!best || fileRows.length > best.length) best = fileRows;
    }
    if (best) for (const r of best) kept.add(r);
  }
  return rows.filter(r => kept.has(r));
}
