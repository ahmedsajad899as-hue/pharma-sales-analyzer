// ════════════════════════════════════════════════════════════════════════════
// اختبار قراءة ملف «صيدليات مفتوحة» (parseOpenPharmacies في smart-plan-excel.js)
// ────────────────────────────────────────────────────────────────────────────
// تشغيل:  node scripts/test-open-pharmacies.mjs
//
// الخطر الحقيقي هنا صامت تماماً: الملف يُقرأ، العدّاد يقول «43 صف»، ولا يظهر أي
// خطأ — لكن الصيدليات تُنسَب لمناطق خاطئة أو تختفي من اللوحة. الحالة التي فجّرت
// هذا الاختبار: اسم صيدلية يصادف اسم منطقة معروفة («الداوودي»، «الينبوع») كان
// يُلتهَم كعنوان كتلة فيسحب كل الصيدليات التي بعده إلى منطقة أخرى — من 43 صيدلية
// في الحارثية ظهرت 3 فقط.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { parseSmartPlanExcel } from '../server/modules/smart-monthly-plans/smart-plan-excel.js';

const AREAS = ['الحارثية', 'الدورة', 'الداوودي', 'الامنية', 'الينبوع', 'حي الجامعة', 'النفق'];
const isAreaName = t => AREAS.includes(String(t).trim());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pharm-'));
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

function parse(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ورقة1');
  const file = path.join(tmp, `${Math.random().toString(36).slice(2)}.xlsx`);
  XLSX.writeFile(wb, file);
  return parseSmartPlanExcel(file, 'openPharmacies', { isAreaName });
}

const areaOf = (r, name) => r.pharmacyEntries.find(e => e.name === name)?.areaName ?? null;

// ── ١) عمود منطقة جانبي + أسماء صيدليات تصادف أسماء مناطق ───────────────────
console.log('\n[١] عمود منطقة جانبي مع أسماء تصادف مناطق');
{
  const names = ['النجوم', 'جابر بن حيان', 'البهجه', 'الداوودي', 'الترياق', 'الينبوع', 'السنديان'];
  const r = parse([['', '', ''], ['', '', ''], ['', '', 'الحارثية'], ...names.map(n => [n, '', ''])]);
  check(r.rowCount === names.length, 'لا تُفقَد أي صيدلية', `${r.rowCount}/${names.length}`);
  check(r.pharmacyEntries.every(e => e.areaName === 'الحارثية'), 'كلها تحت منطقة العمود الجانبي');
  check(areaOf(r, 'الداوودي') === 'الحارثية', 'اسم صيدلية يطابق منطقة يبقى صيدلية');
}

// ── ٢) اسم المنطقة بنفس صف أول صيدلية (خلية مدموجة) ─────────────────────────
console.log('\n[٢] اسم المنطقة بصف أول صيدلية');
{
  const names = ['النجوم', 'جابر بن حيان', 'البهجه'];
  const r = parse([['', '', ''], ...names.map((n, i) => [n, '', i === 0 ? 'الحارثية' : ''])]);
  check(r.rowCount === names.length, 'أول صيدلية لا تُبتلَع مع العنوان', `${r.rowCount}/${names.length}`);
  check(areaOf(r, 'النجوم') === 'الحارثية', 'أول صيدلية تأخذ المنطقة');
}

// ── ٣) عناوين كتل داخل عمود الصيدليات نفسه (الشكل القديم) ───────────────────
console.log('\n[٣] عناوين كتل داخل العمود نفسه');
{
  const r = parse([['*الحارثية*'], ['النجوم'], ['جابر بن حيان'], ['الدورة'], ['قمر الجامعه']]);
  check(r.rowCount === 3, 'العناوين لا تُحسَب صيدليات', `${r.rowCount}`);
  check(areaOf(r, 'جابر بن حيان') === 'الحارثية' && areaOf(r, 'قمر الجامعه') === 'الدورة', 'كل كتلة تحت عنوانها');
}

// ── ٤) عمود منطقة مملوء لكل صف: الفراغ يعني «بلا منطقة» لا تعبئة تنازلية ────
console.log('\n[٤] عمود منطقة لكل صف');
{
  const rows = [['اسم الصيدلية', 'المنطقة']];
  for (let i = 0; i < 10; i++) rows.push([`صيدلية ${i}`, i < 9 ? 'الحارثية' : '']);
  const r = parse(rows);
  check(r.rowCount === 10, 'كل الصفوف تُقرأ', `${r.rowCount}`);
  check(areaOf(r, 'صيدلية 9') === null, 'الفراغ في عمود مملوء = بلا منطقة');
}

// ── ٥) عنوان يجمع منطقتين: لا يُنسب لأيّهما ─────────────────────────────────
console.log('\n[٥] عنوان مركّب');
{
  const r = parse([['', 'حي الجامعة و النفق'], ['النجوم', ''], ['البهجه', '']]);
  check(r.rowCount === 2 && r.pharmacyEntries.every(e => e.areaName === null), 'يُترك بلا منطقة بدل نسبه خطأً');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n✗ فشل ${failed} فحصاً\n` : '\n✓ كل الفحوص ناجحة\n');
process.exit(failed ? 1 : 0);
