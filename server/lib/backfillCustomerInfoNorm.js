import prisma from './prisma.js';

/**
 * يعبّئ Sale.customerInfoNorm للصفوف المرفوعة قبل ميزة «حجب داخل معلومات
 * الزبون» — تلك الصفوف تحمل القيمة أصلاً ضمن rawData (كل صف محفوظ كاملاً)،
 * فنعيد استخراجها هنا بدل اشتراط إعادة رفع الملف. idempotent عبر MigrationFlag
 * (راجعه في schema.prisma): تشغيله بعد أول مرة ناجحة يتحول لاستعلام واحد بلا
 * كتابة، بدل مسح جدول Sale بالكامل عند كل إقلاع — أغلب صفوفه لا تملك عمود
 * «معلومات الزبون» أصلاً فتبقى customerInfoNorm=null للأبد، فذلك الشرط وحده
 * لا يصلح كعلامة «تم الانتهاء».
 */

const FLAG_KEY = 'customer_info_norm_backfill_v1';
const BATCH = 2000;
const CONCURRENCY = 20;

// نفس قائمة server/modules/sales/sales.service.js's COLUMN_ALIASES.customerInfo —
// مكرَّرة هنا عمداً (كما normalizeArabic مكرَّرة أصلاً بين itemResolver.js
// وsales.repository.js) كي لا يعتمد backfill لمرة واحدة على مسار الاستيراد الحي.
const CUSTOMER_INFO_ALIASES = [
  'معلومات الزبون', 'معلومات العميل', 'بيانات الزبون', 'بيانات العميل',
  'تفاصيل الزبون', 'تفاصيل العميل', 'وصف الزبون', 'وصف العميل',
  'customer info', 'customer information', 'customer details',
].map(a => a.toLowerCase());

function normalizeArabic(str) {
  return String(str)
    .trim()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ـ/g, '')
    .replace(/[ً-ٟ]/g, '')
    .replace(/[-–—,،/\\]+/g, ' ')
    .replace(/(^|\s)ال/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCustomerInfoNorm(rawData) {
  if (!rawData) return null;
  let raw;
  try { raw = JSON.parse(rawData); } catch { return null; }
  for (const key of Object.keys(raw)) {
    if (CUSTOMER_INFO_ALIASES.includes(String(key).toLowerCase().trim())) {
      const v = String(raw[key] ?? '').trim();
      if (v) return normalizeArabic(v);
    }
  }
  return null;
}

/** @returns {Promise<number>} عدد الصفوف التي عُبِّئت في هذا التشغيل (0 إن كان قد نُفِّذ من قبل) */
export async function backfillCustomerInfoNorm() {
  const already = await prisma.migrationFlag.findUnique({ where: { key: FLAG_KEY } });
  if (already) return 0;

  let cursor = 0;
  let updated = 0;
  for (;;) {
    const rows = await prisma.sale.findMany({
      where: { id: { gt: cursor }, customerInfoNorm: null, rawData: { not: null } },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { id: true, rawData: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const toUpdate = rows
      .map(r => ({ id: r.id, norm: extractCustomerInfoNorm(r.rawData) }))
      .filter(r => r.norm);

    for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
      const chunk = toUpdate.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(r => prisma.sale.update({ where: { id: r.id }, data: { customerInfoNorm: r.norm } })));
      updated += chunk.length;
    }
  }

  await prisma.migrationFlag.upsert({ where: { key: FLAG_KEY }, update: {}, create: { key: FLAG_KEY } });
  return updated;
}
