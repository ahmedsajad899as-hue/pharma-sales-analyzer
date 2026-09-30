// ════════════════════════════════════════════════════════════════════════════
// اختبار ذهاب-وعودة لملف مراجعة السيرفي (src/lib/surveySheet.ts)
// ────────────────────────────────────────────────────────────────────────────
// تشغيل:  node scripts/test-survey-sheet.mjs
// يحزم الوحدة بـ esbuild (فهي TypeScript موجّهة للمتصفح) ثم يبني مصنَّفاً
// حقيقياً ويقرأه ثانيةً. عقد صيغة الملف هو ما يربط المندوب بالنظام: خطأ في
// كشف عمود واحد هنا يعني تعديلات تُنسب للحقل الخطأ على كامل السيرفي.
// ════════════════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-sheet-'));
const cacheDir = path.join(ROOT, 'node_modules', '.cache', 'survey-sheet-test');
fs.mkdirSync(cacheDir, { recursive: true });
const bundle = path.join(cacheDir, 'surveySheet.mjs');

execFileSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  path.join(ROOT, 'src/lib/surveySheet.ts'),
  '--bundle', '--format=esm', '--platform=node', '--log-level=error',
  '--external:xlsx',
  `--outfile=${bundle}`,
], { cwd: ROOT, stdio: 'inherit' });

const S = await import(pathToFileURL(bundle).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, `توقّع ${e} فجاء ${a}`);
}

// ── 1) كشف الأعمدة ──────────────────────────────────────────────────────────
eq('hdr: المنطقة ⇒ areaName', S.detectField('doctor', 'المنطقة'), 'areaName');
eq('hdr: الزون ⇒ zoneName', S.detectField('doctor', 'الزون'), 'zoneName');
eq('hdr: اسم الطبيب ⇒ name', S.detectField('doctor', 'اسم الطبيب'), 'name');
eq('hdr: اسم الصيدلية في ملف الأطباء ⇒ pharmacyName', S.detectField('doctor', 'اسم الصيدلية'), 'pharmacyName');
eq('hdr: اسم الصيدلية في ملف الصيدليات ⇒ name', S.detectField('pharmacy', 'اسم الصيدلية'), 'name');
eq('hdr: صاحب الصيدلية ⇒ ownerName', S.detectField('pharmacy', 'صاحب الصيدلية'), 'ownerName');
// العمودان المحجوزان يجب ألا يُفسَّرا كحقلَي بيانات أبداً
eq('hdr: الرمز محجوز', S.detectField('doctor', S.CODE_HEADER), null);
eq('hdr: الإجراء محجوز', S.detectField('doctor', S.ACTION_HEADER), null);
eq('hdr: الرمز محجوز (صيدليات)', S.detectField('pharmacy', S.CODE_HEADER), null);
eq('hdr: الإجراء محجوز (صيدليات)', S.detectField('pharmacy', S.ACTION_HEADER), null);
// كل عنوان نُصدّره يجب أن يُقرأ ثانيةً كحقله نفسه — وإلا انكسرت الدورة
for (const t of ['doctor', 'pharmacy']) {
  for (const f of S.SHEET_DEF[t].fields) {
    eq(`roundtrip hdr[${t}]: ${S.SHEET_DEF[t].headers[f]} ⇒ ${f}`, S.detectField(t, S.SHEET_DEF[t].headers[f]), f);
  }
}
eq('code: تنسيق', [S.formatSurveyCode('doctor', 12), S.formatSurveyCode('pharmacy', 9)], ['D-000012', 'P-000009']);

// ── 2) ذهاب وعودة كامل ──────────────────────────────────────────────────────
const prevCwd = process.cwd();
process.chdir(tmp); // XLSX.writeFile يكتب في مجلد العمل

const DOC_ROWS = [
  { code: 'D-000001', name: 'د. أحمد علي', specialty: 'قلبية', areaName: 'الكرخ', pharmacyName: 'صيدلية النور', className: 'A', zoneName: 'Z1', phone: '07701234567', notes: '' },
  { code: 'D-000002', name: 'د. سارة حسن', specialty: 'جلدية', areaName: 'الرصافة', pharmacyName: '', className: '', zoneName: '', phone: '', notes: 'ملاحظة' },
];
const fileName = S.downloadSurveySheet({
  entryType: 'doctor', rows: DOC_ROWS, token: 'TOK123abc',
  surveyName: 'سيرفي ٢٠٢٦', scopeLabel: 'مناطق المندوب', fileName: 'test-doctors.xlsx',
});
process.chdir(prevCwd);

const buf = fs.readFileSync(path.join(tmp, fileName));
const parsed = S.parseSurveySheet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'doctor');

eq('io: الرمز يُستعاد من الورقة المخفية', parsed.token, 'TOK123abc');
eq('io: النوع يُستعاد', parsed.entryType, 'doctor');
eq('io: ورقة البيانات', parsed.sheetName, 'الأطباء');
check('io: عمود الرمز موجود', parsed.hasCodeColumn);
eq('io: لا أعمدة مجهولة', parsed.unknownColumns, []);
eq('io: عدد الصفوف', parsed.rows.length, 2);
eq('io: أرقام الصفوف كما في إكسل', parsed.rows.map(r => r.__row), [2, 3]);

const r0 = parsed.rows[0];
eq('io: الرمز', r0.code, 'D-000001');
for (const f of ['name', 'specialty', 'areaName', 'pharmacyName', 'className', 'zoneName', 'phone']) {
  eq(`io: ${f}`, r0[f], DOC_ROWS[0][f]);
}
eq('io: خانة فارغة تبقى فارغة', r0.notes, '');
eq('io: عمود الإجراء فارغ', r0.action, '');
eq('io: الصف الثاني', [parsed.rows[1].name, parsed.rows[1].notes], ['د. سارة حسن', 'ملاحظة']);

// ── 3) ملف عدّله المندوب: تعديل، إضافة بلا رمز، طلب حذف ────────────────────
{
  const def = S.SHEET_DEF.doctor;
  const aoa = [
    [S.CODE_HEADER, ...def.fields.map(f => def.headers[f]), S.ACTION_HEADER],
    ['D-000001', 'د. أحمد علي', 'باطنية', 'الكرخ', 'صيدلية النور', 'A', 'Z1', '07701234567', '', ''],
    ['D-000002', 'د. سارة حسن', 'جلدية', 'الرصافة', '', '', '', '', 'ملاحظة', 'حذف'],
    ['',          'د. طبيب جديد', 'عظمية', 'الكرخ', '', 'B', '', '', '', ''],
    ['',          '',            '',      '',      '', '',  '', '', '', ''], // ذيل فارغ
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'الأطباء');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const p = S.parseSurveySheet(out, 'doctor');

  eq('edited: بلا رمز تصدير (ورقة _meta محذوفة)', p.token, null);
  eq('edited: الصفوف الفارغة تُتجاهل', p.rows.length, 3);
  eq('edited: التعديل', p.rows[0].specialty, 'باطنية');
  eq('edited: طلب الحذف مقروء', p.rows[1].action, 'حذف');
  eq('edited: الصف الجديد بلا رمز', [p.rows[2].code, p.rows[2].name], ['', 'د. طبيب جديد']);
  eq('edited: أرقام الصفوف', p.rows.map(r => r.__row), [2, 3, 4]);
}

// ── 4) ملف بأعمدة مُعاد ترتيبها وعناوين بديلة ──────────────────────────────
{
  const aoa = [
    ['ملاحظات', 'الرمز', 'التخصص', 'الاسم', 'منطقه', 'الإجراء'],
    ['ملحوظة',  'D-5',   'قلبية',   'د. زيد', 'الكرخ', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ورقة1');
  const p = S.parseSurveySheet(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), 'doctor');
  eq('reorder: الأعمدة تُكتشف بأي ترتيب', [p.rows[0].code, p.rows[0].name, p.rows[0].specialty, p.rows[0].areaName, p.rows[0].notes],
     ['D-5', 'د. زيد', 'قلبية', 'الكرخ', 'ملحوظة']);
  eq('reorder: ورقة بأي اسم تُقرأ', p.sheetName, 'ورقة1');
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(cacheDir, { recursive: true, force: true });

console.log(`\n${pass} ناجح، ${fail} فاشل`);
if (fail) { console.log('\nالفاشل:'); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✓ كل اختبارات صيغة ملف السيرفي نجحت');
