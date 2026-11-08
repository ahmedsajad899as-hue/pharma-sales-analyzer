// ════════════════════════════════════════════════════════════════════════════
// اختبار ربط دوفايد — تشغيل: npm run test:dofied (بلا شبكة ولا قاعدة بيانات)
// ════════════════════════════════════════════════════════════════════════════
import XLSX from 'xlsx';
import { mergeCookies, cookieHeader, loginOk, isTooMany, isXlsx, daysBetween, mergeWorkbooks } from '../server/modules/dofied/dofied.client.js';

process.env.DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/none';
const { syncWindow, baghdadNow } = await import('../server/modules/dofied/dofied.sync.js');

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`✗ ${label}\n    نتيجة: ${JSON.stringify(actual)}\n    متوقَّع: ${JSON.stringify(expected)}`); }
  else console.log(`✓ ${label}`);
};

// ── الكوكيز وتسجيل الدخول ──
const jar = mergeCookies({}, ['PHPSESSID=abc; path=/; HttpOnly', 'lang=ar; Max-Age=100']);
check('جرّة الكوكيز', jar, { PHPSESSID: 'abc', lang: 'ar' });
mergeCookies(jar, ['PHPSESSID=xyz; path=/', 'lang=deleted; expires=Thu, 01 Jan 1970']);
check('تحديث وحذف', cookieHeader(jar), 'PHPSESSID=xyz');
check('«true» = نجاح', loginOk(' true\n'), true);
check('غير ذلك = فشل', loginOk('false'), false);
check('صفحة كثرة السجلات (من التسجيل الحقيقي)', isTooMany('<h1>Heavey Request!</h1><h3>🤨 Too many records to export.</h3>'), true);
check('xlsx بتوقيع PK', isXlsx(Buffer.from('PK\x03\x04abc')), true);
check('HTML ليس xlsx', isXlsx(Buffer.from('<html>')), false);
check('أيام المدى شاملة', daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);

// ── دمج ملفات التصدير بنفس الأوراق ──
const book = (tasks, notes) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', 'task-to', 'client'], ...tasks]), 'Tasks');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['task_id', 'timestamp', 'author', 'message'], ...notes]), 'Task Notes');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const merged = mergeWorkbooks([book([[1, 'علي', 'ص1'], [2, 'علي', 'ص2']], [[1, 1, 'علي', 'ziver 50']]), book([[3, 'زيد', 'ص3']], [[3, 2, 'زيد', 'x']])]);
const wb = XLSX.read(merged.buffer);
check('الأوراق بنفس الترتيب', wb.SheetNames, ['Tasks', 'Task Notes']);
check('عدد الزيارات', merged.taskRows, 3);
check('الترويسة مرة واحدة', XLSX.utils.sheet_to_json(wb.Sheets.Tasks).map(r => r.id), [1, 2, 3]);
check('الملاحظات مدموجة', XLSX.utils.sheet_to_json(wb.Sheets['Task Notes']).map(r => r.task_id), [1, 3]);
check('ملف فارغ', mergeWorkbooks([]).taskRows, 0);

// ── مدى السحب ──
check('أول سحب = أمس', syncWindow(null, '2026-11-09'), { from: '2026-11-08', to: '2026-11-08' });
check('اليوم التالي لآخر سحب ← أمس', syncWindow('2026-11-05', '2026-11-09'), { from: '2026-11-06', to: '2026-11-08' });
check('لا يوم مكتمل جديد', syncWindow('2026-11-08', '2026-11-09'), null);
check('اليوم الجاري لا يُسحب', syncWindow('2026-11-09', '2026-11-09'), null);
check('انقطاع طويل: آخر 31 يوماً', syncWindow('2026-01-01', '2026-11-09'), { from: '2026-10-09', to: '2026-11-08' });
check('عبر نهاية الشهر', syncWindow('2026-10-30', '2026-11-02'), { from: '2026-10-31', to: '2026-11-01' });
check('ساعة بغداد = UTC+3', baghdadNow(new Date('2026-11-09T22:30:00Z')), { date: '2026-11-10', hour: 1 });

if (failed) { console.log(`\n✗ فشل ${failed}`); process.exit(1); }
console.log('\n✓ كل الاختبارات نجحت');
process.exit(0);
