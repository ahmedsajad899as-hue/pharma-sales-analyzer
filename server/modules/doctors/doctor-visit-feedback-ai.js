/**
 * استنتاج فيدباك زيارة الطبيب (DoctorVisit.feedback) تلقائياً من نص الملاحظات
 * (notes) بالذكاء الاصطناعي — يعالج فجوة استيراد صيغة CRM: ذلك المسار لا يملك
 * عموداً موثوقاً للفيدباك فيحفظه دائماً 'pending' (راجع FEEDBACK_RULES/mapFeedback
 * في doctor-visits-import.js)، رغم أن نص الملاحظات الحر غالباً يتضمّن فعلياً ما
 * قرره الطبيب. النتيجة تُعامَل كاقتراح لا حقيقة نهائية: تُحفظ بـfeedbackSource
 * 'import_ai' لتمييزها في الواجهة (شارة ✨)، وأي تعديل يدوي لاحق يُسقِط العلامة.
 *
 * يعيد استعمال نفس نمط analyzeSurveyEntriesBatched في item-analysis.controller.js
 * (دفعات + سقف زمني) بدل اختراع آلية جديدة — راجع التعليق هناك لخلفية لماذا
 * الدفعات ضرورية (نداء واحد ضخم يتجاوز مهلة Gemini/الوسيط).
 */

import prisma from '../../lib/prisma.js';
import { callGeminiSmart } from '../ai-assistant/ai-assistant.controller.js';

const AI_BATCH_SIZE = 40;
const AI_FEEDBACK_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];

// نفس قيم Enum الحرّ الموثّق في schema.prisma (DoctorVisit.feedback) — pending
// مستثناة عمداً: ليست استنتاجاً بل هي حالة "لم يُحسم" نفسها.
const FEEDBACK_VALUES = ['writing', 'stocked', 'interested', 'not_interested', 'unavailable'];

const FEEDBACK_DEFINITIONS = `
- writing: الطبيب قرر أو وافق على "كتابة" المادة (وصفها للمرضى) — مثل "قرر يكتبها" أو "وافق على الكتابة" أو "بدأ يكتب المادة". يشمل أيضاً "تذكير الطبيب بكتابة المادة" أو "متابعة من اجل الكتابة" — فهذه صيغة تعني أن الطبيب بدأ الكتابة فعلاً ووفّر المادة، والزيارة مجرد تذكير/متابعة لاستمراره، فتُصنَّف writing أيضاً لا pending.
- stocked: تم تأكيد توفير/تخزين المادة في الصيدلية المرتبطة بالطبيب — مثل "تم توفيرها بالصيدلية" أو "موجودة عنده حالياً".
- interested: الطبيب أبدى اهتماماً إيجابياً بالمادة لكن بلا قرار كتابة أو تخزين مؤكَّد بعد — مثل "مهتم بالمادة" أو "اخذ فيدباك إيجابي" أو "بيهتم يجربها".
- not_interested: الطبيب رفض المادة أو صرّح أنه لا يحتاجها أو غير مهتم بها — مثل "لا يحتاج المادة" أو "غير مهتم حالياً" أو "رفض".
- unavailable: الطبيب يريد المادة لكنها غير متوفرة له فعلياً (منافس يشغل مكانها، أو نفدت من الصيدلية) — مثل "يوجد كومبتيتر" أو "غير متوفرة حالياً بالصيدلية".
`.trim();

function buildFeedbackPrompt(batch) {
  const list = batch.map(v => ({ id: v.id, item: v.itemName || '', notes: v.notes }));
  return `أنت تحلل ملاحظات كتبها مندوبون طبيون بعد زيارة أطباء عراقيين، وتستنتج منها "فيدباك" الطبيب تجاه مادة دوائية معينة.

كل زيارة لها حقل "item" — هو الايتم الذي زار المندوب الطبيب بخصوصه تحديداً. الفيدباك يتعلق بهذا الايتم حصراً، لا بأي مادة أخرى ورد ذكرها في النص.

القيم المسموحة فقط:
${FEEDBACK_DEFINITIONS}

قواعد صارمة:
- قاعدة حاسمة: إذا ذكرت الملاحظة أن الطبيب يكتب/يهتم/يخزّن مادة مختلفة عن item المعطى لهذه الزيارة (منافس يشغل مكان الايتم المستهدف)، فهذا ليس writing ولا interested ولا stocked لهذا الايتم إطلاقاً — صنّفه unavailable (منافس يشغل مكانه) لا حالة الطبيب تجاه المادة الأخرى.
  مثال: item="pantactive"، والملاحظة "الدكتور اوضح حاليا انه يكتب rapibrazole" → الفيدباك الصحيح unavailable (يكتب مادة أخرى غير pantactive)، وليس writing.
- لا تخمّن أبداً. إن كان نص الملاحظة غامضاً أو لا يكفي لحسم فئة واحدة بثقة معقولة، لا تُدرج تلك الزيارة في الرد إطلاقاً — تجاهلها كلياً بدل وضع قيمة عشوائية.
- أعد فقط الزيارات التي استطعت تصنيفها بثقة معقولة.
- لا تُرجع أي قيمة خارج القائمة الخمسة أعلاه.

الزيارات (${batch.length}):
${JSON.stringify(list)}

أعد JSON فقط — مصفوفة بدون أي نص إضافي، بهذا الشكل بالضبط:
[{"id":123,"feedback":"writing"}]`;
}

/**
 * يصنّف دفعة زيارات (id/notes/itemName) بالذكاء الاصطناعي، محترماً سقفاً زمنياً
 * مطلقاً (epoch ms) — نفس فلسفة analyzeSurveyEntriesBatched: فشل دفعة واحدة
 * (شبكة/JSON غير صالح) لا يوقف البقية، وتلك الزيارات تبقى 'pending' كحالة
 * احتياطية آمنة بدل تعطيل الاستيراد كله.
 * يعيد Map<visitId, feedback> — زيارة غائبة عن الخريطة = لم تُحسم.
 */
export async function inferVisitFeedbackBatched(visits, deadline) {
  const results = new Map();
  let processed = 0;
  for (let i = 0; i < visits.length; i += AI_BATCH_SIZE) {
    const remaining = deadline - Date.now();
    if (remaining <= 15_000) return { results, processed, total: visits.length, timedOut: true };
    const batch = visits.slice(i, i + AI_BATCH_SIZE);
    try {
      const raw = await callGeminiSmart([{ text: buildFeedbackPrompt(batch) }], {
        models: AI_FEEDBACK_MODELS,
        thinkingBudget: 0,
        timeoutMs: 45_000,
        maxTotalMs: remaining,
      });
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        const batchIds = new Set(batch.map(v => v.id));
        for (const e of arr) {
          const id = Number(e?.id);
          const feedback = String(e?.feedback ?? '');
          if (batchIds.has(id) && FEEDBACK_VALUES.includes(feedback)) results.set(id, feedback);
        }
      }
    } catch {
      // دفعة فشلت (شبكة/انتهاء مهلة/JSON غير صالح) — تُترك زياراتها 'pending'؛
      // لا نرمي، كي لا تُفشل الاستيراد أو باقي الدفعات.
    }
    processed += batch.length;
  }
  return { results, processed, total: visits.length, timedOut: false };
}

async function applyInferredFeedback(visits, deadline) {
  const { results } = await inferVisitFeedbackBatched(visits, deadline);
  if (results.size === 0) return 0;
  await prisma.$transaction(
    [...results.entries()].map(([id, feedback]) =>
      prisma.doctorVisit.update({ where: { id }, data: { feedback, feedbackSource: 'import_ai' } })
    )
  );
  return results.size;
}

/**
 * نقطة الاستدعاء التلقائية بعد استيراد ملف زيارات: تفحص زيارات هذا الملف فقط
 * التي بقيت 'pending' بلا مصدر فيدباك بعد، وذات ملاحظات غير فارغة، وتستنتج لها
 * فيدباكاً. تُستدعى بلا انتظار (fire-and-forget) من commitVisitsImport — فشلها
 * لا يجوز أن يُفشل استجابة الاستيراد نفسها.
 */
export async function runFeedbackInferenceForImportFile(importFileId) {
  if (!importFileId) return { updated: 0, total: 0 };
  const visits = await prisma.doctorVisit.findMany({
    where: { visitImportFileId: importFileId, feedback: 'pending', feedbackSource: null, notes: { not: null } },
    select: { id: true, notes: true, itemName: true },
  });
  const withNotes = visits.filter(v => v.notes && v.notes.trim());
  if (withNotes.length === 0) return { updated: 0, total: 0 };
  const deadline = Date.now() + 180_000;
  const updated = await applyInferredFeedback(withNotes, deadline);
  return { updated, total: withNotes.length };
}

/**
 * معالجة شاملة لمرة واحدة (سكربت يدوي — راجع server/scripts/backfill-visit-
 * feedback.js) لكل زيارات قاعدة البيانات العالقة بحالة 'pending' من استيرادات
 * سابقة. ترقيم بالمؤشر (id > cursor) لا OFFSET حتى لا تتكرر نفس الدفعة إلى ما
 * لا نهاية عند بقاء صف غير محسوم (الذكاء الاصطناعي تجاهله لغموض النص) — المؤشر
 * يتقدم دائماً بصرف النظر عن نتيجة الاستنتاج.
 */
export async function backfillPendingVisitFeedback({ batchSize = 500, onProgress } = {}) {
  let totalSeen = 0, totalUpdated = 0, cursor = 0;
  while (true) {
    const visits = await prisma.doctorVisit.findMany({
      where: { id: { gt: cursor }, feedback: 'pending', feedbackSource: null, notes: { not: null } },
      select: { id: true, notes: true, itemName: true },
      take: batchSize,
      orderBy: { id: 'asc' },
    });
    if (visits.length === 0) break;
    cursor = visits[visits.length - 1].id;

    const withNotes = visits.filter(v => v.notes && v.notes.trim());
    if (withNotes.length) {
      totalSeen += withNotes.length;
      const deadline = Date.now() + 180_000;
      totalUpdated += await applyInferredFeedback(withNotes, deadline);
    }
    onProgress?.({ totalSeen, totalUpdated, cursor });
  }
  return { totalSeen, totalUpdated };
}

/**
 * إعادة تصنيف لمرة واحدة (سكربت يدوي — راجع server/scripts/reclassify-visit-
 * feedback.js) لكل زيارة سبق أن صنّفها الذكاء الاصطناعي (feedbackSource=
 * 'import_ai')، بعد تصحيح البرومبت ليُميّز الايتم المستهدف عن أي مادة أخرى
 * وردت في النص (كانت زيارات "الطبيب يكتب مادة منافسة غير الايتم المستهدف"
 * تُصنَّف خطأً writing بدل unavailable). لا يُقيَّد بـfeedback='pending' —
 * الهدف هنا تصحيح تصنيف موجود لا ملء فراغ.
 */
export async function reclassifyImportAiFeedback({ batchSize = 500, onProgress } = {}) {
  let totalSeen = 0, totalChanged = 0, cursor = 0;
  while (true) {
    const visits = await prisma.doctorVisit.findMany({
      where: { id: { gt: cursor }, feedbackSource: 'import_ai', notes: { not: null } },
      select: { id: true, notes: true, itemName: true, feedback: true },
      take: batchSize,
      orderBy: { id: 'asc' },
    });
    if (visits.length === 0) break;
    cursor = visits[visits.length - 1].id;

    const withNotes = visits.filter(v => v.notes && v.notes.trim());
    if (withNotes.length) {
      totalSeen += withNotes.length;
      const deadline = Date.now() + 180_000;
      const { results } = await inferVisitFeedbackBatched(withNotes, deadline);
      const changed = [...results.entries()].filter(([id, fb]) => fb !== withNotes.find(v => v.id === id)?.feedback);
      if (changed.length) {
        await prisma.$transaction(
          changed.map(([id, feedback]) => prisma.doctorVisit.update({ where: { id }, data: { feedback, feedbackSource: 'import_ai' } }))
        );
        totalChanged += changed.length;
      }
    }
    onProgress?.({ totalSeen, totalChanged, cursor });
  }
  return { totalSeen, totalChanged };
}
