// ════════════════════════════════════════════════════════════════════════════
// areaScope.js — المصدر الموحّد لنطاق مناطق المستخدم
// ────────────────────────────────────────────────────────────────────────────
// قبل هذا الملف كان كل موضع فلترة يكتب بنفسه:
//     prisma.userAreaAssignment.findMany({ where: { userId }, select: { areaId: true } })
// مكرراً في ~20 موضعاً. تعيين المحافظة «الديناميكي» مستحيل مع هذا التكرار،
// لأن المحافظة لا تُخزَّن كقائمة مناطق بل تُوسَّع وقت الاستعلام.
//
// المبدأ: تعيين محافظة لمستخدم = كل مناطقها، الآن ومستقبلاً. أي منطقة جديدة
// تدخل المحافظة (من رفع ملف مثلاً) تظهر له فوراً بلا إعادة تعيين — لأن التوسيع
// يحدث هنا عند كل استعلام، لا عند الحفظ.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

/** كل معرّفات المناطق التابعة لمجموعة محافظات (توسيع وقت الاستعلام). */
export async function areaIdsOfProvinces(provinceIds) {
  if (!provinceIds || provinceIds.length === 0) return [];
  const rows = await prisma.area.findMany({
    where:  { provinceId: { in: provinceIds } },
    select: { id: true },
  });
  return rows.map(r => r.id);
}

/** كل معرّفات المناطق التابعة لمجموعة أقسام (كرخ/رصافة). */
export async function areaIdsOfSubProvinces(subProvinceIds) {
  if (!subProvinceIds || subProvinceIds.length === 0) return [];
  const rows = await prisma.area.findMany({
    where:  { subProvinceId: { in: subProvinceIds } },
    select: { id: true },
  });
  return rows.map(r => r.id);
}

/** معرّفات الأقسام المعيّنة لمستخدم. */
export async function subProvinceIdsForUser(userId) {
  const rows = await prisma.userSubProvinceAssignment.findMany({
    where:  { userId },
    select: { subProvinceId: true },
  });
  return rows.map(r => r.subProvinceId);
}

/** معرّفات المحافظات المعيّنة لمستخدم. */
export async function provinceIdsForUser(userId) {
  const rows = await prisma.userProvinceAssignment.findMany({
    where:  { userId },
    select: { provinceId: true },
  });
  return rows.map(r => r.provinceId);
}

/**
 * مناطق المستخدم الفعلية = اتحاد ثلاثة مصادر:
 *   1. UserAreaAssignment      — المناطق المحددة يدوياً
 *   2. ScientificRepArea       — مناطق المندوب العلمي المرتبط (مرآة للأولى، لكن
 *                                قد تُضبط مستقلة من صفحة المناديب العلميين)
 *   3. مناطق المحافظات المعيّنة — التوسيع الديناميكي
 *
 * @param {number} userId
 * @param {{ linkedRepId?: number|null, includeRepAreas?: boolean }} opts
 * @returns {Promise<number[]>} معرّفات مناطق بلا تكرار
 */
export async function resolveEffectiveAreaIds(userId, opts = {}) {
  const { linkedRepId = undefined, includeRepAreas = true } = opts;
  if (!userId) return [];

  // نحلّ linkedRepId فقط إن لم يُمرَّر — الكثير من المستدعين يعرفه أصلاً.
  let repId = linkedRepId;
  if (includeRepAreas && repId === undefined) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
    repId = u?.linkedRepId ?? null;
  }

  const [ua, sa, provinceIds, subProvinceIds] = await Promise.all([
    prisma.userAreaAssignment.findMany({ where: { userId }, select: { areaId: true } }),
    includeRepAreas && repId
      ? prisma.scientificRepArea.findMany({ where: { scientificRepId: repId }, select: { areaId: true } })
      : Promise.resolve([]),
    provinceIdsForUser(userId),
    subProvinceIdsForUser(userId),
  ]);

  // تعيين المحافظة يشمل كل مناطقها (بما فيها مناطق أقسامها)، وتعيين قسم بعينه
  // يشمل مناطق ذلك القسم وحده — فيمكن منح مندوب «الكرخ» دون «الرصافة».
  const [provinceAreaIds, subProvinceAreaIds] = await Promise.all([
    areaIdsOfProvinces(provinceIds),
    areaIdsOfSubProvinces(subProvinceIds),
  ]);

  return [...new Set([
    ...ua.map(r => r.areaId),
    ...sa.map(r => r.areaId),
    ...provinceAreaIds,
    ...subProvinceAreaIds,
  ])];
}

/**
 * هل لهذا المستخدم أي تحديد نطاق أصلاً؟ يُستعمل حيث «بلا مناطق = بلا تقييد»
 * تختلف دلالته عن «بلا مناطق = لا شيء».
 */
export async function hasAnyAreaScope(userId) {
  const ids = await resolveEffectiveAreaIds(userId);
  return ids.length > 0;
}

// الأدوار التي تُمثَّل كمندوب في صفحة «المناديب العلميين» — نفس مجموعة
// scientific-reps.service.js#list. غيرها (مدير شركة/مكتب...) لا يُنشأ له سجل.
export const REP_ROLES = new Set(['scientific_rep', 'team_leader', 'commercial_rep']);

/**
 * يضمن وجود ScientificRepresentative مرتبط بهذا المستخدم، وينشئه عند الحاجة —
 * بدل الاكتفاء بإرجاع null والانتظار حتى يفتح مديرٌ صفحة «المناديب العلميين»
 * (حيث كان الإنشاء الكسول الوحيد سابقاً). بدون هذا، مستخدم جديد يُستورد من
 * إكسل ويُعيَّن له مناطق فوراً كان يبقى بلا linkedRepId، فتتجاهل
 * syncUserAreaDerivedLinks المزامنة بصمت (ScientificRepArea تبقى فارغة) حتى
 * يفتح أحد صفحته لاحقاً — وهو بالضبط ما كان يظهر للمدير كمندوب «بلا تحديد
 * مناطق/ايتمات» رغم تحديدها وقت الاستيراد.
 *
 * @param {number} userId
 * @param {{ onlyRoles?: Set<string>|null }} opts onlyRoles: لا يُنشئ سجلاً
 *        جديداً إلا لهذه الأدوار (سجل قائم يُعاد دائماً مهما كان الدور).
 * @returns {Promise<number|null>} معرّف المندوب المرتبط، أو null إن لم يوجد المستخدم
 */
export async function ensureLinkedRepId(userId, opts = {}) {
  if (!userId) return null;
  const { onlyRoles = null } = opts;
  const userRow = await prisma.user.findUnique({
    where:  { id: userId },
    select: { linkedRepId: true, displayName: true, username: true, phone: true, role: true },
  });
  if (!userRow) return null;
  if (userRow.linkedRepId) return userRow.linkedRepId;
  if (onlyRoles && !onlyRoles.has(userRow.role)) return null;

  let rep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
  if (!rep) {
    rep = await prisma.scientificRepresentative.create({
      data: { name: userRow.displayName || userRow.username, phone: userRow.phone || null, userId },
      select: { id: true },
    });
  }
  await prisma.user.update({ where: { id: userId }, data: { linkedRepId: rep.id } });
  return rep.id;
}

/**
 * إعادة بناء ScientificRepArea من مناطق المستخدم (لقطة snapshot لا تُحسب وقت
 * الاستعلام، بعكس resolveEffectiveAreaIds). مُشغّلاتها:
 *   1. setUserAreas               — حفظ المناطق
 *   2. حفظ تعيين المحافظات/الأقسام — لأن مناطقها تدخل النطاق
 *   3. رفع ملف يُنشئ مناطق جديدة داخل محافظة معيَّنة لمستخدمين
 *   4. إنشاء/استيراد مستخدم جديد  — عبر ensureLinkedRepId أعلاه
 *
 * لا تلمس ScientificRepCommercial إطلاقاً: كانت تُعيد اشتقاق المناديب
 * التجاريين من تطابق اسم المنطقة مع MedicalRepresentative.areas، وهذا مصدر
 * خاطئ لثلاثة أسباب — (أ) يربط أي تجاري «معيَّن» على المنطقة حتى لو لا مبيعة
 * له في الملف المفعَّل، فتنتفخ القائمة بعشرات الأسماء؛ (ب) يتجاهل
 * ScientificRepCommercialExclusion فيُعيد تجارياً حذفه المدير يدوياً؛
 * (ج) يمسح (deleteMany) ما اشتقّه المصدر الصحيح فيدهسه عند أي حفظ مناطق.
 * المصدر الصحيح الوحيد هو بيانات الملف المفعَّل:
 * syncCommercialsByActiveFiles (يُستدعى من App.tsx عند تغيّر الملفات المفعّلة)
 * و syncCommercialsForNewSales (بعد إضافة مبيعات لملف نشط).
 *
 * @param {number} userId
 * @param {number[]|null} areaIdsOverride مناطق محسوبة مسبقاً (يتجنّب استعلاماً)
 */
export async function syncUserAreaDerivedLinks(userId, areaIdsOverride = null) {
  // القصر على أدوار المناديب: حفظ مناطق مديرِ شركة يجب ألّا يُنشئ له سجل
  // ScientificRepresentative — وجود linkedRepId يُغيّر مسارات استعلام الأطباء.
  const repId = await ensureLinkedRepId(userId, { onlyRoles: REP_ROLES });
  if (!repId) return { synced: false };

  // مناطق النطاق الفعلي — بلا مناطق المندوب نفسه، وإلا صارت الدالة تُغذّي نفسها
  // (ScientificRepArea مصدر ونتيجة في آنٍ واحد) فلا تُحذف منطقة أُزيلت أبداً.
  const areaIds = areaIdsOverride
    ?? await resolveEffectiveAreaIds(userId, { includeRepAreas: false });

  await prisma.$transaction([
    prisma.scientificRepArea.deleteMany({ where: { scientificRepId: repId } }),
    ...(areaIds.length ? [prisma.scientificRepArea.createMany({
      data: areaIds.map(areaId => ({ scientificRepId: repId, areaId })),
      skipDuplicates: true,
    })] : []),
  ]);

  return { synced: true, areaCount: areaIds.length };
}

/**
 * كل المستخدمين المعيَّنين على محافظة — لإعادة مزامنة روابطهم المشتقة بعد أن
 * يُضيف رفعُ ملفٍ مناطق جديدة إليها.
 */
export async function userIdsAssignedToSubProvinces(subProvinceIds) {
  if (!subProvinceIds || subProvinceIds.length === 0) return [];
  const rows = await prisma.userSubProvinceAssignment.findMany({
    where:  { subProvinceId: { in: subProvinceIds } },
    select: { userId: true },
  });
  return [...new Set(rows.map(r => r.userId))];
}

export async function userIdsAssignedToProvinces(provinceIds) {
  if (!provinceIds || provinceIds.length === 0) return [];
  const rows = await prisma.userProvinceAssignment.findMany({
    where:  { provinceId: { in: provinceIds } },
    select: { userId: true },
  });
  return [...new Set(rows.map(r => r.userId))];
}

/**
 * أسماء مناطق المستخدم الفعلية — لمواضع تطابق بالاسم لا بالـFK
 * (أطباء السيرفي مثلاً يخزّنون areaName نصاً بلا علاقة).
 */
export async function resolveEffectiveAreaNames(userId, opts = {}) {
  const ids = await resolveEffectiveAreaIds(userId, opts);
  if (ids.length === 0) return [];
  const rows = await prisma.area.findMany({
    where:  { id: { in: ids } },
    select: { name: true },
  });
  return rows.map(r => (r.name || '').trim()).filter(Boolean);
}

/**
 * سجلات مناطق المستخدم الفعلية ({ id, name }) — لمواضع تحتاج الاسم والمعرّف معاً
 * (المساعد الذكي، لوحة المندوب التجاري).
 */
export async function resolveEffectiveAreas(userId, opts = {}) {
  const ids = await resolveEffectiveAreaIds(userId, opts);
  if (ids.length === 0) return [];
  return prisma.area.findMany({
    where:   { id: { in: ids } },
    select:  { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * عكس resolveEffectiveAreaIds: مَن المستخدمون الذين تقع هذه المناطق ضمن نطاقهم؟
 *
 * يُستعمل لتوجيه التنبيهات التلقائية للمندوب المسؤول عن منطقة الصيدلية. يجمع
 * المصادر الأربعة نفسها (منطقة مباشرة، مندوب علمي، محافظة، قسم) — فمندوب
 * مُعيَّن على «الكرخ» يستلم تنبيهات مناطق الكرخ دون أن يُعيَّن على كل منطقة.
 *
 * @param {number[]} areaIds
 * @returns {Promise<Map<number, number[]>>} areaId -> userIds
 */
export async function usersForAreaIds(areaIds) {
  const out = new Map();
  if (!areaIds || areaIds.length === 0) return out;
  const add = (areaId, userId) => {
    if (!out.has(areaId)) out.set(areaId, new Set());
    out.get(areaId).add(userId);
  };

  const areas = await prisma.area.findMany({
    where:  { id: { in: areaIds } },
    select: { id: true, provinceId: true, subProvinceId: true },
  });
  const provinceIds    = [...new Set(areas.map(a => a.provinceId).filter(Boolean))];
  const subProvinceIds = [...new Set(areas.map(a => a.subProvinceId).filter(Boolean))];

  const [direct, viaRep, viaProvince, viaSub] = await Promise.all([
    prisma.userAreaAssignment.findMany({
      where: { areaId: { in: areaIds } }, select: { userId: true, areaId: true },
    }),
    prisma.scientificRepArea.findMany({
      where:  { areaId: { in: areaIds } },
      select: { areaId: true, scientificRep: { select: { linkedUsers: { select: { id: true } } } } },
    }),
    provinceIds.length
      ? prisma.userProvinceAssignment.findMany({
          where: { provinceId: { in: provinceIds } }, select: { userId: true, provinceId: true },
        })
      : Promise.resolve([]),
    subProvinceIds.length
      ? prisma.userSubProvinceAssignment.findMany({
          where: { subProvinceId: { in: subProvinceIds } }, select: { userId: true, subProvinceId: true },
        })
      : Promise.resolve([]),
  ]);

  for (const r of direct) add(r.areaId, r.userId);
  for (const r of viaRep) {
    for (const u of r.scientificRep?.linkedUsers ?? []) add(r.areaId, u.id);
  }
  const byProvince = new Map();
  for (const r of viaProvince) {
    if (!byProvince.has(r.provinceId)) byProvince.set(r.provinceId, []);
    byProvince.get(r.provinceId).push(r.userId);
  }
  const bySub = new Map();
  for (const r of viaSub) {
    if (!bySub.has(r.subProvinceId)) bySub.set(r.subProvinceId, []);
    bySub.get(r.subProvinceId).push(r.userId);
  }
  for (const a of areas) {
    for (const uid of byProvince.get(a.provinceId) ?? []) add(a.id, uid);
    for (const uid of bySub.get(a.subProvinceId) ?? []) add(a.id, uid);
  }

  return new Map([...out].map(([k, v]) => [k, [...v]]));
}
