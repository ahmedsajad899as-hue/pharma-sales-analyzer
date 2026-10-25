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
import { handleGroupInbound } from '../warehouse-dispatch/dispatch.inbound.js';

export const internalRouter = Router();
export const adminRouter = Router();

function checkSecret(req, res, next) {
  const want = groupsSecret();
  const got = String(req.headers['x-wa-groups-secret'] || '');
  if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.sendStatus(403);
  next();
}

// الكروبات المربوطة بمذاخر — الخدمة لا تمرّر غيرها (ولا تنزّل صورها)
internalRouter.get('/known-jids', checkSecret, async (_req, res) => {
  const rows = await prisma.orderWarehouse.findMany({ where: { channel: 'group', groupJid: { not: null } }, select: { groupJid: true } });
  res.json({ jids: [...new Set(rows.map(r => r.groupJid))] });
});

internalRouter.post('/inbound', checkSecret, async (req, res) => {
  res.json({ ok: true }); // إقرار فوري — قراءة الفاتورة بالذكاء قد تطول
  try {
    await handleGroupInbound(req.body || {});
  } catch (e) {
    console.error('[wa-groups] فشل معالجة رسالة الكروب:', e);
  }
});

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
function requireAdmin(req, res, next) {
  if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'للأدمن فقط' });
  next();
}

adminRouter.get('/status', requireAdmin, async (_req, res) => {
  const r = await sidecar('/status', { timeoutMs: 5000 });
  res.json({ success: true, ...(r.data || { connected: false }), error: r.error || null });
});

adminRouter.post('/pair', requireAdmin, async (req, res) => {
  const r = await sidecar('/pair', { method: 'POST', body: { phone: req.body?.phone }, timeoutMs: 30_000 });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ success: true, ...r.data });
});

adminRouter.post('/logout', requireAdmin, async (_req, res) => {
  const r = await sidecar('/logout', { method: 'POST' });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ success: true });
});
