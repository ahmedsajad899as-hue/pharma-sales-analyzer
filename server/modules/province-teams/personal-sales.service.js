// ════════════════════════════════════════════════════════════════════════════
// personal-sales.service.js — «الجهد الشخصي»: الحسبة الثانية لمندوب المحافظة.
//
// ما باعه المندوب بنفسه للصيدليات (من مذخر أو من المكتب). يُدخله المندوب من
// التطبيق أو البوت ← طابور «بانتظار الاعتماد» ← يعتمده تيم ليدر المحافظة (أو
// إدارة المكتب). وحده المعتمد يُحتسب.
//
// **لا يُكتب في جدول Sale أبداً** ولا يُجمع مع تغطية المحافظة: نفس الطلبية قد
// تصل لاحقاً في ملف المكتب، والجمع يعني تكراراً. هو مؤشّر جهد بجانب التغطية.
// ════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { buildMonthFilter } from '../../lib/salesMonths.js';
import { buildRepIndex, matchRepName } from '../../lib/repNameMatch.js';
import { canReviewTeam } from './province-teams.access.js';
import { personalSaleValue } from './province-teams.rules.js';

export const STATUSES = ['pending', 'approved', 'rejected'];
const CHANNELS = new Set(['warehouse', 'office']);
const MAX_ROWS_PER_SUBMIT = 60;
const MAX_PENDING_PER_REP = 300;

const userName = (u) => (u ? (u.displayName || u.username) : null);

// ─── النطاق ───────────────────────────────────────────────────────────────────

/** فرق يعتمدها المُشاهِد (يقودها، أو كل فرق مكتبه لإدارة المكتب). */
async function reviewableTeamIds(viewer) {
  if (viewer.mode === 'office' && viewer.officeId) {
    return (await prisma.provinceTeam.findMany({ where: { officeId: viewer.officeId }, select: { id: true } })).map(t => t.id);
  }
  return (await prisma.provinceTeam.findMany({ where: { leaderUserId: viewer.id }, select: { id: true } })).map(t => t.id);
}

/** شرط Prisma: صفوف الجهد الشخصي المرئية للمُشاهِد. */
async function personalScopeWhere(viewer) {
  const own = [{ repUserId: viewer.id }, { createdById: viewer.id }];
  if (viewer.mode === 'office' && viewer.officeId) return { OR: [{ officeId: viewer.officeId }, ...own] };
  const led = await reviewableTeamIds(viewer);
  const or = [...own];
  if (led.length) or.push({ teamId: { in: led } });
  if (viewer.mode === 'company' && viewer.companyIds.length && viewer.officeId) {
    or.push({ officeId: viewer.officeId, companyId: { in: viewer.companyIds } });
  }
  return { OR: or };
}

/** يعتمد هذا الصف: قائد فريقه، أو إدارة مكتبه (ومنها صفوف البوت بلا فريق بعد). */
function isReviewer(viewer, row) {
  if (row.team) return canReviewTeam(viewer, row.team);
  return viewer.mode === 'office' && row.officeId != null && row.officeId === viewer.officeId;
}

// ─── القراءة ──────────────────────────────────────────────────────────────────

export async function listPersonalSales(viewer, { month = null, status = null, teamId = null, repUserId = null } = {}) {
  const where = { AND: [await personalScopeWhere(viewer)] };
  if (status && STATUSES.includes(status)) where.AND.push({ status });
  if (teamId) where.AND.push({ teamId: Number(teamId) });
  if (repUserId) where.AND.push({ repUserId: Number(repUserId) });
  // «بانتظار الاعتماد» يُعرض كاملاً بلا قيد شهر: المعلَّق من الشهر الماضي ما زال ينتظر.
  if (month && status !== 'pending') where.AND.push(buildMonthFilter(month));

  const rows = await prisma.repPersonalSale.findMany({
    where,
    orderBy: [{ saleDate: 'desc' }, { id: 'desc' }],
    take: 1000,
    include: {
      rep:  { select: { id: true, displayName: true, username: true } },
      team: { select: { id: true, leaderUserId: true, officeId: true, province: { select: { name: true } } } },
    },
  });
  const companyIds = [...new Set(rows.map(r => r.companyId).filter(Boolean))];
  const companies = companyIds.length
    ? await prisma.scientificCompany.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
    : [];
  const companyName = new Map(companies.map(c => [c.id, c.name]));
  const reviewerIds = [...new Set(rows.map(r => r.reviewedById).filter(Boolean))];
  const reviewers = reviewerIds.length
    ? await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, displayName: true, username: true } })
    : [];
  const reviewerName = new Map(reviewers.map(u => [u.id, userName(u)]));

  // الشركة مرئية لمدير الشركة بنصيبه فقط — صفوف الشركات الأخرى للمندوب المشترك تُسقط.
  const visible = viewer.mode === 'company'
    ? rows.filter(r => r.repUserId === viewer.id || r.createdById === viewer.id || r.team?.leaderUserId === viewer.id || viewer.companyIds.includes(r.companyId))
    : rows;

  return visible.map(r => ({
    id: r.id,
    teamId: r.teamId,
    provinceName: r.team?.province?.name ?? null,
    repUserId: r.repUserId,
    repName: userName(r.rep),
    companyId: r.companyId,
    companyName: r.companyId ? (companyName.get(r.companyId) ?? null) : null,
    itemId: r.itemId,
    itemName: r.itemName,
    pharmacyName: r.pharmacyName,
    areaName: r.areaName,
    channel: r.channel,
    warehouseName: r.warehouseName,
    quantity: r.quantity,
    bonusQty: r.bonusQty,
    unitPrice: r.unitPrice,
    totalValue: r.totalValue,
    currency: r.currency,
    saleDate: r.saleDate,
    invoiceNo: r.invoiceNo,
    notes: r.notes,
    status: r.status,
    rejectReason: r.rejectReason,
    reviewedBy: r.reviewedById ? (reviewerName.get(r.reviewedById) ?? null) : null,
    reviewedAt: r.reviewedAt,
    entrySource: r.entrySource,
    senderName: r.senderName,
    createdAt: r.createdAt,
    canReview: isReviewer(viewer, r),
    canEdit: r.status === 'pending' && (r.createdById === viewer.id || isReviewer(viewer, r)),
  }));
}

/**
 * مجاميع المعتمد لكل (مندوب × شركة) في شهر — تُعرض بجانب التغطية لا فوقها.
 * @returns {Map<string, {value:number, valueUSD:number, qty:number, rows:number, pharmacies:number}>} مفتاح `${repUserId}|${companyId}`
 */
export async function approvedTotals(repUserIds, { month, rate }) {
  const map = new Map();
  if (!repUserIds.length) return map;
  const rows = await prisma.repPersonalSale.findMany({
    where: { repUserId: { in: repUserIds }, status: 'approved', ...buildMonthFilter(month) },
    select: { repUserId: true, companyId: true, quantity: true, totalValue: true, currency: true, pharmacyName: true },
  });
  const pharm = new Map();
  for (const r of rows) {
    const key = `${r.repUserId}|${r.companyId ?? 0}`;
    if (!map.has(key)) { map.set(key, { valueUSD: 0, qty: 0, rows: 0, pharmacies: 0 }); pharm.set(key, new Set()); }
    const e = map.get(key);
    e.valueUSD += r.currency === 'USD' ? r.totalValue : r.totalValue / (rate || 1470);
    e.qty += r.quantity;
    e.rows++;
    pharm.get(key).add(String(r.pharmacyName).trim());
  }
  for (const [k, e] of map) { e.pharmacies = pharm.get(k).size; e.valueUSD = +e.valueUSD.toFixed(2); }
  return map;
}

export async function pendingCounts(viewer) {
  const teamIds = await reviewableTeamIds(viewer);
  const or = [];
  if (teamIds.length) or.push({ teamId: { in: teamIds } });
  if (viewer.mode === 'office' && viewer.officeId) or.push({ officeId: viewer.officeId, teamId: null });
  if (!or.length) return { toReview: 0 };
  return { toReview: await prisma.repPersonalSale.count({ where: { status: 'pending', OR: or } }) };
}

// ─── الإدخال ──────────────────────────────────────────────────────────────────

/**
 * يحسم (المندوب، الفريق) لإدخال جديد ويتحقّق من الصلاحية.
 * المندوب يُدخل لنفسه دائماً؛ القائد/الإدارة يُدخلان لمندوب في فريق يعتمدانه.
 */
async function resolveEntryTarget(viewer, { repUserId, teamId }) {
  const rid = viewer.mode === 'rep' ? viewer.id : Number(repUserId || viewer.id);
  const assignments = await prisma.provinceRepAssignment.findMany({
    where: { repUserId: rid, isActive: true, team: { isActive: true } },
    select: { teamId: true, companyId: true, team: { select: { id: true, officeId: true, leaderUserId: true } } },
  });
  if (!assignments.length) throw new AppError('هذا المندوب غير معيَّن في أي فريق محافظة', 400, 'NOT_ASSIGNED');

  const teams = [...new Map(assignments.map(a => [a.team.id, a.team])).values()];
  let team = teamId ? teams.find(t => t.id === Number(teamId)) : (teams.length === 1 ? teams[0] : null);
  if (teamId && !team) throw new AppError('المندوب غير معيَّن في هذا الفريق', 400, 'NOT_ASSIGNED');

  if (rid !== viewer.id) {
    const allowed = teams.some(t => canReviewTeam(viewer, t));
    if (!allowed) throw new AppError('لا يمكنك الإدخال نيابةً عن هذا المندوب', 403, 'FORBIDDEN');
  }
  return { repUserId: rid, teams, team, assignments };
}

function cleanText(v, max = 200) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function parseDate(v) {
  const d = v ? new Date(v) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * @param {object} viewer
 * @param {{repUserId?:number, teamId?:number, rows:Array}} body
 */
export async function createPersonalSales(viewer, body) {
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!rows.length) throw new AppError('لا توجد أصناف للحفظ', 400, 'NO_ROWS');
  if (rows.length > MAX_ROWS_PER_SUBMIT) throw new AppError(`الحد الأقصى ${MAX_ROWS_PER_SUBMIT} صنفاً في المرة الواحدة`, 400, 'TOO_MANY');

  const target = await resolveEntryTarget(viewer, body);
  const pending = await prisma.repPersonalSale.count({ where: { repUserId: target.repUserId, status: 'pending' } });
  if (pending + rows.length > MAX_PENDING_PER_REP) {
    throw new AppError(`لدى المندوب ${pending} صفاً بانتظار الاعتماد — يُعتمد بعضها أولاً`, 409, 'PENDING_FULL');
  }

  const itemIds = [...new Set(rows.map(r => Number(r.itemId)).filter(Number.isInteger))];
  const items = itemIds.length
    ? await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, price: true, warehousePrice: true, scientificCompanyId: true } })
    : [];
  const itemById = new Map(items.map(i => [i.id, i]));
  const companyTeam = new Map(target.assignments.map(a => [a.companyId, a.team]));

  const data = [];
  const errors = [];
  rows.forEach((r, idx) => {
    const line = idx + 1;
    const item = itemById.get(Number(r.itemId)) ?? null;
    const itemName = item?.name ?? cleanText(r.itemName);
    const pharmacyName = cleanText(r.pharmacyName);
    const quantity = Math.round(Number(r.quantity));
    const saleDate = parseDate(r.saleDate);
    const channel = CHANNELS.has(r.channel) ? r.channel : 'warehouse';
    if (!itemName) return errors.push(`سطر ${line}: الصنف مطلوب`);
    if (!pharmacyName) return errors.push(`سطر ${line}: اسم الصيدلية مطلوب`);
    if (!(quantity > 0)) return errors.push(`سطر ${line}: الكمية يجب أن تكون أكبر من صفر`);
    if (!saleDate) return errors.push(`سطر ${line}: التاريخ غير صالح`);

    const companyId = item?.scientificCompanyId ?? null;
    // الفريق: فريق الشركة التي يُعيَّن فيها المندوب لهذا الايتم، وإلا المختار.
    const team = (companyId && companyTeam.get(companyId)) || target.team || target.teams[0];
    const { unitPrice, totalValue } = personalSaleValue({ channel, quantity, unitPrice: r.unitPrice }, item);
    const autoApprove = canReviewTeam(viewer, team) && target.repUserId !== viewer.id;

    data.push({
      officeId: team.officeId,
      teamId: team.id,
      repUserId: target.repUserId,
      companyId,
      itemId: item?.id ?? null,
      itemName,
      pharmacyName,
      areaName: cleanText(r.areaName),
      channel,
      warehouseName: channel === 'warehouse' ? cleanText(r.warehouseName) : null,
      quantity,
      bonusQty: Math.max(0, Math.round(Number(r.bonusQty) || 0)),
      unitPrice,
      totalValue,
      currency: r.currency === 'USD' ? 'USD' : 'IQD',
      saleDate,
      invoiceNo: cleanText(r.invoiceNo, 60),
      notes: cleanText(r.notes, 500),
      // ما يُدخله القائد/الإدارة لمندوبه معتمد بطبيعته — لا معنى لاعتماده لنفسه.
      status: autoApprove ? 'approved' : 'pending',
      reviewedById: autoApprove ? viewer.id : null,
      reviewedAt: autoApprove ? new Date() : null,
      entrySource: 'app',
      createdById: viewer.id,
    });
  });
  if (errors.length) throw new AppError(errors.slice(0, 5).join(' · '), 400, 'INVALID_ROWS');

  await prisma.repPersonalSale.createMany({ data });
  return { created: data.length, approved: data.filter(d => d.status === 'approved').length };
}

async function loadEditable(viewer, id) {
  const row = await prisma.repPersonalSale.findUnique({ where: { id }, include: { team: { select: { id: true, officeId: true, leaderUserId: true } } } });
  if (!row) throw new AppError('السجل غير موجود', 404, 'NOT_FOUND');
  const reviewer = isReviewer(viewer, row);
  return { row, reviewer, owner: row.createdById === viewer.id || row.repUserId === viewer.id };
}

export async function updatePersonalSale(viewer, id, patch) {
  const { row, reviewer, owner } = await loadEditable(viewer, id);
  if (row.status !== 'pending') throw new AppError('لا يُعدَّل إلا ما ينتظر الاعتماد', 409, 'NOT_PENDING');
  if (!reviewer && !owner) throw new AppError('لا صلاحية لتعديل هذا السجل', 403, 'FORBIDDEN');

  const data = {};
  for (const k of ['pharmacyName', 'areaName', 'warehouseName', 'invoiceNo', 'notes', 'itemName']) {
    if (patch[k] !== undefined) data[k] = cleanText(patch[k], k === 'notes' ? 500 : 200);
  }
  if (data.pharmacyName === null) throw new AppError('اسم الصيدلية مطلوب', 400, 'BAD_INPUT');
  if (patch.channel !== undefined && CHANNELS.has(patch.channel)) data.channel = patch.channel;
  if (patch.saleDate !== undefined) { const d = parseDate(patch.saleDate); if (d) data.saleDate = d; }
  if (patch.bonusQty !== undefined) data.bonusQty = Math.max(0, Math.round(Number(patch.bonusQty) || 0));
  if (patch.quantity !== undefined) {
    const q = Math.round(Number(patch.quantity));
    if (!(q > 0)) throw new AppError('الكمية يجب أن تكون أكبر من صفر', 400, 'BAD_INPUT');
    data.quantity = q;
  }

  // المراجِع يحسم المندوب لصفوف البوت التي لم يُعرف مرسِلها.
  if (patch.repUserId !== undefined && reviewer) {
    const rid = Number(patch.repUserId);
    const a = await prisma.provinceRepAssignment.findFirst({
      where: { repUserId: rid, isActive: true, ...(row.teamId ? { teamId: row.teamId } : { team: { officeId: row.officeId } }) },
      select: { teamId: true },
    });
    if (!a) throw new AppError('المندوب المختار غير معيَّن في هذا الفريق', 400, 'NOT_ASSIGNED');
    data.repUserId = rid;
    data.teamId = a.teamId;
  }

  let item = null;
  if (patch.itemId !== undefined && patch.itemId !== null) {
    item = await prisma.item.findUnique({ where: { id: Number(patch.itemId) }, select: { id: true, name: true, price: true, warehousePrice: true, scientificCompanyId: true } });
    if (!item) throw new AppError('الصنف غير موجود', 400, 'BAD_ITEM');
    data.itemId = item.id; data.itemName = item.name; data.companyId = item.scientificCompanyId ?? null;
  } else if (row.itemId) {
    item = await prisma.item.findUnique({ where: { id: row.itemId }, select: { id: true, price: true, warehousePrice: true } });
  }

  const merged = { ...row, ...data };
  if (patch.unitPrice !== undefined || data.quantity !== undefined || data.channel !== undefined || data.itemId !== undefined) {
    const v = personalSaleValue({
      channel: merged.channel,
      quantity: merged.quantity,
      unitPrice: patch.unitPrice !== undefined ? patch.unitPrice : (data.itemId !== undefined || data.channel !== undefined ? null : row.unitPrice),
    }, item);
    data.unitPrice = v.unitPrice; data.totalValue = v.totalValue;
  }
  await prisma.repPersonalSale.update({ where: { id }, data });
}

export async function reviewPersonalSales(viewer, { ids, action, reason = null }) {
  const list = [...new Set((ids ?? []).map(Number).filter(Number.isInteger))];
  if (!list.length) throw new AppError('لم يُحدَّد أي سجل', 400, 'NO_IDS');
  if (!['approve', 'reject', 'reopen'].includes(action)) throw new AppError('إجراء غير معروف', 400, 'BAD_ACTION');

  const rows = await prisma.repPersonalSale.findMany({
    where: { id: { in: list } },
    select: { id: true, status: true, repUserId: true, officeId: true, team: { select: { id: true, officeId: true, leaderUserId: true } } },
  });
  const allowed = rows.filter(r => isReviewer(viewer, r));
  const skipped = { forbidden: rows.length - allowed.length, noRep: 0 };
  let targets = allowed;
  if (action === 'approve') {
    skipped.noRep = targets.filter(r => !r.repUserId).length;
    targets = targets.filter(r => r.repUserId);
  }
  if (!targets.length) {
    throw new AppError(skipped.noRep ? 'حدّد المندوب أولاً للصفوف الواردة من البوت' : 'لا صلاحية لاعتماد هذه السجلات', 403, 'FORBIDDEN');
  }
  const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'pending';
  await prisma.repPersonalSale.updateMany({
    where: { id: { in: targets.map(t => t.id) } },
    data: {
      status,
      rejectReason: action === 'reject' ? cleanText(reason, 300) : null,
      reviewedById: action === 'reopen' ? null : viewer.id,
      reviewedAt: action === 'reopen' ? null : new Date(),
    },
  });
  return { updated: targets.length, skipped };
}

export async function deletePersonalSale(viewer, id) {
  const { row, reviewer, owner } = await loadEditable(viewer, id);
  if (!reviewer && !(owner && row.status === 'pending')) {
    throw new AppError('حذف السجل المعتمد متاح للتيم ليدر أو الإدارة فقط', 403, 'FORBIDDEN');
  }
  await prisma.repPersonalSale.delete({ where: { id } });
}

// ─── البوت ────────────────────────────────────────────────────────────────────

/**
 * يحسم المندوب صاحب رسالة البوت.
 * الربط في هذا النظام «كروب ↔ حساب»: كروب مربوط بحساب المندوب نفسه ⇒ هو. كروب
 * مربوط بحساب القائد/المكتب ⇒ نطابق اسم المرسِل بمندوبي فرقه. التباس أو لا
 * تطابق ⇒ null ويختاره المراجِع — لا تخمين.
 */
async function resolveBotRep(user, senderName) {
  const own = await prisma.provinceRepAssignment.findFirst({
    where: { repUserId: user.id, isActive: true, team: { isActive: true } },
    select: { repUserId: true },
  });
  if (own) return { repUserId: user.id, matched: 'account' };

  const teamWhere = user.officeId
    ? { isActive: true, OR: [{ leaderUserId: user.id }, { officeId: user.officeId }] }
    : { isActive: true, leaderUserId: user.id };
  const assignments = await prisma.provinceRepAssignment.findMany({
    where: { isActive: true, team: teamWhere },
    select: { repUserId: true, rep: { select: { displayName: true, username: true } } },
  });
  if (!assignments.length || !senderName) return { repUserId: null, matched: 'none' };
  const reps = [...new Map(assignments.map(a => [a.repUserId, { id: a.repUserId, name: userName(a.rep) }])).values()];
  const m = matchRepName(senderName, buildRepIndex(reps));
  return m.status === 'exact' ? { repUserId: m.rep.id, matched: 'sender' } : { repUserId: null, matched: m.status };
}

/**
 * صفوف مستخرَجة من رسالة بوت (نفس شكل مخرجات order-extract/enrichRowsFromCatalog)
 * ← صفوف جهد شخصي بانتظار الاعتماد. يُعيد نصّ الردّ للكروب.
 */
export async function ingestPersonalSalesFromBot({ user, source, senderName = null, sourceText = null, mediaKeys = [], rows }) {
  if (!rows?.length) throw new AppError('لم أتعرّف على أي صنف في الرسالة.', 422, 'NO_ROWS');

  const sourceHash = crypto.createHash('sha256')
    .update(`personal|${user.id}|${String(sourceText ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}|${[...mediaKeys].map(String).sort().join(',')}`)
    .digest('hex');
  const dup = await prisma.repPersonalSale.findFirst({ where: { sourceHash }, select: { id: true, status: true } });
  if (dup) return '🔁 هذا المبيع مُسجَّل مسبقاً — لم يُكرَّر.';

  const { repUserId } = await resolveBotRep(user, senderName);
  let team = null;
  if (repUserId) {
    const a = await prisma.provinceRepAssignment.findFirst({
      where: { repUserId, isActive: true, team: { isActive: true } },
      select: { team: { select: { id: true, officeId: true } } },
    });
    team = a?.team ?? null;
  }

  const itemIds = [...new Set(rows.map(r => r._itemId).filter(Number.isInteger))];
  const items = itemIds.length
    ? await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, price: true, warehousePrice: true, scientificCompanyId: true } })
    : [];
  const itemById = new Map(items.map(i => [i.id, i]));

  const data = [];
  for (const r of rows) {
    const item = itemById.get(r._itemId) ?? null;
    const quantity = Math.round(Number(r.quantity));
    const pharmacyName = cleanText(r.pharmacy);
    // صف بلا كمية أو صيدلية يبقى للمراجِع؟ لا — الجهد الشخصي لا يُعتمد بلا هذين،
    // والرسالة تُعاد بتنبيه بدل صفّ ناقص يملأ الطابور.
    if (!(quantity > 0) || !pharmacyName) continue;
    // المندوب يبيع غالباً عبر المذاخر؛ «من المكتب» صراحةً في الرسالة يقلبها.
    const channel = !r.warehouse && /مكتب/.test(String(sourceText ?? '')) ? 'office' : 'warehouse';
    const { unitPrice, totalValue } = personalSaleValue({ channel, quantity, unitPrice: r.unitPrice }, item);
    data.push({
      officeId: team?.officeId ?? user.officeId ?? null,
      teamId: team?.id ?? null,
      repUserId,
      companyId: item?.scientificCompanyId ?? null,
      itemId: item?.id ?? null,
      itemName: item?.name ?? cleanText(r.item) ?? '—',
      pharmacyName,
      areaName: cleanText(r.area),
      channel,
      warehouseName: cleanText(r.warehouse),
      quantity,
      bonusQty: Math.max(0, Math.round(Number(r.bonus) || 0)),
      unitPrice,
      totalValue,
      currency: 'IQD',
      saleDate: parseDate(r.date) ?? new Date(),
      invoiceNo: cleanText(r.invoiceNumber, 60),
      status: 'pending',
      entrySource: source,
      senderName: cleanText(senderName, 120),
      sourceHash,
      createdById: user.id,
    });
  }
  if (!data.length) {
    return '⚠️ لم أجد صنفاً بكمية واسم صيدلية. اكتب مثلاً:\nمبيعي\nصيدلية النور - الكرخ\nبانادول 5 علبة';
  }
  await prisma.repPersonalSale.createMany({ data });

  const unknownItems = data.filter(d => !d.itemId).length;
  const lines = [`✅ سُجّل ${data.length} صنف كجهد شخصي — بانتظار اعتماد التيم ليدر.`];
  if (!repUserId) lines.push('ℹ️ لم أتعرّف على المندوب — سيحدّده التيم ليدر عند المراجعة.');
  if (unknownItems) lines.push(`ℹ️ ${unknownItems} صنف لم يُطابَق بالكتالوج — يُصحَّح عند المراجعة.`);
  if (rows.length > data.length) lines.push(`⚠️ أُهمل ${rows.length - data.length} سطر بلا كمية أو صيدلية.`);
  return lines.join('\n');
}
