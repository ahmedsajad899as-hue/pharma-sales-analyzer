// /api/sa/order-learning — «ذاكرة التصحيحات» في لوحة الماستر أدمن (2026-11-24).
// الدروس التي تعلّمها التطبيق من مراجعي طلبيات البوت (عرض/حذف)، وقاعدة الأصناف
// المتعلَّمة (ItemMergeRule أنشأها مستخدم)، و«رسائل صحّحها المراجعون» لإصلاح المحلّل.
import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';

const router = Router();
router.use(requireMasterAdmin);

async function scopeNames(scopes) {
  const officeIds = [...new Set(scopes.filter(s => s?.startsWith('o:')).map(s => Number(s.slice(2))).filter(Number.isFinite))];
  const userIds = [...new Set(scopes.filter(s => s?.startsWith('u:')).map(s => Number(s.slice(2))).filter(Number.isFinite))];
  const [offices, users] = await Promise.all([
    officeIds.length ? prisma.scientificOffice.findMany({ where: { id: { in: officeIds } }, select: { id: true, name: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true } }) : [],
  ]);
  const map = new Map();
  for (const o of offices) map.set(`o:${o.id}`, o.name);
  for (const u of users) map.set(`u:${u.id}`, u.displayName || u.username);
  return map;
}

router.get('/', async (_req, res, next) => {
  try {
    const [lessons, itemRules, cases] = await Promise.all([
      prisma.orderLearning.findMany({ orderBy: { updatedAt: 'desc' }, take: 1000 }),
      prisma.itemMergeRule.findMany({
        where: { userId: { not: null } },
        orderBy: { id: 'desc' }, take: 500,
        select: {
          id: true, fromName: true, toName: true, createdAt: true,
          scientificCompany: { select: { name: true } },
          user: { select: { username: true, displayName: true } },
        },
      }),
      prisma.orderCorrectionCase.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
    ]);
    const names = await scopeNames([...lessons.map(l => l.scope), ...cases.map(c => c.scope)]);
    res.json({
      success: true,
      data: {
        lessons: lessons.map(l => ({ ...l, scopeName: names.get(l.scope) || l.scope })),
        itemRules: itemRules.map(r => ({
          id: r.id, fromName: r.fromName, toName: r.toName, createdAt: r.createdAt,
          company: r.scientificCompany?.name || null, by: r.user ? (r.user.displayName || r.user.username) : null,
        })),
        cases: cases.map(c => ({ ...c, scopeName: names.get(c.scope) || c.scope })),
      },
    });
  } catch (e) { next(e); }
});

router.delete('/lessons/:id', async (req, res, next) => {
  try {
    await prisma.orderLearning.deleteMany({ where: { id: Number(req.params.id) } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.delete('/item-rules/:id', async (req, res, next) => {
  try {
    await prisma.itemMergeRule.deleteMany({ where: { id: Number(req.params.id), userId: { not: null } } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.patch('/cases/:id', async (req, res, next) => {
  try {
    const status = req.body?.status === 'fixed' ? 'fixed' : 'open';
    await prisma.orderCorrectionCase.updateMany({ where: { id: Number(req.params.id) }, data: { status } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.delete('/cases/:id', async (req, res, next) => {
  try {
    await prisma.orderCorrectionCase.deleteMany({ where: { id: Number(req.params.id) } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

export default router;
