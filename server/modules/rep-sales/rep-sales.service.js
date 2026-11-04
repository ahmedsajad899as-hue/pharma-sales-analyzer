// ════════════════════════════════════════════════════════════════════════════
// rep-sales.service.js — «مبيعات المندوبين».
//
// المندوب يسجّل مبيعه اليومي من الصفحة أو من البوت بكلمة «مبيعي» (rep-sales.bot.js): مؤكد مباشرةً، أو طلبية غير مؤكدة تبقى معلّقة حتى يؤكدها
// بالأرقام نفسها أو بصورة الفاتورة. مديره يرى ما سُجّل بنفس نطاق «طلبيات المذاخر».
//
// **لا يُكتب في Sale** — ملفات الإكسل تحتسب المبيع نفسه لاحقاً. يُقرأ منه المؤكد فقط لمبيع المندوب
// في «مندوبين المحافظات»: عمود اللكوديشن (provinceSummary) وتقرير المندوب (lib/repLiquidation.js).
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { isFieldRole } from '../../lib/surveyDoctors.js';
import { loadRepLocations } from '../../lib/repLocation.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';
import { loadManagerSeat, loadSeatManagers } from '../../lib/provinceSeats.js';
import { aggregateProvinceSales, addMercatoToProvinces } from '../../lib/repSalesProvince.js';
import { dateRangeWhere } from '../../lib/repLiquidation.js';
import { monthToRange } from '../../lib/salesMonths.js';
import { saleValueUSD } from '../sales/sales.repository.js';
import { liquidationProvinces, loadLiquidationData, REP_SALE_SELECT } from '../scientific-reps/scientific-reps.service.js';
import { buildLines, cleanText, loadViewer, orderScopeWhere, parseDay, teamUserIds } from '../rep-orders/rep-orders.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// جذر المشروع/uploads — Nginx يخدم /uploads/ منه مباشرةً على الإنتاج (لا من server/uploads)
export const SALE_IMAGE_DIR = path.join(__dirname, '..', '..', '..', 'uploads', 'rep-sales');

const LIST_CAP = 5000;
const CONFIRM_WAIT_MS = 24 * 60 * 60 * 1000;
const KIND_ORDER = { manager: 0, leader: 1, rep: 2 };
const userName = (u) => (u ? (u.displayName || u.username) : null);
const imageUrl = (file) => `/uploads/rep-sales/${path.basename(file.path)}`;
const removeImageFile = (rel) => {
  if (rel) fs.promises.unlink(path.join(SALE_IMAGE_DIR, path.basename(rel))).catch(() => {});
};

/** multer يحفظ الصورة قبل التحقق من الطلب، فالطلب المرفوض يجب ألّا يترك ملفاً على القرص الضيّق. */
async function withUpload(file, fn) {
  try {
    return await fn();
  } catch (e) {
    if (file) fs.promises.unlink(file.path).catch(() => {});
    throw e;
  }
}

/** نماذج multipart ترسل الحقول نصاً — data = JSON الطلب كله، lines = أسطر التأكيد. */
function parseJsonField(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { throw new AppError('بيانات الطلب غير صالحة', 400); }
}

async function getVisibleSale(viewer, id) {
  const sale = await prisma.repSale.findFirst({
    where: { AND: [{ id: Number(id) }, await orderScopeWhere(viewer)] },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
  if (!sale) throw new AppError('المبيع غير موجود', 404, 'NOT_FOUND');
  return sale;
}

// المؤكد رقم يحاسَب عليه المندوب، فتصحيحه بعد التأكيد لمديره
export const canEditSale = (viewer, sale) =>
  !isFieldRole(viewer.role) || (sale.createdById === viewer.id && sale.status !== 'confirmed');

function assertCanEdit(viewer, sale) {
  if (canEditSale(viewer, sale)) return;
  throw new AppError(sale.status === 'confirmed' ? 'المبيع مؤكد — التعديل عليه من صلاحية المدير فقط' : 'لا يمكنك تعديل هذا المبيع', 403);
}

/**
 * متى يستطيع هذا المُشاهِد تأكيد الطلبية بلا فاتورة: المندوب يكتبها قبل أن يعرف هل ستتجهز،
 * فينتظر 24 ساعة من كتابتها. null = بلا انتظار (المدير يؤكد أي وقت).
 */
const confirmOpensAt = (viewer, sale) =>
  (isFieldRole(viewer.role) ? new Date(new Date(sale.createdAt).getTime() + CONFIRM_WAIT_MS) : null);

function assertWaitOver(viewer, sale) {
  const at = confirmOpensAt(viewer, sale);
  if (!at || at.getTime() <= Date.now()) return;
  const hours = Math.ceil((at.getTime() - Date.now()) / 3600000);
  throw new AppError(`يتاح التأكيد بعد مرور 24 ساعة على الطلبية (باقي ${hours} ساعة) — أو الآن بإرفاق صورة الفاتورة`, 403);
}

async function buildSaleData(body) {
  const pharmacyName = cleanText(body?.pharmacyName, 160);
  if (!pharmacyName) throw new AppError('اسم الصيدلية مطلوب', 400);
  const areaName = cleanText(body?.areaName, 120);
  if (!areaName) throw new AppError('المنطقة مطلوبة', 400);
  const lines = await buildLines(body?.lines);
  if (!lines.length) throw new AppError('أضف ايتماً واحداً على الأقل مع كميته', 400);
  return {
    head: {
      saleDate: parseDay(body?.saleDate),
      pharmacyName,
      areaName,
      warehouseName: cleanText(body?.warehouseName, 120),
      invoiceNumber: cleanText(body?.invoiceNumber, 60),
      notes: cleanText(body?.notes, 500),
    },
    lines,
  };
}

// ─── القراءة ──────────────────────────────────────────────────────────────────

/** @param {{from?:string, to?:string, repUserId?:string}} q */
export async function listSales(reqUser, q = {}) {
  const viewer = await loadViewer(reqUser);
  const and = [await orderScopeWhere(viewer)];
  if (q.from) and.push({ saleDate: { gte: new Date(`${String(q.from).slice(0, 10)}T00:00:00Z`) } });
  if (q.to) and.push({ saleDate: { lte: new Date(`${String(q.to).slice(0, 10)}T23:59:59Z`) } });
  if (q.repUserId) and.push({ createdById: Number(q.repUserId) });

  const rows = await prisma.repSale.findMany({
    where: { AND: and },
    orderBy: [{ saleDate: 'desc' }, { id: 'desc' }],
    take: LIST_CAP,
    include: { lines: { orderBy: { id: 'asc' } } },
  });

  const isManager = !isFieldRole(viewer.role);
  // قائمة المدير: فريقه كله ليُرى من لم يسجّل بعد، + من ظهر في النتائج (ومنهم المدير إن سجّل لنفسه)
  const repIds = new Set(rows.flatMap(r => [r.createdById, r.confirmedById]).filter(Boolean));
  const teamIds = isManager ? (await teamUserIds(viewer)).filter(id => id !== viewer.id) : [];
  for (const id of teamIds) repIds.add(id);
  const users = repIds.size
    ? await prisma.user.findMany({ where: { id: { in: [...repIds] } }, select: { id: true, displayName: true, username: true } })
    : [];
  const nameById = new Map(users.map(u => [u.id, userName(u)]));
  const filterIds = new Set([...teamIds, ...rows.map(r => r.createdById)]);
  const locations = isManager ? await loadRepLocations([...filterIds]) : new Map();

  return {
    viewer: { id: viewer.id, name: userName(viewer), isManager },
    reps: [...filterIds]
      .map(id => ({ id, name: nameById.get(id) ?? '—', ...(locations.get(id) ?? { province: null, side: null, group: 'other', kind: 'rep' }) }))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name, 'ar')),
    truncated: rows.length === LIST_CAP,
    serverNow: Date.now(),
    sales: rows.map(r => ({
      id: r.id,
      saleDate: r.saleDate,
      createdById: r.createdById,
      repName: nameById.get(r.createdById) ?? '—',
      pharmacyName: r.pharmacyName,
      areaName: r.areaName,
      warehouseName: r.warehouseName,
      invoiceNumber: r.invoiceNumber,
      notes: r.notes,
      status: r.status,
      invoiceImage: r.invoiceImage,
      confirmedAt: r.confirmedAt,
      confirmedBy: r.confirmedById ? (nameById.get(r.confirmedById) ?? null) : null,
      createdAt: r.createdAt,
      lines: r.lines.map(l => ({ id: l.id, itemId: l.itemId, itemName: l.itemName, companyName: l.companyName, quantity: l.quantity, bonusQty: l.bonusQty, unitPrice: l.unitPrice })),
      canEdit: canEditSale(viewer, r),
      confirmOpensAt: r.status === 'pending' ? confirmOpensAt(viewer, r) : null,
    })),
  };
}

/** اقتراحات النموذج من سجلّ المندوب نفسه: مبيعاته وطلبياته السابقة. */
export async function suggestions(reqUser) {
  const viewer = await loadViewer(reqUser);
  const select = { pharmacyName: true, areaName: true, warehouseName: true };
  const [sales, orders] = await Promise.all([
    prisma.repSale.findMany({ where: { createdById: viewer.id }, select, orderBy: { id: 'desc' }, take: 1500 }),
    prisma.repOrder.findMany({ where: { createdById: viewer.id }, select, orderBy: { id: 'desc' }, take: 1500 }),
  ]);
  const pharmacies = new Map();
  const warehouses = new Set();
  for (const r of [...sales, ...orders]) {
    if (!pharmacies.has(r.pharmacyName)) pharmacies.set(r.pharmacyName, r.areaName);
    if (r.warehouseName) warehouses.add(r.warehouseName);
  }
  return {
    pharmacies: [...pharmacies].map(([name, areaName]) => ({ name, areaName })),
    warehouses: [...warehouses].sort((a, b) => a.localeCompare(b, 'ar')),
  };
}

/** حسابات المندوبين ضمن نطاق المُشاهِد: نفس orderScopeWhere مكتوباً على User. */
function userScopeWhere(scope, seat) {
  if (!scope.OR) return {};
  return {
    OR: [
      ...scope.OR.map(c => (c.createdById ? { id: c.createdById } : { officeId: c.officeId })),
      ...(seat ? [{ officeId: seat.officeId }] : []),
    ],
  };
}

/**
 * حقل اللكوديشن في «مندوبين المحافظات» لكل محافظة وشركة ونوع مندوب.
 * بملفات نشطة (عرض العلميين): المؤكد + صفوف ميركاتو بأسماء العلميين، وسطر موجود في ميركاتو لا
 * يُحسب مرتين. بلا ملفات (عرض المسوقين): المؤكد وحده.
 * مدير الشركة: كل مبيع مكتبه على ايتماته، أياً كان البائع، كما يُحسب مبيع المحافظة الذي يُقارَن به
 * (مندوبو الفرق والمسوقون كثيراً لا يتبعونه في UserManagerAssignment).
 * @param {{month?:string, startDate?:string, endDate?:string, fileIds?:string}} q
 */
export async function provinceSummary(reqUser, q = {}) {
  const viewer = await loadViewer(reqUser);
  const seat = viewer.role === 'company_manager' ? await loadManagerSeat(viewer.id) : null;
  const scope = await orderScopeWhere(viewer);
  const fileIds = String(q.fileIds ?? '').split(',').map(Number).filter(n => n > 0);
  const range = monthToRange(q.month) ?? { startDate: q.startDate, endDate: q.endDate };
  const repSaleWhere = seat ? { OR: [scope, { officeId: seat.officeId }] } : scope;
  const { sales, mercatoRows, ownerOfRow } = fileIds.length
    ? await loadLiquidationData({ fileIds, range, repSaleWhere, userWhere: userScopeWhere(scope, seat), viewerId: viewer.id })
    : {
        sales: await prisma.repSale.findMany({
          where: { AND: [repSaleWhere, { status: 'confirmed' }, dateRangeWhere(range, 'saleDate')] },
          select: REP_SALE_SELECT,
        }),
        mercatoRows: [],
        ownerOfRow: () => null,
      };
  if (!sales.length && !mercatoRows.length) return { rows: [] };

  const repIds = [...new Set(sales.map(s => s.createdById))];
  const itemIds = [...new Set([...sales.flatMap(s => s.lines.map(l => l.itemId)), ...mercatoRows.map(r => r.itemId)].filter(Boolean))];
  const [provinces, users, items, seats, ownItems] = await Promise.all([
    liquidationProvinces(sales, mercatoRows, ownerOfRow),
    prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, linkedRep: { select: { repKind: true } } } }),
    prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, scientificCompanyId: true } }),
    loadSeatManagers(viewer.officeId ? [viewer.officeId] : null),
    seat ? resolveEffectiveItemIds(seat.userId) : null,
  ]);

  // اسم الشركة = فريق مدير الايتم، كما يعرضها مبيع المحافظة (byProvinceCompany)
  const companyOfItem = new Map(items.map(i => [i.id, i.scientificCompanyId]));
  const teamByItem = new Map();
  for (const s of seats) for (const i of s.items) if (!teamByItem.has(i.id)) teamByItem.set(i.id, s.companyName);
  const wholeCompanySeats = new Map(seats.filter(s => !s.items.length).map(s => [s.companyId, s.companyName]));
  const kindByUser = new Map(users.map(u => [u.id, u.linkedRep?.repKind === 'pharmacy' ? 'pharmacy' : 'scientific']));
  const ownSet = ownItems ? new Set(ownItems) : null;
  const teamOfItem = (id) => (id ? teamByItem.get(id) ?? wholeCompanySeats.get(companyOfItem.get(id)) ?? null : null);
  const allowItem = seat
    ? (id) => (ownSet ? ownSet.has(id) : companyOfItem.get(id) === seat.companyId)
    : undefined;

  const repSaleRows = aggregateProvinceSales(sales, {
    provinceOf: (sale) => (kindByUser.get(sale.createdById) === 'pharmacy' ? provinces.ofMarketerSale(sale) : provinces.ofSale(sale)),
    kindOf: (id) => kindByUser.get(id) ?? 'scientific',
    teamOfItem,
    allowItem,
  });
  return {
    rows: addMercatoToProvinces(mercatoRows, {
      provinceOf: provinces.ofRow,
      usdOf: saleValueUSD,
      teamOfItem,
      allowItem,
    }, repSaleRows),
  };
}

// ─── الكتابة ──────────────────────────────────────────────────────────────────

export const createSale = (reqUser, rawData, file) => withUpload(file, async () => {
  const viewer = await loadViewer(reqUser);
  const body = parseJsonField(rawData, {});
  const { head, lines } = await buildSaleData(body);
  // الفاتورة دليل التأكيد، فمبيع مرفق بصورتها لا يبقى معلّقاً. بدونها يؤكد المدير فقط:
  // المندوب ينتظر 24 ساعة، والتسجيل مؤكداً مباشرةً كان سيتجاوز ذلك.
  const wantsConfirmed = body.status === 'confirmed';
  if (wantsConfirmed && !file && isFieldRole(viewer.role)) throw new AppError('لتسجيل المبيع مؤكداً أرفق صورة الفاتورة', 403);
  const confirmed = wantsConfirmed || !!file;
  return prisma.repSale.create({
    data: {
      ...head,
      officeId: viewer.officeId ?? null,
      createdById: viewer.id,
      status: confirmed ? 'confirmed' : 'pending',
      confirmedAt: confirmed ? new Date() : null,
      confirmedById: confirmed ? viewer.id : null,
      invoiceImage: file ? imageUrl(file) : null,
      lines: { create: lines },
    },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
});

export async function updateSale(reqUser, id, body) {
  const viewer = await loadViewer(reqUser);
  const sale = await getVisibleSale(viewer, id);
  assertCanEdit(viewer, sale);
  const { head, lines } = await buildSaleData(body);
  return prisma.$transaction(async (tx) => {
    await tx.repSaleLine.deleteMany({ where: { saleId: sale.id } });
    return tx.repSale.update({
      where: { id: sale.id },
      data: { ...head, lines: { create: lines } },
      include: { lines: { orderBy: { id: 'asc' } } },
    });
  });
}

/**
 * تأكيد طلبية معلّقة بالأرقام نفسها، أو بالفاتورة، أو بما جُهّز فعلاً حين يختلف.
 * rawLines اختيارية [{id, quantity, bonusQty}]: سطر بلا كمية ولا بونص لم يُجهَّز فيُحذف.
 */
export const confirmSale = (reqUser, id, rawLines, file) => withUpload(file, async () => {
  const viewer = await loadViewer(reqUser);
  const sale = await getVisibleSale(viewer, id);
  assertCanEdit(viewer, sale);
  if (sale.status !== 'pending') throw new AppError('يُؤكَّد المبيع غير المؤكد فقط', 400);
  if (!file) assertWaitOver(viewer, sale);

  const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const given = new Map((parseJsonField(rawLines, null) ?? []).map(l => [Number(l.id), l]));
  const next = sale.lines.map((l) => {
    const g = given.get(l.id);
    return g ? { id: l.id, quantity: toInt(g.quantity), bonusQty: toInt(g.bonusQty) } : { id: l.id, quantity: l.quantity, bonusQty: l.bonusQty };
  });
  if (!next.some(l => l.quantity > 0)) throw new AppError('لا توجد كميات مبيعة — إن لم تتجهز الطلبية علّمها «لم تتم»', 400);

  const updated = await prisma.$transaction(async (tx) => {
    for (const l of next) {
      if (l.quantity > 0 || l.bonusQty > 0) await tx.repSaleLine.update({ where: { id: l.id }, data: { quantity: l.quantity, bonusQty: l.bonusQty } });
      else await tx.repSaleLine.delete({ where: { id: l.id } });
    }
    return tx.repSale.update({
      where: { id: sale.id },
      data: {
        status: 'confirmed',
        confirmedAt: new Date(),
        confirmedById: viewer.id,
        ...(file ? { invoiceImage: imageUrl(file) } : {}),
      },
      include: { lines: { orderBy: { id: 'asc' } } },
    });
  });
  if (file) removeImageFile(sale.invoiceImage);
  return updated;
});

/** pending = إرجاعها غير مؤكدة، cancelled = لم تتم. */
export async function setStatus(reqUser, id, status) {
  if (!['pending', 'cancelled'].includes(status)) throw new AppError('حالة غير معروفة', 400);
  const viewer = await loadViewer(reqUser);
  const sale = await getVisibleSale(viewer, id);
  assertCanEdit(viewer, sale);
  return prisma.repSale.update({ where: { id: sale.id }, data: { status, confirmedAt: null, confirmedById: null } });
}

/**
 * إرفاق الفاتورة: يؤكد الطلبية المعلّقة بأرقامها. المؤكدة بلا صورة تقبل أول صورة من صاحبها
 * لأنها لا تغيّر الأرقام؛ استبدال صورة قائمة تعديل يخضع لقفل التأكيد.
 */
export const attachImage = (reqUser, id, file) => withUpload(file, async () => {
  if (!file) throw new AppError('لا توجد صورة', 400);
  const viewer = await loadViewer(reqUser);
  const sale = await getVisibleSale(viewer, id);
  if (sale.status === 'cancelled') throw new AppError('أرجع الطلبية غير مؤكدة أولاً', 400);
  if (sale.invoiceImage || sale.status === 'pending') assertCanEdit(viewer, sale);
  const url = imageUrl(file);
  await prisma.repSale.update({
    where: { id: sale.id },
    data: {
      invoiceImage: url,
      ...(sale.status === 'pending' ? { status: 'confirmed', confirmedAt: new Date(), confirmedById: viewer.id } : {}),
    },
  });
  removeImageFile(sale.invoiceImage);
  return { invoiceImage: url };
});

export async function removeImage(reqUser, id) {
  const viewer = await loadViewer(reqUser);
  const sale = await getVisibleSale(viewer, id);
  assertCanEdit(viewer, sale);
  await prisma.repSale.update({ where: { id: sale.id }, data: { invoiceImage: null } });
  removeImageFile(sale.invoiceImage);
}

export async function deleteSale(reqUser, id) {
  const viewer = await loadViewer(reqUser);
  const sale = await getVisibleSale(viewer, id);
  assertCanEdit(viewer, sale);
  await prisma.repSale.delete({ where: { id: sale.id } });
  removeImageFile(sale.invoiceImage);
}
