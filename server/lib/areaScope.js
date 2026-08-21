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

  const [ua, sa, provinceIds] = await Promise.all([
    prisma.userAreaAssignment.findMany({ where: { userId }, select: { areaId: true } }),
    includeRepAreas && repId
      ? prisma.scientificRepArea.findMany({ where: { scientificRepId: repId }, select: { areaId: true } })
      : Promise.resolve([]),
    provinceIdsForUser(userId),
  ]);

  const provinceAreaIds = await areaIdsOfProvinces(provinceIds);

  return [...new Set([
    ...ua.map(r => r.areaId),
    ...sa.map(r => r.areaId),
    ...provinceAreaIds,
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

/**
 * إعادة بناء الروابط المشتقة من مناطق المستخدم: ScientificRepArea و
 * ScientificRepCommercial.
 *
 * لماذا موجودة هنا: هذه لقطات (snapshots) لا تُحسب وقت الاستعلام، بعكس
 * resolveEffectiveAreaIds. كانت مدفونة داخل setUserAreas فلا تُحدَّث إلا عند
 * حفظ المناطق يدوياً. بعد إدخال المحافظات صار لها ثلاثة مُشغّلات:
 *   1. setUserAreas               — حفظ المناطق (كما كان)
 *   2. حفظ تعيين المحافظات        — لأن مناطق المحافظة تدخل النطاق
 *   3. بعد رفع ملف ينشئ مناطق جديدة داخل محافظة معيَّنة لمستخدمين
 *
 * @param {number} userId
 * @param {number[]|null} areaIdsOverride مناطق محسوبة مسبقاً (يتجنّب استعلاماً)
 */
export async function syncUserAreaDerivedLinks(userId, areaIdsOverride = null) {
  const userRow = await prisma.user.findUnique({
    where:  { id: userId },
    select: { linkedRepId: true },
  });
  if (!userRow?.linkedRepId) return { synced: false };
  const repId = userRow.linkedRepId;

  // مناطق النطاق الفعلي — بلا مناطق المندوب نفسه، وإلا صارت الدالة تُغذّي نفسها
  // (ScientificRepArea مصدر ونتيجة في آنٍ واحد) فلا تُحذف منطقة أُزيلت أبداً.
  const areaIds = areaIdsOverride
    ?? await resolveEffectiveAreaIds(userId, { includeRepAreas: false });

  // 1. مزامنة ScientificRepArea
  await prisma.$transaction([
    prisma.scientificRepArea.deleteMany({ where: { scientificRepId: repId } }),
    ...(areaIds.length ? [prisma.scientificRepArea.createMany({
      data: areaIds.map(areaId => ({ scientificRepId: repId, areaId })),
      skipDuplicates: true,
    })] : []),
  ]);

  if (areaIds.length === 0) {
    await prisma.scientificRepCommercial.deleteMany({ where: { scientificRepId: repId } });
    return { synced: true, areaCount: 0, commercialCount: 0 };
  }

  // 2. إسناد المناديب التجاريين تلقائياً حسب تطابق اسم المنطقة
  const { normalizeAreaName } = await import('./itemResolver.js');

  const assignedAreas = await prisma.area.findMany({
    where:  { id: { in: areaIds } },
    select: { id: true, name: true },
  });
  const assignedNormSet = new Set(assignedAreas.map(a => normalizeAreaName(a.name)));

  // كل صفوف Area التي تمثّل نفس المكان — تطابق تام بعد التطبيع فقط. المطابقة
  // بالتضمين (includes) كانت فضفاضة: «الحسين» يطابق «الحسينيه»، و«اور»/«مغرب»
  // يطابقان مناطق كثيرة، فتُسحب مناديب من أماكن لا يغطيها المندوب.
  const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
  const matchingAreaIds = allAreas
    .filter(a => assignedNormSet.has(normalizeAreaName(a.name)))
    .map(a => a.id);

  const commercialReps = await prisma.medicalRepresentative.findMany({
    where:   { areas: { some: { areaId: { in: matchingAreaIds } } } },
    select:  { id: true, name: true },
    orderBy: { id: 'asc' },
  });

  // نفس الشخص قد يوجد كصفوف متعددة من ملفات مختلفة — أبقِ الأول لكل اسم مطبَّع.
  // ملاحظة: تطبيع أسماء الأشخاص لا يحذف «ال» التعريف ولا بادئات «حي/محلة» —
  // بعكس normalizeAreaName المخصّص للمناطق. «علي الحسن» ليس «علي حسن».
  const normPersonName = s => String(s || '').trim()
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[ً-ٟ]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
  const seenNames = new Set();
  const uniqueReps = commercialReps.filter(r => {
    const n = normPersonName(r.name);
    if (seenNames.has(n)) return false;
    seenNames.add(n);
    return true;
  });

  await prisma.$transaction([
    prisma.scientificRepCommercial.deleteMany({ where: { scientificRepId: repId } }),
    ...(uniqueReps.length ? [prisma.scientificRepCommercial.createMany({
      data: uniqueReps.map(r => ({ scientificRepId: repId, commercialRepId: r.id })),
      skipDuplicates: true,
    })] : []),
  ]);

  return { synced: true, areaCount: areaIds.length, commercialCount: uniqueReps.length };
}

/**
 * كل المستخدمين المعيَّنين على محافظة — لإعادة مزامنة روابطهم المشتقة بعد أن
 * يُضيف رفعُ ملفٍ مناطق جديدة إليها.
 */
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
