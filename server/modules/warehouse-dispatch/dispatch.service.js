// ════════════════════════════════════════════════════════════════════════════
// dispatch.service.js — واجهة صفحة «إرسال للمذاخر»: القائمة، الإرسال/التحويل/
// الإلغاء، إعداد قناة كل مذخر وبدائله، ووضع الإرسال لكل حساب.
// النطاق نفس «طلبيات المذاخر» (orderScopeWhere / warehouseScopeWhere).
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { isFieldRole } from '../../lib/surveyDoctors.js';
import { isOfficeScopedRole } from '../../lib/officeScope.js';
import { getManagerRoster } from '../../lib/managerRoster.js';
import { normalizeWaId } from '../../lib/waId.js';
import { loadViewer, orderScopeWhere, warehouseScopeWhere, getVisibleOrder, markSent } from '../rep-orders/rep-orders.service.js';
import { whatsappEnabled } from '../whatsapp/whatsapp.service.js';
import { groupsConfigured, sidecar } from '../wa-groups/wa-groups.client.js';
import {
  MODES, PRE_SEND, getConfig, sendDispatch, applyAction, forwardToWarehouse, warehouseReady,
} from './dispatch.core.js';

const ALL_SCOPE_ROLES = new Set(['admin', 'super_admin']);
const CHANNELS = ['cloud', 'group', 'manual'];
const MAX_LINES = 80;
const WINDOW_MS = 23 * 60 * 60 * 1000;

const canManage = (viewer) => !isFieldRole(viewer.role);
function requireManager(viewer) {
  if (!canManage(viewer)) throw new AppError('هذا الإجراء للمدراء فقط', 403);
}

async function getVisibleDispatch(viewer, id) {
  const d = await prisma.warehouseDispatch.findFirst({ where: { AND: [{ id: Number(id) }, await orderScopeWhere(viewer)] } });
  if (!d) throw new AppError('الطلبية غير موجودة', 404);
  return d;
}

async function getVisibleWarehouse(viewer, id) {
  const w = await prisma.orderWarehouse.findFirst({ where: { AND: [{ id: Number(id) }, await warehouseScopeWhere(viewer)] } });
  if (!w) throw new AppError('المذخر غير موجود', 404);
  return w;
}

const userName = (u) => (u ? (u.displayName || u.username) : null);

// ─── القائمة ─────────────────────────────────────────────────────────────────

/** @param {{ days?: string, status?: string }} q */
export async function listDispatches(reqUser, q = {}) {
  const viewer = await loadViewer(reqUser);
  const days = Math.min(90, Math.max(1, Number(q.days) || 7));
  const since = new Date(Date.now() - days * 86_400_000);
  const where = { AND: [await orderScopeWhere(viewer), { createdAt: { gte: since } }] };
  const rows = await prisma.warehouseDispatch.findMany({ where, orderBy: { id: 'desc' }, take: 800 });

  const userIds = [...new Set(rows.flatMap(r => [r.createdById, r.sentById].filter(Boolean)))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, username: true } }) : [];
  const nameById = new Map(users.map(u => [u.id, userName(u)]));

  const month = new Date().toISOString().slice(0, 7);
  const counters = await prisma.waMessageCounter.findMany({ where: { month } });
  const count = (k) => counters.find(c => c.kind === k)?.count || 0;

  return {
    dispatches: rows.map(r => ({ ...r, accountName: nameById.get(r.createdById) || null, sentByName: nameById.get(r.sentById) || null })),
    canManage: canManage(viewer),
    usage: { month, service: count('service'), template: count('template'), group: count('group'), freeServiceTier: 1000 },
    channels: { cloud: whatsappEnabled(), groups: groupsConfigured() },
  };
}

// ─── تعديل وإرسال ────────────────────────────────────────────────────────────

function cleanLines(lines) {
  if (!Array.isArray(lines)) return null;
  const out = lines.slice(0, MAX_LINES).map(l => ({
    item: String(l?.item ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    quantity: Math.max(0, Math.round(Number(l?.quantity) || 0)),
    bonus: Math.max(0, Math.round(Number(l?.bonus) || 0)),
  })).filter(l => l.item);
  if (!out.length) throw new AppError('الطلبية بلا أصناف', 400);
  return out;
}

export async function updateDispatch(reqUser, id, body = {}) {
  const viewer = await loadViewer(reqUser);
  const d = await getVisibleDispatch(viewer, id);
  if (!PRE_SEND.includes(d.status)) throw new AppError('أُرسلت الطلبية — استعمل «تحويل لمذخر آخر»', 409);
  const data = {};
  if (body.warehouseId !== undefined) {
    if (!canManage(viewer) && d.createdById !== viewer.id) throw new AppError('لا يمكنك تغيير المذخر', 403);
    const w = body.warehouseId ? await getVisibleWarehouse(viewer, body.warehouseId) : null;
    Object.assign(data, { warehouseId: w?.id ?? null, warehouseName: w?.name ?? d.requestedWarehouse });
    data.status = warehouseReady(w) ? 'awaiting_approval' : 'needs_warehouse';
    data.error = null;
  }
  if (body.lines !== undefined) data.lines = cleanLines(body.lines);
  if (body.notes !== undefined) data.notes = String(body.notes ?? '').trim().slice(0, 500) || null;
  if (body.pharmacyName !== undefined) data.pharmacyName = String(body.pharmacyName ?? '').trim().slice(0, 200) || null;
  return prisma.warehouseDispatch.update({ where: { id: d.id }, data });
}

export async function sendNow(reqUser, id, body = {}) {
  const viewer = await loadViewer(reqUser);
  requireManager(viewer);
  let d = await getVisibleDispatch(viewer, id);
  if (d.status === 'cancelled') throw new AppError('الطلبية ملغاة', 409);
  if (body.warehouseId && Number(body.warehouseId) !== d.warehouseId) {
    if (!PRE_SEND.includes(d.status)) return forwardNow(reqUser, id, body);
    d = await updateDispatch(reqUser, id, { warehouseId: body.warehouseId });
  }
  return sendDispatch(d, { byUserId: viewer.id });
}

export async function forwardNow(reqUser, id, body = {}) {
  const viewer = await loadViewer(reqUser);
  requireManager(viewer);
  const d = await getVisibleDispatch(viewer, id);
  const w = await getVisibleWarehouse(viewer, body.warehouseId);
  if (w.id === d.warehouseId) return sendDispatch(d, { byUserId: viewer.id });
  return forwardToWarehouse(d, w.id, { byUserId: viewer.id });
}

/** تعليم يدوي (المذخر ردّ هاتفياً مثلاً) أو إلغاء. */
export async function setManualStatus(reqUser, id, body = {}) {
  const viewer = await loadViewer(reqUser);
  requireManager(viewer);
  const d = await getVisibleDispatch(viewer, id);
  const status = String(body.status || '');
  if (status === 'cancelled') return prisma.warehouseDispatch.update({ where: { id: d.id }, data: { status: 'cancelled' } });
  if (!['prepared', 'partial', 'rejected'].includes(status)) throw new AppError('حالة غير معروفة', 400);
  return applyAction(d.id, status, { reason: body.reason || null, via: 'manual' });
}

export async function deleteDispatch(reqUser, id) {
  const viewer = await loadViewer(reqUser);
  requireManager(viewer);
  const d = await getVisibleDispatch(viewer, id);
  if (!PRE_SEND.includes(d.status) && d.status !== 'cancelled') throw new AppError('لا يمكن حذف طلبية أُرسلت — ألغها بدلاً من ذلك', 409);
  await prisma.warehouseDispatch.delete({ where: { id: d.id } });
}

/** «طلبيات المذاخر» ⇒ إرسال عبر البوت (بدل wa.me). */
export async function sendRepOrder(reqUser, repOrderId, body = {}) {
  const viewer = await loadViewer(reqUser);
  const o = await getVisibleOrder(viewer, repOrderId);
  const warehouseId = Number(body.warehouseId) || o.warehouseId;
  if (!warehouseId) throw new AppError('حدّد المذخر أولاً', 400);
  const w = await getVisibleWarehouse(viewer, warehouseId);
  if (!warehouseReady(w)) throw new AppError('المذخر غير مضبوط للإرسال الآلي (رقم/كروب) — اضبطه من صفحة «إرسال للمذاخر»', 400);
  const creator = await prisma.user.findUnique({ where: { id: o.createdById }, select: { displayName: true, username: true } });
  const d = await prisma.warehouseDispatch.create({
    data: {
      officeId: o.officeId, createdById: o.createdById, source: 'rep-order', repOrderId: o.id,
      repName: userName(creator), pharmacyName: o.pharmacyName, areaName: o.areaName,
      requestedWarehouse: o.warehouseName, warehouseId: w.id, warehouseName: w.name,
      lines: o.lines.map(l => ({ item: l.itemName, quantity: l.quantity, bonus: l.bonusQty })),
      notes: o.notes, status: 'awaiting_approval',
    },
  });
  const sent = await sendDispatch(d, { byUserId: viewer.id });
  // نفس تعليم «أُرسلت» في الصفحة ⇒ سجل إرسال للمذخر يتلقّى تصويت/رد الكروب لاحقاً
  if (sent?.status === 'sent') await markSent(reqUser, o.id, w.id);
  return sent;
}

// ─── المذاخر ─────────────────────────────────────────────────────────────────

export async function listWarehouses(reqUser) {
  const viewer = await loadViewer(reqUser);
  const rows = await prisma.orderWarehouse.findMany({ where: await warehouseScopeWhere(viewer), orderBy: { name: 'asc' } });
  return rows.map(w => ({
    id: w.id, name: w.name, phone: w.phone, channel: w.channel, groupJid: w.groupJid, groupName: w.groupName,
    backupWarehouseIds: w.backupWarehouseIds, waLastInboundAt: w.waLastInboundAt,
    windowOpen: Boolean(w.waLastInboundAt && Date.now() - new Date(w.waLastInboundAt).getTime() < WINDOW_MS),
    ready: warehouseReady(w),
  }));
}

export async function updateWarehouseDispatch(reqUser, id, body = {}) {
  const viewer = await loadViewer(reqUser);
  requireManager(viewer);
  const w = await getVisibleWarehouse(viewer, id);
  const data = {};
  if (body.channel !== undefined) {
    if (!CHANNELS.includes(body.channel)) throw new AppError('قناة غير معروفة', 400);
    data.channel = body.channel;
  }
  if (body.groupJid !== undefined) {
    const jid = String(body.groupJid || '').trim();
    if (jid && !/@g\.us$/.test(jid)) throw new AppError('معرّف كروب غير صالح', 400);
    data.groupJid = jid || null;
    data.groupName = String(body.groupName || '').trim().slice(0, 120) || null;
  }
  if (body.backupWarehouseIds !== undefined) {
    const ids = [...new Set((Array.isArray(body.backupWarehouseIds) ? body.backupWarehouseIds : []).map(Number).filter(n => n > 0 && n !== w.id))].slice(0, 5);
    if (ids.length) {
      const visible = await prisma.orderWarehouse.findMany({ where: { AND: [{ id: { in: ids } }, await warehouseScopeWhere(viewer)] }, select: { id: true } });
      const ok = new Set(visible.map(v => v.id));
      data.backupWarehouseIds = ids.filter(i => ok.has(i));
    } else data.backupWarehouseIds = [];
  }
  return prisma.orderWarehouse.update({ where: { id: w.id }, data });
}

// ─── الإعدادات ───────────────────────────────────────────────────────────────

/** الحسابات التي يضبط المُشاهِد وضعها: فريقه + مكتبه (الأدوار المكتبية) + الكل للأدمن. */
async function settingsUserIds(viewer) {
  if (ALL_SCOPE_ROLES.has(viewer.role)) return null;
  const ids = new Set([viewer.id]);
  const roster = await getManagerRoster(viewer, { includeTeamLead: true });
  for (const r of roster.reps) ids.add(r.userId);
  if (isOfficeScopedRole(viewer.role) && viewer.officeId) {
    const office = await prisma.user.findMany({ where: { officeId: viewer.officeId }, select: { id: true } });
    office.forEach(u => ids.add(u.id));
  }
  return [...ids];
}

export async function getSettings(reqUser) {
  const viewer = await loadViewer(reqUser);
  requireManager(viewer);
  const ids = await settingsUserIds(viewer);
  const users = await prisma.user.findMany({
    where: { isActive: true, ...(ids ? { id: { in: ids } } : {}), role: { not: 'super_admin' } },
    select: { id: true, displayName: true, username: true, role: true },
    orderBy: { displayName: 'asc' },
    take: 1000,
  });
  const modes = await prisma.warehouseDispatchSetting.findMany({ where: { userId: { in: users.map(u => u.id) } } });
  const modeById = new Map(modes.map(m => [m.userId, m.mode]));
  return {
    users: users.map(u => ({ id: u.id, name: userName(u), role: u.role, mode: modeById.get(u.id) || 'off' })),
    config: await getConfig(),
    canEditConfig: ALL_SCOPE_ROLES.has(viewer.role) || ['manager', 'office_manager'].includes(viewer.role),
    templateName: process.env.WHATSAPP_DISPATCH_TEMPLATE || 'new_order',
  };
}

export async function setUserMode(reqUser, userId, mode) {
  const viewer = await loadViewer(reqUser);
  requireManager(viewer);
  if (!MODES.includes(mode)) throw new AppError('وضع غير معروف', 400);
  const ids = await settingsUserIds(viewer);
  if (ids && !ids.includes(Number(userId))) throw new AppError('هذا الحساب خارج نطاقك', 403);
  return prisma.warehouseDispatchSetting.upsert({
    where: { userId: Number(userId) },
    create: { userId: Number(userId), mode },
    update: { mode },
  });
}

export async function setConfig(reqUser, body = {}) {
  const viewer = await loadViewer(reqUser);
  if (!(ALL_SCOPE_ROLES.has(viewer.role) || ['manager', 'office_manager'].includes(viewer.role))) throw new AppError('للمدير العام فقط', 403);
  const data = {};
  if (body.responseTimeoutMin !== undefined) data.responseTimeoutMin = Math.min(24 * 60, Math.max(10, Math.round(Number(body.responseTimeoutMin) || 120)));
  if (body.autoBackup !== undefined) data.autoBackup = Boolean(body.autoBackup);
  return prisma.warehouseDispatchConfig.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
}

// ─── رقم الكروبات ────────────────────────────────────────────────────────────

export async function listGroups(reqUser) {
  const viewer = await loadViewer(reqUser);
  requireManager(viewer);
  const r = await sidecar('/groups');
  if (r.error) return { groups: [], error: r.error };
  return { groups: r.data?.groups || [] };
}

/** ترحيل كسول: مذاخر قديمة بلا waId مطبَّع (قبل الإرسال الآلي). */
export async function backfillWarehouseWaIds() {
  try {
    const rows = await prisma.orderWarehouse.findMany({ where: { waId: null }, select: { id: true, phone: true } });
    for (const r of rows) {
      const waId = normalizeWaId(r.phone);
      if (waId) await prisma.orderWarehouse.update({ where: { id: r.id }, data: { waId } });
    }
  } catch (e) {
    console.error('[dispatch] ترحيل أرقام المذاخر:', e?.message);
  }
}
