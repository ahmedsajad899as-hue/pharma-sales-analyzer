// ════════════════════════════════════════════════════════════════════════════
// usersCommon — أدوار المستخدمين وأنواعهم المشتركة بين صفحة التعيينات (UsersPage)
// ودليل المستخدمين (UsersDirectory) ولوحات المقاعد.
// ════════════════════════════════════════════════════════════════════════════
import type { ProvSplit, ProvTeamRep } from './ProvinceSeatsPanel';

export const ROLES = [
  { value: 'office_manager',          label: 'مدير مكتب' },
  { value: 'office_hr',               label: 'HR مكتب' },
  { value: 'office_employee',         label: 'موظف مكتب' },
  { value: 'company_manager',         label: 'مدير شركة' },
  { value: 'supervisor',              label: 'مشرف' },
  { value: 'product_manager',         label: 'مدير منتج' },
  { value: 'team_leader',             label: 'قائد فريق' },
  { value: 'scientific_rep',          label: 'مندوب علمي' },
  { value: 'pharmacy_manager',        label: 'مدير المسوقين' },
  { value: 'pharmacy_rep',            label: 'مندوب فارمسي لاين' },
  { value: 'pharmacy_team_leader',    label: 'قائد فريق فارمسي' },
  { value: 'commercial_supervisor',   label: 'مشرف تجاري' },
  { value: 'commercial_team_leader',  label: 'قائد فريق تجاري' },
  { value: 'commercial_rep',          label: 'مندوب تجاري' },
  { value: 'admin',                   label: 'مدير (admin)' },
  { value: 'manager',                 label: 'مدير (manager)' },
];

// «فارمسي لاين» خيار بالواجهة فقط: الدور الفعلي scientific_rep/team_leader و
// repKind='pharmacy' على سجل المندوب المرتبط (server/lib/pharmacyRep.js).
export const PHARMACY_FORM_ROLES: Record<string, string> = { pharmacy_rep: 'scientific_rep', pharmacy_team_leader: 'team_leader', pharmacy_manager: 'company_manager' };
export const PHARMACY_ROLE_OF: Record<string, string> = { scientific_rep: 'pharmacy_rep', team_leader: 'pharmacy_team_leader', company_manager: 'pharmacy_manager' };
export const isMarketer = (u: { linkedRep?: { repKind?: string } | null }) => u.linkedRep?.repKind === 'pharmacy';
export const formRoleOf = (u: { role: string; linkedRep?: { repKind?: string } | null }) =>
  isMarketer(u) ? (PHARMACY_ROLE_OF[u.role] ?? u.role) : u.role;
export const roleLabelOf = (u: { role: string; linkedRep?: { repKind?: string } | null }) => {
  const r = formRoleOf(u);
  return ROLES.find(x => x.value === r)?.label || u.role;
};

// الأدوار المكتبية — لا تُربط بشركة معيّنة، تحصل تلقائياً على كل شركات مكتبها
// (راجع server/lib/officeScope.js) لتتفاعل مع كل بيانات المكتب لا شركة بعينها.
export const OFFICE_SCOPED_ROLES = new Set(['office_manager', 'office_hr', 'office_employee']);

export interface UserRow {
  id: number; username: string; displayName?: string; role: string; phone?: string;
  isActive: boolean; officeId?: number; office?: { id: number; name: string };
  permissions?: string | null;
  _count?: { companyAssignments?: number; areas?: number; doctorVisits?: number };
  companyAssignments?: { companyId: number; isPrimary?: boolean; company: { id: number; name: string } }[];
  managersOfUser?:     { managerId: number; manager: { id: number; username: string; displayName?: string } }[];
  linkedRep?:          { id?: number; name?: string; repKind?: string } | null;
  side?:               string | null; // المسوقون: الكرخ/الرصافة
}

export interface ProvTeam {
  id: number; officeId: number; provinceId: number; provinceName: string; leaderUserId: number | null;
  reps: ProvTeamRep[];
  splits?: ProvSplit[];
}

/** إجراء إضافي في قائمة صف المستخدم (مثل «المقاعد والايتمات» داخل المقعد). */
export interface RowMenuItem { label: string; onClick: () => void; danger?: boolean }
/** خيارات رسم صف مستخدم داخل لوحات المقاعد. */
export interface RowOpts { extra?: RowMenuItem[]; tag?: string; note?: string }
