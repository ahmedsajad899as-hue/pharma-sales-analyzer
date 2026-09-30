// ════════════════════════════════════════════════════════════════════════════
// smartPlanPharmacyEdit.js — تعديل اسم صيدلية / دمج صيدليات في السيرفي الأصلي
// انطلاقاً من البلان الشهري الذكي. صيدليات اللوحة مبنية من اسم الصيدلية عند أطباء
// السيرفي (وقد لا يقابلها صف في MasterSurveyPharmacy)، لذا نطبّق التغيير على:
//   أطباء السيرفي (MasterSurveyDoctor) + صفوف Doctor المرتبطة + صفوف
//   MasterSurveyPharmacy + زيارات الصيدليات (PharmacyVisit) — كلها داخل منطقة
//   واحدة فقط (نفس الاسم في منطقة أخرى قد يكون فرعاً مختلفاً فلا نمسّه).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeAreaName } from './itemResolver.js';
import { logSurveyEdit } from './surveyDoctors.js';
import { buildRepAreaScope } from './smartPlanMatching.js';

const lc = s => String(s ?? '').trim().toLowerCase();

/**
 * @param {number} scientificRepId
 * @param {number} areaId       منطقة من مناطق المندوب
 * @param {string[]} oldNames   أسماء تُستبدل (اسم واحد = تعديل، أكثر = دمج)
 * @param {string} newName      الاسم الجديد/الباقي
 */
export async function renameOrMergePharmacies(scientificRepId, areaId, oldNames, newName, editedById) {
  const target = String(newName ?? '').trim();
  if (!target) return { error: 'empty_name' };

  const scope = await buildRepAreaScope(scientificRepId);
  if (!scope.areaIds.includes(areaId)) return { error: 'area_not_in_scope' };
  const inArea = name => scope.normToArea.get(normalizeAreaName(name ?? ''))?.id === areaId;

  const olds = new Set((oldNames || []).map(lc).filter(Boolean));
  olds.delete(lc(target));
  if (!olds.size) return { error: 'nothing_to_change' };
  const oldVariants = [...olds];

  let doctors = 0, pharmacyRows = 0, visits = 0;
  for (const surveyId of scope.surveyIds) {
    // 1) أطباء السيرفي + صفوف Doctor المرتبطة
    const docs = await prisma.masterSurveyDoctor.findMany({
      where: { surveyId, pharmacyName: { not: null } },
      select: { id: true, pharmacyName: true, areaName: true },
    });
    const docIds = docs.filter(d => olds.has(lc(d.pharmacyName)) && inArea(d.areaName)).map(d => d.id);
    if (docIds.length) {
      await prisma.masterSurveyDoctor.updateMany({ where: { id: { in: docIds } }, data: { pharmacyName: target } });
      await prisma.doctor.updateMany({ where: { masterSurveyDoctorId: { in: docIds } }, data: { pharmacyName: target } });
      doctors += docIds.length;
    }

    // 2) صفوف صيدليات السيرفي: إن وُجد صف بالاسم الهدف تُحذف المكرَّرات (دمج)، وإلا يُعاد تسمية أولها
    const rows = await prisma.masterSurveyPharmacy.findMany({ where: { surveyId } });
    const inAreaRows = rows.filter(r => inArea(r.areaName));
    const oldRows = inAreaRows.filter(r => olds.has(lc(r.name)));
    if (oldRows.length) {
      let keep = inAreaRows.find(r => lc(r.name) === lc(target));
      const toDelete = [...oldRows];
      if (!keep) {
        const first = toDelete.shift();
        const updated = await prisma.masterSurveyPharmacy.update({
          where: { id: first.id },
          data: { name: target, lastEditedById: editedById ?? null, lastEditedAt: new Date() },
        });
        await logSurveyEdit(surveyId, 'pharmacy', first.id, 'update', first, updated, editedById);
        keep = updated;
      }
      for (const r of toDelete) {
        await prisma.masterSurveyPharmacy.delete({ where: { id: r.id } });
        await logSurveyEdit(surveyId, 'pharmacy', r.id, 'delete', r, null, editedById);
      }
      pharmacyRows += oldRows.length;
    }
  }

  // 3) زيارات الصيدليات المسجَّلة بالاسم القديم داخل هذه المنطقة
  const visitRows = await prisma.pharmacyVisit.findMany({
    where: { OR: oldVariants.map(n => ({ pharmacyName: { equals: n, mode: 'insensitive' } })) },
    select: { id: true, areaId: true, areaName: true },
  });
  const visitIds = visitRows.filter(v => v.areaId === areaId || (v.areaId == null && inArea(v.areaName))).map(v => v.id);
  if (visitIds.length) {
    await prisma.pharmacyVisit.updateMany({ where: { id: { in: visitIds } }, data: { pharmacyName: target } });
    visits = visitIds.length;
  }

  // 4) تعريفات الصيدليات المفتوحة التي كانت تشير للاسم القديم تتبع الاسم الجديد
  await prisma.openPharmacyLink.updateMany({
    where: { OR: oldVariants.map(n => ({ toName: { equals: n, mode: 'insensitive' } })) },
    data: { toName: target },
  });

  return { doctors, pharmacyRows, visits };
}
