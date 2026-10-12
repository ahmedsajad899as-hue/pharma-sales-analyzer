// ════════════════════════════════════════════════════════════════════════════
// invoiceImage.js — تعديل اتجاه صورة الفاتورة قبل قراءتها بالذكاء الاصطناعي.
// ────────────────────────────────────────────────────────────────────────────
// المشكلة (مقيسة 2026-10-13): فواتير تُصوَّر مُدارة 90° أو مقلوبة، فيقرأ Gemini سطر
// الزبون الصغير بتذبذب («النعيمي» بدل «النبض»). نفس الصورة بعد تدويرها قائمةً
// قُرئت صحيحة 3 من 3. فنكتشف الاتجاه بنداء lite صغير ثم نُدير البكسلات.
//
// jpeg-js مكتبة JS خالصة (بلا sharp/كتل أصلية) — السيرفر 951MB RAM. تُتخطّى الصور
// غير JPEG أو الكبيرة (فك ترميزها يحجز ~4 بايت/بكسل)، فيُقرأ الأصل كما هو.
// ════════════════════════════════════════════════════════════════════════════

import jpeg from 'jpeg-js';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;

export const isJpeg = (buf) => buf?.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;

/** يُدير JPEG بزاوية 90/180/270 باتجاه عقارب الساعة. يُعيد Buffer جديداً. */
export function rotateJpeg(buf, degrees) {
  const deg = ((Number(degrees) % 360) + 360) % 360;
  if (!deg) return buf;
  const { width: w, height: h, data } = jpeg.decode(buf, {
    useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 256,
  });
  const swap = deg !== 180;
  const nw = swap ? h : w, nh = swap ? w : h;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (deg === 90)       { nx = h - 1 - y; ny = x; }
      else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; }
      else                  { nx = y;         ny = w - 1 - x; }
      const si = (y * w + x) * 4, di = (ny * nw + nx) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data: out, width: nw, height: nh }, 90).data);
}

export const canRotate = (buf) => isJpeg(buf) && buf.length <= MAX_BYTES;
