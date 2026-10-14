import prisma from '../../lib/prisma.js';
import { listOfficeScientificReps } from '../orders/orders.service.js';
import { invalidateSilentCache, getChatMembersInfo } from './telegram.service.js';
import { ORDER_TEXT_MODES, DEFAULT_ORDER_TEXT_MODE } from '../orders/order-trigger.js';

// قائمة بيضاء لا تمرير حرّ: قيمة مكتوبة خطأً («trigerr») كانت ستُخزَّن بهدوء،
// وisOrderTrigger يرتدّ بها إلى 'trigger' — فيظنّ الأدمن أنه فعّل وضع «كل
// الرسائل» وهو لم يفعّل شيئاً. الرفض الصريح أفضل من ارتداد صامت.
const pickOrderTextMode = (v) => (ORDER_TEXT_MODES.includes(v) ? v : null);

/**
 * يُطبّع رقم الكروب المُلصَق. معرّفات الكروبات/السوبرغروب في تلكرام تبدأ بـ«-100»
 * وطولها 13 رقماً، والنقر المزدوج على الرقم في المحادثة يُظلّل الأرقام وحدها
 * فتسقط الإشارة — فيبدو الكروب مربوطاً في اللوحة ولا تُقرأ فيه طلبية واحدة.
 * نُعيد الإشارة حين يكون الشكل قاطعاً فقط؛ أرقام المحادثات الخاصة (موجبة وأقصر)
 * لا تُمسّ.
 */
const normalizeChatId = (v) => {
  const s = String(v ?? '').trim().replace(/[\u200e\u200f\s]/g, '');
  return /^100[0-9]{10,}$/.test(s) ? `-${s}` : s;
};

// ── List all chat↔user links ────────────────────────────────────────────
export async function listLinks(req, res) {
  const links = await prisma.telegramChatLink.findMany({
    include: { user: { select: { id: true, username: true, displayName: true, role: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: links });
}

// ── Create a link (admin pastes the chat_id the bot replied with) ──────
export async function createLink(req, res) {
  const { chatId, chatTitle, userId, orderTextMode, salesQueryEnabled, silentMode } = req.body;
  if (!chatId || !userId) return res.status(400).json({ error: 'chatId و userId مطلوبان' });

  let mode = DEFAULT_ORDER_TEXT_MODE;
  if (orderTextMode !== undefined) {
    mode = pickOrderTextMode(orderTextMode);
    if (!mode) return res.status(400).json({ error: `orderTextMode يجب أن يكون أحد: ${ORDER_TEXT_MODES.join(' | ')}` });
  }

  const link = await prisma.telegramChatLink.create({
    data: {
      chatId: normalizeChatId(chatId), chatTitle: chatTitle || null,
      userId: parseInt(userId), orderTextMode: mode,
      ...(salesQueryEnabled !== undefined ? { salesQueryEnabled: Boolean(salesQueryEnabled) } : {}),
      ...(silentMode !== undefined ? { silentMode: Boolean(silentMode) } : {}),
    },
  });
  res.status(201).json({ success: true, data: link });
}

// ── Update a link (label / active toggle / re-point to another user) ───
export async function updateLink(req, res) {
  const id = parseInt(req.params.id);
  const { chatTitle, isActive, userId, orderTextMode, salesQueryEnabled, silentMode } = req.body;

  const data = {};
  if (chatTitle !== undefined) data.chatTitle = chatTitle;
  if (isActive  !== undefined) data.isActive  = Boolean(isActive);
  if (userId    !== undefined) data.userId    = parseInt(userId);
  if (orderTextMode !== undefined) {
    const mode = pickOrderTextMode(orderTextMode);
    if (!mode) return res.status(400).json({ error: `orderTextMode يجب أن يكون أحد: ${ORDER_TEXT_MODES.join(' | ')}` });
    data.orderTextMode = mode;
  }
  if (salesQueryEnabled !== undefined) data.salesQueryEnabled = Boolean(salesQueryEnabled);
  if (silentMode !== undefined) data.silentMode = Boolean(silentMode);

  const link = await prisma.telegramChatLink.update({ where: { id }, data });
  invalidateSilentCache(link.chatId);
  res.json({ success: true, data: link });
}

// ── Delete a link ────────────────────────────────────────────────────────
export async function deleteLink(req, res) {
  const id = parseInt(req.params.id);
  await prisma.telegramChatLink.delete({ where: { id } });
  res.json({ success: true });
}

// ── Members seen in a chat + admins + member count ───────────────────────
export async function listMembers(req, res) {
  const link = await prisma.telegramChatLink.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!link) return res.status(404).json({ error: 'الربط غير موجود' });
  const [info, reps] = await Promise.all([getChatMembersInfo(link.chatId), listOfficeScientificReps(link.userId)]);
  res.json({ success: true, data: { ...info, reps } });
}

// ── Link a telegram person to a scientific rep (userId=null to unlink) ───
export async function setMemberRep(req, res) {
  const link = await prisma.telegramChatLink.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!link) return res.status(404).json({ error: 'الربط غير موجود' });
  const telegramUserId = String(req.params.telegramUserId);
  const { userId, firstName, lastName, username } = req.body;

  let linkedUserId = null;
  if (userId != null && userId !== '') {
    const allowed = await listOfficeScientificReps(link.userId);
    linkedUserId = parseInt(userId);
    if (!allowed.some(r => r.id === linkedUserId)) return res.status(400).json({ error: 'المندوب ليس من مندوبي هذا المكتب' });
  }

  await prisma.telegramChatMember.upsert({
    where: { chatId_telegramUserId: { chatId: link.chatId, telegramUserId } },
    update: { linkedUserId },
    create: { chatId: link.chatId, telegramUserId, firstName: firstName || null, lastName: lastName || null, username: username || null, linkedUserId },
  });
  // الشخص واحد عبر كل كروباته
  await prisma.telegramChatMember.updateMany({ where: { telegramUserId }, data: { linkedUserId } });
  res.json({ success: true });
}
