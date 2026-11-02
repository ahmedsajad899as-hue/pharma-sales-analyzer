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

/**
 * قصاصة مكبّرة من JPEG: box = [ymin,xmin,ymax,xmax] بمقياس 0-1000، تُوسَّع بهامش
 * ثم تُكبَّر (bilinear) حتى يبلغ ضلعها الأطول ~minSide. سطر الزبون خطّه صغير وسط
 * صورة كاملة تُصغَّر عند الموديل، فيقرأ الجدول ويضيع الاسم — القصاصة تمنحه بكسلات
 * أكثر لكل حرف. يُعيد Buffer أو null.
 */
export function cropJpeg(buf, box, { pad = 60, minSide = 1400, maxScale = 3 } = {}) {
  if (!canRotate(buf) || !Array.isArray(box) || box.length !== 4) return null;
  const { width: w, height: h, data } = jpeg.decode(buf, {
    useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 256,
  });
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  const [y1, x1, y2, x2] = box.map(Number);
  const left = Math.floor(clamp(Math.min(x1, x2) - pad, 1000) / 1000 * w);
  const right = Math.ceil(clamp(Math.max(x1, x2) + pad, 1000) / 1000 * w);
  const top = Math.floor(clamp(Math.min(y1, y2) - pad, 1000) / 1000 * h);
  const bottom = Math.ceil(clamp(Math.max(y1, y2) + pad, 1000) / 1000 * h);
  const cw = right - left, ch = bottom - top;
  if (cw < 20 || ch < 20) return null;
  const s = Math.max(1, Math.min(maxScale, minSide / Math.max(cw, ch)));
  const nw = Math.round(cw * s), nh = Math.round(ch * s);
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(ch - 1, y / s), y0 = Math.floor(sy), y1b = Math.min(ch - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(cw - 1, x / s), x0 = Math.floor(sx), x1b = Math.min(cw - 1, x0 + 1), fx = sx - x0;
      const i00 = ((top + y0) * w + left + x0) * 4, i01 = ((top + y0) * w + left + x1b) * 4;
      const i10 = ((top + y1b) * w + left + x0) * 4, i11 = ((top + y1b) * w + left + x1b) * 4;
      const di = (y * nw + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[di + c] = Math.round(
          (data[i00 + c] * (1 - fx) + data[i01 + c] * fx) * (1 - fy)
          + (data[i10 + c] * (1 - fx) + data[i11 + c] * fx) * fy,
        );
      }
      out[di + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data: out, width: nw, height: nh }, 92).data);
}
