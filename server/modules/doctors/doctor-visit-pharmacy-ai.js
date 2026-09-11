/**
 * استخراج اسم صيدلية الطبيب بالذكاء الاصطناعي من نص ملاحظة الزيارة (note) —
 * يعالج فجوة استيراد صيغة CRM: تلك الملفات لا تملك عموداً موثوقاً لصيدلية
 * الطبيب (عمود "associated-client" غالباً اسم عيادة لا صيدلية)، والاستخراج
 * النصي القطعي (doctor-visits-import.js) لا يلتقط إلا حالة بادئة "ص."/"صيدلية"
 * الصريحة — أغلب الملاحظات تذكر الصيدلية بلا أي بادئة، بموضع غير ثابت بين
 * الصفوف (جُرِّب استنتاج الموضع نصياً وثبت أنه غير آمن: بعض الصفوف تُدرج مقطع
 * منطقة فرعية بين الصيدلية والايتم فيُلتقَط خطأً — راجع محادثة الإصلاح).
 *
 * يُستدعى أثناء EXTRACT (قبل مراجعة المستخدم، لا بعد الحفظ كاستنتاج الفيدباك)
 * كي تظهر النتيجة في شبكة المراجعة مباشرة — القيمة تُعامَل كاقتراح لا حقيقة:
 * تُعرض في خانة قابلة للتعديل مميَّزة (pharmacyFromFile + شارة ✨ pharmacyFromAI)،
 * ولا تُحفظ في سجل الطبيب إلا إن أبقاها المستخدم عند التأكيد.
 *
 * يعيد استعمال نفس نمط الدفعات + السقف الزمني من doctor-visit-feedback-ai.js.
 */

import { callGeminiSmart } from '../ai-assistant/ai-assistant.controller.js';

const AI_BATCH_SIZE = 40;
const AI_PHARMACY_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];

function buildPharmacyPrompt(batch) {
  const list = batch.map(v => ({ id: v.id, doctor: v.doctorName || '', area: v.areaName || '', notes: v.notes }));
  return `أنت تحلل ملاحظات زيارات طبية عراقية (نص حر، أو "سطر خطة" مفصول بشرطات مائلة \\ أو شرطات عادية -) وتحاول استخراج اسم الصيدلية التي يعمل معها الطبيب إن وردت الإشارة إليها بوضوح في نص الملاحظة.

لكل زيارة: اسم الطبيب (doctor)، منطقته (area) إن عُرفت، ونص الملاحظة (notes).

قواعد صارمة:
- استخرج اسم الصيدلية فقط حين يكون مذكوراً بوضوح كافٍ — لا تخمّن أبداً.
- لا تُعِد اسم الطبيب (doctor) نفسه، ولا اسم المنطقة (area) نفسه أو جزءاً منه، كأنه اسم صيدلية.
- تحذير مهم: نص الملاحظة قد يحتوي عدة أسماء أماكن (منطقة فرعية، حي، معلم قريب) غير الصيدلية في نفس السطر — لا تلتقط أول اسم مكان تراه، ولا المقطع الأقرب للايتم موضعياً بالضرورة. مثال حقيقي على خطأ شائع: سطر خطة به مقطعان متتاليان قبل الايتم — الأول اسم الصيدلية الفعلي والثاني تفصيل منطقة فرعية (كـ"طعمة" أو اسم حي) لصق بعده بالخطأ يُظَن صيدلية؛ ميّز بينهما من السياق (اسم صيدلية حقيقي مثل "صيدلية الأمل"/"قمر الجامعة" مقابل اسم حي/منطقة كـ"الطعمة"/"حي الجامعة"/"الدورة").
- إن لم تكن واثقاً بثقة معقولة أن المقطع صيدلية تحديداً لا شيء آخر، لا تُدرج تلك الزيارة في الرد إطلاقاً — تجاهلها كلياً بدل التخمين.

الزيارات (${batch.length}):
${JSON.stringify(list)}

أعد JSON فقط — مصفوفة بدون أي نص إضافي، بهذا الشكل بالضبط:
[{"id":1,"pharmacyName":"..."}]`;
}

/**
 * يستنتج اسم الصيدلية لدفعة صفوف (id/doctorName/areaName/notes) بالذكاء
 * الاصطناعي، محترماً سقفاً زمنياً مطلقاً (epoch ms). فشل دفعة واحدة لا يوقف
 * البقية ولا يُفشل الاستخراج كله — تلك الصفوف تبقى بلا اقتراح كحالة احتياطية.
 * يعيد Map<id, pharmacyName>.
 */
export async function suggestPharmacyNamesBatched(rows, deadline) {
  const results = new Map();
  for (let i = 0; i < rows.length; i += AI_BATCH_SIZE) {
    const remaining = deadline - Date.now();
    if (remaining <= 15_000) break;
    const batch = rows.slice(i, i + AI_BATCH_SIZE);
    try {
      const raw = await callGeminiSmart([{ text: buildPharmacyPrompt(batch) }], {
        models: AI_PHARMACY_MODELS,
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
          const name = String(e?.pharmacyName ?? '').trim();
          if (batchIds.has(id) && name) results.set(id, name);
        }
      }
    } catch {
      // دفعة فشلت (شبكة/انتهاء مهلة/JSON غير صالح) — تُترك صفوفها بلا اقتراح.
    }
  }
  return results;
}

/**
 * يُثري صفوف زيارات أطباء استُخرجت للتو (doctorRows، بذاكرة لا قاعدة بيانات —
 * مرحلة المراجعة قبل الحفظ) بصيدلية مستنتَجة لمن ينقصها الاستخراج القطعي.
 * يُعدِّل rows في مكانها (pharmacyName + pharmacyFromAI)؛ فشل الذكاء الاصطناعي
 * كلياً يترك الصفوف كما هي بلا أي تأثير على بقية الاستخراج.
 */
export async function enrichDoctorRowsWithPharmacyAI(doctorRows, deadline) {
  const candidates = [];
  doctorRows.forEach((r, idx) => {
    if (!r.pharmacyName && r.notes && r.notes.trim()) {
      candidates.push({ id: idx, doctorName: r.doctorName, areaName: r.areaName, notes: r.notes });
    }
  });
  if (candidates.length === 0) return;
  try {
    const results = await suggestPharmacyNamesBatched(candidates, deadline);
    for (const [idx, name] of results) {
      doctorRows[idx].pharmacyName = name;
      doctorRows[idx].pharmacyFromAI = true;
    }
  } catch {
    // لا نُفشل الاستخراج كله لخطأ في الإثراء الاختياري بالذكاء الاصطناعي.
  }
}
