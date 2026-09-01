/**
 * اختبار محلّل ملفات الستوك (src/lib/stockParser.ts).
 *
 *   node scripts/test-stock-parser.mjs
 *
 * يبني ملفات Excel وهمية تحاكي النماذج الحقيقية (مناطق مدموجة / مناطق ملوّنة /
 * رأس واحد / شيت لكل شركة / مبيعات موزّعين) ويتحقّق من:
 *   - أسماء المناطق لا تختفي ولا تندمج تحت اسم واحد
 *   - الشركة = item code والمادة = Item (لا خلط بينهما)
 *   - Item / price لا يظهران ضمن المذاخر
 *   - كل الشيتات تُقرأ ولا تضيع بياناتها
 */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import XLSX from 'xlsx-js-style';

// ── بناء الوحدة عبر esbuild لتشغيل TypeScript في Node ─────────────────────────
const tmp = path.join('node_modules', '.cache', 'stock-parser-test');
mkdirSync(tmp, { recursive: true });
const outFile = path.join(tmp, 'stockParser.mjs');
await esbuild.build({
  entryPoints: ['src/lib/stockParser.ts'],
  bundle: true, format: 'esm', platform: 'node', external: ['xlsx'], outfile: outFile,
});
const P = await import(pathToFileURL(path.resolve(outFile)).href);

// ── أدوات ─────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function bookToBuffer(sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, aoa, merges, fills } of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (merges) ws['!merges'] = merges;
    for (const [addr, rgb] of Object.entries(fills ?? {})) {
      if (!ws[addr]) ws[addr] = { t: 's', v: '' };
      ws[addr].s = { fill: { fgColor: { rgb } } };
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const M = (r, c1, c2) => ({ s: { r, c: c1 }, e: { r, c: c2 } });
const regionsOf = f => [...new Set(f.areaCols.map(c => c.region))];
const whOf = f => f.areaCols.map(c => c.label);
const whIn = (f, region) => f.areaCols.filter(c => c.region === region).map(c => c.label);

// ══════════════════════════════════════════════════════════════════════════════
// 1) نموذج المستخدم: صف مناطق مدموج + item code/Item/price + شيتان
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1) صيغة المصفوفة — مناطق مدموجة، شيتان\x1b[0m');
{
  //           A            B        C        D..H = الحارثية        I..K = الكوت
  const head0 = ['', '', '', 'الحارثية', '', '', '', '', 'الكوت', '', ''];
  const head1 = ['item code', 'Item', 'price',
                 'أبراج الحارثية', 'المنصور', 'سنايا', 'اسبرين', 'الناقوس الفضي',
                 'الزيتون', 'بغداد', 'الغدير'];
  const sheet1 = [
    head0, head1,
    ['DevaTurkeyN/A', 'AMOKLAVIN 1000MG 10TAB', 5693, 85, 284, 613, 767, 911, 202, 93, 178],
    ['DevaTurkeyN/A', 'AMOKLAVIN 625 MG 10TAB', 3918, 161, 41, 304, 898, 593, 98, 110, 215],
    ['HUMANISTurkeyN/A', 'AIRTIDE 100 mcg/50 mcg', 13527, 15, 11, 24, 111, 22, '', '', ''],
  ];
  // شيت ثانٍ: مناطق مختلفة (السماوة) + ايتم جديد + ايتم مكرر
  const s2h0 = ['', '', '', 'السماوة', '', '', 'النجف', '', ''];
  const s2h1 = ['item code', 'Item', 'price', 'الشمس', 'الرافدين', 'الغدير', 'الشامل', 'الصيدلي', 'المورد'];
  const sheet2 = [
    s2h0, s2h1,
    ['OselTurkeyN/A', 'Lesitam Vail', 93508, 5, 40, 18, 4, 12, 3],
    ['DevaTurkeyN/A', 'AMOKLAVIN 1000MG 10TAB', 5693, 154, 224, 26, 601, 210, 214],
  ];
  const buf = bookToBuffer([
    { name: 'Sheet1', aoa: sheet1, merges: [M(0, 3, 7), M(0, 8, 10)] },
    { name: 'Sheet2', aoa: sheet2, merges: [M(0, 3, 5), M(0, 6, 8)] },
  ]);

  const f = P.parseStockFile(buf, 'ستوك ايلول.xlsx');
  check('لم يُرجِع خطأ', typeof f !== 'string', typeof f === 'string' ? f : '');
  if (typeof f !== 'string') {
    check('المناطق الأربع ظهرت كلها',
      eq(regionsOf(f).sort(), ['السماوة', 'الحارثية', 'الكوت', 'النجف'].sort()),
      `المناطق = ${JSON.stringify(regionsOf(f))}`);
    check('«Item» و«price» ليسا ضمن المذاخر',
      !whOf(f).includes('Item') && !whOf(f).includes('price'),
      `المذاخر = ${JSON.stringify(whOf(f))}`);
    check('مذاخر الحارثية صحيحة',
      eq(whIn(f, 'الحارثية'), ['أبراج الحارثية', 'المنصور', 'سنايا', 'اسبرين', 'الناقوس الفضي']),
      JSON.stringify(whIn(f, 'الحارثية')));
    check('مذاخر الكوت صحيحة',
      eq(whIn(f, 'الكوت'), ['الزيتون', 'بغداد', 'الغدير']), JSON.stringify(whIn(f, 'الكوت')));
    check('«الغدير» المتكرّر بقي عمودين تحت منطقتيه',
      whIn(f, 'الكوت').includes('الغدير') && whIn(f, 'السماوة').includes('الغدير'));
    check('أعمدة التعريف = الشركة | المادة | السعر',
      eq(f.fixedCols, ['الشركة', 'المادة', 'السعر']), JSON.stringify(f.fixedCols));

    const r0 = f.rows.find(r => r['المادة'] === 'AMOKLAVIN 1000MG 10TAB');
    check('المادة = اسم الايتم (لا كود الشركة)', !!r0, JSON.stringify(f.rows[0]));
    check('الشركة = item code', r0 && r0['الشركة'] === 'DevaTurkeyN/A', r0 && r0['الشركة']);
    check('السعر مقروء', r0 && P.toNum(r0['السعر']) === 5693, r0 && r0['السعر']);

    const kAbraj = f.areaCols.find(c => c.label === 'أبراج الحارثية').key;
    const kShams = f.areaCols.find(c => c.label === 'الشمس').key;
    check('كمية من الشيت الأول صحيحة', r0 && P.toNum(r0[kAbraj]) === 85, r0 && r0[kAbraj]);
    check('الشيت الثاني قُرئ ودُمج بنفس الصف', r0 && P.toNum(r0[kShams]) === 154, r0 && r0[kShams]);
    check('ايتم الشيت الثاني موجود', f.rows.some(r => r['المادة'] === 'Lesitam Vail'));
    check('عدد الصفوف = 4 (بدمج المكرّر بين الشيتين)', f.rows.length === 4, `rows=${f.rows.length}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 2) مناطق غير مدموجة لكن ملوّنة (كما في الصورة الثالثة)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2) صيغة المصفوفة — تمييز المناطق بالألوان (بلا دمج)\x1b[0m');
{
  const BLUE = '4472C4', GOLD = 'FFC000';
  const aoa = [
    ['', '', '', 'السماوة', '', '', 'الحلة', '', '', 'الموصل', '', ''],
    ['item code', 'Item', 'price',
     'الافنان', 'الشمس', 'الرافدين', 'القمه', 'الرواد', 'م. السنايا', 'نركال', 'المدائن', 'النهله'],
    ['RAM PharmaJordanN/A', 'Rampal 500mg', 4000, 154, 224, 26, 700, 184, 56, 3, 340, 325],
    ['REMASEEgyptN/A', 'Conviban tab', 9000, 89, 120, 42, 170, 176, 19, '', 228, ''],
  ];
  const fills = {};
  for (const a of ['D1', 'D2', 'E2', 'F2']) fills[a] = BLUE;   // السماوة
  for (const a of ['G1', 'G2', 'H2', 'I2']) fills[a] = GOLD;   // الحلة
  for (const a of ['J1', 'J2', 'K2', 'L2']) fills[a] = BLUE;   // الموصل
  const buf = bookToBuffer([{ name: 'ورقة1', aoa, fills }]);

  const f = P.parseStockFile(buf, 'stock-colors.xlsx');
  check('لم يُرجِع خطأ', typeof f !== 'string', typeof f === 'string' ? f : '');
  if (typeof f !== 'string') {
    check('المناطق الثلاث ظهرت',
      eq(regionsOf(f).sort(), ['الحلة', 'السماوة', 'الموصل'].sort()), JSON.stringify(regionsOf(f)));
    check('مذاخر السماوة بحسب اللون',
      eq(whIn(f, 'السماوة'), ['الافنان', 'الشمس', 'الرافدين']), JSON.stringify(whIn(f, 'السماوة')));
    check('مذاخر الحلة بحسب اللون',
      eq(whIn(f, 'الحلة'), ['القمه', 'الرواد', 'م. السنايا']), JSON.stringify(whIn(f, 'الحلة')));
    check('مذاخر الموصل بحسب اللون',
      eq(whIn(f, 'الموصل'), ['نركال', 'المدائن', 'النهله']), JSON.stringify(whIn(f, 'الموصل')));
    check('«Item» و«price» ليسا ضمن المذاخر',
      !whOf(f).includes('Item') && !whOf(f).includes('price'), JSON.stringify(whOf(f)));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 3) رأس «price» مدموج على خليتين: العملة ثم الرقم + عمود مجموع + عمود «ت»
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3) صيغة المصفوفة — price بعملة، وعمود مجموع، وعمود تسلسل\x1b[0m');
{
  const aoa = [
    ['', '', '', '', 'الحارثية', '', '', 'المجموع الكلي', ''],
    ['item code', 'Item', 'price', '', 'المنصور', 'سنايا', 'اسبرين', 'المجموع', 'ت'],
    ['DevaTurkeyN/A', 'AMOKLAVIN 1000MG', 'IQD', 5693, 284, 613, 767, 1664, 1],
    ['HUMANISTurkeyN/A', 'AIRTIDE 100 mcg', 'IQD', 13527, 11, 24, 111, 146, 2],
  ];
  const buf = bookToBuffer([{ name: 'Sheet1', aoa, merges: [M(0, 4, 6), M(1, 2, 3)] }]);
  const f = P.parseStockFile(buf, 'ستوك.xlsx');
  check('لم يُرجِع خطأ', typeof f !== 'string', typeof f === 'string' ? f : '');
  if (typeof f !== 'string') {
    check('المذاخر ثلاثة فقط (بلا مجموع/تسلسل/price)',
      eq(whOf(f), ['المنصور', 'سنايا', 'اسبرين']), JSON.stringify(whOf(f)));
    check('منطقة واحدة: الحارثية', eq(regionsOf(f), ['الحارثية']), JSON.stringify(regionsOf(f)));
    const r = f.rows[0];
    check('السعر أُخذ من الخلية الرقمية لا نص العملة', P.toNum(r['السعر']) === 5693, r['السعر']);
    check('الشركة والمادة صحيحتان',
      r['الشركة'] === 'DevaTurkeyN/A' && r['المادة'] === 'AMOKLAVIN 1000MG', JSON.stringify(r));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 4) بانر عنوان يغطي كل الأعمدة فوق الرؤوس — يجب ألّا يصير «منطقة»
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4) صف عنوان يغطي كل الأعمدة (بانر) بدل صف المناطق\x1b[0m');
{
  const aoa = [
    ['تقرير الستوك لشهر ايلول', '', '', '', '', ''],
    ['item code', 'Item', 'price', 'المنصور', 'سنايا', 'اسبرين'],
    ['DevaTurkeyN/A', 'AMOKLAVIN', 5693, 284, 613, 767],
    ['OselTurkeyN/A', 'Lesitam', 93508, 5, 40, 18],
  ];
  const buf = bookToBuffer([{ name: 'Sheet1', aoa, merges: [M(0, 0, 5)] }]);
  const f = P.parseStockFile(buf, 'ستوك ايلول.xlsx');
  check('لم يُرجِع خطأ', typeof f !== 'string', typeof f === 'string' ? f : '');
  if (typeof f !== 'string') {
    check('المذاخر صحيحة (بلا Item/price)',
      eq(whOf(f), ['المنصور', 'سنايا', 'اسبرين']), JSON.stringify(whOf(f)));
    check('عنوان البانر صار منطقة احتياطية واحدة',
      regionsOf(f).length === 1, JSON.stringify(regionsOf(f)));
    check('الشركة والمادة لم تختلطا',
      f.rows[0]['الشركة'] === 'DevaTurkeyN/A' && f.rows[0]['المادة'] === 'AMOKLAVIN',
      JSON.stringify(f.rows[0]));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 5) رأس واحد بلا صف مناطق إطلاقاً (تراجُع: يجب أن يبقى شغّالاً)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5) رأس واحد بلا صف مناطق\x1b[0m');
{
  const aoa = [
    ['الشركة', 'المادة', 'السعر', 'المنصور', 'سنايا', 'اسبرين'],
    ['Deva', 'AMOKLAVIN', 5693, 284, 613, 767],
    ['Osel', 'Lesitam', 93508, 5, 40, 18],
  ];
  const buf = bookToBuffer([{ name: 'Sheet1', aoa }]);
  const f = P.parseStockFile(buf, 'بغداد.xlsx');
  check('لم يُرجِع خطأ', typeof f !== 'string', typeof f === 'string' ? f : '');
  if (typeof f !== 'string') {
    check('المذاخر صحيحة', eq(whOf(f), ['المنصور', 'سنايا', 'اسبرين']), JSON.stringify(whOf(f)));
    check('المنطقة الاحتياطية = اسم الملف', eq(regionsOf(f), ['بغداد']), JSON.stringify(regionsOf(f)));
    check('الصفوف صحيحة', f.rows.length === 2 && f.rows[0]['المادة'] === 'AMOKLAVIN');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 6) الصيغة الحقيقية لـ parseMultiSheetStock (شيت لكل شركة) — يجب ألّا تنكسر
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m6) شيت لكل شركة (parseMultiSheetStock) — تراجُع\x1b[0m');
{
  const mk = () => ([
    ['الحارثية', '', '', ''],
    ['المادة', 'الناقوس', 'اسبرين', 'المنصور'],
    ['AMOKLAVIN', 85, 284, 613],
    ['AIRTIDE', 15, 11, 24],
  ]);
  const buf = bookToBuffer([
    { name: 'Deva', aoa: mk() },
    { name: 'Humanis', aoa: mk() },
  ]);
  const f = P.parseStockFile(buf, 'الحارثية.xlsx');
  check('لم يُرجِع خطأ', typeof f !== 'string', typeof f === 'string' ? f : '');
  if (typeof f !== 'string') {
    check('الشركة = اسم الشيت', f.rows[0]['الشركة'] === 'Deva', JSON.stringify(f.rows[0]));
    check('المادة = اسم الايتم', f.rows[0]['المادة'] === 'AMOKLAVIN');
    check('المذاخر صحيحة', eq(whOf(f), ['الناقوس', 'اسبرين', 'المنصور']), JSON.stringify(whOf(f)));
    check('المنطقة من صف العنوان', eq(regionsOf(f), ['الحارثية']), JSON.stringify(regionsOf(f)));
    check('صفوف الشيتين معاً', f.rows.length === 4, `rows=${f.rows.length}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 7) مبيعات الموزّعين — تراجُع
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m7) مبيعات الموزّعين (parseDistributorSales) — تراجُع\x1b[0m');
{
  const mk = () => ([
    ['Company', 'Description', 'الكمية', 'الكمية المجانية', 'Total Qty', 'Net Sale'],
    ['', 'مندوب: علي', '', '', '', ''],
    ['Deva', 'AMOKLAVIN', 10, 0, 10, 56930],
    ['Osel', 'Lesitam', 2, 0, 2, 187016],
  ]);
  const buf = bookToBuffer([
    { name: 'بغداد', aoa: mk() },
    { name: 'البصرة', aoa: mk() },
  ]);
  const f = P.parseStockFile(buf, 'مبيعات.xlsx');
  check('لم يُرجِع خطأ', typeof f !== 'string', typeof f === 'string' ? f : '');
  if (typeof f !== 'string') {
    check('المحافظات = مناطق', eq(regionsOf(f), ['بغداد', 'البصرة']), JSON.stringify(regionsOf(f)));
    check('صفّان مجمّعان', f.rows.length === 2, `rows=${f.rows.length}`);
    check('سعر الوحدة مشتقّ', P.toNum(f.rows[0]['السعر']) === 5693, f.rows[0]['السعر']);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 8) ملف عريض: صف بيانات أكثر امتلاءً من صف الرؤوس (سبب اختفاء المناطق)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m8) صف بيانات ممتلئ أكثر من صف الرؤوس\x1b[0m');
{
  const N = 40;
  const wh = Array.from({ length: N }, (_, i) => `الناقوس ${i + 1}`);
  const head0 = ['', '', '', 'الحارثية', ...Array(19).fill(''), 'الكوت', ...Array(19).fill('')];
  const head1 = ['item code', 'Item', 'price', ...wh];
  // صف رؤوس فيه فجوات (بعض المذاخر بلا اسم) مقابل صف بيانات ممتلئ بالكامل
  head1[10] = ''; head1[11] = ''; head1[12] = '';
  const rows = [
    ['DevaTurkeyN/A', 'AMOKLAVIN', 5693, ...Array.from({ length: N }, (_, i) => i + 1)],
    ['OselTurkeyN/A', 'Lesitam', 93508, ...Array.from({ length: N }, (_, i) => i + 2)],
    ['REMASEEgyptN/A', 'Conviban', 9000, ...Array.from({ length: N }, (_, i) => i + 3)],
  ];
  const buf = bookToBuffer([
    { name: 'Sheet1', aoa: [head0, head1, ...rows], merges: [M(0, 3, 22), M(0, 23, 42)] },
  ]);
  const f = P.parseStockFile(buf, 'wide.xlsx');
  check('لم يُرجِع خطأ', typeof f !== 'string', typeof f === 'string' ? f : '');
  if (typeof f !== 'string') {
    check('المنطقتان ظهرتا (لم تُبتلعا تحت اسم واحد)',
      eq(regionsOf(f).sort(), ['الحارثية', 'الكوت'].sort()), JSON.stringify(regionsOf(f)));
    check('«Item» و«price» ليسا ضمن المذاخر',
      !whOf(f).includes('Item') && !whOf(f).includes('price'), JSON.stringify(whOf(f).slice(0, 6)));
    check('الشركة والمادة صحيحتان',
      f.rows[0]['الشركة'] === 'DevaTurkeyN/A' && f.rows[0]['المادة'] === 'AMOKLAVIN',
      JSON.stringify(f.rows[0]).slice(0, 120));
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 9) بلا دمج إطلاقاً: الكتل مُعرَّفة باللون واسم المنطقة ليس في أول كتلته
//    (بنية ملف «ستوك هيومانس» الحقيقي — كان اسم المنطقة يمتد يميناً فقط
//     فتضيع الأعمدة التي قبله إلى منطقة احتياطية باسم الملف، ويصير الحرف
//     المفرد «ح»/«م» منطقةً مستقلة.)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m9) مناطق بالألوان بلا دمج، والاسم في وسط الكتلة ومقسوم على خليتين\x1b[0m');
{
  const BLUE1 = '9DC3E6', BLUE2 = '5B9BD5', GOLD = 'FFC000', NAVY = '002060';
  const aoa = [
    // صف المناطق: «ح» في c5 و«الحارثية» في c6، «م» في c11 و«الحارثية» في c12،
    // و«الكوت» في c20 بينما كتلته تبدأ من c17
    ['', '', '', '', '', 'ح', 'الحارثية', '', '', '', '', 'م', 'الحارثية', '', '', '', '', '', '', '', 'الكوت', '', '', ''],
    ['item code', 'Item', 'price',
     'أبراج الحارثية', 'المنصور', 'سنايا', 'اسبرين', 'العناية المتميزة', 'الناقوس الفضي',
     'طريق اليسر', 'طريق السلام', 'اوزون', 'دواء الكندي', 'شغف', 'المنارة', 'الفصول الأربعة', 'مصدر الدواء',
     'الزيتون', 'بغداد', 'مزايا', 'الرازي', 'الكوت', 'الغدير', 'المدينة'],
    ['ALBALSAMIRAQIN/A', 'Moxibillin 125mg/5ml', 1200,
     138, 48, 165, 0, 523, 262, 0, 120, 116, 126, 466, 65, 112, 158, 348, 217, 128, 0, 303, 833, 238],
    ['DevaTurkeyN/A', 'AMOKLAVIN 1000MG 10TAB', 5693,
     85, 284, 613, 767, 911, 699, 416, 1134, 70, 458, 1420, 41, 940, 944, 202, 93, 23, 106, 178, 237, 245],
  ];
  const fills = {};
  const col = (letterIdx) => XLSX.utils.encode_col(letterIdx);
  for (let c = 0; c <= 2; c++) { fills[col(c) + '1'] = NAVY; fills[col(c) + '2'] = NAVY; }
  for (let c = 3; c <= 8; c++) { fills[col(c) + '1'] = BLUE1; fills[col(c) + '2'] = BLUE1; }
  for (let c = 9; c <= 16; c++) { fills[col(c) + '1'] = BLUE2; fills[col(c) + '2'] = BLUE2; }
  for (let c = 17; c <= 23; c++) { fills[col(c) + '1'] = GOLD; fills[col(c) + '2'] = GOLD; }
  const buf = bookToBuffer([{ name: 'Sheet1', aoa, fills }]);

  const f = P.parseStockFile(buf, 'ستوك هيومانس.xlsx');
  check('لم يُرجِع خطأ', typeof f !== 'string', typeof f === 'string' ? f : '');
  if (typeof f !== 'string') {
    check('لا توجد منطقة احتياطية باسم الملف',
      !regionsOf(f).includes('ستوك هيومانس'), JSON.stringify(regionsOf(f)));
    check('لا توجد منطقة من حرف واحد',
      !regionsOf(f).some(r => r.trim().length <= 2), JSON.stringify(regionsOf(f)));
    check('ثلاث مناطق فقط', regionsOf(f).length === 3, JSON.stringify(regionsOf(f)));
    check('الكتلة الأولى كاملة (6 مذاخر بما فيها ما قبل الاسم)',
      eq(whIn(f, regionsOf(f)[0]), ['أبراج الحارثية', 'المنصور', 'سنايا', 'اسبرين', 'العناية المتميزة', 'الناقوس الفضي']),
      JSON.stringify(whIn(f, regionsOf(f)[0])));
    check('الكتلة الثانية كاملة (8 مذاخر)',
      eq(whIn(f, regionsOf(f)[1]), ['طريق اليسر', 'طريق السلام', 'اوزون', 'دواء الكندي', 'شغف', 'المنارة', 'الفصول الأربعة', 'مصدر الدواء']),
      JSON.stringify(whIn(f, regionsOf(f)[1])));
    check('«الكوت» تشمل الأعمدة التي تسبق اسمها',
      eq(whIn(f, 'الكوت'), ['الزيتون', 'بغداد', 'مزايا', 'الرازي', 'الكوت', 'الغدير', 'المدينة']),
      JSON.stringify(whIn(f, 'الكوت')));
    check('الاسم المقسوم دُمج مع الحرف المفرد',
      regionsOf(f)[0].includes('الحارثية') && regionsOf(f)[0].includes('ح'),
      JSON.stringify(regionsOf(f)[0]));
    check('المنطقتان متمايزتان', regionsOf(f)[0] !== regionsOf(f)[1],
      JSON.stringify(regionsOf(f).slice(0, 2)));
  }
}
// ── النتيجة ───────────────────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });
console.log(`\n\x1b[1mالنتيجة:\x1b[0m ${pass} ناجح، ${fail} فاشل`);
if (fail) { console.log('الفاشل:\n  - ' + failures.join('\n  - ')); process.exit(1); }
