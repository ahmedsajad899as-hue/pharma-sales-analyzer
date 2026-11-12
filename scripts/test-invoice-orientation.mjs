// اختبار كشف اتجاه الفاتورة محلياً (server/lib/invoiceOrientation.js) على صور حقيقية.
// العيّنات خارج المستودع (بيانات زبائن): ../invoice-samples/<مذخر>/*.jpeg — تُتخطّى إن غابت.
// الإجابة الصحيحة لكل صورة أصلية (التدوير اللازم مع عقارب الساعة) في ANSWERS، فُحصت بالعين.
// القاعدة: صفر أخطاء واثقة — «غير متأكد» مقبول (يُحال للذكاء كما كان).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectOrientationLocal } from '../server/lib/invoiceOrientation.js';
import { rotateJpeg } from '../server/lib/invoiceImage.js';
import jpeg from 'jpeg-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'invoice-samples');
// صور طريق السلام العمودية (900×1600) مصوّرة جانبية: تحتاج 270. البقية قائمة.
const ANSWERS = { 'طريق السلام': (w, h) => (h > w ? 270 : 0), 'العناية الطبية': () => 0 };

if (!fs.existsSync(ROOT)) { console.log('⏭️  لا عيّنات في', ROOT); process.exit(0); }

let right = 0, unsure = 0, wrong = 0, ms = 0, n = 0;
for (const dir of Object.keys(ANSWERS)) {
  const p = path.join(ROOT, dir);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p).filter(x => /\.jpe?g$/i.test(x))) {
    const buf = fs.readFileSync(path.join(p, f));
    const { width: w, height: h } = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
    const need0 = ANSWERS[dir](w, h);
    for (const extra of [0, 90, 180, 270]) {
      const img = extra ? rotateJpeg(buf, extra) : buf;
      const need = ((need0 - extra) % 360 + 360) % 360;
      const r = detectOrientationLocal(img);
      n++; ms += r.ms;
      if (!r.sure) { unsure++; continue; }
      if (r.deg === need) right++;
      else { wrong++; console.log(`❌ ${dir}/${f} +${extra}: قال ${r.deg} والصحيح ${need} (ratio ${r.ratio?.toFixed(2)} skew ${r.skew?.toFixed(3)})`); }
    }
  }
}
console.log(`اتجاه محلي: ${right} صحيح، ${unsure} غير متأكد، ${wrong} خطأ من ${n} — متوسط ${Math.round(ms / Math.max(1, n))}ms`);
process.exit(wrong ? 1 : 0);
