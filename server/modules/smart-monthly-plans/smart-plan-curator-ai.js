/**
 * "منسّق" (curator) الفئة الواحدة داخل البلان الذكي — يُستدعى فقط على فائض
 * bucket مُشبَع أصلاً (مرشّحون مؤهَّلون أكثر من العدد الثابت المطلوب لهذا
 * bucket)، ويختار بالضبط quota فائزين مع سبب مختصر لكل اختيار. لا يقرر أبداً
 * العدد نفسه (محسوم سلفاً بخوارزمية computeBucketPlan الحتمية في
 * smartPlanMatching.js) — فقط "مَن الأفضل" ضمن عدد ثابت.
 *
 * نفس نمط الدُّفعة/السقف الزمني في doctor-visit-feedback-ai.js، لكن بلا تقسيم
 * دُفعات هنا: الترتيب النسبي يحتاج رؤية كل مرشّحي الـbucket معاً دفعة واحدة —
 * حجم واقعي لهذا التطبيق (بلان شهري = عشرات لا آلاف الأطباء لكل فئة)، مع سقف
 * أمان MAX_POOL يمنع نداءً ضخماً غير متوقَّع.
 */

import { callGeminiSmart } from '../ai-assistant/ai-assistant.controller.js';

const AI_CURATOR_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];
const MAX_POOL = 300; // سقف أمان — لا يُتوقَّع بلوغه عملياً لفئة واحدة ضمن بلان شهري

function buildCuratorPrompt(bucketLabel, quota, pool) {
  const list = pool.map(c => ({
    id: c.id,
    name: c.rawName,
    area: c.areaName || null,
    pharmacy: c.pharmacyName || null,
    items: c.items || [],
    matchConfidence: c.matchConfidence != null ? Math.round(c.matchConfidence * 100) / 100 : null,
  }));
  return `أنت تساعد مندوباً طبياً على اختيار أفضل ${quota} طبيباً من قائمة مرشّحين لفئة "${bucketLabel}" ضمن بلانه الشهري (عدد المرشّحين أكبر من العدد المطلوب لهذه الفئة تحديداً).

فضّل: مرشّحين ببيانات أوثق (منطقة/صيدلية/ايتمات معروفة)، ثقة مطابقة أعلى (matchConfidence)، وتنوّعاً جغرافياً معقولاً (لا تُكدِّس كل الاختيارات في منطقة واحدة إن وُجد بديل جيد في مناطق أخرى ضمن نفس الفئة).

القائمة (${list.length} مرشّحاً):
${JSON.stringify(list)}

اختر بالضبط ${quota} من هذه المعرّفات (لا أكثر ولا أقل إن توفّر العدد)، مرتَّبة من الأفضل، مع سبب مختصر (أقل من 12 كلمة) لكل اختيار.

أعد JSON فقط — مصفوفة بدون أي نص إضافي، بهذا الشكل بالضبط:
[{"id":123,"reason":"منطقة نشطة وثقة مطابقة عالية","score":0.9}]`;
}

/**
 * يرتّب فائض bucket واحد ويختار أفضل quota منهم. عند فشل Gemini (شبكة/JSON
 * غير صالح) يقع احتياطياً على ترتيب حتمي بسيط (matchConfidence تنازلياً) بدل
 * ترك الفئة بلا فائزين — النتيجة تبقى صالحة للتصدير دائماً.
 * @returns {{id:number, reason:string|null, score:number|null}[]} أول quota فقط
 */
export async function curateBucket(bucketLabel, candidates, quota, deadlineMs = 60_000) {
  if (candidates.length <= quota) {
    return candidates.map(c => ({ id: c.id, reason: null, score: c.matchConfidence ?? null }));
  }

  const pool = candidates.slice(0, MAX_POOL);
  const deadline = Date.now() + deadlineMs;

  try {
    const raw = await callGeminiSmart([{ text: buildCuratorPrompt(bucketLabel, quota, pool) }], {
      models: AI_CURATOR_MODELS, thinkingBudget: 0, timeoutMs: 55_000, maxTotalMs: deadline - Date.now(),
    });
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr) || !arr.length) throw new Error('empty');

    const poolIds = new Set(pool.map(c => c.id));
    const picked = [];
    const seen = new Set();
    for (const entry of arr) {
      const id = Number(entry?.id);
      if (!poolIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      picked.push({ id, reason: String(entry?.reason ?? '').trim() || null, score: Number.isFinite(entry?.score) ? entry.score : null });
      if (picked.length >= quota) break;
    }
    if (picked.length < quota) {
      // Gemini أعاد أقل من المطلوب — نكمل العدد احتياطياً من الباقين بترتيب matchConfidence
      const rest = pool.filter(c => !seen.has(c.id)).sort((a, b) => (b.matchConfidence ?? 0) - (a.matchConfidence ?? 0));
      for (const c of rest) {
        if (picked.length >= quota) break;
        picked.push({ id: c.id, reason: null, score: c.matchConfidence ?? null });
      }
    }
    return picked;
  } catch {
    return [...pool]
      .sort((a, b) => (b.matchConfidence ?? 0) - (a.matchConfidence ?? 0))
      .slice(0, quota)
      .map(c => ({ id: c.id, reason: null, score: c.matchConfidence ?? null }));
  }
}
