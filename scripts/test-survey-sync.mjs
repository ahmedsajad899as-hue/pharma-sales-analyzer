// ════════════════════════════════════════════════════════════════════════════
// اختبار محرّك دورة تحديث السيرفي (server/lib/surveySync.js)
// ────────────────────────────────────────────────────────────────────────────
// تشغيل:  node scripts/test-survey-sync.mjs
// لا يلمس قاعدة البيانات: diffSurveyRows تقبل currentRows و classifier محقونين.
// أهم ما يحرسه هذا الملف هو القواعد التي يعني خرقها فقدان بيانات ميدانية:
//   • صف غائب عن الملف لا يُنتج حذفاً أبداً
//   • خلية فارغة لا تمسح قيمة موجودة
//   • تعديل متزامن داخل التطبيق يُكشف كتعارض لا يُدهس
// ════════════════════════════════════════════════════════════════════════════

import {
  parseSurveyCode, formatSurveyCode, rowHash, readIncoming, normalizeStored,
  isDeleteAction, buildExportPayload, diffSurveyRows, SYNC_TYPES,
} from '../server/lib/surveySync.js';

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

// ── 1) الرمز ────────────────────────────────────────────────────────────────
eq('code: تنسيق طبيب', formatSurveyCode('doctor', 123), 'D-000123');
eq('code: تنسيق صيدلية', formatSurveyCode('pharmacy', 45678), 'P-045678');

for (const [input, expected] of [
  ['D-000123', 123], ['d123', 123], ['123', 123], ['د-١٢٣', 123],
  ['D 42', 42], ['‏D-7‎', 7], ["'D-8", 8], ['ط-15', 15],
]) {
  eq(`code: قراءة ${JSON.stringify(input)}`, parseSurveyCode(input, 'doctor'), { ok: true, id: expected });
}
eq('code: رمز صيدلية في ملف أطباء يُرفض', parseSurveyCode('P-9', 'doctor'), { ok: false, reason: 'wrong_type' });
eq('code: رمز طبيب في ملف صيدليات يُرفض', parseSurveyCode('D-9', 'pharmacy'), { ok: false, reason: 'wrong_type' });
eq('code: فارغ', parseSurveyCode('', 'doctor'), { ok: false, reason: 'empty' });
eq('code: نص', parseSurveyCode('abc', 'doctor'), { ok: false, reason: 'unparsable' });
eq('code: صفر', parseSurveyCode('D-0', 'doctor'), { ok: false, reason: 'unparsable' });

// ── 2) قراءة الخلايا ───────────────────────────────────────────────────────
eq('cell: فارغة = لم يُذكر', readIncoming('phone', ''), undefined);
eq('cell: مسافات = لم يُذكر', readIncoming('phone', '   '), undefined);
eq('cell: شرطة = مسح صريح', readIncoming('phone', '-'), null);
eq('cell: الاسم لا يُمسح بالشرطة', readIncoming('name', '-'), undefined);
eq('cell: قيمة', readIncoming('phone', ' 0770 '), '0770');
eq('cell: توحيد المسافات', normalizeStored('  د.  أحمد   علي '), 'د. أحمد علي');
check('action: حذف', isDeleteAction('حذف') && isDeleteAction(' DELETE ') && isDeleteAction('x'));
check('action: فارغ ليس حذفاً', !isDeleteAction('') && !isDeleteAction('تعديل'));

// ── 3) البصمة ──────────────────────────────────────────────────────────────
const baseRow = { id: 1, name: 'د. أحمد', specialty: 'قلبية', areaName: 'الكرخ', pharmacyName: 'النور', className: 'A', zoneName: 'Z1', phone: '0770', notes: null };
check('hash: ثابتة', rowHash('doctor', baseRow) === rowHash('doctor', { ...baseRow }));
check('hash: تتجاهل فرق المسافات وحالة الأحرف',
  rowHash('doctor', baseRow) === rowHash('doctor', { ...baseRow, name: ' د.  أحمد ', className: 'a' }));
check('hash: تتجاهل اختلاف تهجئة المنطقة',
  rowHash('doctor', baseRow) === rowHash('doctor', { ...baseRow, areaName: 'الكرخ ' }));
check('hash: تتغيّر بتغيّر قيمة فعلية',
  rowHash('doctor', baseRow) !== rowHash('doctor', { ...baseRow, phone: '0771' }));
check('hash: null و "" سواء',
  rowHash('doctor', baseRow) === rowHash('doctor', { ...baseRow, notes: '' }));

// ── 4) التصدير ─────────────────────────────────────────────────────────────
{
  const recs = [baseRow, { ...baseRow, id: 2, name: 'د. سارة', areaName: 'الرصافة' }];
  const { rows, rowHashes } = buildExportPayload('doctor', recs);
  eq('export: رمز كل صف', rows.map(r => r.code), ['D-000001', 'D-000002']);
  eq('export: عمود الإجراء فارغ', rows.map(r => r.action), ['', '']);
  eq('export: null يُصدَّر فراغاً', rows[0].notes, '');
  check('export: بصمة لكل صف', rowHashes['1'] === rowHash('doctor', recs[0]) && !!rowHashes['2']);
}

// ── 5) التصنيف ─────────────────────────────────────────────────────────────
const CURRENT = [
  { id: 1, isActive: true, name: 'د. أحمد',  specialty: 'قلبية',  areaName: 'الكرخ',   pharmacyName: 'النور', className: 'A', zoneName: 'Z1', phone: '0770', notes: null },
  { id: 2, isActive: true, name: 'د. سارة',  specialty: 'جلدية',  areaName: 'الرصافة', pharmacyName: null,    className: null, zoneName: null, phone: null,   notes: null },
  { id: 3, isActive: true, name: 'د. كريم',  specialty: null,     areaName: 'الكرخ',   pharmacyName: null,    className: null, zoneName: null, phone: null,   notes: null },
];
const BASELINE = Object.fromEntries(CURRENT.map(r => [String(r.id), rowHash('doctor', r)]));
const noFuzzy = async () => ({ resolved: [], pending: [], unrelated: [] });

async function diff(incomingRows, opts = {}) {
  return diffSurveyRows({
    entryType: 'doctor', surveyId: 1, incomingRows,
    baselineHashes: opts.baseline ?? BASELINE,
    currentRows: opts.current ?? CURRENT,
    classifier: opts.classifier ?? noFuzzy,
  });
}
const byRow = res => Object.fromEntries(res.rows.map(r => [r.rowNumber, r.changeType]));

{
  // الحالة المرجعية: صف بلا تغيير، تعديل حقل، نقل منطقة، طلب حذف — والصف
  // رقم 3 محذوف من الملف كلياً.
  const res = await diff([
    { __row: 2, code: 'D-000001', name: 'د. أحمد', specialty: 'قلبية', areaName: 'الكرخ', pharmacyName: 'النور', className: 'A', zoneName: 'Z1', phone: '0770', notes: '' },
    { __row: 3, code: 'D-000002', name: 'د. سارة', specialty: 'باطنية', areaName: 'الرصافة' },
  ]);
  eq('diff: بلا تغيير + تعديل', byRow(res), { 2: 'unchanged', 3: 'update' });
  eq('diff: الفرق يحمل القيمتين', res.rows[1].diffs, [{ field: 'specialty', from: 'جلدية', to: 'باطنية' }]);
  eq('diff: صف محذوف من الملف لا يُنتج حذفاً', res.counts.delete, 0);
  eq('diff: ولا يُنتج أي تصنيف إطلاقاً', res.rows.length, 2);
}

{
  const res = await diff([{ __row: 2, code: 'D-000002', name: 'د. سارة', areaName: 'الكرخ' }]);
  eq('diff: تغيير المنطقة وحده = نقل', byRow(res), { 2: 'move' });
}
{
  const res = await diff([{ __row: 2, code: 'D-000002', name: 'د. سارة', areaName: 'الكرخ', phone: '0999' }]);
  eq('diff: منطقة + حقل آخر = تعديل', byRow(res), { 2: 'update' });
}
{
  const res = await diff([{ __row: 2, code: 'D-000001', name: 'د. أحمد', action: 'حذف' }]);
  eq('diff: كلمة حذف = طلب تعطيل', byRow(res), { 2: 'delete' });
}
{
  const inactive = CURRENT.map(r => r.id === 1 ? { ...r, isActive: false } : r);
  const res = await diff([{ __row: 2, code: 'D-000001', name: 'د. أحمد', action: 'حذف' }], { current: inactive });
  eq('diff: حذف صف معطَّل أصلاً = بلا تغيير', byRow(res), { 2: 'unchanged' });
}

{
  // خلية فارغة لا تمسح، والشرطة تمسح.
  const res = await diff([
    { __row: 2, code: 'D-000001', name: 'د. أحمد', specialty: '', phone: '', notes: '' },
    { __row: 3, code: 'D-000001', name: 'د. أحمد', phone: '-' },
  ]);
  eq('diff: خلايا فارغة لا تمسح شيئاً', res.rows[0].changeType, 'unchanged');
  eq('diff: الشرطة تمسح صراحةً', res.rows[1].diffs, [{ field: 'phone', from: '0770', to: null }]);
}

{
  // تعارض: زميل عدّل الصف داخل التطبيق بعد التصدير، فبصمة الأساس لم تعد تطابق.
  const stale = { ...BASELINE, 1: 'deadbeef' };
  const res = await diff([{ __row: 2, code: 'D-000001', name: 'د. أحمد', phone: '0771' }], { baseline: stale });
  eq('diff: تعديل فوق تعديل أحدث = تعارض', byRow(res), { 2: 'conflict' });
  eq('diff: التعارض يحتفظ بالفرق', res.rows[0].diffs.length, 1);
}
{
  // بلا بصمة أساس (ملف بلا رمز تصدير) لا يُفترض تعارض — يبقى تعديلاً عادياً.
  const res = await diff([{ __row: 2, code: 'D-000001', name: 'د. أحمد', phone: '0771' }], { baseline: {} });
  eq('diff: بلا بصمة = تعديل عادي لا تعارض', byRow(res), { 2: 'update' });
}

{
  // رمز مكتوب لكنه معطوب أو غريب ⇒ مراجعة دائماً، مهما قال المطابق الضبابي.
  // الإنشاء الصامت هنا كان سيُغرق السيرفي بنسخ مكرّرة عند رفع ملف سيرفي آخر
  // أو عند إفساد عمود الرمز بالسحب في إكسل.
  const res = await diff([
    { __row: 2, code: 'D-009999', name: 'د. مجهول' },   // رمز سليم الشكل خارج السيرفي
    { __row: 3, code: 'xyz',      name: 'د. مشوّه' },    // رمز غير مقروء
    { __row: 4, code: 'P-000001', name: 'د. نوع خاطئ' }, // رمز صيدلية في ملف أطباء
  ]);
  eq('diff: رمز معطوب/غريب لا يُنشئ أبداً', byRow(res), { 2: 'unmatched', 3: 'unmatched', 4: 'unmatched' });
  check('diff: ولا يُصنَّف تعديلاً', res.counts.update === 0 && res.counts.move === 0 && res.counts.new === 0);
}
{
  // أما الرمز الفارغ فهو الطريقة الموثَّقة لإضافة اسم جديد — يبقى مسموحاً.
  const res = await diff([{ __row: 2, code: '', name: 'د. اسم جديد تماماً' }]);
  eq('diff: رمز فارغ + بلا مرشّحين ⇒ جديد', byRow(res), { 2: 'new' });
}
{
  // نفس الحالة لكن المطابق الضبابي وجد مرشّحين ⇒ مراجعة لا إنشاء صامت.
  const classifier = async (_s, rows) => {
    rows.forEach(r => { r.rowKey = 'k1'; r.matchedDoctorId = null; });
    return { resolved: [], pending: [{ key: 'k1', suggestions: [{ id: 3, name: 'د. كريم', score: 0.8 }] }], unrelated: [] };
  };
  const res = await diff([{ __row: 2, code: '', name: 'د. كريم محمد' }], { classifier });
  eq('diff: مرشّحون موجودون ⇒ بلا مطابقة (مراجعة)', byRow(res), { 2: 'unmatched' });
  eq('diff: المرشّحون مرفقون', res.rows[0].candidates.length, 1);
}
{
  // ذاكرة مطابقة مؤكَّدة: الصف بلا رمز لكنه معروف الهوية ⇒ يُقارَن لا يُنشأ.
  const classifier = async (_s, rows) => {
    rows.forEach(r => { r.rowKey = 'k2'; r.matchedDoctorId = 2; });
    return { resolved: [{ key: 'k2', status: 'linked' }], pending: [], unrelated: [] };
  };
  const res = await diff([{ __row: 2, code: '', name: 'د. سارة', specialty: 'باطنية' }], { classifier });
  eq('diff: رابط محفوظ ⇒ تعديل لا إنشاء', byRow(res), { 2: 'update' });
  eq('diff: يُنسب للصف الصحيح', res.rows[0].entryId, 2);
}
{
  // طلب حذف لصف مجهول الهوية لا يُنفَّذ ولا يُنشئ صفاً جديداً.
  const res = await diff([{ __row: 2, code: '', name: 'اسم لا وجود له', action: 'حذف' }]);
  eq('diff: حذف بلا هوية ⇒ مراجعة', byRow(res), { 2: 'unmatched' });
}
{
  const res = await diff([{ __row: 5, code: '', name: '' }, { __row: 6, code: '', name: '   ' }]);
  eq('diff: صفوف ذيل الورقة الفارغة تُتجاهل', res.rows.length, 0);
}

// ── 6) الصيدليات: نفس المحرّك ──────────────────────────────────────────────
{
  const cur = [{ id: 7, isActive: true, name: 'صيدلية النور', ownerName: 'علي', pharmacyName: null, phone: null, address: null, areaName: 'الكرخ', notes: null }];
  const res = await diffSurveyRows({
    entryType: 'pharmacy', surveyId: 1,
    incomingRows: [{ __row: 2, code: 'P-000007', name: 'صيدلية النور الجديدة', areaName: 'الكرخ' }],
    baselineHashes: { 7: rowHash('pharmacy', cur[0]) },
    currentRows: cur, classifier: noFuzzy,
  });
  eq('pharmacy: إعادة تسمية = تعديل', res.rows[0].changeType, 'update');
  eq('pharmacy: الفرق على الاسم', res.rows[0].diffs, [{ field: 'name', from: 'صيدلية النور', to: 'صيدلية النور الجديدة' }]);
}
eq('types: حقول الطبيب ثمانية', SYNC_TYPES.doctor.fields.length, 8);
eq('types: حقول الصيدلية سبعة', SYNC_TYPES.pharmacy.fields.length, 7);

// ── النتيجة ────────────────────────────────────────────────────────────────
console.log(`\n${pass} ناجح، ${fail} فاشل`);
if (fail) { console.log('\nالفاشل:'); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('✓ كل اختبارات محرّك المزامنة نجحت');
