// ════════════════════════════════════════════════════════════════════════════
// areaResolver.js — محرك مطابقة موحّد لأسماء المناطق.
// ────────────────────────────────────────────────────────────────────────────
// المشكلة: كل مسار إنشاء منطقة (استيراد سيرفي، ملفات مبيعات، إضافة طبيب...)
// كان يطابق بـ normalizeAreaName فقط — تطابق تام بعد التطبيع. أي اختلاف
// إملائي أبسط من ذلك (فراغ إضافي، صياغة مختلفة قليلاً) كان يُنشئ صفّ Area
// جديداً بصمت، رغم أن المنطقة الحقيقية موجودة أصلاً بتهجئة قريبة.
//
// الحل هنا بثلاث مراحل بالترتيب:
//   1) تطابق تام (normalizeAreaName) — كما كان يعمل سابقاً.
//   2) ذاكرة AreaAlias — اسم سبق حسمه (تلقائياً أو بدمج يدوي) يُربط فوراً
//      دون إعادة السؤال، وتنمو هذه الذاكرة تلقائياً مع كل دمج (mergeAreas.js).
//   3) مطابقة ضبابية صارمة (areSimilar) — أشد من العتبة الافتراضية المستخدمة
//      للايتمات/الشركات، لأن أسماء الأحياء تتشارك جذوراً بينما تكون أماكن
//      مختلفة فعلاً (مثال: "المنصور" و"المنصورية" ليسا نفس المكان) خلافاً
//      لأسماء الأدوية حيث نمط البادئة المشتركة نادراً ما يعني كياناً مختلفاً.
//      عند تطابق: يُحفظ في AreaAlias فوراً (confidence: 'fuzzy').
//   4) لا شيء مما سبق → تُنشأ منطقة جديدة فعلاً، لكن بعلامة needsReview=true
//      بدل الإضافة الصامتة — تظهر في طابور المراجعة (AreasPage) ليقرر
//      السوبر أدمن دمجها أو تأكيدها كمنطقة جديدة حقيقية.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeAreaName } from './itemResolver.js';
import { areSimilar, similarity } from './fuzzyMatch.js';
import { provinceNameKeys, findOrCreateProvinceCenter } from './provinceNameCollision.js';

// عتبات الربط التلقائي الصامت — أشد من fuzzyMatch الافتراضي (0.85/0.55/0.8)
// عمداً، تفادياً لدمج حيّين مختلفين فعلاً يشتركان جذراً لغوياً واحداً.
//
// wordOverlap مُعطَّلة هنا عمداً (1.01 لا يمكن بلوغها، النسبة القصوى 1.0):
// قاعدة wordOverlapRatio في fuzzyMatch.js تحسب النسبة بالنسبة لعدد كلمات
// الاسم الأقصر فقط — فإن كان أحد الاسمين كلمة واحدة والآخر كلمتين، وتطابقت
// الكلمة الوحيدة مع إحداهما، تصير النسبة 1.0 وتتجاهل الكلمة الإضافية
// كلياً. هذا مصمَّم عمداً لأسماء الأدوية (حيث الكلمة الإضافية جرعة/شكل
// صيدلاني لا تُميّز الهوية)، لكنه خطأ لأسماء الأماكن: "العامرية" (بغداد/
// الكرخ) و"عامرية الفلوجة" (الأنبار) مكانان مختلفان تماماً، والكلمة
// الإضافية "الفلوجة" هي بالضبط ما يُميّزهما — تجاهلها دمج المنطقتين في صفّ
// واحد بصمت (رُصِد فعلياً وسبَّب بشارة تعارض محافظة ثابتة). prefixRatio
// وlev يبقيان كافيين لالتقاط الأخطاء الإملائية الحقيقية لنفس المكان.
const AUTO_LINK_OPTS = { lev: 0.92, prefixRatio: 0.85, wordOverlap: 1.01 };

const AREA_SELECT = { id: true, name: true, provinceId: true, needsReview: true };

// ── لقطة جدول المناطق داخل الدفعة الواحدة ────────────────────────────────────
// التسلسل أدناه كان سيعني استعلاماً كاملاً لجدول المناطق لكل اسم في الدفعة
// (رفع ملف فيه 300 منطقة = 300 استعلام متسلسل). فنقرأ الجدول مرة واحدة لكل
// «دفعة» ونُضيف إليها كل منطقة تُنشأ فوراً — فصحّة الدفعة مضمونة دون تكرار
// القراءة. اللقطة تُلغى فور خلوّ الطابور (أي بين طلبين مستقلين)، فلا تعيش
// أطول من الدفعة نفسها ولا تُخفي دمجاً/حذفاً جرى في طلب آخر.
let snapshot = null;
let inFlight = 0;

async function loadAreas() {
  if (!snapshot) snapshot = await prisma.area.findMany({ select: AREA_SELECT });
  return snapshot;
}

/** إلغاء اللقطة يدوياً — يستدعيه أي مسار يعدّل جدول المناطق خارج هذا الملف. */
export function invalidateAreaSnapshot() { snapshot = null; }

// ── قفل التسلسل (داخل العملية) ───────────────────────────────────────────────
// السبب الحقيقي وراء استمرار تكرار المناطق رغم كل ما سبق: المطابقة كانت
// تُنفَّذ على التوازي. رفع المبيعات (resolveEntities في sales.service.js) وربط
// مناطق المندوبين (assignAreasByName) يستدعيان هذه الدالة عبر Promise.all لكل
// الأسماء دفعةً واحدة، فتقرأ كل الاستدعاءات جدول Area في اللحظة نفسها — قبل
// أن يكتب أيٌّ منها صفّه الجديد. فتهجئتان لنفس المنطقة داخل ملف واحد
// («الدورة - الطعمة» و«الدورة الطعمة» — تطبيعهما متطابق حرفياً) لا ترى
// إحداهما الأخرى، فتفشل خطوة «التطابق التام» بلا ذنب وتُنشأ منطقتان.
// القفل يجعل كل مطابقة تبدأ بعد اكتمال سابقتها، فترى ما أُنشئ للتو.
let gate = Promise.resolve();

/**
 * يطابق اسم منطقة قادم من ملف/سيرفي مقابل كتالوج Area، بالترتيب:
 * تطابق تام → alias محفوظ → ضبابي بثقة عالية (يُحفظ alias) → إنشاء جديد
 * (بعلامة needsReview). الاستدعاءات المتوازية تُنفَّذ واحدة تلو الأخرى.
 *
 * @param {string} rawName
 * @returns {Promise<{ area: {id:number,name:string,provinceId:number|null}, matched: 'exact'|'alias'|'fuzzy'|'new' }|null>}
 *          null إن كان الاسم فارغاً.
 */
export function resolveAreaByName(rawName, { provinceId = null } = {}) {
  inFlight++;
  const run = () => resolveAreaByNameSerial(rawName, provinceId);
  const result = gate.then(run, run);
  // فشل استدعاء واحد يجب ألا يوقف طابور الانتظار خلفه.
  gate = result.then(() => {}, () => {});
  const release = () => { if (--inFlight === 0) snapshot = null; };
  result.then(release, release);
  return result;
}

async function resolveAreaByNameSerial(rawName, provinceId = null) {
  const trimmed = String(rawName ?? '').trim();
  if (!trimmed) return null;
  const norm = normalizeAreaName(trimmed);

  const allAreas = await loadAreas();

  // 1) تطابق تام — عند تعدّد الصفوف بنفس الاسم تُفضَّل محافظة الصف القادم من الملف
  const exacts = allAreas.filter(a => normalizeAreaName(a.name) === norm);
  const exact = (provinceId != null && exacts.find(a => a.provinceId === provinceId)) || exacts[0];

  // اسم المنطقة = اسم المحافظة نفسها (ملف محافظة القادسية يكتب «القادسية» في عمود
  // المنطقة) والصف المطابق حيّ بمحافظة أخرى (القادسية/الكرخ) ⇒ مركز المحافظة
  // (الديوانية) لا الحيّ — راجع provinceNameCollision.js.
  if (provinceId != null && exact && exact.provinceId != null && exact.provinceId !== provinceId) {
    const province = await prisma.province.findUnique({ where: { id: provinceId } });
    if (province && provinceNameKeys(province).has(norm)) {
      const center = await findOrCreateProvinceCenter(prisma, province, allAreas);
      if (center) {
        if (snapshot && !snapshot.some(a => a.id === center.id)) snapshot.push(center);
        return { area: center, matched: 'exact' };
      }
    }
  }
  if (exact) return { area: exact, matched: 'exact' };

  // 2) ذاكرة alias محفوظة سابقاً
  const alias = await prisma.areaAlias.findUnique({ where: { fromKey: norm } });
  if (alias) {
    const target = allAreas.find(a => a.id === alias.areaId)
      ?? await prisma.area.findUnique({ where: { id: alias.areaId }, select: AREA_SELECT });
    if (target) return { area: target, matched: 'alias' };
    // alias يتيم (منطقته حُذفت خارج مسار الدمج المعتاد) — تجاهله والمتابعة كالمعتاد
  }

  // 3) مطابقة ضبابية صارمة — يُقارَن فقط مقابل مناطق مؤكَّدة (غير معلَّمة
  // needsReview) كي لا تُربط منطقة جديدة غامضة بأخرى جديدة غامضة أيضاً.
  const confirmedAreas = allAreas.filter(a => !a.needsReview);
  let best = null, bestScore = -1;
  for (const cand of confirmedAreas) {
    if (!areSimilar(trimmed, cand.name, AUTO_LINK_OPTS)) continue;
    const score = similarity(norm, normalizeAreaName(cand.name));
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  if (best) {
    await prisma.areaAlias.upsert({
      where:  { fromKey: norm },
      update: { fromName: trimmed, areaId: best.id, confidence: 'fuzzy' },
      create: { fromKey: norm, fromName: trimmed, areaId: best.id, confidence: 'fuzzy' },
    });
    return { area: best, matched: 'fuzzy' };
  }

  // 4) لا تطابق البتة — منطقة جديدة فعلاً، لكن بعلامة مراجعة بدل إضافة صامتة
  const created = await prisma.area.create({
    data: { name: trimmed, userId: null, needsReview: true },
    select: AREA_SELECT,
  });
  // تُضاف للقطة فوراً: الاسم التالي في الدفعة نفسها يجب أن يراها في خطوة
  // «التطابق التام» بدل أن ينشئ نسخة ثانية منها.
  if (snapshot) snapshot.push(created);
  return { area: created, matched: 'new' };
}

/**
 * خريطة بحث «هل هذا الاسم معروف أصلاً؟» — تطابق تام بعد التطبيع + ذاكرة
 * AreaAlias، بلا أي إنشاء. يحتاجها كل مسار يُنشئ مناطق دفعةً من أسماء السيرفي
 * (GET /api/sa/areas، reset-from-survey): كانت تلك المسارات تقارن بالأسماء
 * الموجودة فقط وتتجاهل AreaAlias، فاسم دُمج يدوياً (وحُذف صفّه) يبقى نصّاً
 * خاماً في السيرفي ويُعاد إنشاؤه بلا محافظة عند أول فتح لصفحة المستخدمين —
 * فيعود للظهور تحت «غير محدد» وكأن الدمج لم يحدث.
 *
 * @returns {Promise<(name: string) => {id:number,name:string,provinceId:number|null}|null>}
 */
export async function buildKnownAreaLookup() {
  const [areas, aliases] = await Promise.all([
    prisma.area.findMany({ select: AREA_SELECT, orderBy: { id: 'asc' } }),
    prisma.areaAlias.findMany({ select: { fromKey: true, areaId: true } }),
  ]);
  const byId = new Map(areas.map(a => [a.id, a]));
  const byKey = new Map();
  for (const a of areas) {
    const k = normalizeAreaName(a.name);
    if (k && !byKey.has(k)) byKey.set(k, a);
  }
  for (const al of aliases) {
    const target = byId.get(al.areaId);
    if (target && !byKey.has(al.fromKey)) byKey.set(al.fromKey, target);
  }
  return name => byKey.get(normalizeAreaName(name)) ?? null;
}
