// ════════════════════════════════════════════════════════════════════════════
// اختبار مطابقة أسماء الصيدليات (src/lib/pharmacyMatch.ts)
// ────────────────────────────────────────────────────────────────────────────
// تشغيل:  node scripts/test-pharmacy-match.mjs
// يحزم الوحدة بـ esbuild (فهي TypeScript موجّهة للمتصفح) ثم يفحص عيّنة الحالات
// التي بُني عليها الترتيب. المخاطرة هنا ليست انهياراً بل انزلاقاً صامتاً: تعديل
// عتبة واحدة يكفي لإخفاء الاسم الصحيح عن المندوب أو لإغراق القائمة بأسماء بعيدة،
// وكلاهما لا يظهر إلا بعد أن يربط أحدهم صيدلية بالخطأ.
// ════════════════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const cacheDir = path.join(ROOT, 'node_modules', '.cache', 'pharmacy-match-test');
fs.mkdirSync(cacheDir, { recursive: true });
const bundle = path.join(cacheDir, 'pharmacyMatch.mjs');

execFileSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  path.join(ROOT, 'src/lib/pharmacyMatch.ts'),
  '--bundle', '--format=esm', '--platform=node', '--log-level=error',
  `--outfile=${bundle}`,
], { cwd: ROOT, stdio: 'inherit' });

const { matchScore, searchScore, rankPharmacies, pharmacyKey } = await import(pathToFileURL(bundle).href);

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `   (${detail})` : ''}`);
  if (!ok) failed++;
};

// ── قرب الاسم: اقتراح «هل هي نفس الصيدلية؟» ────────────────────────────────
console.log('\n[matchScore] أسماء يجب أن تُقترح');
for (const [a, b, min] of [
  ['الميرا', 'صيدلية الميرة', 0.85],      // ا/ة في آخر الكلمة — أشهر اختلاف إملائي
  ['النيم', 'النعيم', 0.6],               // حرف ناقص في اسم قصير
  ['البقالة', 'البقالة الحديثة', 0.8],    // اسم مختصر من نفس الصيدلية
  ['عبد الله تمام', 'تمام عبدالله', 0.85], // ترتيب ووصل مختلفان
  ['علي حسن', 'حسن علي', 0.9],
  ['صيدلية الحياة', 'ص. الحياه', 0.95],   // كلمة الحشو واللاحقة لا تميّزان
]) {
  const r = matchScore(a, b);
  check(r.score >= min, `${a} ⟷ ${b}`, `${Math.round(r.score * 100)}% ≥ ${Math.round(min * 100)}% · ${r.reason}`);
}

console.log('\n[matchScore] أسماء يجب ألا تُقترح');
for (const [a, b, max] of [
  ['الميرا', 'النعيم', 0.34],
  ['البقالة', 'النعيم', 0.34],
  ['الزهراء', 'الزهور', 0.34],
  ['الكرخ', 'الكرادة', 0.34],
]) {
  const r = matchScore(a, b);
  check(r.score < max, `${a} ⟷ ${b}`, `${Math.round(r.score * 100)}% < ${Math.round(max * 100)}%`);
}

// ── البحث الحيّ أثناء الكتابة ───────────────────────────────────────────────
console.log('\n[searchScore] ترتيب نتائج الكتابة');
check(searchScore('نور', 'ص. النور الجديدة').score >= 0.85, 'بداية كلمة تتصدّر');
check(searchScore('نعم', 'النعيم').score >= 0.6, 'حرف ساقط أثناء الكتابة لا يُسقِط النتيجة');
check(searchScore('تمام عبد', 'تمام عبدالله').score >= 0.85, 'كلمتان جزئيتان');
check(searchScore('زهراء', 'النعيم').score === 0, 'استعلام بعيد لا يُرجِع شيئاً');
check(
  searchScore('نور', 'النور').score > searchScore('نور', 'منصور').score,
  'البداية أقوى من الاحتواء',
);

// ── الترتيب النهائي ────────────────────────────────────────────────────────
console.log('\n[rankPharmacies] الترتيب والحدود');
const pool = [
  { name: 'صيدلية الميرة', areaId: 1, areaName: 'الدورة', doctorCount: 4 },
  { name: 'النعيم', areaId: 1, areaName: 'الدورة', doctorCount: 7 },
  { name: 'الزهور', areaId: 1, areaName: 'الدورة', doctorCount: 2 },
];
const auto = rankPharmacies({ pool, sourceName: 'الميرا' });
check(auto[0]?.item.name === 'صيدلية الميرة', 'الأقرب أولاً بلا بحث', auto.map(r => r.item.name).join(' > '));
check(auto.every(r => r.score >= 0.34), 'البعيد لا يدخل القائمة');
const typed = rankPharmacies({ pool, sourceName: 'الميرا', query: 'نعيم' });
check(typed[0]?.item.name === 'النعيم', 'البحث المكتوب يتجاوز قرب الاسم');
check(rankPharmacies({ pool, sourceName: 'الميرا', query: 'xyz' }).length === 0, 'بحث بلا نتائج');

// ── المفتاح المتساهل (يُستعمل لاستبعاد الصيدلية نفسها من مجموعة البحث) ──────
console.log('\n[pharmacyKey] المفتاح المتساهل');
check(pharmacyKey('صيدلية الحياة') === pharmacyKey('الحياه'), 'الحشو وأداة التعريف واللاحقة لا تغيّر المفتاح');
check(pharmacyKey('الميرا') !== pharmacyKey('النعيم'), 'اسمان مختلفان مفتاحاهما مختلفان');

console.log(failed ? `\n✗ فشل ${failed} فحصاً\n` : '\n✓ كل الفحوص ناجحة\n');
process.exit(failed ? 1 : 0);
