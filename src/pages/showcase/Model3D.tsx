// ════════════════════════════════════════════════════════════════════════════
// Model3D — مجسّمات «استوديو المجسّم» غير الصندوقية (الصندوق = Box3D في HomePage):
//   - Cylinder3D: أسطوانة (عبوة، قنينة، أنبوب، علبة دائرية) من بانوراما ملصقها.
//   - Standee3D: مجسّم مقصوص بسُمك (شخص، عارضة، ملابس، أي غرض) — وجه أمامي وخلفي
//     وطبقات بينهما تصنع الحافة، فيدور 360° كمجسّم لا كصورة مسطّحة.
// كلاهما يدور ذاتياً ويُسحب بالماوس/الإصبع (نفس سلوك Box3D مع spin) ويستعمل نفس
// أصناف CSS (b3d-scene/b3d-bob/b3d-shadow/b3d-glow) فيرث مظهر الصفحة.
// ════════════════════════════════════════════════════════════════════════════

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box3D } from '../HomePage';

const SPIN_DEG_PER_MS = 360 / 36_000;

/** دوران ذاتي + سحب، نسخة Box3D نفسها كخطّاف مشترك */
function useSpinDrag(initialX = -12) {
  const boxRef = useRef<HTMLDivElement>(null);
  const rot = useRef({ x: initialX, y: 0, moved: false, drag: null as null | { id: number; px: number; py: number; x: number; y: number } });
  const isActive = (el: Element) => { const slot = el.closest('.cf-slot'); return !slot || slot.classList.contains('is-active'); };

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0, prev = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(t - prev, 100); prev = t;
      const r = rot.current, el = boxRef.current;
      if (el) {
        if (!r.drag && !reduce && isActive(el)) r.y -= dt * SPIN_DEG_PER_MS;
        el.style.transform = `rotateX(${r.x}deg) rotateY(${r.y}deg)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.pointerType === 'mouse' && e.button !== 0) || !isActive(e.currentTarget)) return;
      e.stopPropagation();
      const r = rot.current;
      r.drag = { id: e.pointerId, px: e.clientX, py: e.clientY, x: r.x, y: r.y };
      r.moved = false;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = rot.current.drag;
      if (!d || d.id !== e.pointerId) return;
      e.stopPropagation();
      const dx = e.clientX - d.px, dy = e.clientY - d.py;
      if (Math.abs(dx) + Math.abs(dy) > 4) rot.current.moved = true;
      rot.current.y = d.y + dx * 0.5;
      rot.current.x = Math.max(-60, Math.min(40, d.x - dy * 0.4));
    },
    onPointerUp: (e: React.PointerEvent) => {
      const r = rot.current;
      if (!r.drag || r.drag.id !== e.pointerId) return;
      r.drag = null;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* */ }
    },
    onClickCapture: (e: React.MouseEvent) => { if (rot.current.moved) { rot.current.moved = false; e.stopPropagation(); e.preventDefault(); } },
  };
  return { boxRef, handlers: { ...handlers, onPointerCancel: handlers.onPointerUp } };
}

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

function useImageAspect(src?: string) {
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    const im = new Image();
    im.onload = () => { if (alive) setAspect(im.naturalWidth / im.naturalHeight); };
    im.src = src;
    return () => { alive = false; };
  }, [src]);
  return aspect;
}

function Scene({ children, w, h, label, sceneRef, handlers, boxRef, shadowW }: {
  children: ReactNode; w: number; h: number; label: string; shadowW: number;
  sceneRef: React.RefObject<HTMLDivElement>; boxRef: React.RefObject<HTMLDivElement>;
  handlers: ReturnType<typeof useSpinDrag>['handlers'];
}) {
  return (
    <div className="b3d-scene is-draggable" ref={sceneRef} {...handlers}>
      {w > 0 && (
        <>
          <div className="b3d-glow" style={{ width: w * 1.6, height: h * 1.2 }} />
          <div className="b3d-shadow" style={{ width: shadowW }} />
          <div className="b3d-bob">
            <div ref={boxRef} className="b3d is-spin" role="img" aria-label={label} style={{ width: w, height: h }}>
              {children}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * أسطوانة من بانوراما ملصقها (عرضها = المحيط، يبدأ من الخلف −180° وينتهي عنده +180°،
 * الأمامي في الوسط — راجع cylinderPanorama). dia/height بأي وحدة (النسبة فقط تهم).
 */
export function Cylinder3D({ wrap, dia, height, cap = '#d8d8d8', label, scale = 1 }: {
  wrap: string; dia: number; height: number; cap?: string; label: string; scale?: number;
}) {
  const { ref, size } = useSize();
  const { boxRef, handlers } = useSpinDrag(-14);
  const aspect = dia / height;
  let H = size.h * 0.6 * scale, D = H * aspect;
  if (D > size.w * 0.45 * scale) { D = size.w * 0.45 * scale; H = D / aspect; }
  const R = D / 2;
  const N = 48;
  const sw0 = (Math.PI * D) / N;          // عرض الشريحة على المحيط
  const sw = sw0 + 0.8;                    // + تداخل كي لا تظهر فواصل
  const apothem = R * Math.cos(Math.PI / N);
  const strips: ReactNode[] = [];
  if (size.w > 0) for (let i = 0; i < N; i++) {
    const a = (i * 360) / N;
    // إضاءة: الوجه المقابل للضوء (يسار-أمام) أفتح، الجوانب البعيدة أظلم
    const shade = 0.18 - 0.2 * Math.cos(((a + 30) * Math.PI) / 180);
    const ov = shade >= 0 ? `rgba(0,0,0,${shade.toFixed(3)})` : `rgba(255,255,255,${(-shade).toFixed(3)})`;
    strips.push(
      <div key={i} className="b3d-face" style={{
        width: sw, height: H, left: (D - sw) / 2, top: 0,
        transform: `rotateY(${a}deg) translateZ(${apothem}px)`,
        background: `linear-gradient(${ov}, ${ov}), url("${wrap}") ${-(i * sw0 + Math.PI * D / 2 - sw0 / 2) - 0.4}px 0 / ${Math.PI * D}px ${H}px repeat-x`,
      }} />,
    );
  }
  return (
      <Scene w={D} h={H} label={label} sceneRef={ref} boxRef={boxRef} handlers={handlers} shadowW={D * 1.3}>
        {strips}
        <div className="b3d-face" style={{ width: D, height: D, left: 0, top: (H - D) / 2, borderRadius: '50%',
          transform: `rotateX(90deg) translateZ(${H / 2}px)`, background: `linear-gradient(rgba(255,255,255,.18), rgba(255,255,255,.18)), ${cap}` }} />
        <div className="b3d-face" style={{ width: D, height: D, left: 0, top: (H - D) / 2, borderRadius: '50%',
          transform: `rotateX(-90deg) translateZ(${H / 2}px)`, background: `linear-gradient(rgba(0,0,0,.3), rgba(0,0,0,.3)), ${cap}` }} />
      </Scene>
  );
}

/**
 * مجسّم مقصوص بسُمك: الأمامي في +z، الخلفي (صورته أو ظلّ الأمامي المعكوس) في −z، وطبقات
 * داكنة من نفس القصّة بينهما تصنع حافة صلبة تُرى عند الدوران. thick = السُمك نسبةً للعرض.
 */
export function Standee3D({ front, back, label, thick = 0.06, scale = 1 }: {
  front: string; back?: string; label: string; thick?: number; scale?: number;
}) {
  const { ref, size } = useSize();
  const { boxRef, handlers } = useSpinDrag(-6);
  const aspect = useImageAspect(front);
  let H = size.h * 0.74 * scale, W = aspect ? H * aspect : 0;
  if (W > size.w * 0.7 * scale) { W = size.w * 0.7 * scale; H = W / (aspect || 1); }
  const T = Math.max(2, W * thick);
  const K = Math.max(4, Math.min(14, Math.round(T / 1.5)));
  const img = (src: string, style: React.CSSProperties, key: string) => (
    <img key={key} src={src} alt="" draggable={false} className="sd-layer"
      style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, objectFit: 'contain', ...style }} />
  );
  const layers: ReactNode[] = [];
  if (aspect && size.w > 0) {
    for (let k = 1; k < K; k++) {
      const z = -T / 2 + (T * k) / K;
      layers.push(img(front, { transform: `translateZ(${z}px)`, filter: 'brightness(.42) saturate(.7)' }, `m${k}`));
    }
    layers.push(img(front, { transform: `translateZ(${T / 2}px)`, backfaceVisibility: 'hidden' }, 'f'));
    layers.push(img(back || front, {
      transform: `rotateY(180deg) translateZ(${T / 2}px)`, backfaceVisibility: 'hidden',
      ...(back ? {} : { filter: 'brightness(.55) saturate(.8)' }),
    }, 'b'));
  }
  return (
      <Scene w={aspect ? W : 0} h={H} label={label} sceneRef={ref} boxRef={boxRef} handlers={handlers} shadowW={W * 0.9}>
        {layers}
      </Scene>
  );
}

// ── مجسّم جاهز (GLB) — من المسح بالتصوير (photogrammetry) أو أي مصدر ──────────────
// يُعرض بـ <model-viewer> من Google (Apache-2.0)، يُحمَّل كسولاً من CDN عند أول مجسّم فقط.
const MODEL_VIEWER = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@4.3.1/dist/model-viewer.min.js';
let mvLoad: Promise<void> | null = null;
const loadModelViewer = () => (mvLoad ??= new Promise<void>((ok, bad) => {
  if (customElements.get('model-viewer')) return ok();
  const s = document.createElement('script');
  s.type = 'module'; s.src = MODEL_VIEWER;
  s.onload = () => customElements.whenDefined('model-viewer').then(() => ok());
  s.onerror = () => { mvLoad = null; bad(new Error('تعذّر تحميل عارض المجسّمات')); };
  document.head.appendChild(s);
}));

export function Mesh3D({ src, label, scale = 1 }: { src: string; label: string; scale?: number }) {
  const [ready, setReady] = useState(!!customElements.get('model-viewer'));
  const [err, setErr] = useState('');
  useEffect(() => { if (!ready) loadModelViewer().then(() => setReady(true)).catch(e => setErr(e.message)); }, [ready]);
  // السحب على المجسّم يدوّره هو لا الدوّار (نفس سلوك Box3D) — في البطاقة المعروضة فقط
  const stop = (e: React.PointerEvent) => {
    const slot = (e.currentTarget as Element).closest('.cf-slot');
    if (!slot || slot.classList.contains('is-active')) e.stopPropagation();
  };
  if (err) return <div className="mesh-err">{err}</div>;
  return (
    <div className="b3d-scene mesh-scene" onPointerDown={stop} onPointerMove={stop} onClickCapture={e => e.stopPropagation()}>
      {ready && createElement('model-viewer', {
        src, alt: label, 'camera-controls': true, 'auto-rotate': true, 'rotation-per-second': '10deg',
        'auto-rotate-delay': '1500', 'interaction-prompt': 'none', 'shadow-intensity': '1', exposure: '1.05',
        'environment-image': 'neutral', 'touch-action': 'pan-y', 'disable-pan': true, loading: 'lazy',
        style: { width: `${100 * scale}%`, height: `${100 * scale}%`, background: 'transparent', '--poster-color': 'transparent' },
      })}
    </div>
  );
}

// ── عرض أي عنصر حسب شكله (الدوّار، معاينة الاستوديو، نافذة التعديل) ─────────────
export interface ModelItem {
  shape: 'box' | 'frame' | 'cylinder' | 'standee' | 'mesh';
  faces: Partial<Record<'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'wrap' | 'cutFront' | 'cutBack' | 'model', string>>;
  depth?: number; scale?: number; spin?: boolean; round?: number | null;
  dims?: { w?: number; h?: number; d?: number; dia?: number } | null;
  cap?: string | null; thick?: number | null;
}
/** عمق اللوحة الرقيقة نسبةً لارتفاعها */
const FRAME_DEPTH = 0.035;

export function ModelView({ item, label }: { item: ModelItem; label: string }) {
  const f = item.faces;
  if (item.shape === 'cylinder' && f.wrap) {
    return <Cylinder3D wrap={f.wrap} dia={item.dims?.dia ?? 6} height={item.dims?.h ?? 12} cap={item.cap ?? undefined} label={label} scale={item.scale} />;
  }
  if (item.shape === 'mesh' && f.model) return <Mesh3D src={f.model} label={label} scale={item.scale} />;
  if (item.shape === 'standee' && f.cutFront) {
    return <Standee3D front={f.cutFront} back={f.cutBack} thick={item.thick ?? undefined} label={label} scale={item.scale} />;
  }
  if (!f.front) return null;
  const isBox = item.shape === 'box';
  // الأبعاد الحقيقية (إن وُجدت) تحدّد العمق بدقة؛ وإلا العمق المحفوظ
  const depth = !isBox ? FRAME_DEPTH : item.dims?.d && item.dims?.h ? item.dims.d / item.dims.h : (item.depth ?? 0.33);
  return (
    <Box3D src={f.front} depth={depth} scale={item.scale} spin={item.spin} label={label}
      round={isBox ? (item.round ?? 0.01) : 0}
      faces={isBox ? { left: f.left, right: f.right, top: f.top, back: f.back, bottom: f.bottom } : undefined} />
  );
}
