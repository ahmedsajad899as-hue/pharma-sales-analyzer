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
import { Prisma } from '@prisma/client';
import { normalizeWaId } from '../../lib/waId.js';
import { groupsSecret, sidecar } from './wa-groups.client.js';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import { handleGroupInbound } from '../warehouse-dispatch/dispatch.inbound.js';
import { ORDER_TEXT_MODES } from '../orders/order-trigger.js';
import { pickAiMode } from '../orders/order-extract.js';
import { listenLinkFor, handleListenGroupMessage, invalidateListenCache, LISTEN_SOURCE, listRetryingByJid } from './wa-groups.listen.js';
import { BOT_TO_CONDITION } from '../orders/bot-order-flow.js';
import { resolveSharedConditionOwner } from '../sales/sales.service.js';
import { loadItemOwnerManagers } from '../../lib/itemOwnerManager.js';
import { CONDITION_VARIANT } from '../../lib/saleFingerprint.js';
import { userFeatureOn } from '../../lib/userFeatures.js';

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
    // قراءة كروب المذخر مطفأة ⇒ الخدمة لا تمرّر رسائله ولا تنزّل صوره أصلاً
    prisma.orderWarehouse.findMany({ where: { channel: 'group', groupJid: { not: null }, groupReadOn: true }, select: { groupJid: true } }),
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
  const [links, wh, pending] = await Promise.all([
    prisma.waGroupLink.findMany({ include: { user: { select: { id: true, username: true, displayName: true, role: true } } }, orderBy: { id: 'asc' } }),
    prisma.orderWarehouse.findMany({ where: { channel: 'group', groupJid: { not: null } }, select: { groupJid: true, name: true, groupSendOn: true, groupReadOn: true } }),
    // طلبيات الكروب التي لم تُراجَع بعد — بعد التحويل قد تكون عند أكثر من مدير
    prisma.pendingBotOrder.groupBy({ by: ['chatId', 'userId'], where: { source: LISTEN_SOURCE }, _count: { _all: true } }),
  ]);
  const warehouses = {};
  const warehouseSwitches = {}; // jid → { send, read } (كروب = مذخر واحد عادةً؛ أي مذخر شغّال ⇒ شغّال)
  for (const w of wh) {
    (warehouses[w.groupJid] ||= []).push(w.name);
    const sw = (warehouseSwitches[w.groupJid] ||= { send: false, read: false });
    sw.send ||= w.groupSendOn !== false;
    sw.read ||= w.groupReadOn !== false;
  }
  const names = new Map((await prisma.user.findMany({
    where: { id: { in: [...new Set(pending.map(p => p.userId))] } }, select: { id: true, username: true, displayName: true },
  })).map(u => [u.id, u.displayName?.trim() || u.username]));
  const pendingByJid = {};
  for (const p of pending) (pendingByJid[p.chatId] ||= []).push({ userId: p.userId, name: names.get(p.userId) || `#${p.userId}`, count: p._count._all });
  res.json({ success: true, links, warehouses, warehouseSwitches, pending: pendingByJid, retrying: listRetryingByJid() });
});

// ─── كروب مذخر من نفس الصفحة: نوع كل كروب يُحدَّد عند إضافة الرقم له ─────────
// (طلب صاحب المشروع 2026-11-10) — كان الربط فقط من «إرسال للمذاخر» ← المذاخر.

/** كل مذاخر الدليل (ماستر أدمن) لاختيار مذخر الكروب. */
saRouter.get('/warehouses', async (_req, res) => {
  const rows = await prisma.orderWarehouse.findMany({
    select: { id: true, name: true, province: true, phone: true, channel: true, groupJid: true, createdById: true },
    orderBy: { name: 'asc' }, take: 3000,
  });
  const owners = new Map((await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.createdById))] } }, select: { id: true, username: true, displayName: true },
  })).map(u => [u.id, u.displayName?.trim() || u.username]));
  res.json({ success: true, warehouses: rows.map(r => ({ ...r, owner: owners.get(r.createdById) || null })) });
});

/** المذخر الذي فقد كروبه يعود لرقم البوت الرسمي إن كان له رقم، وإلا يدوي. */
const unlinkWarehouseGroup = (where) => prisma.$transaction(async (tx) => {
  const ws = await tx.orderWarehouse.findMany({ where, select: { id: true, phone: true } });
  for (const w of ws) {
    await tx.orderWarehouse.update({ where: { id: w.id }, data: { groupJid: null, groupName: null, groupSendOn: true, groupReadOn: true, channel: String(w.phone || '').trim() ? 'cloud' : 'manual' } });
  }
  return ws.length;
});

saRouter.put('/warehouse-link', async (req, res) => {
  const { jid, groupName, warehouseId } = req.body || {};
  if (!/@g\.us$/.test(String(jid || ''))) return res.status(400).json({ error: 'معرّف كروب غير صالح' });
  const w = await prisma.orderWarehouse.findUnique({ where: { id: Number(warehouseId) || 0 }, select: { id: true, name: true, groupJid: true } });
  if (!w) return res.status(400).json({ error: 'اختر المذخر' });
  // كروب المندوبين لا يصير كروب مذخر بصمت (هناك يقرأ فقط وهنا يرسل)
  const listen = await prisma.waGroupLink.findUnique({ where: { jid: String(jid) }, select: { id: true } });
  if (listen) return res.status(400).json({ error: 'هذا الكروب مربوط ككروب مندوبين (قراءة صامتة) — ألغِ ذلك أولاً' });
  // كروب واحد = مذخر واحد: من كان مربوطاً بهذا الكروب يُفصل
  await unlinkWarehouseGroup({ groupJid: String(jid), id: { not: w.id } });
  await prisma.orderWarehouse.update({
    where: { id: w.id },
    // ربط جديد يبدأ والمفتاحان شغّالان
    data: { channel: 'group', groupJid: String(jid), groupName: String(groupName || '').trim().slice(0, 120) || null, groupSendOn: true, groupReadOn: true },
  });
  refreshSidecarJids();
  res.json({ success: true, previousGroup: w.groupJid && w.groupJid !== String(jid) ? w.groupJid : null });
});

// مفتاحا كروب المذخر بلا فصل: send = إرسال الطلبيات عبر البوت، read = قراءة الفواتير/الردود وربطها
saRouter.patch('/warehouse-link/:jid', async (req, res) => {
  const { send, read } = req.body || {};
  const data = {
    ...(typeof send === 'boolean' ? { groupSendOn: send } : {}),
    ...(typeof read === 'boolean' ? { groupReadOn: read } : {}),
  };
  if (!Object.keys(data).length) return res.status(400).json({ error: 'لا تغيير' });
  const r = await prisma.orderWarehouse.updateMany({ where: { groupJid: String(req.params.jid), channel: 'group' }, data });
  if (!r.count) return res.status(404).json({ error: 'الكروب غير مربوط بمذخر' });
  if (data.groupReadOn !== undefined) refreshSidecarJids();
  res.json({ success: true });
});

saRouter.delete('/warehouse-link/:jid', async (req, res) => {
  const n = await unlinkWarehouseGroup({ groupJid: String(req.params.jid) });
  refreshSidecarJids();
  res.json({ success: true, unlinked: n });
});

// «وين راح تروح البيانات؟» للحساب المختار قبل الحفظ — نفس القواعد الفعلية:
// مفتاح «فواتير البوت ← اللكوديشن»، تحويل الأسطر لمدراء الايتمات، والملف المشترك.
saRouter.get('/destination', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: Number(req.query.userId) || 0 },
    select: { id: true, username: true, displayName: true, role: true, officeId: true, isActive: true, permissions: true },
  });
  if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
  const nameOf = (u) => u?.displayName?.trim() || u?.username || '';
  const [office, owners, condOwnerId] = await Promise.all([
    user.officeId != null ? prisma.scientificOffice.findUnique({ where: { id: user.officeId }, select: { name: true } }) : null,
    loadItemOwnerManagers(user.officeId).catch(() => new Map()),
    resolveSharedConditionOwner(user),
  ]);
  const managers = new Map();
  for (const o of owners.values()) {
    if (o.managerId === user.id) continue;
    const m = managers.get(o.managerId) || { id: o.managerId, name: o.managerName, company: o.companyName, items: 0 };
    m.items++;
    managers.set(o.managerId, m);
  }
  const [condOwner, condFile] = await Promise.all([
    prisma.user.findUnique({ where: { id: condOwnerId }, select: { username: true, displayName: true } }),
    prisma.uploadedFile.findFirst({
      where: { userId: condOwnerId, isCumulative: true, mergeGroup: { endsWith: `|${CONDITION_VARIANT}` } },
      select: { id: true, originalName: true, _count: { select: { sales: true } } }, orderBy: { id: 'asc' },
    }),
  ]);
  res.json({
    success: true,
    reviewer: { id: user.id, name: nameOf(user), role: user.role, isActive: user.isActive },
    office: office?.name || null,
    conditionOn: userFeatureOn(user, BOT_TO_CONDITION),
    ownItems: [...owners.values()].filter(o => o.managerId === user.id).length,
    managers: [...managers.values()].sort((a, b) => b.items - a.items),
    conditionFile: {
      ownerName: nameOf(condOwner),
      id: condFile?.id ?? null,
      name: condFile?.originalName ?? null,
      rows: condFile?._count.sales ?? 0,
    },
  });
});

saRouter.put('/links', async (req, res) => {
  const { jid, name, userId, orderTextMode, isActive, allowedSenders, aiMode } = req.body || {};
  if (aiMode !== undefined && !pickAiMode(aiMode)) return res.status(400).json({ error: 'وضع التحليل غير صالح' });
  let senders;
  if (allowedSenders !== undefined) {
    if (allowedSenders !== null && !Array.isArray(allowedSenders)) return res.status(400).json({ error: 'قائمة الأشخاص غير صالحة' });
    // رقم مكتوب يدوياً (0770…) يُوحَّد؛ «lid:…» من قائمة من كتب في الكروب يبقى كما هو
    senders = [...new Set((allowedSenders || []).map(v => {
      const s = String(v || '').trim();
      return s.startsWith('lid:') ? (/^lid:\d+$/.test(s) ? s : null) : (normalizeWaId(s) || null);
    }).filter(Boolean))].slice(0, 100);
  }
  if (!/@g\.us$/.test(String(jid || ''))) return res.status(400).json({ error: 'معرّف كروب غير صالح' });
  const mode = orderTextMode === undefined ? undefined : String(orderTextMode);
  if (mode !== undefined && !ORDER_TEXT_MODES.includes(mode)) return res.status(400).json({ error: 'وضع القراءة غير صالح' });
  const used = await prisma.orderWarehouse.findFirst({ where: { channel: 'group', groupJid: String(jid) }, select: { name: true } });
  if (used) return res.status(400).json({ error: `هذا الكروب مربوط بمذخر «${used.name}» — افصله أولاً («فصل المذخر»)` });
  const existing = await prisma.waGroupLink.findUnique({ where: { jid: String(jid) } });
  const uid = userId === undefined ? existing?.userId : Number(userId);
  if (!uid) return res.status(400).json({ error: 'اختر الحساب الذي تُسجَّل عليه المبيعات' });
  const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true } });
  if (!user) return res.status(400).json({ error: 'الحساب غير موجود' });
  const data = {
    userId: uid,
    ...(name !== undefined ? { name: String(name || '').slice(0, 200) || null } : {}),
    ...(mode !== undefined ? { orderTextMode: mode } : {}),
    ...(aiMode !== undefined ? { aiMode: pickAiMode(aiMode) } : {}),
    ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
    ...(senders !== undefined ? { allowedSenders: senders.length ? senders : Prisma.DbNull } : {}),
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
