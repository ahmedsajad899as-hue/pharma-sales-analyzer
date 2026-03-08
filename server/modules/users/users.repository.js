import prisma from '../../lib/prisma.js';
import bcrypt from 'bcryptjs';

export async function listUsers() {
  return prisma.user.findMany({
    select:  {
      id: true, username: true, role: true, isActive: true, createdAt: true,
      linkedRepId: true,
      linkedRep: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createUser(username, password, role = 'user', linkedRepId = null) {
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data:   { username, passwordHash, role, ...(linkedRepId ? { linkedRepId: parseInt(linkedRepId) } : {}) },
    select: {
      id: true, username: true, role: true, isActive: true, createdAt: true,
      linkedRepId: true,
      linkedRep: { select: { id: true, name: true } },
    },
  });
}

export async function updateUser(id, data) {
  const updateData = { ...data };
  if (data.password) {
    updateData.passwordHash = await bcrypt.hash(data.password, 10);
    delete updateData.password;
  }
  // handle linkedRepId: allow null (unlink) or int (link)
  if ('linkedRepId' in updateData) {
    updateData.linkedRepId = updateData.linkedRepId ? parseInt(updateData.linkedRepId) : null;
  }
  return prisma.user.update({
    where:  { id },
    data:   updateData,
    select: {
      id: true, username: true, role: true, isActive: true,
      linkedRepId: true,
      linkedRep: { select: { id: true, name: true } },
    },
  });
}

export async function deleteUser(id) {
  return prisma.user.delete({ where: { id } });
}
