// ════════════════════════════════════════════════════════════════════════════
// companyResolver.js — مطابقة اسم شركة قادم من ملف إكسل بشركة في النظام
// ────────────────────────────────────────────────────────────────────────────
// نظير resolveItemName في itemResolver.js، لكن للشركات. بُني بنفس الترتيب
// والدلالات (alias ← exact ← fuzzy) كي لا تختلف قراءة الثقة بين الشاشتين.
//
// لم يكن في النظام أي مطابقة ضبابية لأسماء الشركات العلمية إطلاقاً — كل
// الاستعلامات كانت بالمعرّف أو بالاسم الحرفي.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeItemKey } from './itemResolver.js';
import { areSimilar, similarity } from './fuzzyMatch.js';

/**
 * لواحق الدولة في كود الملف. تشمل صيغة الاسم والنسبة معاً لأن الملف يخلط
 * بينهما: «ALBALSAM + IRAQI» و«AROMA + Turkey». الأطول أولاً كي لا تقطع
 * «IRAQ» جزءاً من «IRAQI» فيبقى حرف I ملتصقاً باسم الشركة.
 */
const COUNTRY_SUFFIXES = [
  'IRAQI', 'IRAQ', 'TURKISH', 'TURKEY', 'ITALIAN', 'ITALY', 'EGYPTIAN', 'EGYPT',
  'INDIAN', 'INDIA', 'JORDANIAN', 'JORDAN', 'SYRIAN', 'SYRIA', 'LEBANESE', 'LEBANON',
  'GERMAN', 'GERMANY', 'FRENCH', 'FRANCE', 'SPANISH', 'SPAIN', 'GREEK', 'GREECE',
  'SWISS', 'SWITZERLAND', 'DUTCH', 'NETHERLANDS', 'BELGIAN', 'BELGIUM',
  'POLISH', 'POLAND', 'UKRAINIAN', 'UKRAINE', 'RUSSIAN', 'RUSSIA',
  'CHINESE', 'CHINA', 'IRANIAN', 'IRAN', 'PAKISTANI', 'PAKISTAN',
  'CYPRUS', 'MALTA', 'TUNISIAN', 'TUNISIA', 'MOROCCAN', 'MOROCCO',
  'ALGERIAN', 'ALGERIA', 'SAUDI', 'KSA', 'UAE', 'EMIRATI', 'JAPAN', 'KOREA',
  'CANADIAN', 'CANADA', 'SWEDISH', 'SWEDEN', 'DANISH', 'DENMARK', 'NORWAY',
  'AUSTRIAN', 'AUSTRIA', 'PORTUGAL', 'IRELAND', 'ROMANIA', 'BULGARIA', 'SERBIA',
  'CZECH', 'HUNGARY', 'MEXICO', 'BRAZIL', 'ARGENTINA', 'VIETNAM', 'THAILAND',
  'MALAYSIA', 'INDONESIA', 'PHILIPPINES', 'BANGLADESH', 'NEPAL', 'YEMEN',
  'OMAN', 'QATAR', 'BAHRAIN', 'KUWAIT', 'LIBYA', 'SUDAN', 'PALESTINE', 'TAIWAN',
  // أخطاء إملائية واردة فعلياً في ملفات العملاء
  'EYGPT',
  'UK', 'USA', 'AMERICAN',
].sort((a, b) => b.length - a.length);

/**
 * يستخرج اسم الشركة من «كود الايتم» في الملف.
 *   "ALBALSAMIRAQIN/A" → "ALBALSAM"
 *   "AL-HAYATIRAQIN/A" → "AL-HAYAT"
 *   "C TItalyN/A"      → "C T"
 *   "DevaTurkeyN/A"    → "Deva"
 *
 * ملاحظة: توجد extractCompanyFromCode في sales.service.js لكنها تُبقي الدولة
 * ملتصقة ("ALBALSAMIRAQIN") لأنها تخدم غرضاً آخر — لا تُستعمل هنا.
 */
export function extractCompanyFromCode(code) {
  let s = String(code ?? '').trim();
  if (!s) return '';

  // 1) لاحقة N/A بصيغها المختلفة
  s = s.replace(/\s*N\s*[^A-Za-z0-9]?\s*A\s*$/i, '').trim();

  // 2) لاحقة الدولة (مرة واحدة — أطول تطابق أولاً)
  const upper = s.toUpperCase();
  for (const c of COUNTRY_SUFFIXES) {
    if (upper.endsWith(c) && upper.length > c.length) {
      s = s.slice(0, s.length - c.length);
      break;
    }
  }

  // 3) فواصل زائدة على الطرفين
  return s.replace(/[-_\/\s]+$/, '').replace(/^[-_\/\s]+/, '').trim();
}

/**
 * مفتاح متجاهل للمسافات. أسماء الشركات تختلف بالتباعد كثيراً بين الملف
 * والنظام («C T» مقابل «CT»)، والأسماء القصيرة لا تلتقطها المطابقة الضبابية:
 * تشابه «c t» و«ct» يساوي 0.67 وهو دون عتبة 0.85، وقاعدة تداخل الكلمات
 * تتجاهل الرموز الأقصر من 3 أحرف. المطابقة هنا مساواة تامة لا تخمين.
 */
function compactKey(name) {
  return normalizeItemKey(name).replace(/[^a-z0-9؀-ۿ]+/gi, '');
}

/**
 * سياق المطابقة لمكتب واحد: شركاته + قرارات الربط المحفوظة.
 * يُحمَّل مرة واحدة لكل عملية استيراد ويُمرَّر لكل نداء.
 */
export async function loadCompanyMatchContext(officeId) {
  const [companies, aliases] = await Promise.all([
    prisma.scientificCompany.findMany({
      where:  officeId ? { officeId } : {},
      select: { id: true, name: true, officeId: true },
    }),
    officeId
      ? prisma.companyAlias.findMany({
          where:  { officeId },
          select: { fromKey: true, companyId: true },
        })
      : Promise.resolve([]),
  ]);

  const byId = new Map(companies.map(c => [c.id, c]));
  const aliasMap = new Map();
  for (const a of aliases) if (!aliasMap.has(a.fromKey)) aliasMap.set(a.fromKey, a.companyId);

  return { companies, byId, aliasMap };
}

/**
 * يطابق اسم شركة خام بشركة في السياق.
 *
 * @returns {{ company: {id,name}|null, confidence: 'alias'|'exact'|'high'|'medium'|'none', suggestions: Array<{id,name,sim}> }}
 */
export function resolveCompanyName(rawName, ctx = {}) {
  const { companies = [], byId = new Map(), aliasMap = new Map() } = ctx;
  const out = { company: null, confidence: 'none', suggestions: [] };

  const name = String(rawName ?? '').trim();
  if (!name) return out;
  const key = normalizeItemKey(name);
  if (!key) return out;

  // ① قرار محفوظ سابقاً — أعلى أولوية
  const aliasId = aliasMap.get(key);
  if (aliasId != null) {
    const hit = byId.get(aliasId);
    if (hit) return { company: { id: hit.id, name: hit.name }, confidence: 'alias', suggestions: [] };
    // الشركة حُذفت بعد حفظ القرار → تجاهل الـalias وتابع المطابقة العادية
  }

  // ② تطابق تام — يجب أن يسبق الضبابي: areSimilar تُرجع false عند التطابق
  //    التام (وظيفتها كشف المكررات لا تأكيد التطابق).
  const exact = companies.find(c => normalizeItemKey(c.name) === key);
  if (exact) return { company: { id: exact.id, name: exact.name }, confidence: 'exact', suggestions: [] };

  // ③ تطابق تام متجاهل للمسافات — «C T» = «CT». إن انطبق على أكثر من شركة
  //    فهما صفّان مكرران أصلاً، فنترك القرار للمدير بدل اختيار عشوائي.
  const ck = compactKey(name);
  if (ck) {
    const compactHits = companies.filter(c => compactKey(c.name) === ck);
    if (compactHits.length === 1) {
      return { company: { id: compactHits[0].id, name: compactHits[0].name }, confidence: 'exact', suggestions: [] };
    }
    if (compactHits.length > 1) {
      return {
        company: null, confidence: 'medium',
        suggestions: compactHits.map(c => ({ id: c.id, name: c.name, sim: 1 })),
      };
    }
  }

  // ④ ضبابي — نفس محرّك الايتمات (areSimilar للقرار، similarity للترتيب)
  const candidates = companies
    .filter(c => areSimilar(name, c.name))
    .map(c => ({ id: c.id, name: c.name, sim: similarity(key, normalizeItemKey(c.name)) }))
    .sort((a, b) => b.sim - a.sim);

  out.suggestions = candidates;
  if (candidates.length === 0)      out.confidence = 'none';
  else if (candidates.length === 1) { out.company = candidates[0]; out.confidence = 'high'; }
  else                              out.confidence = 'medium'; // يقرّرها المدير

  return out;
}
