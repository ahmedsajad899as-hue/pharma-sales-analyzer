// ════════════════════════════════════════════════════════════════════════════
// activeFiles.js — «الملفات المفعّلة» لحساب ما، كما يراها التطبيق.
//
// الفخّ الذي تحرسه هذه الدالة: تفعيل الملفات حالة متصفح (localStorage) لا يراها
// السيرفر. فأي حساب يعمل في الخلفية (بوت، مُجدوِل، لقطة ليلية) كان يحسب على كل
// ملفات المكتب بينما التطبيق يحسب على المفعّلة وحدها — فتظهر أرقام الخلفية
// أعلى من أرقام الشاشة بلا سبب مفهوم. App.tsx يُزامن القائمة إلى
// User.activeFileIds عبر /api/active-files، وهذه الدالة تقرأها.
//
// استُخرجت من telegram/sales-query.js لتبقى نسخة واحدة: كل مَن يحسب بلا واجهة
// يجب أن يحسب على نفس الملفات، وإلا تناقضت الأرقام بين البوت والملخّص والصفحة.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { expandOwnerIdsByCompany } from '../modules/scientific-reps/scientific-reps.service.js';

/**
 * @param {number} userId
 * @returns {Promise<{ ids:number[], synced:boolean, source:string, names:string[] }>}
 *   synced=false يعني أن الحساب لم يُزامن قائمته بعد (أو كانت فارغة) فارتددنا
 *   إلى كل ملفات نطاقه — تُعرض للمستخدم كي يفهم لماذا الأرقام أوسع مما يتوقع.
 */
export async function resolveActiveFileIds(userId) {
  const [me, ownerIds] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { activeFileIds: true } }),
    expandOwnerIdsByCompany([userId]),
  ]);
  const [ownFiles, sharedFiles] = await Promise.all([
    prisma.uploadedFile.findMany({ where: { userId: { in: ownerIds } }, select: { id: true, originalName: true } }),
    prisma.fileUserShare.findMany({ where: { userId }, select: { file: { select: { id: true, originalName: true } } } }),
  ]);

  const inScope = new Map();
  for (const f of ownFiles) inScope.set(f.id, f.originalName);
  for (const s of sharedFiles) if (s.file) inScope.set(s.file.id, s.file.originalName);

  let active = null;
  try {
    const saved = me?.activeFileIds ? JSON.parse(me.activeFileIds) : null;
    // التقاطع مع النطاق إلزامي: القائمة المحفوظة قد تشير لملف حُذف لاحقاً.
    if (Array.isArray(saved)) active = saved.filter((id) => inScope.has(id));
  } catch { /* JSON تالف — نرتدّ لكل الملفات */ }

  const ids = active && active.length ? active : [...inScope.keys()];
  const synced = Boolean(active && active.length);
  return {
    ids,
    synced,
    source: synced ? 'المفعّلة في التطبيق' : 'كل ملفات المكتب (لم تُزامَن بعد)',
    names: ids.map((id) => inScope.get(id) || `#${id}`),
  };
}
