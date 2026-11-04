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
//   • الاستثناء: مندوب المقعد يأخذ ايتمات مديره كاملة ولو شاركه فيها مدير آخر، ويُنسب
//     المبيع المشترك لمندوب واحد في buildItemAttribution.
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
 * خريطة النسب داخل فريق: ايتم ← تعيين. الايتم المشترك بين مقعدين يُنسب لمندوب شركة
 * الايتم (شركته الرئيسية هي شركة التعيين)، ثم للأقدم إنشاءً (أصغر id) — حتمي،
 * ويُبلَّغ عنه في `overlaps` كي لا يبقى خفياً.
 *
 * @param {Array<{id:number, companyId:number, allItems:boolean, itemIds:number[], isRepPrimaryCompany?:boolean}>} assignments
 * @param {Map<number, number[]>} companyItems
 */
export function buildItemAttribution(assignments, companyItems) {
  const owner = new Map();       // itemId → assignmentId
  const overlaps = [];
  const sorted = [...assignments].sort((a, b) => Number(Boolean(b.isRepPrimaryCompany)) - Number(Boolean(a.isRepPrimaryCompany)) || a.id - b.id);
  for (const a of sorted) {
    for (const itemId of resolveAssignmentItemIds(a, companyItems)) {
      if (owner.has(itemId)) { overlaps.push({ itemId, keptAssignmentId: owner.get(itemId), droppedAssignmentId: a.id }); continue; }
      owner.set(itemId, a.id);
    }
  }
  return { owner, overlaps };
}

// ─── مقاعد الفريق: مقعد لكل مدير شركة ─────────────────────────────────────────
// «الشركة» هنا = فريق مديرها: ايتماته المسندة له (UserItemAssignment)، لا كل ايتمات
// ScientificCompany. مدير بلا ايتمات مسندة = كل ايتمات شركته الرئيسية.

/**
 * هل يشغل هذا التعيين مقعد المدير؟ «كل الايتمات» يخص الشركة الرئيسية للمقعد فقط:
 * تعيين deva بكل ايتماتها لا يملأ مقعد humanis لمجرد أن مديره مسند على ايتمات من deva.
 * @param {{companyId:number, allItems:boolean, itemIds:number[]}} a
 * @param {{companyId:number, items:{id:number}[]}} seat
 */
export function assignmentFillsSeat(a, seat) {
  if (a.allItems || !seat.items.length) return a.companyId === seat.companyId;
  const mine = new Set(seat.items.map(i => i.id));
  return (a.itemIds ?? []).some(id => mine.has(id));
}

/**
 * مقاعد المندوب. ايتم مشترك بين مديرين يجعل تعيينه يطابق مقعديهما، فمديره يحسم مقعده:
 * من يتبع مدير مقعد يطابقه يشغل مقعد ذلك المدير فقط، ومن لا يتبع أحدهم يشغل كل ما يطابقه.
 * @param {Array<{companyId:number, allItems:boolean, itemIds:number[]}>} assignments تعيينات المندوب في الفريق
 * @param {number[]} managerIds مدراء المندوب
 * @param {Array<{userId:number, companyId:number, items:{id:number}[]}>} seats مقاعد المكتب
 * @returns {number[]} معرّفات مدراء المقاعد
 */
export function repSeatIds(assignments, managerIds, seats) {
  const matching = seats.filter(s => assignments.some(a => assignmentFillsSeat(a, s)));
  const own = matching.filter(s => managerIds.includes(s.userId));
  return (own.length ? own : matching).map(s => s.userId);
}

/** المحافظات التي خرج منها الحساب بهذا الحفظ. غير المذكورة في الحالتين لا تُمَسّ (تعيين يدوي في الهيكلية). */
export function removedProvinceIds(before, after) {
  const kept = new Set(after);
  return [...new Set(before)].filter(id => !kept.has(id));
}

/**
 * روابط التبعية التي أنشأها فريق المحافظة بين مسوق وعلمي، وتُحذف مع خروج المسوق منه.
 * مسوق تحت قائد مسوق يبقى: تلك تبعية فريق المسوقين نفسه.
 * @param {{repUserId:number, repIsMarketer:boolean, leaderUserId:number|null, leaderIsMarketer:boolean}[]} rows
 * @returns {{userId:number, managerId:number}[]}
 */
export function marketerTeamLinksToDrop(rows) {
  const links = new Map();
  for (const r of rows) {
    if (r.leaderUserId == null || r.repIsMarketer === r.leaderIsMarketer) continue;
    links.set(`${r.repUserId}|${r.leaderUserId}`, { userId: r.repUserId, managerId: r.leaderUserId });
  }
  return [...links.values()];
}

/**
 * هل المندوب من فريق مدير الشركة في عرض المحافظات؟ مندوب فريق المحافظة يحسمه مقعده فقط،
 * فلا تكفي شركة ثانوية مسندة للمدير. وغيره بتبعيته للمدير أو بشركته الرئيسية.
 * @param {{assignments:Array, isSubordinate:boolean, primaryCompanyId:number|null, managerIds?:number[]}} rep
 * @param {{userId:number, companyId:number, items:{id:number}[]}} seat
 * @param {Array} seats مقاعد المكتب: مندوب يتبع مديراً آخر يطابقه مقعده لا يدخل فريق هذا المدير
 */
export function repBelongsToSeat({ assignments, isSubordinate, primaryCompanyId, managerIds = [] }, seat, seats = [seat]) {
  if (assignments.length) return repSeatIds(assignments, managerIds, seats).includes(seat.userId);
  return isSubordinate || primaryCompanyId === seat.companyId;
}

/**
 * تعيينات مندوب جديد في مقعد: ايتمات المدير كاملة مقسَّمة على شركاتها، ولو شاركه فيها
 * مندوب مقعد آخر (النسب في buildItemAttribution يبقي المبيع لمندوب واحد).
 *
 * @param {{companyId:number, items:{id:number, companyId:number|null}[]}} seat
 *   companyId=null: ايتم بلا شركة في هذا المكتب؛ يبقى في قائمة المندوب بلا تعيين فريق.
 * @returns {{assignments:Array, keptItemIds:number[]}}
 */
export function planSeatAssignments(seat) {
  const wanted = new Map();
  if (!seat.items.length) wanted.set(seat.companyId, { companyId: seat.companyId, allItems: true, itemIds: [] });
  for (const i of seat.items) {
    if (i.companyId == null) continue;
    if (!wanted.has(i.companyId)) wanted.set(i.companyId, { companyId: i.companyId, allItems: false, itemIds: [] });
    wanted.get(i.companyId).itemIds.push(i.id);
  }
  const assignments = [...wanted.values()];
  const noCompany = seat.items.filter(i => i.companyId == null).map(i => i.id);
  return { assignments, keptItemIds: [...assignments.flatMap(a => a.itemIds), ...noCompany] };
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
