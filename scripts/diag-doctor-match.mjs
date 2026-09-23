/**
 * diag-doctor-match.mjs — تشخيص للاطلاع فقط (بلا أي تعديل): لماذا لم يُطابَق
 * اسم طبيب معيّن (موجود في السيرفي) عند استيراد زيارات لحساب معيّن.
 *
 * الاستعمال:
 *   node scripts/diag-doctor-match.mjs --user=43 --name="علي منهل ابراهيم" --area="ابو غريب"
 */

import prisma from '../server/lib/prisma.js';
import { normalizeAreaName } from '../server/lib/itemResolver.js';
import { normalizeRepName } from '../server/modules/scientific-reps/scientific-reps.service.js';
import { cleanDoctorName, doctorLinkKey } from '../server/lib/surveyDoctors.js';

const arg = (name) => {
  const a = process.argv.find(a => a.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const userId = Number(arg('user'));
const name = arg('name');
const area = arg('area') || '';

async function main() {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, role: true, officeId: true, linkedRepId: true } });
  console.log('المستخدم:', user);

  const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'commercial_rep'];
  let ownerId = userId;
  if (user && FIELD_ROLES.includes(user.role)) {
    if (user.linkedRepId) {
      const rep = await prisma.scientificRepresentative.findUnique({ where: { id: user.linkedRepId }, select: { userId: true } });
      if (rep?.userId) ownerId = rep.userId;
    }
    if (ownerId === userId) {
      const ma = await prisma.userManagerAssignment.findFirst({ where: { userId }, select: { managerId: true } });
      if (ma?.managerId) ownerId = ma.managerId;
    }
  }
  console.log(`resolveDocOwnerUserId(${userId}) = ${ownerId} (role=${user?.role}, في FIELD_ROLES=${FIELD_ROLES.includes(user?.role)})`);

  const localDoctors = await prisma.doctor.count({ where: { userId: ownerId } });
  console.log(`عدد صفوف Doctor محلية لـ ownerId=${ownerId}: ${localDoctors}`);

  const visibleSurveys = await prisma.masterSurvey.findMany({
    where: { isActive: true, hiddenUsers: { none: { userId: ownerId } } },
    select: { id: true, name: true },
  });
  console.log(`السيرفيات النشطة الظاهرة لـ ownerId=${ownerId} (isActive + !hiddenUsers):`, visibleSurveys);

  const allActiveSurveys = await prisma.masterSurvey.findMany({ where: { isActive: true }, select: { id: true, name: true } });
  console.log('كل السيرفيات النشطة (بصرف النظر عن hiddenUsers):', allActiveSurveys);

  const hiddenForThisUser = await prisma.masterSurveyHiddenUser.findMany({ where: { userId: ownerId }, select: { surveyId: true } });
  console.log(`سيرفيات مخفية صراحةً عن ownerId=${ownerId}:`, hiddenForThisUser);

  if (user?.officeId) {
    const hiddenForOffice = await prisma.masterSurveyHiddenOffice.findMany({ where: { officeId: user.officeId }, select: { surveyId: true } });
    console.log(`سيرفيات مخفية عن مكتب officeId=${user.officeId}:`, hiddenForOffice);
  }

  const matches = await prisma.masterSurveyDoctor.findMany({
    where: { name: { contains: name } },
    select: { id: true, surveyId: true, name: true, areaName: true, specialty: true, pharmacyName: true },
  });
  console.log(`\nأطباء سيرفي بأي اسم يحتوي "${name}":`, matches);

  const cleanNorm = normalizeRepName(cleanDoctorName(name));
  console.log(`\ncleanNorm المحسوب للاسم المستورَد: "${cleanNorm}"`);
  for (const m of matches) {
    console.log(`  مقارنة مع "${m.name}": normalizeRepName(cleanDoctorName) = "${normalizeRepName(cleanDoctorName(m.name))}" ${normalizeRepName(cleanDoctorName(m.name)) === cleanNorm ? '✅ يطابق' : '❌ لا يطابق'}`);
  }

  const fromKey = doctorLinkKey(name, area);
  console.log(`\ndoctorLinkKey المحسوب: "${fromKey}"`);
  const link = await prisma.doctorNameLink.findUnique({ where: { userId_fromKey: { userId: ownerId, fromKey } } }).catch(() => null);
  console.log(`DoctorNameLink محفوظ لهذا المفتاح ولـ ownerId=${ownerId}:`, link);

  // كل روابط هذا المستخدم التي قد تخص هذا الاسم بأي منطقة أخرى
  const anyLinks = await prisma.doctorNameLink.findMany({ where: { userId: ownerId, fromName: { contains: name } } });
  console.log(`كل DoctorNameLink لهذا المستخدم بأي اسم يحتوي "${name}":`, anyLinks);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
