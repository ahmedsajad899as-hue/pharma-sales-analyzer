// اختبار منطق متابعة المندوبين: حساب أيام العمل، المؤشّر الموزون، الأسباب.
// npm run test:rep-followup
import { workingDaysElapsed, workingDaysInMonth, parseRestWeekdays, effectiveFor, FOLLOWUP_DEFAULTS } from '../server/lib/followupStandards.js';
import { scoreCard, buildReasons, periodKeyOf } from '../server/modules/rep-followup/rep-followup.service.js';

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log('FAIL', name, '| got', JSON.stringify(got), '| want', JSON.stringify(want)); }
  else console.log('ok  ', name, '=', JSON.stringify(got));
};

// ── أيام العمل ─────────────────────────────────────────────────────────────
// أكتوبر 2026: 31 يوماً، الجمعات 2/9/16/23/30 = 5 → 26 يوم عمل
eq('workingDaysInMonth oct2026 (جمعة راحة)', workingDaysInMonth(2026, 10, '5'), 26);
eq('المنقضي حتى 9 تشرين', workingDaysElapsed(2026, 10, new Date(Date.UTC(2026, 9, 9)), '5'), 7);
eq('المنقضي حتى 1 تشرين', workingDaysElapsed(2026, 10, new Date(Date.UTC(2026, 9, 1)), '5'), 1);
// تشرين الأول 2026: 5 جمعات + 5 سبوت = 31 - 10 = 21
eq('جمعة + سبت راحة', workingDaysInMonth(2026, 10, '5,6'), 21);
eq('بلا أيام راحة', workingDaysInMonth(2026, 10, ''), 31);
eq('تجاهل قيم راحة غير صالحة', [...parseRestWeekdays('5, 9, x, 6')], [5, 6]);
eq('periodKey مصفوف بصفر', periodKeyOf(2026, 3), '2026-03');
// شهر سابق لتاريخ اليوم: يجب أن يُعيد الشهر كاملاً لا جزءاً
eq('شهر منتهٍ = كل أيامه', workingDaysElapsed(2026, 9, new Date(Date.UTC(2026, 9, 9)), '5'), workingDaysInMonth(2026, 9, '5'));

// ── الاستثناء لمندوب ───────────────────────────────────────────────────────
const eff = effectiveFor({ ...FOLLOWUP_DEFAULTS }, null);
eq('الافتراضي 8 أطباء/يوم', eff.doctorVisitsPerDay, 8);
const effOv = effectiveFor({ ...FOLLOWUP_DEFAULTS }, { doctorVisitsPerDay: 12, pharmacyVisitsPerDay: null, note: 'منطقة واسعة' });
eq('الاستثناء يطبَّق', effOv.doctorVisitsPerDay, 12);
eq('الحقل الفارغ يورث الافتراضي', effOv.pharmacyVisitsPerDay, 4);
eq('سبب الاستثناء محفوظ', effOv.overrideNote, 'منطقة واسعة');

// ── المؤشّر ────────────────────────────────────────────────────────────────
const baseMetrics = {
  target: { total: 0, achieved: 0, achievementPct: null, projectedPct: null, zeroSaleItems: [], neededPerDay: 0, remainingWorkDays: 0 },
  visits: { doctorVisitPct: 100, pharmacyVisitPct: 100, workDaysElapsed: 10, zeroDays: 0, monthProgressPct: 40, doctorVisits: 80, expectedDoctorVisits: 80, zeroDayList: [] },
  coverage: { doctorCoveragePct: 80, pharmacyCoveragePct: 70, areasWithNoVisits: [], visitedDoctors: 80, totalDoctors: 100 },
  growth: { growthPct: null },
  discipline: { adherencePct: null, hasData: false },
};

// مندوب بلا تارجت مُدخَل: وزن المبيع يُستبعد من المقام لا يُحتسب صفراً
const r1 = scoreCard(baseMetrics, eff);
eq('بلا تارجت ← وزن المبيع مُستبعَد', r1.measuredWeight, eff.weightVisits + eff.weightCoverage + eff.weightDiscipline);
eq('كامل على ما يُقاس = 100', r1.score, 100);
eq('الحالة ممتاز', r1.status, 'excellent');

// لا بيانات على الإطلاق ≠ أداء صفر
const nothing = {
  target: { total: 0, achievementPct: null, projectedPct: null, zeroSaleItems: [], neededPerDay: 0 },
  visits: { doctorVisitPct: null, pharmacyVisitPct: null, workDaysElapsed: 0, zeroDays: 0, monthProgressPct: 0, zeroDayList: [] },
  coverage: { doctorCoveragePct: null, pharmacyCoveragePct: null, areasWithNoVisits: [] },
  growth: { growthPct: null },
  discipline: { adherencePct: null, hasData: false },
};
const r2 = scoreCard(nothing, eff);
eq('بلا أي بيانات ← no_data', r2.status, 'no_data');
eq('بلا أي بيانات ← وزن 0', r2.measuredWeight, 0);

// تحقّق يساوي المعيار = كامل درجة المبيع (المعيار خط النجاح لا الكمال)
const atBar = { ...baseMetrics, target: { ...baseMetrics.target, total: 1000, achieved: 900, achievementPct: 90, projectedPct: 95 } };
eq('تحقّق 90% بمعيار 90% ← 100', scoreCard(atBar, eff).components.sales.pct, 100);
const halfBar = { ...baseMetrics, target: { ...baseMetrics.target, total: 1000, achieved: 450, achievementPct: 45, projectedPct: 50 } };
eq('تحقّق 45% بمعيار 90% ← 50', scoreCard(halfBar, eff).components.sales.pct, 50);

// نمو سالب لا يُنتج درجة سالبة
eq('نمو سالب ← 0 لا سالب', scoreCard({ ...atBar, growth: { growthPct: -40 } }, eff).components.growth.pct, 0);
eq('نمو 10% بمعيار 10% ← 100', scoreCard({ ...atBar, growth: { growthPct: 10 } }, eff).components.growth.pct, 100);

// الأيام الضائعة تُسقط الانضباط
const lost = { ...atBar, visits: { ...baseMetrics.visits, zeroDays: 5, workDaysElapsed: 10 } };
eq('5 أيام ضائعة من 10 ← انضباط 50', scoreCard(lost, eff).components.discipline.pct, 50);

// معيار صفري لا يسبّب قسمة على صفر
const zeroStd = effectiveFor({ ...FOLLOWUP_DEFAULTS, targetAchievementMinPct: 0, doctorCoverageTargetPct: 0, growthTargetPct: 0 }, null);
const rz = scoreCard(atBar, zeroStd);
eq('معيار صفري لا يُنتج NaN', Number.isFinite(rz.score), true);

// ── الأسباب ────────────────────────────────────────────────────────────────
const reasons = buildReasons({
  target: { total: 1000, achieved: 400, achievementPct: 40, projectedPct: 66, zeroSaleItems: [{ itemName: 'ايتم أ' }, { itemName: 'ايتم ب' }], neededPerDay: 120, remainingWorkDays: 5 },
  visits: { doctorVisitPct: 55, doctorVisits: 44, expectedDoctorVisits: 80, zeroDays: 3, zeroDayList: [4, 7, 11], monthProgressPct: 60, workDaysElapsed: 10 },
  coverage: { doctorCoveragePct: 50, visitedDoctors: 50, totalDoctors: 100, areasWithNoVisits: ['الدورة', 'الكرادة'] },
  growth: { growthPct: -12 },
  discipline: { hasData: true, adherencePct: 40, visited: 4, planned: 10, autoPostponed: 2 },
}, eff, 'behind');
console.log('--- نموذج الأسباب ---');
reasons.forEach(r => console.log('  •', r));
eq('الأسباب لا تتجاوز 6 أسطر', reasons.length <= 6, true);
eq('كل سبب يحمل رقماً', reasons.every(r => /\d/.test(r)), true);
eq('no_data يُعطي سبباً واحداً مفهوماً', buildReasons(nothing, eff, 'no_data').length, 1);

console.log(fails ? `\n❌ فشل ${fails} اختبار` : '\n✅ كل الاختبارات نجحت');
process.exit(fails ? 1 : 0);
