import prisma from '../../lib/prisma.js';

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
  const { chatId, chatTitle, userId } = req.body;
  if (!chatId || !userId) return res.status(400).json({ error: 'chatId و userId مطلوبان' });

  const link = await prisma.telegramChatLink.create({
    data: { chatId: String(chatId), chatTitle: chatTitle || null, userId: parseInt(userId) },
  });
  res.status(201).json({ success: true, data: link });
}

// ── Update a link (label / active toggle / re-point to another user) ───
export async function updateLink(req, res) {
  const id = parseInt(req.params.id);
  const { chatTitle, isActive, userId } = req.body;

  const data = {};
  if (chatTitle !== undefined) data.chatTitle = chatTitle;
  if (isActive  !== undefined) data.isActive  = Boolean(isActive);
  if (userId    !== undefined) data.userId    = parseInt(userId);

  const link = await prisma.telegramChatLink.update({ where: { id }, data });
  res.json({ success: true, data: link });
}

// ── Delete a link ────────────────────────────────────────────────────────
export async function deleteLink(req, res) {
  const id = parseInt(req.params.id);
  await prisma.telegramChatLink.delete({ where: { id } });
  res.json({ success: true });
}
