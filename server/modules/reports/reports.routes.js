/**
 * Reports Routes
 * GET /api/reports/representative/:id
 * GET /api/reports/overall
 */

import { Router } from 'express';
import { getRepresentativeReport } from '../representatives/representatives.controller.js';
import { COLUMN_ALIASES, detectMercatoFormat } from '../sales/sales.service.js';
import { saleValueUSD } from '../sales/sales.repository.js';
import prisma from '../../lib/prisma.js';
import { resolveEffectiveAreaIds } from '../../lib/areaScope.js';
import { buildItemScopeFilter } from '../../lib/itemScope.js';
import { extractCompanyFromCode, isPlaceholderCompanyValue } from '../../lib/companyResolver.js';
import { normalizeItemKey } from '../../lib/itemResolver.js';
import { PROVINCE_COLUMN_ALIASES, extractRawColumnValue, buildProvinceLookup, matchProvinceName } from '../../lib/provinces.js';
import { isWarehouseSaleRow, pharmacyNameFromRawData } from '../../lib/orderKey.js';

const router = Router();

/** عمود «غير مصنّف» في جدول محافظة × شركة: مبيع لم يُطابَق أي تيم مكتب. */
const UNASSIGNED_COMPANY = 'غير مصنّف';

/**
 * «تيمات» المكتب: كل حساب «مدير شركة» (company_manager) في نفس officeId
 * الطالب، باسم عرض = شركته الرئيسية (UserCompanyAssignment.isPrimary)، و
 * `itemIds` = الايتمات المُسنَدة له عبر «الايتمات» في السوبر أدمن
 * (UserItemAssignment) — وهي وحدها ما يُحتسب مبيعاً لذلك التيم.
 *
 * الشركة تحدّد **اسم** التيم فقط، لا مبيعه: «مبيع الشركة المختارة = ايتمات
 * مديرها حصراً لا كل ايتمات الشركة» (طلب صريح). فايتم من شركة deva مُسنَد
 * لمدير humanis يُحتسب لـhumanis، وايتم deva غير مُسنَد لأحد لا يُحتسب لأحد.
 *
 * مشتركة بين /overall-teams (شرائح الفلترة) و/overall (تجميع «محافظة × شركة»).
 */
async function loadOfficeTeams(userId) {
  if (!userId) return [];
  const viewer = await prisma.user.findUnique({ where: { id: userId }, select: { officeId: true } });
  if (viewer?.officeId == null) return [];

  const managers = await prisma.user.findMany({
    where: { officeId: viewer.officeId, role: 'company_manager', isActive: true },
    select: { id: true, displayName: true, username: true },
    orderBy: { id: 'asc' },
  });
  if (managers.length === 0) return [];

  const assignments = await prisma.userCompanyAssignment.findMany({
    where: { userId: { in: managers.map(m => m.id) } },
    select: { userId: true, isPrimary: true, company: { select: { id: true, name: true } } },
  });
  const byManager = new Map();
  for (const a of assignments) {
    if (!byManager.has(a.userId)) byManager.set(a.userId, []);
    byManager.get(a.userId).push(a);
  }

  /**
   * ايتم مُسنَد لأكثر من مدير (غير موجود حالياً في بيانات المكتب): يفوز مالك
   * شركته — التيم الذي هي شركته الرئيسية — وإلا أصغر id. قرار ثابت لا يتبدّل
   * بترتيب العرض، فلا يُحتسب مبيع الايتم نفسه لتيمين.
   */
  const ownerByCompany = new Map(); // companyId -> managerId (للترجيح فقط)
  for (const a of assignments) {
    const prev = ownerByCompany.get(a.company.id);
    if (prev == null || (a.isPrimary && prev !== a.userId)) ownerByCompany.set(a.company.id, a.userId);
  }

  const itemAssignments = await prisma.userItemAssignment.findMany({
    where: { userId: { in: managers.map(m => m.id) } },
    select: { userId: true, item: { select: { id: true, scientificCompanyId: true } } },
  });
  const claimsByItem = new Map();
  for (const a of itemAssignments) {
    if (!claimsByItem.has(a.item.id)) claimsByItem.set(a.item.id, []);
    claimsByItem.get(a.item.id).push(a);
  }
  const ownedItemsByManager = new Map();
  for (const [iid, rows] of claimsByItem) {
    const ordered = [...rows].sort((x, y) => x.userId - y.userId);
    const companyOwnerId = ownerByCompany.get(ordered[0].item.scientificCompanyId);
    const owner = ordered.find(r => r.userId === companyOwnerId) ?? ordered[0];
    if (!ownedItemsByManager.has(owner.userId)) ownedItemsByManager.set(owner.userId, []);
    ownedItemsByManager.get(owner.userId).push(iid);
  }

  return managers
    .map(m => {
      const rows = byManager.get(m.id) ?? [];
      if (rows.length === 0) return null;
      const primary = rows.find(r => r.isPrimary) ?? rows[0];
      return {
        managerId: m.id,
        managerName: m.displayName || m.username,
        name: primary.company.name,
        // ايتمات هذا المدير — المصدر الوحيد لمبيع تيمه.
        itemIds: ownedItemsByManager.get(m.id) ?? [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

router.get('/representative/:id', getRepresentativeReport);

/**
 * GET /api/reports/overall
 * Overall aggregated report across all files (or filtered files).
 * Query params: fileIds, startDate, endDate, recordType
 * Returns: { totalQuantity, totalValue, byItem, byArea }
 */
router.get('/overall', async (req, res) => {
  try {
    const { fileIds, startDate, endDate, recordType, teamManagerId } = req.query;
    const userId = req.user?.id ?? null;

    const parsedFileIds = fileIds
      ? String(fileIds).split(',').map(Number).filter(Boolean)
      : [];

    // Scope: rely on fileIds (user already sees only their own files from /api/files endpoint)
    // Keeping userId filter only as a fallback when no fileIds provided
    const userOwnershipFilter = (userId && parsedFileIds.length === 0) ? { uploadedFile: { userId } } : {};

    // ── Area filter: when the current user is viewing a file shared WITH them
    //    (not owned by them), restrict results to their assigned areas only ──
    let areaFilter = {};
    // نطاق ايتمات المستخدم (تبويب «الايتمات»): إن حُدِّدت ايتمات فالمبيع
    // والإرجاع يُحسبان عليها فقط. فارغة = بلا تقييد.
    const itemScopeFilter = await buildItemScopeFilter(userId);

    // «الشركة الرئيسية» لتبويب المحافظة × الشركة: اسم الكروب الذي يمثّله مدير
    // الشركة (قد يضمّ أكثر من ScientificCompany وأكثر من ايتم) — لا اسم الشركة
    // الخام المستخرَج من كل صف. راجع loadOfficeTeams. فهرسان: بالمعرّف
    // (scientificCompanyId، الأدقّ) وبالاسم المطبَّع (ايتمات لم تُربط بعد
    // بـScientificCompany — عبرها فقط Company القديم أو نص rawData — فيفشل
    // فهرس المعرّف رغم أن اسم الشركة نفسه مطابق تماماً لاسم شركة في التيم،
    // وكانت هذه الشركة تختفي كاملةً من هذا الجدول رغم وجود بيانات فعلية لها).
    const officeTeams = await loadOfficeTeams(userId);

    // ── فلتر «التيم» (اختياري) — عزل مبيع/ارجاع تيم واحد داخل المكتب ─────────
    // تيم = حساب مدير شركة (company_manager) واحد + ما **يملكه**: ايتماته
    // المُسنَدة مباشرةً، ثم شركاته (راجع ownerByItem/ownerByCompany في
    // loadOfficeTeams) — لا كل شركة أو ايتم مُنِح وصولاً إليه.
    // هذا ما يجعل رقم الشريحة ورقم عمودها في جدول محافظة×شركة من مصدر واحد:
    // سابقاً كانت الشريحة تُفلتر بكل إسنادات المدير (الثانوية أيضاً) بينما
    // العمود يُنسَب بالملكية، فشريحة «humanis» تعرض مبيع deva/osel/Marcyrl
    // ضمنها ثم يوزّعه الجدول على أعمدتها — رقمان مختلفان لنفس المحافظة.
    // يُبنى بمعرّفات الشركة الحقيقية لا بمطابقة اسم نصي (أسماء مكرَّرة بحالة
    // أحرف مختلفة: HUMANIS/humanis).
    const mgrId = teamManagerId ? Number(teamManagerId) : 0;
    // officeTeams محصورة أصلاً بمدراء الشركات النشطين في مكتب الطالب، فالعضوية
    // فيها هي نفسها فحص الصلاحية الذي كان يتم باستعلام منفصل.
    const selectedTeam = mgrId ? (officeTeams.find(t => t.managerId === mgrId) ?? null) : null;
    // مصدر النسبة الوحيد: الايتم مُسنَد لمدير عبر «الايتمات» في السوبر أدمن.
    // لا رجوع لشركة الايتم ولا لاسمها النصي — طلب صريح: «مبيع الشركة المختارة =
    // ايتمات مديرها حصراً، لا كل ايتمات الشركة». ايتم غير مُسنَد لأي مدير لا
    // يُنسَب لأحد (ويسقط من تبويب المحافظة كبقية غير المصنّف).
    const itemIdToTeamName = new Map();
    for (const team of officeTeams) {
      for (const iid of team.itemIds) itemIdToTeamName.set(iid, team.name);
    }

    // ── وضع «تحليل كامل» (raw=1) ────────────────────────────────────────────
    // يتجاوز قائمة ايتمات الحساب *ونطاق مناطقه* معاً ليعرض بيانات الملف كاملة
    // تماماً كما يراها صاحبه. مسموح لأي مستخدم له صلاحية وصول فعلية على كل
    // الملفات المطلوبة — مالك أو مُشارَك معه عبر FileUserShare (نفس شرط
    // resolveFileScope في fileScope.js) — بطلب صريح: عند مشاركة ملف مع عدة
    // أشخاص، «تحليل كامل» يُسوّي بينهم جميعاً وبين صاحب الملف، فلا يبقى كل
    // واحد مقيَّداً بمناطقه/ايتماته الشخصية عند الضغط على هذا الزر تحديداً.
    const rawRequested = String(req.query.raw ?? '') === '1';
    let rawApplied = false;
    if (rawRequested && userId && parsedFileIds.length > 0) {
      const accessibleCount = await prisma.uploadedFile.count({
        where: { id: { in: parsedFileIds }, OR: [{ userId }, { fileShares: { some: { userId } } }] },
      });
      rawApplied = accessibleCount === parsedFileIds.length;
    }
    const effectiveItemScope = rawApplied ? {} : itemScopeFilter;
    // «التحليل الشامل» مُستثنى عمداً من خاصية الحجب (BlockedArea/Item/
    // CommercialRep/Pharmacy) — بطلب صريح: الحجب يخصّ تقرير «علمي» فقط
    // (resolveSciRepSales في scientific-reps.service.js)، ولا يجوز أن يمسّ
    // نتائج أو بيانات هذه الشاشة إطلاقاً، سواء كان الملف مملوكاً أو مُشارَكاً.
    // نطاق المناطق (لا علاقة له بالحجب) يبقى مُطبَّقاً على الملفات المُشارَكة —
    // إلا حين طُبِّق «تحليل كامل» فعلاً (rawApplied)، فيُلغى هذا القيد أيضاً كي
    // يرى المُشارَك معه كامل بيانات الملف تماماً كصاحبه، لا مناطقه هو فقط.
    // UserAreaAssignment ∪ ScientificRepArea ∪ مناطق المحافظات المعيّنة —
    // موحَّد في areaScope.js ليشمل توسيع المحافظات، وليعطي اتحاداً بدل «أول
    // مصدر غير فارغ» (مستخدم له مناطق يدوية ومحافظة كان يفقد الثانية).
    if (!rawApplied && userId && parsedFileIds.length > 0) {
      const sharedFiles = await prisma.uploadedFile.count({
        where: { id: { in: parsedFileIds }, NOT: { userId }, fileShares: { some: { userId } } },
      });
      if (sharedFiles > 0) {
        const areaIds = await resolveEffectiveAreaIds(userId);
        if (areaIds.length > 0) {
          areaFilter = { areaId: { in: areaIds } };
        }
      }
    }

    const fileFilter = parsedFileIds.length === 0
      ? {}
      : parsedFileIds.length === 1
        ? { uploadedFileId: parsedFileIds[0] }
        : { uploadedFileId: { in: parsedFileIds } };

    console.log('[overall] userId:', userId, '| fileIds:', parsedFileIds, '| recordType:', recordType);

    // Quick count without any date filter — to see if records exist at all
    const rawCount = await prisma.sale.count({
      where: { isHidden: false, ...fileFilter, ...(recordType ? { recordType } : {}) },
    });
    const ownedCount = await prisma.sale.count({
      where: { isHidden: false, ...fileFilter, ...userOwnershipFilter, ...(recordType ? { recordType } : {}) },
    });
    console.log('[overall] rawCount (no userId filter):', rawCount, '| ownedCount (with userId filter):', ownedCount);

    // If no date filter provided, auto-detect the real date range from the file
    let effectiveStartDate = startDate ? new Date(startDate) : null;
    // For endDate, extend to end-of-day to include all records on that day regardless of
    // stored time component. e.g. "2026-04-21" → 2026-04-21T23:59:59.999Z so records
    // stored as midnight local time (= 2026-04-20T21:00:00Z in UTC+3) are still included.
    let effectiveEndDate = endDate
      ? (() => { const d = new Date(endDate); d.setUTCHours(23, 59, 59, 999); return d; })()
      : null;

    // استبعاد صفوف «التاريخ الافتراضي» لكل ملف على حدة: صفوف لم يحمل الإكسل لها
    // تاريخاً فأخذت saleDate = @default(now()) ≈ لحظة رفع الملف. لكل ملف حدّه
    // (uploadedAt) — لا مدى عام واحد: المدى العام كان يُسقط ملفاً كاملاً كل صفوفه
    // بلا تاريخ (ملف ستوك مثلاً) فيختفي الملف الثاني بصمت في التحليل متعدد الملفات.
    //
    // ⚠️ يُطبَّق دائماً — لا عند غياب التواريخ فقط. سابقاً كان مقصوراً على حالة
    // «بلا تواريخ»، فيعطي نفس الشاشة رقمين مختلفين للإرجاع: التحليل التلقائي
    // يُسقط الصفوف بلا تاريخ، ثم مدىً صريح يشمل يومَ الرفع يُعيدها كلها. النتيجة
    // أن تضييق المدى كان يرفع الإجمالي بدل أن يخفضه — وهو مستحيل منطقياً.
    let noDateFileFilter = null;
    if (parsedFileIds.length > 0) {
      const fileRecords = await prisma.uploadedFile.findMany({
        where: { id: { in: parsedFileIds } },
        select: { id: true, uploadedAt: true },
      });
      const orConds = [];
      for (const f of fileRecords) {
        if (!f.uploadedAt) { orConds.push({ uploadedFileId: f.id }); continue; }
        const up = new Date(f.uploadedAt);
        // Keep this file's rows dated before its own upload moment. If it has NONE
        // (all rows date-defaulted), keep ALL its rows rather than dropping the file.
        const realCount = await prisma.sale.count({
          where: { uploadedFileId: f.id, isHidden: false, ...(recordType ? { recordType } : {}), saleDate: { lt: up } },
        });
        orConds.push(realCount > 0 ? { uploadedFileId: f.id, saleDate: { lt: up } } : { uploadedFileId: f.id });
      }
      if (orConds.length > 0) noDateFileFilter = { OR: orConds };
    }

    // حارس الصفوف بلا تاريخ + المدى الصريح يُطبَّقان معاً (AND): الأول يحدّد ما
    // يُعتدّ بتاريخه أصلاً، والثاني يقصّ داخله. فرعا الـOR يحملان saleDate خاصاً
    // بكل ملف، وهو مستوى مستقل عن saleDate الأعلى فلا يتعارضان.
    const explicitRange = (effectiveStartDate || effectiveEndDate) ? {
      saleDate: {
        ...(effectiveStartDate ? { gte: effectiveStartDate } : {}),
        ...(effectiveEndDate   ? { lte: effectiveEndDate   } : {}),
      },
    } : {};
    // فلتر الشريحة = نفس قاعدة النسبة أدناه حرفياً: ايتمات ذلك المدير وحدها.
    // تيم بلا ايتمات مُسنَدة = لا صفوف له (`in: []`) — لا «بلا فلتر»؛ الثانية
    // كانت ستعرض مبيع المكتب كله تحت اسم ذلك التيم.
    //
    // ⚠️ يُغلَّف بـ`AND`: المفتاح `itemId` مشغول أصلاً بنطاق ايتمات الطالب
    // (effectiveItemScope) المنشور في نفس الكائن، ونشر مفتاحين متطابقين يُلغي
    // أحدهما بصمت. نفس السبب يمنع استعمال `OR` هنا (محجوز لـnoDateFileFilter).
    const teamCompanyFilter = selectedTeam
      ? { AND: [{ itemId: { in: selectedTeam.itemIds } }] }
      : {};
    const baseWhere = {
      isHidden: false,
      ...fileFilter,
      ...userOwnershipFilter,
      ...areaFilter,
      // نطاق ايتمات الطالب وحده يُطبَّق — حتى مع اختيار شريحة تيم. سابقاً كانت
      // الشريحة تستبدل به قائمة ايتمات ذلك المدير الشخصية («ليرى الطالبُ ما
      // يراه هو»)، وهذا ما كان يُفرّغ شريحة deva تماماً: مديرها مُسنَد على 27
      // ايتماً من كتالوج شركته بينما مبيع الملفات يشير لصفوف Item أخرى لنفس
      // الشركة — فتعود الشريحة بصفر رغم وجود مبيع فعلي لها. عزلُ التيم يتم
      // بشركاته المملوكة (teamCompanyFilter) وهو كافٍ ودقيق، كما يضمن أن
      // مجموع الشرائح = «الكل» بدل أن يتبدّل نطاق الايتمات مع كل شريحة.
      ...effectiveItemScope,
      ...teamCompanyFilter,
      ...(recordType ? { recordType } : {}),
    };
    const where = {
      ...baseWhere,
      ...(noDateFileFilter ?? {}),
      ...explicitRange,
    };

    // كم صفاً أسقطه حارسُ «بلا تاريخ»؟ نُرجعه للواجهة كي لا يكون الاستبعاد صامتاً:
    // المستخدم يرى «مبيع/ارجاع» أقل مما في الإكسل ولا يعرف السبب. عدّة واحدة
    // فقط — الطرف الآخر هو sales.length بعد الجلب أدناه.
    const countWithUndated = noDateFileFilter
      ? await prisma.sale.count({ where: { ...baseWhere, ...explicitRange } })
      : 0;

    // Column names that represent "product/item code" in uploaded files —
    // these often contain the company name (e.g. "HUMANISTurkeyN/A")
    const COMPANY_CODE_KEYS = [
      'رقم المادة', 'رقم الماده', 'رقم مادة', 'رقم الماد', 'كود المادة',
      'product code', 'item code', 'material code', 'material no', 'item no',
      'code', 'كود', 'رقم',
    ];

    // في ملف ميركاتو «اسم الشركة» هو الصيدلية المشترية لا الشركة المصنّعة (راجع
    // mercatoColumnMap في sales.service.js) — بينما COLUMN_ALIASES.company يتضمّنها
    // لأنها تعني الشركة فعلاً في ملفات أخرى. بلا هذا الاستثناء كانت أسماء الصيدليات
    // تظهر ضمن تبويب «الشركة» بالتحليل الشامل لكل ايتم لم يُربَط بعد بشركة حقيقية
    // (Item.companyId فارغ) فيسقط extractCompanyFromRaw للأولوية 1 على هذا العمود.
    const MERCATO_PHARMACY_ALIASES = new Set(['اسم الشركة', 'اسم الشركه']);
    const companyAliasesFor = (isMercato) =>
      isMercato ? COLUMN_ALIASES.company.filter(a => !MERCATO_PHARMACY_ALIASES.has(a)) : COLUMN_ALIASES.company;

    const extractCompanyFromRaw = (rawData) => {
      if (!rawData) return null;
      try {
        const raw = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        const isMercato = detectMercatoFormat(Object.keys(raw));
        // ميركاتو: «الصنف» هو الشركة المصنّعة الفعلية (Deva/HUMANIS...) — أولوية قصوى
        // قبل أي محاولة عامة، فلا تصل القراءة إلى عمود الصيدلية أصلاً.
        if (isMercato) {
          for (const key of ['الصنف', 'صنف']) {
            if (raw[key] && String(raw[key]).trim() && !isPlaceholderCompanyValue(raw[key])) return String(raw[key]).trim();
          }
        }
        // Priority 1: an actual "company name" column (الشركة/company/المورد/...) —
        // this is the real source of truth when present, even if its value is a
        // messy concatenation like "HUMANISTurkeyN/A".
        for (const key of companyAliasesFor(isMercato)) {
          if (raw[key] && String(raw[key]).trim() && !isPlaceholderCompanyValue(raw[key])) return String(raw[key]).trim();
        }
        // Priority 2: known "item/material code" columns, which on some files
        // carry the company name instead (e.g. "رقم المادة" → "HUMANISTurkeyN/A").
        for (const key of COMPANY_CODE_KEYS) {
          if (raw[key] && String(raw[key]).trim() && !isPlaceholderCompanyValue(raw[key])) return String(raw[key]).trim();
        }
        // Priority 3: scan remaining keys for one whose value looks like a company
        // code (Latin letters only, no spaces). Restricted to "code"/"كود" headers —
        // NOT a bare "رقم"/"number" substring, which also matches invoice/order
        // number columns ("رقم الفاتورة") and was wrongly picking up invoice
        // numbers as the "company name".
        for (const [k, v] of Object.entries(raw)) {
          const val = String(v || '').trim();
          if (val && !isPlaceholderCompanyValue(val) && /^[A-Za-z0-9/\-_]+$/.test(val) && val.length > 3 && val.length < 40) {
            const keyLower = k.toLowerCase();
            const looksLikeInvoiceOrOrder = keyLower.includes('فاتورة') || keyLower.includes('فاتوره') || keyLower.includes('invoice') || keyLower.includes('طلب') || keyLower.includes('order');
            if (!looksLikeInvoiceOrOrder && (keyLower.includes('code') || keyLower.includes('كود'))) {
              return val;
            }
          }
        }
      } catch { /* ignore */ }
      return null;
    };

    // المحافظة لكل صف: المصدر الأول دائماً Area.provinceId — تصنيف السوبر أدمن
    // الرسمي في خانة «المناطق» (server/lib/provinces.js)، لأنه الثابت المعتمَد
    // ومحافظاته الـ18 أسماء رسمية واحدة. عمود المحافظة الخام في الملف نفسه كان
    // يفوز سابقاً فيُنتج صفوفاً مكرَّرة لنفس المحافظة بصياغات مختلفة («بصرة» و
    // «البصرة» معاً، أو «الموصل»/«الديوانية» بدل الاسم الرسمي «نينوى»/«القادسية»)
    // رغم أن المنطقة نفسها مُسنَدة فعلاً لمحافظتها الصحيحة. الآن هو احتياطي فقط
    // لمنطقة لم تُسنَد بعد لأي محافظة في النظام — ويُمرَّر عبر نفس جدول محافظات
    // السوبر أدمن (matchProvinceName) ليُطبَّع لاسمها الرسمي بدل نصّه الخام حرفياً
    // حين يطابق اسماً أو alias معروفاً. الأخير إطلاقاً: اسم المنطقة نفسه.
    const extractProvinceFromRaw = (rawData) => {
      if (!rawData) return null;
      try {
        const raw = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        return extractRawColumnValue(raw, PROVINCE_COLUMN_ALIASES);
      } catch { return null; }
    };
    const provinceLookup = buildProvinceLookup(await prisma.province.findMany());
    const resolveRawProvinceName = (rawData) => {
      const raw = extractProvinceFromRaw(rawData);
      if (!raw) return null;
      return matchProvinceName(raw, provinceLookup)?.name ?? raw;
    };

    const sales = await prisma.sale.findMany({
      where,
      select: {
        quantity:   true,
        totalValue: true,
        saleDate:   true,
        rawData:    true,
        area: { select: { id: true, name: true, province: { select: { name: true } } } },
        item: { select: { id: true, name: true, company: { select: { id: true, name: true } }, scientificCompany: { select: { id: true, name: true } } } },
        representative: { select: { id: true, name: true } },
        // Per-file currency → normalize each row to USD before summing, so mixing
        // files of different currencies (USD + IQD) produces a correct total.
        uploadedFile: { select: { detectedCurrency: true, exchangeRate: true } },
      },
    });

    // Aggregate in-memory by item, by area, by area+item, and by company
    const itemMap     = new Map();
    const areaMap     = new Map();
    const areaItemMap = new Map(); // key: "areaName::itemName"
    const companyMap  = new Map(); // key: مفتاح موحَّد (طبّع + قُطعت لاحقة الدولة)
    const provinceMap = new Map(); // key: اسم المحافظة (أو اسم المنطقة حين لا محافظة في الملف)
    const provinceCompanyMap = new Map(); // key: "اسم المحافظة::مفتاح الشركة الموحَّد"
    const provinceItemMap = new Map(); // key: "اسم المحافظة::مفتاح الايتم"
    // مذاخر بغداد: صفوف مبيع تجارية بمحافظة بغداد وُسِمَت "مذخر" في عمود الصنف
    // الخام (isWarehouseSaleRow) — لا علاقة لها بتبويب «المحافظة» أعلاه (ذاك
    // يستبعد الايتمات غير المُسنَدة لتيم؛ هذا يشمل كل الصفوف بلا قيد تيم، لأن
    // الطلب هنا هو مندوب × مذخر لا شركة). مفتاح: اسم المندوب × اسم المذخر ×
    // اسم الايتم، كي يبني الفرونت-إند منه كلاً من إجمالي كل (مندوب، مذخر) وتفصيل
    // الايتمات داخله دون استعلام إضافي.
    const baghdadWarehouseMap = new Map(); // key: "المندوب::المذخر::الايتم"
    // اسم عرض واحد لكل شركة موحَّدة — أول صيغة تُصادَف تصير العرض الثابت لبقية
    // الصفوف. بدونها: نفس الشركة تظهر DevaTurkeyN/A و deva و DEVA في 3 صفوف
    // منفصلة، لأن رقم المادة الخام وحقل «الشركة» يُكتَبان بصيغ مختلفة صفاً
    // بصف — والتجميع بالنص الحرفي لا يرى أنها نفس الشركة.
    const companyDisplayByKey = new Map();
    const canonicalCompany = (raw) => {
      if (!raw || isPlaceholderCompanyValue(raw)) return null;
      const stripped = extractCompanyFromCode(raw) || raw;
      if (isPlaceholderCompanyValue(stripped)) return null;
      const key = normalizeItemKey(stripped);
      if (!key) return null;
      if (!companyDisplayByKey.has(key)) companyDisplayByKey.set(key, stripped);
      return { key, display: companyDisplayByKey.get(key) };
    };
    let totalQuantity = 0;
    let totalValue    = 0;
    let minDate = null;
    let maxDate = null;

    for (const s of sales) {
      const qty = s.quantity   || 0;
      const val = saleValueUSD(s);   // normalized to USD using this row's file currency
      totalQuantity += qty;
      totalValue    += val;

      // Track date range
      if (s.saleDate) {
        if (!minDate || s.saleDate < minDate) minDate = s.saleDate;
        if (!maxDate || s.saleDate > maxDate) maxDate = s.saleDate;
      }

      // ترتيب الأولوية: (1) محافظة المنطقة المُسنَدة فعلاً في النظام
      // (Area.provinceId — تُحسَم تلقائياً أو يدوياً عبر السوبر أدمن، راجع
      // server/lib/provinces.js) — هذه ما تجعل «الحارثية»/«المنصور»/«حي
      // العامل»... تُجمَّع تحت «بغداد» بالاسم الرسمي الموحَّد حتى لو خلا
      // الملف من عمود محافظة أصلاً، أو حمل اسماً مختلفاً عنه. (2) عمود
      // المحافظة الخام في الملف نفسه — فقط حين لا تملك المنطقة محافظة مُسنَدة
      // بعد — مُطبَّعاً لاسمه الرسمي عبر جدول محافظات السوبر أدمن. (3) لا يوجد
      // أي مصدر — اسم المنطقة نفسه، طلب صريح بدل إسقاط الصف.
      const provinceName = s.area?.province?.name || resolveRawProvinceName(s.rawData) || s.area?.name || null;

      let rowCompany = null; // الشركة المحسومة لهذا الصف — تُستعمل أدناه خارج هذا الفرع
      if (s.item) {
        const key = s.item.id;
        // Priority: DB company relation → scientificCompany relation → rawData column
        const rawCompanyName = s.item.company?.name ?? s.item.scientificCompany?.name ?? extractCompanyFromRaw(s.rawData) ?? null;
        const company = canonicalCompany(rawCompanyName);
        const companyName = company?.display ?? null;
        if (!itemMap.has(key)) itemMap.set(key, { itemName: s.item.name, companyName, totalQuantity: 0, totalValue: 0 });
        else if (!itemMap.get(key).companyName && companyName) itemMap.get(key).companyName = companyName;
        const r = itemMap.get(key);
        r.totalQuantity += qty;
        r.totalValue    += val;
        // company aggregation — مفتاح موحَّد لا الاسم الخام
        if (company) {
          if (!companyMap.has(company.key)) companyMap.set(company.key, { companyName: company.display, totalQuantity: 0, totalValue: 0 });
          const cr = companyMap.get(company.key);
          cr.totalQuantity += qty;
          cr.totalValue    += val;
        }
        rowCompany = company;
      }

      // محافظة (الإجمالي) ومحافظة × شركة رئيسية — لتبويب «المحافظة». «الشركة»
      // هنا = شرائح «الشركة الرئيسية» نفسها (officeTeams، كروب مدير الشركة) لا
      // اسم الشركة الخام لكل ايتم.
      //
      // النسبة بالايتم المُسنَد وحده (نفس فلتر الشريحة أعلاه). ايتم لم يُسنَد
      // لأي مدير يُستبعَد بالكامل من هذا التبويب — بطلب صريح: لا عمود/قيمة
      // «غير مصنّف» ولا ضمن إجمالي المحافظة. استبعاد مقصود يخصّ تبويب المحافظة
      // وحده؛ لا يمسّ byItem/byArea/byCompany أعلاه.
      const teamName = (s.item?.id != null ? itemIdToTeamName.get(s.item.id) : null)
        ?? UNASSIGNED_COMPANY;

      if (provinceName && teamName !== UNASSIGNED_COMPANY) {
        if (!provinceMap.has(provinceName)) provinceMap.set(provinceName, { provinceName, totalQuantity: 0, totalValue: 0 });
        const pr = provinceMap.get(provinceName);
        pr.totalQuantity += qty;
        pr.totalValue    += val;

        const pcKey = `${provinceName}::${normalizeItemKey(teamName)}`;
        if (!provinceCompanyMap.has(pcKey)) provinceCompanyMap.set(pcKey, { provinceName, companyName: teamName, totalQuantity: 0, totalValue: 0 });
        const pcr = provinceCompanyMap.get(pcKey);
        pcr.totalQuantity += qty;
        pcr.totalValue    += val;

        if (s.item) {
          const piKey = `${provinceName}::${normalizeItemKey(s.item.name)}`;
          if (!provinceItemMap.has(piKey)) provinceItemMap.set(piKey, { provinceName, itemName: s.item.name, totalQuantity: 0 });
          provinceItemMap.get(piKey).totalQuantity += qty;
        }
      }

      if (provinceName === 'بغداد' && isWarehouseSaleRow(s.rawData)) {
        const repName = s.representative?.name || 'غير محدد';
        // هوية المذخر = عمود العميل/الصيدلية الخام (ناقوس/عناية/اسبرين...) لا عمود
        // «المخزن» (WAREHOUSE_ALIASES) الذي قد يحمل بدلاً منه تصنيفاً داخلياً
        // («الرئيسي»/«الثانوي») لا يميّز مذخراً عن آخر — طلب صريح: لا فرق بينهما،
        // فتُدمَج كل صفوفهما تحت اسم المذخر الفعلي الواحد بلا عمود «المخزن» إطلاقاً.
        const warehouseName = pharmacyNameFromRawData(s.rawData) || 'غير محدد';
        const itemName      = s.item?.name || 'غير محدد';
        // اسم الشركة لهذا الايتم — نفس rowCompany المحسوم أعلاه لنفس الصف (DB
        // company/scientificCompany → عمود rawData) — يُستعمل فقط لتجميع/ترتيب
        // الايتمات داخل كل مذخر عند عرض التفاصيل، لا للتجميع نفسه.
        const itemCompanyName = rowCompany?.display || 'غير مصنّف';
        const bwKey = `${repName}::${warehouseName}::${itemName}`;
        if (!baghdadWarehouseMap.has(bwKey)) {
          baghdadWarehouseMap.set(bwKey, { repName, warehouseName, itemName, companyName: itemCompanyName, totalQuantity: 0, totalValue: 0 });
        }
        const bwr = baghdadWarehouseMap.get(bwKey);
        bwr.totalQuantity += qty;
        bwr.totalValue    += val;
      }

      if (s.area) {
        const key = s.area.id;
        if (!areaMap.has(key)) areaMap.set(key, { areaName: s.area.name, totalQuantity: 0, totalValue: 0 });
        const r = areaMap.get(key);
        r.totalQuantity += qty;
        r.totalValue    += val;
      }
      if (s.area && s.item) {
        const key = `${s.area.name}::${s.item.name}`;
        if (!areaItemMap.has(key)) areaItemMap.set(key, { areaName: s.area.name, itemName: s.item.name, totalQuantity: 0, totalValue: 0 });
        const r = areaItemMap.get(key);
        r.totalQuantity += qty;
        r.totalValue    += val;
      }
    }

    const undatedExcluded = noDateFileFilter ? Math.max(0, countWithUndated - sales.length) : 0;

    const byItem     = [...itemMap.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));
    const byArea     = [...areaMap.values()].sort((a, b) => b.totalValue - a.totalValue);
    const byAreaItem = [...areaItemMap.values()];
    const byCompany  = [...companyMap.values()].sort((a, b) => b.totalValue - a.totalValue);
    const byProvince = [...provinceMap.values()].sort((a, b) => b.totalValue - a.totalValue);
    const byProvinceCompany = [...provinceCompanyMap.values()].sort((a, b) =>
      a.provinceName.localeCompare(b.provinceName, 'ar') || b.totalValue - a.totalValue);
    const byProvinceItem = [...provinceItemMap.values()];
    const byBaghdadWarehouse = [...baghdadWarehouseMap.values()].sort((a, b) =>
      a.repName.localeCompare(b.repName, 'ar') || a.warehouseName.localeCompare(b.warehouseName, 'ar') || b.totalValue - a.totalValue);

    res.json({ success: true, data: { totalQuantity, totalValue, byItem, byArea, byAreaItem, byCompany, byProvince, byProvinceCompany, byProvinceItem, byBaghdadWarehouse, minDate, maxDate, recordCount: sales.length, undatedExcluded, rawRequested, rawApplied, _debug: { parsedFileIds, userId, effectiveStartDate, effectiveEndDate, whereClause: JSON.stringify(where) } } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/overall-teams
 * التيمات (فرق) الموجودة داخل مكتب الطالب: كل حساب «مدير شركة» (company_manager)
 * في نفس officeId، باسم عرض = شركته الرئيسية، ومعرّفات كل شركاته (رئيسية
 * وثانوية) — لاستعمالها لاحقاً كـ teamManagerId في /overall لعزل مبيع/ارجاع
 * ذلك التيم فقط. مبنية على officeId لا على تسلسل UserManagerAssignment: طلب
 * صريح أن الشاشة تعرض «تيمات المكتب» كاملة.
 */
router.get('/overall-teams', async (req, res) => {
  try {
    const teams = await loadOfficeTeams(req.user?.id ?? null);
    res.json({ success: true, data: { teams } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
