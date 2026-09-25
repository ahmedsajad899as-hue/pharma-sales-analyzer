/**
 * scoped-sales.js — مصدر واحد لصفوف المبيعات التي تقرأها صفحة Pharmacy Net.
 *
 * لماذا مُستخرَج: كانت كل من pharmacy-analysis.controller.js (تبويبا الصيدليات
 * والايتمات) و pharmacy-alerts.service.js (تبويب التنبيهات + المُجدوِل) تجلب
 * النطاق نفسه باستعلام خاص بها، ولكلٍّ نسخته من resolveFileScope ومن منطق
 * إسقاط التكرار — فاختلفت أرقام التبويبات، ودُفع ثمن الاستعلام الضخم مرتين.
 */

import prisma from '../../lib/prisma.js';
import { buildItemScopeFilter, resolveEffectiveItemIds } from '../../lib/itemScope.js';
import { resolveFileScope } from '../../lib/fileScope.js';

/** تطبيع عربي للمطابقة الضبابية. */
export function norm(s = '') {
  return String(s).trim()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ـ/g, '')
    .replace(/[ً-ٟ]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** تحويل القيمة المخزَّنة إلى الدينار حسب عملة الملف. */
export function toIQD(value, uploadedFile) {
  if (!uploadedFile) return value || 0;
  const rate = uploadedFile.exchangeRate || 1500;
  const mode = uploadedFile.currencyMode || uploadedFile.detectedCurrency || 'IQD';
  return mode === 'USD' ? (value || 0) * rate : (value || 0);
}

// المنطق في server/lib/fileScope.js — مشترك مع «تحليل الإيتم» وغيره.
// (مستورد محلياً لأن getScopedSales أدناه يستدعيه، و`export ... from` وحده
// لا يُنشئ ربطاً محلياً.)
export { resolveFileScope };

// المنطق في server/lib/crossFileDedup.js — مشترك مع «تحليل الإيتم» وغيره.
export { dedupCrossFile } from '../../lib/crossFileDedup.js';

// أعمدة Sale وحدها بلا أي علاقة متشعّبة: طلب العلاقات عبر select المتشعّب يجعل
// Prisma يبني لكل صف من الـ48 ألف كائناً متداخلاً لكل علاقة (خمسة كائنات
// إضافية للصف الواحد). نجلب الأسماء من جداولها مرة واحدة ونربطها بخرائط.
const SALE_SCALAR_SELECT = {
  id: true, quantity: true, totalValue: true, saleDate: true, recordType: true,
  uploadedFileId: true, customerId: true, itemId: true, areaId: true, representativeId: true,
};

const nameMap = async (model, ids) => {
  if (ids.length === 0) return new Map();
  const rows = await model.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map(r => [r.id, r.name]));
};

const SALES_CACHE_TTL_MS = 15000;
const salesCache = new Map(); // `${userId}|${fileIds}` -> { expiresAt, promise }

/**
 * صفوف المبيعات ضمن نطاق (مستخدم × ملفات) مع كل الحقول المشتقّة محسوبة مسبقاً.
 *
 * كل تبويب وكل فتح تفصيل كان يعيد الاستعلام والمعالجة من الصفر، لذا تُخزَّن
 * النتيجة لمدة قصيرة لكل نطاق. والحقول المشتقّة (`_`) تُحسب هنا مرة واحدة بدل
 * إعادة حسابها لكل صف في كل مسار استهلاك: التطبيع (norm) ست استبدالات regex،
 * ومفتاح اليوم إنشاء Date + تنسيق ISO — أي مئات الآلاف من العمليات لكل طلب.
 */
export async function getScopedSales(userId, fileIds) {
  const key = `${userId}|${fileIds || ''}`;
  const hit = salesCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;

  const promise = (async () => {
    const t0 = Date.now();
    const [itemScope, fileScope] = await Promise.all([
      buildItemScopeFilter(userId),
      resolveFileScope(userId, fileIds),
    ]);
    const tScope = Date.now();

    const where = { isHidden: false, ...fileScope, ...itemScope };
    const sales = await prisma.sale.findMany({
      where,
      select: SALE_SCALAR_SELECT,
      orderBy: { saleDate: 'desc' },
    });
    const tFetch = Date.now();

    const ids = (pick) => [...new Set(sales.map(pick).filter(v => v != null))];
    const [customers, items, areas, reps, files] = await Promise.all([
      nameMap(prisma.customer, ids(s => s.customerId)),
      nameMap(prisma.item, ids(s => s.itemId)),
      nameMap(prisma.area, ids(s => s.areaId)),
      nameMap(prisma.medicalRepresentative, ids(s => s.representativeId)),
      prisma.uploadedFile.findMany({
        where:  { id: { in: ids(s => s.uploadedFileId) } },
        select: { id: true, currencyMode: true, exchangeRate: true, detectedCurrency: true },
      }),
    ]);
    const fileById = new Map(files.map(f => [f.id, f]));
    const tLookup = Date.now();

    // rawData = صف الإكسل الأصلي كاملاً كـJSON لكل صف. على ملف بـ48 ألف صف هو
    // أضخم ما يُنقل من قاعدة البيانات، ولا يُستعمل إلا كخطة بديلة لاسم الصيدلية
    // حين لا يكون للصف عميل مرتبط. فيُجلب لتلك الصفوف وحدها — وفي ملف يُقرأ فيه
    // عمود العميل صحيحاً لا يُجلب إطلاقاً.
    let rawById = null;
    if (sales.some(s => s.customerId == null)) {
      const rawRows = await prisma.sale.findMany({
        where:  { ...where, customerId: null },
        select: { id: true, rawData: true },
      });
      rawById = new Map(rawRows.map(r => [r.id, r.rawData]));
    }

    for (const s of sales) {
      let pharmaName = (s.customerId != null ? customers.get(s.customerId) : null) || null;
      const rawJson = pharmaName ? null : rawById?.get(s.id);
      if (rawJson) {
        try {
          const raw = JSON.parse(rawJson);
          pharmaName = raw.pharmacyName || raw.pharmacy || raw.customer || raw.Customer || raw['اسم الصيدلية'] || raw['الصيدلية'] || raw['العميل'] || null;
        } catch { /* صف بلا rawData صالح */ }
      }
      const itemName = items.get(s.itemId) || '';
      const repName  = reps.get(s.representativeId) || '';

      s._pharmaName = pharmaName;
      s._itemName   = itemName;
      s._areaName   = areas.get(s.areaId) || '';
      s._repName    = repName;
      s._normPharma = pharmaName ? norm(pharmaName) : '';
      s._normItem   = norm(itemName);
      s._normRep    = repName ? norm(repName) : '';
      s._day        = dayKey(s.saleDate);
      s._iqd        = toIQD(s.totalValue, fileById.get(s.uploadedFileId));
      s._isReturn   = s.recordType === 'return';
      // مقارنات التواريخ في حلقات التجميع كانت تُنشئ كائنَي Date لكل صف
      // (‏new Date(a) > new Date(b)‎) — أي عشرات آلاف الكائنات لكل طلب.
      s._ts         = s.saleDate ? s.saleDate.getTime() : 0;
    }
    const tDerive = Date.now();

    console.log(`[pharmacy-net] scope=${tScope - t0}ms fetch=${tFetch - tScope}ms lookups=${tLookup - tFetch}ms derive=${tDerive - tLookup}ms rows=${sales.length}`);
    return sales;
  })();

  const entry = { expiresAt: Date.now() + SALES_CACHE_TTL_MS, promise };
  salesCache.set(key, entry);
  promise.catch(() => salesCache.delete(key)); // لا تُخزَّن نتيجة فاشلة
  setTimeout(() => { if (salesCache.get(key) === entry) salesCache.delete(key); }, SALES_CACHE_TTL_MS + 2000);
  return promise;
}

/**
 * ايتمات نطاق «شركة رئيسية» بعينها: مدير الشركة (company_manager) صاحب
 * التعيين الأساسي (isPrimary) هو مصدر UserItemAssignment — لا مطابقة اسم
 * الشركة في عمود الإكسل. مُستخرَجة لتُستعمل من applyRosterFilters (اختيار
 * الشريط) ومن resolveSearchTerms في الكنترولر (كتابة اسم الشركة في خانة
 * البحث) معاً.
 *
 * @returns {Promise<{valid: boolean, itemIds: number[]|null}>} valid=false يعني
 *   شركة بلا مدير قابل للتحديد؛ itemIds=null (مع valid=true) يعني بلا تقييد.
 */
export async function resolveCompanyItemScope(companyId) {
  const mgrAssignment = await prisma.userCompanyAssignment.findFirst({
    where: { companyId, isPrimary: true, user: { role: 'company_manager', isActive: true } },
    select: { userId: true },
  });
  if (!mgrAssignment) return { valid: false, itemIds: null };
  const itemIds = await resolveEffectiveItemIds(mgrAssignment.userId);
  return { valid: true, itemIds };
}

/**
 * مناطق «مندوب علمي» بعينه — بنفس منطق توسيع الاسم المطبَّع المستخدم في
 * resolveSciRepSales، لأن نفس المنطقة قد تتكرر بمعرّفات مختلفة عبر
 * الحسابات/الملفات (راجع مذكرة duplicate-area-bug). مُستخرَجة لنفس سبب
 * resolveCompanyItemScope أعلاه.
 */
export async function resolveRepAreaScopeIds(repId) {
  const areaLinks = await prisma.scientificRepArea.findMany({ where: { scientificRepId: repId }, select: { areaId: true } });
  const directIds = areaLinks.map(a => a.areaId);
  const areaIdSet = new Set(directIds);
  if (directIds.length > 0) {
    const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
    const directSet = new Set(directIds);
    const assignedNorms = new Set(allAreas.filter(a => directSet.has(a.id)).map(a => norm(a.name)));
    for (const a of allAreas) if (assignedNorms.has(norm(a.name))) areaIdSet.add(a.id);
  }
  return areaIdSet;
}

/**
 * فلترة «الشركة الرئيسية»/«المندوب» على صفوف Sale المُحمَّلة مسبقاً (getScopedSales).
 *
 * كل «شركة» في الشريط هي نطاق مدير شركة (company_manager) بعينه ضمن نفس
 * المكتب — لا نص «الشركة» الحر في عمود الإكسل. اختيار مندوب دون شركة (حسابات
 * بلا هيكل مكتب) يستعمل ايتمات المندوب نفسه.
 *
 * مشتركة بين تبويبات الصيدليات/الايتمات/التنبيهات كلها (وحساب التنبيهات
 * التلقائية في pharmacy-alerts.service.js) — نفس الشريط، نفس منطق النطاق، لا
 * نسخة موازية لكل تبويب.
 *
 * @param {Array} sales
 * @param {{companyId?: number|null, repId?: number|null, repUserId?: number|null}} opts
 */
export async function applyRosterFilters(sales, { companyId, repId, repUserId }) {
  let allowedItemIds = null; // null = بلا تقييد
  if (companyId) {
    const scope = await resolveCompanyItemScope(companyId);
    if (!scope.valid) return []; // شركة بلا مدير قابل للتحديد — لا نُظهر بيانات غير موثوقة النطاق
    allowedItemIds = scope.itemIds;
  } else if (repUserId) {
    allowedItemIds = await resolveEffectiveItemIds(repUserId);
  }

  if (allowedItemIds) { // null = بلا تقييد (كل الايتمات)
    const idSet = new Set(allowedItemIds);
    sales = sales.filter(s => idSet.has(s.itemId));
  }

  if (repId) {
    const areaIdSet = await resolveRepAreaScopeIds(repId);
    sales = sales.filter(s => areaIdSet.has(s.areaId));
  }

  return sales;
}
