import prisma from '../../lib/prisma.js';
import { ORDER_TEXT_MODES, DEFAULT_ORDER_TEXT_MODE } from '../orders/order-trigger.js';

// قائمة بيضاء لا تمرير حرّ — قيمة مكتوبة خطأً كانت ستُخزَّن بهدوء ويرتدّ بها
// isOrderTrigger إلى 'trigger'، فيظنّ الأدمن أنه فعّل «كل الرسائل» وهو لم يفعّل.
const pickOrderTextMode = (v) => (ORDER_TEXT_MODES.includes(v) ? v : null);

// ── List all receiver↔user links ────────────────────────────────────────
export async function listLinks(req, res) {
  const links = await prisma.viberChatLink.findMany({
    include: { user: { select: { id: true, username: true, displayName: true, role: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: links });
}

// ── Create a link (admin pastes the receiver id the bot replied with) ──
export async function createLink(req, res) {
  const { receiverId, chatTitle, userId, orderTextMode } = req.body;
  if (!receiverId || !userId) return res.status(400).json({ error: 'receiverId و userId مطلوبان' });

  let mode = DEFAULT_ORDER_TEXT_MODE;
  if (orderTextMode !== undefined) {
    mode = pickOrderTextMode(orderTextMode);
    if (!mode) return res.status(400).json({ error: `orderTextMode يجب أن يكون أحد: ${ORDER_TEXT_MODES.join(' | ')}` });
  }

  const link = await prisma.viberChatLink.create({
    data: {
      receiverId: String(receiverId), chatTitle: chatTitle || null,
      userId: parseInt(userId), orderTextMode: mode,
    },
  });
  res.status(201).json({ success: true, data: link });
}

// ── Update a link (label / active toggle / mode / re-point) ────────────
export async function updateLink(req, res) {
  const id = parseInt(req.params.id);
  const { chatTitle, isActive, userId, orderTextMode } = req.body;

  const data = {};
  if (chatTitle !== undefined) data.chatTitle = chatTitle;
  if (isActive  !== undefined) data.isActive  = Boolean(isActive);
  if (userId    !== undefined) data.userId    = parseInt(userId);
  if (orderTextMode !== undefined) {
    const mode = pickOrderTextMode(orderTextMode);
    if (!mode) return res.status(400).json({ error: `orderTextMode يجب أن يكون أحد: ${ORDER_TEXT_MODES.join(' | ')}` });
    data.orderTextMode = mode;
  }

  const link = await prisma.viberChatLink.update({ where: { id }, data });
  res.json({ success: true, data: link });
}

// ── Delete a link ────────────────────────────────────────────────────────
export async function deleteLink(req, res) {
  const id = parseInt(req.params.id);
  await prisma.viberChatLink.delete({ where: { id } });
  res.json({ success: true });
}
