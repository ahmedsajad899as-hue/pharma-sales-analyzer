// ════════════════════════════════════════════════════════════════════════════
// bot-chat.js — محادثة حرّة مع البوت: «بوت اريد مبيعات محمد باقر شهر 10 لايتم
// amoklavin 1000» أو «زيارات محمود وعبدالله ومصطفى ومبيعاتهم».
//
// التقسيم عمداً: Gemini **يفهم** الجملة فقط ويُخرج طلباً منظماً (JSON)؛ الأرقام
// كلها تأتي من نفس دوال التطبيق (getReport / computeRepsVisitsSummary) — الموديل لا
// يحسب ولا يجيب من ذاكرته، فلا يختلق رقماً.
//
// التفعيل: كلمة «بوت» في أي موضع من الرسالة (hasBotTrigger) — لا نحلّل كل دردشة
// الكروب. ذاكرة قصيرة لكل كروب لمتابعة مثل «وعبدالله؟».
// ════════════════════════════════════════════════════════════════════════════

import { callAI } from '../../lib/claudeAi.js';
import { parseInvoiceJson } from '../sales/sales.service.js';
import { buildRepIndex, matchRepName } from '../../lib/repNameMatch.js';
import {
  MONTH_NAMES_AR, fmtUSD, resolveBotFileIds, loadRepIndex, fetchRepSalesReport,
} from './sales-query.js';

// «بوت» / «البوت» / «bot» ككلمة مستقلة — لا داخل كلمة أخرى (مثل «بوتاس»).
// الحدود يدوية لأن \b لا تعمل مع العربية في JS.
const BOT_WORD_RE = /(^|[\s،,.!؟?:;\-–—()«»"'])(?:ال)?(?:بوت|bot)(?=$|[\s،,.!؟?:;\-–—()«»"'])/giu;

export const hasBotTrigger = (text) => {
  BOT_WORD_RE.lastIndex = 0;
  return BOT_WORD_RE.test(String(text ?? ''));
};
const stripBotWord = (text) =>
  String(text ?? '').replace(BOT_WORD_RE, '$1 ').replace(/\s+/g, ' ').trim();

const MAX_TEXT_LEN = 500;
const MAX_PEOPLE = 8;
const MAX_MONTHS = 3;

// ── ذاكرة المحادثة القصيرة: آخر طلب منظم لكل كروب (10 دقائق) ───────────────
const CONTEXT_TTL_MS = 10 * 60 * 1000;
const lastQuery = new Map(); // chatId → { q, ts }
const getContext = (chatId) => {
  const c = lastQuery.get(chatId);
  return c && Date.now() - c.ts < CONTEXT_TTL_MS ? c.q : null;
};
const setContext = (chatId, q) => {
  lastQuery.set(chatId, { q, ts: Date.now() });
  while (lastQuery.size > 200) lastQuery.delete(lastQuery.keys().next().value);
};

// تاريخ اليوم بتوقيت بغداد (UTC+3) — سيرفر بتوقيت آخر كان سيُخطئ «الشهر الحالي» قرب نهاية الشهر.
function todayBaghdad() {
  const d = new Date(Date.now() + 3 * 3600_000);
  return { iso: d.toISOString().slice(0, 10), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

const buildPrompt = (today, previous) => `أنت مُحلّل أسئلة لبوت مبيعات أدوية في كروب تلكرام (لهجة عراقية). حوّل رسالة المستخدم إلى طلب منظم فقط — لا تجب على السؤال ولا تحسب أي رقم.

تاريخ اليوم: ${today.iso} (الشهر الحالي ${today.month} من ${today.year}).

الأنواع المدعومة حالياً: **مبيعات** مندوب/مندوبين، و**زيارات** (أطباء وصيدليات) مندوب/مندوبين، أو الاثنين معاً.

أعِد كائن JSON واحداً فقط بلا شرح وبلا أسوار \`\`\`:
{
  "intent": "query" أو "other",
  "wantSales": true/false,
  "wantVisits": true/false,
  "people": ["اسم 1", "اسم 2"],
  "months": [{"month": 10, "year": ${today.year}}],
  "item": "اسم الايتم + التركيز كما كُتب" أو null
}

القواعد:
- "intent" = "other" إن لم يكن الطلب عن مبيعات أو زيارات مندوب (تحية، سؤال عام، موضوع آخر).
- الأسماء: كل مندوب مذكور كعنصر منفصل بالصيغة التي كُتبت. «محمود وعبدالله ومصطفى» = ثلاثة عناصر. لا تضف كلمة «مندوب». إن قال «مبيعاتهم/زياراتهم» فالمقصود الأسماء المذكورة.
- الشهور: إن لم يُذكر شهر فالشهر الحالي. «الشهر الماضي» = الشهر الذي قبل الحالي (انتبه لتغيّر السنة). «شهر 10» = 10 من السنة الحالية ما لم تُذكر سنة. نطاق «من شهر 8 الى 10» = ثلاثة عناصر. بحدّ أقصى ${MAX_MONTHS} أشهر.
- "item": الايتم المطلوب فقط إن ذُكر (مثل «amoklavin دوز 1000» → "amoklavin 1000"). ألغِ كلمات مثل «دوز/جرعة/ايتم/مادة». يبقى null إن لم يُذكر.
- "wantSales": مبيعات/مبيع/بيع/شكد باع. "wantVisits": زيارات/كولات/زار. إن ذُكر الاثنان فكلاهما true. إن لم يحدد نوعاً صراحةً وكان الطلب عن مندوب فاجعل wantSales=true.
- المتابعة: إن بدت الرسالة تكملةً لسؤال سابق («وعبدالله؟»، «وزياراته؟»، «والشهر الماضي؟») فورِّث الحقول الناقصة من الطلب السابق أدناه.
${previous ? `\nالطلب السابق في هذا الكروب (للمتابعة فقط): ${JSON.stringify(previous)}` : '\nلا يوجد طلب سابق.'}`;

function sanitizeQuery(raw, today) {
  if (!raw || typeof raw !== 'object') return null;
  const people = (Array.isArray(raw.people) ? raw.people : [])
    .map(p => String(p ?? '').trim()).filter(Boolean).slice(0, MAX_PEOPLE);
  let months = (Array.isArray(raw.months) ? raw.months : [])
    .map(m => ({ month: Number(m?.month), year: Number(m?.year) || today.year }))
    .filter(m => m.month >= 1 && m.month <= 12 && m.year >= 2020 && m.year <= today.year + 1)
    .slice(0, MAX_MONTHS);
  if (!months.length) months = [{ month: today.month, year: today.year }];
  const wantVisits = raw.wantVisits === true;
  const wantSales = raw.wantSales === true || !wantVisits;
  return {
    intent: raw.intent === 'query' ? 'query' : 'other',
    wantSales, wantVisits, people, months,
    item: raw.item ? String(raw.item).trim().slice(0, 80) || null : null,
  };
}

async function understand(text, chatId, today) {
  const previous = getContext(chatId);
  const reply = await callAI(
    [buildPrompt(today, previous), `رسالة المستخدم:\n«${text}»`],
    { timeoutMs: 25_000, thinkingBudget: 0, feature: 'telegram-bot-chat' },
  );
  // parseInvoiceJson يتوقع مصفوفة غالباً؛ نحاول الكائن مباشرة أولاً.
  const cleaned = String(reply ?? '').replace(/```json|```/gi, '').trim();
  let obj = null;
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    obj = m ? JSON.parse(m[0]) : null;
  } catch { /* يُجرَّب المسار الاحتياطي */ }
  if (!obj) { const arr = parseInvoiceJson(reply); obj = Array.isArray(arr) ? arr[0] : null; }
  return sanitizeQuery(obj, today);
}

// مطابقة نصّ الايتم: كل كلمة من الطلب يجب أن تُوجد في اسم الايتم (حروف صغيرة، أرقام لاتينية).
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const normItem = (s) => String(s ?? '').replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d))).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function filterItems(byItem, itemQuery) {
  const tokens = normItem(itemQuery).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  return (byItem ?? []).filter(i => {
    const n = normItem(i.itemName);
    return tokens.every(t => n.includes(t));
  });
}

const monthLabel = ({ month, year }) => `${MONTH_NAMES_AR[month]} ${year}`;

function askBlock(raw, suggestions) {
  const list = (suggestions ?? []).slice(0, 5).map(s => `• ${s.name}${s.company ? ` (${s.company})` : ''}`).join('\n');
  return `⚠️ «${raw}»: وجدت أكثر من مندوب بهذا الاسم — حدّد أكثر (مثلاً أضف الشركة):\n${list}`;
}

async function runSales({ actorUser, q, index, files }) {
  const blocks = [];
  for (const person of q.people) {
    const lines = [];
    let headerName = person;
    for (const m of q.months) {
      const r = await fetchRepSalesReport({ actorUser, index, repNameRaw: person, ...m, files });
      if (r.status === 'none') { lines.length = 0; blocks.push(`❓ ما لقيت مندوباً باسم «${person}».`); break; }
      if (r.status === 'ask') { lines.length = 0; blocks.push(askBlock(person, r.suggestions)); break; }
      if (r.status === 'nofiles') return ['لا توجد ملفات مبيعات مفعّلة لهذا الحساب.'];
      headerName = r.rep.name;
      const { summary, byItem, bySource } = r.report;
      if (q.item) {
        const hits = filterItems(byItem, q.item);
        if (!hits.length) {
          lines.push(`• ${monthLabel(m)}: لا مبيعات لـ«${q.item}»`);
        } else {
          lines.push(`• ${monthLabel(m)}:`);
          for (const h of hits.slice(0, 5)) lines.push(`   ${h.itemName}: الكمية ${Math.round(h.totalQuantity).toLocaleString('en-US')} — ${fmtUSD(h.totalValue)}`);
          if (hits.length > 5) lines.push(`   … و${hits.length - 5} ايتم مطابق آخر`);
        }
      } else {
        let l = `• ${monthLabel(m)}: ${fmtUSD(summary.totalValue)} — ${summary.orderCount} طلبية`;
        if (bySource?.hasOffice && bySource?.hasMercato) {
          l += ` (مكتب ${fmtUSD(bySource.office.totalValue)} / ميركاتو ${fmtUSD(bySource.mercato.totalValue)})`;
        }
        lines.push(l);
      }
    }
    if (lines.length) blocks.push(`📊 مبيعات ${headerName}${q.item ? ` — «${q.item}»` : ''}\n${lines.join('\n')}`);
  }
  return blocks;
}

async function runVisits({ actorUser, q }) {
  const { computeRepsVisitsSummary } = await import('../doctors/doctors.controller.js');
  const blocks = [];
  const perMonth = [];
  for (const m of q.months) {
    const data = await computeRepsVisitsSummary(actorUser, { month: m.month, year: m.year });
    perMonth.push({ m, reps: data.reps ?? [] });
  }
  const pool = perMonth[0]?.reps ?? [];
  if (!pool.length) return ['لا يوجد مندوبون ضمن فريق هذا الحساب لعرض زياراتهم.'];
  const index = buildRepIndex(pool.map(r => ({ id: r.userId, name: r.name, company: r.company?.name ?? null })));

  for (const person of q.people) {
    const { status, rep, suggestions } = matchRepName(person, index);
    if (status === 'none') { blocks.push(`❓ ما لقيت مندوباً باسم «${person}» ضمن فريقك.`); continue; }
    if (status === 'ask' || !rep) { blocks.push(askBlock(person, suggestions)); continue; }
    const lines = [];
    for (const { m, reps } of perMonth) {
      const r = reps.find(x => x.userId === rep.id);
      if (!r) { lines.push(`• ${monthLabel(m)}: لا بيانات`); continue; }
      lines.push(
        `• ${monthLabel(m)}: أطباء ${r.doctorVisitCount} زيارة (${r.visitedDoctors} من ${r.totalDoctors} طبيب، تغطية ${r.coveragePct}%)`
        + ` — صيدليات ${r.pharmacyVisitCount} زيارة (${r.visitedPharmacies} من ${r.totalPharmacies})`,
      );
    }
    blocks.push(`🩺 زيارات ${rep.name}\n${lines.join('\n')}`);
  }
  return blocks;
}

const HELP_TEXT = 'أكدر أجاوبك عن المبيعات والزيارات. مثال:\n'
  + '«بوت اريد مبيعات محمد باقر شهر 10 لايتم amoklavin 1000»\n'
  + '«بوت زيارات محمود وعبدالله ومصطفى ومبيعاتهم»';

/**
 * @returns {Promise<string|null>} نص الرد، أو null إن لم يكن هناك ما يُرسَل
 */
export async function answerBotChat({ actorUser, chatId, text }) {
  const body = stripBotWord(text).slice(0, MAX_TEXT_LEN);
  if (!body) return HELP_TEXT;

  const today = todayBaghdad();
  const q = await understand(body, String(chatId), today);
  if (!q) return '⚠️ ما قدرت أفهم الطلب — جرّب تعيد صياغته.';
  if (q.intent === 'other' || (!q.people.length)) {
    return q.intent === 'other' ? HELP_TEXT : 'مين المندوب اللي تقصده؟ اكتب اسمه مع طلبك.';
  }

  setContext(String(chatId), q);

  const index = q.wantSales ? await loadRepIndex(actorUser) : null;
  if (q.wantSales && !index) return 'لا يوجد كتالوج مندوبين مرئي لهذا الحساب.';
  const files = q.wantSales ? await resolveBotFileIds(actorUser.id) : null;

  const parts = [];
  if (q.wantSales) parts.push(...await runSales({ actorUser, q, index, files }));
  if (q.wantVisits) parts.push(...await runVisits({ actorUser, q }));

  if (q.wantSales && files && !files.synced && files.ids.length) {
    parts.push('⚠️ محسوب على كل ملفات المكتب وقد يتضمّن تكراراً — افتح التطبيق بهذا الحساب مرة ليُزامَن «الملفات المفعّلة».');
  }
  return parts.join('\n\n') || HELP_TEXT;
}
