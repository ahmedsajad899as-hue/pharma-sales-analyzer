// ════════════════════════════════════════════════════════════════════════════
// rep-orders.service.js — «طلبيات المذاخر».
//
// المندوب يكتب طلبيات اليوم (صيدلية + منطقة + مذخر + أصناف بكمياتها، وصورة
// فاتورة اختيارية)، ثم يرسل الطلبية لرقم واتساب المذخر (wa.me من الواجهة).
// المدير يرى طلبيات فريقه، والأدوار المكتبية ترى طلبيات مكتبها كله.
//
// **لا يُكتب في Sale ولا يدخل أي حسبة** — سجلّ تجهيز فقط.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { getManagerRoster } from '../../lib/managerRoster.js';
import { isOfficeScopedRole } from '../../lib/officeScope.js';
import { isFieldRole } from '../../lib/surveyDoctors.js';

export const STATUSES = ['pending', 'prepared', 'cancelled'];
const MAX_LINES = 80;
const ALL_SCOPE_ROLES = new Set(['admin', 'super_admin']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// جذر المشروع/uploads — Nginx يخدم /uploads/ منه مباشرةً على الإنتاج (لا من server/uploads)
export const INVOICE_DIR = path.join(__dirname, '..', '..', '..', 'uploads', 'rep-orders');

const userName = (u) => (u ? (u.displayName || u.username) : null);

function cleanText(v, max = 200) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function parseDay(v) {
  const s = String(v ?? '').slice(0, 10);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// ─── النطاق ───────────────────────────────────────────────────────────────────

export async function loadViewer(reqUser) {
  const u = await prisma.user.findUnique({
    where: { id: reqUser.id },
    select: { id: true, role: true, officeId: true, displayName: true, username: true },
  });
  if (!u) throw new AppError('المستخدم غير موجود', 401);
  return u;
}

/** حسابات يرى المُشاهِد طلبياتها: نفسه + فريقه (للمدراء). */
async function teamUserIds(viewer) {
  const ids = new Set([viewer.id]);
  if (!isFieldRole(viewer.role)) {
    const roster = await getManagerRoster(viewer, { includeTeamLead: true });
    for (const r of roster.reps) ids.add(r.userId);
  }
  return [...ids];
}

/** شرط Prisma للطلبيات المرئية. */
export async function orderScopeWhere(viewer) {
  if (ALL_SCOPE_ROLES.has(viewer.role)) return {};
  const or = [{ createdById: { in: await teamUserIds(viewer) } }];
  if (isOfficeScopedRole(viewer.role) && viewer.officeId) or.push({ officeId: viewer.officeId });
  return { OR: or };
}

/** دليل المذاخر: مذاخر المكتب + ما أضافه المُشاهِد أو مدراؤه أو فريقه. */
async function warehouseScopeWhere(viewer) {
  if (ALL_SCOPE_ROLES.has(viewer.role)) return {};
  const ids = new Set(await teamUserIds(viewer));
  const managers = await prisma.userManagerAssignment.findMany({ where: { userId: viewer.id }, select: { managerId: true } });
  for (const m of managers) ids.add(m.managerId);
  const or = [{ createdById: { in: [...ids] } }];
  if (viewer.officeId) or.push({ officeId: viewer.officeId });
  return { OR: or };
}

export async function getVisibleOrder(viewer, id) {
  const order = await prisma.repOrder.findFirst({
    where: { AND: [{ id: Number(id) }, await orderScopeWhere(viewer)] },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
  if (!order) throw new AppError('الطلبية غير موجودة', 404, 'NOT_FOUND');
  return order;
}

export const canEditContent = (viewer, order) => order.createdById === viewer.id || !isFieldRole(viewer.role);

// ─── المذاخر ──────────────────────────────────────────────────────────────────

export async function listWarehouses(reqUser) {
  const viewer = await loadViewer(reqUser);
  const rows = await prisma.orderWarehouse.findMany({
    where: await warehouseScopeWhere(viewer),
    orderBy: { name: 'asc' },
  });
  return rows.map(w => ({ ...w, canEdit: w.createdById === viewer.id || !isFieldRole(viewer.role) }));
}

function warehouseData(body) {
  const name = cleanText(body?.name, 120);
  const phone = cleanText(body?.phone, 40);
  if (!name) throw new AppError('اسم المذخر مطلوب', 400);
  if (!phone || phone.replace(/\D/g, '').length < 7) throw new AppError('رقم واتساب المذخر غير صالح', 400);
  return { name, phone, notes: cleanText(body?.notes, 300) };
}

export async function createWarehouse(reqUser, body) {
  const viewer = await loadViewer(reqUser);
  return prisma.orderWarehouse.create({
    data: { ...warehouseData(body), officeId: viewer.officeId ?? null, createdById: viewer.id },
  });
}

async function getEditableWarehouse(viewer, id) {
  const w = await prisma.orderWarehouse.findFirst({ where: { AND: [{ id: Number(id) }, await warehouseScopeWhere(viewer)] } });
  if (!w) throw new AppError('المذخر غير موجود', 404);
  if (w.createdById !== viewer.id && isFieldRole(viewer.role)) throw new AppError('لا يمكنك تعديل هذا المذخر', 403);
  return w;
}

export async function updateWarehouse(reqUser, id, body) {
  const viewer = await loadViewer(reqUser);
  const w = await getEditableWarehouse(viewer, id);
  const data = warehouseData(body);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.orderWarehouse.update({ where: { id: w.id }, data });
    if (data.name !== w.name) await tx.repOrder.updateMany({ where: { warehouseId: w.id }, data: { warehouseName: data.name } });
    return updated;
  });
}

export async function deleteWarehouse(reqUser, id) {
  const viewer = await loadViewer(reqUser);
  const w = await getEditableWarehouse(viewer, id);
  await prisma.orderWarehouse.delete({ where: { id: w.id } }); // الطلبيات تحتفظ بالاسم النصي
}

// ─── الطلبيات: القراءة ────────────────────────────────────────────────────────

/**
 * @param {{from?:string, to?:string, status?:string, warehouseId?:string, repUserId?:string, invoice?:'yes'|'no'}} q
 */
export async function listOrders(reqUser, q = {}) {
  const viewer = await loadViewer(reqUser);
  const and = [await orderScopeWhere(viewer)];
  if (q.from) and.push({ orderDate: { gte: new Date(`${String(q.from).slice(0, 10)}T00:00:00Z`) } });
  if (q.to) and.push({ orderDate: { lte: new Date(`${String(q.to).slice(0, 10)}T23:59:59Z`) } });
  if (q.status && STATUSES.includes(q.status)) and.push({ status: q.status });
  if (q.warehouseId) and.push({ warehouseId: Number(q.warehouseId) });
  if (q.repUserId) and.push({ createdById: Number(q.repUserId) });
  if (q.invoice === 'yes') and.push({ invoiceImage: { not: null } });
  if (q.invoice === 'no') and.push({ invoiceImage: null });

  const rows = await prisma.repOrder.findMany({
    where: { AND: and },
    orderBy: [{ orderDate: 'desc' }, { id: 'desc' }],
    take: 2000,
    include: {
      lines: { orderBy: { id: 'asc' } },
      warehouse: { select: { id: true, name: true, phone: true } },
    },
  });

  // مذاخر الاحتياط وآخر مذخر أُرسلت له — استعلام واحد لكل الطلبيات
  const whIds = [...new Set(rows.flatMap(r => [...r.backupWarehouseIds, r.lastSentWarehouseId]).filter(Boolean))];
  const whRows = whIds.length ? await prisma.orderWarehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, name: true, phone: true } }) : [];
  const whById = new Map(whRows.map(w => [w.id, w]));

  // سطور قديمة بلا سعر محفوظ ← سعر الكتالوج الحالي
  const priceItemIds = [...new Set(rows.flatMap(r => r.lines.filter(l => l.unitPrice == null && l.itemId).map(l => l.itemId)))];
  const priceItems = priceItemIds.length ? await prisma.item.findMany({ where: { id: { in: priceItemIds } }, select: { id: true, price: true, warehousePrice: true } }) : [];
  const catalogPrice = new Map(priceItems.map(i => [i.id, i.warehousePrice ?? i.price ?? null]));

  const userIds = [...new Set(rows.flatMap(r => [r.createdById, r.preparedById]).filter(Boolean))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, username: true } })
    : [];
  const nameById = new Map(users.map(u => [u.id, userName(u)]));

  // قائمة المندوبين لفلتر المدير (من يظهر في النتائج + فريقه)
  let reps = [];
  if (!isFieldRole(viewer.role)) {
    const ids = new Set(await teamUserIds(viewer));
    for (const r of rows) ids.add(r.createdById);
    const repUsers = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, displayName: true, username: true } });
    reps = repUsers.map(u => ({ id: u.id, name: userName(u) })).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }

  return {
    viewer: { id: viewer.id, name: userName(viewer), isManager: !isFieldRole(viewer.role) },
    reps,
    orders: rows.map(r => ({
      id: r.id,
      orderDate: r.orderDate,
      createdById: r.createdById,
      repName: nameById.get(r.createdById) ?? '—',
      warehouseId: r.warehouseId,
      warehouseName: r.warehouse?.name ?? r.warehouseName,
      warehousePhone: r.warehouse?.phone ?? null,
      // كل مذاخر الطلبية بالترتيب: الأساسي ثم الاحتياط
      warehouses: [
        r.warehouse ? { id: r.warehouse.id, name: r.warehouse.name, phone: r.warehouse.phone } : { id: null, name: r.warehouseName, phone: null },
        ...r.backupWarehouseIds.map(id => whById.get(id)).filter(Boolean),
      ],
      lastSentWarehouseId: r.lastSentWarehouseId,
      pharmacyName: r.pharmacyName,
      areaName: r.areaName,
      notes: r.notes,
      status: r.status,
      invoiceImage: r.invoiceImage,
      preparedImage: r.preparedImage,
      invoiceNumber: r.invoiceNumber,
      sentAt: r.sentAt,
      sentCount: r.sentCount,
      preparedAt: r.preparedAt,
      preparedBy: r.preparedById ? (nameById.get(r.preparedById) ?? null) : null,
      createdAt: r.createdAt,
      lines: r.lines.map(l => ({ id: l.id, itemId: l.itemId, itemName: l.itemName, companyName: l.companyName, quantity: l.quantity, bonusQty: l.bonusQty, preparedQty: l.preparedQty, preparedBonus: l.preparedBonus, unitPrice: l.unitPrice ?? (l.itemId ? catalogPrice.get(l.itemId) ?? null : null) })),
      canEdit: canEditContent(viewer, r),
    })),
  };
}

// ─── الطلبيات: الكتابة ────────────────────────────────────────────────────────

async function buildOrderData(viewer, body) {
  const pharmacyName = cleanText(body?.pharmacyName, 160);
  if (!pharmacyName) throw new AppError('اسم الصيدلية مطلوب', 400);

  let warehouseId = body?.warehouseId ? Number(body.warehouseId) : null;
  let warehouseName = cleanText(body?.warehouseName, 120);
  if (warehouseId) {
    const w = await prisma.orderWarehouse.findFirst({ where: { AND: [{ id: warehouseId }, await warehouseScopeWhere(viewer)] } });
    if (!w) throw new AppError('المذخر غير موجود', 400);
    warehouseName = w.name;
  }
  if (!warehouseName) throw new AppError('اختر المذخر', 400);

  const wantedBackups = [...new Set((Array.isArray(body?.backupWarehouseIds) ? body.backupWarehouseIds : []).map(Number).filter(id => id && id !== warehouseId))].slice(0, 5);
  let backupWarehouseIds = [];
  if (wantedBackups.length) {
    const found = await prisma.orderWarehouse.findMany({ where: { AND: [{ id: { in: wantedBackups } }, await warehouseScopeWhere(viewer)] }, select: { id: true } });
    const ok = new Set(found.map(w => w.id));
    backupWarehouseIds = wantedBackups.filter(id => ok.has(id)); // يحفظ ترتيب المستخدم
  }

  const rawLines = Array.isArray(body?.lines) ? body.lines.slice(0, MAX_LINES) : [];
  const itemIds = [...new Set(rawLines.map(l => Number(l.itemId)).filter(Boolean))];
  const items = itemIds.length
    ? await prisma.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, name: true, price: true, warehousePrice: true, company: { select: { name: true } }, scientificCompany: { select: { name: true } } },
      })
    : [];
  const itemById = new Map(items.map(i => [i.id, i]));

  const lines = [];
  for (const l of rawLines) {
    const qty = Math.floor(Number(l.quantity));
    if (!(qty > 0)) continue;
    const it = l.itemId ? itemById.get(Number(l.itemId)) : null;
    const itemName = it?.name ?? cleanText(l.itemName, 160);
    if (!itemName) continue;
    lines.push({
      itemId: it?.id ?? null,
      itemName,
      // الشركة تُكتب تلقائياً من الكتالوج؛ الصنف الحرّ يحمل ما كتبه المندوب
      companyName: it ? (it.scientificCompany?.name ?? it.company?.name ?? null) : cleanText(l.companyName, 120),
      quantity: qty,
      bonusQty: Math.max(0, Math.floor(Number(l.bonusQty) || 0)),
      // الطلبية تذهب لمذخر ← سعر المذخر أولاً
      unitPrice: it ? (it.warehousePrice ?? it.price ?? null) : null,
    });
  }
  if (!lines.length) throw new AppError('أضف صنفاً واحداً على الأقل مع كميته', 400);

  return {
    head: {
      orderDate: parseDay(body?.orderDate),
      warehouseId,
      warehouseName,
      backupWarehouseIds,
      pharmacyName,
      areaName: cleanText(body?.areaName, 120),
      notes: cleanText(body?.notes, 500),
    },
    lines,
  };
}

export async function createOrder(reqUser, body) {
  const viewer = await loadViewer(reqUser);
  const { head, lines } = await buildOrderData(viewer, body);
  return prisma.repOrder.create({
    data: { ...head, officeId: viewer.officeId ?? null, createdById: viewer.id, lines: { create: lines } },
    include: { lines: true },
  });
}

export async function updateOrder(reqUser, id, body) {
  const viewer = await loadViewer(reqUser);
  const order = await getVisibleOrder(viewer, id);
  if (!canEditContent(viewer, order)) throw new AppError('لا يمكنك تعديل هذه الطلبية', 403);
  const { head, lines } = await buildOrderData(viewer, body);
  return prisma.$transaction(async (tx) => {
    await tx.repOrderLine.deleteMany({ where: { orderId: order.id } });
    return tx.repOrder.update({ where: { id: order.id }, data: { ...head, lines: { create: lines } }, include: { lines: true } });
  });
}

export async function setStatus(reqUser, ids, status) {
  if (!STATUSES.includes(status)) throw new AppError('حالة غير معروفة', 400);
  const viewer = await loadViewer(reqUser);
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean).slice(0, 500);
  if (!list.length) return { updated: 0 };
  const r = await prisma.repOrder.updateMany({
    where: { AND: [{ id: { in: list } }, await orderScopeWhere(viewer)] },
    data: status === 'prepared'
      ? { status, preparedAt: new Date(), preparedById: viewer.id }
      : { status, preparedAt: null, preparedById: null },
  });
  return { updated: r.count };
}

export async function markSent(reqUser, ids, warehouseId = null) {
  const viewer = await loadViewer(reqUser);
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean).slice(0, 500);
  if (!list.length) return { updated: 0 };
  const r = await prisma.repOrder.updateMany({
    where: { AND: [{ id: { in: list } }, await orderScopeWhere(viewer)] },
    data: { sentAt: new Date(), sentCount: { increment: 1 }, ...(warehouseId ? { lastSentWarehouseId: Number(warehouseId) } : {}) },
  });
  return { updated: r.count };
}

function removeImageFile(rel) {
  if (!rel) return;
  const file = path.join(INVOICE_DIR, path.basename(rel));
  fs.promises.unlink(file).catch(() => {});
}

export async function deleteOrder(reqUser, id) {
  const viewer = await loadViewer(reqUser);
  const order = await getVisibleOrder(viewer, id);
  if (!canEditContent(viewer, order)) throw new AppError('لا يمكنك حذف هذه الطلبية', 403);
  await prisma.repOrder.delete({ where: { id: order.id } });
  removeImageFile(order.invoiceImage);
  removeImageFile(order.preparedImage);
}

// نوعا الصورة: invoice = ختم الصيدلية يرفقه المندوب مع الطلبية (اسم تاريخي)،
// prepared = فاتورة المذخر بعد التجهيز — رفعها يعني أن الطلبية جُهّزت، فتُعلَّم
// «تم التجهيز» تلقائياً.
export const IMAGE_KINDS = { invoice: 'invoiceImage', prepared: 'preparedImage' };

export async function attachImage(reqUser, id, kind, file) {
  const field = IMAGE_KINDS[kind];
  if (!file) throw new AppError('لا توجد صورة', 400);
  if (!field) { fs.promises.unlink(file.path).catch(() => {}); throw new AppError('نوع صورة غير معروف', 400); }
  const viewer = await loadViewer(reqUser);
  let order;
  try {
    order = await getVisibleOrder(viewer, id);
  } catch (e) {
    fs.promises.unlink(file.path).catch(() => {});
    throw e;
  }
  const url = `/uploads/rep-orders/${path.basename(file.path)}`;
  const data = { [field]: url };
  if (kind === 'prepared') Object.assign(data, { status: 'prepared', preparedAt: new Date(), preparedById: viewer.id });
  await prisma.repOrder.update({ where: { id: order.id }, data });
  removeImageFile(order[field]);
  return { [field]: url };
}

export async function removeImage(reqUser, id, kind) {
  const field = IMAGE_KINDS[kind];
  if (!field) throw new AppError('نوع صورة غير معروف', 400);
  const viewer = await loadViewer(reqUser);
  const order = await getVisibleOrder(viewer, id);
  await prisma.repOrder.update({ where: { id: order.id }, data: { [field]: null } });
  removeImageFile(order[field]);
}

/** صيدليات/مناطق سبق أن كتبها المندوب — اقتراحات للإكمال التلقائي. */
export async function suggestions(reqUser) {
  const viewer = await loadViewer(reqUser);
  const rows = await prisma.repOrder.findMany({
    where: { createdById: viewer.id },
    select: { pharmacyName: true, areaName: true },
    orderBy: { id: 'desc' },
    take: 1500,
  });
  const pharmacies = new Map();
  for (const r of rows) if (!pharmacies.has(r.pharmacyName)) pharmacies.set(r.pharmacyName, r.areaName);
  return { pharmacies: [...pharmacies].map(([name, areaName]) => ({ name, areaName })) };
}
