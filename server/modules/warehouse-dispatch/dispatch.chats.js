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
import { userFeatureOn } from '../../lib/userFeatures.js';
import { campaignParty } from '../whatsapp/wa-chat-log.js';

const ALL_SCOPE_ROLES = new Set(['admin', 'super_admin']);

/**
 * null = كل المحادثات؛ وإلا Map(waId → Set(party)) للمحادثات المسموحة. رقم واحد قد
 * يكون مذخراً لمكتب وزبون حملة لمكتب آخر — كل مدير يرى جهته على الرقم فقط.
 * (party = null — رسائل رقم غير منسوبة — تُرى مع أي جهة مسموحة على الرقم.)
 */
async function visibleNumbers(viewer) {
  if (isFieldRole(viewer.role)) throw new AppError('المحادثات للمدراء فقط', 403);
  if (ALL_SCOPE_ROLES.has(viewer.role)) return null;
  const [whs, links] = await Promise.all([
    prisma.orderWarehouse.findMany({ where: { AND: [await warehouseScopeWhere(viewer), { waId: { not: null } }] }, select: { id: true, waId: true } }),
    prisma.whatsAppChatLink.findMany({ where: { userId: { in: await teamUserIds(viewer) } }, select: { waId: true, userId: true } }),
  ]);
  const m = new Map();
  const add = (waId, party) => {
    if (!waId) return;
    if (!m.has(waId)) m.set(waId, new Set([null]));
    m.get(waId).add(party);
  };
  // زبائن حملات العروض لمكتبه (ردودهم على العرض تُتابَع من هنا)
  if (viewer.officeId) {
    const recips = await prisma.waCampaignRecipient.findMany({
      where: { campaign: { is: { officeId: viewer.officeId, chatsHidden: false } }, sentAt: { gte: new Date(Date.now() - 90 * 86_400_000) } },
      select: { waId: true, name: true },
    });
    for (const r of recips) add(r.waId, campaignParty(r.name));
  }
  for (const l of links) add(l.waId, `acct:${l.userId}`);
  for (const w of whs) add(w.waId, `wh:${w.id}`);
  return m;
}

const canSee = (allowed, waId, party) => !allowed || Boolean(allowed.get(String(waId))?.has(party ?? null));
/** ?party= من الواجهة: '' = غير منسوبة (null)؛ غائب = كل جهات الرقم. */
const partyParam = (v) => (v === undefined ? undefined : (String(v) || null));

/** مُشاهِد من التطبيق: نطاقه حسب دوره، وردّه باسمه. */
export async function userActor(reqUser) {
  const viewer = await loadViewer(reqUser);
  // صفحة اشتراك (wa_chats) — يفعّلها السوبر أدمن لكل حساب من «المميزات»
  const perms = await prisma.user.findUnique({ where: { id: viewer.id }, select: { permissions: true } });
  if (!userFeatureOn(perms, 'wa_chats', { optIn: true })) throw new AppError('صفحة محادثات واتساب غير مفعّلة لحسابك', 403);
  return { allowed: await visibleNumbers(viewer), sender: { id: viewer.id, name: viewer.displayName || viewer.username } };
}

/** الماستر أدمن (لوحة السوبر أدمن، توكن مستقل): كل المحادثات. sentById سالب = ليس User. */
export function masterActor(superAdmin) {
  return { allowed: null, sender: { id: -Math.abs(Number(superAdmin?.id) || 1), name: superAdmin?.username || superAdmin?.name || 'الإدارة' } };
}

/** (waId, party) ⇒ { name, type: 'warehouse' | 'linked' | 'campaign' | 'unknown', account } */
async function describeParties(pairs) {
  const whIds = new Set(), userIds = new Set();
  for (const { party } of pairs) {
    const m = /^(wh|acct):(\d+)$/.exec(party || '');
    if (m) (m[1] === 'wh' ? whIds : userIds).add(Number(m[2]));
  }
  const [whs, users, links] = await Promise.all([
    whIds.size ? prisma.orderWarehouse.findMany({ where: { id: { in: [...whIds] } }, select: { id: true, name: true } }) : [],
    userIds.size ? prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, displayName: true, username: true } }) : [],
    userIds.size ? prisma.whatsAppChatLink.findMany({ where: { userId: { in: [...userIds] } }, select: { waId: true, userId: true, chatTitle: true } }) : [],
  ]);
  const whName = new Map(whs.map(w => [w.id, w.name]));
  const userName = new Map(users.map(u => [u.id, u.displayName || u.username]));
  const title = new Map(links.map(l => [`${l.waId}|${l.userId}`, l.chatTitle]));
  return (waId, party) => {
    const p = party || '';
    if (p.startsWith('wh:')) return { name: whName.get(Number(p.slice(3))) || 'مذخر محذوف', type: 'warehouse', account: null };
    if (p.startsWith('acct:')) {
      const uid = Number(p.slice(5));
      const account = userName.get(uid) || null;
      return { name: title.get(`${waId}|${uid}`) || account || 'حساب', type: 'linked', account };
    }
    if (p.startsWith('c:')) return { name: p.slice(2) || 'زبون حملة', type: 'campaign', account: null };
    return { name: null, type: 'unknown', account: null };
  };
}

export async function listChats(actor, q = {}) {
  const { allowed } = actor;
  const days = Math.min(90, Math.max(1, Number(q.days) || 30));
  const where = { createdAt: { gte: new Date(Date.now() - days * 86_400_000) } };
  if (allowed) where.waId = { in: [...allowed.keys()] };

  // محادثة لكل (رقم × جهة): المذخر وزبون الحملة والحساب على نفس الرقم كلٌّ في محادثته
  let groups = await prisma.waMessageLog.groupBy({
    by: ['waId', 'party'], where, _count: { _all: true }, _max: { id: true, createdAt: true },
  });
  groups = groups.filter(g => canSee(allowed, g.waId, g.party));
  groups.sort((a, b) => b._max.id - a._max.id);
  const top = groups.slice(0, 300);
  const lastIds = top.map(g => g._max.id);
  const [lasts, failed, inbound, describe] = await Promise.all([
    prisma.waMessageLog.findMany({ where: { id: { in: lastIds } } }),
    prisma.waMessageLog.groupBy({ by: ['waId', 'party'], where: { ...where, error: { not: null } }, _count: { _all: true } }),
    prisma.waMessageLog.findMany({ where: { ...where, direction: 'in', contactName: { not: null } }, distinct: ['waId'], orderBy: { id: 'desc' }, select: { waId: true, contactName: true } }),
    describeParties(top),
  ]);
  const key = (g) => `${g.waId}|${g.party || ''}`;
  const lastById = new Map(lasts.map(m => [m.id, m]));
  const failedBy = new Map(failed.map(f => [key(f), f._count._all]));
  const contactBy = new Map(inbound.map(i => [i.waId, i.contactName]));
  const perNumber = new Map();
  for (const g of top) perNumber.set(g.waId, (perNumber.get(g.waId) || 0) + 1);

  return {
    chats: top.map(g => {
      const info = describe(g.waId, g.party);
      const last = lastById.get(g._max.id);
      return {
        key: key(g),
        waId: g.waId,
        party: g.party || '',
        name: info.name || contactBy.get(g.waId) || null,
        type: info.type,
        account: info.account,
        contactName: contactBy.get(g.waId) || null,
        sameNumber: (perNumber.get(g.waId) || 1) - 1, // محادثات أخرى على نفس الرقم
        count: g._count._all,
        failed: failedBy.get(key(g)) || 0,
        lastAt: g._max.createdAt,
        lastText: last?.text || null,
        lastDirection: last?.direction || null,
      };
    }),
  };
}

export async function chatMessages(actor, waId, q = {}) {
  const { allowed } = actor;
  const id = String(waId);
  const party = partyParam(q.party);
  if (allowed && (party === undefined ? !allowed.has(id) : !canSee(allowed, id, party))) throw new AppError('المحادثة غير موجودة', 404);
  const before = Number(q.before) || null;
  // party محدد ⇒ رسائل هذه الجهة فقط؛ مدير بلا party ⇒ جهاته المسموحة على الرقم فقط
  const partyWhere = party !== undefined ? { party }
    : allowed ? { OR: [{ party: null }, { party: { in: [...allowed.get(id)].filter(Boolean) } }] } : {};
  const rows = await prisma.waMessageLog.findMany({
    where: { waId: id, ...partyWhere, ...(before ? { id: { lt: before } } : {}) },
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

export async function sendChatMessage(actor, waId, body = {}) {
  const { allowed } = actor;
  const id = String(waId);
  const party = partyParam(body.party);
  if (allowed && (party === undefined ? !allowed.has(id) : !canSee(allowed, id, party))) throw new AppError('المحادثة غير موجودة', 404);
  if (!whatsappEnabled()) throw new AppError('رقم البوت غير مفعّل', 503);
  const text = String(body.text ?? '').trim();
  if (!text) throw new AppError('اكتب الرسالة', 400);
  if (text.length > 4000) throw new AppError('الرسالة طويلة جداً (الحد 4000 حرف)', 400);
  const w = await windowState(id);
  if (!w.open) throw new AppError('مرّت 24 ساعة على آخر رسالة منه — واتساب لا يسمح بالكتابة له حتى يراسل الرقم أولاً', 409);
  // ردّك يُحفظ في محادثة الجهة المفتوحة (ويصل لنفس الرقم طبعاً)
  const r = await sendRaw(id, { type: 'text', text: { body: text } }, { sentBy: actor.sender, ...(party !== undefined ? { party } : {}) });
  if (r.error) throw new AppError(`لم تُرسل: ${r.error.message}`, 502);
  return { id: r.id };
}

/** صورة واردة — تُنزَّل من واتساب عند الطلب (media id صالح ~30 يوماً). */
export async function chatMedia(actor, logId) {
  const { allowed } = actor;
  const row = await prisma.waMessageLog.findUnique({ where: { id: Number(logId) } });
  if (!row?.mediaId || !canSee(allowed, row.waId, row.party)) throw new AppError('الصورة غير موجودة', 404);
  try {
    return await downloadMedia(row.mediaId);
  } catch {
    throw new AppError('انتهت صلاحية الصورة لدى واتساب', 410);
  }
}
