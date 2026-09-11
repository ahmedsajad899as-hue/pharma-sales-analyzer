// ════════════════════════════════════════════════════════════════════════════
// surveyPharmacies.js — المصدر الموحّد لصيدليات السيرفي
// ────────────────────────────────────────────────────────────────────────────
// نظير surveyDoctors.js لكن للصيدليات: يُخرج خانة «زيارات الصيدليات» من نفس
// مبدأ خانة الأطباء — كل صيدليات السيرفي النشط ضمن مناطق نطاق المستخدم (لا فقط
// الصيدليات التي لها زيارة مسجَّلة مسبقاً)، فتظهر كل أسماء الصيدليات ومناطقها
// من السيرفي حتى قبل أي زيارة. resolveAreaScope مُستوردة من surveyDoctors.js
// لأنها عامة أصلاً (نطاق مناطق + سيرفيات) لا خاصة بالأطباء.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeAreaName } from './itemResolver.js';
import { areSimilar, similarity, normalizeStr } from './fuzzyMatch.js';
import { ensureGlobalArea, logSurveyEdit } from './surveyDoctors.js';

// Common prefixes/titles typed before a pharmacy name (same set the invoice-
// extraction path in sales.service.js strips) — stripped before comparing
// pharmacy names so "ص. النور" and "صيدلية النور" are recognised as the same name.
const PHARMACY_PREFIX_RE = /^\s*(ص\.?|صيدلية|الصيدلية|صيدليه|الصيدليه)\s+/i;
export function cleanPharmacyName(name) {
  let s = String(name ?? '').trim();
  for (let i = 0; i < 3 && PHARMACY_PREFIX_RE.test(s); i++) s = s.replace(PHARMACY_PREFIX_RE, '').trim();
  return s;
}

// ── normalizePharmacyStoredName(name) — تنظيف الاسم المخزَّن فعلياً ──────────
// بخلاف cleanPharmacyName أعلاه (يُستخدم فقط للمطابقة عند اقتراحات الدمج، لا
// يُكتب للقاعدة)، هذه تُستخدم فعلياً لتعديل الاسم المخزَّن في قاعدة البيانات
// (زر "تنظيف الأسماء" في لوحة السوبر أدمن). تزيل بادئات تصنيفية شائعة قبل
// الاسم الصريح (ص / ص. / ص/ / صيدلية / الصيدلية / الاسم / العميل) مع أي فارزة
// أو نقطة أو شرطة تتلوها — بشكل تكراري (قد تتكرر أكثر من بادئة، مثل
// "الاسم: ص. مملكة العلاج") — ثم توحّد نهاية كل كلمة تنتهي بـ"ه" إلى "ة" (خطأ
// إملائي شائع، مثل "قمه الدواء" ← "قمة الدواء")، باستثناء "الله" حفاظاً على
// الأسماء الدينية. لا تلمس الاسم الصريح نفسه — فقط البادئة التصنيفية قبله.
const NAME_LABEL_PREFIX_RE = /^(الصيدليه|الصيدلية|صيدليه|صيدلية|الاسم|العميل|ص)(?=$|[\s.,،:\-/])/iu;
const LEADING_PUNCT_RE = /^[\s.,،:\-/]+/u;

export function normalizePharmacyStoredName(name) {
  const original = String(name ?? '').trim();
  let s = original;
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(LEADING_PUNCT_RE, '').replace(NAME_LABEL_PREFIX_RE, '').trim();
    if (s === before) break;
  }
  if (!s) return original; // البادئة كانت الاسم كله فعلياً — لا نمسح الصف بالكامل
  // "الله" مستثناة كنهاية كلمة (منفردة أو ملتصقة مثل "عبدالله"/"نصرالله") — ليست خطأ إملائي.
  s = s.split(/\s+/).map(w => (/ه$/u.test(w) && !/الله$/u.test(w)) ? w.slice(0, -1) + 'ة' : w).join(' ');
  return s;
}

// ── previewPharmacyNameCleanup / applyPharmacyNameCleanup ───────────────────
// معاينة (بلا كتابة) ثم تطبيق فعلي لتنظيف أسماء صيدليات سيرفي واحد بواسطة
// normalizePharmacyStoredName أعلاه. التطبيق يستعمل cascadePharmacyNameChange
// نفسها المستخدمة في التعديل اليدوي لاسم صيدلية — فتتبعه أسماء الصيدلية عند
// الأطباء المرتبطين وزيارات الصيدليات المسجَّلة بالاسم القديم أيضاً.
export async function previewPharmacyNameCleanup(surveyId) {
  const pharmacies = await prisma.masterSurveyPharmacy.findMany({
    where: { surveyId },
    select: { id: true, name: true, areaName: true },
    orderBy: { name: 'asc' },
  });
  const changes = [];
  for (const p of pharmacies) {
    const cleaned = normalizePharmacyStoredName(p.name);
    if (cleaned && cleaned !== p.name) changes.push({ id: p.id, oldName: p.name, newName: cleaned, areaName: p.areaName });
  }
  return changes;
}

// idSet قد يصل لآلاف الصفوف دفعة واحدة (زر "تنظيف الأسماء" مطبَّق على كل
// صيدليات السيرفي) — كل صف يعالَج بمعزل عن البقية (try/catch فردي) كي لا يوقف
// خطأ صف واحد (أو انقطاع مؤقت بالاتصال) بقية الدفعة؛ العملية idempotent أصلاً
// (تعيد حساب الاسم النظيف وتتخطى ما لا يحتاج تغييراً) فيصح تكرار الاستدعاء
// بأمان على الصفوف التي فشلت. failedIds تُعاد للواجهة لإعادة المحاولة عليها فقط.
export async function applyPharmacyNameCleanup(surveyId, ids, editedById) {
  const idSet = [...new Set((ids || []).map(id => parseInt(id)).filter(Boolean))];
  if (!idSet.length) return { updated: 0, affectedDoctors: 0, affectedVisits: 0, failedIds: [] };

  const pharmacies = await prisma.masterSurveyPharmacy.findMany({ where: { surveyId, id: { in: idSet } } });
  let updated = 0, affectedDoctors = 0, affectedVisits = 0;
  const failedIds = [];
  for (const old of pharmacies) {
    try {
      const cleaned = normalizePharmacyStoredName(old.name);
      if (!cleaned || cleaned === old.name) continue;
      const updatedRow = await prisma.masterSurveyPharmacy.update({
        where: { id: old.id },
        data: { name: cleaned, lastEditedById: editedById ?? null, lastEditedAt: new Date() },
      });
      await logSurveyEdit(surveyId, 'pharmacy', old.id, 'update', old, updatedRow, editedById);
      const cascade = await cascadePharmacyNameChange(surveyId, [old.name], cleaned);
      affectedDoctors += cascade.affectedDoctors;
      affectedVisits += cascade.affectedVisits;
      updated++;
    } catch (e) {
      failedIds.push(old.id);
    }
  }
  return { updated, affectedDoctors, affectedVisits, failedIds };
}

// ── findClosestPharmacyName(deletedName, candidateNames) ────────────────────
// عند حذف صيدلية من السيرفي، الأطباء الذين كان اسم صيدليتهم هذا الاسم يحتاجون
// أقرب اسم بديل من الصيدليات المتبقية بدل أن يبقوا مربوطين باسم لم يعد موجوداً.
// نستعمل نفس محرّك areSimilar المستخدم لكشف التكرار عند استيراد الملفات (بادئة
// + Levenshtein + تداخل كلمات) لتصفية المرشّحين المقبولين فعلاً، ثم similarity
// لاختيار الأقرب بينهم. بلا مرشّح مقبول → null (يُترك الطبيب بلا اسم صيدلية).
export function findClosestPharmacyName(deletedName, candidateNames) {
  const cleanedDeleted = cleanPharmacyName(deletedName);
  if (!cleanedDeleted) return null;
  let best = null, bestScore = -1;
  for (const cand of candidateNames) {
    if (!cand || cand === deletedName) continue;
    const cleanedCand = cleanPharmacyName(cand);
    if (!cleanedCand || !areSimilar(cleanedDeleted, cleanedCand)) continue;
    const score = similarity(normalizeStr(cleanedDeleted), normalizeStr(cleanedCand));
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

// ── getScopedSurveyPharmacies(scope) ─────────────────────────────────────────
// المجموعة القانونية: صيدليات السيرفي النشط ضمن مناطق النطاق. صيدلية بلا منطقة
// مسجَّلة لا يمكن نسبتها لفريق أصلاً فتُستبعد (كما تُستبعد صيدليات النطاق
// الفارغ بالكامل) — نفس فلسفة getScopedSurveyDoctors تماماً.
export async function getScopedSurveyPharmacies(scope) {
  const { surveyIds, normAreaNames } = scope;
  if (!surveyIds.length || !normAreaNames.length) return [];
  const all = await prisma.masterSurveyPharmacy.findMany({
    where: { surveyId: { in: surveyIds } },
    select: {
      id: true, name: true, ownerName: true, pharmacyName: true,
      phone: true, address: true, areaName: true, notes: true,
    },
    orderBy: { name: 'asc' },
  });
  const set = new Set(normAreaNames);
  return all.filter(p => p.areaName?.trim() && set.has(normalizeAreaName(p.areaName)));
}

// ── cascadePharmacyNameChange(surveyId, oldNames, newName) ──────────────────
// صيدلية غيّرت اسمها (تعديل) أو اندمجت باسم آخر (دمج) أو حُذفت مع نقل الأطباء
// لأقرب بديل (حذف): الأطباء الذين اسم صيدليتهم كان أحد oldNames يتبعون الاسم
// الجديد في MasterSurveyDoctor + كل صفوف Doctor المرتبطة (نفس فكرة cascade في
// updateSurveyDoctor)، وزيارات الصيدليات المسجَّلة بأحد الأسماء القديمة
// (PharmacyVisit.pharmacyName نص خام بلا FK — خلافاً لـ DoctorVisit المربوطة
// بـ doctorId) تتبع الاسم الجديد أيضاً كي لا تنفصل عن صيدليتها في تحليل
// الزيارات. newName فارغ/null (حذف بلا بديل مشابه) يُبقي الزيارات كما هي —
// PharmacyVisit.pharmacyName غير قابل لـ null أصلاً في الـ schema.
export async function cascadePharmacyNameChange(surveyId, oldNames, newName) {
  const trimmedNew = String(newName ?? '').trim();
  const names = [...new Set((oldNames || []).map(n => String(n ?? '').trim()).filter(Boolean))]
    .filter(n => n.toLowerCase() !== trimmedNew.toLowerCase());
  if (!names.length) return { affectedDoctors: 0, affectedVisits: 0 };

  let affectedDoctors = 0, affectedVisits = 0;
  for (const oldName of names) {
    const docs = await prisma.masterSurveyDoctor.findMany({
      where: { surveyId, pharmacyName: { equals: oldName, mode: 'insensitive' } },
      select: { id: true },
    });
    if (docs.length) {
      const ids = docs.map(d => d.id);
      await prisma.masterSurveyDoctor.updateMany({ where: { id: { in: ids } }, data: { pharmacyName: trimmedNew || null } });
      await prisma.doctor.updateMany({ where: { masterSurveyDoctorId: { in: ids } }, data: { pharmacyName: trimmedNew || null } });
      affectedDoctors += ids.length;
    }
    if (trimmedNew) {
      const result = await prisma.pharmacyVisit.updateMany({
        where: { pharmacyName: { equals: oldName, mode: 'insensitive' } },
        data: { pharmacyName: trimmedNew },
      });
      affectedVisits += result.count;
    }
  }
  return { affectedDoctors, affectedVisits };
}

// ── createSurveyPharmacy — إنشاء صيدلية سيرفي موحّد (log + منطقة عامة) ───────
// نظير createSurveyDoctor: ensureGlobalArea يضمن ظهور صيدلية بمنطقة جديدة
// كلياً لكل الفرق فوراً (بدل أن تبقى غير مرئية للأبد — كانت هذه الخطوة مفقودة
// من مسار الصيدليات أصلاً وهي سبب رئيسي لعدم تطابق العدد بين لوحة السوبر أدمن
// وما يظهر عند المستخدمين).
export async function createSurveyPharmacy(surveyId, fields, editedById, areaCache = null) {
  if (fields.areaName?.trim()) await ensureGlobalArea(fields.areaName, areaCache);
  const ph = await prisma.masterSurveyPharmacy.create({
    data: {
      surveyId,
      name:         fields.name.trim(),
      ownerName:    fields.ownerName    ?? null,
      pharmacyName: fields.pharmacyName ?? null,
      phone:        fields.phone        ?? null,
      address:      fields.address      ?? null,
      areaName:     fields.areaName     ?? null,
      notes:        fields.notes        ?? null,
      lastEditedById: editedById ?? null,
      lastEditedAt:   new Date(),
    },
  });
  await logSurveyEdit(surveyId, 'pharmacy', ph.id, 'create', null, ph, editedById);
  return ph;
}

// ── updateSurveyPharmacy — تعديل صيدلية سيرفي موحّد (منطقة عامة + cascade اسم) ─
export async function updateSurveyPharmacy(surveyId, pharmaId, fields, editedById, areaCache = null) {
  const old = await prisma.masterSurveyPharmacy.findUnique({ where: { id: pharmaId } });
  if (!old || old.surveyId !== surveyId) return { error: 'not_found' };

  const data = { lastEditedById: editedById ?? null, lastEditedAt: new Date() };
  for (const key of ['name', 'ownerName', 'pharmacyName', 'phone', 'address', 'areaName', 'notes']) {
    if (fields[key] !== undefined) data[key] = key === 'name' ? String(fields[key]).trim() : fields[key];
  }
  if (data.areaName?.trim()) await ensureGlobalArea(data.areaName, areaCache);

  const updated = await prisma.masterSurveyPharmacy.update({ where: { id: pharmaId }, data });
  await logSurveyEdit(surveyId, 'pharmacy', pharmaId, 'update', old, updated, editedById);

  if (data.name !== undefined && data.name !== old.name) {
    await cascadePharmacyNameChange(surveyId, [old.name], data.name);
  }

  return { old, updated };
}

// ── deleteSurveyPharmacy — حذف صيدلية سيرفي موحّد (نقل الأطباء+الزيارات لأقرب بديل) ─
export async function deleteSurveyPharmacy(surveyId, pharmaId, editedById) {
  const old = await prisma.masterSurveyPharmacy.findUnique({ where: { id: pharmaId } });
  if (!old || old.surveyId !== surveyId) return { error: 'not_found' };

  const remainingPharmacies = await prisma.masterSurveyPharmacy.findMany({
    where: { surveyId, id: { not: pharmaId } }, select: { name: true },
  });
  const replacement = findClosestPharmacyName(old.name, remainingPharmacies.map(p => p.name));
  const { affectedDoctors } = await cascadePharmacyNameChange(surveyId, [old.name], replacement);

  await prisma.masterSurveyPharmacy.delete({ where: { id: pharmaId } });
  await logSurveyEdit(surveyId, 'pharmacy', pharmaId, 'delete', old, null, editedById);

  return { old, reassignedDoctors: affectedDoctors };
}

// ── mergeSurveyPharmacies — دمج صيدليات في صيدلية واحدة (نقل الأطباء+الزيارات) ─
export async function mergeSurveyPharmacies(surveyId, keepId, mergeIds, editedById) {
  const keepPharma = await prisma.masterSurveyPharmacy.findUnique({ where: { id: keepId } });
  if (!keepPharma || keepPharma.surveyId !== surveyId) return { error: 'not_found' };

  const mergePharmas = await prisma.masterSurveyPharmacy.findMany({ where: { id: { in: mergeIds }, surveyId } });
  if (mergePharmas.length === 0) return { error: 'not_found' };

  const { affectedDoctors } = await cascadePharmacyNameChange(surveyId, mergePharmas.map(p => p.name), keepPharma.name);

  const mergedIds = mergePharmas.map(p => p.id);
  await prisma.masterSurveyPharmacy.deleteMany({ where: { id: { in: mergedIds } } });
  for (const mp of mergePharmas) {
    await logSurveyEdit(surveyId, 'pharmacy', mp.id, 'delete', mp, null, editedById);
  }
  await logSurveyEdit(surveyId, 'pharmacy', keepId, 'update', keepPharma,
    { ...keepPharma, notes: `دُمجت معها: ${mergePharmas.map(p => p.name).join('، ')}` }, editedById);

  return { reassignedDoctors: affectedDoctors, mergedCount: mergedIds.length, data: keepPharma };
}

// ── Union-Find بسيط لتجميع الصيدليات المتشابهة ────────────────────────────────
class UnionFind {
  constructor(ids) { this.parent = new Map(ids.map(id => [id, id])); }
  find(id) { while (this.parent.get(id) !== id) { this.parent.set(id, this.parent.get(this.parent.get(id))); id = this.parent.get(id); } return id; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

// ── pharmacyNamesVeryClose(cleanedA, cleanedB) ───────────────────────────────
// أشد صرامة من areSimilar العامة (مصمَّمة لأسماء أدوية طويلة نسبياً بقاعدة
// "تداخل كلمات" تُطابق أي اسمين يشتركان كلمة واحدة فقط). أسماء الصيدليات
// العربية قصيرة (كلمة أو كلمتان غالباً) — تلك القاعدة كانت تُطابق أي صيدليتين
// تشتركان بكلمة عامة شائعة (مثل "النور"، "الرحمة"، "الأمل") رغم كونهما
// منشأتين مختلفتين تماماً. هنا فقط: تطابق تام بعد التطبيع، أو أحد الاسمين
// بادئة تغطي معظم الآخر (نسبة عالية لا 55%)، أو تشابه Levenshtein عالٍ جداً
// على النص الكامل (يلتقط خطأ إملائي بسيط أو اختلاف حرف ة/ه أو أ/ا).
function pharmacyNamesVeryClose(cleanedA, cleanedB) {
  const a = normalizeStr(cleanedA), b = normalizeStr(cleanedB);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  if (longer.startsWith(shorter) && shorter.length / longer.length >= 0.75) return true;
  return similarity(a, b) >= 0.86;
}

// ── findPharmacyMergeSuggestions(pharmacies, doctorCountByKey) ──────────────
// يجمّع صيدليات هذا السيرفي في مجموعات "يُحتمل أنها نفس الصيدلية بأسماء مختلفة
// قليلاً" — بادئة صيدلية/ص. مختلفة، خطأ إملائي بسيط، أو نفس الاسم مكرَّراً —
// يوفّر على السوبر أدمن البحث اليدوي بين آلاف الأسماء لإيجاد مرشّحي الدمج.
// دقّة عالية مقصودة: أفضل تفويت مرشّح حقيقي من اقتراح اسمين مختلفين فعلاً.
//
// نرتّب أبجدياً على الاسم بعد التطبيع ونقارن كل اسم بنافذة محدودة من جيرانه
// (سلوك sorted-neighborhood القياسي) بدل مقارنة كل زوج O(n²) — سيرفي واحد قد
// يحوي آلاف الصيدليات (لوحظ 2666 في الإنتاج) وحساب كل الأزواج عندها كان سيجمّد
// الطلب. المرشّحون الفعليون متقاربون أبجدياً بعد إزالة بادئة "صيدلية/ص."،
// فتلتقطهم النافذة رغم صغرها.
//
// Union-Find وحده يسمح بـ"تسلسل": لو A قريب من B وB قريب من C يجتمعون في مجموعة
// واحدة حتى لو A بعيد تماماً عن C — هذا بالضبط ما كان يُنتج مجموعات ضخمة بأسماء
// غير متشابهة فعلياً. لذا بعد التجميع الأولي نختار "الممثّل" (الأغنى بيانات:
// أكثر أطباء مرتبطين، ثم أطول اسم) ونُبقي فقط من هو قريب مباشرة من الممثّل
// نفسه — فتتحوّل كل مجموعة إلى نجمة حول اسم واحد بدل سلسلة، وهذا أصلاً شكل
// عملية الدمج (اسم يبقى + أسماء تُدمج فيه مباشرة).
const MERGE_SUGGESTION_WINDOW = 60;
export function findPharmacyMergeSuggestions(pharmacies, doctorCountByKey = new Map()) {
  const cmpKey = s => String(s ?? '').trim().toLowerCase();
  const withKey = pharmacies
    .filter(p => p.name?.trim())
    .map(p => ({ ...p, _clean: cleanPharmacyName(p.name), _doctorCount: doctorCountByKey.get(cmpKey(p.name)) ?? 0 }))
    .sort((a, b) => normalizeStr(a._clean).localeCompare(normalizeStr(b._clean)));

  const uf = new UnionFind(withKey.map(p => p.id));
  for (let i = 0; i < withKey.length; i++) {
    const a = withKey[i];
    for (let j = i + 1; j < Math.min(i + 1 + MERGE_SUGGESTION_WINDOW, withKey.length); j++) {
      const b = withKey[j];
      if (pharmacyNamesVeryClose(a._clean, b._clean)) uf.union(a.id, b.id);
    }
  }

  const groups = new Map();
  for (const p of withKey) {
    const root = uf.find(p.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  }

  const suggestions = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ranked = [...members].sort((a, b) => b._doctorCount - a._doctorCount || b.name.length - a.name.length);
    const anchor = ranked[0];
    // تنقية "النجمة": أبقِ فقط من يقترب فعلاً من الممثّل مباشرة — يستبعد أعضاء
    // انضمّوا للمجموعة عبر حلقة وسيطة بعيدة عنه.
    const kept = members.filter(m => m.id === anchor.id || pharmacyNamesVeryClose(anchor._clean, m._clean));
    if (kept.length < 2) continue;
    suggestions.push({
      suggestedKeepId: anchor.id,
      members: kept.map(({ _clean, _doctorCount, ...rest }) => ({ ...rest, doctorCount: _doctorCount })),
    });
  }

  return suggestions.sort((a, b) => b.members.length - a.members.length);
}
