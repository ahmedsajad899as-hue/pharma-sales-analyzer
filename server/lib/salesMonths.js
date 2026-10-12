// ════════════════════════════════════════════════════════════════════════════
// salesMonths.js — «الصفوف بلا تاريخ» وفلتر الشهر، لكل شاشات التحليل.
//
// ─── لماذا تاريخ حارس (sentinel) بدل null ───────────────────────────────────
// Sale.saleDate ليس nullable وقيمته الافتراضية @default(now())، فصفٌّ لم يحمل
// الإكسل له تاريخاً كان يُخزَّن بتاريخ **لحظة الرفع** — أي يظهر كمبيعٍ في شهر
// الرفع. مع الملف المستقل كان ذلك محتملاً (التحليل الشامل يستبعد الصفوف التي
// saleDate ≥ uploadedAt للملف، راجع noDateFileFilter في reports.routes.js)،
// لكن الملف التراكمي يُرفع عليه كل شهر فـuploadedAt يتحرّك باستمرار: صفوفٌ بلا
// تاريخ من رفعة قديمة تصبح فجأةً «أقدم من آخر رفعة» فتدخل التحليل بتاريخ وهمي.
//
// لذلك كل صفّ يدخل ملفاً تراكمياً بلا تاريخ في الإكسل يأخذ UNDATED_SENTINEL
// (1970-01-01) صراحةً: علامة لا لبس فيها لا تتحرّك مع الزمن، تُعرَض للمستخدم
// كشريحة «بلا تاريخ» منفصلة بدل أن تختفي بصمت أو تُنسب لشهرٍ لم تحدث فيه.
// ════════════════════════════════════════════════════════════════════════════

/** التاريخ الذي يُكتب على كل صفّ لا يحمل تاريخاً في الإكسل داخل ملف تراكمي. */
export const UNDATED_SENTINEL = new Date('1970-01-01T00:00:00.000Z');
/** أي saleDate قبل هذا الحدّ = «بلا تاريخ»، لا مبيعٌ في السبعينيات. */
export const UNDATED_CUTOFF   = new Date('2000-01-01T00:00:00.000Z');

export const isUndatedDate = (d) => d != null && new Date(d) < UNDATED_CUTOFF;

/** شرط Prisma يستبعد الصفوف بلا تاريخ. */
export const DATED_ONLY = { saleDate: { gte: UNDATED_CUTOFF } };
/** شرط Prisma يُبقي الصفوف بلا تاريخ وحدها. */
export const UNDATED_ONLY = { saleDate: { lt: UNDATED_CUTOFF } };

/**
 * يحوّل بارامتر `month` القادم من الواجهة إلى شرط saleDate.
 *
 *   'all' | '' | undefined → {}                         كل الصفوف
 *   'none'                 → الصفوف بلا تاريخ وحدها
 *   '2026-09'              → الشهر الميلادي كاملاً (بتوقيت UTC)
 *   '2026-09..2026-11'     → مدى أشهر متصل
 *
 * نهاية الشهر تُحسب كبداية الشهر التالي مع `lt` بدل `lte` على آخر يوم: الصفوف
 * المخزَّنة بتوقيت محلي (UTC+3) تقع بعد منتصف ليل اليوم الأخير بـ UTC، وكانت
 * تسقط من الشهر خطأً.
 *
 * @param {string|null|undefined} month
 * @returns {object} شرط Prisma يُنشَر داخل where
 */
export function buildMonthFilter(month) {
  const m = String(month ?? '').trim();
  if (!m || m === 'all') return {};
  if (m === 'none') return { ...UNDATED_ONLY };

  const parts = m.split('..').map(s => s.trim()).filter(Boolean);
  const first = parseMonth(parts[0]);
  const last  = parseMonth(parts[1] ?? parts[0]);
  if (!first || !last) return {};
  return { saleDate: { gte: first.start, lt: last.nextStart } };
}

function parseMonth(ym) {
  const match = /^(\d{4})-(\d{1,2})$/.exec(String(ym ?? '').trim());
  if (!match) return null;
  const year  = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return {
    start:     new Date(Date.UTC(year, month - 1, 1)),
    nextStart: new Date(Date.UTC(year, month, 1)),
  };
}

const AR_MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
  'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];

/** '2026-09' → { ym, label: 'أيلول 2026', short: '9/2026' } */
export function monthLabel(ym) {
  const parsed = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!parsed) return { ym, label: 'بلا تاريخ', short: 'بلا تاريخ' };
  const year = Number(parsed[1]);
  const mon  = Number(parsed[2]);
  return { ym, label: `${AR_MONTHS[mon - 1]} ${year}`, short: `${mon}/${year}` };
}

/**
 * الأشهر الموجودة فعلاً داخل مجموعة ملفات — لبناء شرائح اختيار الشهر.
 *
 * يُحسب في قاعدة البيانات (`date_trunc` + GROUP BY) لا بجلب الصفوف: الملف
 * التراكمي قد يحمل مئات آلاف الصفوف، وجلبها لعدّ أشهرها كان سيلتهم ذاكرة
 * السيرفر كاملةً عند كل فتح لصفحة تحليل.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number[]} fileIds
 * @param {string|null} recordType 'sale' | 'return' | null (الاثنان)
 * @returns {Promise<{ months: Array<{ym,label,short,count}>, undatedCount: number, latest: string|null }>}
 */
export async function listSalesMonths(prisma, fileIds, recordType = null) {
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return { months: [], undatedCount: 0, latest: null };
  }
  // معرّفات الملفات أعداد صحيحة مُتحقَّق منها أدناه فتُدمج في النص مباشرة:
  // تمرير مصفوفة كبارامتر لـ$queryRawUnsafe يختلف سلوكه بين المحرّكات، بينما
  // قائمة أعداد صحيحة مُصفّاة لا تحمل أي سطح حقن.
  const ids = fileIds.map(Number).filter(Number.isInteger);
  if (ids.length === 0) return { months: [], undatedCount: 0, latest: null };
  const typeClause = recordType === 'sale' || recordType === 'return'
    ? `AND "recordType" = '${recordType}'`
    : '';
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_char(date_trunc('month', "saleDate" AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
            COUNT(*)::int AS count
       FROM sales
      WHERE "uploadedFileId" IN (${ids.join(',')})
        AND "isHidden" = false
        ${typeClause}
      GROUP BY 1
      ORDER BY 1 ASC`,
  );

  const months = [];
  let undatedCount = 0;
  for (const row of rows) {
    const ym = row.ym;
    if (!ym || ym < '2000-01') { undatedCount += Number(row.count) || 0; continue; }
    months.push({ ...monthLabel(ym), count: Number(row.count) || 0 });
  }
  const latest = months.length > 0 ? months[months.length - 1].ym : null;
  return { months, undatedCount, latest };
}

/**
 * يحوّل بارامتر `month` إلى مدى تواريخ (startDate/endDate) — للمسارات التي
 * تستقبل مدىً صريحاً أصلاً (تقرير المندوب التجاري والعلمي) فلا داعي لتغيير
 * توقيعها. 'none' يُمثَّل بمدى ما قبل حدّ «بلا تاريخ» فيلتقط العلامة الحارسة
 * وحدها.
 *
 * @returns {{ startDate: Date, endDate: Date }|null} null = بلا تقييد (الكل)
 */
export function monthToRange(month) {
  const filter = buildMonthFilter(month);
  const cond = filter.saleDate;
  if (!cond) return null;
  if (cond.lt && !cond.gte) return { startDate: new Date(0), endDate: new Date(cond.lt.getTime() - 1) };
  return { startDate: cond.gte, endDate: new Date(cond.lt.getTime() - 1) };
}
