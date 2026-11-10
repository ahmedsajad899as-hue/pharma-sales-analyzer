import express from 'express';
import { listLinks, createLink, updateLink, deleteLink } from './whatsapp-links.controller.js';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import * as chats from '../warehouse-dispatch/dispatch.chats.js';

const router = express.Router();

// ماستر أدمن فقط — ربط محادثة بحساب يمنحها صلاحية "إدخال بيانات باسم هذا
// المستخدم"، حساس بما يكفي لتقييده دون بقية السوبر أدمن (نفس منطق روابط تلكرام).
router.use(requireMasterAdmin);

// محادثات رقم البوت — الماستر أدمن يرى كلها ويردّ (نفس منطق تبويب المدير)
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
router.get('/chats', wrap(async (req, res) => res.json({ success: true, ...(await chats.listChats(chats.masterActor(req.superAdmin), req.query)) })));
router.get('/chats/media/:logId', wrap(async (req, res) => {
  const buf = await chats.chatMedia(chats.masterActor(req.superAdmin), req.params.logId);
  res.set('Cache-Control', 'private, max-age=86400').type('image/jpeg').send(buf);
}));
router.get('/chats/:waId', wrap(async (req, res) => res.json({ success: true, ...(await chats.chatMessages(chats.masterActor(req.superAdmin), req.params.waId, req.query)) })));
router.post('/chats/:waId/send', wrap(async (req, res) => res.json({ success: true, ...(await chats.sendChatMessage(chats.masterActor(req.superAdmin), req.params.waId, req.body)) })));

router.get('/',       listLinks);
router.post('/',      createLink);
router.put('/:id',    updateLink);
router.delete('/:id', deleteLink);

export default router;
