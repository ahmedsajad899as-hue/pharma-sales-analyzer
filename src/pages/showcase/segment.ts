// ════════════════════════════════════════════════════════════════════════════
// segment — إزالة الخلفية في المتصفح بـ MediaPipe Tasks Vision (Apache-2.0) للمجسّمات
// «المقصوصة» (أشخاص، عارضات، ملابس، أي غرض). يُحمَّل كسولاً من CDN عند أول استعمال فقط:
//   - شخص/عارضة: selfie_multiclass (شعر، بشرة، وجه، ملابس، إكسسوارات) — تلقائي بالكامل.
//   - غرض/ملابس وحدها: interactive segmenter — المستخدم ينقر على الغرض (نقطة أو أكثر).
// لا شيء يُرسل لأي سيرفر؛ النموذج يعمل على جهاز المستخدم.
// ════════════════════════════════════════════════════════════════════════════

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const PERSON_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const POINT_MODEL = 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/latest/magic_touch.tflite';

/* eslint-disable @typescript-eslint/no-explicit-any */
let visionP: Promise<{ m: any; fs: any }> | null = null;
const loadVision = () => (visionP ??= (async () => {
  const m = await import(/* @vite-ignore */ `${MP}/vision_bundle.mjs`);
  const fs = await m.FilesetResolver.forVisionTasks(`${MP}/wasm`);
  return { m, fs };
})().catch(e => { visionP = null; throw e; }));

let personSeg: Promise<any> | null = null;
let pointSeg: Promise<any> | null = null;
const getPersonSeg = () => (personSeg ??= loadVision().then(({ m, fs }) => m.ImageSegmenter.createFromOptions(fs, {
  baseOptions: { modelAssetPath: PERSON_MODEL, delegate: 'CPU' },
  runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true,
})).catch(e => { personSeg = null; throw e; }));
const getPointSeg = () => (pointSeg ??= loadVision().then(({ m, fs }) => m.InteractiveSegmenter.createFromOptions(fs, {
  baseOptions: { modelAssetPath: POINT_MODEL, delegate: 'CPU' },
  outputCategoryMask: false, outputConfidenceMasks: true,
})).catch(e => { pointSeg = null; throw e; }));

/** قناع ثقة (0..1) بحجم الصورة */
export interface Mask { w: number; h: number; a: Float32Array }

function readMask(mp: any): Mask {
  return { w: mp.width, h: mp.height, a: new Float32Array(mp.getAsFloat32Array()) };
}

/** شخص كامل بملابسه: 1 − ثقة «الخلفية» (الفئة 0) */
export async function segmentPerson(img: HTMLCanvasElement): Promise<Mask> {
  const seg = await getPersonSeg();
  const res = seg.segment(img);
  try {
    const bg = readMask(res.confidenceMasks[0]);
    for (let i = 0; i < bg.a.length; i++) bg.a[i] = 1 - bg.a[i];
    return bg;
  } finally { res.close?.(); }
}

/** الغرض تحت النقطة (إحداثيات 0..1). عدة نقاط = اتحاد أقنعتها */
export async function segmentAtPoints(img: HTMLCanvasElement, pts: { x: number; y: number }[]): Promise<Mask> {
  const seg = await getPointSeg();
  let acc: Mask | null = null;
  for (const p of pts) {
    const res = seg.segment(img, { keypoint: { x: p.x, y: p.y } });
    try {
      const masks = res.confidenceMasks as any[];
      let m = readMask(masks[masks.length - 1]);
      // اتجاه القناع يختلف بين الإصدارات: القيمة عند نقطة النقر يجب أن تكون «الغرض»
      const at = m.a[Math.min(m.h - 1, Math.floor(p.y * m.h)) * m.w + Math.min(m.w - 1, Math.floor(p.x * m.w))];
      if (at < 0.5) { m = { ...m, a: m.a.map(v => 1 - v) }; }
      if (!acc) acc = m;
      else for (let i = 0; i < acc.a.length; i++) acc.a[i] = Math.max(acc.a[i], m.a[i]);
    } finally { res.close?.(); }
  }
  if (!acc) throw new Error('انقر على الغرض أولاً');
  return acc;
}

/**
 * تطبيق القناع: الخلفية شفافة بحافة ناعمة (انتقال بين 0.35 و0.65 بدل قطع حاد)، ثم قصّ
 * الصورة على حدود الغرض مع هامش صغير. الناتج PNG/WebP بشفافية.
 */
export function applyMask(img: HTMLCanvasElement, mask: Mask, erase?: HTMLCanvasElement | null): HTMLCanvasElement {
  const w = img.width, h = img.height;
  const ctx = img.getContext('2d')!;
  const d = ctx.getImageData(0, 0, w, h);
  const er = erase ? erase.getContext('2d')!.getImageData(0, 0, w, h).data : null;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const my = Math.min(mask.h - 1, Math.floor((y / h) * mask.h));
    for (let x = 0; x < w; x++) {
      const mx = Math.min(mask.w - 1, Math.floor((x / w) * mask.w));
      let v = mask.a[my * mask.w + mx];
      v = Math.max(0, Math.min(1, (v - 0.35) / 0.3));
      v = v * v * (3 - 2 * v);
      const i = (y * w + x) * 4;
      // فرشاة المستخدم: أحمر = مسح، أخضر = إرجاع
      if (er) { if (er[i + 3] > 0) v = er[i + 1] > er[i] ? 1 : 0; }
      const a = Math.round(v * 255);
      d.data[i + 3] = a;
      if (a > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) throw new Error('لم يُعثر على الغرض — جرّب نقطة أخرى');
  const pad = Math.round(Math.max(w, h) * 0.01);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const full = document.createElement('canvas');
  full.width = w; full.height = h;
  full.getContext('2d')!.putImageData(d, 0, 0);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(full, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
