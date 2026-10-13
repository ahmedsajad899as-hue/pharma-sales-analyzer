// ════════════════════════════════════════════════════════════════════════════
// province-teams.rules.js — قواعد فرق المحافظات (نقيّة: بلا قاعدة بيانات).
//
// الفكرة التي تحرسها هذه القواعد: **كل مبيع في المحافظة يُنسب لمندوب واحد على
// الأكثر**. هكذا يساوي مجموعُ المندوبين إجماليَّ المحافظة حرفياً، ولا يُحتسب
// المبيع الواحد مرتين حين يعمل مندوبان لنفس الشركة في نفس المحافظة.
//
//   • التعيين = (فريق محافظة × مندوب × شركة) + ايتمات (أو «كل ايتمات الشركة»).
//   • المندوب المشترك بين شركتين = تعيينان؛ لا تقاطع بينهما لأن الايتم ينتمي
//     لشركة واحدة.
//   • مندوبان لنفس الشركة في نفس المحافظة ⇒ يتقاسمان الايتمات بلا تقاطع، وإلا
//     رُفض الحفظ بتعارض واضح (لا ترجيح صامت).
//   • ايتم الشركة غير المعيَّن لأحد يذهب لسلّة «غير منسوب» ظاهرة — لا يُسقط.
//
// اختباره: npm run test:province-teams
// ════════════════════════════════════════════════════════════════════════════

/**
 * يحسم ايتمات تعيين واحد.
 * @param {{allItems:boolean, companyId:number, itemIds:number[]}} a
 * @param {Map<number, number[]>} companyItems شركة ← ايتمات الكتالوج
 * @returns {number[]}
 */
export function resolveAssignmentItemIds(a, companyItems) {
  if (a.allItems) return [...(companyItems.get(a.companyId) ?? [])];
  return [...new Set((a.itemIds ?? []).map(Number).filter(Number.isInteger))];
}

/**
 * تعارضات تعيين مرشّح مع بقية تعيينات نفس الفريق.
 * التعارض يقع فقط داخل نفس الشركة: «كل الايتمات» يتعارض مع أي تعيين آخر لنفس
 * الشركة، وغير ذلك يتعارض حيث تتقاطع الايتمات.
 *
 * @param {{id?:number|null, repUserId:number, companyId:number, allItems:boolean, itemIds:number[]}} candidate
 * @param {Array<{id:number, repUserId:number, repName?:string, companyId:number, allItems:boolean, itemIds:number[]}>} others
 * @returns {Array<{assignmentId:number, repUserId:number, repName:string|null, kind:'all'|'items', itemIds:number[]}>}
 */
export function findItemConflicts(candidate, others) {
  const conflicts = [];
  const mine = new Set((candidate.itemIds ?? []).map(Number));
  for (const o of others) {
    if (candidate.id != null && o.id === candidate.id) continue;
    if (o.companyId !== candidate.companyId) continue;
    // نفس المندوب ونفس الشركة = نفس التعيين (القيد الفريد يمنع صفّين)، فلا تعارض.
    if (o.repUserId === candidate.repUserId) continue;
    if (candidate.allItems || o.allItems) {
      conflicts.push({ assignmentId: o.id, repUserId: o.repUserId, repName: o.repName ?? null, kind: 'all', itemIds: [] });
      continue;
    }
    const shared = (o.itemIds ?? []).map(Number).filter(id => mine.has(id));
    if (shared.length) {
      conflicts.push({ assignmentId: o.id, repUserId: o.repUserId, repName: o.repName ?? null, kind: 'items', itemIds: shared });
    }
  }
  return conflicts;
}

/**
 * خريطة النسب داخل فريق: ايتم ← تعيين. مع القواعد أعلاه لا يتكرّر ايتم، لكن لو
 * وُجد تقاطع قديم (بيانات سبقت الحارس) يفوز الأقدم إنشاءً (أصغر id) — حتمي،
 * ويُبلَّغ عنه في `overlaps` كي لا يبقى خفياً.
 *
 * @param {Array<{id:number, companyId:number, allItems:boolean, itemIds:number[]}>} assignments
 * @param {Map<number, number[]>} companyItems
 */
export function buildItemAttribution(assignments, companyItems) {
  const owner = new Map();       // itemId → assignmentId
  const overlaps = [];
  const sorted = [...assignments].sort((a, b) => a.id - b.id);
  for (const a of sorted) {
    for (const itemId of resolveAssignmentItemIds(a, companyItems)) {
      if (owner.has(itemId)) { overlaps.push({ itemId, keptAssignmentId: owner.get(itemId), droppedAssignmentId: a.id }); continue; }
      owner.set(itemId, a.id);
    }
  }
  return { owner, overlaps };
}

// ─── تصنيف وجهة البيع: مذخر أم صيدلية ─────────────────────────────────────────

const normAr = (s) => String(s ?? '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[ً-ٰٟـ]/g, '')
  .replace(/\s+/g, ' ').trim();

// اسم زبون يبدأ بـ«مذخر/مذاخر/المذخر» — هكذا تكتب ملفات المكتب بيعها للمذاخر
// («مذخر الناقوس»). البداية فقط لا الاحتواء: «صيدلية قرب المذخر» صيدلية.
const WAREHOUSE_NAME_RE = /^(ال)?(مذخر|مذاخر)(\s|$)/;

/**
 * @param {boolean} rawSaysWarehouse ناتج isWarehouseSaleRow (عمود تصنيف صريح)
 * @param {string}  customerName     اسم الزبون كما ورد
 * @returns {'warehouse'|'pharmacy'}
 */
export function classifyChannel(rawSaysWarehouse, customerName) {
  if (rawSaysWarehouse) return 'warehouse';
  return WAREHOUSE_NAME_RE.test(normAr(customerName)) ? 'warehouse' : 'pharmacy';
}

// ─── قيمة الجهد الشخصي ───────────────────────────────────────────────────────

/**
 * السعر الافتراضي حسب مصدر البضاعة: البيع من المذخر بسعر المذخر، ومن المكتب
 * بسعر المكتب — ثم الآخر بديلاً كي لا تبقى القيمة صفراً. سعر يكتبه المستخدم
 * يُقدَّم دائماً. البونص مجاني فلا يدخل القيمة.
 */
export function personalSaleValue({ channel, quantity, unitPrice = null }, item = null) {
  const qty = Number(quantity) || 0;
  let price = unitPrice != null && unitPrice !== '' ? Number(unitPrice) : null;
  if ((price == null || !Number.isFinite(price)) && item) {
    price = channel === 'office'
      ? (item.price ?? item.warehousePrice ?? null)
      : (item.warehousePrice ?? item.price ?? null);
  }
  if (price == null || !Number.isFinite(price)) return { unitPrice: null, totalValue: 0 };
  return { unitPrice: price, totalValue: +(qty * price).toFixed(2) };
}

/** قيمة بالدولار — نفس اصطلاح saleValueUSD في التقارير (القيم تُطبَّع للدولار). */
export function toUSD(value, currency, rate) {
  const v = Number(value) || 0;
  return currency === 'USD' ? v : v / (Number(rate) || 1470);
}
