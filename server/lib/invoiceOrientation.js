// ════════════════════════════════════════════════════════════════════════════
// invoiceOrientation.js — اتجاه صورة الفاتورة **محلياً بلا ذكاء** (بلا كلفة).
// ────────────────────────────────────────────────────────────────────────────
// سؤالان منفصلان، ولكلٍّ «غير متأكد» يُحال فيه للذكاء كما كان:
//  1) جانبية أم قائمة؟ أسطر النص تصنع تذبذباً قوياً في مجموع الحبر لكل صف حين
//     تكون أفقية، ولكل عمود حين تكون الصورة جانبية. نقارن الطاقتين (مع ميلان ±20°).
//  2) مقلوبة؟ في العربية «ال» و«ا/ل/ك/ط» صواعد طويلة فوق السطر، فتوزيع الحبر داخل
//     كل سطر له ذيل نحو الأعلى (التواء سالب). المقلوبة ذيلها نحو الأسفل.
// قبلهما: قناع «الورقة» (المناطق الفاتحة) وحذف الخطوط الطويلة (حدود الجدول، حافة
// الشاشة) — بدونهما أخطأت صور شاشة الكمبيوتر بثقة.
//
// مقيس 2026-11-13 على 13 فاتورة حقيقية (طريق السلام ورق، العناية صور شاشة) × 4
// تدويرات = 52 حالة: جانبية/قائمة 40 صحيحة و12 غير متأكد و0 خطأ؛ مقلوبة 28 صحيحة
// و24 غير متأكد و0 خطأ. العتبات محافظة عمداً: الخطأ الواثق أغلى من نداء ذكاء.
// ════════════════════════════════════════════════════════════════════════════

import jpeg from 'jpeg-js';

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_SIDE = 900;
const ANGLES = [-20, -15, -10, -6, -3, 0, 3, 6, 10, 15, 20];
export const SIDEWAYS_BELOW = 0.85; // طاقة الصفوف ÷ الأعمدة تحتها ⇒ جانبية
export const UPRIGHT_ABOVE = 1.18;  // فوقها ⇒ أسطر أفقية (قائمة أو مقلوبة)
export const SKEW_MIN = 0.08;       // |الالتواء| أقل منه ⇒ لا نحكم على القلب

const isJpeg = (buf) => buf?.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;

/** رمادي مصغّر (متوسط كتل) — الضلع الأطول ≤ maxSide. */
function grayDown(buf, maxSide) {
  const { width: w, height: h, data } = jpeg.decode(buf, {
    useTArray: true, formatAsRGBA: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 256,
  });
  const s = Math.min(1, maxSide / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const g = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y / s), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) / s)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x / s), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) / s)));
      let v = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          v += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++;
        }
      }
      g[y * nw + x] = v / n;
    }
  }
  return { w: nw, h: nh, g };
}

function integral(w, h, g) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  return (x0, y0, x1, y1) => (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
}

/** بكسلات الحبر داخل الورقة، بعد حذف الخطوط المستقيمة الطويلة. يُعيد قناعاً 0/1. */
function inkMask({ w, h, g }) {
  const mean = integral(w, h, g);
  const win = Math.max(8, Math.round(Math.max(w, h) / 60));
  const big = Math.max(20, Math.round(Math.max(w, h) / 12));
  const local = (x, y, r) => mean(Math.max(0, x - r), Math.max(0, y - r), Math.min(w, x + r + 1), Math.min(h, y + r + 1));
  // الورقة = جوار فاتح نسبةً لأفتح مناطق الصورة (يُسقط حافة الشاشة والطاولة والكيبورد)
  const samples = [];
  for (let y = 0; y < h; y += 7) for (let x = 0; x < w; x += 7) samples.push(local(x, y, big));
  samples.sort((a, b) => a - b);
  const paperMin = samples[Math.floor(samples.length * 0.95)] * 0.72;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (local(x, y, big) < paperMin) continue;
      if (g[y * w + x] < local(x, y, win) * 0.82) m[y * w + x] = 1;
    }
  }
  const L = Math.round(Math.max(w, h) * 0.05);
  const out = m.slice();
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && m[y * w + x]) continue;
      if (x - s > L) for (let k = s; k < x; k++) out[y * w + k] = 0;
      s = x + 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && m[y * w + x]) continue;
      if (y - s > L) for (let k = s; k < y; k++) out[k * w + x] = 0;
      s = y + 1;
    }
  }
  return out;
}

/** نقاط الحبر: a = الإحداثي على امتداد السطر، b = عبره. */
function points(mask, w, h) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  const xs = new Int32Array(n), ys = new Int32Array(n);
  let k = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { xs[k] = x; ys[k] = y; k++; }
  return { xs, ys, n };
}

/** طاقة الإسقاط (تباين ÷ مربع المتوسط) على المحور b بعد ميلان a — أعلاها وزاويتها. */
function bestEnergy(along, across, n, alongLen, angles) {
  let best = 0, bestA = 0;
  for (const deg of angles) {
    const t = Math.tan(deg * Math.PI / 180);
    const off = Math.ceil(Math.abs(t) * alongLen) + 1;
    let maxIdx = 0;
    for (let i = 0; i < n; i++) { const v = Math.round(across[i] + along[i] * t) + off; if (v > maxIdx) maxIdx = v; }
    const Q = new Float64Array(maxIdx + 1);
    for (let i = 0; i < n; i++) Q[Math.round(across[i] + along[i] * t) + off]++;
    let s = 0, s2 = 0, c = 0;
    for (const v of Q) { if (!v) continue; s += v; s2 += v * v; c++; }
    const mu = c ? s / c : 0;
    const e = mu > 0 ? (s2 / c) / (mu * mu) : 0;
    if (e > best) { best = e; bestA = deg; }
  }
  return { energy: best, angle: bestA };
}

/** التواء توزيع الحبر داخل كل سطر (موزوناً): سالب = ذيل نحو الأعلى = قائم. */
function lineSkew(xs, ys, n, w) {
  const coarse = bestEnergy(xs, ys, n, w, ANGLES).angle;
  const fine = [];
  for (let d = -3; d <= 3; d += 0.5) fine.push(coarse + d);
  const angle = bestEnergy(xs, ys, n, w, fine).angle;
  const t = Math.tan(angle * Math.PI / 180);
  const off = Math.ceil(Math.abs(t) * w) + 1;
  let maxIdx = 0;
  for (let i = 0; i < n; i++) { const v = Math.round(ys[i] + xs[i] * t) + off; if (v > maxIdx) maxIdx = v; }
  const STRIPS = 4, sw = Math.ceil(w / STRIPS);
  const P = Array.from({ length: STRIPS }, () => new Float64Array(maxIdx + 1));
  for (let i = 0; i < n; i++) P[Math.min(STRIPS - 1, Math.floor(xs[i] / sw))][Math.round(ys[i] + xs[i] * t) + off]++;
  let num = 0, den = 0, bands = 0;
  for (const Q of P) {
    const sorted = [...Q].filter(v => v > 0).sort((a, b) => a - b);
    if (!sorted.length) continue;
    const T = 0.12 * sorted[Math.floor(sorted.length * 0.95)];
    let i = 0;
    while (i < Q.length) {
      if (Q[i] <= T) { i++; continue; }
      let j = i;
      while (j < Q.length && Q[j] > T) j++;
      if (j - i >= 4) {
        let W = 0, mu = 0;
        for (let k = i; k < j; k++) { W += Q[k]; mu += Q[k] * k; }
        mu /= W;
        let v2 = 0, v3 = 0;
        for (let k = i; k < j; k++) { const d = k - mu; v2 += Q[k] * d * d; v3 += Q[k] * d * d * d; }
        v2 /= W; v3 /= W;
        if (v2 > 0) { num += W * v3 / Math.pow(v2, 1.5); den += W; bands++; }
      }
      i = j;
    }
  }
  return { skew: den ? num / den : 0, bands };
}

/**
 * @param {Buffer} buf JPEG
 * @returns {{ sure:boolean, deg:number|null, family:'upright'|'sideways'|null, ratio:number|null, skew:number|null, ms:number, why?:string }}
 *   deg = التدوير اللازم مع عقارب الساعة حين sure. family يُعرف أحياناً وحده (فيُسأل الذكاء بين نسختين فقط).
 *   لا ترمي أبداً.
 */
export function detectOrientationLocal(buf) {
  const started = Date.now();
  const unsure = (why, extra = {}) => ({ sure: false, deg: null, family: null, ratio: null, skew: null, ...extra, why, ms: Date.now() - started });
  try {
    if (!isJpeg(buf) || buf.length > MAX_BYTES) return unsure('not-jpeg');
    const img = grayDown(buf, MAX_SIDE);
    const mask = inkMask(img);
    const { xs, ys, n } = points(mask, img.w, img.h);
    if (n < 500) return unsure('little-ink');
    const eRows = bestEnergy(xs, ys, n, img.w, ANGLES).energy;
    const eCols = bestEnergy(ys, xs, n, img.h, ANGLES).energy;
    const ratio = eCols > 0 ? eRows / eCols : 0;
    const family = ratio < SIDEWAYS_BELOW ? 'sideways' : ratio > UPRIGHT_ABOVE ? 'upright' : null;
    if (!family) return unsure('family', { ratio });
    // جانبية ⇒ تُدار النقاط 90° مع عقارب الساعة: (x,y) ← (h-1-y, x) فتصير الأسطر أفقية
    let s;
    if (family === 'sideways') {
      const rx = new Int32Array(n), ry = new Int32Array(n);
      for (let i = 0; i < n; i++) { rx[i] = img.h - 1 - ys[i]; ry[i] = xs[i]; }
      s = lineSkew(rx, ry, n, img.h);
    } else {
      s = lineSkew(xs, ys, n, img.w);
    }
    const flip = s.skew < -SKEW_MIN ? 0 : s.skew > SKEW_MIN ? 180 : null;
    if (flip == null || s.bands < 6) return { sure: false, deg: null, family, ratio, skew: s.skew, why: 'flip', ms: Date.now() - started };
    const deg = family === 'sideways' ? (flip === 0 ? 90 : 270) : flip;
    return { sure: true, deg, family, ratio, skew: s.skew, ms: Date.now() - started };
  } catch (e) {
    return unsure(`error: ${String(e?.message || e).slice(0, 80)}`);
  }
}
