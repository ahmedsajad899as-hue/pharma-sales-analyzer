// ════════════════════════════════════════════════════════════════════════════
// Studio — «استوديو المجسّم»: بناء مجسّم ثلاثي الأبعاد دقيق من صور حقيقية.
//   📦 صندوق: لكل وجه صورة → تحديد زواياه الأربع (اقتراح Claude + سحب يدوي بعدسة مكبّرة)
//      → تصحيح المنظور إلى مستطيل بالأبعاد الحقيقية (سم) → الأوجه الستة.
//   🥫 أسطوانة: صورة أمامية (وخلفية اختيارية) → تصحيح + فكّ الانحناء → بانوراما الملصق.
//   🧍 مقصوص: شخص/عارضة (إزالة خلفية تلقائية) أو ملابس/غرض (نقرة على الغرض) + فرشاة
//      تصحيح → مجسّم بسُمك يدور 360°.
// كل المعالجة في المتصفح؛ السيرفر يستقبل الصور الجاهزة فقط (و Claude يقترح الزوايا والأبعاد).
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Pt, type Quad, fileToCanvas, warpQuad, unwrapCylinder, cylinderPanorama, topEdgeColor,
  canvasToBlob, canvasToBase64, scaledCanvas, defaultQuad,
} from './imageOps';
import { segmentPerson, segmentAtPoints, applyMask, type Mask } from './segment';
import { ModelView, type ModelItem } from './Model3D';

const API = import.meta.env.VITE_API_URL || '';

type Kind = 'box' | 'cylinder' | 'standee' | 'mesh';
type BoxFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
interface FaceSrc { src: HTMLCanvasElement; quad: Quad }

const FACE_INFO: Record<BoxFace, { label: string; tip: string }> = {
  front:  { label: 'الأمامي', tip: 'الوجه الرئيسي كما تراه من الأمام، والكتابة مقروءة.' },
  back:   { label: 'الخلفي', tip: 'كما تراه من الخلف والعلبة واقفة.' },
  left:   { label: 'الطرف الأيسر', tip: 'انظر إليه مباشرة والعلبة واقفة — الوجه الأمامي يكون على يمينك.' },
  right:  { label: 'الطرف الأيمن', tip: 'انظر إليه مباشرة والعلبة واقفة — الوجه الأمامي يكون على يسارك.' },
  top:    { label: 'السقف', tip: 'من فوق والوجه الأمامي باتجاهك: حافته الملاصقة للأمامي تكون في الأسفل.' },
  bottom: { label: 'القاعدة', tip: 'من تحت والوجه الأمامي باتجاهك: حافته الملاصقة للأمامي تكون في الأعلى.' },
};
const BOX_FACES: BoxFace[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];
/** دقّة الحفظ: أطول ضلع لأكبر وجه */
const FINAL_PX = 1400;
const PREVIEW_PX = 520;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
/** نسبة عرض/ارتفاع الوجه كما يظهر في الرباعي (تقريبية — المنظور يحرّفها قليلاً) */
const quadAspect = (q: Quad) => (dist(q[0], q[1]) + dist(q[3], q[2])) / (dist(q[0], q[3]) + dist(q[1], q[2]));
/** تدوير ناتج القصّ ربع دورة مع عقارب الساعة = إزاحة ترتيب الزوايا */
const rotQuad = (q: Quad, cw: number): Quad => {
  const n = ((cw % 4) + 4) % 4;
  return [0, 1, 2, 3].map(i => q[(i - n + 4) % 4]) as Quad;
};
const num = (v: string) => { const n = parseFloat(v.replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };

/** canvas ← رابط blob للمعاينة، يُحرَّر عند التغيير */
function useCanvasUrl(c: HTMLCanvasElement | null, type = 'image/jpeg') {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    if (!c) { setUrl(undefined); return; }
    let u: string | undefined, alive = true;
    canvasToBlob(c, type, 0.85).then(b => { if (alive) { u = URL.createObjectURL(b); setUrl(u); } }).catch(() => {});
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [c, type]);
  return url;
}

async function postJson(token: string | null, path: string, body: unknown) {
  const j = await fetch(`${API}/api/showcase${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json()).catch(() => ({ error: 'تعذّر الاتصال بالسيرفر' }));
  if (!j.success) throw new Error(j.error || 'فشل الطلب');
  return j.data;
}

function pickFile(accept = 'image/*'): Promise<File | null> {
  return new Promise(ok => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => ok(i.files?.[0] ?? null);
    i.click();
  });
}

// ════════════════════════════════════════════════════════════════════════════
export default function Studio({ token, onClose, onSaved }: {
  token: string | null; onClose: () => void; onSaved: (item: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  // ── صندوق ──
  const [faces, setFaces] = useState<Partial<Record<BoxFace, FaceSrc>>>({});
  const [backSame, setBackSame] = useState(true);
  const [dims, setDims] = useState({ w: '', h: '', d: '' });
  const [aiNote, setAiNote] = useState('');
  // ── أسطوانة ──
  const [cyl, setCyl] = useState<{ front?: FaceSrc; back?: FaceSrc }>({});
  const [cdims, setCdims] = useState({ dia: '', h: '' });
  const [cap, setCap] = useState('#d9d9d9');
  // ── مقصوص ──
  const [cut, setCut] = useState<{ front?: HTMLCanvasElement; back?: HTMLCanvasElement }>({});
  const [thick, setThick] = useState(0.05);
  // ── مجسّم جاهز (GLB) ──
  const [mesh, setMesh] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => () => { if (mesh) URL.revokeObjectURL(mesh.url); }, [mesh]);
  const pickMesh = async () => {
    const f = await pickFile('.glb,model/gltf-binary');
    if (!f) return;
    setErr('');
    const head = new TextDecoder().decode(await f.slice(0, 4).arrayBuffer());
    if (head !== 'glTF') { setErr('الملف ليس مجسّم GLB صالحاً'); return; }
    if (f.size > 20 * 1024 * 1024) { setErr(`حجم المجسّم ${(f.size / 1e6).toFixed(1)} MB — الحد 20 MB (اضغطه أولاً)`); return; }
    setMesh({ file: f, url: URL.createObjectURL(f) });
    if (!title) setTitle(f.name.replace(/\.glb$/i, ''));
  };
  // محرّر مفتوح
  const [editing, setEditing] = useState<
    | { type: 'quad'; slot: string; canvas: HTMLCanvasElement; quad?: Quad; aspect: number | null; cyl: boolean }
    | { type: 'seg'; slot: 'front' | 'back'; canvas: HTMLCanvasElement }
    | null>(null);

  // الأبعاد الفعلية للصندوق: ما أدخله المستخدم، وإلا تقدير من نسب الأوجه المقصوصة
  const boxDims = useMemo(() => {
    const w = num(dims.w), h = num(dims.h), d = num(dims.d);
    if (w && h && d) return { w, h, d, estimated: false };
    const f = faces.front;
    const H = 10, W = f ? quadAspect(f.quad) * H : 14;
    const side = faces.left ?? faces.right;
    const tb = faces.top ?? faces.bottom;
    const D = side ? quadAspect(side.quad) * H : tb ? W / quadAspect(tb.quad) : H * 0.4;
    return { w: W, h: H, d: D, estimated: true };
  }, [dims, faces]);
  const cylDims = useMemo(() => {
    const dia = num(cdims.dia), h = num(cdims.h);
    if (dia && h) return { dia, h, estimated: false };
    const f = cyl.front;
    return { dia: f ? quadAspect(f.quad) * 10 : 6, h: 10, estimated: true };
  }, [cdims, cyl]);

  /** حجم كل وجه بالبكسل من الأبعاد (نفس مقياس بكسل/سم لكل الأوجه) */
  const faceSize = (f: BoxFace, maxPx: number) => {
    const { w, h, d } = boxDims;
    const k = maxPx / Math.max(w, h, d);
    if (f === 'front' || f === 'back') return [w * k, h * k];
    if (f === 'left' || f === 'right') return [d * k, h * k];
    return [w * k, d * k];
  };
  const renderFace = (f: BoxFace, maxPx: number): HTMLCanvasElement | null => {
    const src = f === 'back' && backSame && !faces.back ? faces.front : faces[f];
    if (!src) return null;
    const [w, h] = faceSize(f, maxPx);
    return warpQuad(src.src, src.quad, w, h);
  };

  // معاينة الأوجه (دقة منخفضة، تُعاد عند تغيّر الأبعاد/الأوجه بعد تأخير قصير)
  const [pv, setPv] = useState<Partial<Record<BoxFace, HTMLCanvasElement>>>({});
  useEffect(() => {
    if (kind !== 'box') return;
    const t = setTimeout(() => {
      const out: Partial<Record<BoxFace, HTMLCanvasElement>> = {};
      for (const f of BOX_FACES) { const c = renderFace(f, PREVIEW_PX); if (c) out[f] = c; }
      setPv(out);
    }, 250);
    return () => clearTimeout(t);
  }, [kind, faces, boxDims, backSame]); // eslint-disable-line react-hooks/exhaustive-deps
  const pvUrl = {
    front: useCanvasUrl(pv.front ?? null), back: useCanvasUrl(pv.back ?? null), left: useCanvasUrl(pv.left ?? null),
    right: useCanvasUrl(pv.right ?? null), top: useCanvasUrl(pv.top ?? null), bottom: useCanvasUrl(pv.bottom ?? null),
  };

  // بانوراما الأسطوانة
  const [pano, setPano] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (kind !== 'cylinder' || !cyl.front) { setPano(null); return; }
    const t = setTimeout(() => {
      const k = PREVIEW_PX / cylDims.h;
      const flat = (s: FaceSrc) => unwrapCylinder(warpQuad(s.src, s.quad, cylDims.dia * k, cylDims.h * k));
      const f = flat(cyl.front!);
      setPano(cylinderPanorama(f, cyl.back ? flat(cyl.back) : null));
      setCap(c => (c === '#d9d9d9' ? topEdgeColor(f) : c));
    }, 250);
    return () => clearTimeout(t);
  }, [kind, cyl, cylDims]);
  const panoUrl = useCanvasUrl(pano);
  const cutFrontUrl = useCanvasUrl(cut.front ?? null, 'image/webp');
  const cutBackUrl = useCanvasUrl(cut.back ?? null, 'image/webp');

  const previewItem: ModelItem | null =
    kind === 'box' && pvUrl.front ? {
      shape: 'box', depth: boxDims.d / boxDims.h, spin: true, round: 0.01,
      faces: { front: pvUrl.front, back: pvUrl.back, left: pvUrl.left, right: pvUrl.right, top: pvUrl.top, bottom: pvUrl.bottom },
    }
    : kind === 'cylinder' && panoUrl ? { shape: 'cylinder', faces: { wrap: panoUrl }, dims: { dia: cylDims.dia, h: cylDims.h }, cap }
    : kind === 'standee' && cutFrontUrl ? { shape: 'standee', faces: { cutFront: cutFrontUrl, cutBack: cutBackUrl }, thick }
    : kind === 'mesh' && mesh ? { shape: 'mesh', faces: { model: mesh.url } }
    : null;

  // ── رفع صورة لخانة ──
  const addPhoto = async (slot: string) => {
    const file = await pickFile();
    if (!file) return;
    setErr('');
    try {
      const canvas = await fileToCanvas(file);
      if (kind === 'standee') { setEditing({ type: 'seg', slot: slot as 'front' | 'back', canvas }); return; }
      const isCyl = kind === 'cylinder';
      const aspect = isCyl ? (num(cdims.dia) && num(cdims.h) ? num(cdims.dia)! / num(cdims.h)! : null)
        : (num(dims.w) && num(dims.h) && num(dims.d) ? (() => { const [w, h] = faceSize(slot as BoxFace, 100); return w / h; })() : null);
      setEditing({ type: 'quad', slot, canvas, aspect, cyl: isCyl });
    } catch { setErr('تعذّر قراءة الصورة'); }
  };
  const editAgain = (slot: string) => {
    const s = kind === 'cylinder' ? cyl[slot as 'front' | 'back'] : faces[slot as BoxFace];
    if (!s) return;
    const aspect = kind === 'cylinder' ? cylDims.dia / cylDims.h : (() => { const [w, h] = faceSize(slot as BoxFace, 100); return w / h; })();
    setEditing({ type: 'quad', slot, canvas: s.src, quad: s.quad, aspect, cyl: kind === 'cylinder' });
  };

  // ── تقدير الأبعاد بالذكاء الاصطناعي ──
  const aiDims = async () => {
    setBusy('الذكاء الاصطناعي يقدّر الأبعاد…'); setErr(''); setAiNote('');
    try {
      const list = kind === 'cylinder'
        ? (['front', 'back'] as const).filter(f => cyl[f]).map(f => ({ face: f, s: cyl[f]! }))
        : BOX_FACES.filter(f => faces[f]).map(f => ({ face: f, s: faces[f]! }));
      if (!list.length) throw new Error('أضف صورة وجه واحد على الأقل');
      const payload = list.map(({ face, s }) => {
        const ratio = quadAspect(s.quad);
        const H = 700 / Math.max(1, ratio);
        const c = warpQuad(s.src, s.quad, ratio >= 1 ? 700 : 700 * ratio, ratio >= 1 ? H : 700);
        return { face, ratio, image: canvasToBase64(c, 0.82) };
      });
      const d = await postJson(token, '/ai/dims', { kind, faces: payload });
      const r1 = (n?: number) => (n ? String(Math.round(n * 10) / 10) : '');
      if (kind === 'cylinder') setCdims({ dia: r1(d.dims.dia), h: r1(d.dims.h) });
      else setDims({ w: r1(d.dims.w), h: r1(d.dims.h), d: r1(d.dims.d) });
      setAiNote(`🤖 ثقة ${Math.round(d.confidence * 100)}٪ — ${d.note || ''} (القياس بالمسطرة أدق دائماً)`);
    } catch (e: any) { setErr(e.message); } // eslint-disable-line @typescript-eslint/no-explicit-any
    finally { setBusy(''); }
  };

  // ── حفظ ──
  const save = async () => {
    setErr('');
    try {
      const fd = new FormData();
      fd.append('title', title); fd.append('caption', caption); fd.append('spin', 'true');
      const files: [string, Blob, string][] = [];
      if (kind === 'box') {
        if (!faces.front) throw new Error('صورة الوجه الأمامي مطلوبة');
        setBusy('تجهيز الأوجه بالدقة الكاملة…');
        fd.append('shape', 'box'); fd.append('depth', String(boxDims.d / boxDims.h)); fd.append('round', '0.01');
        if (!boxDims.estimated) fd.append('dims', JSON.stringify({ w: boxDims.w, h: boxDims.h, d: boxDims.d }));
        for (const f of BOX_FACES) {
          const c = renderFace(f, FINAL_PX);
          if (c) files.push([f, await canvasToBlob(c, 'image/jpeg', 0.9), `${f}.jpg`]);
        }
      } else if (kind === 'cylinder') {
        if (!cyl.front) throw new Error('الصورة الأمامية مطلوبة');
        setBusy('فكّ الملصق بالدقة الكاملة…');
        const k = FINAL_PX / cylDims.h;
        const flat = (s: FaceSrc) => unwrapCylinder(warpQuad(s.src, s.quad, cylDims.dia * k, cylDims.h * k));
        const p = cylinderPanorama(flat(cyl.front), cyl.back ? flat(cyl.back) : null);
        fd.append('shape', 'cylinder'); fd.append('cap', cap);
        fd.append('dims', JSON.stringify({ dia: cylDims.dia, h: cylDims.h }));
        files.push(['wrap', await canvasToBlob(p, 'image/jpeg', 0.9), 'wrap.jpg']);
      } else if (kind === 'mesh') {
        if (!mesh) throw new Error('اختر ملف المجسّم');
        fd.append('shape', 'mesh');
        files.push(['model', mesh.file, mesh.file.name.toLowerCase().endsWith('.glb') ? mesh.file.name : 'model.glb']);
      } else if (kind === 'standee') {
        if (!cut.front) throw new Error('الصورة الأمامية مطلوبة');
        setBusy('حفظ القصّات…');
        fd.append('shape', 'standee'); fd.append('thick', String(thick));
        const fit = (c: HTMLCanvasElement) => scaledCanvas(c, FINAL_PX).canvas;
        files.push(['cutFront', await canvasToBlob(fit(cut.front), 'image/webp', 0.92), 'front.webp']);
        if (cut.back) files.push(['cutBack', await canvasToBlob(fit(cut.back), 'image/webp', 0.92), 'back.webp']);
      }
      setBusy('رفع المجسّم…');
      for (const [k, b, n] of files) fd.append(k, b, n);
      const j = await fetch(`${API}/api/showcase`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
        .then(r => r.json()).catch(() => ({ error: 'تعذّر الاتصال بالسيرفر' }));
      if (!j.success) throw new Error(j.error || 'فشل الحفظ');
      onSaved(j.data);
    } catch (e: any) { setErr(e.message || 'فشل الحفظ'); } // eslint-disable-line @typescript-eslint/no-explicit-any
    finally { setBusy(''); }
  };

  const slotTile = (slot: string, label: string, canvas: HTMLCanvasElement | null | undefined, opts: { required?: boolean; tip?: string; onEdit?: () => void; onClear?: () => void }) => (
    <div className={`st-slot ${canvas ? 'has' : ''}`} key={slot}>
      <button type="button" className="st-slot-img" onClick={() => (canvas && opts.onEdit ? opts.onEdit() : addPhoto(slot))} title={opts.tip}>
        {canvas ? <CanvasThumb c={canvas} /> : <span>＋</span>}
      </button>
      <div className="st-slot-label">{label}{opts.required ? ' *' : ''}</div>
      {canvas && (
        <div className="st-slot-acts">
          <button type="button" onClick={() => addPhoto(slot)} title="صورة أخرى">🔄</button>
          {opts.onClear && <button type="button" onClick={opts.onClear} title="إزالة">✕</button>}
        </div>
      )}
    </div>
  );

  return (
    <div className="modal-overlay st-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal st-modal" onClick={e => e.stopPropagation()} dir="rtl">
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>🛠️ استوديو المجسّم{kind ? ` — ${({ box: '📦 علبة', cylinder: '🥫 أسطوانة', standee: '🧍 مجسّم مقصوص', mesh: '🧊 مجسّم ممسوح' } as const)[kind]}` : ''}</h3>
          <button className="modal-close" onClick={onClose} disabled={!!busy}>✕</button>
        </div>

        {!kind ? (
          <div className="st-kinds">
            {([
              ['box', '📦', 'علبة / منتج مستطيل', 'علب أدوية، كراتين، كتب — صورة لكل وجه وأبعاد حقيقية'],
              ['cylinder', '🥫', 'أسطوانة', 'قناني، عبوات شراب، أنابيب كريم، علب دائرية'],
              ['standee', '🧍', 'شخص / عارضة / ملابس', 'إزالة الخلفية تلقائياً ومجسّم بسُمك يدور 360°'],
              ['mesh', '🧊', 'مجسّم ممسوح / جاهز', 'ملف GLB من المسح بفيديو 360° أو تطبيق مسح — مجسّم حقيقي من كل الجهات'],
            ] as const).map(([k, ic, t, d]) => (
              <button key={k} type="button" className="st-kind" onClick={() => setKind(k)}>
                <span className="st-kind-ic">{ic}</span><b>{t}</b><small>{d}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="st-body">
            <div className="st-col">
              {kind === 'box' && (
                <>
                  <div className="st-section">
                    <div className="st-h">١. الأبعاد الحقيقية (سم) <small>— قِسها بالمسطرة للدقة الكاملة</small></div>
                    <div className="st-dims">
                      <label>العرض<input className="input" inputMode="decimal" value={dims.w} onChange={e => setDims(d => ({ ...d, w: e.target.value }))} placeholder="مثلاً 14" /></label>
                      <label>الارتفاع<input className="input" inputMode="decimal" value={dims.h} onChange={e => setDims(d => ({ ...d, h: e.target.value }))} placeholder="9" /></label>
                      <label>العمق<input className="input" inputMode="decimal" value={dims.d} onChange={e => setDims(d => ({ ...d, d: e.target.value }))} placeholder="4" /></label>
                      <button type="button" className="btn" onClick={aiDims} disabled={!!busy || !faces.front}>🤖 قدّرها</button>
                    </div>
                    {boxDims.estimated && faces.front && <div className="st-hint">بلا أبعاد: تُقدَّر النِّسب من الصور المقصوصة.</div>}
                    {aiNote && <div className="st-hint">{aiNote}</div>}
                  </div>
                  <div className="st-section">
                    <div className="st-h">٢. صور الأوجه <small>— كل وجه من أمامه مباشرة</small></div>
                    <div className="st-slots">
                      {BOX_FACES.map(f => slotTile(f, FACE_INFO[f].label, f === 'back' && backSame && !faces.back ? null : (pv[f] ?? null), {
                        required: f === 'front', tip: FACE_INFO[f].tip, onEdit: () => editAgain(f),
                        onClear: () => setFaces(x => { const n = { ...x }; delete n[f]; return n; }),
                      }))}
                    </div>
                    <label className="st-check"><input type="checkbox" checked={backSame} onChange={e => setBackSame(e.target.checked)} /> الخلفي مثل الأمامي إن لم تُرفع له صورة</label>
                  </div>
                </>
              )}

              {kind === 'cylinder' && (
                <>
                  <div className="st-section">
                    <div className="st-h">١. الأبعاد الحقيقية (سم)</div>
                    <div className="st-dims">
                      <label>القطر<input className="input" inputMode="decimal" value={cdims.dia} onChange={e => setCdims(d => ({ ...d, dia: e.target.value }))} placeholder="6" /></label>
                      <label>الارتفاع<input className="input" inputMode="decimal" value={cdims.h} onChange={e => setCdims(d => ({ ...d, h: e.target.value }))} placeholder="12" /></label>
                      <button type="button" className="btn" onClick={aiDims} disabled={!!busy || !cyl.front}>🤖 قدّرها</button>
                    </div>
                    {aiNote && <div className="st-hint">{aiNote}</div>}
                  </div>
                  <div className="st-section">
                    <div className="st-h">٢. الصور <small>— من الأمام ومن الخلف، والعبوة واقفة</small></div>
                    <div className="st-slots">
                      {slotTile('front', 'الأمامي', cyl.front?.src, { required: true, onEdit: () => editAgain('front') })}
                      {slotTile('back', 'الخلفي', cyl.back?.src, { onEdit: () => editAgain('back'), onClear: () => setCyl(c => ({ ...c, back: undefined })) })}
                    </div>
                    <label className="st-field">لون الغطاء/القاعدة <input type="color" value={cap} onChange={e => setCap(e.target.value)} /></label>
                  </div>
                </>
              )}

              {kind === 'mesh' && (
                <div className="st-section">
                  <div className="st-h">ملف المجسّم (GLB) <small>— حتى 20 MB</small></div>
                  <button type="button" className="btn" onClick={pickMesh}>{mesh ? '🔄 ملف آخر' : '📂 اختيار ملف .glb'}</button>
                  {mesh && <div className="st-hint">✔ {mesh.file.name} — {(mesh.file.size / 1e6).toFixed(1)} MB</div>}
                  <div className="st-hint">مصادره: المسح بفيديو 360° حول الغرض (تُعالجه أداة المسح على الكمبيوتر)، أو تطبيقات المسح بالموبايل، أو أي خدمة تُصدِّر GLB.</div>
                </div>
              )}

              {kind === 'standee' && (
                <div className="st-section">
                  <div className="st-h">الصور <small>— شخص، عارضة، قطعة ملابس، أو أي غرض</small></div>
                  <div className="st-slots">
                    {slotTile('front', 'الأمامي', cut.front, { required: true })}
                    {slotTile('back', 'الخلفي (اختياري)', cut.back, { onClear: () => setCut(c => ({ ...c, back: undefined })) })}
                  </div>
                  <label className="st-field">السُمك <small>{Math.round(thick * 100)}٪ من العرض</small>
                    <input type="range" min={0.01} max={0.15} step={0.005} value={thick} onChange={e => setThick(Number(e.target.value))} />
                  </label>
                  <div className="st-hint">بلا صورة خلفية: يظهر ظلّ القصّة من الخلف.</div>
                </div>
              )}

              <div className="st-section">
                <label className="st-field">العنوان<input className="input" value={title} maxLength={80} onChange={e => setTitle(e.target.value)} /></label>
                <label className="st-field">وصف قصير (اختياري)<input className="input" value={caption} maxLength={120} onChange={e => setCaption(e.target.value)} /></label>
              </div>
            </div>

            <div className="st-col st-preview-col">
              <div className="st-preview">
                {previewItem ? <ModelView item={previewItem} label={title || 'معاينة'} />
                  : <div className="st-preview-empty">المعاينة تظهر بعد أول صورة</div>}
              </div>
              <div className="st-hint" style={{ textAlign: 'center' }}>اسحب المجسّم لتدويره</div>
            </div>
          </div>
        )}

        <div className="st-foot">
          {kind && <button type="button" className="btn" onClick={() => { setKind(null); setErr(''); }} disabled={!!busy}>→ نوع آخر</button>}
          {busy && <span className="st-busy">⏳ {busy}</span>}
          {err && <span className="st-err">{err}</span>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose} disabled={!!busy}>إلغاء</button>
          {kind && <button type="button" className="btn btn-primary" onClick={save} disabled={!!busy || !previewItem}>💾 حفظ المجسّم</button>}
        </div>

        {editing?.type === 'quad' && (
          <QuadEditor token={token} canvas={editing.canvas} initial={editing.quad} aspect={editing.aspect} cyl={editing.cyl}
            face={editing.cyl ? undefined : (editing.slot as BoxFace)}
            tip={editing.cyl ? 'حدّد جسم العبوة: الحافتان اليمنى واليسرى، وبداية ونهاية الجزء الأسطواني (بلا الغطاء).' : FACE_INFO[editing.slot as BoxFace].tip}
            onCancel={() => setEditing(null)}
            onDone={quad => {
              const fs: FaceSrc = { src: editing.canvas, quad };
              if (editing.cyl) setCyl(c => ({ ...c, [editing.slot]: fs }));
              else setFaces(x => ({ ...x, [editing.slot]: fs }));
              setEditing(null);
            }} />
        )}
        {editing?.type === 'seg' && (
          <SegEditor canvas={editing.canvas}
            onCancel={() => setEditing(null)}
            onDone={c => { setCut(x => ({ ...x, [editing.slot]: c })); setEditing(null); }} />
        )}
      </div>
      <style>{STUDIO_CSS}</style>
    </div>
  );
}

function CanvasThumb({ c }: { c: HTMLCanvasElement }) {
  const url = useCanvasUrl(c, 'image/webp');
  return url ? <img src={url} alt="" /> : null;
}

// ════════════════════════════════════════════════════════════════════════════
// محرّر الزوايا الأربع: سحب بعدسة مكبّرة + اقتراح Claude + تدوير الناتج + معاينة القصّ
// ════════════════════════════════════════════════════════════════════════════
export function QuadEditor({ token, canvas, initial, aspect, cyl, face, tip, onDone, onCancel }: {
  token: string | null; canvas: HTMLCanvasElement; initial?: Quad; aspect: number | null; cyl: boolean;
  face?: BoxFace; tip: string; onDone: (q: Quad) => void; onCancel: () => void;
}) {
  const [quad, setQuad] = useState<Quad>(initial ?? defaultQuad(canvas.width, canvas.height));
  const [drag, setDrag] = useState<number | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const prevRef = useRef<HTMLCanvasElement>(null);
  // نسخة العرض تُحضَّر مرة واحدة: إنشاؤها في كل رسم كان يولّد رابطاً جديداً ويحرّر السابق فتظهر الصورة مكسورة
  const bg = useMemo(() => scaledCanvas(canvas, 1600).canvas, [canvas]);
  const bgUrl = useCanvasUrl(bg);
  const small = useMemo(() => scaledCanvas(canvas, 900), [canvas]);
  const W = canvas.width, H = canvas.height;

  // معاينة القصّ (منخفضة الدقة، تتحدّث مع السحب)
  useEffect(() => {
    const t = setTimeout(() => {
      const a = aspect ?? quadAspect(quad);
      const pw = a >= 1 ? 320 : 320 * a, ph = a >= 1 ? 320 / a : 320;
      let c = warpQuad(small.canvas, quad.map(p => ({ x: p.x * small.scale, y: p.y * small.scale })) as Quad, pw, ph);
      if (cyl) c = unwrapCylinder(c);
      const out = prevRef.current;
      if (!out) return;
      out.width = c.width; out.height = c.height;
      out.getContext('2d')!.drawImage(c, 0, 0);
    }, drag === null ? 0 : 90);
    return () => clearTimeout(t);
  }, [quad, aspect, cyl, drag]); // eslint-disable-line react-hooks/exhaustive-deps

  // تحويل دقيق من الشاشة لإحداثيات الصورة (الـSVG قد يُظهر الصورة بهوامش letterbox)
  const toImg = (e: React.PointerEvent): Pt => {
    const svg = svgRef.current!;
    const m = svg.getScreenCTM();
    if (!m) return quad[0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
  };
  const drawLoupe = (p: Pt) => {
    const l = loupeRef.current;
    if (!l) return;
    const ctx = l.getContext('2d')!;
    const S = 150, Z = 4, src = S / Z;
    ctx.clearRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, p.x - src / 2, p.y - src / 2, src, src, 0, 0, S, S);
    ctx.strokeStyle = '#ff2d55'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(S / 2, 0); ctx.lineTo(S / 2, S); ctx.moveTo(0, S / 2); ctx.lineTo(S, S / 2); ctx.stroke();
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag === null) return;
    const p = toImg(e);
    setQuad(q => q.map((x, i) => (i === drag ? p : x)) as Quad);
    drawLoupe(p);
  };

  const ai = async () => {
    setAiBusy(true); setMsg('');
    try {
      const { canvas: small, scale } = scaledCanvas(canvas, 1280);
      const d = await postJson(token, '/ai/corners', { image: canvasToBase64(small, 0.85), width: small.width, height: small.height, kind: cyl ? 'cylinder' : 'box', face });
      let q = d.corners.map(([x, y]: number[]) => ({ x: x / scale, y: y / scale })) as Quad;
      if (d.rotate) q = rotQuad(q, d.rotate / 90);
      setQuad(q);
      setMsg(`🤖 ثقة ${Math.round(d.confidence * 100)}٪${d.note ? ` — ${d.note}` : ''}. كبّر بالسحب ودقّق كل زاوية.`);
    } catch (e: any) { setMsg(e.message); } // eslint-disable-line @typescript-eslint/no-explicit-any
    finally { setAiBusy(false); }
  };

  const hr = Math.max(W, H) / 70; // نصف قطر المقبض بإحداثيات الصورة
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const topMid = mid(quad[0], quad[1]);
  return (
    <div className="modal-overlay st-sub" onClick={e => e.stopPropagation()}>
      <div className="modal st-qe" dir="rtl">
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{cyl ? 'تحديد جسم العبوة' : `تحديد زوايا ${face ? FACE_INFO[face].label : 'الوجه'}`}</h3>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="st-qe-tip">💡 {tip} اسحب كل نقطة إلى زاوية الوجه بالضبط — العدسة تكبّر أثناء السحب. السهم ▲ يشير إلى أعلى الناتج.</div>
        <div className="st-qe-body">
          <div className="st-qe-stage">
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="st-qe-svg"
              onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
              {bgUrl && <image href={bgUrl} x={0} y={0} width={W} height={H} />}
              <polygon points={quad.map(p => `${p.x},${p.y}`).join(' ')} fill="rgba(56,189,248,.14)" stroke="#38bdf8" strokeWidth={hr / 4} />
              <polygon points={`${topMid.x},${topMid.y - hr * 2.2} ${topMid.x - hr},${topMid.y - hr * 0.6} ${topMid.x + hr},${topMid.y - hr * 0.6}`} fill="#facc15" />
              {quad.map((p, i) => (
                <g key={i} onPointerDown={e => { e.preventDefault(); (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId); setDrag(i); drawLoupe(p); }} style={{ cursor: 'grab' }}>
                  <circle cx={p.x} cy={p.y} r={hr * 2.2} fill="transparent" />
                  <circle cx={p.x} cy={p.y} r={hr} fill={drag === i ? '#ff2d55' : '#fff'} stroke="#0f172a" strokeWidth={hr / 4} />
                  <text x={p.x} y={p.y + hr * 0.38} textAnchor="middle" fontSize={hr * 1.1} fontWeight={800} fill="#0f172a" pointerEvents="none">{i + 1}</text>
                </g>
              ))}
            </svg>
            <canvas ref={loupeRef} width={150} height={150} className={`st-loupe ${drag !== null ? 'on' : ''}`} />
          </div>
          <div className="st-qe-side">
            <div className="st-h">الناتج</div>
            <canvas ref={prevRef} className="st-qe-prev" />
            <div className="st-qe-tools">
              <button type="button" className="btn" onClick={ai} disabled={aiBusy}>{aiBusy ? '🤖 جاري التحليل…' : '🤖 تحديد تلقائي'}</button>
              <button type="button" className="btn" onClick={() => setQuad(q => rotQuad(q, -1))} title="تدوير الناتج عكس عقارب الساعة">↺</button>
              <button type="button" className="btn" onClick={() => setQuad(q => rotQuad(q, 1))} title="تدوير الناتج مع عقارب الساعة">↻</button>
              <button type="button" className="btn" onClick={() => setQuad(defaultQuad(W, H))}>⟲ إعادة</button>
            </div>
            {msg && <div className="st-hint">{msg}</div>}
          </div>
        </div>
        <div className="st-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onCancel}>إلغاء</button>
          <button type="button" className="btn btn-primary" onClick={() => onDone(quad)}>✓ اعتماد</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// محرّر القصّ: إزالة الخلفية (شخص تلقائياً، غرض بالنقر) + فرشاة مسح/إرجاع
// ════════════════════════════════════════════════════════════════════════════
export function SegEditor({ canvas, onDone, onCancel }: { canvas: HTMLCanvasElement; onDone: (c: HTMLCanvasElement) => void; onCancel: () => void }) {
  // العمل على نسخة ≤1600px (سرعة النموذج والفرشاة)
  const img = useMemo(() => scaledCanvas(canvas, 1600).canvas, [canvas]);
  const W = img.width, H = img.height;
  const [mode, setMode] = useState<'person' | 'point'>('person');
  const [pts, setPts] = useState<Pt[]>([]);
  const [mask, setMask] = useState<Mask | null>(null);
  const [tool, setTool] = useState<'pick' | 'erase' | 'restore'>('pick');
  const [brush, setBrush] = useState(28);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<HTMLCanvasElement | null>(null);
  const eraseRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const bgUrl = useCanvasUrl(img);
  const resUrl = useCanvasUrl(result, 'image/webp');
  const painting = useRef(false);

  useEffect(() => { eraseRef.current.width = W; eraseRef.current.height = H; }, [W, H]);

  const rebuild = (m: Mask | null = mask) => {
    if (!m) return;
    const copy = document.createElement('canvas');
    copy.width = W; copy.height = H;
    copy.getContext('2d')!.drawImage(img, 0, 0);
    try { setResult(applyMask(copy, m, eraseRef.current)); setErr(''); } catch (e: any) { setErr(e.message); } // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const run = async (m = mode, p = pts) => {
    setBusy(m === 'person' ? 'تحميل نموذج إزالة الخلفية وتحليل الصورة… (أول مرة قد تأخذ ثوانٍ)' : 'تحديد الغرض…'); setErr('');
    try {
      const mk = m === 'person' ? await segmentPerson(img) : await segmentAtPoints(img, p.map(q => ({ x: q.x / W, y: q.y / H })));
      setMask(mk); rebuild(mk);
    } catch (e: any) { setErr(e.message || 'تعذّر تحميل نموذج إزالة الخلفية'); } // eslint-disable-line @typescript-eslint/no-explicit-any
    finally { setBusy(''); }
  };
  // كشف تلقائي عند الفتح: نموذج الأشخاص أولاً؛ إن لم يجد شخصاً معقولاً (أقل من 4% أو كل الصورة)
  // فهي قطعة ملابس/غرض → يُقصّ الغرض الذي في وسط الصورة. المستخدم يضيف نقاطاً أو يصحّح بالفرشاة.
  const coverage = (m: Mask) => { let n = 0; for (let i = 0; i < m.a.length; i++) if (m.a[i] > 0.5) n++; return n / m.a.length; };
  const runCenter = () => { const c = [{ x: W / 2, y: H / 2 }]; setMode('point'); setTool('pick'); setPts(c); return run('point', c); };
  const autoDetect = async () => {
    setBusy('تحليل الصورة… (أول مرة يُحمَّل نموذج إزالة الخلفية وقد يأخذ ثوانٍ)'); setErr('');
    try {
      const pm = await segmentPerson(img);
      const cov = coverage(pm);
      if (cov > 0.04 && cov < 0.97) { setMode('person'); setMask(pm); rebuild(pm); setBusy(''); return; }
    } catch { /* نجرّب وضع الغرض */ }
    await runCenter();
  };
  useEffect(() => { autoDetect(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = (e: React.PointerEvent) => {
    const r = overlayRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const paint = (p: Pt) => {
    const color = tool === 'erase' ? 'rgba(255,0,0,1)' : 'rgba(0,255,0,1)';
    for (const c of [eraseRef.current, overlayRef.current!]) {
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = c === eraseRef.current ? color : (tool === 'erase' ? 'rgba(255,45,85,.45)' : 'rgba(34,197,94,.45)');
      ctx.beginPath(); ctx.arc(p.x, p.y, brush * (W / 1000), 0, Math.PI * 2); ctx.fill();
    }
  };
  const onDown = (e: React.PointerEvent) => {
    const p = pos(e);
    if (tool === 'pick') {
      if (mode !== 'point') return;
      const np = [...pts, p]; setPts(np); run('point', np);
      return;
    }
    painting.current = true;
    overlayRef.current!.setPointerCapture(e.pointerId);
    paint(p);
  };
  const onMove = (e: React.PointerEvent) => { if (painting.current) paint(pos(e)); };
  const onUp = () => { if (painting.current) { painting.current = false; rebuild(); } };
  const reset = () => {
    setPts([]); setMask(null); setResult(null);
    for (const c of [eraseRef.current, overlayRef.current]) c?.getContext('2d')!.clearRect(0, 0, W, H);
    autoDetect();
  };

  return (
    <div className="modal-overlay st-sub" onClick={e => e.stopPropagation()}>
      <div className="modal st-qe" dir="rtl">
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>قصّ الغرض من الخلفية</h3>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="st-seg-bar">
          <div className="s3d-seg" role="radiogroup">
            <button type="button" className={mode === 'person' ? 'is-on' : ''} onClick={() => { setMode('person'); setTool('pick'); setPts([]); run('person', []); }}>🧍 شخص / عارضة</button>
            <button type="button" className={mode === 'point' ? 'is-on' : ''} onClick={() => { setMask(null); setResult(null); runCenter(); }}>👕 ملابس / غرض</button>
          </div>
          <div className="s3d-seg">
            <button type="button" className={tool === 'pick' ? 'is-on' : ''} onClick={() => setTool('pick')} disabled={mode === 'person'}>👆 نقر</button>
            <button type="button" className={tool === 'erase' ? 'is-on' : ''} onClick={() => setTool('erase')} disabled={!mask}>🧽 مسح</button>
            <button type="button" className={tool === 'restore' ? 'is-on' : ''} onClick={() => setTool('restore')} disabled={!mask}>🖌️ إرجاع</button>
          </div>
          {tool !== 'pick' && <label className="st-field st-inline">الفرشاة<input type="range" min={6} max={80} value={brush} onChange={e => setBrush(Number(e.target.value))} /></label>}
          <button type="button" className="btn" onClick={reset}>⟲ من جديد</button>
        </div>
        <div className="st-qe-tip">
          {mode === 'person' ? '💡 الخلفية تُزال تلقائياً للأشخاص والعارضات بملابسهم. صحّح أي جزء بالمسح أو الإرجاع.'
            : '💡 قُصّ الغرض الذي في وسط الصورة تلقائياً. إن فاته جزء انقر عليه لإضافته (النقاط الخضراء)، وصحّح الحواف بالفرشاة.'}
        </div>
        <div className="st-qe-body">
          <div className="st-qe-stage">
            {/* غلاف بنسبة الصورة نفسها كي تنطبق طبقة الفرشاة عليها بكسلاً ببكسل */}
            <div className="st-seg-wrap" style={{ width: `min(100%, ${(66 * W) / H}vh)` }}>
              {bgUrl && <img src={bgUrl} alt="" className="st-seg-img" />}
              <canvas ref={overlayRef} width={W} height={H} className="st-seg-overlay" style={{ cursor: tool === 'pick' ? 'crosshair' : 'cell' }}
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
              {pts.map((p, i) => <span key={i} className="st-pt" style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }} />)}
            </div>
          </div>
          <div className="st-qe-side">
            <div className="st-h">الناتج</div>
            <div className="st-checker">{resUrl ? <img src={resUrl} alt="" /> : <span>{busy || 'بانتظار التحديد'}</span>}</div>
            {busy && <div className="st-hint">⏳ {busy}</div>}
            {err && <div className="st-err">{err}</div>}
          </div>
        </div>
        <div className="st-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onCancel}>إلغاء</button>
          <button type="button" className="btn btn-primary" onClick={() => result && onDone(result)} disabled={!result || !!busy}>✓ اعتماد</button>
        </div>
      </div>
    </div>
  );
}

export const STUDIO_CSS = `
.st-overlay { z-index: 1000; }
.st-modal { width: min(1100px, 97vw); max-width: 97vw; max-height: 95vh; display: flex; flex-direction: column; }
.st-kinds { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 18px; }
.st-kind { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 22px 12px; border-radius: 16px; cursor: pointer;
  border: 1px solid var(--c-border); background: var(--c-surface); font-family: inherit; text-align: center; transition: transform .15s, box-shadow .15s; }
.st-kind:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(15,30,53,.12); border-color: var(--c-accent); }
.st-kind-ic { font-size: 40px; }
.st-kind b { font-size: 15px; }
.st-kind small { color: var(--c-text-secondary); font-size: 12px; line-height: 1.6; }
.st-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 14px 18px; overflow: auto; }
.st-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.st-section { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--c-border); border-radius: 12px; background: var(--c-surface); }
.st-h { font-weight: 800; font-size: 13.5px; }
.st-h small { font-weight: 500; color: var(--c-text-secondary); }
.st-hint { font-size: 12px; color: var(--c-text-secondary); line-height: 1.6; }
.st-err { color: #dc2626; font-size: 12.5px; font-weight: 600; }
.st-busy { font-size: 12.5px; color: var(--c-accent); font-weight: 600; }
.st-dims { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
.st-dims label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; font-weight: 600; width: 82px; }
.st-slots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.st-slot { display: flex; flex-direction: column; align-items: center; gap: 4px; position: relative; }
.st-slot-img { width: 100%; aspect-ratio: 4/3; border-radius: 10px; border: 2px dashed var(--c-border); background: var(--c-bg); cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 24px; color: var(--c-text-secondary); overflow: hidden; padding: 4px; }
.st-slot.has .st-slot-img { border-style: solid; border-color: var(--c-accent); background: #0f172a; }
.st-slot-img img { max-width: 100%; max-height: 100%; object-fit: contain; }
.st-slot-label { font-size: 12px; font-weight: 700; }
.st-slot-acts { position: absolute; top: 4px; left: 4px; display: flex; gap: 3px; }
.st-slot-acts button { border: 0; border-radius: 6px; background: rgba(255,255,255,.9); cursor: pointer; font-size: 11px; padding: 2px 5px; }
.st-check { display: flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer; }
.st-field { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; font-weight: 600; }
.st-field small { font-weight: 500; color: var(--c-text-secondary); }
.st-inline { flex-direction: row; align-items: center; }
.st-preview-col { position: sticky; top: 0; }
.st-preview { position: relative; min-height: 380px; border-radius: 14px; overflow: hidden;
  background: radial-gradient(ellipse at 50% 0%, #3a4a8a 0%, transparent 60%), linear-gradient(180deg, #2b3670 0%, #1f2856 55%, #161d40 100%); }
.st-preview-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #c7d2fe; font-size: 14px; }
.st-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 18px; border-top: 1px solid var(--c-border-light, #eef2f7); }
.st-sub { z-index: 1010; }
.st-qe { width: min(1180px, 97vw); max-width: 97vw; max-height: 96vh; display: flex; flex-direction: column; }
.st-qe-tip { padding: 8px 18px 0; font-size: 12.5px; color: var(--c-text-secondary); line-height: 1.7; }
.st-qe-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 14px; padding: 12px 18px; overflow: auto; }
.st-qe-stage { position: relative; background: #0f172a; border-radius: 12px; overflow: hidden; display: flex; align-items: center; justify-content: center; min-height: 300px; }
.st-qe-svg { width: 100%; max-height: 66vh; display: block; touch-action: none; user-select: none; }
.st-loupe { position: absolute; top: 10px; left: 10px; width: 150px; height: 150px; border-radius: 50%; border: 3px solid #fff;
  box-shadow: 0 6px 20px rgba(0,0,0,.5); background: #000; opacity: 0; transition: opacity .15s; pointer-events: none; }
.st-loupe.on { opacity: 1; }
.st-qe-side { display: flex; flex-direction: column; gap: 10px; }
.st-qe-prev { width: 100%; height: auto; border-radius: 8px; background: #0f172a; box-shadow: inset 0 0 0 1px rgba(0,0,0,.08); }
.st-qe-tools { display: flex; flex-wrap: wrap; gap: 6px; }
.st-seg-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 18px 0; }
.st-seg-wrap { position: relative; margin: 0 auto; }
.st-seg-img { width: 100%; height: auto; display: block; }
.st-seg-overlay { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.st-pt { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #22c55e; border: 2px solid #fff; pointer-events: none; }
.st-checker { min-height: 220px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 12.5px; color: #64748b;
  background: repeating-conic-gradient(#e2e8f0 0% 25%, #fff 0% 50%) 50% / 18px 18px; }
.st-checker img { max-width: 100%; max-height: 60vh; object-fit: contain; }
.st-overlay .s3d-seg { display: flex; gap: 4px; background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 12px; padding: 4px; }
.st-overlay .s3d-seg button { border: 0; background: none; padding: 7px 10px; border-radius: 9px; cursor: pointer; font-family: inherit; font-weight: 700; font-size: 12.5px; color: var(--c-text-secondary); }
.st-overlay .s3d-seg button.is-on { background: var(--c-accent); color: #fff; }
.st-overlay .s3d-seg button:disabled { opacity: .4; cursor: default; }
@media (max-width: 760px) {
  .st-kinds, .st-body, .st-qe-body { grid-template-columns: 1fr; }
  .st-preview { min-height: 280px; }
  .st-preview-col { position: static; }
}
`;
