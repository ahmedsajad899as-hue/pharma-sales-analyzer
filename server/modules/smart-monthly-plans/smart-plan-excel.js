/**
 * تحليل ملفات Excel الأربعة للبلان الشهري الذكي (موصفين/مرشحون/سيرفي/صيدليات
 * مفتوحة) — نفس نمط اكتشاف الأعمدة بالكلمات المفتاحية المستخدم في
 * doctor-visits-import.js (COL_KEYWORDS/findCol)، منسوخ محلياً هنا (لم يكن
 * مُصدَّراً هناك، ونفس الفكرة مكرَّرة أصلاً محلياً في أكثر من موديول بهذا
 * المشروع — راجع commercial.controller.js).
 */

import XLSX from 'xlsx';

const COL_KEYWORDS = {
  doctor:    ['اسم الطبيب', 'اسم الدكتور', 'الطبيب', 'الدكتور', 'doctor name', 'doctor'],
  area:      ['المنطقة', 'منطقة', 'المنطقه', 'منطقه', 'area', 'zone', 'region'],
  pharmacy:  ['اسم الصيدلية', 'الصيدلية', 'صيدلية', 'صيدليه', 'pharmacy'],
  item:      ['اسم الايتم', 'الايتم', 'ايتم', 'المادة', 'الماده', 'item', 'drug', 'product', 'items'],
  specialty: ['الاختصاص', 'التخصص', 'اختصاص', 'تخصص', 'specialty', 'speciality'],
};

function findCol(headers, keywords) {
  const lower = headers.map(h => String(h).trim().toLowerCase());
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    let idx = lower.findIndex(h => h === k);
    if (idx === -1) idx = lower.findIndex(h => h.includes(k));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

/**
 * @param {string} filePath
 * @param {'prescribers'|'candidates'|'survey'|'openPharmacies'} kind
 * @returns {{ rows?: {doctorName,areaName,pharmacyName,specialty,items}[], pharmacyNames?: string[], rowCount: number }}
 */
export function parseSmartPlanExcel(filePath, kind) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) return kind === 'openPharmacies' ? { pharmacyNames: [], rowCount: 0 } : { rows: [], rowCount: 0 };

  const headers = Object.keys(rows[0]);
  const colMap = {
    doctor:    findCol(headers, COL_KEYWORDS.doctor),
    area:      findCol(headers, COL_KEYWORDS.area),
    pharmacy:  findCol(headers, COL_KEYWORDS.pharmacy),
    item:      findCol(headers, COL_KEYWORDS.item),
    specialty: findCol(headers, COL_KEYWORDS.specialty),
  };

  if (kind === 'openPharmacies') {
    const col = colMap.pharmacy || headers[0];
    const pharmacyNames = rows.map(r => String(r[col] ?? '').trim()).filter(Boolean);
    return { pharmacyNames, rowCount: rows.length };
  }

  if (!colMap.doctor) {
    throw new Error('لم يُعثَر على عمود اسم الطبيب في الملف — تأكد من وجود عمود بعنوان "اسم الطبيب" أو ما شابه');
  }

  const parsed = rows
    .map(r => {
      const doctorName = String(r[colMap.doctor] ?? '').trim();
      const areaName = colMap.area ? String(r[colMap.area] ?? '').trim() : '';
      const pharmacyName = colMap.pharmacy ? String(r[colMap.pharmacy] ?? '').trim() : '';
      const specialty = colMap.specialty ? String(r[colMap.specialty] ?? '').trim() : '';
      const itemRaw = colMap.item ? String(r[colMap.item] ?? '').trim() : '';
      const items = itemRaw ? itemRaw.split(/[,،\/;؛]+/).map(s => s.trim()).filter(Boolean) : [];
      return { doctorName, areaName, pharmacyName, specialty, items };
    })
    .filter(r => r.doctorName);

  return { rows: parsed, rowCount: rows.length };
}
