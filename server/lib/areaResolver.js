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

// عتبات الربط التلقائي الصامت — أشد من fuzzyMatch الافتراضي (0.85/0.55/0.8)
// عمداً، تفادياً لدمج حيّين مختلفين فعلاً يشتركان جذراً لغوياً واحداً.
const AUTO_LINK_OPTS = { lev: 0.92, prefixRatio: 0.85, wordOverlap: 0.95 };

/**
 * يطابق اسم منطقة قادم من ملف/سيرفي مقابل كتالوج Area، بالترتيب:
 * تطابق تام → alias محفوظ → ضبابي بثقة عالية (يُحفظ alias) → إنشاء جديد
 * (بعلامة needsReview).
 *
 * @param {string} rawName
 * @returns {Promise<{ area: {id:number,name:string,provinceId:number|null}, matched: 'exact'|'alias'|'fuzzy'|'new' }|null>}
 *          null إن كان الاسم فارغاً.
 */
export async function resolveAreaByName(rawName) {
  const trimmed = String(rawName ?? '').trim();
  if (!trimmed) return null;
  const norm = normalizeAreaName(trimmed);

  const allAreas = await prisma.area.findMany({
    select: { id: true, name: true, provinceId: true, needsReview: true },
  });

  // 1) تطابق تام
  const exact = allAreas.find(a => normalizeAreaName(a.name) === norm);
  if (exact) return { area: exact, matched: 'exact' };

  // 2) ذاكرة alias محفوظة سابقاً
  const alias = await prisma.areaAlias.findUnique({ where: { fromKey: norm } });
  if (alias) {
    const target = allAreas.find(a => a.id === alias.areaId)
      ?? await prisma.area.findUnique({ where: { id: alias.areaId }, select: { id: true, name: true, provinceId: true, needsReview: true } });
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
  });
  return { area: created, matched: 'new' };
}
