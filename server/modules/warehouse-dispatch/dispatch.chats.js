// ════════════════════════════════════════════════════════════════════════════
// dispatch.chats.js — تبويب «المحادثات»: ما دار بين رقم البوت الرسمي والمندوبين
// والمذاخر (السجلّ يكتبه whatsapp/wa-chat-log.js).
//
// النطاق:
//  • admin / super_admin (مالك التطبيق) — كل المحادثات، بما فيها أرقام غير مربوطة.
//  • المدير — محادثات مذاخره (نفس نطاق «المذاخر») + الأرقام المربوطة بحسابه أو فريقه.
//  • المندوب — لا شيء (هذا للمراقبة الإدارية).
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { isFieldRole } from '../../lib/surveyDoctors.js';
import { loadViewer, warehouseScopeWhere, teamUserIds } from '../rep-orders/rep-orders.service.js';
import { downloadMedia, sendRaw, whatsappEnabled } from '../whatsapp/whatsapp.service.js';

const ALL_SCOPE_ROLES = new Set(['admin', 'super_admin']);

/** null = كل الأرقام؛ وإلا Map(waId → { name, type }) للأرقام المسموحة. */
async function visibleNumbers(viewer) {
  if (isFieldRole(viewer.role)) throw new AppError('المحادثات للمدراء فقط', 403);
  if (ALL_SCOPE_ROLES.has(viewer.role)) return null;
  const [whs, links] = await Promise.all([
    prisma.orderWarehouse.findMany({ where: { AND: [await warehouseScopeWhere(viewer), { waId: { not: null } }] }, select: { waId: true, name: true } }),
    prisma.whatsAppChatLink.findMany({ where: { userId: { in: await teamUserIds(viewer) } }, select: { waId: true } }),
  ]);
  const m = new Map();
  for (const l of links) m.set(l.waId, null);
  for (const w of whs) if (w.waId) m.set(w.waId, null);
  return m;
}

/** waId ⇒ { name, type: 'warehouse' | 'linked' | 'unknown', account } */
async function describeNumbers(waIds) {
  if (!waIds.length) return new Map();
  const [whs, links] = await Promise.all([
    prisma.orderWarehouse.findMany({ where: { waId: { in: waIds } }, select: { waId: true, name: true } }),
    prisma.whatsAppChatLink.findMany({ where: { waId: { in: waIds } }, select: { waId: true, chatTitle: true, user: { select: { displayName: true, username: true } } } }),
  ]);
  const out = new Map();
  for (const l of links) {
    const account = l.user?.displayName || l.user?.username || null;
    out.set(l.waId, { name: l.chatTitle || account, type: 'linked', account });
  }
  for (const w of whs) out.set(w.waId, { name: w.name, type: 'warehouse', account: null });
  return out;
}

export async function listChats(reqUser, q = {}) {
  const viewer = await loadViewer(reqUser);
  const allowed = await visibleNumbers(viewer);
  const days = Math.min(90, Math.max(1, Number(q.days) || 30));
  const where = { createdAt: { gte: new Date(Date.now() - days * 86_400_000) } };
  if (allowed) where.waId = { in: [...allowed.keys()] };

  const groups = await prisma.waMessageLog.groupBy({
    by: ['waId'], where, _count: { _all: true }, _max: { id: true, createdAt: true },
  });
  groups.sort((a, b) => b._max.id - a._max.id);
  const top = groups.slice(0, 300);
  const lastIds = top.map(g => g._max.id);
  const [lasts, failed, inbound, names] = await Promise.all([
    prisma.waMessageLog.findMany({ where: { id: { in: lastIds } } }),
    prisma.waMessageLog.groupBy({ by: ['waId'], where: { ...where, error: { not: null } }, _count: { _all: true } }),
    prisma.waMessageLog.findMany({ where: { ...where, direction: 'in', contactName: { not: null } }, distinct: ['waId'], orderBy: { id: 'desc' }, select: { waId: true, contactName: true } }),
    describeNumbers(top.map(g => g.waId)),
  ]);
  const lastById = new Map(lasts.map(m => [m.id, m]));
  const failedBy = new Map(failed.map(f => [f.waId, f._count._all]));
  const contactBy = new Map(inbound.map(i => [i.waId, i.contactName]));

  return {
    chats: top.map(g => {
      const info = names.get(g.waId);
      const last = lastById.get(g._max.id);
      return {
        waId: g.waId,
        name: info?.name || contactBy.get(g.waId) || null,
        type: info?.type || 'unknown',
        account: info?.account || null,
        contactName: contactBy.get(g.waId) || null,
        count: g._count._all,
        failed: failedBy.get(g.waId) || 0,
        lastAt: g._max.createdAt,
        lastText: last?.text || null,
        lastDirection: last?.direction || null,
      };
    }),
  };
}

export async function chatMessages(reqUser, waId, q = {}) {
  const viewer = await loadViewer(reqUser);
  const allowed = await visibleNumbers(viewer);
  const id = String(waId);
  if (allowed && !allowed.has(id)) throw new AppError('المحادثة غير موجودة', 404);
  const before = Number(q.before) || null;
  const rows = await prisma.waMessageLog.findMany({
    where: { waId: id, ...(before ? { id: { lt: before } } : {}) },
    orderBy: { id: 'desc' }, take: 200,
  });
  return { messages: rows.reverse(), hasMore: rows.length === 200, window: await windowState(id) };
}

// ─── الردّ اليدوي ────────────────────────────────────────────────────────────
// واتساب يسمح بالرسالة الحرّة فقط خلال 24 ساعة من آخر رسالة كتبها الطرف الآخر
// (وهي مجانية). خارجها يلزم قالب معتمد مدفوع — الردّ اليدوي لا يرسل قوالب.
const WINDOW_MS = 24 * 60 * 60 * 1000;

async function windowState(waId) {
  const [lastIn, wh] = await Promise.all([
    prisma.waMessageLog.findFirst({ where: { waId, direction: 'in' }, orderBy: { id: 'desc' }, select: { createdAt: true } }),
    prisma.orderWarehouse.findFirst({ where: { waId, waLastInboundAt: { not: null } }, orderBy: { waLastInboundAt: 'desc' }, select: { waLastInboundAt: true } }),
  ]);
  const times = [lastIn?.createdAt, wh?.waLastInboundAt].filter(Boolean).map(d => new Date(d).getTime());
  const last = times.length ? Math.max(...times) : null;
  const closesAt = last ? last + WINDOW_MS : null;
  return { open: Boolean(closesAt && closesAt > Date.now()), lastInboundAt: last ? new Date(last) : null, closesAt: closesAt ? new Date(closesAt) : null };
}

export async function sendChatMessage(reqUser, waId, body = {}) {
  const viewer = await loadViewer(reqUser);
  const allowed = await visibleNumbers(viewer);
  const id = String(waId);
  if (allowed && !allowed.has(id)) throw new AppError('المحادثة غير موجودة', 404);
  if (!whatsappEnabled()) throw new AppError('رقم البوت غير مفعّل', 503);
  const text = String(body.text ?? '').trim();
  if (!text) throw new AppError('اكتب الرسالة', 400);
  if (text.length > 4000) throw new AppError('الرسالة طويلة جداً (الحد 4000 حرف)', 400);
  const w = await windowState(id);
  if (!w.open) throw new AppError('مرّت 24 ساعة على آخر رسالة منه — واتساب لا يسمح بالكتابة له حتى يراسل الرقم أولاً', 409);
  const name = viewer.displayName || viewer.username;
  const r = await sendRaw(id, { type: 'text', text: { body: text } }, { sentBy: { id: viewer.id, name } });
  if (r.error) throw new AppError(`لم تُرسل: ${r.error.message}`, 502);
  return { id: r.id };
}

/** صورة واردة — تُنزَّل من واتساب عند الطلب (media id صالح ~30 يوماً). */
export async function chatMedia(reqUser, logId) {
  const viewer = await loadViewer(reqUser);
  const allowed = await visibleNumbers(viewer);
  const row = await prisma.waMessageLog.findUnique({ where: { id: Number(logId) } });
  if (!row?.mediaId || (allowed && !allowed.has(row.waId))) throw new AppError('الصورة غير موجودة', 404);
  try {
    return await downloadMedia(row.mediaId);
  } catch {
    throw new AppError('انتهت صلاحية الصورة لدى واتساب', 410);
  }
}
