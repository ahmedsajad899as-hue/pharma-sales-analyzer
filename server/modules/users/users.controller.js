import * as repo from './users.repository.js';

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
    await repo.deleteUser(id);
    res.json({ success: true });
  } catch (err) { next(err); }
}
