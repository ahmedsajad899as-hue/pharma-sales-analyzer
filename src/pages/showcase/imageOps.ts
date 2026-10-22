// ════════════════════════════════════════════════════════════════════════════
// imageOps — معالجة صور «استوديو المجسّم» في المتصفح (بلا سيرفر — RAM السيرفر هو عنق
// الزجاجة، راجع server_capacity):
//   - تحميل الصورة مع اتجاه EXIF وتصغير معقول.
//   - تصحيح المنظور: رباعي الزوايا في الصورة ← مستطيل بالأبعاد الحقيقية (homography).
//   - فكّ ملصق الأسطوانة: الجزء المرئي من الجسم الدائري ← شريط مسطّح (arcsin).
//   - تركيب «بانوراما» الأسطوانة من الوجه الأمامي والخلفي.
// ════════════════════════════════════════════════════════════════════════════

export type Pt = { x: number; y: number };
/** ترتيب الزوايا دائماً: أعلى-يسار، أعلى-يمين، أسفل-يمين، أسفل-يسار */
export type Quad = [Pt, Pt, Pt, Pt];

const MAX_SRC = 2400;

/** ملف ← canvas باتجاه EXIF الصحيح، أطول ضلع ≤ MAX_SRC */
export async function fileToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const s = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

/** تدوير canvas بأرباع دورة (1 = مع عقارب الساعة) */
export function rotateCanvas(src: HTMLCanvasElement, quarter: number): HTMLCanvasElement {
  const q = ((quarter % 4) + 4) % 4;
  if (!q) return src;
  const c = document.createElement('canvas');
  c.width = q % 2 ? src.height : src.width;
  c.height = q % 2 ? src.width : src.height;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(q * Math.PI / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function flipCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

/** نسخة مصغّرة (لإرسالها للذكاء الاصطناعي أو للمعاينة السريعة) */
export function scaledCanvas(src: HTMLCanvasElement, maxSide: number): { canvas: HTMLCanvasElement; scale: number } {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (s === 1) return { canvas: src, scale: 1 };
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return { canvas: c, scale: s };
}

/** حل homography من 4 نقاط: يُرجع دالة تحوّل نقطة من «from» إلى «to» */
function homography(from: Quad, to: Quad): (x: number, y: number) => [number, number] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: X, y: Y } = to[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  }
  // حذف غاوسي مع محور جزئي
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return (x, y) => {
    const w = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  };
}

/** قصّ رباعي الزوايا من الصورة وتسويته إلى مستطيل outW×outH (عيّنة ثنائية الخطية) */
export function warpQuad(src: HTMLCanvasElement, quad: Quad, outW: number, outH: number): HTMLCanvasElement {
  outW = Math.max(2, Math.round(outW)); outH = Math.max(2, Math.round(outH));
  const sd = src.getContext('2d')!.getImageData(0, 0, src.width, src.height);
  const S = sd.data, sw = src.width, sh = src.height;
  const map = homography([{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }], quad);
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d')!;
  const od = octx.createImageData(outW, outH);
  const D = od.data;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let [sx, sy] = map(x + 0.5, y + 0.5);
      sx -= 0.5; sy -= 0.5;
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(sx))), y0 = Math.max(0, Math.min(sh - 2, Math.floor(sy)));
      const fx = Math.max(0, Math.min(1, sx - x0)), fy = Math.max(0, Math.min(1, sy - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * outW + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = S[i00 + k] + (S[i10 + k] - S[i00 + k]) * fx;
        const bot = S[i01 + k] + (S[i11 + k] - S[i01 + k]) * fx;
        D[o + k] = top + (bot - top) * fy;
      }
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

/**
 * فكّ الجزء المرئي من أسطوانة (مستطيل مسطّح بعرض = القطر الظاهر) إلى ملصق بعرض نصف المحيط.
 * العمود u في الناتج يقابل زاوية θ ∈ [-90°, 90°] حول المحور، ومصدره x = r + r·sin θ — فتعود
 * الكتابة المضغوطة قرب حافتَي الأسطوانة إلى عرضها الحقيقي.
 */
export function unwrapCylinder(rect: HTMLCanvasElement): HTMLCanvasElement {
  const w = rect.width, h = rect.height, r = w / 2;
  const outW = Math.round(Math.PI * r);
  const out = document.createElement('canvas');
  out.width = outW; out.height = h;
  const ctx = out.getContext('2d')!;
  for (let u = 0; u < outW; u++) {
    const th = ((u + 0.5) / outW - 0.5) * Math.PI;
    const sx = r + r * Math.sin(th);
    // عمود مصدر بعرض يتناسب مع الضغط (cos θ) كي لا تظهر خطوط
    const sw = Math.max(1, Math.cos(th) * (Math.PI * r / outW) * 1.2);
    ctx.drawImage(rect, Math.max(0, Math.min(w - sw, sx - sw / 2)), 0, sw, h, u, 0, 1.02, h);
  }
  return out;
}

/**
 * بانوراما الأسطوانة (360°): الأمامي في الوسط (−90°..90°)، والخلفي مقسوم على الطرفين
 * (180°..270° يساراً و90°..180° يميناً) — يطابق ترتيب الشرائح في Cylinder3D.
 * بلا خلفي: يُكرَّر الأمامي.
 */
export function cylinderPanorama(front: HTMLCanvasElement, back?: HTMLCanvasElement | null): HTMLCanvasElement {
  const half = front.width, h = front.height;
  const b = back ?? front;
  const out = document.createElement('canvas');
  out.width = half * 2; out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(front, half / 2, 0, half, h);
  // نصف الخلفي الأيمن (180°..270°) أول البانوراما، ونصفه الأيسر (90°..180°) آخرها
  ctx.drawImage(b, b.width / 2, 0, b.width / 2, b.height, 0, 0, half / 2, h);
  ctx.drawImage(b, 0, 0, b.width / 2, b.height, half * 1.5, 0, half / 2, h);
  return out;
}

/** لون الوسيط لشريط أعلى الصورة (لون غطاء الأسطوانة) */
export function topEdgeColor(c: HTMLCanvasElement): string {
  const h = Math.max(2, Math.round(c.height * 0.03));
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, h).data;
  const ch: number[][] = [[], [], []];
  for (let i = 0; i < d.length; i += 4) { ch[0].push(d[i]); ch[1].push(d[i + 1]); ch[2].push(d[i + 2]); }
  const med = ch.map(a => a.sort((p, q) => p - q)[a.length >> 1]);
  return '#' + med.map(v => v.toString(16).padStart(2, '0')).join('');
}

export const canvasToBlob = (c: HTMLCanvasElement, type = 'image/jpeg', q = 0.9) =>
  new Promise<Blob>((ok, bad) => c.toBlob(b => (b ? ok(b) : bad(new Error('تعذّر حفظ الصورة'))), type, q));

/** canvas ← JPEG base64 (بلا المقدمة) لإرساله للذكاء الاصطناعي */
export function canvasToBase64(c: HTMLCanvasElement, q = 0.85): string {
  return c.toDataURL('image/jpeg', q).split(',')[1];
}

/** رباعي افتراضي داخل الصورة (هامش 12%) */
export function defaultQuad(w: number, h: number): Quad {
  const mx = w * 0.12, my = h * 0.12;
  return [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my }];
}
