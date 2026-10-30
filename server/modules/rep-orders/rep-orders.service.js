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
import { normalizeWaId } from '../../lib/waId.js';

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
export async function warehouseScopeWhere(viewer) {
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

// رابط دعوة كروب واتساب أو فايبر — يُقبل بلا https (وواتساب بصيغة /invite/) ويُحفظ بصيغة واحدة
const WA_GROUP_RE = /(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,})/i;
const VIBER_GROUP_RE = /(?:https?:\/\/)?invite\.viber\.com\/\?(g2?)=([A-Za-z0-9%+/=_-]{8,})/i;
const GROUP_LINK_RE = new RegExp(`${WA_GROUP_RE.source}|${VIBER_GROUP_RE.source}`, 'i');

function normalizeGroupLink(raw) {
  const wa = raw.match(WA_GROUP_RE);
  if (wa) return `https://chat.whatsapp.com/${wa[1]}`;
  const vb = raw.match(VIBER_GROUP_RE);
  if (vb) return `https://invite.viber.com/?${vb[1].toLowerCase()}=${vb[2]}`;
  return null;
}

function warehouseData(body) {
  const name = cleanText(body?.name, 120);
  let phone = cleanText(body?.phone, 300) ?? '';
  let rawLink = cleanText(body?.groupLink, 300) ?? '';
  // رابط كروب لُصق في حقل الرقم (نموذج الإضافة السريعة فيه حقل واحد)
  if (!rawLink && GROUP_LINK_RE.test(phone)) { rawLink = phone; phone = ''; }
  if (!name) throw new AppError('اسم المذخر مطلوب', 400);
  const groupLink = rawLink ? normalizeGroupLink(rawLink) : null;
  if (rawLink && !groupLink) throw new AppError('رابط الكروب غير صالح — يقبل روابط كروبات واتساب (chat.whatsapp.com) وفايبر (invite.viber.com)', 400);
  phone = phone.slice(0, 40);
  if (phone && phone.replace(/\D/g, '').length < 7) throw new AppError('رقم واتساب المذخر غير صالح', 400);
  if (!phone && !groupLink) throw new AppError('أدخل رقم واتساب المذخر أو رابط كروبه', 400);
  return {
    name, phone, groupLink,
    waId: phone ? normalizeWaId(phone) || null : null,
    notes: cleanText(body?.notes, 300),
  };
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
// ─── ترقيم مستقل لكل مذخر ─────────────────────────────────────────────────────
// المذخر يرى طلبياته مرقّمة 1، 2، 3… حسب ما وصله هو، لا حسب id الطلبية في التطبيق.
// الرقم يُحفظ على RepOrderSend.whSeq عند أول إرسال للطلبية لذلك المذخر، ويُعاد
// استعماله لأي إرسال لاحق لنفس المذخر.

/** آخر رقم مستعمل لكل مذخر: Map(warehouseId → max whSeq) */
async function maxWhSeqs(db, whIds) {
  const ids = [...new Set(whIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.repOrderSend.groupBy({ by: ['warehouseId'], where: { warehouseId: { in: ids }, whSeq: { not: null } }, _max: { whSeq: true } });
  return new Map(rows.map(r => [r.warehouseId, r._max.whSeq ?? 0]));
}

/** قفل قصير يمنع إرسالين متزامنين لنفس المذخر من أخذ نفس الرقم (Postgres فقط) */
async function lockWhSeq(tx) {
  try { await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(4711001)`); } catch { /* غير Postgres */ }
}

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
      warehouse: { select: { id: true, name: true, phone: true, groupLink: true } },
      sends: { orderBy: { id: 'asc' } },
    },
  });

  // مذاخر الاحتياط وآخر مذخر أُرسلت له — استعلام واحد لكل الطلبيات
  const whIds = [...new Set(rows.flatMap(r => [...r.backupWarehouseIds, r.lastSentWarehouseId]).filter(Boolean))];
  const whRows = whIds.length ? await prisma.orderWarehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, name: true, phone: true, groupLink: true } }) : [];
  const whById = new Map(whRows.map(w => [w.id, w]));
  // الرقم التالي عند كل مذخر — الواجهة تكتبه في نص الإرسال قبل markSent (الذي يحفظه)
  const seqMax = await maxWhSeqs(prisma, rows.flatMap(r => [r.warehouseId, ...r.backupWarehouseIds]));
  const whNextSeq = Object.fromEntries([...new Set(rows.flatMap(r => [r.warehouseId, ...r.backupWarehouseIds]).filter(Boolean))].map(id => [id, (seqMax.get(id) ?? 0) + 1]));

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
    whNextSeq,
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
        r.warehouse ? { id: r.warehouse.id, name: r.warehouse.name, phone: r.warehouse.phone, groupLink: r.warehouse.groupLink } : { id: null, name: r.warehouseName, phone: null, groupLink: null },
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
      // سجل الإرسال للمذاخر بالترتيب ونتيجة كل مذخر
      sends: r.sends.map(s => ({ id: s.id, warehouseId: s.warehouseId, warehouseName: s.warehouseName, sentAt: s.sentAt, outcome: s.outcome, outcomeAt: s.outcomeAt, image: s.image, whSeq: s.whSeq, lines: Array.isArray(s.lines) ? s.lines : [] })),
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
    const updated = await tx.repOrder.update({ where: { id: order.id }, data: { ...head, lines: { create: lines } }, include: { lines: { orderBy: { id: 'asc' } } } });
    // الأسطر أُعيد إنشاؤها ← سجل التجهيز يُربط بها من جديد بالصنف نفسه
    const sends = await tx.repOrderSend.findMany({ where: { orderId: order.id } });
    if (sends.some(s => Array.isArray(s.lines) && s.lines.length)) {
      const newIdByKey = new Map(updated.lines.map(l => [lineKey(l), l.id]));
      const oldKey = new Map(order.lines.map(l => [l.id, lineKey(l)]));
      for (const s of sends) {
        if (!Array.isArray(s.lines) || !s.lines.length) continue;
        const remapped = s.lines
          .map(x => ({ ...x, lineId: newIdByKey.get(oldKey.get(x.lineId) ?? lineKey({ itemName: x.itemName })) }))
          .filter(x => x.lineId);
        await tx.repOrderSend.update({ where: { id: s.id }, data: { lines: remapped } });
        s.lines = remapped;
      }
      await syncPreparedTotals(tx, updated, sends);
    }
    return updated;
  });
}

const lineKey = (l) => (l.itemId ? `i${l.itemId}` : `n${String(l.itemName ?? '').trim().toLowerCase()}`);

/** RepOrderLine.preparedQty/Bonus = مجموع ما جهّزته كل المذاخر. يعيد هل اكتمل تجهيز كل الأسطر. */
async function syncPreparedTotals(tx, order, sends) {
  const recorded = sends.some(s => s.outcome !== 'sent');
  const sum = new Map();
  for (const s of sends) for (const x of (Array.isArray(s.lines) ? s.lines : [])) {
    const t = sum.get(x.lineId) ?? { qty: 0, bonus: 0 };
    t.qty += Number(x.qty) || 0; t.bonus += Number(x.bonus) || 0;
    sum.set(x.lineId, t);
  }
  for (const l of order.lines) {
    const t = sum.get(l.id);
    await tx.repOrderLine.update({
      where: { id: l.id },
      data: recorded ? { preparedQty: t?.qty ?? 0, preparedBonus: t?.bonus ?? 0 } : { preparedQty: null, preparedBonus: null },
    });
  }
  return recorded && order.lines.every(l => (sum.get(l.id)?.qty ?? 0) >= l.quantity);
}

/**
 * يسجّل ما جهّزه مذخر للطلبية (كامل/جزئي/لا شيء) مع فاتورته إن وُجدت.
 * السجل المقصود = آخر إرسال لهذا المذخر (يُصحَّح إن سبق تسجيله)، وإلا يُنشأ —
 * طلبية لم تُعلَّم مُرسلة أو أُرسلت قبل وجود سجل الإرسال.
 * الطلبية تصير «تم التجهيز» فقط حين تكتمل كل أسطرها عبر كل المذاخر.
 * @param {{ warehouseId?:number|null, lines?:{lineId:number, qty?:number, preparedQty?:number, bonus?:number, preparedBonus?:number}[], image?:string|null, invoiceNumber?:string|null }} input
 */
export async function recordPreparation(viewer, orderId, input = {}) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.repOrder.findUnique({ where: { id: Number(orderId) }, include: { lines: { orderBy: { id: 'asc' } }, sends: { orderBy: { id: 'desc' } } } });
    if (!order) throw new AppError('الطلبية غير موجودة', 404);
    const whId = input.warehouseId ? Number(input.warehouseId) : (order.lastSentWarehouseId ?? order.warehouseId);
    let send = order.sends.find(s => s.warehouseId === whId);

    // ما جهّزته المذاخر الأخرى ← المتبقي المطلوب من هذا المذخر
    const prior = new Map();
    for (const s of order.sends) {
      if (s.id === send?.id) continue;
      for (const x of (Array.isArray(s.lines) ? s.lines : [])) prior.set(x.lineId, (prior.get(x.lineId) ?? 0) + (Number(x.qty) || 0));
    }
    const given = new Map((Array.isArray(input.lines) ? input.lines : []).map(x => [Number(x.lineId), x]));
    const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));
    const sendLines = order.lines
      .map(l => { const x = given.get(l.id); return { lineId: l.id, itemName: l.itemName, qty: toInt(x?.qty ?? x?.preparedQty), bonus: toInt(x?.bonus ?? x?.preparedBonus) }; })
      .filter(x => x.qty > 0 || x.bonus > 0);
    const gotQty = new Map(sendLines.map(x => [x.lineId, x.qty]));
    const asked = order.lines.filter(l => l.quantity - (prior.get(l.id) ?? 0) > 0);
    const outcome = !sendLines.length ? 'rejected'
      : asked.every(l => (gotQty.get(l.id) ?? 0) >= l.quantity - (prior.get(l.id) ?? 0)) ? 'prepared' : 'partial';

    const now = new Date();
    const data = { outcome, outcomeAt: now, outcomeById: viewer.id, lines: sendLines, ...(input.image ? { image: input.image } : {}) };
    if (send) {
      if (input.image && send.image && send.image !== input.image && send.image !== order.preparedImage) removeImageFile(send.image);
      send = await tx.repOrderSend.update({ where: { id: send.id }, data });
    } else {
      const w = whId ? await tx.orderWarehouse.findUnique({ where: { id: whId }, select: { name: true } }) : null;
      let whSeq = null;
      if (whId) { await lockWhSeq(tx); whSeq = ((await maxWhSeqs(tx, [whId])).get(whId) ?? 0) + 1; }
      send = await tx.repOrderSend.create({
        data: { orderId: order.id, warehouseId: whId ?? null, warehouseName: w?.name ?? order.warehouseName, sentAt: order.sentAt ?? now, sentById: viewer.id, whSeq, ...data },
      });
    }

    const allSends = order.sends.map(s => (s.id === send.id ? send : s));
    if (!allSends.some(s => s.id === send.id)) allSends.push(send);
    const complete = await syncPreparedTotals(tx, order, allSends);

    await tx.repOrder.update({
      where: { id: order.id },
      data: {
        ...(input.invoiceNumber ? { invoiceNumber: String(input.invoiceNumber).slice(0, 60) } : {}),
        ...(whId ? { lastSentWarehouseId: whId } : {}),
        ...(complete
          ? { status: 'prepared', preparedAt: now, preparedById: viewer.id, preparedImage: input.image ?? order.preparedImage }
          : { status: order.status === 'cancelled' ? 'cancelled' : 'pending', preparedAt: null, preparedById: null }),
      },
    });
    return { outcome, complete, sendId: send.id };
  });
}

export async function prepareOrder(reqUser, id, body, file) {
  const viewer = await loadViewer(reqUser);
  try {
    await getVisibleOrder(viewer, id);
  } catch (e) {
    if (file) fs.promises.unlink(file.path).catch(() => {});
    throw e;
  }
  let lines = body?.lines;
  if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch { lines = []; } }
  return recordPreparation(viewer, id, {
    warehouseId: body?.warehouseId || null,
    lines,
    image: file ? `/uploads/rep-orders/${path.basename(file.path)}` : null,
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
  const orders = await prisma.repOrder.findMany({
    where: { AND: [{ id: { in: list } }, await orderScopeWhere(viewer)] },
    select: { id: true, warehouseId: true, warehouseName: true, sends: { orderBy: { id: 'desc' }, select: { id: true, warehouseId: true, outcome: true, whSeq: true } } },
  });
  if (!orders.length) return { updated: 0 };
  orders.sort((a, b) => list.indexOf(a.id) - list.indexOf(b.id));
  const whId = warehouseId ? Number(warehouseId) : null;
  const w = whId ? await prisma.orderWarehouse.findUnique({ where: { id: whId }, select: { name: true } }) : null;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.repOrder.updateMany({
      where: { id: { in: orders.map(o => o.id) } },
      data: { sentAt: now, sentCount: { increment: 1 }, ...(whId ? { lastSentWarehouseId: whId } : {}) },
    });
    await lockWhSeq(tx);
    const next = await maxWhSeqs(tx, orders.map(o => whId ?? o.warehouseId));
    for (const o of orders) {
      const target = whId ?? o.warehouseId;
      const last = o.sends[0];
      // رقمها عند هذا المذخر إن وصلته سابقاً، وإلا الرقم التالي عنده
      let whSeq = o.sends.find(s => s.warehouseId === target && s.whSeq != null)?.whSeq ?? null;
      if (whSeq == null && target) { whSeq = (next.get(target) ?? 0) + 1; next.set(target, whSeq); }
      // إعادة إرسال لنفس المذخر وهو لم يرد بعد ← نفس السجل
      if (last && last.outcome === 'sent' && last.warehouseId === target) await tx.repOrderSend.update({ where: { id: last.id }, data: { sentAt: now, whSeq } });
      else await tx.repOrderSend.create({ data: { orderId: o.id, warehouseId: target, warehouseName: w?.name ?? o.warehouseName, sentAt: now, sentById: viewer.id, whSeq } });
    }
  });
  return { updated: orders.length };
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
  const sends = await prisma.repOrderSend.findMany({ where: { orderId: order.id }, select: { image: true } });
  await prisma.repOrder.delete({ where: { id: order.id } });
  removeImageFile(order.invoiceImage);
  for (const img of new Set([order.preparedImage, ...sends.map(s => s.image)])) removeImageFile(img);
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

/**
 * إرسالات بلا whSeq (قبل الترقيم المستقل) ← رقم لكل (مذخر، طلبية) حسب أول وصول للطلبية
 * لذلك المذخر، بعد آخر رقم مستعمل عنده. idempotent — يُستدعى عند الإقلاع.
 */
export async function backfillWarehouseSeqs() {
  try {
    const rows = await prisma.repOrderSend.findMany({
      where: { whSeq: null, warehouseId: { not: null } },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      select: { id: true, orderId: true, warehouseId: true },
      take: 20000,
    });
    if (!rows.length) return 0;
    const max = await maxWhSeqs(prisma, rows.map(r => r.warehouseId));
    // طلبية سبق أن أخذت رقماً عند المذخر ← نفس الرقم
    const known = await prisma.repOrderSend.findMany({
      where: { whSeq: { not: null }, warehouseId: { in: [...new Set(rows.map(r => r.warehouseId))] } },
      select: { orderId: true, warehouseId: true, whSeq: true },
    });
    const seqOf = new Map(known.map(k => [`${k.warehouseId}:${k.orderId}`, k.whSeq]));
    const bySeq = new Map();
    for (const r of rows) {
      const key = `${r.warehouseId}:${r.orderId}`;
      if (!seqOf.has(key)) { const n = (max.get(r.warehouseId) ?? 0) + 1; max.set(r.warehouseId, n); seqOf.set(key, n); }
      const n = seqOf.get(key);
      if (!bySeq.has(n)) bySeq.set(n, []);
      bySeq.get(n).push(r.id);
    }
    for (const [n, ids] of bySeq) await prisma.repOrderSend.updateMany({ where: { id: { in: ids } }, data: { whSeq: n } });
    console.log(`✓ rep-orders: ترقيم المذاخر لـ ${rows.length} إرسال قديم`);
    return rows.length;
  } catch (e) {
    console.error('[rep-orders] backfillWarehouseSeqs:', e.message);
    return 0;
  }
}

/**
 * طلبيات أُرسلت قبل وجود سجل الإرسال (rep_order_sends) ← سجل واحد لآخر مذخر أُرسلت له،
 * بنتيجتها الحالية، كي تظهر علامات «أُرسلت» على المذاخر. idempotent — يُستدعى عند الإقلاع.
 */
export async function backfillOrderSends() {
  try {
    const rows = await prisma.repOrder.findMany({
      where: { sentAt: { not: null }, sends: { none: {} } },
      select: { id: true, sentAt: true, warehouseId: true, warehouseName: true, lastSentWarehouseId: true, status: true, preparedAt: true, preparedById: true, preparedImage: true, createdById: true, lines: { select: { id: true, itemName: true, preparedQty: true, preparedBonus: true } } },
      take: 5000,
    });
    if (!rows.length) return 0;
    const whIds = [...new Set(rows.map(r => r.lastSentWarehouseId).filter(Boolean))];
    const whs = whIds.length ? await prisma.orderWarehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, name: true } }) : [];
    const whName = new Map(whs.map(w => [w.id, w.name]));
    await prisma.repOrderSend.createMany({
      data: rows.map(r => {
        const whId = r.lastSentWarehouseId ?? r.warehouseId;
        const lines = r.lines.filter(l => (l.preparedQty ?? 0) > 0 || (l.preparedBonus ?? 0) > 0).map(l => ({ lineId: l.id, itemName: l.itemName, qty: l.preparedQty ?? 0, bonus: l.preparedBonus ?? 0 }));
        const prepared = r.status === 'prepared';
        return {
          orderId: r.id, warehouseId: whId, warehouseName: whName.get(whId) ?? r.warehouseName, sentAt: r.sentAt, sentById: r.createdById,
          outcome: prepared ? 'prepared' : 'sent',
          ...(prepared ? { outcomeAt: r.preparedAt ?? r.sentAt, outcomeById: r.preparedById, image: r.preparedImage, lines } : {}),
        };
      }),
    });
    console.log(`✓ rep-orders: سجل إرسال لـ ${rows.length} طلبية قديمة`);
    return rows.length;
  } catch (e) {
    console.error('[rep-orders] backfillOrderSends:', e.message);
    return 0;
  }
}
