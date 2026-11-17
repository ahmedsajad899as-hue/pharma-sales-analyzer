import prisma from './prisma.js';

/**
 * من يحسم «مطابقة أسماء المندوبين (ميركاتو)»؟
 *
 * الروابط (SciRepNameLink) مشتركة على مستوى المكتب، فكان كل مدير يرى الأسئلة
 * ويحفظ قراره — فيتوزّع الحسم بين عدة أشخاص ويكتب أحدهم فوق الآخر (مثال
 * 2026-11-17: اسم مندوب آخر رُبط بمسوّق فدخلت طلبيته في مبيعاته). القرار صار
 * عند موظف المكتب وحده (هو من يرفع الملفات):
 *   - office_employee / admin / super_admin → يُسأل ويحفظ.
 *   - غيرهم داخل مكتب فيه موظف مكتب فعّال → لا أسئلة، عرض فقط، والحفظ مرفوض.
 *   - حساب بلا مكتب، أو مكتب بلا موظف مكتب → كما كان (وإلا بقيت أسماؤه بلا حسم).
 *
 * @param {{id:number, role?:string}|null} user
 * @returns {Promise<boolean>}
 */
export async function canResolveRepNames(user) {
  if (!user?.id) return false;
  if (['office_employee', 'admin', 'super_admin'].includes(user.role)) return true;
  const u = await prisma.user.findUnique({ where: { id: user.id }, select: { officeId: true } });
  if (!u?.officeId) return true;
  const employees = await prisma.user.count({
    where: { officeId: u.officeId, role: 'office_employee', isActive: true },
  });
  return employees === 0;
}
