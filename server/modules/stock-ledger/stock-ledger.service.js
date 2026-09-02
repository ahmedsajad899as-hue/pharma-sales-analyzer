/**
 * Stock Ledger Service — دفتر رصيد المذاخر
 *
 *   المتبقي = آخر ستوك افتتاحي مرفوع
 *           + التعزيزات الداخلة للمذخر بعد تاريخه
 *           − المبيع الخارج من المذخر إلى الصيدليات بعد تاريخه
 *
 * مبدأ التنفيذ: StockBalance مُشتق بالكامل. كل عملية (رفع/حذف/إدخال يدوي)
 * تنتهي بـ recomputeBalances() التي تعيد بناء الأرصدة من الصفر من StockMovement،
 * فلا يوجد تعديل تراكمي يمكن أن ينحرف.
 */

import * as XLSX from 'xlsx';
import prisma from '../../lib/prisma.js';
import {
  resolveColumns, detectHeaderRow, parseNumeric, parseExcelDate,
  detectMercatoFormat, mercatoColumnMap,
} from '../sales/sales.service.js';
import {
  normalizeArabic, normalizeAreaName, normalizeItemKey,
  loadResolutionContext, resolveItemName,
} from '../../lib/itemResolver.js';
import { areSimilar, similarity } from '../../lib/fuzzyMatch.js';
import { flattenStockMatrix } from '../../lib/stockMatrix.js';
import { isPlaceholderCompanyValue } from '../../lib/companyResolver.js';
import { getAllCompanies } from '../sales/sales.repository.js';
import * as repo from './stock-ledger.repository.js';

// COLUMN_ALIASES.customer يضع «صيدلية/زبون» قبل «مذخر»، وresolveColumns يأخذ أول
// تطابق — فملف فيه العمودان معاً يُرجِع الصيدلية. لذلك للمذخر قائمة خاصة تُفحص أولاً.
const WAREHOUSE_ALIASES = [
  'المذخر', 'مذخر', 'اسم المذخر', 'المخزن', 'مخزن', 'اسم المخزن',
  'المستودع', 'مستودع', 'اسم المستودع', 'المجهز', 'اسم المجهز',
  'warehouse', 'warehouse name', 'store', 'store name', 'depot', 'depot name',
];

const DIRECTIONS = { baseline: 'baseline', in: 'in', out: 'out' };

// ═══════════════════════════════════════════════════════════════
//  1. تحليل ملف الحركات (صيغة طولية)
// ═══════════════════════════════════════════════════════════════

/** يبحث عن ترويسة المذخر بالتطابق التام ثم الجزئي، وإلا يعود لـ customer العام */
function resolveWarehouseCol(headers, fallbackCustomerCol) {
  const lower = headers.map(h => String(h).toLowerCase().trim());
  const aliases = WAREHOUSE_ALIASES.map(a => a.toLowerCase().trim());
  const exact = lower.findIndex(h => aliases.includes(h));
  if (exact !== -1) return headers[exact];
  const partial = lower.findIndex(h => aliases.some(a => h.includes(a)));
  if (partial !== -1) return headers[partial];
  return fallbackCustomerCol;
}

/**
 * يحلّل ملف Excel طولي: المذخر | المنطقة | الشركة | الايتم | الكمية | التاريخ
 *
 * يكتشف صيغة ميركاتو تلقائياً (نفس محرّك وحدة المبيعات: detectMercatoFormat/
 * mercatoColumnMap) — ملف طلبيات مذاخر عامة، حيث «اسم الشركة» = الصيدلية لا
 * شركة، و«الصنف» = الشركة الحقيقية، و«المنطقة»/«المدينة» تخصّان الصيدلية لا
 * المذخر (فتُهمَل تماماً كمنطقة له)، والكمية = المدفوعة + البونص (البونص يخرج
 * فعلياً من المذخر أيضاً). حقول إضافية (رقم/حالة الطلبية، حالة المادة، اسم
 * الصيدلية) تُرفَق بالصف لاستعمال filterMercatoRows لاحقاً في ingestRows.
 *
 * @returns {{rows: object[], headers: string[], colMap: object, skipped: number}}
 */
export function parseMovementFile(buffer, defaultDate) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], headers: [], colMap: {}, skipped: 0 };

  // يتخطى صفوف العنوان/الشعار التي تسبق الترويسة الحقيقية
  const headerRow = detectHeaderRow(ws, {});
  const json = XLSX.utils.sheet_to_json(ws, { range: headerRow, defval: '' });
  if (!json.length) return { rows: [], headers: [], colMap: {}, skipped: 0 };

  const headers = Object.keys(json[0]);
  const cm = resolveColumns(headers, {});
  const isMercato = detectMercatoFormat(headers);
  if (isMercato) Object.assign(cm, mercatoColumnMap(headers));
  const whCol = resolveWarehouseCol(headers, cm.customer);
  const colMap = {
    warehouse: whCol, region: cm.area, item: cm.item,
    quantity: cm.quantity, company: cm.company, date: cm.date,
    ...(isMercato ? {
      orderNumber: cm.orderNumber, orderStatus: cm.orderStatus,
      itemStatus: cm.itemStatus, bonusQty: cm.bonusQty, pharmacy: cm.customer,
    } : {}),
  };

  const rows = [];
  let skipped = 0;
  for (const raw of json) {
    const warehouse = String(raw[whCol] ?? '').trim();
    const itemName = String(raw[cm.item] ?? '').trim();
    const paidQty = Math.abs(parseNumeric(raw[cm.quantity]));
    const bonusQty = isMercato && cm.bonusQty ? Math.abs(parseNumeric(raw[cm.bonusQty])) : 0;
    const qty = paidQty + bonusQty;
    if (!warehouse || !itemName || qty <= 0) { skipped++; continue; }
    rows.push({
      warehouse,
      region: isMercato ? '' : String(raw[cm.area] ?? '').trim(),
      itemName,
      companyName: (raw[cm.company] && !isPlaceholderCompanyValue(raw[cm.company])) ? String(raw[cm.company]).trim() : null,
      qty,
      movementDate: parseExcelDate(raw[cm.date]) ?? defaultDate,
      rawRow: raw,
      ...(isMercato ? {
        orderNumber: cm.orderNumber ? String(raw[cm.orderNumber] ?? '').trim() : '',
        orderStatus: cm.orderStatus ? String(raw[cm.orderStatus] ?? '').trim() : '',
        itemStatus: cm.itemStatus ? String(raw[cm.itemStatus] ?? '').trim() : '',
        pharmacyName: cm.customer ? String(raw[cm.customer] ?? '').trim() : '',
      } : {}),
    });
  }
  return { rows, headers, colMap, skipped };
}

// ═══════════════════════════════════════════════════════════════
//  2. مطابقة المذاخر
// ═══════════════════════════════════════════════════════════════

// بادئات كلمة «مذخر» العامة الشائعة في عمود اسم المذخر نفسه (لا في ترويسة
// العمود — تلك WAREHOUSE_ALIASES أعلاه). بدونها "مذخر اوزون" لا يُطابق "اوزون"
// إطلاقاً رغم أنهما نفس المذخر بالضبط — لا في المطابقة التامة ولا الضبابية
// (كلمة كاملة إضافية تُنقص نسبة تداخل الكلمات دون العتبة). على غرار
// DOCTOR_PREFIX_RE في doctor-visits-import.js.
const WAREHOUSE_PREFIX_RE = /^(مذخر|مخزن|مستودع|مجهز)\s+/;
export function cleanWarehouseName(name) {
  let s = normalizeArabic(String(name ?? ''));
  for (let i = 0; i < 2 && WAREHOUSE_PREFIX_RE.test(s); i++) s = s.replace(WAREHOUSE_PREFIX_RE, '').trim();
  return s;
}
const whKey = (s) => cleanWarehouseName(s).toLowerCase();
const regKey = (s) => normalizeAreaName(String(s ?? '')) || '';
/** مفتاح تصنيف/حفظ موحّد لاسم مذخر — نفس القيمة تُستعمل في WarehouseNameLink.fromKey.
 *  مُصدَّر أيضاً لسكربت scripts/stock-ledger-name-cleanup.mjs. */
export const warehouseLinkKey = (name, region) => whKey(name) + '|' + regKey(region);

/**
 * منطقة «فاسدة»: بقايا خلل تحليل قديم انجمدت في StockWarehouse.region ولا تُصحَّح
 * تلقائياً بعدها أبداً (المطابقة بالاسم تعيد استعمال السجل القديم كما هو). الأنماط:
 * فارغة/'غير محدد'، أو شظية حرف واحد/حرفين من دمج خلايا فاشل (راجع stockParser.ts)،
 * أو عنوان/اسم ملف الستوك نفسه استُعمل احتياطياً بدل اسم منطقة حقيقي ("ستوك ...").
 */
function looksLikeBadRegion(region) {
  const r = String(region ?? '').trim();
  if (!r || r === 'غير محدد') return true;
  if (r.length <= 2) return true;
  // \b لا يعمل بعد حرف عربي (\w في JS لا يشمل العربية) — لهذا فحص مسافة/نهاية صريح
  if (/^ستوك(?:\s|$)/.test(r)) return true;
  return false;
}

const WAREHOUSE_ASK_FLOOR = 0.5; // أدنى نقاط تشابه يُعتَد بها كمرشّح يُعرض للمستخدم

/**
 * مرشّحو مذخر مرتّبون لاسم معطى ضمن مجموعة مذاخر — يُستعمل في المعاينة
 * (classifyWarehouseRows) وفي المُحلِّل الفعلي أثناء الاستيعاب معاً، فلا تختلف
 * قراءة الالتباس بين الحالتين.
 */
function scoreWarehouseCandidates(name, pool) {
  return pool
    .map(w => ({ id: w.id, name: w.name, region: w.region, score: similarity(whKey(name), whKey(w.name)) }))
    .filter(w => w.score >= WAREHOUSE_ASK_FLOOR || areSimilar(name, w.name))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/**
 * تصنيف مذخر واحد (اسم+منطقة) مقابل مذاخر المستخدم + روابط محفوظة — قراءة
 * فقط، لا تُنشئ ولا تحفظ شيئاً. الترتيب: رابط محفوظ ← تطابق تام (منطقة+اسم) ←
 * اسم تام ووحيد بغضّ النظر عن المنطقة (تفاوت نص المنطقة وحده لا يُنشئ تكراراً)
 * ← تشابه داخل نفس المنطقة، وإن لم يُثمر يُعاد البحث عبر كل المناطق (نص
 * المنطقة نفسه قد يختلف كتابةً بين ملف الستوك وملف الحركات) ← جديد.
 *
 * @returns {{status:'linked'|'exact'|'high'|'ask'|'new', key:string, warehouseId?:number|null, candidates?:Array}}
 */
function matchWarehouse(name, region, { linkByKey, existing }) {
  const nk = whKey(name);
  const key = warehouseLinkKey(name, region);
  if (!nk) return { status: 'new', key };

  const link = linkByKey.get(key);
  if (link) return { status: 'linked', key, warehouseId: link.warehouseId ?? null };

  const rk = regKey(region);
  const exact = existing.find(w => whKey(w.name) === nk && regKey(w.region) === rk);
  if (exact) return { status: 'exact', key, warehouseId: exact.id };

  const sameName = existing.filter(w => whKey(w.name) === nk);
  if (sameName.length === 1) return { status: 'exact', key, warehouseId: sameName[0].id };

  const sameRegionPool = rk ? existing.filter(w => regKey(w.region) === rk) : existing;
  let cands = scoreWarehouseCandidates(name, sameRegionPool);
  if (cands.length === 0 && rk) cands = scoreWarehouseCandidates(name, existing);
  if (cands.length === 1) return { status: 'high', key, warehouseId: cands[0].id, candidates: cands };
  if (cands.length === 0) return { status: 'new', key };
  return { status: 'ask', key, candidates: cands };
}

/**
 * أسماء المذاخر التي تحتاج تأكيد المستخدم (حالة 'ask' فقط) لملف مُحلَّل بعد —
 * معاينة قبل الحفظ، لا تُنشئ ولا تلمس قاعدة البيانات.
 */
export async function classifyWarehouseRows(rows, userId) {
  const rowsWithName = (rows || []).filter(r => String(r?.warehouse ?? '').trim());
  if (!rowsWithName.length) return { pending: [] };

  const [links, existing] = await Promise.all([
    prisma.warehouseNameLink.findMany({ where: { userId }, select: { fromKey: true, warehouseId: true } }),
    repo.getWarehouses(userId),
  ]);
  const linkByKey = new Map(links.map(l => [l.fromKey, l]));

  const groups = new Map();
  for (const r of rowsWithName) {
    const key = warehouseLinkKey(r.warehouse, r.region);
    if (!groups.has(key)) groups.set(key, { key, raw: r.warehouse, region: r.region || null });
  }

  const pending = [];
  for (const g of groups.values()) {
    const m = matchWarehouse(g.raw, g.region, { linkByKey, existing });
    if (m.status === 'ask') {
      pending.push({
        key: g.key, raw: g.raw, region: g.region,
        suggestions: m.candidates.map(c => ({ id: c.id, name: c.name, region: c.region, score: Math.round(c.score * 100) / 100 })),
      });
    }
  }
  return { pending: pending.sort((a, b) => a.raw.localeCompare(b.raw, 'ar')) };
}

/**
 * يحفظ قرارات المستخدم في مطابقة أسماء المذاخر — نفس فلسفة saveDoctorNameLinks.
 * warehouseId=null يعني «تأكَّد المستخدم أنه مذخر مختلف فعلاً» فيُحفظ أيضاً كي
 * لا يتكرّر السؤال، وسيُنشأ مذخر جديد دائماً لهذا الاسم+المنطقة لاحقاً.
 */
export async function saveWarehouseNameLinks(userId, links) {
  let saved = 0;
  for (const l of (Array.isArray(links) ? links : [])) {
    const fromName = String(l?.fromName ?? '').trim();
    if (!fromName || !whKey(fromName)) continue;
    const fromKey = warehouseLinkKey(fromName, l?.region);
    const warehouseId = Number.isInteger(l?.warehouseId) ? l.warehouseId : null;
    await prisma.warehouseNameLink.upsert({
      where: { userId_fromKey: { userId, fromKey } },
      update: { fromName, region: l?.region || null, warehouseId },
      create: { userId, fromKey, fromName, region: l?.region || null, warehouseId, confidence: 'confirmed' },
    }).catch(() => {}); // تذكّر القرار رفاهية — لا يُفشل الاستيعاب
    saved++;
  }
  return { saved };
}

/**
 * قاموس مذاخر قابل للتوسع أثناء الاستيراد.
 * المطابقة (matchWarehouse): رابط محفوظ ← تطابق تام ← اسم تام ووحيد بغضّ النظر
 * عن المنطقة ← تشابه (داخل نفس المنطقة ثم عبر كل المناطق) ← إنشاء جديد.
 * الصفوف غير المطابقة لا تُسقط أبداً: يُنشأ لها مذخر وتُبلَّغ للمراجعة — هذا
 * هو مسار الأمان حين يُستدعى ingestRows مباشرة بلا مرور بنافذة التأكيد
 * (classifyWarehouseRows + saveWarehouseNameLinks) أولاً؛ أي رابط يُحفظ هناك
 * يُحمَّل هنا تلقائياً (linkByKey) في الاستيعاب التالي فلا يتكرّر السؤال.
 */
function makeWarehouseResolver(existing, userId, links = []) {
  const linkByKey = new Map((links || []).map(l => [l.fromKey, l]));
  const idIndex = new Map(existing.map(w => [w.id, w]));
  const pool = [...existing]; // يكبر مع كل مذخر جديد يُنشأ ضمن نفس الاستيعاب
  const cache = new Map(); // warehouseLinkKey ← نتيجة (مرة واحدة لكل اسم+منطقة، لا لكل صف)
  const toCreate = [];
  const toHeal = new Map();    // warehouseId ← warehouse (منطقته صُحّحت، تحتاج تحديث بقاعدة البيانات)
  const fuzzyLinked = [];
  const created = [];

  /**
   * تصحيح ذاتي: مذخر موجود منطقته فاسدة (مجمّدة من استيراد قديم معطوب)، وهذا الصف
   * يحمل منطقة صريحة وسليمة لنفس المذخر — يُصحَّح فوراً بدل تجميد الخطأ للأبد.
   * لا يُصحَّح إن كانت المنطقة الحالية تبدو سليمة أصلاً (تفادي التذبذب بين صياغتين).
   */
  function maybeHeal(w, rawRegion) {
    if (!w.id) return; // مذخر معلّق لم يُنشأ بعد — سيُنشأ بمنطقته الصحيحة مباشرة
    const incoming = String(rawRegion ?? '').trim();
    if (!incoming || looksLikeBadRegion(incoming) || !looksLikeBadRegion(w.region)) return;
    w.region = incoming;
    w.regionKey = regKey(incoming);
    toHeal.set(w.id, w);
  }

  function resolve(name, region) {
    const nk = whKey(name);
    if (!nk) return null;
    const key = warehouseLinkKey(name, region);
    if (cache.has(key)) return cache.get(key);

    const m = matchWarehouse(name, region, { linkByKey, existing: pool });

    if (m.status !== 'ask' && m.status !== 'new' && m.warehouseId) {
      const w = idIndex.get(m.warehouseId);
      if (w) {
        if (m.status === 'high') {
          fuzzyLinked.push({
            raw: region ? name + ' (' + region + ')' : name,
            matchedTo: w.name + ' — ' + w.region,
          });
        }
        maybeHeal(w, region);
        cache.set(key, w);
        return w;
      }
      // status='linked' لكن warehouseId=null («تأكَّد أنه مختلف») → يسقط لإنشاء جديد أدناه
    }

    // مذخر جديد — يُنشأ ويُبلَّغ عنه للمراجعة مع أقرب الأسماء
    const pending = {
      id: null, userId, name: String(name).trim(), nameKey: nk,
      region: String(region ?? '').trim() || 'غير محدد', regionKey: regKey(region),
    };
    pool.push(pending);
    toCreate.push(pending);
    const suggestions = (m.candidates ?? []).slice(0, 3).map(c => ({ name: c.name, region: c.region, score: c.score }));
    created.push({ name: pending.name, region: pending.region, suggestions });
    cache.set(key, pending);
    return pending;
  }

  /** ينشئ المذاخر الجديدة في قاعدة البيانات، ويحفظ تصحيحات المنطقة الذاتية */
  async function flush() {
    for (const w of toCreate) {
      if (w.id) continue;
      const row = await prisma.stockWarehouse.upsert({
        where: { userId_regionKey_nameKey: { userId, regionKey: w.regionKey, nameKey: w.nameKey } },
        update: {},
        create: { userId, name: w.name, nameKey: w.nameKey, region: w.region, regionKey: w.regionKey },
      });
      w.id = row.id;
    }
    for (const w of toHeal.values()) {
      await prisma.stockWarehouse.update({
        where: { id: w.id },
        data: { region: w.region, regionKey: w.regionKey },
      });
    }
  }

  return { resolve, flush, report: () => ({ fuzzyLinked, created, healed: [...toHeal.values()].map(w => ({ name: w.name, region: w.region })) }) };
}

// ═══════════════════════════════════════════════════════════════
//  3. الاستيعاب (ingestion) — مسار موحّد لكل المصادر
// ═══════════════════════════════════════════════════════════════

/** سياق مطابقة الايتمات لمستخدم — كتالوج الشركة/الشركات + aliases (ItemMergeRule)،
 *  محمَّل مرة واحدة ومُعاد استعماله لكل صفوف الملف. مشترك بين ingestRows وclassifyItemNames. */
async function loadItemCtx(userId) {
  try {
    const assigns = await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
    return await loadResolutionContext({ scientificCompanyIds: assigns.map(a => a.companyId), userId });
  } catch { return { catalog: [], catalogById: new Map(), aliasMap: new Map() }; } // الكتالوج اختياري
}

/**
 * أسماء الايتمات التي تحتاج تأكيد المستخدم (ثقة medium — مرشّحون متعددون
 * ملتبسون) لملف مُحلَّل بعد. alias/exact/high تُطبَّق دائماً بصمت (لا تُعرض)،
 * وnone تُترك كايتم مؤقّت بصمت كما كانت (يدخل طابور مراجعة السوبر أدمن).
 */
export async function classifyItemNames(rows, userId, ctx = null) {
  const names = [...new Set((rows || []).map(r => String(r?.itemName ?? '').trim()).filter(Boolean))];
  if (!names.length) return { pending: [] };
  const itemCtx = ctx || await loadItemCtx(userId);
  if (!itemCtx.catalog.length) return { pending: [] }; // بلا كتالوج لا مطابقة ملتبسة أصلاً

  const pending = [];
  for (const raw of names) {
    const r = await resolveItemName(raw, itemCtx);
    if (r.confidence === 'medium') {
      pending.push({ key: normalizeItemKey(raw), raw, suggestions: r.suggestions.slice(0, 5) });
    }
  }
  return { pending: pending.sort((a, b) => a.raw.localeCompare(b.raw, 'ar')) };
}

/**
 * يحفظ قرارات المستخدم في مطابقة أسماء الايتمات — نفس آلية rememberItems في
 * insertManualSales (sales.service.js): قاعدة ItemMergeRule بنطاق الشركة
 * العلمية للايتم الهدف. لا تدعم «مؤكَّد أنه مختلف» (بعكس المذاخر/الشركات) —
 * قيد موجود مسبقاً في محرّك الايتمات المشترك بكل صفحات التطبيق، لا نضيفه هنا.
 */
export async function saveItemLinks(userId, links) {
  let saved = 0;
  for (const l of (Array.isArray(links) ? links : [])) {
    const toItemId = Number(l?.toItemId);
    const fromKey = normalizeItemKey(l?.fromName ?? '');
    if (!fromKey || !Number.isFinite(toItemId)) continue;
    const target = await prisma.item.findUnique({ where: { id: toItemId }, select: { id: true, name: true, scientificCompanyId: true } });
    if (!target?.scientificCompanyId) continue; // بلا شركة علمية لا نطاق للقاعدة
    if (normalizeItemKey(target.name) === fromKey) continue; // الاسمان متطابقان أصلاً
    await prisma.itemMergeRule.upsert({
      where: { scientificCompanyId_fromKey: { scientificCompanyId: target.scientificCompanyId, fromKey } },
      update: { fromName: String(l.fromName), toName: target.name, toItemId: target.id },
      create: { scientificCompanyId: target.scientificCompanyId, fromKey, fromName: String(l.fromName), toName: target.name, toItemId: target.id, userId },
    }).catch(() => {});
    saved++;
  }
  return { saved };
}

/** أسماء الشركات (Company — كتالوج المستخدم البسيط) التي تحتاج تأكيد المستخدم. */
export async function classifyCompanyNames(rows, userId) {
  const names = [...new Set((rows || []).map(r => r.companyName).filter(Boolean))];
  if (!names.length) return { pending: [] };
  const [links, companies] = await Promise.all([
    prisma.stockCompanyNameLink.findMany({ where: { userId }, select: { fromKey: true } }),
    getAllCompanies(userId),
  ]);
  const linkKeys = new Set(links.map(l => l.fromKey));

  const pending = [];
  for (const raw of names) {
    const key = normalizeItemKey(raw);
    if (linkKeys.has(key)) continue; // رابط محفوظ → بلا سؤال
    if (companies.some(c => normalizeItemKey(c.name) === key)) continue; // تطابق تام
    const cands = companies
      .filter(c => areSimilar(raw, c.name))
      .map(c => ({ id: c.id, name: c.name, score: similarity(key, normalizeItemKey(c.name)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (cands.length) pending.push({ key, raw, suggestions: cands });
  }
  return { pending: pending.sort((a, b) => a.raw.localeCompare(b.raw, 'ar')) };
}

/**
 * يحفظ قرارات المستخدم في مطابقة أسماء الشركات — نفس فلسفة saveWarehouseNameLinks.
 * companyId=null يعني «تأكَّد أنها شركة مختلفة فعلاً» فيُحفظ أيضاً كي لا يتكرّر السؤال.
 */
export async function saveStockCompanyNameLinks(userId, links) {
  let saved = 0;
  for (const l of (Array.isArray(links) ? links : [])) {
    const fromName = String(l?.fromName ?? '').trim();
    const fromKey = normalizeItemKey(fromName);
    if (!fromKey) continue;
    const companyId = Number.isInteger(l?.companyId) ? l.companyId : null;
    await prisma.stockCompanyNameLink.upsert({
      where: { userId_fromKey: { userId, fromKey } },
      update: { fromName, companyId },
      create: { userId, fromKey, fromName, companyId },
    }).catch(() => {});
    saved++;
  }
  return { saved };
}

// ─── ميركاتو: احتساب الطلبيات كمبيع حسب حالتها + منع تكرار الاحتساب ───────────
// ملف ميركاتو (طلبيات مذاخر عامة) يحمل حالة الطلبية وحالة كل مادة فيها، ويُعاد
// رفعه بمرور الوقت مع تحدّث الحالات. سطر (طلبية+صيدلية+مادة) يُحتسب مبيعاً مرة
// واحدة فقط، نهائياً — راجع StockOrderLine (وجود السطر = احتُسب سلفاً).
const MERCATO_SALE_STATUSES = new Set(['جاهزة للتسليم', 'تم التوصيل']);
const MERCATO_EXCLUDED_ITEM_STATUSES = new Set(['نعتذر عن التجهيز', 'المادة غير متوفرة']);
// «تغيرت الكمية» ليست هنا عمداً — تُحتسب مبيعاً بالكمية كما وردت (قرار المستخدم).

/**
 * يصفّي صفوف ميركاتو (تحمل orderNumber) حسب حالتها وسجل الاحتساب السابق —
 * قراءة فقط، لا تكتب شيئاً. صفوف بلا orderNumber (ملفات عادية) تمرّ بلا أي
 * تأثير. تُستدعى بشكل مستقل في classifyMovementRows (معاينة) وingestRows
 * (تنفيذ فعلي ذاتي الحماية بصرف النظر عن نقطة الدخول).
 */
async function filterMercatoRows(rows, userId) {
  const mercatoRows = (rows || []).filter(r => r?.orderNumber);
  if (!mercatoRows.length) return { eligible: rows, skippedAlready: 0, skippedNotReady: 0 };

  const keyOf = (r) => ({
    orderNumber: String(r.orderNumber).trim(),
    pharmacyKey: normalizeItemKey(r.pharmacyName || ''),
    itemKey: normalizeItemKey(r.itemName),
  });

  const orderNumbers = [...new Set(mercatoRows.map(r => keyOf(r).orderNumber))];
  const existing = await prisma.stockOrderLine.findMany({
    where: { userId, orderNumber: { in: orderNumbers } },
    select: { orderNumber: true, pharmacyKey: true, itemKey: true },
  });
  const countedSet = new Set(existing.map(e => `${e.orderNumber}|${e.pharmacyKey}|${e.itemKey}`));

  const eligible = [];
  let skippedAlready = 0, skippedNotReady = 0;
  for (const r of rows) {
    if (!r?.orderNumber) { eligible.push(r); continue; }
    const k = keyOf(r);
    if (countedSet.has(`${k.orderNumber}|${k.pharmacyKey}|${k.itemKey}`)) { skippedAlready++; continue; }
    const orderOk = MERCATO_SALE_STATUSES.has(String(r.orderStatus ?? '').trim());
    const itemOk = !MERCATO_EXCLUDED_ITEM_STATUSES.has(String(r.itemStatus ?? '').trim());
    if (!orderOk || !itemOk) { skippedNotReady++; continue; } // لم يكتمل تجهيزها بعد — تُعاد المحاولة في رفعة لاحقة
    eligible.push(r);
  }
  return { eligible, skippedAlready, skippedNotReady };
}

/**
 * يصنّف صفوف ملف مُحلَّل عبر المحاور الثلاثة معاً (مذاخر/ايتمات/شركات) — معاينة
 * قبل الحفظ لواجهة الرفع على مرحلتين (استخراج ← تأكيد المشكوك فيه ← حفظ).
 * صفوف ميركاتو غير المؤهَّلة (مُحتسبة سابقاً أو لم يكتمل تجهيزها) تُستبعد أولاً
 * فلا يُسأل المستخدم عن أسماء تخصّها.
 */
export async function classifyMovementRows({ rows, userId }) {
  const mercato = await filterMercatoRows(rows, userId);
  const eligibleRows = mercato.eligible;
  const itemCtx = await loadItemCtx(userId);
  const [warehouses, items, companies] = await Promise.all([
    classifyWarehouseRows(eligibleRows, userId),
    classifyItemNames(eligibleRows, userId, itemCtx),
    classifyCompanyNames(eligibleRows, userId),
  ]);
  return {
    pending: { warehouses: warehouses.pending, items: items.pending, companies: companies.pending },
    mercato: { skippedAlready: mercato.skippedAlready, skippedNotReady: mercato.skippedNotReady },
  };
}

/**
 * @param {object}   p
 * @param {number}   p.userId
 * @param {'baseline'|'in'|'out'} p.kind
 * @param {string}   p.name          اسم الدفعة
 * @param {Date}     p.movementDate  تاريخ سريان الدفعة
 * @param {number?}  p.sourceFileId  SalesDataFile المصدر (للستوك الافتتاحي)
 * @param {Array}    p.rows          {warehouse, region, itemName, companyName, qty, movementDate?, rawRow?}
 */
export async function ingestRows({ userId, kind, name, movementDate, sourceFileId = null, rows }) {
  const direction = DIRECTIONS[kind];
  if (!direction) throw new Error('نوع الدفعة غير صالح');
  if (!rows.length) throw new Error('لا توجد صفوف صالحة في الملف');

  // ميركاتو: تصفية ذاتية الحماية بصرف النظر عن نقطة الدخول — صفوف مُحتسبة
  // سابقاً أو غير جاهزة (حالة الطلبية/المادة) تُستبعد دائماً هنا، حتى لو
  // استُدعيت هذه الدالة مباشرة بلا مرور بـclassifyMovementRows أولاً.
  const mercato = await filterMercatoRows(rows, userId);
  rows = mercato.eligible;
  if (!rows.length) {
    // وضع طبيعي متوقَّع (إعادة رفع نفس الملف للتحقق من التحديثات) — لا خطأ
    return {
      batchId: null, rowCount: 0, warehouseCount: 0, unmatched: null,
      mercato: { skippedAlready: mercato.skippedAlready, skippedNotReady: mercato.skippedNotReady, countedNow: 0 },
    };
  }

  // المذاخر: تُحمَّل مذاخر المستخدم + روابط أسمائه المحفوظة (WarehouseNameLink) —
  // أي قرار حفظه المستخدم عبر نافذة التأكيد (قُبيل هذا النداء مباشرة في نفس
  // الطلب، أو في استيراد سابق) يُطبَّق هنا بصمت.
  const [existing, warehouseLinks] = await Promise.all([
    repo.getWarehouses(userId),
    prisma.warehouseNameLink.findMany({ where: { userId }, select: { fromKey: true, warehouseId: true } }),
  ]);
  const wh = makeWarehouseResolver(existing, userId, warehouseLinks);

  // ربط الايتمات بكتالوج الشركة — نفس محرّك ملفات المبيعات، فتلتقي أسماء الستوك
  // وأسماء المبيعات على نفس Item.id.
  const ctx = await loadItemCtx(userId);

  // الشركة: نص حر بلا FK — لكن تُحوَّل إلى الاسم القانوني لشركة Company المستخدم
  // متى وُجد رابط محفوظ أو تطابق تام، فلا يُخزَّن نفس المُصنِّع بتهجئتين مختلفتين.
  let companyCtx = { linkByKey: new Map(), companies: [] };
  try {
    const [companyLinks, companies] = await Promise.all([
      prisma.stockCompanyNameLink.findMany({ where: { userId }, select: { fromKey: true, companyId: true } }),
      getAllCompanies(userId),
    ]);
    companyCtx = { linkByKey: new Map(companyLinks.map(l => [l.fromKey, l.companyId])), companies };
  } catch { /* اختياري — لا يمنع الاستيراد */ }
  function resolveCompanyLabel(raw) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;
    const key = normalizeItemKey(trimmed);
    if (companyCtx.linkByKey.has(key)) {
      const id = companyCtx.linkByKey.get(key);
      const c = id ? companyCtx.companies.find(x => x.id === id) : null;
      return c ? c.name : trimmed; // id=null («مؤكَّد مختلفة») → يبقى كما ورد
    }
    const exact = companyCtx.companies.find(c => normalizeItemKey(c.name) === key);
    return exact ? exact.name : trimmed; // لا قرار ولا تطابق تام → كما ورد (لا تخمين هنا)
  }

  const itemLinkCache = new Map();
  async function linkItem(itemName) {
    const key = normalizeItemKey(itemName);
    if (itemLinkCache.has(key)) return itemLinkCache.get(key);
    let linked = { itemId: null, canonicalName: null };
    try {
      const r = await resolveItemName(itemName, ctx);
      if (r?.canonicalItem && ['alias', 'exact', 'high'].includes(r.confidence)) {
        linked = { itemId: r.canonicalItem.id, canonicalName: r.canonicalItem.name };
      }
    } catch { /* لا يمنع الاستيراد */ }
    itemLinkCache.set(key, linked);
    return linked;
  }

  const prepared = [];
  for (const r of rows) {
    const w = wh.resolve(r.warehouse, r.region);
    if (!w) continue;
    const linked = await linkItem(r.itemName);
    // ايتم مُطابَق (alias/exact/high) ⟵ itemKey/itemName من اسمه القانوني لا من
    // النص الخام المرفوع، وإلا فتهجئتان مختلفتان لنفس الايتم المُطابَق بنجاح لن
    // تندمجا في نفس صف الرصيد رغم نجاح الربط (كانت هذه الفجوة الفعلية للخلل).
    const canonicalName = linked.canonicalName ?? String(r.itemName).trim();
    prepared.push({
      w,
      itemKey: normalizeItemKey(canonicalName),
      itemName: canonicalName,
      companyName: resolveCompanyLabel(r.companyName),
      itemId: linked.itemId,
      qty: r.qty,
      movementDate: r.movementDate ?? movementDate,
      rawRow: r.rawRow ? JSON.stringify(r.rawRow) : null,
      // ميركاتو فقط — مفتاح StockOrderLine الخام (لا القانوني) لأنه هو ما فحصه
      // filterMercatoRows أعلاه؛ orderNumber=null لصفوف الملفات العادية.
      orderNumber: r.orderNumber || null,
      pharmacyName: r.pharmacyName || null,
      orderItemKey: r.orderNumber ? normalizeItemKey(r.itemName) : null,
    });
  }
  await wh.flush();

  const batch = await repo.createBatch({ userId, kind, name, sourceFileId, movementDate });
  const movements = prepared.map(p => ({
    batchId: batch.id, userId, warehouseId: p.w.id,
    itemKey: p.itemKey, itemName: p.itemName, companyName: p.companyName, itemId: p.itemId,
    qty: p.qty, direction, movementDate: p.movementDate, rawRow: p.rawRow,
  }));

  // صفوف ميركاتو تُدرج فرداً (لا createMany) لالتقاط id الحركة فوراً وربطه بثقة
  // تامة بـStockOrderLine — لا يمكن الاعتماد على ترتيب/تسلسل createMany لهذا.
  // بقية الصفوف (الغالبية عادةً) تُدرج بالجملة كالمعتاد.
  const mercatoIdx = new Set();
  prepared.forEach((p, i) => { if (p.orderNumber) mercatoIdx.add(i); });
  await repo.bulkInsertMovements(movements.filter((_, i) => !mercatoIdx.has(i)));
  for (const i of mercatoIdx) {
    const p = prepared[i];
    const created = await prisma.stockMovement.create({ data: movements[i] });
    const pharmacyKey = normalizeItemKey(p.pharmacyName || '');
    await prisma.stockOrderLine.upsert({
      where: { userId_orderNumber_pharmacyKey_itemKey: { userId, orderNumber: p.orderNumber, pharmacyKey, itemKey: p.orderItemKey } },
      update: {},
      create: { userId, orderNumber: p.orderNumber, pharmacyKey, pharmacyName: p.pharmacyName || '', itemKey: p.orderItemKey, qty: p.qty, movementId: created.id },
    }).catch(() => {});
  }

  const warehouseIds = [...new Set(movements.map(m => m.warehouseId))];
  await recomputeBalances(userId, warehouseIds);

  // تقرير المراجعة: مذاخر جديدة، مذاخر رُبطت بالتشابه، وايتمات تحرّكت بلا ستوك افتتاحي
  const unmatched = { ...wh.report(), itemsWithoutBaseline: [] };
  if (direction !== 'baseline' && warehouseIds.length) {
    const orphans = await prisma.stockBalance.findMany({
      where: { userId, warehouseId: { in: warehouseIds }, openingAt: null },
      select: { itemName: true, outQty: true, warehouse: { select: { name: true, region: true } } },
      take: 200,
    });
    unmatched.itemsWithoutBaseline = orphans.map(o => ({
      itemName: o.itemName, warehouse: o.warehouse.name, region: o.warehouse.region, qty: o.outQty,
    }));
  }
  const hasIssues = unmatched.created.length || unmatched.fuzzyLinked.length || unmatched.itemsWithoutBaseline.length || unmatched.healed.length;
  await repo.finalizeBatch(batch.id, { rowCount: movements.length, unmatched: hasIssues ? unmatched : null });

  return {
    batchId: batch.id,
    rowCount: movements.length,
    warehouseCount: warehouseIds.length,
    unmatched: hasIssues ? unmatched : null,
    mercato: { skippedAlready: mercato.skippedAlready, skippedNotReady: mercato.skippedNotReady, countedNow: mercatoIdx.size },
  };
}

/** يقرأ صفوف ملف Stock (بلا حفظ) — أساس classify/ingest للستوك الافتتاحي من ملف موجود. */
async function readStockFileRows(userId, salesDataFileId) {
  const file = await prisma.salesDataFile.findFirst({ where: { id: salesDataFileId, userId } });
  if (!file) throw new Error('الملف غير موجود');
  const rows = flattenStockMatrix(file);
  if (!rows.length) throw new Error('لم يُعثر على كميات في هذا الملف');
  return { file, rows };
}

/** معاينة تطابق الستوك الافتتاحي من ملف Stock موجود — قبل الحفظ، بلا لمس قاعدة البيانات. */
export async function classifyBaselineFromStockFile({ userId, salesDataFileId }) {
  const { rows } = await readStockFileRows(userId, salesDataFileId);
  return classifyMovementRows({ rows, userId });
}

/** استيراد الستوك الافتتاحي من ملف Stock موجود (SalesDataFile) */
export async function ingestBaselineFromStockFile({ userId, salesDataFileId, movementDate }) {
  const { file, rows } = await readStockFileRows(userId, salesDataFileId);
  return ingestRows({
    userId, kind: 'baseline',
    name: 'ستوك افتتاحي: ' + file.name,
    movementDate, sourceFileId: file.id, rows,
  });
}

// ═══════════════════════════════════════════════════════════════
//  4. إعادة حساب الأرصدة — قلب الميزة
// ═══════════════════════════════════════════════════════════════

const pairId = (warehouseId, itemKey) => warehouseId + String.fromCharCode(0) + itemKey;

/**
 * يعيد بناء StockBalance من الصفر لنطاق المذاخر المحدد (أو كل مذاخر المستخدم).
 *
 * لكل زوج (مذخر + ايتم):
 *   opening/openingAt = أحدث حركة baseline (بالتاريخ ثم بالـ id عند التساوي)
 *   inQty / outQty    = مجموع الحركات من openingAt فصاعداً (أو الكل إن لا افتتاحي)
 *   remaining         = opening + inQty − outQty
 *
 * هذا يحقق «التصفير الجزئي»: ستوك جديد لزوج ⟵ يصير هو الافتتاحي وتُهمل الحركات
 * الأقدم منه؛ والأزواج غير الواردة في الملف الجديد لا تتأثر لأن آخر baseline لها
 * لم يتغيّر.
 */
export function computeBalanceRows(userId, baselineRows, flowRows) {
  const base = new Map();
  for (const m of baselineRows) {
    const k = pairId(m.warehouseId, m.itemKey);
    const prev = base.get(k);
    const newer = !prev
      || m.movementDate > prev.openingAt
      || (+m.movementDate === +prev.openingAt && m.id > prev.sortId);
    if (newer) {
      base.set(k, {
        warehouseId: m.warehouseId, itemKey: m.itemKey, itemName: m.itemName,
        companyName: m.companyName, itemId: m.itemId,
        opening: m.qty, openingAt: m.movementDate, sortId: m.id,
      });
    }
  }

  const agg = new Map();
  for (const m of flowRows) {
    const k = pairId(m.warehouseId, m.itemKey);
    const b = base.get(k);
    if (b && m.movementDate < b.openingAt) continue; // أقدم من الافتتاحي ⟵ يُهمل
    let a = agg.get(k);
    if (!a) {
      a = {
        warehouseId: m.warehouseId, itemKey: m.itemKey, itemName: m.itemName,
        companyName: m.companyName, itemId: m.itemId,
        inQty: 0, outQty: 0, lastMovementAt: m.movementDate,
      };
      agg.set(k, a);
    }
    if (m.direction === 'in') a.inQty += m.qty; else a.outQty += m.qty;
    if (m.movementDate > a.lastMovementAt) a.lastMovementAt = m.movementDate;
  }

  const rows = [];
  for (const k of new Set([...base.keys(), ...agg.keys()])) {
    const b = base.get(k);
    const a = agg.get(k);
    const src = b ?? a;
    const opening = b?.opening ?? 0;
    const inQty = a?.inQty ?? 0;
    const outQty = a?.outQty ?? 0;
    rows.push({
      userId,
      warehouseId: src.warehouseId,
      itemKey: src.itemKey,
      // الاسم/الشركة من الافتتاحي أولاً (أدق)، وإلا من الحركة
      itemName: b?.itemName ?? a?.itemName ?? src.itemKey,
      companyName: b?.companyName ?? a?.companyName ?? null,
      itemId: b?.itemId ?? a?.itemId ?? null,
      opening,
      openingAt: b?.openingAt ?? null,
      inQty,
      outQty,
      remaining: opening + inQty - outQty,
      lastMovementAt: a?.lastMovementAt ?? b?.openingAt ?? null,
    });
  }
  return rows;
}

/** يقرأ حركات النطاق على دفعات (حدّ للذاكرة) ثم يستدعي الحساب النقي */
export async function recomputeBalances(userId, warehouseIds = null) {
  const scope = { userId, ...(warehouseIds?.length ? { warehouseId: { in: warehouseIds } } : {}) };
  const CHUNK = 5000;
  const SELECT = {
    id: true, warehouseId: true, itemKey: true, itemName: true,
    companyName: true, itemId: true, qty: true, movementDate: true, direction: true,
  };

  const scanAll = async (where) => {
    const out = [];
    let cursor = 0;
    for (;;) {
      const page = await prisma.stockMovement.findMany({
        where, select: SELECT, orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: CHUNK,
      });
      if (!page.length) break;
      out.push(...page);
      cursor = page[page.length - 1].id;
      if (page.length < CHUNK) break;
    }
    return out;
  };

  const [baselineRows, flowRows] = await Promise.all([
    scanAll({ ...scope, direction: 'baseline' }),
    scanAll({ ...scope, direction: { in: ['in', 'out'] } }),
  ]);

  const rows = computeBalanceRows(userId, baselineRows, flowRows);

  // استبدال ذرّي: حذف النطاق ثم إعادة الإدراج — الأرصدة مُشتقة بالكامل
  const ops = [prisma.stockBalance.deleteMany({ where: scope })];
  for (let i = 0; i < rows.length; i += 2000) {
    ops.push(prisma.stockBalance.createMany({ data: rows.slice(i, i + 2000) }));
  }
  await prisma.$transaction(ops);
  return rows.length;
}

// ═══════════════════════════════════════════════════════════════
//  5. التنبيهات
// ═══════════════════════════════════════════════════════════════

/**
 * نفس تسمية الشدة المستعملة في «رادار النقص» بصفحة Stock.
 * التنبيه يُطلق بالنسبة من الستوك الأصلي أو بالكمية الثابتة — أيهما تحقق أولاً.
 */
export function severityOf(remaining, opening, { pct, qty }) {
  if (remaining <= 0) return 'out';
  if (remaining <= qty / 2) return 'critical';
  if (remaining <= qty) return 'low';
  if (opening > 0 && remaining <= opening * (pct / 100)) return 'low';
  return null;
}

const SEV_ORDER = { out: 0, critical: 1, low: 2 };

/** الايتمات التي يجب عمل طلبية جديدة لها، مجمّعة حسب المذخر */
export async function buildAlerts(userId, { pct = 20, qty = 10, region = null, warehouseId = null } = {}) {
  const balances = await prisma.stockBalance.findMany({
    where: {
      userId,
      ...(warehouseId ? { warehouseId } : {}),
      ...(region ? { warehouse: { region } } : {}),
    },
    include: { warehouse: { select: { id: true, name: true, region: true } } },
  });

  const byWarehouse = new Map();
  const totals = { out: 0, critical: 0, low: 0 };

  for (const b of balances) {
    const sev = severityOf(b.remaining, b.opening, { pct, qty });
    if (!sev) continue;
    totals[sev]++;
    if (!byWarehouse.has(b.warehouseId)) {
      byWarehouse.set(b.warehouseId, {
        warehouseId: b.warehouseId, warehouse: b.warehouse.name, region: b.warehouse.region,
        items: [], counts: { out: 0, critical: 0, low: 0 },
      });
    }
    const g = byWarehouse.get(b.warehouseId);
    g.counts[sev]++;
    g.items.push({
      itemKey: b.itemKey, itemName: b.itemName, companyName: b.companyName,
      opening: b.opening, inQty: b.inQty, outQty: b.outQty, remaining: b.remaining,
      // الكمية المقترحة للطلبية = ما استُهلك فعلاً منذ الستوك الافتتاحي
      suggestedQty: Math.max(0, Math.round(b.opening + b.inQty - b.remaining)),
      pctLeft: b.opening > 0 ? Math.round((b.remaining / b.opening) * 100) : 0,
      lastMovementAt: b.lastMovementAt,
      severity: sev,
    });
  }

  const groups = [...byWarehouse.values()];
  for (const g of groups) {
    g.items.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.remaining - b.remaining);
    g.total = g.items.length;
  }
  groups.sort((a, b) =>
    (b.counts.out - a.counts.out)
    || (b.counts.critical - a.counts.critical)
    || String(a.region).localeCompare(String(b.region), 'ar')
    || String(a.warehouse).localeCompare(String(b.warehouse), 'ar'));

  return {
    groups, totals,
    totalItems: totals.out + totals.critical + totals.low,
    thresholds: { pct, qty },
  };
}

/** حذف دفعة ثم إعادة حساب المذاخر التي كانت تخصّها */
export async function removeBatch(userId, batchId) {
  const batch = await repo.getBatchById(batchId, userId);
  if (!batch) throw new Error('الدفعة غير موجودة');
  const warehouseIds = await repo.getBatchWarehouseIds(batchId);
  await repo.deleteBatch(batchId, userId);
  await recomputeBalances(userId, warehouseIds);
  return { warehouseIds };
}
