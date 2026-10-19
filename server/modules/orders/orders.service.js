// ════════════════════════════════════════════════════════════════════════════
// orders.service.js — طابور الطلبيات الواردة من البوتات (PendingBotOrder).
//
// الطلبية تُستخرَج بالذكاء ثم **تنتظر** هنا. لا شيء يصل جدول Sale إلا بعد أن يفتح
// المستخدم شبكة المراجعة في التطبيق ويؤكّد — فالحفظ النهائي يمرّ حصراً بمسار
// insertManualSales القائم (POST /api/sales/manual) ومن هناك يُحذَف الصف المعلَّق.
// نفس عقد PendingVisitsImport، إلا في شيء واحد: هنا عدة صفوف لكل مستخدم مسموحة.
// ════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { buildRepIndex, matchRepName, repCoreName, repCoreKey } from '../../lib/repNameMatch.js';
import { getAssignedItemsCatalog } from '../../lib/itemScope.js';
import { loadResolutionContext, loadCompanyContext, resolveItemName, resolveItemNameSync, normalizeAreaName, normalizeItemKey, normalizeArabic } from '../../lib/itemResolver.js';
import { cleanPharmacyName } from '../../lib/surveyPharmacies.js';
import { matchInvoiceCustomers } from '../../lib/invoiceCustomerMatch.js';
import { similarity } from '../../lib/fuzzyMatch.js';
import { applyTextParse, TEXT_PARSE_VERSION } from './order-extract.js';
import { loadItemOwnerManagers } from '../../lib/itemOwnerManager.js';

const __dirname3 = path.dirname(fileURLToPath(import.meta.url));

// صور الطلبيات. **ليس** داخل server/uploads: ذاك المجلد يُخدَم ساكناً من
// server/index.js فوق بوابة JWT، فأي ملف فيه مقروء للعالم بمعرفة اسمه. هذا المجلد
// (جذر المشروع/uploads) خاص — نفس مكان ملفات الإكسل المحفوظة — ويُقرأ حصراً عبر
// نقطة مصادَقة تفحص ملكية الصف أولاً. وهو أيضاً خارج أرشيف النشر (deploy.ps1
// يحزم server/ وprisma/ فقط) فلا تُنشَر صور التطوير للإنتاج.
const BOT_ORDER_IMAGES_DIR = path.join(__dirname3, '..', '..', '..', 'uploads', 'bot-orders');

/** حدّ الطلبيات المعلَّقة لكل مستخدم — حارس تكلفة وقاعدة بيانات، لا قيد منطقي. */
export const MAX_PENDING_ORDERS_PER_USER = 30;

/** تُقلَّم الصفوف الأقدم من هذا تلقائياً عند أول قراءة للقائمة. */
const PRUNE_AFTER_DAYS = 30;

const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * بصمة الطلبية — الحارس الفعلي ضد التكرار، مستقلّ عن حارس update_id في تلكرام
 * (لا يصمد أمام الألبومات) وعن message_token في فايبر (ليس عدّاداً تصاعدياً).
 * النص يُطبَّع بإسقاط المسافات وحالة الأحرف فإعادة لصق نفس الطلبية تُكتشف.
 */
export function orderSourceHash({ userId, text, mediaKeys = [] }) {
  const normText = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const keys = [...mediaKeys].map(String).sort().join(',');
  return crypto.createHash('sha256').update(`${userId}|${normText}|${keys}`).digest('hex');
}

// ─── مطابقة الايتمات وتعبئة الشركة والسعر ───────────────────────────────────

/**
 * نطاق مطابقة الايتمات: الايتمات المعيَّنة للمستخدم إن وُجدت (وهي ما يعنيه
 * المستخدم بـ«ايتمات المندوب»)، وإلا كتالوج شركاته العلمية — نفس اصطلاح
 * checkManualNames وresolveEffectiveItemIds: تعيين فارغ لا يعني صفر ايتمات.
 */
async function buildItemContext(userId) {
  if (!userId) return null;
  const assigned = await getAssignedItemsCatalog(userId);
  if (assigned && assigned.length > 0) {
    return {
      catalog: assigned,
      catalogById: new Map(assigned.map(c => [c.id, c])),
      aliasMap: new Map(),
      scope: 'assigned',
    };
  }
  const ua = await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
  const ids = ua.map(c => c.companyId).filter(Boolean);
  const ctx = await loadResolutionContext({ scientificCompanyIds: ids, userId });
  return { ...ctx, scope: ids.length > 0 ? 'catalog' : 'user-items' };
}

// ─── بديل «العلامة + الجرعة المختصرة» ────────────────────────────────────────
// أرقام الجرعة في اسم صنف. فاصل الآلاف («50.000IU»، «50,000»، «50'000») يُدمج **قبل**
// normalizeItemKey (التطبيع يحوّل «,» مسافة فتصير رقمين). الرقم الأول غير صفري شرطٌ
// كي تبقى «0.125mg» عشرية. أعداد العبوة («8CAP»، «1AMP»، «15ML»، «30TAB») ليست جرعة.
const PACK_RE = /\b\d+\s*(?:x\s*\d+\s*)?(?:tabs?|tablets?|caps?|capsules?|amps?|ampoules?|vials?|sachets?|pcs?|strips?|ml|kapsul|film)\b/gi;
function doseNumbers(s) {
  const joined = String(s ?? '').replace(/\b([1-9]\d{0,2})[.,'](\d{3})(?!\d)/g, '$1$2');
  return (normalizeItemKey(joined).replace(PACK_RE, ' ').match(/\d+/g) || []).map(Number);
}
const brandWord = (s) => (normalizeItemKey(s).match(/[a-z؀-ۿ]{3,}/) || [])[0] || '';

// كلمات شكل صيدلاني مترادفة: «قطرة/drops» في الطلبية = «DAMLA/ORAL» في الكتالوج.
const FORM_SYNONYMS = [
  ['drop', 'drops', 'damla', 'oral', 'قطره', 'قطرة', 'نقط'],
  ['amp', 'ampoule', 'inj', 'injection', 'امبول', 'ابره', 'إبرة'],
  ['cap', 'caps', 'capsule', 'kapsul', 'كبسول'],
  ['tab', 'tabs', 'tablet', 'حب', 'حبوب'],
  ['sus', 'susp', 'suspension', 'syr', 'syrup', 'شراب', 'معلق'],
  ['gel', 'jel', 'جل'],
  ['cream', 'crem', 'كريم'],
  ['supp', 'suppository', 'تحاميل', 'تحميله'],
];
const formOf = (s) => {
  const words = normalizeItemKey(s).split(/[^a-z؀-ۿ]+/);
  return FORM_SYNONYMS.findIndex(g => words.some(w => g.includes(w)));
};

/**
 * بديل حين لم يُطابَق الاسم بأي شكل (2026-10-19). المندوبون:
 *  • يختصرون الجرعة بالآلاف: «Devit 50» = «DEVIT 3 50.000IU»، و5 = 5000، و300 = 300.000.
 *  • يخطئون إملائياً قليلاً في العلامة: «Divit»، «Devet».
 * حارس الجرعة في areSimilar يرى 50 ≠ 50000 فلا يقترح شيئاً. هنا نحصر الكتالوج في
 * **عائلة العلامة** (أول كلمة متطابقة أو قريبة إملائياً)، ونُسقط الأرقام المشتركة بين
 * كل أفراد العائلة («3» في «DEVIT 3» جزء من الاسم لا جرعة)، ثم نربط **فقط** إن
 * انفرد صنف واحد بجرعة = الرقم المكتوب أو ألف ضعفه (أو بشكل صيدلاني إن لم تُكتب جرعة).
 * أكثر من صنف = اقتراحات بلا ربط — إسناد مبيع لجرعة خاطئة أسوأ من خانة فارغة.
 * نقي — exported للاختبار.
 */
export function brandDoseFallback(name, catalog) {
  const brand = brandWord(name);
  if (brand.length < 4 || !Array.isArray(catalog)) return null;
  const family = catalog.filter(c => {
    const b = brandWord(c.name);
    return b === brand || (b.length >= 4 && similarity(b, brand) >= 0.75);
  });
  if (!family.length) return null;
  const suggestions = family.map(c => ({ id: c.id, name: c.name, sim: 0.5 }));

  // رقم يحمله **كل** أفراد العائلة جزءٌ من اسم العلامة («DEVIT 3»، «DEVIT-3») — لا جرعة.
  const famNums = family.map(c => new Set(doseNumbers(c.name)));
  const shared = family.length > 1
    ? new Set([...famNums[0]].filter(n => famNums.every(s => s.has(n))))
    : new Set();
  const dosesOf = (s) => doseNumbers(s).filter(n => !shared.has(n));

  const q = dosesOf(name)[0];
  let hits;
  hits = q != null ? family.filter(c => dosesOf(c.name).some(n => n === q || n === q * 1000)) : family;
  // الشكل الصيدلاني («Azitro sus» ← «AZITRO Susp 200mg/5ml» لا «Azitro 500mg Tab»)
  // يحسم ما بقي ملتبساً بعد الجرعة.
  const f = formOf(name);
  if (hits.length > 1 && f >= 0) hits = hits.filter(c => formOf(c.name) === f);
  if (hits.length === 1) return { canonicalItem: hits[0], confidence: 'high', suggestions, via: 'brand-dose' };
  return { canonicalItem: null, confidence: 'medium', suggestions };
}

/**
 * يطابق اسم كل صنف بكتالوج المستخدم، ويملأ الشركة وسعر الوحدة من بطاقة الايتم.
 *
 * يُطبَّق على **الصفوف غير المحفوظة** قبل دخولها الطابور، فكل ما يكتبه هنا يبقى
 * قابلاً لتعديل المراجِع في الشبكة — لا حفظ ولا إنشاء ايتم جديد في أي حال.
 *
 * الربط التلقائي يقتصر على ثقة alias/exact/high (نفس سلّم itemResolver): المتشابه
 * الملتبس (medium) يُترك كما كُتب وتُرفَق مرشّحاته في `_itemMatch` ليسأل عنه مسار
 * check-names عند الحفظ — لا نحسم اللبس صامتين فنُسند مبيعات لايتم خاطئ.
 *
 * السعر: «سعر المذخر» (Item.warehousePrice) أولاً ثم «سعر المكتب» (Item.price)
 * بديلاً. ولا يُكتب فوق سعر ذكره المرسِل في نصّ الطلبية.
 */
export async function enrichRowsFromCatalog(rows, userId, { linkOnly = false } = {}) {
  if (!Array.isArray(rows) || rows.length === 0 || !userId) return rows;

  let ctx = null;
  try {
    ctx = await buildItemContext(userId);
  } catch (e) {
    console.error('[orders] تعذّر تحميل كتالوج الايتمات:', e?.message);
    return rows; // المطابقة تحسين لا شرط — فشلها لا يُسقط الطلبية
  }
  if (!ctx || !ctx.catalog?.length) return rows;

  const names = [...new Set(rows.map(r => String(r.item ?? '').trim()).filter(Boolean))];
  const resolved = new Map();
  for (const name of names) {
    try {
      let r = await resolveItemName(name, ctx);
      // لا مطابقة → البديل كاملاً (حتى اقتراحاته). لبس (medium) → البديل يُقبل فقط إن حسم.
      if (r.confidence === 'none') r = brandDoseFallback(name, ctx.catalog) || r;
      else if (r.confidence === 'medium') {
        const fb = brandDoseFallback(name, ctx.catalog);
        if (fb?.confidence === 'high') r = fb;
      }
      resolved.set(name, r);
    } catch { /* يبقى كما كُتب */ }
  }

  const ids = [...new Set([...resolved.values()].map(r => r?.canonicalItem?.id).filter(Boolean))];
  const details = ids.length
    ? await prisma.item.findMany({
        where:  { id: { in: ids } },
        select: {
          id: true, name: true, price: true, warehousePrice: true,
          scientificCompanyId: true,
          company:           { select: { name: true } },
          scientificCompany: { select: { name: true } },
        },
      })
    : [];
  const byId = new Map(details.map(d => [d.id, d]));

  for (const row of rows) {
    const key = String(row.item ?? '').trim();
    const r = resolved.get(key);
    if (!r) continue;

    row._itemMatch = { confidence: r.confidence, suggestions: (r.suggestions || []).slice(0, 5) };
    const autoLink = r.confidence === 'alias' || r.confidence === 'exact' || r.confidence === 'high';
    if (!autoLink || !r.canonicalItem) continue;

    row._itemId = r.canonicalItem.id;
    const d = byId.get(r.canonicalItem.id);
    // linkOnly (رفع صورة يدوياً): نربط المعرّف والشركة العلمية فقط لتخمين المندوب
    // ولا نمسّ ما قُرئ من الفاتورة — توحيد الاسم يتمّ بفحص الأسماء عند الحفظ،
    // وسعر الكتالوج قد يملأ سطراً بلا سعر في الفاتورة (سطر بونص) خطأً.
    if (linkOnly) {
      if (d) {
        row._scientificCompanyId = d.scientificCompanyId ?? null;
        if (!String(row.company ?? '').trim()) row.company = d.scientificCompany?.name || d.company?.name || null;
      }
      continue;
    }

    row.item    = r.canonicalItem.name; // توحيد الاسم مع الكتالوج
    if (!d) continue;
    // **الشركة العلمية أولاً** — وهي ما تعرضه صفحة «الايتمات» بالماستر أدمن
    // (تُجمَّع الايتمات تحت ScientificCompany)، وهي أيضاً ما تشير إليه
    // UserCompanyAssignment.companyId. حقل Company منفصل وقد يختلف للايتم نفسه
    // («Moreserc 16 mg»: Company = HEJHEZ بينما ScientificCompany = HELPA) —
    // فتفضيله كان يعرض اسماً لا يراه المستخدم في أي مكان آخر بالتطبيق.
    row.company = d.scientificCompany?.name || d.company?.name || row.company || null;
    row._scientificCompanyId = d.scientificCompanyId ?? null;

    // سعر المذخر أولاً (طلب صريح من صاحب المشروع) ثم سعر المكتب بديلاً — ملء
    // الخانة بسعر المكتب أفضل من تركها فارغة، وسعر المذخر مملوء في ايتم واحد
    // فقط من 153 حتى الآن. المراجِع يصحّح أي سعر قبل الحفظ على أي حال.
    const catalogPrice = d.warehousePrice ?? d.price ?? null;
    if (row.unitPrice == null && catalogPrice != null) row.unitPrice = catalogPrice;
    if (row.total == null && row.quantity != null && row.unitPrice != null) {
      row.total = Number(row.quantity) * Number(row.unitPrice);
    }
  }
  return rows;
}

// ─── تخمين المندوب العلمي صاحب الطلبية ──────────────────────────────────────

/** العلامة التجارية للصنف = أول كلمة حرفية من مفتاحه («amoklavin bid 1000mg» ← «amoklavin»). */
function itemBrand(itemKey) {
  const m = String(itemKey || '').match(/[a-z؀-ۿ]{4,}/);
  return m ? m[0] : '';
}

/** «حسين قحطان» ≡ «حسين قحطان العبيدي» — أسماء ميركاتو أطول أحياناً من أسماء الحسابات. */
function sameRepKey(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');
}

/**
 * يخمّن المندوب العلمي الذي تخصّه الطلبية من ثلاثة أدلة متقاطعة:
 * الشركة العلمية للصنف + منطقة الصيدلية + تعيين الصنف نفسه للمندوب.
 *
 * التخمين **لا يُحسم إلا حين يبقى مرشّح واحد**؛ وجود أكثر من مرشّح يترك الحقل
 * فارغاً مع قائمة المرشّحين في `_repCandidates` ليختار المراجِع — إسناد طلبية
 * لمندوب خاطئ أسوأ من خانة فارغة، وهو خطأ لا يظهر إلا بعد شهور في التقارير.
 *
 * النطاق: مندوبو **نفس المكتب العلمي** للحساب المربوط بالكروب فقط.
 */
export async function attachScientificRepGuess(rows, actingUser) {
  if (!Array.isArray(rows) || rows.length === 0 || !actingUser) return rows;

  const areaNames = [...new Set(rows.map(r => r.area).filter(Boolean).map(normalizeAreaName).filter(Boolean))];
  const hasItemEvidence = rows.some(r => r._itemId || String(r.company ?? '').trim());
  if (!hasItemEvidence && areaNames.length === 0) return rows;

  try {
    const officeWhere = actingUser.officeId ? { officeId: actingUser.officeId } : { id: actingUser.id };
    const [reps, areas, aliases, repRecords, provinceAssignments, sciCompanies] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'scientific_rep', isActive: true, ...officeWhere },
        select: {
          id: true, username: true, displayName: true, linkedRepId: true,
          areaAssignments:    { select: { areaId: true } },
          companyAssignments: { select: { companyId: true } },
          itemAssignments:    { select: { itemId: true } },
        },
      }),
      areaNames.length ? prisma.area.findMany({ select: { id: true, name: true } }) : Promise.resolve([]),
      // ذاكرة الدمج («دورة جمعه» ← «الدورة») — القراءة من الصورة كثيراً ما تكون
      // الاسم القديم أو المركَّب لا القانوني.
      areaNames.length ? prisma.areaAlias.findMany({ select: { fromKey: true, areaId: true } }) : Promise.resolve([]),
      // سجلّ المندوب العلمي الذي يملكه المدير يحمل التعيين الفعلي غالباً
      // (المناطق + الايتمات + الشركات) لا حساب المندوب نفسه. كان يُقرأ منه
      // المناطق فقط، فمندوبان يغطّيان «البياع» بشركتين مختلفتين يبقيان مرشّحَين
      // معاً وتبقى الخانة فارغة.
      prisma.scientificRepresentative.findMany({
        where: { isActive: true, user: officeWhere },
        select: {
          id: true, name: true,
          areas:       { select: { areaId: true } },
          items:       { select: { itemId: true } },
          companies:   { select: { company: { select: { name: true } } } },
          linkedUsers: { select: { id: true } },
        },
      }),
      // فرق المحافظات: مندوب × شركة × ايتمات بلا تقاطع داخل الفريق — أقوى دليل
      // على صاحب الصنف.
      actingUser.officeId
        ? prisma.provinceRepAssignment.findMany({
            where: { isActive: true, team: { officeId: actingUser.officeId, isActive: true } },
            select: { repUserId: true, companyId: true, allItems: true, items: { select: { itemId: true } } },
          })
        : Promise.resolve([]),
      actingUser.officeId
        ? prisma.scientificCompany.findMany({ where: { officeId: actingUser.officeId }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    if (!reps.length && !repRecords.length) return rows;

    // اسم المنطقة قد يتكرّر كصفوف Area متعدّدة (المنطقة لكل حساب لا عالمية —
    // راجع ذاكرة project_pharma_area_account_scoping)، فنجمع كل المعرّفات.
    const areaIdsByName = new Map();
    const addAreaKey = (k, id) => {
      if (!k) return;
      if (!areaIdsByName.has(k)) areaIdsByName.set(k, new Set());
      areaIdsByName.get(k).add(id);
    };
    const areaNameById = new Map(areas.map(a => [a.id, a.name]));
    for (const a of areas) addAreaKey(normalizeAreaName(a.name), a.id);
    // الـalias يشير لصفّ واحد؛ نضمّ معه كل صفوف نفس الاسم القانوني.
    for (const al of aliases) {
      const canon = areaNameById.get(al.areaId);
      const ids = (canon && areaIdsByName.get(normalizeAreaName(canon))) || new Set([al.areaId]);
      for (const id of ids) addAreaKey(al.fromKey, id);
    }

    // الشركة العلمية بالاسم — للصفوف التي لم يُربط صنفها بالكتالوج (فلا
    // _scientificCompanyId) لكن الشركة مقروءة («DEVA»)، ولتحويل شركات سجلّ
    // المندوب (نموذج Company) إلى ScientificCompany.
    const sciCompanyByKey = new Map(sciCompanies.map(c => [normalizeItemKey(c.name), c.id]));
    const sciCompanyIdOf = (name) => {
      const k = normalizeItemKey(name ?? '');
      return k ? (sciCompanyByKey.get(k) ?? null) : null;
    };

    const newCandidate = (id, name) => ({
      id, name,
      areas: new Set(), companies: new Set(), items: new Set(),
      // ايتمات/شركات «مُسنَدة صراحةً» (فريق محافظة / سجلّ المندوب) — تختلف عن
      // UserItemAssignment العامة التي قد تكون فارغة بمعنى «الكل».
      ownedItems: new Set(), ownedCompanies: new Set(),
    });
    const index = reps.map(r => {
      const c = newCandidate(r.id, r.displayName?.trim() || r.username);
      r.areaAssignments.forEach(a => c.areas.add(a.areaId));
      r.companyAssignments.forEach(x => c.companies.add(x.companyId));
      r.itemAssignments.forEach(i => c.items.add(i.itemId));
      return c;
    });

    // دمج سجلّات المندوبين: المرتبط بحساب يُضاف لذلك الحساب، وغير المرتبط يصير
    // مرشّحاً باسمه (الخانة نصّ حرّ تُطابَق بالاسم عند الحفظ). نفس الاسم عند أكثر
    // من مدير = مندوب واحد، فيُجمَع بالاسم الجوهري.
    const byUserId = new Map(index.map(c => [c.id, c]));
    const byLinkedRep = new Map(reps.filter(r => r.linkedRepId).map(r => [r.linkedRepId, byUserId.get(r.id)]));
    const byName = new Map(index.map(c => [repCoreKey(c.name), c]));
    for (const rec of repRecords) {
      let target = byLinkedRep.get(rec.id)
        ?? rec.linkedUsers.map(u => byUserId.get(u.id)).find(Boolean)
        ?? byName.get(repCoreKey(rec.name));
      if (!target) {
        if (!rec.areas.length || !repCoreKey(rec.name)) continue;
        target = newCandidate(-rec.id, rec.name.trim());
        index.push(target);
        byName.set(repCoreKey(rec.name), target);
      }
      for (const a of rec.areas) target.areas.add(a.areaId);
      for (const i of rec.items) target.ownedItems.add(i.itemId);
      for (const c of rec.companies) {
        const sid = sciCompanyIdOf(c.company?.name);
        if (sid != null) target.ownedCompanies.add(sid);
      }
    }
    for (const pa of provinceAssignments) {
      const target = byUserId.get(pa.repUserId);
      if (!target) continue;
      target.ownedCompanies.add(pa.companyId);
      for (const i of pa.items) target.ownedItems.add(i.itemId);
    }

    // ── أسماء ايتمات المندوبين: مطابقة بالاسم والعلامة التجارية ──
    // الصنف كثيراً ما لا يُربط بمعرّف كتالوج (كتالوج المستخدم الرافع ضيّق، أو
    // الشكل الصيدلاني غير مسجّل: «AMOKLAVIN -BID 457MG SYRUP» والمسجّل أقراص)،
    // فيسقط دليل الصنف كلياً ويبقى مرشّحان يغطّيان المنطقة. اسم الصنف وعلامته
    // التجارية («amoklavin») يكفيان لمعرفة من يحمل هذا الدواء.
    const allItemIds = new Set();
    for (const c of index) { c.items.forEach(i => allItemIds.add(i)); c.ownedItems.forEach(i => allItemIds.add(i)); }
    const itemNames = allItemIds.size
      ? await prisma.item.findMany({ where: { id: { in: [...allItemIds] } }, select: { id: true, name: true } })
      : [];
    const itemKeyById = new Map(itemNames.map(i => [i.id, normalizeItemKey(i.name)]));
    for (const c of index) {
      c.explicitItems = c.ownedItems.size > 0 ? c.ownedItems : c.items;
      c.itemKeys = new Set(); c.brands = new Set();
      for (const id of c.explicitItems) {
        const k = itemKeyById.get(id);
        if (!k) continue;
        c.itemKeys.add(k);
        const b = itemBrand(k);
        if (b) c.brands.add(b);
      }
    }

    // ربط الصنف بكتالوج **المكتب كله** حين لم يُربط بكتالوج المستخدم الرافع.
    const officeItemIdByName = new Map();
    const unlinked = [...new Set(rows.filter(r => !r._itemId && String(r.item ?? '').trim()).map(r => String(r.item).trim()))];
    if (unlinked.length && sciCompanies.length) {
      try {
        const officeCtx = await loadCompanyContext(sciCompanies.map(c => c.id));
        if (officeCtx.catalog.length) {
          for (const name of unlinked) {
            const r = resolveItemNameSync(name, officeCtx);
            if (r?.canonicalItem && (r.confidence === 'alias' || r.confidence === 'exact' || r.confidence === 'high')) {
              officeItemIdByName.set(name, r.canonicalItem.id);
              if (!itemKeyById.has(r.canonicalItem.id)) itemKeyById.set(r.canonicalItem.id, normalizeItemKey(r.canonicalItem.name));
            }
          }
        }
      } catch (e) { console.error('[orders] office item link failed:', e?.message); }
    }

    // تضييق متتالٍ: كل دليل يُطبَّق فقط إن أبقى مرشّحاً واحداً على الأقل — دليل
    // غائب أو ناقص لا يُفرغ القائمة.
    const narrow = (list, pred) => { const out = list.filter(pred); return out.length ? out : list; };

    const ctxByRow = new Map();
    for (const row of rows) {
      const itemId = row._itemId ?? officeItemIdByName.get(String(row.item ?? '').trim()) ?? null;
      const sciId = row._scientificCompanyId ?? sciCompanyIdOf(row.company);
      const areaKey = row.area ? normalizeAreaName(row.area) : '';
      const areaIds = areaKey ? (areaIdsByName.get(areaKey) ?? new Set()) : new Set();
      const itemKey = normalizeItemKey(row.item ?? '');
      const brand = itemBrand(itemKey);

      let candidates = index;
      // المنطقة أقوى دليل — تُطبَّق أولاً حين نعرفها فعلاً، وبصرامة: مندوب لا
      // يغطّي المنطقة لا يُقترح لها ولو طابقت شركته.
      if (areaIds.size > 0) {
        candidates = candidates.filter(c => [...areaIds].some(id => c.areas.has(id)));
      }
      // الصنف مُسنَد صراحةً لمندوب — يحسم وحده غالباً.
      if (itemId) candidates = narrow(candidates, c => c.ownedItems.has(itemId) || c.items.has(itemId));
      else if (itemKey) candidates = narrow(candidates, c => c.itemKeys.has(itemKey));
      if (sciId != null) candidates = narrow(candidates, c => c.companies.has(sciId) || c.ownedCompanies.has(sciId));
      // من له قائمة ايتمات صريحة لا تضمّ هذا الصنف ليس صاحبه.
      if (itemId) {
        candidates = narrow(candidates, c => c.explicitItems.size === 0 || c.explicitItems.has(itemId));
      }
      // العلامة التجارية: من قائمته الصريحة لا تحمل «amoklavin» بأي شكل ليس صاحبه.
      if (brand) {
        candidates = narrow(candidates, c => c.explicitItems.size === 0 || c.brands.has(brand));
        candidates = narrow(candidates, c => c.brands.has(brand));
      }

      ctxByRow.set(row, { candidates, areaIds, itemKey, brand, sciId });
    }

    // ── سجلّ ميركاتو: من باع هذا الصنف في هذه المنطقة فعلاً ──
    // في ملفات ميركاتو «اسم المندوب» هو المندوب العلمي نفسه، فهي سجلّ حيّ لمن
    // يملك (منطقة × صنف) — ويتغذّى أيضاً من كل فاتورة تُحفَظ بمندوب مختار.
    const ambiguousAreaIds = new Set();
    for (const { candidates, areaIds } of ctxByRow.values()) {
      if (candidates.length > 1) areaIds.forEach(id => ambiguousAreaIds.add(id));
    }
    let history = [];
    if (ambiguousAreaIds.size) {
      try {
        const since = new Date(Date.now() - 365 * 86_400_000);
        const groups = await prisma.sale.groupBy({
          by: ['representativeId', 'itemId', 'areaId'],
          where: {
            isHidden: false, recordType: 'sale', areaId: { in: [...ambiguousAreaIds] }, saleDate: { gte: since },
            uploadedFile: { sourceSystem: 'mercato', user: officeWhere },
          },
          _count: { _all: true },
        });
        if (groups.length) {
          const [hReps, hItems] = await Promise.all([
            prisma.medicalRepresentative.findMany({ where: { id: { in: [...new Set(groups.map(g => g.representativeId))] } }, select: { id: true, name: true } }),
            prisma.item.findMany({ where: { id: { in: [...new Set(groups.map(g => g.itemId))] } }, select: { id: true, name: true } }),
          ]);
          const repNameById = new Map(hReps.map(r => [r.id, r.name]));
          const hItemKey = new Map(hItems.map(i => [i.id, normalizeItemKey(i.name)]));
          history = groups.map(g => {
            const k = hItemKey.get(g.itemId) || '';
            return { areaId: g.areaId, repKey: repCoreKey(repNameById.get(g.representativeId) || ''), itemKey: k, brand: itemBrand(k), n: g._count._all };
          }).filter(h => h.repKey);
        }
      } catch (e) { console.error('[orders] mercato history lookup failed:', e?.message); }
    }

    // ── سجلّ الصيدلية نفسها: من يخدم هذه الصيدلية فعلاً ──
    // مندوبان يتقاسمان منطقة («البياع» معيَّنة لحسين قحطان وعبداللة عمر بنفس الايتمات
    // والشركات — مقيس 2026-10-16) يتقاسمان صيدلياتها لا ايتماتها، فلا يحسم بينهما
    // إلا من باع لهذه الصيدلية من قبل.
    const pharmKey = (p) => normalizeArabic(cleanPharmacyName(p || '')).toLowerCase();
    const pharmHistory = new Map(); // pharmKey → [{ areaId, repKey, n }]
    const ambiguousPharms = [...new Set([...ctxByRow].filter(([, c]) => c.candidates.length > 1)
      .map(([r]) => cleanPharmacyName(r.pharmacy || '').trim()).filter(p => p.length >= 3))];
    if (ambiguousPharms.length) {
      try {
        const variants = new Set();
        for (const p of ambiguousPharms) { variants.add(p); variants.add(p.replace(/ة/g, 'ه')); variants.add(p.replace(/ه(\s|$)/g, 'ة$1')); }
        const customers = await prisma.customer.findMany({
          where: { OR: [...variants].map(v => ({ name: { contains: v } })) },
          select: { id: true, name: true }, take: 500,
        });
        const wanted = new Set(ambiguousPharms.map(pharmKey));
        const custKey = new Map(customers.map(c => [c.id, pharmKey(c.name)]).filter(([, k]) => wanted.has(k)));
        if (custKey.size) {
          const groups = await prisma.sale.groupBy({
            by: ['representativeId', 'customerId', 'areaId'],
            where: { isHidden: false, recordType: 'sale', customerId: { in: [...custKey.keys()] }, uploadedFile: { sourceSystem: 'mercato', user: officeWhere } },
            _count: { _all: true },
          });
          const hReps = await prisma.medicalRepresentative.findMany({ where: { id: { in: [...new Set(groups.map(g => g.representativeId))] } }, select: { id: true, name: true } });
          const repNameById = new Map(hReps.map(r => [r.id, r.name]));
          for (const g of groups) {
            const k = custKey.get(g.customerId);
            if (!pharmHistory.has(k)) pharmHistory.set(k, []);
            pharmHistory.get(k).push({ areaId: g.areaId, repKey: repCoreKey(repNameById.get(g.representativeId) || ''), n: g._count._all });
          }
        }
      } catch (e) { console.error('[orders] pharmacy history lookup failed:', e?.message); }
    }

    // الفائز يحتاج تفوّقاً واضحاً (ضعف الوصيف) وإلا يبقى القرار للمراجِع.
    const pickWinner = (score, minScore) => {
      const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
      return ranked.length && ranked[0][1] >= minScore && ranked[0][1] >= 2 * (ranked[1]?.[1] || 0) ? ranked[0][0] : null;
    };

    for (const [row, ctx] of ctxByRow) {
      if (ctx.candidates.length <= 1) continue;
      const hist = pharmHistory.get(pharmKey(row.pharmacy)) || [];
      const score = new Map();
      for (const h of hist) {
        if (ctx.areaIds.size && !ctx.areaIds.has(h.areaId)) continue; // نفس الاسم بمنطقة أخرى صيدلية أخرى
        const c = ctx.candidates.find(x => sameRepKey(repCoreKey(x.name), h.repKey));
        if (c) score.set(c, (score.get(c) || 0) + h.n);
      }
      const w = pickWinner(score, 1);
      if (w) { ctx.decided = w; ctx.candidates = [w, ...ctx.candidates.filter(c => c !== w)]; }
    }

    for (const [row, ctx] of ctxByRow) {
      let { candidates } = ctx;
      if (!ctx.decided && candidates.length > 1 && history.length && ctx.areaIds.size) {
        const score = new Map();
        for (const h of history) {
          if (!ctx.areaIds.has(h.areaId)) continue;
          const w = h.itemKey && h.itemKey === ctx.itemKey ? 3 : (ctx.brand && h.brand === ctx.brand ? 1 : 0);
          if (!w) continue;
          const c = candidates.find(x => sameRepKey(repCoreKey(x.name), h.repKey));
          if (c) score.set(c, (score.get(c) || 0) + w * h.n);
        }
        const w = pickWinner(score, 2);
        if (w) {
          // الأرجح أولاً في القائمة، والبقية تبقى للمراجِع.
          candidates = [w, ...candidates.filter(c => c !== w)];
          ctx.decided = w;
        }
      }
      ctx.candidates = candidates;
    }

    // ── اتّساق الفاتورة: نفس الصيدلية + نفس الشركة = نفس المندوب غالباً ──
    // صنف حُسم مندوبه يُرجّح بقية أصناف نفس الفاتورة من نفس الشركة حين يكون
    // ذلك المندوب ضمن مرشّحيها (ولا يُفرَض على من لا يغطّي المنطقة).
    const invoiceKey = (r) => [normalizeAreaName(r.pharmacy || ''), normalizeAreaName(r.area || ''), String(r.invoiceNumber ?? '').trim()].join('|');
    const decidedByInvoice = new Map();
    for (const [row, ctx] of ctxByRow) {
      const name = row.scientificRep || ctx.decided?.name || (ctx.candidates.length === 1 ? ctx.candidates[0].name : null);
      if (!name) continue;
      const k = invoiceKey(row);
      if (!decidedByInvoice.has(k)) decidedByInvoice.set(k, []);
      decidedByInvoice.get(k).push({ key: repCoreKey(name), sciId: ctx.sciId });
    }
    for (const [row, ctx] of ctxByRow) {
      if (ctx.decided || ctx.candidates.length <= 1) continue;
      const decided = decidedByInvoice.get(invoiceKey(row)) || [];
      const sameCo = decided.filter(d => d.sciId == null || ctx.sciId == null || d.sciId === ctx.sciId);
      const hits = [...new Set(ctx.candidates.filter(c => sameCo.some(d => sameRepKey(repCoreKey(c.name), d.key))))];
      if (hits.length === 1) {
        ctx.decided = hits[0];
        ctx.candidates = [hits[0], ...ctx.candidates.filter(c => c !== hits[0])];
      }
    }

    for (const [row, ctx] of ctxByRow) {
      const { candidates } = ctx;
      row._repCandidates = candidates.slice(0, 8).map(c => ({ id: c.id, name: c.name }));
      if (!row.scientificRep) {
        row.scientificRep = ctx.decided?.name ?? (candidates.length === 1 ? candidates[0].name : null);
      }
    }
  } catch (e) {
    console.error('[orders] تعذّر تخمين المندوب العلمي:', e?.message);
  }
  return rows;
}

/**
 * كل المندوبين العلميين النشطين في مكتب المستخدم — خيارات خانة «المندوب العلمي»
 * في شبكة المراجعة حين يمسح المراجِع الاسم المقترح. نفس نطاق
 * attachScientificRepGuess (نفس المكتب)، فلا يظهر مندوب لا يمكن أن يخصّ الطلبية.
 */
export async function listOfficeScientificReps(userId) {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { officeId: true } });
  const reps = await prisma.user.findMany({
    where: {
      role: 'scientific_rep',
      isActive: true,
      ...(me?.officeId ? { officeId: me.officeId } : {}),
    },
    select: { id: true, username: true, displayName: true },
  });
  return reps
    .map(r => ({ id: r.id, name: r.displayName?.trim() || r.username }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

/** عدد صفوف الطلبية المعلَّقة — يُعرَض في الشريط وفي ردّ البوت. */
export async function countPendingOrders(userId) {
  return prisma.pendingBotOrder.count({ where: { userId } });
}

/**
 * يحلّ مندوب الطلبية من حساب الكروب المربوط (قرار المستخدم: الاسم من الحساب لا
 * من نص الرسالة). repCoreName يُسقط لاحقة «/ المنطقة ph» التي تحملها أسماء
 * الحسابات الفعلية، ثم تُطابَق النتيجة بمندوبي ذلك الحساب. عند اللبس يبقى repId
 * فارغاً ويختار المراجِع من المنسدلة — لا نُنشئ مندوباً تلقائياً هنا أبداً.
 */
async function resolveRep(user) {
  const core = repCoreName(user.displayName?.trim() || user.username || '');
  if (!core) return { repName: null, repId: null };
  try {
    const reps = await prisma.medicalRepresentative.findMany({
      where: { userId: user.id }, select: { id: true, name: true },
    });
    if (reps.length) {
      const m = matchRepName(core, buildRepIndex(reps));
      if (m.status === 'exact' && m.rep) return { repName: m.rep.name, repId: m.rep.id };
    }
  } catch (e) {
    console.error('[orders] تعذّر مطابقة المندوب:', e?.message);
  }
  return { repName: core, repId: null };
}

async function saveImages(buffers) {
  if (!buffers?.length) return [];
  await fs.mkdir(BOT_ORDER_IMAGES_DIR, { recursive: true });
  const names = [];
  for (const buf of buffers) {
    if (!buf?.length) continue;
    const name = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.jpg`;
    await fs.writeFile(path.join(BOT_ORDER_IMAGES_DIR, name), buf);
    names.push(name);
  }
  return names;
}

/** حذف صور صفٍّ — best-effort، فشلها لا يُسقط حذف الصف نفسه. */
async function unlinkImages(imageFiles) {
  for (const name of toImageList(imageFiles)) {
    await fs.unlink(path.join(BOT_ORDER_IMAGES_DIR, name)).catch(() => {});
  }
}

/** يُعيد أسماء ملفات آمنة فقط — حارس ضد اجتياز المسار من قيمة Json مشوّهة. */
function toImageList(imageFiles) {
  if (!Array.isArray(imageFiles)) return [];
  return imageFiles.filter(n =>
    typeof n === 'string' && n === path.basename(n) && ALLOWED_IMAGE_EXT.has(path.extname(n).toLowerCase()),
  );
}

// ─── تحويل الطلبية لمدير الشركة صاحب الايتم ─────────────────────────────────
// (2026-10-19، طلب صاحب المشروع) طلبية فيها «Pantactive» تخصّ مدير humanis: هو من
// يدقّقها ويوافق عليها، لا حساب الكروب. الصفوف تُقسَّم بحسب مالك كل ايتم
// (lib/itemOwnerManager.js — نفس قاعدة التحليل الشامل)، وكل مدير يستلم طلبية معلَّقة
// باسمه (userId = المدير) فتعمل القائمة والصور والحذف والاستهلاك بلا أي تفريع.
// الحساب الأصلي يُحفَظ في payload.originUserId: الحفظ يذهب لملف كوديشن **ذلك**
// الحساب (الملف المشترك أصلاً مع إدارة المكتب) لا لملف شخصي عند المدير.
// ايتم بلا مدير مالك يبقى عند حساب الكروب كما كان.

/** يُرفع عند تغيير قاعدة التقسيم كي تُعاد على الطابور القائم. */
// 2: إعادة قراءة الصفوف القديمة قبل التقسيم + الدمج. (بديل «مدير الشركة العلمية»
//    أُزيل: «الشركة» عند صاحب المشروع = ايتمات المدير المُسنَدة فقط.)
const ROUTE_VERSION = 2;

/**
 * يقسّم صفوف طلبية بين حساب الكروب ومدراء الشركات المالكين لأصنافها.
 * @returns {Promise<{ keep: any[], forwards: {managerId:number, managerName:string, companyName:string|null, rows:any[]}[] }>}
 */
export async function splitRowsByOwner(rows, user) {
  const none = { keep: rows, forwards: [] };
  if (!Array.isArray(rows) || !rows.length || !user?.officeId) return none;
  let owners;
  try {
    owners = await loadItemOwnerManagers(user.officeId);
  } catch (e) {
    console.error('[orders] تعذّر تحميل مالكي الايتمات:', e?.message);
    return none; // التحويل تحسين — فشله يُبقي الطلبية عند حساب الكروب
  }
  if (!owners.size) return none;

  // صنف لم يُربط بكتالوج حساب الكروب يُجرَّب على كتالوج المكتب كله — بنفس سلّم
  // enrichRowsFromCatalog (المحلِّل ثم بديل «العلامة + الجرعة»: «Devit 50»).
  const officeIdByName = new Map();
  const sciCompanies = await prisma.scientificCompany.findMany({ where: { officeId: user.officeId }, select: { id: true, name: true } }).catch(() => []);
  const unlinked = [...new Set(rows.filter(r => r && !r._itemId && String(r.item ?? '').trim()).map(r => String(r.item).trim()))];
  if (unlinked.length && sciCompanies.length) {
    try {
      const ctx = await loadCompanyContext(sciCompanies.map(s => s.id));
      if (ctx.catalog.length) {
        for (const name of unlinked) {
          let r = resolveItemNameSync(name, ctx);
          const sure = (x) => x?.canonicalItem && (x.confidence === 'alias' || x.confidence === 'exact' || x.confidence === 'high');
          if (!sure(r)) {
            const fb = brandDoseFallback(name, ctx.catalog);
            if (sure(fb)) r = fb;
          }
          if (sure(r)) officeIdByName.set(name, r.canonicalItem.id);
        }
      }
    } catch (e) { console.error('[orders] office item link (routing) failed:', e?.message); }
  }

  const keep = [];
  const byManager = new Map();
  for (const row of rows) {
    if (!row) continue;
    const itemId = row._itemId ?? officeIdByName.get(String(row.item ?? '').trim()) ?? null;
    // «الشركة» = تيم المدير: الايتم المُسنَد له فقط (قاعدة التحليل الشامل) — لا
    // الشركة العلمية للايتم. ايتم غير مُسنَد لأي مدير يبقى عند حساب الكروب.
    const owner = itemId != null ? owners.get(itemId) : null;
    if (!owner || owner.managerId === user.id) { keep.push(row); continue; }
    if (!byManager.has(owner.managerId)) byManager.set(owner.managerId, { ...owner, rows: [] });
    byManager.get(owner.managerId).rows.push(row);
  }
  return { keep, forwards: [...byManager.values()] };
}

const displayNameOf = (u) => u?.displayName?.trim() || u?.username || '';

/**
 * ينشئ صفّاً معلَّقاً، أو يستبدل قراءة صفّ بنفس البصمة عند نفس المالك.
 * إعادة إرسال طلبية ما زالت معلَّقة = طلب إعادة قراءة (بعد تحسين الاستخراج أو
 * لأن القراءة الأولى كانت خاطئة). الصف المعلَّق لم يُراجَع بعد — تعديلات المراجِع
 * لا تُحفَظ فيه — فاستبدال قراءته آمن ولا يُنشئ مبيعات مكرّرة.
 * @returns {Promise<{id:number, replaced:boolean}>}
 */
async function createOrReplacePending({ ownerId, data, payload, rows, imageFiles, merge = false }) {
  try {
    const created = await prisma.pendingBotOrder.create({
      data: {
        ...data,
        userId: ownerId,
        imageFiles: imageFiles.length ? imageFiles : null,
        payload,
        rowCount: rows.length,
      },
      select: { id: true },
    });
    return { id: created.id, replaced: false };
  } catch (err) {
    if (err?.code !== 'P2002') { await unlinkImages(imageFiles); throw err; }
    const existing = await prisma.pendingBotOrder.findFirst({
      where: { userId: ownerId, sourceHash: data.sourceHash }, select: { id: true, imageFiles: true },
    });
    if (!existing) {
      await unlinkImages(imageFiles);
      throw new AppError('هذه الطلبية مُسجَّلة مسبقاً بانتظار المراجعة.', 409, 'DUPLICATE_ORDER');
    }
    if (merge) {
      // تحويل جزء آخر من **نفس** الطلبية لمدير استلم جزءاً منها سابقاً (مثلاً
      // Devit بعد أن صار يُعرَف): تُضاف الصفوف لطلبيته ولا تستبدلها، وصوره تبقى.
      const cur = await prisma.pendingBotOrder.findUnique({ where: { id: existing.id }, select: { payload: true } });
      const curRows = Array.isArray(cur?.payload?.rows) ? cur.payload.rows : [];
      const merged = [...curRows, ...rows];
      await prisma.pendingBotOrder.update({
        where: { id: existing.id },
        data: { payload: { ...(cur?.payload || {}), rows: merged }, rowCount: merged.length },
      });
      await unlinkImages(imageFiles);
      return { id: existing.id, replaced: false, merged: true };
    }
    await prisma.pendingBotOrder.update({
      where: { id: existing.id },
      data: { payload, rowCount: rows.length, imageFiles: imageFiles.length ? imageFiles : null },
    });
    await unlinkImages(existing.imageFiles);
    return { id: existing.id, replaced: true };
  }
}

/**
 * يُسجّل طلبية مستخرَجة في الطابور ويُعيد نصّ ردّ البوت بالعربية.
 * يرمي AppError تشغيلياً (isOperational) فيصل نصّه للكروب كما هو.
 */
export async function ingestBotOrder({
  user, source, chatId, chatTitle = null, senderName = null,
  kind, sourceText = null, rows, imageBuffers = [], mediaKeys = [],
}) {
  if (!rows?.length) throw new AppError('لم أتعرّف على أي صنف في هذه الطلبية.', 422, 'NO_ORDER_ROWS');

  const { keep, forwards } = await splitRowsByOwner(rows, user);

  // حدّ الطابور يخصّ ما يبقى عند حساب الكروب؛ المحوَّل يذهب لطوابير المدراء.
  if (keep.length) {
    const pending = await countPendingOrders(user.id);
    if (pending >= MAX_PENDING_ORDERS_PER_USER) {
      throw new AppError(
        `لديك ${pending} طلبية بانتظار المراجعة — راجِعها أو ألغِ بعضها من التطبيق أولاً.`,
        409, 'PENDING_ORDERS_FULL',
      );
    }
  }

  const { repName, repId } = await resolveRep(user);
  const sourceHash = orderSourceHash({ userId: user.id, text: sourceText, mediaKeys });
  const data = {
    source, chatId: String(chatId), chatTitle, senderName, repName, repId, kind,
    sourceText: sourceText || null, sourceHash,
  };
  const basePayload = () => ({
    extractedAt: new Date().toISOString(), textParse: TEXT_PARSE_VERSION, routed: ROUTE_VERSION,
  });

  const lines = [];
  // الصور تُكتب قبل الصف كي لا يُنشأ صف يشير لملفات غير موجودة؛ وكل صفّ نسخته
  // الخاصة منها — حذف طلبية عند مدير لا يمسّ صور نسختها عند حساب الكروب.
  if (keep.length) {
    const r = await createOrReplacePending({
      ownerId: user.id, data, rows: keep,
      payload: { ...basePayload(), rows: keep },
      imageFiles: await saveImages(imageBuffers),
    });
    // ردّ مختصر بطلب صاحب المشروع: الكروب كروب عمل، والتفاصيل مكانها التطبيق.
    lines.push(r.replaced ? `🔄 أُعيدت قراءة الطلبية #${r.id}` : `تم الاستلام والتحليل #${r.id}`);
  }
  for (const f of forwards) {
    const r = await createOrReplacePending({
      ownerId: f.managerId, data, rows: f.rows,
      payload: { ...basePayload(), rows: f.rows, originUserId: user.id, originName: displayNameOf(user) },
      imageFiles: await saveImages(imageBuffers),
    });
    lines.push(`${r.replaced ? '🔄' : '↪️'} #${r.id} حُوِّلت لمدير ${f.companyName || 'الشركة'} (${f.managerName}) — ${f.rows.length} صنف`);
  }
  if (forwards.length && !keep.length) lines.unshift('تم الاستلام والتحليل');
  return lines.join('\n');
}

/**
 * تقسيم الطابور القائم (طلبيات وصلت قبل خاصية التحويل، أو قبل إسناد ايتم لمدير):
 * يُطبَّق كسولاً عند فتح الشريط مرة واحدة لكل طلبية (payload.routed). المحوَّل
 * يحتفظ بوقت وصوله الأصلي ونسخة من صوره.
 */
const routingInFlight = new Set();
async function routeQueuedOrders(userId) {
  if (routingInFlight.has(userId)) return; // استقصاءان متزامنان لا يحوّلان مرتين
  routingInFlight.add(userId);
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }, select: { id: true, officeId: true, displayName: true, username: true },
    });
    if (!user?.officeId) return;
    const queued = await prisma.pendingBotOrder.findMany({ where: { userId } });
    for (const q of queued) {
      const payload = q.payload || {};
      if (payload.routed === ROUTE_VERSION || payload.originUserId != null) continue;
      const rows = Array.isArray(payload.rows) ? payload.rows.filter(Boolean) : [];
      // الصفوف المخزّنة قد تكون من قراءة أقدم لم تربط الصنف بكتالوج («Devit 50»،
      // «pandev 20 (5)») فلا يُعرَف مالكه — تُعاد قراءتها وتُحفَظ قبل التقسيم، بنفس
      // ما يفعله getPendingOrder عند الفتح (هناك في الذاكرة فقط).
      await refreshStoredRows(q, rows, user);
      const { keep, forwards } = await splitRowsByOwner(rows, user);
      try {
        for (const f of forwards) {
          await createOrReplacePending({
            ownerId: f.managerId,
            data: {
              source: q.source, chatId: q.chatId, chatTitle: q.chatTitle, senderName: q.senderName,
              repName: q.repName, repId: q.repId, kind: q.kind, sourceText: q.sourceText,
              sourceHash: q.sourceHash, createdAt: q.createdAt,
            },
            rows: f.rows,
            payload: { ...payload, rows: f.rows, routed: ROUTE_VERSION, originUserId: user.id, originName: displayNameOf(user) },
            imageFiles: await copyImages(q.imageFiles),
            merge: true,
          });
        }
        if (forwards.length && !keep.length) {
          await prisma.pendingBotOrder.delete({ where: { id: q.id } });
          await unlinkImages(q.imageFiles);
        } else {
          await prisma.pendingBotOrder.update({
            where: { id: q.id },
            data: { payload: { ...payload, rows: keep, routed: ROUTE_VERSION, textParse: payload.textParse }, rowCount: keep.length },
          });
        }
        if (forwards.length) console.log(`[orders] #${q.id} حُوِّلت: ${forwards.map(f => `${f.managerName}×${f.rows.length}`).join('، ')}`);
      } catch (e) {
        console.error(`[orders] تعذّر تحويل الطلبية #${q.id}:`, e?.message);
      }
    }
  } catch (e) {
    console.error('[orders] تعذّر تحويل الطابور:', e?.message);
  } finally {
    routingInFlight.delete(userId);
  }
}

async function refreshStoredRows(q, rows, user) {
  const payload = q.payload || {};
  try {
    if (rows.length && q.kind === 'text' && q.sourceText && payload.textParse !== TEXT_PARSE_VERSION) {
      const areaBefore = rows.map(r => r.area ?? null);
      await applyTextParse(rows, q.sourceText);
      await enrichRowsFromCatalog(rows, user.id);
      await matchInvoiceCustomers(rows);
      rows.forEach((r, i) => { if (r.area !== areaBefore[i]) r.scientificRep = null; });
      payload.textParse = TEXT_PARSE_VERSION;
    } else {
      const unlinked = rows.filter(r => !r._itemId);
      if (unlinked.length) await enrichRowsFromCatalog(unlinked, user.id);
    }
    if (rows.some(r => !r.scientificRep)) await attachScientificRepGuess(rows, user);
  } catch (e) {
    console.error(`[orders] تعذّر إعادة قراءة الطلبية #${q.id}:`, e?.message);
  }
}

async function copyImages(imageFiles) {
  const names = [];
  for (const src of toImageList(imageFiles)) {
    const name = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.jpg`;
    try {
      await fs.copyFile(path.join(BOT_ORDER_IMAGES_DIR, src), path.join(BOT_ORDER_IMAGES_DIR, name));
      names.push(name);
    } catch { /* صورة مفقودة لا تمنع التحويل */ }
  }
  return names;
}

/**
 * الحساب الذي يُحفَظ في ملف كوديشنه صفّ طلبية محوَّلة: يُرجع خريطة
 * pendingOrderId → originUserId للطلبيات المملوكة للمراجِع فقط (فحص الملكية هنا
 * هو ما يسمح للمدير بالكتابة في ملف حساب الكروب — لا غيره).
 */
export async function loadOrderOrigins(reviewerId, ids) {
  const list = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!reviewerId || !list.length) return new Map();
  const rows = await prisma.pendingBotOrder.findMany({
    where: { id: { in: list }, userId: reviewerId }, select: { id: true, payload: true },
  });
  return new Map(rows.map(r => [r.id, Number(r.payload?.originUserId) || reviewerId]));
}

/** قائمة خفيفة للشريط — بلا payload.rows (قد تكون عشرات الصفوف). */
export async function listPendingOrders(userId) {
  // تقليم كسول: لا setInterval (لا نفترض عدد نسخ PM2) وidempotent بطبعه.
  const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 86_400_000);
  const stale = await prisma.pendingBotOrder.findMany({
    where: { userId, createdAt: { lt: cutoff } }, select: { id: true, imageFiles: true },
  });
  if (stale.length) {
    await prisma.pendingBotOrder.deleteMany({ where: { id: { in: stale.map(s => s.id) } } });
    for (const s of stale) await unlinkImages(s.imageFiles);
  }

  // صفوف تخصّ ايتمات مدراء الشركات تُحوَّل لهم قبل العرض (مرة لكل طلبية).
  await routeQueuedOrders(userId);

  const rows = await prisma.pendingBotOrder.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, source: true, chatTitle: true, senderName: true, repName: true,
      kind: true, sourceText: true, rowCount: true, imageFiles: true, createdAt: true, payload: true,
    },
  });

  return rows.map(r => ({
    ...r,
    payload: undefined,
    originName: r.payload?.originUserId ? (r.payload.originName || null) : null,
    imageFiles: undefined,
    imageCount: toImageList(r.imageFiles).length,
    // أول صيدلية للعرض في الشريط بلا تحميل كل الصفوف
    preview: (r.sourceText || '').replace(/\s+/g, ' ').slice(0, 120) || null,
  }));
}

/**
 * طلبية واحدة للمراجعة. يُسطّح payload ويحقن الحقول المساعدة كي يصبح الردّ
 * متوافق الشكل مع ما يبنيه المودال من استخراج طازج — نفس خدعة
 * getPendingVisitsImport في doctors.controller.js التي تجعل مساراً واحداً يخدم
 * طريقَي الدخول بلا تفريع.
 */
export async function getPendingOrder(userId, id) {
  const row = await prisma.pendingBotOrder.findFirst({ where: { id: Number(id), userId } });
  if (!row) throw new AppError('الطلبية غير موجودة أو لا تخصّك.', 404, 'ORDER_NOT_FOUND');
  const payload = row.payload || {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  // طلبية نصّية قُرئت قبل القراءة الحتمية للنص (2026-10-19) تُعاد قراءتها عند الفتح:
  // ترويسة متعدّدة الأسطر وكمية بين قوسين ← ثم إعادة مطابقة الكتالوج والماستر
  // والمندوب. في الذاكرة فقط كالمطابقة أدناه.
  if (rows.length && row.kind === 'text' && row.sourceText && payload.textParse !== TEXT_PARSE_VERSION) {
    const live = rows.filter(Boolean);
    const areaBefore = live.map(r => r.area ?? null);
    // النصّ كما هو: الأسطر هي ما يقرأه المحلّل، وparseOrderText يُسقط سطر «طلبية» بنفسه.
    await applyTextParse(live, row.sourceText);
    rows.splice(0, rows.length, ...live); // القراءة قد تحذف صفوفاً (سطر مذاخر قُرئ صنفاً)
    await enrichRowsFromCatalog(live, userId);
    await matchInvoiceCustomers(live);
    // مندوب خُمِّن من منطقة خاطئة يُمسح ليُعاد تخمينه من المنطقة المصحّحة أدناه.
    live.forEach((r, i) => { if (r.area !== areaBefore[i]) r.scientificRep = null; });
  } else if (rows.length && rows.every(r => r && r._pharmacyMatched === undefined)) {
    // طلبيات دخلت الطابور قبل مطابقة الماستر (لا تحمل _pharmacyMatched) تُطابَق عند
    // الفتح — في الذاكرة فقط، فالصف المخزَّن لا يتغيّر قبل تأكيد المراجِع.
    await matchInvoiceCustomers(rows);
  }
  // التخمين يُعاد عند الفتح لكل صف بلا مندوب — كي تستفيد الطلبيات المعلَّقة من
  // أي تعيين مناطق جديد (أو إصلاح في التخمين) بلا إعادة إرسالها.
  // كل الصفوف تُمرَّر (لا الفارغة وحدها): المحسومة منها دليل «اتّساق الفاتورة»
  // لبقية أصنافها، والتخمين لا يكتب فوق مندوب موجود.
  if (rows.some(r => r && !r.scientificRep)) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, officeId: true } });
    if (user) await attachScientificRepGuess(rows.filter(Boolean), user);
  }
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    rows,
    extractedAt: payload.extractedAt ?? null,
    repName: row.repName,
    repId: row.repId,
    sourceText: row.sourceText,
    senderName: row.senderName,
    chatTitle: row.chatTitle,
    imageCount: toImageList(row.imageFiles).length,
    createdAt: row.createdAt,
    // طلبية محوَّلة من حساب الكروب: الحفظ في ملف كوديشن ذلك الحساب.
    originUserId: payload.originUserId ?? null,
    originName: payload.originUserId ? (payload.originName || null) : null,
  };
}

/** مسار صورة على القرص بعد التحقق من ملكية الصف — للبثّ عبر نقطة مصادَقة. */
export async function getPendingOrderImagePath(userId, id, index) {
  const row = await prisma.pendingBotOrder.findFirst({
    where: { id: Number(id), userId }, select: { imageFiles: true },
  });
  if (!row) throw new AppError('الطلبية غير موجودة أو لا تخصّك.', 404, 'ORDER_NOT_FOUND');
  const names = toImageList(row.imageFiles);
  const name = names[Number(index)];
  if (!name) throw new AppError('الصورة غير موجودة.', 404, 'IMAGE_NOT_FOUND');
  return path.join(BOT_ORDER_IMAGES_DIR, name);
}

/** إلغاء طلبية معلَّقة بلا حفظ أي شيء منها. */
export async function deletePendingOrder(userId, id) {
  const row = await prisma.pendingBotOrder.findFirst({
    where: { id: Number(id), userId }, select: { id: true, imageFiles: true },
  });
  if (!row) throw new AppError('الطلبية غير موجودة أو لا تخصّك.', 404, 'ORDER_NOT_FOUND');
  await prisma.pendingBotOrder.delete({ where: { id: row.id } });
  await unlinkImages(row.imageFiles);
  return true;
}

/**
 * يُستهلَك الصف بعد حفظ ناجح في insertManualSales — يُستدعى من
 * sales.controller.js. best-effort بالكامل: فشله لا يُسقط نجاح الحفظ.
 */
export async function consumePendingOrder(userId, id) {
  if (!id) return;
  try {
    const row = await prisma.pendingBotOrder.findFirst({
      where: { id: Number(id), userId }, select: { id: true, imageFiles: true },
    });
    if (!row) return;
    await prisma.pendingBotOrder.delete({ where: { id: row.id } });
    await unlinkImages(row.imageFiles);
  } catch (e) {
    console.error('[orders] تعذّر حذف الطلبية المعلَّقة بعد الحفظ:', e?.message);
  }
}
