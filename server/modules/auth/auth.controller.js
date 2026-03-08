import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma.js';

const JWT_SECRET  = process.env.JWT_SECRET  || 'pharma-sales-secret-key-2026';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

/** POST /api/auth/login */
export async function login(req, res) {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان.' });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES },
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role, linkedRepId: user.linkedRepId ?? null },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** GET /api/auth/me  (requires auth) */
export async function me(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { id: true, username: true, role: true, isActive: true, linkedRepId: true },
    });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** POST /api/auth/change-password  (requires auth) */
export async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل.' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة.' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: hash } });

    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
