// ════════════════════════════════════════════════════════════════════════════
// province-seats.js — ملء مقاعد فريق محافظة بأسماء جديدة من «المستخدمين» بالماستر أدمن.
//
// كل اسم = حساب جديد: اسم الدخول والاسم الظاهر هو المكتوب، والرمز موحّد. كل مقعد
// يُعالَج وحده: فشل اسم لا يوقف البقية ويُعاد مكتوباً على مقعده.
// ════════════════════════════════════════════════════════════════════════════

import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma.js';
import { encryptPassword } from '../../lib/passwordCrypto.js';
import { syncUserAreaDerivedLinks } from '../../lib/areaScope.js';
import { syncUserItemDerivedLinks } from '../../lib/itemScope.js';
import { shareOfficeFilesWithNewUser } from '../../lib/officeFileShares.js';
import { loadSeatManagers, leaderScopeFromManagers } from '../../lib/provinceSeats.js';
import * as provinceTeamsService from '../province-teams/province-teams.service.js';
import { assignmentFillsSeat, planSeatAssignments } from '../province-teams/province-teams.rules.js';
import { buildDefaultPermissions, findUsernameConflict } from './admin-users.controller.js';

const SEAT_PASSWORD = '123456789';

const seatError = (message, extra = {}) => Object.assign(new Error(message), { isSeatError: true, ...extra });
const cleanName = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

async function createAccount(name, role, officeId) {
  const conflict = await findUsernameConflict(name);
  if (conflict) {
    const e = conflict.existing;
    throw seatError(`الاسم «${name}» محجوز لحساب موجود (${e.officeName || 'بدون مكتب'} · ${e.isActive ? 'نشط' : 'معطّل'} · رقم ${e.id}) — اكتب اسماً مختلفاً`);
  }
  try {
    return await prisma.user.create({
      data: {
        username: name,
        displayName: name,
        passwordHash: await bcrypt.hash(SEAT_PASSWORD, 12),
        passwordEncrypted: encryptPassword(SEAT_PASSWORD),
        role,
        officeId,
        permissions: JSON.stringify(buildDefaultPermissions()),
      },
      select: { id: true, username: true },
    });
  } catch (err) {
    if (err.code === 'P2002') throw seatError(`الاسم «${name}» مستخدم بالفعل — اكتب اسماً مختلفاً`);
    throw err;
  }
}

/** ما يتبقى بعد ملء المقعد: محافظة الحساب (مناطقها الآن ومستقبلاً) وملفات مكتبه. */
async function finishAccount(userId, provinceId) {
  await prisma.userProvinceAssignment.createMany({ data: [{ userId, provinceId }], skipDuplicates: true });
  await syncUserAreaDerivedLinks(userId);
  await syncUserItemDerivedLinks(userId);
  await shareOfficeFilesWithNewUser(userId).catch(e => console.error('[province-seats] office files share', e.message));
}

/** فشل بعد إنشاء الحساب يحذفه: وإلا ردّت إعادة المحاولة بنفس الاسم أنه محجوز لحساب ناقص. */
async function orRemoveAccount(userId, build) {
  try {
    return await build();
  } catch (err) {
    await prisma.user.delete({ where: { id: userId } }).catch(e => console.error('[province-seats] rollback', userId, e.message));
    throw err;
  }
}

async function setUserScope(userId, companies, itemIds) {
  await prisma.$transaction([
    ...(companies.length ? [prisma.userCompanyAssignment.createMany({ data: companies.map(c => ({ userId, ...c })), skipDuplicates: true })] : []),
    ...(itemIds.length ? [prisma.userItemAssignment.createMany({ data: itemIds.map(itemId => ({ userId, itemId })), skipDuplicates: true })] : []),
  ]);
}

async function activeTeam(officeId, provinceId) {
  const team = await prisma.provinceTeam.findUnique({ where: { officeId_provinceId: { officeId, provinceId } } });
  return team?.isActive ? team : null;
}

/** تيم ليدر جديد: كل شركات وايتمات مدراء الشركات، بلا شركة رئيسية. */
async function fillLeaderSeat({ name, officeId, provinceId, asOffice, seats }) {
  if ((await activeTeam(officeId, provinceId))?.leaderUserId) throw seatError('لهذه المحافظة تيم ليدر بالفعل');
  const user = await createAccount(name, 'team_leader', officeId);
  await orRemoveAccount(user.id, async () => {
    const { companyIds, itemIds } = await leaderScopeFromManagers(seats);
    // الشركات قبل تعيينه قائداً: syncProvinceLeaderCompanies يمنح من بلا شركات كل شركات المكتب.
    await setUserScope(user.id, companyIds.map(companyId => ({ companyId, isPrimary: false })), itemIds);
    const team = await activeTeam(officeId, provinceId);
    if (team) await provinceTeamsService.updateTeam(asOffice, team.id, { leaderUserId: user.id });
    else await provinceTeamsService.createTeam(asOffice, { provinceId, leaderUserId: user.id });
    await finishAccount(user.id, provinceId);
  });
  return { userId: user.id, username: user.username, warnings: [] };
}

/** مندوب جديد في مقعد مدير: ايتمات المدير، وشركاته التي تحمل هذه الايتمات. */
async function fillRepSeat({ name, seat, officeId, provinceId, asOffice }) {
  const team = await activeTeam(officeId, provinceId);
  const rows = team
    ? await prisma.provinceRepAssignment.findMany({
        where: { teamId: team.id, isActive: true },
        include: { items: { select: { itemId: true } }, rep: { select: { displayName: true, username: true } } },
      })
    : [];
  const siblings = rows.map(r => ({
    id: r.id, repUserId: r.repUserId, repName: r.rep.displayName || r.rep.username,
    companyId: r.companyId, allItems: r.allItems, itemIds: r.items.map(i => i.itemId),
  }));
  if (siblings.some(s => assignmentFillsSeat(s, seat))) throw seatError(`مقعد ${seat.companyName} مشغول بالفعل`);

  const plan = planSeatAssignments(seat, siblings);
  if (!plan.assignments.length) {
    throw seatError(plan.dropped.length
      ? `كل ايتمات ${seat.companyName} معيَّنة لـ${[...new Set(plan.dropped.map(d => d.repName))].join('، ')} في هذه المحافظة`
      : `ايتمات ${seat.name} غير مرتبطة بشركة في هذا المكتب`);
  }

  const user = await createAccount(name, 'scientific_rep', officeId);
  await orRemoveAccount(user.id, async () => {
    const companyIds = plan.assignments.map(a => a.companyId);
    const primary = companyIds.includes(seat.companyId) ? seat.companyId : companyIds[0];
    await setUserScope(user.id, companyIds.map(companyId => ({ companyId, isPrimary: companyId === primary })), plan.keptItemIds);

    const teamId = (team ?? await provinceTeamsService.createTeam(asOffice, { provinceId })).id;
    for (const a of plan.assignments) {
      await provinceTeamsService.saveAssignment(asOffice, teamId, { repUserId: user.id, companyId: a.companyId, allItems: a.allItems, itemIds: a.itemIds });
    }
    await finishAccount(user.id, provinceId);
  });
  const warnings = plan.dropped.length
    ? [`تُركت له ايتمات أقل: بعضها معيَّن لـ${[...new Set(plan.dropped.map(d => d.repName))].join('، ')} في هذه المحافظة`]
    : [];
  return { userId: user.id, username: user.username, warnings };
}

// body: { officeId, provinceId, leaderName?, reps?: [{ managerUserId, name }] }
export async function createProvinceSeats(req, res, next) {
  try {
    const officeId = parseInt(req.body?.officeId);
    const provinceId = parseInt(req.body?.provinceId);
    if (!Number.isInteger(officeId) || !Number.isInteger(provinceId)) {
      return res.status(400).json({ error: 'المكتب والمحافظة مطلوبان' });
    }
    const province = await prisma.province.findUnique({ where: { id: provinceId }, select: { id: true } });
    if (!province) return res.status(400).json({ error: 'المحافظة غير موجودة' });

    const asOffice = { officeId, canEditStructure: true };
    const seats = await loadSeatManagers([officeId]);
    const results = [];
    const run = async (seatKey, fill) => {
      try {
        results.push({ seatKey, ok: true, ...(await fill()) });
      } catch (err) {
        if (!err.isSeatError && !err.isOperational) console.error('[province-seats]', seatKey, err);
        results.push({ seatKey, ok: false, error: err.isSeatError || err.isOperational ? err.message : 'تعذّر إنشاء الحساب — حاول مرة أخرى' });
      }
    };

    // القائد أولاً: saveAssignment يربط كل مندوب جديد بقائد الفريق.
    const leaderName = cleanName(req.body?.leaderName);
    if (leaderName) await run('leader', () => fillLeaderSeat({ name: leaderName, officeId, provinceId, asOffice, seats }));

    for (const r of Array.isArray(req.body?.reps) ? req.body.reps : []) {
      const name = cleanName(r?.name);
      if (!name) continue;
      const seat = seats.find(s => s.userId === Number(r.managerUserId));
      await run(`m${r.managerUserId}`, async () => {
        if (!seat) throw seatError('مدير الشركة غير موجود في هذا المكتب');
        return fillRepSeat({ name, seat, officeId, provinceId, asOffice });
      });
    }
    res.json({ success: true, results, password: SEAT_PASSWORD });
  } catch (e) {
    next(e);
  }
}
