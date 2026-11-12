// ════════════════════════════════════════════════════════════════════════════
// aiModelSettings.js — أي نموذج Gemini لكل ميزة، يختاره الماستر أدمن من صفحة
// «استهلاك الذكاء» (جدول AiModelSetting). ثلاثة أوضاع:
//   strong — gemini-3.8-flash (الأدق، الأغلى)
//   lite   — gemini-3.5-flash-lite (~نصف السعر أو أقل)
//   auto   — lite أولاً، ثم strong **للجزء المتعذّر فقط** (طلب صاحب المشروع 2026-11-13):
//            سطر لا تتّسق أرقامه (الكمية × السعر ≠ المجموع) ⇒ قصاصة أسطره وحدها بالأقوى؛
//            صيدلية فارغة ⇒ قصاصة كتلة الزبون وحدها؛ ولا يُعاد كل شيء بالأقوى إلا حين
//            يتعذّر تحديد الجزء (لا أصناف، أو مجموع الفاتورة لا يطابق بعد الإصلاح).
//            للفواتير فقط — لا فحص حسابي في الطلبيات النصية.
//
// مقيس 2026-11-10 (13 فاتورة × 5، مسار البطاقة المضغوط): strong 62/65 بـ0.0024$ للقراءة،
// lite 63/65 بـ0.0012$ — لكن أحد خطأَي lite أرقام مقلوبة (كمية 6 بونص 20 بدل 20 و6)،
// وهو بالضبط ما يلتقطه فحص auto.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

export const AI_MODELS = { strong: 'gemini-3.8-flash', lite: 'gemini-3.5-flash-lite' };

// الميزات القابلة للضبط + افتراضها (= السلوك قبل اللوحة) + الأوضاع المسموحة.
// invoice-read-card صار auto افتراضياً (2026-11-13، بند «هـ» من خطة تقليل الكلفة).
export const AI_MODEL_FEATURES = {
  'invoice-read-card': { default: 'auto',   modes: ['strong', 'lite', 'auto'] },
  'invoice-read':      { default: 'strong', modes: ['strong', 'lite', 'auto'] },
  'invoice-pdf':       { default: 'auto',   modes: ['strong', 'lite', 'auto'] }, // نصّ PDF — نداء نصّي بلا صورة
  'invoice-gate':      { default: 'lite',   modes: ['strong', 'lite'] },        // فحص كروب المذخر: اسم الزبون والأصناف فقط
  'bot-order-text':    { default: 'lite',   modes: ['strong', 'lite'] },
};

// ترحيل لمرة واحدة: إعداد «الأقوى» المحفوظ لبطاقات المذاخر قبل هذا التاريخ ← «تلقائي»
// (طلبه صاحب المشروع صراحةً). أي تغيير يُحفظ بعده من اللوحة يبقى كما هو.
const CARD_AUTO_SINCE = new Date('2026-11-13T12:00:00Z');
let migrated = false;
async function migrateOnce() {
  if (migrated) return;
  migrated = true;
  try {
    await prisma.aiModelSetting.updateMany({
      where: { feature: 'invoice-read-card', mode: 'strong', updatedAt: { lt: CARD_AUTO_SINCE } },
      data: { mode: 'auto' },
    });
  } catch (e) {
    console.error('[ai-models] ترحيل البطاقات إلى تلقائي:', String(e?.message || '').slice(0, 120));
  }
}

const CACHE_MS = 60_000;
let cache = null; // { at, map }

async function loadMap() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.map;
  const map = {};
  try {
    await migrateOnce();
    for (const r of await prisma.aiModelSetting.findMany()) map[r.feature] = r.mode;
  } catch (e) {
    console.error('[ai-models] تعذّر قراءة الإعدادات:', String(e?.message || '').slice(0, 120));
  }
  cache = { at: Date.now(), map };
  return map;
}

/** وضع الميزة: strong | lite | auto، أو null لميزة غير قابلة للضبط. */
export async function getAiMode(feature) {
  const def = AI_MODEL_FEATURES[feature];
  if (!def) return null;
  const m = (await loadMap())[feature];
  return def.modes.includes(m) ? m : def.default;
}

/** اسم النموذج لنداء واحد. auto يبدأ بالأرخص (المستدعي يتولّى الإعادة). null = اترك الافتراضي. */
export async function modelForMode(feature) {
  const mode = await getAiMode(feature);
  if (!mode) return null;
  return mode === 'strong' ? AI_MODELS.strong : AI_MODELS.lite;
}

export async function listAiModelSettings() {
  const map = await loadMap();
  return Object.entries(AI_MODEL_FEATURES).map(([feature, d]) => ({
    feature, modes: d.modes, default: d.default,
    mode: d.modes.includes(map[feature]) ? map[feature] : d.default,
  }));
}

export async function setAiModelSetting(feature, mode) {
  const def = AI_MODEL_FEATURES[feature];
  if (!def || !def.modes.includes(mode)) return false;
  await prisma.aiModelSetting.upsert({ where: { feature }, create: { feature, mode }, update: { mode } });
  cache = null;
  return true;
}

/**
 * فحص أرقام الفاتورة المقروءة (قبل طيّ البونص). يُعيد سبب الفشل نصاً، أو null إن سلمت:
 *  • لا صفوف، أو بلا صيدلية.
 *  • سطر مسعّر مجموعه ≠ الكمية × السعر (هامش 2%) — يلتقط الكمية/البونص المقلوبين.
 *  • مجموع الفاتورة المطبوع (إن قُرئ) ≠ مجموع الأسطر (هامش 1%).
 */
export function invoiceNumbersProblem(rows, { grandTotal = null } = {}) {
  return diagnoseInvoiceRows(rows, { grandTotal, needPharmacy: true }).problem;
}

const num = (v) => { const x = Number(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(x) ? x : 0; };

/**
 * تشخيص مفصّل لقراءة الأرخص — **أي جزء** تعذّر، كي يُعاد ذلك الجزء وحده بالأقوى:
 *  noRows      — لا أصناف إطلاقاً (يُعاد كل شيء).
 *  badRows     — مواضع الأسطر المسعّرة التي الكمية × السعر ≠ المجموع فيها (هامش 2%).
 *  noPharmacy  — الصيدلية فارغة (حين needPharmacy).
 *  sumMismatch — مجموع الأسطر ≠ مجموع الفاتورة المطبوع (هامش 1%، ويُقبل ×1000).
 * @returns {{ ok:boolean, noRows:boolean, badRows:number[], noPharmacy:boolean, sumMismatch:boolean, problem:string|null }}
 */
export function diagnoseInvoiceRows(rows, { grandTotal = null, needPharmacy = true } = {}) {
  const out = { ok: false, noRows: false, badRows: [], noPharmacy: false, sumMismatch: false, problem: null };
  if (!rows?.length) { out.noRows = true; out.problem = 'no rows'; return out; }
  out.noPharmacy = needPharmacy && !rows.some(r => String(r.pharmacy ?? '').trim());
  let sum = 0;
  rows.forEach((r, i) => {
    const q = num(r.quantity), u = num(r.unitPrice), t = num(r.total);
    const free = r.priceShown === false || r.priceShown === 'false';
    if (free || !(t > 0)) return;
    sum += t;
    if (q > 0 && u > 0 && Math.abs(q * u - t) > Math.max(1, t * 0.02)) out.badRows.push(i);
  });
  const g = num(grandTotal);
  // «183,864» يُقرأ أحياناً 183.864 (فاصل الآلاف كفاصلة عشرية) — يُقبل ×1000 أيضاً.
  const near = (a, b) => Math.abs(a - b) <= Math.max(1, b * 0.01);
  out.sumMismatch = g > 0 && sum > 0 && !near(sum, g) && !near(sum, g * 1000);
  const b = out.badRows[0];
  out.problem = out.noPharmacy ? 'no pharmacy'
    : b != null ? `row ${rows[b].item}: ${num(rows[b].quantity)}×${num(rows[b].unitPrice)}≠${num(rows[b].total)}`
    : out.sumMismatch ? `sum ${sum}≠${g}` : null;
  out.ok = !out.problem;
  return out;
}
