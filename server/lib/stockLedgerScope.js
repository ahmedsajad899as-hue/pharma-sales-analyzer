// ════════════════════════════════════════════════════════════════════════════
// stockLedgerScope.js — دفتر رصيد المذاخر دفترٌ واحد للمكتب: من يقرؤه ومن يكتب فيه.
//
// كان موظف المكتب يرفع، فيُعاد استيعاب نفس الصفوف في حساب كل مدير مكتب / HR /
// مدير شركة (autoSyncStockToManagers سابقاً): نسخة مستقلة لكل حساب — مذاخره،
// حركاته، أرصدته، روابط أسمائه. النسخ تتباعد حتماً:
//   • قرارات المطابقة (مذخر/شركة) تُحفظ لصاحب الرفع وحده، فتُحلَّل الأسماء عند كل
//     هدف بحالته هو (مذاخر مختلفة/مناطق مختلفة لنفس الاسم).
//   • حذف دفعة كان لحساب واحد فقط — لا يُعمَّم.
//   • أي استيراد يقوم به المدير في نسخته يُصفّر أزواجه ويُهمل كل مبيع أقدم منه.
//     شوهد فعلياً (2026-09-18): مدير شركة استورد «ستوك افتتاحي: فورما شهر 9»
//     بتاريخ 11/9 في نسخته وحدها، فصار افتتاحيه 11/9 (لا 1/9 كما عند الموظف)
//     وسقط كل مبيع 8/9–11/9 من حسابه وبقي مبيع 13/9 وحده — نفس المذاخر، أرقام مختلفة.
//
// الآن دفتر واحد لكل مكتب — دفتر موظف المكتب — يقرؤه الجميع (مدير المكتب / HR /
// مدير الشركة) مباشرةً بلا نسخ، وأي رفع يقوم به أحدهم يُكتب في الدفتر نفسه لا في
// دفتر خاص لا يراه غيره. دفاتر المدراء القديمة (نسخ التعميم + استيراداتهم
// الخاصة) تُهمَل بالكامل ولا تُعرض — لا حاجة لحذفها كي تصحّ الأرقام
// (scripts/cleanup-stock-ledger-mirrors.mjs يحذف نسخ التعميم كتنظيف اختياري).
// نفس فلسفة FileUserShare في ملفات المبيعات: مصدر واحد للحقيقة.
//
// مكتب فيه أكثر من موظف مكتب: تُقرأ دفاترهم كلها (اتحاد)، ويُكتب في دفتر أقدمهم
// (أصغر id) — حالة نادرة، والقاعدة ثابتة كي لا يتبعثر الرفع بين دفاتر. مدير بلا
// أي موظف مكتب في نطاقه (مكتب آخر مثلاً) يبقى على دفتره الخاص كما كان.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

/** الأدوار التي تقرأ/تكتب دفتر موظف المكتب بدل دفترها — نفس أهداف التعميم القديمة */
export const STOCK_VIEWER_ROLES = new Set(['office_manager', 'office_hr', 'company_manager']);

/**
 * @param {{id:number, role:string}} user  req.user (الـJWT لا يحمل officeId — يُقرأ هنا)
 * @returns {Promise<{
 *   readIds: number[],            // دفاتر تُقرأ (اتحاد)
 *   writeId: number,              // الدفتر الذي تُكتب فيه رفعاته — وهو أيضاً دفتر
 *                                 //   المطابقة (مذاخر/روابط أسماء/شركات) عند الاستيعاب
 *   viewer: boolean,              // هل يعمل على دفتر غيره (مدير يقرأ دفتر الموظف)
 *   ownerName: Map<number,string> // اسم صاحب كل دفتر للعرض في تبويب الدفعات
 * }>}
 */
export async function resolveLedgerScope(user) {
  const self = user?.id;
  const own = { readIds: self ? [self] : [], writeId: self ?? null, viewer: false, ownerName: new Map() };
  if (!self || !STOCK_VIEWER_ROLES.has(user.role)) return own;

  const me = await prisma.user.findUnique({ where: { id: self }, select: { officeId: true } });
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
  if (!employees.length) return own;

  return {
    readIds: employees.map(e => e.id),
    writeId: employees[0].id,
    viewer: true,
    ownerName: new Map(employees.map(e => [e.id, e.displayName || e.username])),
  };
}
