// ════════════════════════════════════════════════════════════════════════════
// province-teams.service.js — هيكلية فرق المحافظات: الفرق، القادة، التعيينات.
//
// الحساب (تغطية المحافظة) في province-coverage.js، والجهد الشخصي في
// personal-sales.service.js. القواعد النقية في province-teams.rules.js.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  teamScopeWhere, canSeeAssignment, canReviewTeam, assertStructureEditor,
  REP_CANDIDATE_ROLES, LEADER_CANDIDATE_ROLES,
} from './province-teams.access.js';
import { findItemConflicts, resolveAssignmentItemIds } from './province-teams.rules.js';
import { syncProvinceLeaderCompanies } from '../../lib/provinceScope.js';

const userName = (u) => (u ? (u.displayName || u.username) : null);

const TEAM_INCLUDE = {
  province: { select: { id: true, name: true, sortOrder: true } },
  leader:   { select: { id: true, displayName: true, username: true, role: true } },
  assignments: {
    where: { isActive: true },
    orderBy: { id: 'asc' },
    include: {
      rep:     { select: { id: true, displayName: true, username: true, role: true, isActive: true } },
      company: { select: { id: true, name: true } },
      items:   { select: { itemId: true } },
    },
  },
};

/** ايتمات الكتالوج لكل شركة — لحسم «كل ايتمات الشركة». */
export async function loadCompanyItems(companyIds) {
  const ids = [...new Set(companyIds)].filter(Number.isInteger);
  const map = new Map(ids.map(id => [id, []]));
  if (!ids.length) return map;
  const rows = await prisma.item.findMany({
    where: { scientificCompanyId: { in: ids }, isTemp: false },
    select: { id: true, scientificCompanyId: true },
  });
  for (const r of rows) map.get(r.scientificCompanyId)?.push(r.id);
  return map;
}

/**
 * الفرق المرئية للمُشاهِد، بتعيينات مُصفّاة حسب صلاحيته.
 * @returns {Promise<Array>} شكل خام قريب من Prisma + itemIds محسومة
 */
export async function loadVisibleTeams(viewer, { teamId = null } = {}) {
  const where = { isActive: true, ...teamScopeWhere(viewer) };
  if (teamId) where.id = teamId;
  const teams = await prisma.provinceTeam.findMany({
    where,
    include: TEAM_INCLUDE,
    orderBy: [{ province: { sortOrder: 'asc' } }, { province: { name: 'asc' } }],
  });
  const companyItems = await loadCompanyItems(teams.flatMap(t => t.assignments.map(a => a.companyId)));

  return teams.map(t => {
    const all = t.assignments.map(a => ({
      id: a.id,
      repUserId: a.repUserId,
      repName: userName(a.rep),
      repActive: a.rep?.isActive !== false,
      companyId: a.companyId,
      companyName: a.company?.name ?? '—',
      allItems: a.allItems,
      itemIds: resolveAssignmentItemIds({ ...a, itemIds: a.items.map(i => i.itemId) }, companyItems),
      explicitItemIds: a.items.map(i => i.itemId),
    }));
    return {
      id: t.id,
      officeId: t.officeId,
      provinceId: t.provinceId,
      provinceName: t.province.name,
      leaderUserId: t.leaderUserId,
      leaderName: userName(t.leader),
      notes: t.notes,
      // كل التعيينات تبقى للحساب الداخلي (سلّة «غير منسوب» تحتاج معرفة ما هو
      // معيَّن فعلاً حتى لو لم يُعرض)، والمرئي منها وحده يصل الواجهة.
      allAssignments: all,
      assignments: all.filter(a => canSeeAssignment(viewer, t, a)),
      canReview: canReviewTeam(viewer, t),
      isLeader: t.leaderUserId === viewer.id,
    };
  });
}

// ─── خيارات الواجهة ──────────────────────────────────────────────────────────

export async function getOptions(viewer) {
  const provinces = await prisma.province.findMany({
    select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  if (!viewer.officeId) return { provinces, leaders: [], reps: [], companies: [] };

  const [users, companies] = await Promise.all([
    prisma.user.findMany({
      where: {
        officeId: viewer.officeId, isActive: true,
        role: { in: [...new Set([...REP_CANDIDATE_ROLES, ...LEADER_CANDIDATE_ROLES])] },
      },
      select: {
        id: true, displayName: true, username: true, role: true,
        companyAssignments: { where: { isPrimary: true }, select: { company: { select: { name: true } } } },
      },
      orderBy: { displayName: 'asc' },
    }),
    prisma.scientificCompany.findMany({
      where: { officeId: viewer.officeId, isActive: true },
      select: { id: true, name: true, _count: { select: { items: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  const toOpt = (u) => ({ id: u.id, name: userName(u), role: u.role, company: u.companyAssignments[0]?.company?.name ?? null });
  return {
    provinces,
    leaders: users.filter(u => LEADER_CANDIDATE_ROLES.includes(u.role)).map(toOpt),
    reps: users.filter(u => REP_CANDIDATE_ROLES.includes(u.role)).map(toOpt),
    companies: companies.map(c => ({ id: c.id, name: c.name, itemCount: c._count.items })),
  };
}

export async function getCompanyItems(viewer, companyId) {
  const company = await prisma.scientificCompany.findUnique({ where: { id: companyId }, select: { id: true, officeId: true } });
  if (!company || company.officeId !== viewer.officeId) throw new AppError('الشركة غير موجودة في مكتبك', 404, 'NOT_FOUND');
  return prisma.item.findMany({
    where: { scientificCompanyId: companyId, isTemp: false },
    select: { id: true, name: true, scientificName: true, price: true, warehousePrice: true },
    orderBy: { name: 'asc' },
  });
}

// ─── الفرق ────────────────────────────────────────────────────────────────────

async function assertOfficeUser(userId, officeId, roles, label) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, officeId: true, role: true, isActive: true } });
  if (!u || u.officeId !== officeId) throw new AppError(`${label} ليس من حسابات مكتبك`, 400, 'BAD_USER');
  if (roles && !roles.includes(u.role)) throw new AppError(`دور الحساب لا يصلح ${label}`, 400, 'BAD_ROLE');
  return u;
}

/**
 * يربط مندوبي الفريق بقائده في التسلسل الوظيفي القائم (UserManagerAssignment)
 * — فتظهر زياراتهم وبلاناتهم ومتابعتهم للقائد في كل الصفحات القائمة بلا تعديلها.
 * إضافة فقط: لا يحذف روابط إدارية أخرى قد يكون المكتب وضعها يدوياً.
 */
async function linkRepsToLeader(leaderUserId, repUserIds) {
  if (!leaderUserId) return;
  const ids = [...new Set(repUserIds)].filter(id => id && id !== leaderUserId);
  if (!ids.length) return;
  await prisma.userManagerAssignment.createMany({
    data: ids.map(userId => ({ userId, managerId: leaderUserId })),
    skipDuplicates: true,
  });
}

/**
 * تسجيل مندوب علمي تلقائياً في فرق المحافظات المعيَّنة له (UserProvinceAssignment).
 * تعيين المحافظة للمندوب في «المستخدمين» = إدخاله فريق تلك المحافظة، فلا يُكرَّر
 * العمل في «الهيكلية». يُنشئ الفريق إن لم يوجد، ويُنشئ تعييناً لكل شركة من شركات
 * المندوب بايتماته المحددة له (أو «كل ايتمات الشركة» إن لم تُحدَّد ايتمات).
 *
 * إضافة فقط وidempotent: لا يعدّل تعييناً قائماً ولا يحذف شيئاً. تعيين يتعارض
 * ايتماته مع مندوب آخر لنفس الشركة يُتخطّى ويُبلَّغ عنه ولا يُرمى.
 * @returns {Promise<{enrolled:number, skipped:{province:string, company:string, reason:string}[], reason?:string}>}
 */
export async function autoEnrollRep(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, role: true, officeId: true, isActive: true,
      provinceAssignments: { select: { provinceId: true, province: { select: { name: true } } } },
      companyAssignments: { select: { companyId: true, company: { select: { name: true, officeId: true } } } },
      itemAssignments: { select: { itemId: true, item: { select: { scientificCompanyId: true } } } },
    },
  });
  const out = { enrolled: 0, skipped: [] };
  if (!u || u.role !== 'scientific_rep' || !u.officeId || !u.isActive) return { ...out, reason: 'not-eligible' };
  if (!u.provinceAssignments.length) return { ...out, reason: 'no-province' };

  const companies = u.companyAssignments.filter(c => c.company.officeId === u.officeId);
  if (!companies.length) return { ...out, reason: 'no-company' };
  const companyItems = await loadCompanyItems(companies.map(c => c.companyId));

  for (const pa of u.provinceAssignments) {
    let team = await prisma.provinceTeam.findUnique({ where: { officeId_provinceId: { officeId: u.officeId, provinceId: pa.provinceId } } });
    if (!team) team = await prisma.provinceTeam.create({ data: { officeId: u.officeId, provinceId: pa.provinceId } });
    else if (!team.isActive) team = await prisma.provinceTeam.update({ where: { id: team.id }, data: { isActive: true } });

    for (const c of companies) {
      const exists = await prisma.provinceRepAssignment.findUnique({
        where: { teamId_repUserId_companyId: { teamId: team.id, repUserId: u.id, companyId: c.companyId } },
      });
      if (exists?.isActive) continue; // موجود (ربما يدوياً) — لا نمسّه
      const mine = u.itemAssignments.filter(i => i.item.scientificCompanyId === c.companyId).map(i => i.itemId);
      const allItems = mine.length === 0;

      const siblings = await prisma.provinceRepAssignment.findMany({
        where: { teamId: team.id, companyId: c.companyId, isActive: true },
        include: { items: { select: { itemId: true } } },
      });
      const conflicts = findItemConflicts(
        { id: exists?.id ?? null, repUserId: u.id, companyId: c.companyId, allItems, itemIds: mine },
        siblings.map(s => ({ id: s.id, repUserId: s.repUserId, companyId: s.companyId, allItems: s.allItems, itemIds: s.items.map(i => i.itemId) })),
      );
      if (conflicts.length) {
        out.skipped.push({ province: pa.province.name, company: c.company.name, reason: 'مندوب آخر لنفس الشركة معيَّن على ايتمات متقاطعة' });
        continue;
      }
      await prisma.$transaction(async (tx) => {
        const a = exists
          ? await tx.provinceRepAssignment.update({ where: { id: exists.id }, data: { isActive: true, allItems } })
          : await tx.provinceRepAssignment.create({ data: { teamId: team.id, repUserId: u.id, companyId: c.companyId, allItems } });
        await tx.provinceRepAssignmentItem.deleteMany({ where: { assignmentId: a.id } });
        if (!allItems) await tx.provinceRepAssignmentItem.createMany({ data: mine.map(itemId => ({ assignmentId: a.id, itemId })) });
      });
      out.enrolled++;
    }
    await linkRepsToLeader(team.leaderUserId, [u.id]);
  }
  return out;
}

/** تسجيل كل المندوبين الذين لهم محافظات (backfill عند إقلاع الخادم). */
export async function autoEnrollAllReps() {
  const reps = await prisma.user.findMany({
    where: { role: 'scientific_rep', isActive: true, officeId: { not: null }, provinceAssignments: { some: {} } },
    select: { id: true },
  });
  let n = 0;
  for (const r of reps) {
    try { n += (await autoEnrollRep(r.id)).enrolled; } catch (e) { console.error('[autoEnrollRep]', r.id, e.message); }
  }
  return n;
}

export async function createTeam(viewer, { provinceId, leaderUserId = null, notes = null }) {
  assertStructureEditor(viewer);
  const pid = Number(provinceId);
  const province = await prisma.province.findUnique({ where: { id: pid }, select: { id: true, name: true } });
  if (!province) throw new AppError('المحافظة غير موجودة', 400, 'BAD_PROVINCE');
  if (leaderUserId) await assertOfficeUser(Number(leaderUserId), viewer.officeId, LEADER_CANDIDATE_ROLES, 'قائد الفريق');

  const existing = await prisma.provinceTeam.findUnique({
    where: { officeId_provinceId: { officeId: viewer.officeId, provinceId: pid } },
  });
  if (existing?.isActive) throw new AppError(`فريق ${province.name} موجود مسبقاً`, 409, 'DUPLICATE_TEAM');

  const team = existing
    ? await prisma.provinceTeam.update({ where: { id: existing.id }, data: { isActive: true, leaderUserId: leaderUserId ? Number(leaderUserId) : null, notes } })
    : await prisma.provinceTeam.create({
        data: { officeId: viewer.officeId, provinceId: pid, leaderUserId: leaderUserId ? Number(leaderUserId) : null, notes },
      });
  if (team.leaderUserId) await syncProvinceLeaderCompanies(team.leaderUserId, viewer.officeId);
  return team;
}

export async function updateTeam(viewer, id, { leaderUserId, notes }) {
  assertStructureEditor(viewer);
  const team = await prisma.provinceTeam.findUnique({ where: { id }, include: { assignments: { where: { isActive: true }, select: { repUserId: true } } } });
  if (!team || team.officeId !== viewer.officeId) throw new AppError('الفريق غير موجود', 404, 'NOT_FOUND');
  const data = {};
  if (leaderUserId !== undefined) {
    if (leaderUserId) await assertOfficeUser(Number(leaderUserId), viewer.officeId, LEADER_CANDIDATE_ROLES, 'قائد الفريق');
    data.leaderUserId = leaderUserId ? Number(leaderUserId) : null;
  }
  if (notes !== undefined) data.notes = notes || null;
  const updated = await prisma.provinceTeam.update({ where: { id }, data });
  if (data.leaderUserId) {
    await linkRepsToLeader(data.leaderUserId, team.assignments.map(a => a.repUserId));
    await syncProvinceLeaderCompanies(data.leaderUserId, viewer.officeId);
  }
  return updated;
}

/** إيقاف لا حذف: الجهد الشخصي المعتمد يبقى مرتبطاً بفريقه للأرشيف. */
export async function archiveTeam(viewer, id) {
  assertStructureEditor(viewer);
  const team = await prisma.provinceTeam.findUnique({ where: { id } });
  if (!team || team.officeId !== viewer.officeId) throw new AppError('الفريق غير موجود', 404, 'NOT_FOUND');
  await prisma.$transaction([
    prisma.provinceRepAssignment.updateMany({ where: { teamId: id }, data: { isActive: false } }),
    prisma.provinceTeam.update({ where: { id }, data: { isActive: false } }),
  ]);
}

// ─── التعيينات ────────────────────────────────────────────────────────────────

/**
 * ينشئ أو يعدّل تعيين (مندوب × شركة) داخل فريق. يرفض أي تقاطع ايتمات مع مندوب
 * آخر لنفس الشركة في نفس المحافظة، ويُرجع التعارضات مسمّاة كي يصحّحها المستخدم.
 */
export async function saveAssignment(viewer, teamId, body) {
  assertStructureEditor(viewer);
  const team = await prisma.provinceTeam.findUnique({ where: { id: teamId } });
  if (!team || !team.isActive || team.officeId !== viewer.officeId) throw new AppError('الفريق غير موجود', 404, 'NOT_FOUND');

  const repUserId = Number(body.repUserId);
  const companyId = Number(body.companyId);
  const allItems = Boolean(body.allItems);
  await assertOfficeUser(repUserId, viewer.officeId, REP_CANDIDATE_ROLES, 'المندوب');

  const company = await prisma.scientificCompany.findUnique({ where: { id: companyId }, select: { id: true, officeId: true, name: true } });
  if (!company || company.officeId !== viewer.officeId) throw new AppError('الشركة ليست من شركات مكتبك', 400, 'BAD_COMPANY');

  let itemIds = [];
  if (!allItems) {
    itemIds = [...new Set((body.itemIds ?? []).map(Number).filter(Number.isInteger))];
    if (!itemIds.length) throw new AppError('اختر ايتماً واحداً على الأقل، أو فعّل «كل ايتمات الشركة»', 400, 'NO_ITEMS');
    const valid = await prisma.item.findMany({ where: { id: { in: itemIds }, scientificCompanyId: companyId }, select: { id: true } });
    if (valid.length !== itemIds.length) throw new AppError(`بعض الايتمات المختارة لا تتبع شركة ${company.name}`, 400, 'ITEM_COMPANY_MISMATCH');
  }

  // التعيين الحالي لنفس (مندوب × شركة) — تعديل لا إنشاء ثانٍ.
  const id = body.id ? Number(body.id)
    : (await prisma.provinceRepAssignment.findUnique({
        where: { teamId_repUserId_companyId: { teamId, repUserId, companyId } }, select: { id: true },
      }))?.id ?? null;

  const siblings = await prisma.provinceRepAssignment.findMany({
    where: { teamId, companyId, isActive: true },
    include: { items: { select: { itemId: true } }, rep: { select: { displayName: true, username: true } } },
  });
  const conflicts = findItemConflicts(
    { id, repUserId, companyId, allItems, itemIds },
    siblings.map(s => ({ id: s.id, repUserId: s.repUserId, repName: userName(s.rep), companyId: s.companyId, allItems: s.allItems, itemIds: s.items.map(i => i.itemId) })),
  );
  if (conflicts.length) {
    const names = await prisma.item.findMany({ where: { id: { in: conflicts.flatMap(c => c.itemIds) } }, select: { id: true, name: true } });
    const nameOf = new Map(names.map(n => [n.id, n.name]));
    const err = new AppError(
      conflicts.map(c => c.kind === 'all'
        ? `${c.repName} معيَّن على ايتمات ${company.name} في هذه المحافظة — قسّم الايتمات بينكما بدل «كل الايتمات»`
        : `${c.repName} معيَّن مسبقاً على: ${c.itemIds.map(i => nameOf.get(i) ?? `#${i}`).join('، ')}`).join(' · '),
      409, 'ITEM_CONFLICT',
    );
    err.details = conflicts.map(c => ({ ...c, itemNames: c.itemIds.map(i => nameOf.get(i) ?? `#${i}`) }));
    throw err;
  }

  const saved = await prisma.$transaction(async (tx) => {
    const a = id
      ? await tx.provinceRepAssignment.update({ where: { id }, data: { repUserId, companyId, allItems, isActive: true } })
      : await tx.provinceRepAssignment.create({ data: { teamId, repUserId, companyId, allItems } });
    await tx.provinceRepAssignmentItem.deleteMany({ where: { assignmentId: a.id } });
    if (!allItems) {
      await tx.provinceRepAssignmentItem.createMany({ data: itemIds.map(itemId => ({ assignmentId: a.id, itemId })) });
    }
    return a;
  });
  await linkRepsToLeader(team.leaderUserId, [repUserId]);
  return saved;
}

export async function removeAssignment(viewer, id) {
  assertStructureEditor(viewer);
  const a = await prisma.provinceRepAssignment.findUnique({ where: { id }, include: { team: true } });
  if (!a || a.team.officeId !== viewer.officeId) throw new AppError('التعيين غير موجود', 404, 'NOT_FOUND');
  await prisma.provinceRepAssignment.delete({ where: { id } });
}

/** ايتمات مندوب عبر كل تعييناته — لقائمة الإدخال في «الجهد الشخصي». */
export async function getRepItems(repUserId) {
  const assignments = await prisma.provinceRepAssignment.findMany({
    where: { repUserId, isActive: true, team: { isActive: true } },
    include: { items: { select: { itemId: true } }, company: { select: { id: true, name: true } }, team: { select: { id: true, province: { select: { name: true } } } } },
  });
  const companyItems = await loadCompanyItems(assignments.map(a => a.companyId));
  const itemToCompany = new Map();
  for (const a of assignments) {
    for (const itemId of resolveAssignmentItemIds({ ...a, itemIds: a.items.map(i => i.itemId) }, companyItems)) {
      if (!itemToCompany.has(itemId)) itemToCompany.set(itemId, { companyId: a.companyId, companyName: a.company.name, teamId: a.teamId });
    }
  }
  const items = itemToCompany.size
    ? await prisma.item.findMany({
        where: { id: { in: [...itemToCompany.keys()] } },
        select: { id: true, name: true, price: true, warehousePrice: true },
        orderBy: { name: 'asc' },
      })
    : [];
  return {
    teams: [...new Map(assignments.map(a => [a.team.id, { id: a.team.id, provinceName: a.team.province.name }])).values()],
    items: items.map(i => ({ ...i, ...itemToCompany.get(i.id) })),
  };
}
