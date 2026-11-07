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
 * خريطة النسب داخل فريق: ايتم ← تعيين. المعيار تعيين الايتم لا شركة المندوب (قرار صاحب
 * المشروع 2026-11-06، كما في بغداد): من عُيِّن له الايتم بالاسم يغلب تعيين «كل ايتمات الشركة»،
 * وبين اثنين عُيِّن لهما نفس الايتم فالأقدم إنشاءً (أصغر id) — حتمي، ويُبلَّغ عنه في
 * `overlaps` كي لا يبقى خفياً.
 *
 * @param {Array<{id:number, companyId:number, allItems:boolean, itemIds:number[]}>} assignments
 * @param {Map<number, number[]>} companyItems
 */
export function buildItemAttribution(assignments, companyItems) {
  const owner = new Map();       // itemId → assignmentId
  const overlaps = [];
  const sorted = [...assignments].sort((a, b) => Number(Boolean(a.allItems)) - Number(Boolean(b.allItems)) || a.id - b.id);
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
 * هل يشغل هذا التعيين مقعد المدير؟ الايتمات أولاً قبل اسم الشركة (قرار صاحب المشروع
 * 2026-11-07): تعيين يحمل ايتماً من ايتمات المدير يملأ مقعده أياً كانت شركة التعيين.
 * «كل ايتمات الشركة» بلا قائمة يملؤه إن كان بين ايتمات المدير ايتم من تلك الشركة —
 * كان قبلها يخص الشركة الرئيسية وحدها، فيختفي مبيع ايتمات المدير المسجّلة تحت deva.
 * المبيع نفسه يبقى مقيّداً بايتمات المدير (allowedFor في directory).
 * @param {{companyId:number, allItems:boolean, itemIds:number[]}} a
 * @param {{companyId:number, items:{id:number, companyId?:number|null}[]}} seat
 */
export function assignmentFillsSeat(a, seat) {
  if (!seat.items.length) return a.companyId === seat.companyId;
  const mine = new Set(seat.items.map(i => i.id));
  if ((a.itemIds ?? []).some(id => mine.has(id))) return true;
  return !!a.allItems && (a.companyId === seat.companyId || seat.items.some(i => i.companyId === a.companyId));
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

/**
 * اسم الشركة الواحدة التي تمثل تيم المندوب. ايتمات المدير موزعة على عدة شركات، فشركات
 * تعيينات المندوب لا تدل على تيمه. الترتيب: الشركة الرئيسية لمدير مقعده، ثم شركته الرئيسية،
 * ثم المقعد الأكثر تطابقاً مع ايتماته (مندوب المقعد يأخذ ايتمات مديره كاملة).
 * @param {Array<{companyId:number, companyName:string, allItems:boolean, itemIds:number[], isPrimary:boolean}>} assignments
 * @param {number[]} managerIds مدراء المندوب
 * @param {Array<{userId:number, companyId:number, companyName:string, items:{id:number}[]}>} seats مقاعد المكتب
 * @returns {string|null}
 */
export function repTeamCompany(assignments, managerIds, seats) {
  const seatIds = repSeatIds(assignments, managerIds, seats);
  const matching = seats.filter(s => seatIds.includes(s.userId));
  const primary = assignments.find(a => a.isPrimary);
  const own = matching.filter(s => managerIds.includes(s.userId));
  // المندوب المشترك يتبع أكثر من مدير مقعد: يُعرض بكل شركاته.
  if (own.length > 1) return own.map(s => s.companyName).join(' + ');
  if (own.length) return own[0].companyName;
  if (primary) return primary.companyName;
  const repItems = new Set(assignments.flatMap(a => a.itemIds ?? []));
  const overlap = (s) => s.items.filter(i => repItems.has(i.id)).length;
  const best = matching.reduce((top, s) => (!top || overlap(s) > overlap(top) ? s : top), null);
  return best?.companyName ?? assignments[0]?.companyName ?? null;
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

/** أدوار لا تصلح مديراً لأحد: المندوب لا يُدير حساباً آخر. */
export const REP_ONLY_ROLES = ['scientific_rep', 'commercial_rep'];
const LEADER_LEVEL_ROLES = ['team_leader', 'supervisor'];

/**
 * روابط مدراء مندوبي الفرق التي لا سند لها. مندوب مديراً لمندوب يُحذف، إلا قائد فريقه.
 * وقائد ليس قائد فريق المندوب للمراجعة فقط: قد يكون تيم ليدر شركته وضعه المكتب عمداً.
 * @param {Array<{repUserId:number, leaderUserId:number|null, managers:{id:number, role:string}[]}>} rows صف لكل تعيين
 * @returns {{drop:{userId:number, managerId:number}[], review:{userId:number, managerId:number}[]}}
 */
export function foreignManagerLinks(rows) {
  const leadersOf = new Map();
  for (const r of rows) {
    if (!leadersOf.has(r.repUserId)) leadersOf.set(r.repUserId, new Set());
    if (r.leaderUserId != null) leadersOf.get(r.repUserId).add(r.leaderUserId);
  }
  const drop = [];
  const review = [];
  const seen = new Set();
  for (const r of rows) {
    for (const m of r.managers) {
      const key = `${r.repUserId}|${m.id}`;
      if (seen.has(key) || leadersOf.get(r.repUserId).has(m.id)) continue;
      seen.add(key);
      if (REP_ONLY_ROLES.includes(m.role)) drop.push({ userId: r.repUserId, managerId: m.id });
      else if (LEADER_LEVEL_ROLES.includes(m.role)) review.push({ userId: r.repUserId, managerId: m.id });
    }
  }
  return { drop, review };
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
 * مندوبو فرق المحافظات الذين يشغلون مقعد هذا المدير — نفس حكم تبويب «مندوبين المحافظات»:
 * تُقرأ تعيينات المندوب داخل كل فريق على حدة. لا يشترط رابط تبعية مباشراً بالمدير.
 * @param {Array<{repUserId:number, teamId:number, companyId:number, allItems:boolean, itemIds:number[], managerIds:number[]}>} rows
 * @param {{userId:number}} seat
 * @param {Array} seats مقاعد المكتب
 * @returns {number[]}
 */
export function repUserIdsInSeat(rows, seat, seats) {
  const byRepTeam = new Map();
  for (const r of rows) {
    const k = `${r.repUserId}|${r.teamId}`;
    if (!byRepTeam.has(k)) byRepTeam.set(k, []);
    byRepTeam.get(k).push(r);
  }
  const out = new Set();
  for (const own of byRepTeam.values()) {
    if (repSeatIds(own, own[0].managerIds, seats).includes(seat.userId)) out.add(own[0].repUserId);
  }
  return [...out];
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

// ─── المندوب المشترك: مقاعد مدراء متعددة ──────────────────────────────────────
// حساب واحد يتبع التيم ليدر ومدراء الشركات المحددة له، وكل مدير يرى نصيبه منه.

/**
 * أي مقعد من مقاعد المندوب يملك الايتم؟ نفس قاعدة loadItemOwnerManagers (التحليل الشامل):
 * من شركةُ الايتم شركتُه الرئيسية، وإلا أصغر معرّف. مقعد بلا ايتمات مسندة يحمل كل شركته.
 * @param {number|null} itemId
 * @param {number|null} companyId شركة الايتم
 * @param {Array<{userId:number, companyId:number, items:{id:number}[]}>} seats مقاعد المندوب
 * @returns {number|null} معرّف مدير المقعد
 */
export function ownerSeatOfItem(itemId, companyId, seats) {
  if (itemId == null) return null;
  const holders = seats
    .filter(s => (s.items.length ? s.items.some(i => i.id === itemId) : s.companyId === companyId))
    .sort((a, b) => a.userId - b.userId);
  if (!holders.length) return null;
  return (holders.find(s => s.companyId === companyId) ?? holders[0]).userId;
}

/**
 * تعيينات مندوب يشغل مقعداً أو أكثر، موحَّدة لكل شركة. selected=null = كل ايتمات المدير.
 * مقعد بلا ايتمات مسندة بلا تضييق = كل الشركة (allItems)، و`catalog` ايتماته عند التضييق.
 *
 * @param {Array<{seat:{companyId:number, items:{id:number, companyId:number|null}[]}, selected:number[]|null, catalog?:{id:number, companyId:number|null}[]}>} chosen
 * @returns {{assignments:{companyId:number, allItems:boolean, itemIds:number[]}[], keptItemIds:number[], unknownItemIds:number[]}}
 *   keptItemIds = قائمة ايتمات الحساب: غير الفارغة قائمة بيضاء، فتشمل كل ما اختير؛ وفارغة إذا كان
 *   كل مقعد مأخوذاً بكل شركته، كي تصله ايتمات الشركة الجديدة مستقبلاً.
 */
export function planRepSeats(chosen) {
  const wanted = new Map();
  const companyRow = (companyId) => {
    if (!wanted.has(companyId)) wanted.set(companyId, { companyId, allItems: false, itemIds: new Set() });
    return wanted.get(companyId);
  };
  const kept = new Set();
  const unknown = [];
  let everySeatWhole = true;
  for (const { seat, selected, catalog = [] } of chosen) {
    const available = seat.items.length ? seat.items : catalog;
    if (!seat.items.length && selected == null) {
      companyRow(seat.companyId).allItems = true;
      for (const i of catalog) kept.add(i.id);
      continue;
    }
    everySeatWhole = false;
    const pick = selected == null ? null : new Set(selected.map(Number));
    if (pick) for (const id of pick) if (!available.some(i => i.id === id)) unknown.push(id);
    for (const i of available) {
      if (pick && !pick.has(i.id)) continue;
      kept.add(i.id);
      if (i.companyId != null) companyRow(i.companyId).itemIds.add(i.id);
    }
  }
  const assignments = [...wanted.values()]
    .filter(a => a.allItems || a.itemIds.size)
    .map(a => ({ companyId: a.companyId, allItems: a.allItems, itemIds: a.allItems ? [] : [...a.itemIds] }));
  return { assignments, keptItemIds: everySeatWhole ? [] : [...kept], unknownItemIds: unknown };
}

// ─── تقسيم مبيع المقعد بين مندوبيه ────────────────────────────────────────────

/** order: من أرسل الطلبية؛ item/area/customer: حامل الايتم أو المنطقة أو الزبون. */
export const SPLIT_MODES = ['order', 'item', 'area', 'customer'];
export const DEFAULT_SPLIT_MODE = 'order';

/** قائمة نصوص نظيفة بلا تكرار من إدخال حر. */
const cleanNames = (list) => [...new Set((Array.isArray(list) ? list : []).map(s => String(s ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))];

/**
 * يحوّل إدخال إعداد التقسيم إلى قيمة تُحفظ. الأسماء الفارغة وغير المعروفة من المندوبين تسقط.
 * @returns {{mode:string, scopes:Object<string,{areas:string[], customers:string[]}>}|null} null = وضع غير معروف
 */
export function normalizeSplitConfig(mode, scopes, repUserIds) {
  if (!SPLIT_MODES.includes(mode)) return null;
  const out = {};
  for (const id of repUserIds) {
    const s = scopes?.[id] ?? scopes?.[String(id)] ?? {};
    const areas = cleanNames(s.areas);
    const customers = cleanNames(s.customers);
    if (areas.length || customers.length) out[id] = { areas, customers };
  }
  return { mode, scopes: out };
}

/**
 * لمن يُحسب سطر مبيع داخل فريق المحافظة؟ كل سطر لمندوب واحد، فلا يتغيّر مجموع الفريق.
 * ما لا يطابقه أحد يبقى لمن أرسله. وحامل مطابق هو المرسل نفسه يُبقيه عنده.
 *
 * @param {{senderId:number|null, itemId:number|null, area?:string|null, customer?:string|null}} line
 * @param {{seatOfItem:(itemId:number|null)=>number|null,
 *   splits:Map<number,{mode:string, reps:Array<{repUserId:number, itemIds:Set<number>, areas:string[], customers:string[]}>}>,
 *   sameArea:(a:string,b:string)=>boolean, sameCustomer:(a:string,b:string)=>boolean}} plan
 * @returns {number|null} حساب المندوب
 */
export function attributeLine(line, plan) {
  const sender = line.senderId ?? null;
  const seatId = plan.seatOfItem(line.itemId);
  const split = seatId != null ? plan.splits.get(seatId) : null;
  if (!split || split.mode === DEFAULT_SPLIT_MODE) return sender;
  const holds = {
    item: (r) => r.itemIds.has(line.itemId),
    area: (r) => !!line.area && r.areas.some(a => plan.sameArea(a, line.area)),
    customer: (r) => !!line.customer && r.customers.some(c => plan.sameCustomer(c, line.customer)),
  }[split.mode];
  const holders = holds ? split.reps.filter(holds) : [];
  if (!holders.length) return sender;
  return holders.some(r => r.repUserId === sender) ? sender : holders[0].repUserId;
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
