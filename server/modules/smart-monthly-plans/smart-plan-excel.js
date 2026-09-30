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
/**
 * ملف الصيدليات المفتوحة غالباً قائمة عمود واحد مقسَّمة بصفوف عناوين مناطق
 * («البياع» ثم صيدلياتها، ثم «الدورة» ...). نقرأ الورقة مصفوفةً خام: أي خلية
 * نصّها اسم منطقة معروفة (isAreaName) تصير المنطقة الحالية، وكل اسم في عمود
 * الصيدليات بعدها يُنسَب إليها. عمود الصيدليات = عنوان «الصيدلية» إن وُجد، وإلا
 * العمود الأكثر خلايا نصية. عمود «المنطقة» الصريح إن وُجد يُفضَّل على العناوين.
 */
function parseOpenPharmacies(ws, isAreaName) {
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
  const text = v => String(v ?? '').trim();
  const isNumeric = t => /^[\d\s.,+\-()]+$/.test(t);

  const exactPharm = new Set(COL_KEYWORDS.pharmacy.map(k => k.toLowerCase()));
  const exactArea = new Set(COL_KEYWORDS.area.map(k => k.toLowerCase()));
  let pharmCol = -1, areaCol = -1, dataStart = 0;
  for (let r = 0; r < Math.min(matrix.length, 15) && pharmCol === -1; r++) {
    const row = matrix[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (exactPharm.has(text(row[c]).toLowerCase())) { pharmCol = c; dataStart = r + 1; }
    }
    if (pharmCol !== -1) {
      for (let c = 0; c < row.length; c++) if (exactArea.has(text(row[c]).toLowerCase())) areaCol = c;
    }
  }
  if (pharmCol === -1) {
    const counts = new Map();
    for (const row of matrix) {
      (row || []).forEach((v, c) => {
        const t = text(v);
        if (t && !isNumeric(t) && !isAreaName(t)) counts.set(c, (counts.get(c) || 0) + 1);
      });
    }
    pharmCol = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  }

  const entries = [];
  let currentArea = null, sawAreaHeader = false;
  for (let r = dataStart; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const areaHeader = row.map(text).find(t => t && isAreaName(t));
    if (areaHeader) { currentArea = areaHeader; sawAreaHeader = true; continue; }
    const name = text(row[pharmCol]);
    if (!name || isNumeric(name)) continue;
    const explicitArea = areaCol !== -1 ? text(row[areaCol]) : '';
    entries.push({ name, areaName: explicitArea || currentArea });
  }
  return { pharmacyEntries: entries, pharmacyNames: entries.map(e => e.name), rowCount: entries.length, hasAreaInfo: sawAreaHeader || areaCol !== -1 };
}

export function parseSmartPlanExcel(filePath, kind, { isAreaName = () => false } = {}) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (kind === 'openPharmacies') return parseOpenPharmacies(ws, isAreaName);
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
