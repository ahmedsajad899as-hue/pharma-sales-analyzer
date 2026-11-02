// ════════════════════════════════════════════════════════════════════════════
// wa-groups.routes.js — جسر خدمة «رقم الكروبات» (server/wa-groups-sidecar).
//
//  • /api/wa-groups/internal/*  — من الخدمة نفسها (127.0.0.1) بسرّ مشترك، بلا JWT
//    (مستثنى في بوابة server/index.js): رسائل الكروبات الواردة + الكروبات المعنيّة.
//  • /api/wa-groups/admin/*     — صفحة الإدارة (JWT + أدمن): الحالة، الربط بكود، فصل.
// ════════════════════════════════════════════════════════════════════════════

import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { groupsSecret, sidecar } from './wa-groups.client.js';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import { handleGroupInbound } from '../warehouse-dispatch/dispatch.inbound.js';
import { ORDER_TEXT_MODES } from '../orders/order-trigger.js';
import { listenLinkFor, handleListenGroupMessage, invalidateListenCache } from './wa-groups.listen.js';

export const internalRouter = Router();
export const adminRouter = Router();

function checkSecret(req, res, next) {
  const want = groupsSecret();
  const got = String(req.headers['x-wa-groups-secret'] || '');
  if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.sendStatus(403);
  next();
}

// الكروبات المعنيّة: كروبات مذاخر + كروبات مندوبين صامتة — الخدمة لا تمرّر غيرها (ولا تنزّل صورها)
internalRouter.get('/known-jids', checkSecret, async (_req, res) => {
  const [wh, listen] = await Promise.all([
    prisma.orderWarehouse.findMany({ where: { channel: 'group', groupJid: { not: null } }, select: { groupJid: true } }),
    prisma.waGroupLink.findMany({ where: { isActive: true }, select: { jid: true } }),
  ]);
  res.json({ jids: [...new Set([...wh.map(r => r.groupJid), ...listen.map(r => r.jid)])] });
});

internalRouter.post('/inbound', checkSecret, async (req, res) => {
  res.json({ ok: true }); // إقرار فوري — قراءة الفاتورة بالذكاء قد تطول
  try {
    const m = req.body || {};
    // كروب مندوبين صامت أولاً — لا يُعامل أبداً كردّ مذخر
    const link = m.pollVote ? null : await listenLinkFor(m.jid);
    if (link) await handleListenGroupMessage(m, link);
    else await handleGroupInbound(m);
  } catch (e) {
    console.error('[wa-groups] فشل معالجة رسالة الكروب:', e);
  }
});

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
function requireAdmin(req, res, next) {
  if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'للأدمن فقط' });
  next();
}

// الحالة/الربط/الفصل — مشتركة بين صفحة التطبيق (أدمن) ولوحة السوبر أدمن (ماستر)
const statusHandler = async (_req, res) => {
  const r = await sidecar('/status', { timeoutMs: 5000 });
  res.json({ success: true, ...(r.data || { connected: false }), error: r.error || null });
};
const pairHandler = async (req, res) => {
  const r = await sidecar('/pair', { method: 'POST', body: { phone: req.body?.phone }, timeoutMs: 30_000 });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ success: true, ...r.data });
};
const logoutHandler = async (_req, res) => {
  const r = await sidecar('/logout', { method: 'POST' });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ success: true });
};
const groupsHandler = async (_req, res) => {
  const r = await sidecar('/groups');
  res.json({ success: true, groups: r.data?.groups || [], error: r.error || null });
};

adminRouter.get('/status', requireAdmin, statusHandler);
adminRouter.post('/pair', requireAdmin, pairHandler);
adminRouter.post('/logout', requireAdmin, logoutHandler);

// لوحة السوبر أدمن: رقم واحد لكل النظام ⇒ الماستر أدمن فقط (كروابط واتساب)
export const saRouter = Router();
saRouter.use(requireMasterAdmin);
saRouter.get('/status', statusHandler);
saRouter.post('/pair', pairHandler);
saRouter.post('/logout', logoutHandler);
saRouter.get('/groups', groupsHandler);

// ─── نوع كل كروب: مذخر (من التطبيق) أو مندوبين بقراءة صامتة (هنا) ────────────

const refreshSidecarJids = () => sidecar('/refresh-known', { method: 'POST', timeoutMs: 5000 }).catch(() => {});

saRouter.get('/links', async (_req, res) => {
  const [links, wh] = await Promise.all([
    prisma.waGroupLink.findMany({ include: { user: { select: { id: true, username: true, displayName: true, role: true } } }, orderBy: { id: 'asc' } }),
    prisma.orderWarehouse.findMany({ where: { channel: 'group', groupJid: { not: null } }, select: { groupJid: true, name: true } }),
  ]);
  const warehouses = {};
  for (const w of wh) (warehouses[w.groupJid] ||= []).push(w.name);
  res.json({ success: true, links, warehouses });
});

saRouter.put('/links', async (req, res) => {
  const { jid, name, userId, orderTextMode, isActive } = req.body || {};
  if (!/@g\.us$/.test(String(jid || ''))) return res.status(400).json({ error: 'معرّف كروب غير صالح' });
  const mode = orderTextMode === undefined ? undefined : String(orderTextMode);
  if (mode !== undefined && !ORDER_TEXT_MODES.includes(mode)) return res.status(400).json({ error: 'وضع القراءة غير صالح' });
  const used = await prisma.orderWarehouse.findFirst({ where: { channel: 'group', groupJid: String(jid) }, select: { name: true } });
  if (used) return res.status(400).json({ error: `هذا الكروب مربوط بمذخر «${used.name}» — افصله من «إرسال للمذاخر» أولاً` });
  const existing = await prisma.waGroupLink.findUnique({ where: { jid: String(jid) } });
  const uid = userId === undefined ? existing?.userId : Number(userId);
  if (!uid) return res.status(400).json({ error: 'اختر الحساب الذي تُسجَّل عليه المبيعات' });
  const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true } });
  if (!user) return res.status(400).json({ error: 'الحساب غير موجود' });
  const data = {
    userId: uid,
    ...(name !== undefined ? { name: String(name || '').slice(0, 200) || null } : {}),
    ...(mode !== undefined ? { orderTextMode: mode } : {}),
    ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
  };
  const link = await prisma.waGroupLink.upsert({ where: { jid: String(jid) }, create: { jid: String(jid), ...data }, update: data });
  invalidateListenCache();
  refreshSidecarJids();
  res.json({ success: true, link });
});

saRouter.delete('/links/:jid', async (req, res) => {
  await prisma.waGroupLink.deleteMany({ where: { jid: String(req.params.jid) } });
  invalidateListenCache();
  refreshSidecarJids();
  res.json({ success: true });
});
