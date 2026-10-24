import prisma from '../../lib/prisma.js';
import { ORDER_TEXT_MODES, DEFAULT_ORDER_TEXT_MODE } from '../orders/order-trigger.js';

// قائمة بيضاء لا تمرير حرّ — قيمة مكتوبة خطأً كانت ستُخزَّن بهدوء ويرتدّ بها
// isOrderTrigger إلى 'trigger'، فيظنّ الأدمن أنه فعّل «كل الرسائل» وهو لم يفعّل.
const pickOrderTextMode = (v) => (ORDER_TEXT_MODES.includes(v) ? v : null);

// واتساب يرسل wa_id أرقاماً دولية بلا «+» (9647701234567). الأدمن يكتب الرقم كما
// يعرفه («0770 123 4567» أو «+964 770…») — نوحّده وإلا لن يطابق أي رسالة أبداً.
const normalizeWaId = (v) => {
  let d = String(v ?? '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660)).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^07\d{9}$/.test(d)) d = '964' + d.slice(1); // رقم عراقي محلي
  return d;
};

// ── List all number↔user links ────────────────────────────────────────
export async function listLinks(req, res) {
  const links = await prisma.whatsAppChatLink.findMany({
    include: { user: { select: { id: true, username: true, displayName: true, role: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: links });
}

// ── Create a link (admin pastes the wa_id (phone) the bot replied with) ──
export async function createLink(req, res) {
  const { waId, chatTitle, userId, orderTextMode } = req.body;
  if (!normalizeWaId(waId) || !userId) return res.status(400).json({ error: 'رقم الواتساب و userId مطلوبان' });

  let mode = DEFAULT_ORDER_TEXT_MODE;
  if (orderTextMode !== undefined) {
    mode = pickOrderTextMode(orderTextMode);
    if (!mode) return res.status(400).json({ error: `orderTextMode يجب أن يكون أحد: ${ORDER_TEXT_MODES.join(' | ')}` });
  }

  const link = await prisma.whatsAppChatLink.create({
    data: {
      waId: normalizeWaId(waId), chatTitle: chatTitle || null,
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

  const link = await prisma.whatsAppChatLink.update({ where: { id }, data });
  res.json({ success: true, data: link });
}

// ── Delete a link ────────────────────────────────────────────────────────
export async function deleteLink(req, res) {
  const id = parseInt(req.params.id);
  await prisma.whatsAppChatLink.delete({ where: { id } });
  res.json({ success: true });
}
