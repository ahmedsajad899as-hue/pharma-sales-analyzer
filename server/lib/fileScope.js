/**
 * fileScope — شرط Prisma يحصر صفوف Sale بالملفات التي يحقّ للمستخدم رؤيتها.
 *
 * لماذا لا يكفي `{ userId }`: ملفات المبيعات تُعمَّم من موظف المكتب على مدير
 * المكتب/الشركة عبر FileUserShare. صفوف Sale تبقى مملوكة لرافع الملف، فشرط
 * `userId` الخام يُخفي الملف المُشارَك عن المشارَك معه تماماً — تظهر الصفحة
 * فارغة رغم أن الملف مختار أمامه. (هذا ما كان يُفرغ «تحليل الإيتم» لمدير
 * المكتب بينما Pharmacy Net تعمل: الأخيرة عولجت والأولى بقيت.)
 *
 * لا توسيع للصلاحية: المعرّفات المُتحقَّق منها وحدها هي ما يدخل الشرط، فلا
 * يستطيع أحد تمرير fileId لملف لا يملكه ولم يُشارَك معه.
 *
 * @param {number|null} userId
 * @param {string|null} fileIds قائمة معرّفات مفصولة بفواصل من الاستعلام
 * @returns {Promise<object>} شرط Prisma للدمج في where الخاص بـ Sale
 */

import prisma from './prisma.js';

export async function resolveFileScope(userId, fileIds) {
  if (!fileIds) return userId ? { userId } : {};
  const ids = String(fileIds).split(',').map(Number).filter(Boolean);
  if (!ids.length) return userId ? { userId } : {};
  const accessible = await prisma.uploadedFile.findMany({
    where: { id: { in: ids }, OR: [{ userId }, { fileShares: { some: { userId } } }] },
    select: { id: true },
  });
  const verifiedIds = accessible.map(f => f.id);
  if (!verifiedIds.length) return { id: -1 }; // لا صلاحية على أي من الملفات المطلوبة
  return { uploadedFileId: { in: verifiedIds } };
}
