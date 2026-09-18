// ════════════════════════════════════════════════════════════════════════════
// stockLedgerScope.js — من «يقرأ» دفتر رصيد المذاخر ومن «يكتب» فيه.
//
// كان موظف المكتب يرفع، فيُعاد استيعاب نفس الصفوف في حساب كل مدير مكتب / HR /
// مدير شركة (autoSyncStockToManagers سابقاً): نسخة مستقلة لكل حساب — مذاخره،
// حركاته، أرصدته، روابط أسمائه. النسخ تتباعد حتماً:
//   • قرارات المطابقة (مذخر/شركة) تُحفظ لصاحب الرفع وحده، فتُحلَّل الأسماء عند كل
//     هدف بحالته هو (مذاخر مختلفة/مناطق مختلفة لنفس الاسم).
//   • حذف دفعة كان لحساب واحد فقط — لا يُعمَّم.
//   • أي استيراد يقوم به المدير في نسخته (ستوك افتتاحي بتاريخ أحدث مثلاً) يُصفّر
//     أزواجه ويُهمل كل مبيع أقدم منه، فيرى أرقاماً غير التي يراها الموظف عن نفس
//     المذاخر (شوهد فعلياً: افتتاحي 11/9 عند المدير مقابل 1/9 عند الموظف، ومبيع
//     13/9 وحده محسوب عند المدير بينما 8/9 و9/9 و10/9 و11/9 ظاهرة عند الموظف).
//
// الآن مصدر واحد للحقيقة: الدفتر ملك لمن رفعه، والمدير يقرأ دفاتر موظفي مكتبه
// مباشرة (اتحاد) بلا نسخ — نفس فلسفة FileUserShare في ملفات المبيعات. كتابات
// المدير نفسه (إن أُتيحت له) تبقى في دفتره هو وتظهر ضمن الاتحاد نفسه.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

/** الأدوار التي تقرأ دفاتر موظفي المكتب إضافةً إلى دفترها — نفس أهداف التعميم القديمة */
export const STOCK_VIEWER_ROLES = new Set(['office_manager', 'office_hr', 'company_manager']);

/**
 * @param {{id:number, role:string}} user  req.user (الـJWT لا يحمل officeId — يُقرأ هنا)
 * @returns {Promise<{
 *   readIds: number[],            // دفاتر تُقرأ (اتحاد) — الأول دائماً المستخدم نفسه
 *   writeId: number,              // الدفتر الذي تُكتب فيه رفعاته هو
 *   viewer: boolean,              // هل يقرأ دفاتر غيره (مدير مكتب/HR/مدير شركة)
 *   ownerName: Map<number,string> // اسم صاحب كل دفتر للعرض في تبويب الدفعات
 * }>}
 */
export async function resolveLedgerScope(user) {
  const self = user?.id;
  const base = { readIds: self ? [self] : [], writeId: self ?? null, viewer: false, ownerName: new Map() };
  if (!self || !STOCK_VIEWER_ROLES.has(user.role)) return base;

  const me = await prisma.user.findUnique({ where: { id: self }, select: { officeId: true, displayName: true, username: true } });
  // نطاق المكتب متى عُرف؛ موظف بلا مكتب (إعداد ناقص) يُضمّ أيضاً كي لا يختفي
  // دفتره عن مديره كما كان يصله بالتعميم القديم (الذي لم يكن مقيَّداً بمكتب أصلاً).
  const employees = await prisma.user.findMany({
    where: {
      isActive: true, role: 'office_employee', id: { not: self },
      ...(me?.officeId ? { OR: [{ officeId: me.officeId }, { officeId: null }] } : {}),
    },
    select: { id: true, displayName: true, username: true },
    orderBy: { id: 'asc' },
  });

  const ownerName = new Map([[self, me?.displayName || me?.username || 'أنا']]);
  for (const e of employees) ownerName.set(e.id, e.displayName || e.username);
  return { readIds: [self, ...employees.map(e => e.id)], writeId: self, viewer: true, ownerName };
}
