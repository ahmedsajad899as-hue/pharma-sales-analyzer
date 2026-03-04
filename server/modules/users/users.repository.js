import prisma from '../../lib/prisma.js';
import bcrypt from 'bcryptjs';

export async function listUsers() {
  return prisma.user.findMany({
    select:  { id: true, username: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createUser(username, password, role = 'user') {
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data:   { username, passwordHash, role },
    select: { id: true, username: true, role: true, isActive: true, createdAt: true },
  });
}

export async function updateUser(id, data) {
  const updateData = { ...data };
  if (data.password) {
    updateData.passwordHash = await bcrypt.hash(data.password, 10);
    delete updateData.password;
  }
  return prisma.user.update({
    where:  { id },
    data:   updateData,
    select: { id: true, username: true, role: true, isActive: true },
  });
}

export async function deleteUser(id) {
  return prisma.user.delete({ where: { id } });
}
