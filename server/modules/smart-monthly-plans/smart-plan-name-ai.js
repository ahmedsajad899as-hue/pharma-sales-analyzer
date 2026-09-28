/**
 * حسم الأسماء الملتبسة (تصنيف "ask" من classifyDoctorRows) في البلان الذكي —
 * بعد أن تعجز المطابقة الحتمية عن الحسم بثقة (لا رابط محفوظ ولا تطابق تام)،
 * يُعرَض على Gemini اسم كل طبيب ملتبس مع مرشّحيه (حتى 5، بالاسم/المنطقة/
 * الاختصاص/الصيدلية ودرجة تشابهه) ليختار الأفضل من بينهم فقط — أو يقرر أنه
 * طبيب جديد كلياً. لا يخترع Gemini أبداً معرّفاً غير موجود في قائمة المرشّحين.
 *
 * نفس نمط الدُّفعات + السقف الزمني المطلق في doctor-visit-feedback-ai.js
 * (inferVisitFeedbackBatched) بدل اختراع آلية جديدة — فشل دفعة واحدة لا يوقف
 * البقية، وأي اسم لم يُحسم يبقى 'ask' لمراجعة بشرية لاحقة.
 */

import { callGeminiSmart } from '../ai-assistant/ai-assistant.controller.js';
import { getAmbiguousCandidates, applyAiCandidateMatch } from '../../lib/smartPlanMatching.js';

const AI_BATCH_SIZE = 40;
const AI_NAME_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];

function buildNamePrompt(batch) {
  const list = batch.map(g => ({
    key: g.key,
    name: g.raw,
    area: g.areaName || null,
    pharmacy: g.pharmacyName || null,
    candidates: (g.suggestions || []).map(s => ({
      id: s.id, name: s.name, area: s.areaName || null,
      specialty: s.specialty || null, pharmacy: s.pharmacyName || null,
      score: Math.round((s.score || 0) * 100) / 100,
    })),
  }));
  return `أنت تراجع أسماء أطباء مستخرَجة من ملفات Excel مختلفة (موصفين/مرشحين/سيرفي) لبناء بلان شهري لمندوب طبي، وتحاول ربط كل اسم بسجل الطبيب الصحيح إن وُجد ضمن "candidates" المُعطاة له فقط.

لكل اسم في القائمة أدناه، اختر id أفضل مرشّح من candidates إن كنت واثقاً أنه نفس الشخص فعلاً (نفس الاسم تقريباً + نفس المنطقة/الصيدلية غالباً)، أو أعد "new" إن لم يكن أيٌّ من المرشحين هو نفس الشخص فعلياً (حتى لو تشابهت الأسماء شكلياً، قد يكونان طبيبين مختلفين في نفس التخصص).

قواعد صارمة:
- لا تخترع أبداً id غير موجود في candidates الخاصة بذلك الاسم تحديداً.
- عند الشك الحقيقي (لا يوجد مرشّح واضح التفوّق)، أعد "new" — لا تخمّن.
- لا تُدرج في الرد أي اسم لم تستطع حسمه بثقة معقولة؛ تجاهله كلياً بدل تخمين عشوائي.

الأسماء (${list.length}):
${JSON.stringify(list)}

أعد JSON فقط — مصفوفة بدون أي نص إضافي، بهذا الشكل بالضبط:
[{"key":"...","pick":"123","reason":"نفس الاسم ونفس المنطقة"},{"key":"...","pick":"new","reason":"لا مرشّح مطابق فعلياً"}]`;
}

/**
 * يشغّل تمريرة Gemini على كل الأسماء الملتبسة الحالية لهذا البلان، ويكتب
 * النتائج مباشرة عبر confirmCandidateMatch (نفس مسار التأكيد البشري — يحفظ
 * DoctorNameLink بثقة 'fuzzy' لأن Gemini وحده حسم، لا مراجعة بشرية).
 * يُرجع عدّادات للعرض في الواجهة؛ لا يرمي أبداً — فشل كامل = صفر تغييرات.
 */
export async function aiResolveSmartPlanCandidates(smartPlanId, ownerUserId, deadlineMs = 180_000) {
  const deadline = Date.now() + deadlineMs;
  const groups = await getAmbiguousCandidates(smartPlanId, ownerUserId);
  const withCandidateId = groups.filter(g => g.candidateId && g.suggestions?.length);
  if (!withCandidateId.length) return { resolved: 0, newDoctors: 0, total: groups.length, timedOut: false };

  let resolved = 0, newDoctors = 0, timedOut = false;
  for (let i = 0; i < withCandidateId.length; i += AI_BATCH_SIZE) {
    const remaining = deadline - Date.now();
    if (remaining <= 15_000) { timedOut = true; break; }
    const batch = withCandidateId.slice(i, i + AI_BATCH_SIZE);
    let arr;
    try {
      const raw = await callGeminiSmart([{ text: buildNamePrompt(batch) }], {
        models: AI_NAME_MODELS, thinkingBudget: 0, timeoutMs: 45_000, maxTotalMs: remaining,
      });
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      arr = JSON.parse(cleaned);
    } catch {
      continue; // دفعة فشلت (شبكة/JSON غير صالح) — تبقى أسماؤها 'ask'، نتابع البقية
    }
    if (!Array.isArray(arr)) continue;

    const byKey = new Map(batch.map(g => [g.key, g]));
    for (const entry of arr) {
      const g = byKey.get(String(entry?.key ?? ''));
      if (!g) continue;
      const pick = String(entry?.pick ?? '').trim();
      if (!pick) continue;
      let doctorId = null;
      let score = null;
      if (pick !== 'new') {
        const asNum = Number(pick);
        const matchedSuggestion = g.suggestions.find(s => s.id === asNum);
        if (!matchedSuggestion) continue; // Gemini اخترع id غير موجود — نتجاهل هذا الاسم، يبقى 'ask'
        doctorId = asNum;
        score = matchedSuggestion.score ?? null;
      }
      const reason = String(entry?.reason ?? '').trim() || null;
      try {
        await applyAiCandidateMatch(smartPlanId, ownerUserId, g.candidateId, doctorId, { reason, score });
        doctorId ? resolved++ : newDoctors++;
      } catch { /* صفّ واحد فشل — لا يوقف الباقي */ }
    }
  }
  return { resolved, newDoctors, total: withCandidateId.length, timedOut };
}
