// ════════════════════════════════════════════════════════════════════════════
// province-teams.access.js — من يرى ماذا في فرق المحافظات.
//
// أربعة أنماط مُشاهدة (قرار المستخدم 2026-10-13):
//   office  — إدارة المكتب: كل فرق مكتبها، وتعدّل الهيكلية وتعتمد.
//   leader  — تيم ليدر المحافظة: فرقه هو بكل شركاتها، ويعتمد الجهد الشخصي.
//   company — مدير الشركة ومن بمستواه: مندوبو شركاته في المحافظات **بايتمات
//             شركاته فقط** — المندوب المشترك يظهر له بنصيب شركته وحده.
//   rep     — المندوب: تعييناته هو وجهده الشخصي.
// التيم ليدر أو المندوب قد يكون مُعيَّناً كمندوب في فريق آخر أيضاً — فيرى هناك
// تعييناته وحدها.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';

/** أدوار إدارة المكتب: ترى كل فرق المكتب، تبني الهيكلية، وتعتمد. */
// «user» دور قديم لحسابات المكتب (يرى ما يراه موظف المكتب) — بلا مكتب لا يرى شيئاً أصلاً.
export const OFFICE_ROLES = new Set(['admin', 'manager', 'office_manager', 'office_hr', 'office_employee', 'user']);
/** أدوار مُقيَّدة بشركاتها (UserCompanyAssignment). */
export const COMPANY_ROLES = new Set(['company_manager', 'supervisor', 'product_manager']);
/** من يصلح مندوباً في فريق محافظة. */
export const REP_CANDIDATE_ROLES = ['scientific_rep', 'team_leader'];
/** من يصلح قائداً لفريق محافظة. */
export const LEADER_CANDIDATE_ROLES = ['team_leader', 'supervisor', 'scientific_rep'];

/**
 * @param {{id:number}} reqUser
 * @returns {Promise<{id:number, role:string, officeId:number|null, name:string,
 *   mode:'office'|'leader'|'company'|'rep', canEditStructure:boolean, companyIds:number[]}>}
 */
export async function loadViewer(reqUser) {
  const u = await prisma.user.findUnique({
    where: { id: reqUser.id },
    select: {
      id: true, role: true, officeId: true, displayName: true, username: true,
      companyAssignments: { select: { companyId: true } },
      _count: { select: { provinceTeamsLed: true } },
    },
  });
  if (!u) throw new AppError('الحساب غير موجود', 404, 'NOT_FOUND');

  let mode;
  if (OFFICE_ROLES.has(u.role)) mode = 'office';
  else if (COMPANY_ROLES.has(u.role)) mode = 'company';
  // قائد فريق محافظة فعلاً (بصرف النظر عن اسم دوره) يُعامَل قائداً.
  else if (u.role === 'team_leader' || u._count.provinceTeamsLed > 0) mode = 'leader';
  else mode = 'rep';

  return {
    id: u.id,
    role: u.role,
    officeId: u.officeId ?? null,
    name: u.displayName || u.username,
    mode,
    canEditStructure: mode === 'office' && u.officeId != null,
    companyIds: u.companyAssignments.map(c => c.companyId),
  };
}

/** شرط Prisma لفرق المحافظة المرئية لهذا المُشاهِد. */
export function teamScopeWhere(viewer) {
  const mineOrLed = { OR: [{ leaderUserId: viewer.id }, { assignments: { some: { repUserId: viewer.id } } }] };
  switch (viewer.mode) {
    case 'office':
      return viewer.officeId ? { officeId: viewer.officeId } : { id: -1 };
    case 'company':
      if (!viewer.officeId || !viewer.companyIds.length) return mineOrLed;
      return {
        OR: [
          { officeId: viewer.officeId, assignments: { some: { companyId: { in: viewer.companyIds } } } },
          mineOrLed.OR[0], mineOrLed.OR[1],
        ],
      };
    default:
      return mineOrLed;
  }
}

/** هل يرى المُشاهِد هذا التعيين (مندوب × شركة) داخل فريق مرئي له؟ */
export function canSeeAssignment(viewer, team, a) {
  if (viewer.mode === 'office' && team.officeId === viewer.officeId) return true;
  if (team.leaderUserId === viewer.id) return true;
  if (a.repUserId === viewer.id) return true;
  if (viewer.mode === 'company' && team.officeId === viewer.officeId) return viewer.companyIds.includes(a.companyId);
  return false;
}

/** يعتمد/يرفض الجهد الشخصي: قائد الفريق، أو إدارة المكتب. */
export function canReviewTeam(viewer, team) {
  // صفّ بلا فريق (بوت لم يُعرف مندوبه) يُحسم بمكتبه عند المُستدعي، لا هنا.
  if (!team) return false;
  if (team.leaderUserId === viewer.id) return true;
  return viewer.mode === 'office' && team.officeId === viewer.officeId;
}

export function assertStructureEditor(viewer) {
  if (!viewer.canEditStructure) {
    throw new AppError(
      viewer.officeId ? 'تعديل هيكلية المحافظات متاح لإدارة المكتب فقط' : 'الحساب غير مرتبط بمكتب علمي',
      403, 'FORBIDDEN',
    );
  }
}
