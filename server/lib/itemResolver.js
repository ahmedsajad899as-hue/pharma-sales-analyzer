/**
 * itemResolver — محرّك توحيد هوية الايتمات (مصدر الحقيقة الوحيد).
 *
 * كل مسارات التطبيق (رفع الملفات، التقارير، التجميع، طابور المراجعة) يجب أن تمرّ
 * عبر هذا المحرّك لتحويل أي اسم ايتم خام إلى "الايتم القانوني" في كتالوج الشركة.
 *
 * يعيد استخدام محرّك المطابقة الموجود بالكامل (server/lib/fuzzyMatch.js):
 *   - areSimilar  : قرار التشابه (مع حارس الجرعة hasDifferentCoreNumbers الذي يمنع دمج 100/500)
 *   - similarity  : ترتيب الاقتراحات
 * ولا يعيد كتابة أيٍّ منها.
 *
 * نطاق التوحيد = الشركة العلمية (ScientificCompany): قاعدة توحيد واحدة تفيد كل
 * مستخدمي الشركة (قرار المستخدم: "لكل شركة — مشترك").
 */

import prisma from './prisma.js';
import { similarity, normalizeStr, areSimilar } from './fuzzyMatch.js';

// ─── التطبيع القانوني (عربي + لاتيني) ───────────────────────────────────────────
/**
 * تطبيع النص العربي إلى صورة قانونية:
 * توحيد الألف، ة→ه، ى→ي، حذف التطويل والتشكيل، الفواصل→مسافة، حذف "ال" التعريف،
 * وطيّ المسافات. (نسخة موحّدة — كانت مكرّرة في sales.repository.js و server/index.js.)
 */
export function normalizeArabic(str) {
  return String(str)
    .trim()
    .replace(/[أإآٱ]/g, 'ا')  // أ إ آ ٱ → ا
    .replace(/ة/g, 'ه')                        // ة → ه
    .replace(/ى/g, 'ي')                        // ى → ي
    .replace(/ـ/g, '')                              // ـ التطويل
    .replace(/[ً-ٟ]/g, '')                    // التشكيل
    .replace(/[-–—,،/\\]+/g, ' ')                       // فواصل → مسافة
    .replace(/(^|\s)ال/g, '$1')               // حذف "ال" التعريف في بداية الكلمة
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * المفتاح القانوني لايتم — يُستخدم للمطابقة التامة وكمفتاح alias (fromKey).
 * تطبيع عربي ثم تطبيع لاتيني (lowercase/trim/collapse) — لأن أسماء الأدوية لاتينية غالباً.
 */
export function normalizeItemKey(name) {
  return normalizeStr(normalizeArabic(name));
}

// ─── تحميل سياق الشركة (كتالوج + aliases) دفعةً واحدة ────────────────────────────
/**
 * يحمّل كتالوج الشركة/الشركات وقواعد التوحيد مرة واحدة، لتفادي استعلامات متكرّرة
 * عند توحيد قائمة أسماء (وضع الدُّفعة). يُستحسن استدعاؤه مرة لكل طلب/رفع.
 *
 * @param {number[]} scientificCompanyIds
 * @returns {Promise<{ catalog: Array<{id:number,name:string}>, catalogById: Map<number,{id,name}>, aliasMap: Map<string,{toItemId:number|null,toName:string}> }>}
 */
export async function loadCompanyContext(scientificCompanyIds = []) {
  const ids = (scientificCompanyIds || []).filter(Boolean);
  if (ids.length === 0) {
    return { catalog: [], catalogById: new Map(), aliasMap: new Map() };
  }
  const [catalog, aliasRows] = await Promise.all([
    prisma.item.findMany({
      where: { scientificCompanyId: { in: ids }, isTemp: false },
      select: { id: true, name: true },
    }),
    prisma.itemMergeRule.findMany({
      where: { scientificCompanyId: { in: ids } },
      select: { fromKey: true, toItemId: true, toName: true },
    }),
  ]);

  const catalogById = new Map(catalog.map(c => [c.id, c]));
  const aliasMap = new Map();
  for (const a of aliasRows) {
    if (!aliasMap.has(a.fromKey)) aliasMap.set(a.fromKey, { toItemId: a.toItemId, toName: a.toName });
  }
  return { catalog, catalogById, aliasMap };
}

/**
 * توحيد قائمة أسماء حرة إلى الأسماء القانونية — للحقول التي تخزّن نصاً حراً
 * (البونص/الموزّع/التجاري/تحليل المبيعات). يُطبَّق **وقت العرض/التجميع فقط** ولا يمسّ التخزين.
 *
 * يُعيد Map<الاسم الأصلي → الاسم القانوني>. لا يُوحّد إلا التطابق عالي الثقة
 * (alias/exact/high)؛ الأسماء الملتبسة أو غير المعروفة تبقى كما هي (لا دمج خاطئ).
 * إن لم يكن للمستخدم كتالوج شركة → تُبقى كل الأسماء كما هي.
 *
 * @param {Iterable<string>} names
 * @param {{ scientificCompanyIds?: number[], ctx?: {catalog,catalogById,aliasMap} }} opts
 * @returns {Promise<Map<string,string>>}
 */
export async function canonicalizeNames(names, { scientificCompanyIds = [], ctx = null } = {}) {
  const uniqueNames = [...new Set([...(names || [])].filter(Boolean).map(String))];
  const map = new Map();
  if (uniqueNames.length === 0) return map;

  const context = ctx || await loadCompanyContext(scientificCompanyIds);
  if (!context.catalog || context.catalog.length === 0) {
    for (const n of uniqueNames) map.set(n, n);   // لا كتالوج → بلا توحيد
    return map;
  }
  for (const n of uniqueNames) {
    const r = await resolveItemName(n, context);
    const canonical = (r.canonicalItem && (r.confidence === 'alias' || r.confidence === 'exact' || r.confidence === 'high'))
      ? r.canonicalItem.name
      : n;
    map.set(n, canonical);
  }
  return map;
}

/**
 * دالة توحيد جاهزة لمستخدم: تشتق شركات المستخدم ثم تبني خريطة توحيد، وتُعيد
 * دالة (name)=>canonicalName. دفاعية: عند غياب شركة/كتالوج أو أي خطأ → دالة هوية.
 * مخصّصة للحقول الحرة (البونص/التجاري/الموزّع/تحليل المبيعات) وقت العرض.
 *
 * @param {number} userId
 * @param {Iterable<string>} names
 * @returns {Promise<(name:string)=>string>}
 */
export async function buildUserCanonMap(userId, names) {
  try {
    if (!userId) return (n) => n;
    const sciCompanyIds = (await prisma.userCompanyAssignment.findMany({
      where: { userId }, select: { companyId: true },
    })).map(c => c.companyId);
    if (sciCompanyIds.length === 0) return (n) => n;
    const map = await canonicalizeNames(names, { scientificCompanyIds: sciCompanyIds });
    return (n) => map.get(n) || n;
  } catch { return (n) => n; }
}

/**
 * سياق التوحيد الكامل لمسار الرفع: كتالوج الشركة + ايتمات المستخدم غير المؤقتة
 * (للتوافق مع السلوك القديم الذي كان يطابق ايتمات المستخدم أيضاً) + aliases الشركة.
 * الكتالوج المشترك له الأولوية؛ تُدمج ايتمات المستخدم غير المكرّرة بعده (حسب المفتاح القانوني).
 *
 * @param {{ scientificCompanyIds?: number[], userId?: number|null }} opts
 */
export async function loadResolutionContext({ scientificCompanyIds = [], userId = null } = {}) {
  const ids = (scientificCompanyIds || []).filter(Boolean);
  const [companyCatalog, userItems, aliasRows] = await Promise.all([
    ids.length > 0
      ? prisma.item.findMany({ where: { scientificCompanyId: { in: ids }, isTemp: false }, select: { id: true, name: true } })
      : Promise.resolve([]),
    userId
      ? prisma.item.findMany({ where: { userId, isTemp: false }, select: { id: true, name: true } })
      : Promise.resolve([]),
    ids.length > 0
      ? prisma.itemMergeRule.findMany({ where: { scientificCompanyId: { in: ids } }, select: { fromKey: true, toItemId: true, toName: true } })
      : Promise.resolve([]),
  ]);

  const seen = new Set();
  const catalog = [];
  for (const it of [...companyCatalog, ...userItems]) {
    const k = normalizeItemKey(it.name);
    if (seen.has(k)) continue;              // الكتالوج المشترك يسبق ايتمات المستخدم
    seen.add(k);
    catalog.push(it);
  }
  const catalogById = new Map(catalog.map(c => [c.id, c]));
  const aliasMap = new Map();
  for (const a of aliasRows) {
    if (!aliasMap.has(a.fromKey)) aliasMap.set(a.fromKey, { toItemId: a.toItemId, toName: a.toName });
  }
  return { catalog, catalogById, aliasMap };
}

// ─── مستويات الثقة ──────────────────────────────────────────────────────────────
// alias  : قاعدة توحيد محفوظة سابقاً (تُطبَّق دائماً)
// exact  : تطابق مفتاح قانوني تام مع الكتالوج
// high   : تطابق ضبابي وحيد لا لبس فيه (مرشّح واحد) → ربط تلقائي صامت
// medium : تطابق ضبابي متعدّد/ملتبس (مرشّحان فأكثر) → يُسأل المستخدم مرة واحدة
// none   : لا مطابقة → ايتم جديد (يدخل طابور مراجعة السوبر أدمن)

/**
 * يحلّل اسم ايتم خام إلى ايتم كتالوج قانوني ضمن شركة/شركات المستخدم.
 *
 * يمكن تمرير سياق مُحمّل مسبقاً (catalog/catalogById/aliasMap) لوضع الدُّفعة؛ وإلا
 * يُحمَّل من scientificCompanyIds تلقائياً.
 *
 * @param {string} name
 * @param {{ scientificCompanyIds?: number[], catalog?: any[], catalogById?: Map, aliasMap?: Map }} ctx
 * @returns {Promise<{ canonicalItem: {id:number,name:string}|null, confidence: 'alias'|'exact'|'high'|'medium'|'none', suggestions: Array<{id:number,name:string,sim:number}> }>}
 */
export async function resolveItemName(name, ctx = {}) {
  let { catalog, catalogById, aliasMap } = ctx;
  if (!catalog || !aliasMap) {
    const loaded = await loadCompanyContext(ctx.scientificCompanyIds || []);
    catalog = loaded.catalog;
    catalogById = loaded.catalogById;
    aliasMap = loaded.aliasMap;
  }

  const result = { canonicalItem: null, confidence: 'none', suggestions: [] };
  if (!name || !String(name).trim()) return result;

  const key = normalizeItemKey(name);

  // 1) alias محفوظ (نطاق الشركة) → أعلى أولوية
  const alias = aliasMap.get(key);
  if (alias) {
    let target = alias.toItemId ? catalogById.get(alias.toItemId) : null;
    if (!target && alias.toName) {
      const toKey = normalizeItemKey(alias.toName);
      target = catalog.find(c => normalizeItemKey(c.name) === toKey) || null;
    }
    if (target) {
      result.canonicalItem = target;
      result.confidence = 'alias';
      return result;
    }
    // القاعدة موجودة لكن الهدف حُذف من الكتالوج → نتجاهلها ونكمل للمطابقة العادية
  }

  // 2) تطابق تام (مفتاح قانوني)
  const exact = catalog.find(c => normalizeItemKey(c.name) === key);
  if (exact) {
    result.canonicalItem = exact;
    result.confidence = 'exact';
    return result;
  }

  // 3) مطابقة ضبابية — نعيد استخدام areSimilar (بحارس الجرعة) + similarity للترتيب
  const candidates = catalog
    .filter(c => areSimilar(name, c.name))
    .map(c => ({ id: c.id, name: c.name, sim: similarity(key, normalizeItemKey(c.name)) }))
    .sort((a, b) => b.sim - a.sim);

  result.suggestions = candidates;

  if (candidates.length === 0) {
    result.confidence = 'none';
  } else if (candidates.length === 1) {
    // مرشّح وحيد لا لبس فيه → ثقة عالية → ربط تلقائي
    result.canonicalItem = candidates[0];
    result.confidence = 'high';
  } else {
    // مرشّحات متعدّدة → ملتبس → يُسأل المستخدم مرة واحدة
    result.confidence = 'medium';
  }

  return result;
}
