import * as XLSX from 'xlsx';
import type { SmartPlan, SmartPlanCandidate } from './types';

const MONTHS_AR = ['يناير','فبراير','مارس','ابريل','مايو','يونيو','يوليو','اغسطس','سبتمبر','اكتوبر','نوفمبر','ديسمبر'];

/** يبني ملف Excel من نتيجة البلان الذكي النهائية — نفس نمط exportPlanExcel في MonthlyPlansPage.tsx. */
export function exportSmartPlan(plan: SmartPlan, candidates: SmartPlanCandidate[]) {
  const bucketLabel = (key: string | null) => plan.ratioConfig.find(b => b.key === key)?.label ?? key ?? '—';
  const selected = candidates.filter(c => c.selected);

  const rows = selected.map(c => ({
    'الطبيب':        c.doctor?.name ?? c.rawName,
    'الفئة':          bucketLabel(c.assignedBucketKey),
    'المنطقة':        c.doctor?.area?.name ?? c.areaName ?? '',
    'الصيدلية':       c.pharmacyName ?? '',
    'الايتمات':       (c.items ?? []).join(', '),
    'مصدر المطابقة':  c.matchTier ?? '',
    'سبب الاختيار':   c.aiReason ?? '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'البلان الذكي');

  if (plan.resultSummary?.length) {
    const summaryRows = plan.resultSummary.map(s => ({
      'الفئة': s.label, 'النسبة %': s.percent, 'العدد المطلوب': s.quota,
      'تم اختيار': s.filledCount ?? 0, 'نقص': s.shortfall,
    }));
    const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'ملخّص الفئات');
  }

  const repLabel = (plan.scientificRep?.name ?? 'مندوب').replace(/[/\\:*?"<>|]/g, '_');
  XLSX.writeFile(wb, `بلان_ذكي_${repLabel}_${MONTHS_AR[plan.month - 1]}_${plan.year}.xlsx`);
}
