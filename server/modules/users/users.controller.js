import * as repo from './users.repository.js';
import prisma from '../../lib/prisma.js';

/** GET /api/admin/users */
export async function listUsers(req, res, next) {
  try {
    const users = await repo.listUsers();
    res.json({ success: true, data: users });
  } catch (err) { next(err); }
}

/** POST /api/admin/users */
export async function createUser(req, res, next) {
  try {
    const { username, password, role, linkedRepId } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.' });
    }
    const user = await repo.createUser(username, password, role || 'user', linkedRepId || null);
    res.status(201).json({ success: true, data: user });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل.' });
    next(err);
  }
}

/** PATCH /api/admin/users/:id */
export async function updateUser(req, res, next) {
  try {
    const id = +req.params.id;
    if (id === req.user.id && req.body.role === 'user') {
      return res.status(400).json({ error: 'لا يمكنك إزالة صلاحية Admin من حسابك الخاص.' });
    }
    const user = await repo.updateUser(id, req.body);
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
}

/** DELETE /api/admin/users/:id */
export async function deleteUser(req, res, next) {
  try {
    const id = +req.params.id;
    if (id === req.user.id) {
      return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص.' });
    }
    const force = req.query.force === '1' || req.query.force === 'true';
    if (force) {
      // Same force-delete as admin-users.deleteUser: remove the user's Restrict-
      // blocking activity data (their CASCADE children go too), then the user.
      // SET NULL relations (sales, files, shared entities) are auto-nulled, not deleted.
      await prisma.$transaction([
        prisma.visitLike.deleteMany({ where: { userId: id } }),
        prisma.visitComment.deleteMany({ where: { userId: id } }),
        prisma.pharmacyVisitLike.deleteMany({ where: { userId: id } }),
        prisma.dailyPlanComment.deleteMany({ where: { userId: id } }),
        prisma.dailyPlanSettings.deleteMany({ where: { userId: id } }),
        prisma.collectionRecord.deleteMany({ where: { collectedById: id } }),
        prisma.commercialInvoice.deleteMany({ where: { OR: [{ createdByUserId: id }, { assignedRepId: id }] } }),
        prisma.invoiceSheet.deleteMany({ where: { repId: id } }),
        prisma.dailyPlan.deleteMany({ where: { userId: id } }),
        prisma.user.delete({ where: { id } }),
      ]);
      return res.json({ success: true, forced: true });
    }
    await repo.deleteUser(id);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'المستخدم غير موجود أو تم حذفه بالفعل.' });
    if (err.code === 'P2003' || err.code === 'P2014' || /foreign key constraint/i.test(err.message || '')) {
      return res.status(409).json({
        error: 'لا يمكن حذف هذا المستخدم لأن لديه بيانات مرتبطة (بلان يومي، فواتير تجارية، كشوفات استحصال، أو إعجابات/تعليقات على زيارات). عطّل الحساب بدلاً من حذفه إذا أردت إيقافه دون فقدان هذه البيانات.',
        code: 'HAS_DEPENDENCIES',
      });
    }
    next(err);
  }
}
