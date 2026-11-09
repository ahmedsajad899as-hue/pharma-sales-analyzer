// ════════════════════════════════════════════════════════════════════════════
// aiModelSettings.js — أي نموذج Gemini لكل ميزة، يختاره الماستر أدمن من صفحة
// «استهلاك الذكاء» (جدول AiModelSetting). ثلاثة أوضاع:
//   strong — gemini-3.8-flash (الأدق، الأغلى)
//   lite   — gemini-3.5-flash-lite (~نصف السعر أو أقل)
//   auto   — lite أولاً، ثم strong إن فشل فحص الأرقام (الكمية × السعر = المجموع، ومجموع
//            الفاتورة المطبوع). للفواتير فقط — لا فحص حسابي في الطلبيات النصية.
//
// مقيس 2026-11-10 (13 فاتورة × 5، مسار البطاقة المضغوط): strong 62/65 بـ0.0024$ للقراءة،
// lite 63/65 بـ0.0012$ — لكن أحد خطأَي lite أرقام مقلوبة (كمية 6 بونص 20 بدل 20 و6)،
// وهو بالضبط ما يلتقطه فحص auto.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

export const AI_MODELS = { strong: 'gemini-3.8-flash', lite: 'gemini-3.5-flash-lite' };

// الميزات القابلة للضبط + افتراضها (= السلوك قبل اللوحة) + الأوضاع المسموحة.
export const AI_MODEL_FEATURES = {
  'invoice-read-card': { default: 'strong', modes: ['strong', 'lite', 'auto'] },
  'invoice-read':      { default: 'strong', modes: ['strong', 'lite', 'auto'] },
  'bot-order-text':    { default: 'lite',   modes: ['strong', 'lite'] },
};

const CACHE_MS = 60_000;
let cache = null; // { at, map }

async function loadMap() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.map;
  const map = {};
  try {
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
  if (!rows?.length) return 'no rows';
  if (!rows.some(r => String(r.pharmacy ?? '').trim())) return 'no pharmacy';
  const n = (v) => { const x = Number(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(x) ? x : 0; };
  let sum = 0;
  for (const r of rows) {
    const q = n(r.quantity), u = n(r.unitPrice), t = n(r.total);
    const free = r.priceShown === false || r.priceShown === 'false';
    if (free || !(t > 0)) continue;
    sum += t;
    if (q > 0 && u > 0 && Math.abs(q * u - t) > Math.max(1, t * 0.02)) return `row ${r.item}: ${q}×${u}≠${t}`;
  }
  const g = n(grandTotal);
  // «183,864» يُقرأ أحياناً 183.864 (فاصل الآلاف كفاصلة عشرية) — يُقبل ×1000 أيضاً.
  const near = (a, b) => Math.abs(a - b) <= Math.max(1, b * 0.01);
  if (g > 0 && sum > 0 && !near(sum, g) && !near(sum, g * 1000)) return `sum ${sum}≠${g}`;
  return null;
}
