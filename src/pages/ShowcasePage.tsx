// ════════════════════════════════════════════════════════════════════════════
// ShowcasePage — «العرض ثلاثي الأبعاد»: معرض حرّ لأي صور (ايتمات، أشخاص، أماكن…)
// يُعرض بنفس دوّار المجسّمات في الرئيسية (Box3D + Coverflow من HomePage).
//
// كل عنصر: صورة أمامية + شكل (علبة بعمق، أو لوحة رقيقة للصور الشخصية والأماكن)
// + أوجه جانبية اختيارية للعلبة. التخزين لكل مستخدم: /api/showcase (ملفات بلا جدول).
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Box3D, Coverflow, shrinkImage } from './HomePage';

const API = import.meta.env.VITE_API_URL || '';

type Shape = 'box' | 'frame';
type Face = 'front' | 'left' | 'right' | 'top' | 'back' | 'bottom';
interface ShowItem {
  id: string; title: string; caption: string; shape: Shape; depth: number; scale: number;
  faces: Partial<Record<Face, string>>; at: number;
  /** دوران كامل 360° بدل التمايل — يُستحسن معه رفع الأوجه الستة */
  spin?: boolean;
}
/** عمق اللوحة الرقيقة نسبةً لارتفاعها — تبقى مجسّماً يتمايل لكن بلا «علبة» */
const FRAME_DEPTH = 0.035;
/** انحناء حواف العلبة (نسبة من أصغر بُعدَيها) — طيّ الكرتون الحقيقي ليس حادّاً */
const BOX_ROUND = 0.06;
const effDepth = (it: { shape: Shape; depth: number }) => (it.shape === 'frame' ? FRAME_DEPTH : it.depth);
const FACE_LABEL: Record<Face, string> = {
  front: 'الوجه الأمامي', left: 'الجانب الأيسر', right: 'الجانب الأيمن', top: 'السقف', back: 'الخلفي', bottom: 'القاعدة',
};
const SIDE_FACES: Face[] = ['left', 'right', 'top', 'back', 'bottom'];
/** أوجه Box3D غير الأمامية من مصادر العنصر */
const boxFaces = (src: (f: Face) => string | undefined) =>
  ({ left: src('left'), right: src('right'), top: src('top'), back: src('back'), bottom: src('bottom') });

/**
 * مجسّمات جاهزة تُعرض أولاً لكل من فُعّلت له الصفحة — أوجهها في public/showcase/<dir>/
 * مقصوصة ومصحَّحة المنظور يدوياً من صور العلبة (نفس اصطلاح أوجه Box3D في الرئيسية).
 * لا تُعدَّل ولا تُحذف من الصفحة؛ تُضاف/تُزال هنا في الكود.
 */
const presetBox = (dir: string, title: string, depth: number, faces: Face[], spin = false): ShowItem => ({
  id: `preset:${dir}`, title, caption: '', shape: 'box', depth, scale: 1, at: 0, spin,
  faces: Object.fromEntries(faces.map(f => [f, `/showcase/${dir}/${f}.jpg`])),
});
const PRESETS: ShowItem[] = [
  // عرض/ارتفاع ≈ 1.58 من الصور المستقيمة. العمق 0.40 من الارتفاع (0.48 المقاس من الصور بدا أعرض من الواقع
  // لأن الطرفين صُوّرا بقرب فتضخّما). الخلفي = الأمامي (نفس الطباعة)
  presetBox('potafast-50', 'Potafast 50 mg', 0.40, ['front', 'back', 'left', 'right', 'top', 'bottom'], true),
];
const isPreset = (it: ShowItem) => it.id.startsWith('preset:');

export default function ShowcasePage() {
  const { token } = useAuth();
  const H = { Authorization: `Bearer ${token}` };
  const [items, setItems] = useState<ShowItem[] | null>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<ShowItem | 'new' | null>(null);
  const [manage, setManage] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetch(`${API}/api/showcase`, { headers: H })
      .then(r => r.json())
      .then(j => { if (alive) { setItems(j.success ? j.data : []); if (!j.success) setErr(j.error || 'تعذّر التحميل'); } })
      .catch(() => { if (alive) { setItems([]); setErr('تعذّر التحميل'); } });
    return () => { alive = false; };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveOrder = (next: ShowItem[]) => {
    setItems(next);
    fetch(`${API}/api/showcase/order`, {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: next.map(x => x.id) }),
    }).catch(() => setErr('تعذّر حفظ الترتيب'));
  };
  const move = (i: number, d: number) => {
    if (!items) return;
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    saveOrder(next);
  };
  const remove = async (it: ShowItem) => {
    if (!window.confirm(`حذف «${it.title || 'هذه الصورة'}» من العرض؟`)) return;
    const j = await fetch(`${API}/api/showcase/${it.id}`, { method: 'DELETE', headers: H }).then(r => r.json()).catch(() => ({} as any));
    if (j.success) setItems(x => (x ?? []).filter(y => y.id !== it.id)); else setErr(j.error || 'تعذّر الحذف');
  };
  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  const own = items ?? [];
  const list = [...PRESETS, ...own];
  return (
    <div className="s3d" dir="rtl">
      <div className="s3d-bar">
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>➕ إضافة صورة</button>
        <button type="button" className={`btn ${manage ? 'btn-primary' : ''}`} onClick={() => setManage(v => !v)} disabled={!own.length}>
          🗂️ إدارة العناصر <small>({own.length})</small>
        </button>
        <button type="button" className="btn" onClick={fullscreen} disabled={!list.length}>⛶ ملء الشاشة</button>
        {err && <span className="s3d-err">{err}</span>}
      </div>

      <div className="s3d-stage" ref={stageRef}>
        <div className="s3d-stars" aria-hidden="true" />
        {items === null && !list.length ? <div className="s3d-empty">جاري التحميل…</div>
          : list.length === 0 ? (
            <div className="s3d-empty">
              <div style={{ fontSize: 46 }}>🧊</div>
              <div>أضف أي صورة — منتج، شخص، مكان — لتُعرض هنا كمجسّم ثلاثي الأبعاد.</div>
              <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>➕ إضافة أول صورة</button>
            </div>
          ) : (
            <Coverflow count={list.length} variant="item" paused={!!editing}
              render={(i) => {
                const it = list[i];
                return (
                  <div className="s3d-card">
                    <Box3D src={it.faces.front!} depth={effDepth(it)} scale={it.scale} spin={it.spin} round={it.shape === 'box' ? BOX_ROUND : 0}
                      faces={it.shape === 'box' ? boxFaces(f => it.faces[f]) : undefined}
                      label={it.title || 'صورة'} />
                    {(it.title || it.caption) && (
                      <div className="s3d-pill">
                        {it.title && <b>{it.title}</b>}
                        {it.caption && <small>{it.caption}</small>}
                      </div>
                    )}
                  </div>
                );
              }}
              onOpen={(i) => { if (!isPreset(list[i])) setEditing(list[i]); }} />
          )}
      </div>

      {manage && own.length > 0 && (
        <div className="s3d-manage">
          {own.map((it, i) => (
            <div key={it.id} className="s3d-row">
              <img src={it.faces.front} alt="" />
              <div className="s3d-row-text">
                <b>{it.title || '— بلا عنوان —'}</b>
                <small>{it.shape === 'box' ? '📦 علبة' : '🖼️ لوحة'}{it.caption ? ` · ${it.caption}` : ''}</small>
              </div>
              <button type="button" className="s3d-icon" onClick={() => move(i, -1)} disabled={i === 0} title="تقديم">▲</button>
              <button type="button" className="s3d-icon" onClick={() => move(i, 1)} disabled={i === own.length - 1} title="تأخير">▼</button>
              <button type="button" className="s3d-icon" onClick={() => setEditing(it)} title="تعديل">✏️</button>
              <button type="button" className="s3d-icon is-del" onClick={() => remove(it)} title="حذف">🗑️</button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Editor item={editing === 'new' ? null : editing} token={token}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setItems(x => {
              const arr = x ?? [];
              return arr.some(y => y.id === saved.id) ? arr.map(y => (y.id === saved.id ? saved : y)) : [...arr, saved];
            });
            setEditing(null);
          }}
          onDelete={editing === 'new' ? undefined : () => { const it = editing; setEditing(null); remove(it); }} />
      )}

      <style>{CSS}</style>
    </div>
  );
}

/** نافذة الإضافة/التعديل مع معاينة حيّة للمجسّم. الصور تُرفع عند الإضافة فقط؛ للتعديل: الحقول والشكل. */
function Editor({ item, token, onClose, onSaved, onDelete }: {
  item: ShowItem | null; token: string | null;
  onClose: () => void; onSaved: (it: ShowItem) => void; onDelete?: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [caption, setCaption] = useState(item?.caption ?? '');
  const [shape, setShape] = useState<Shape>(item?.shape ?? 'box');
  const [depth, setDepth] = useState(item?.depth ?? 0.33);
  const [scale, setScale] = useState(item?.scale ?? 1);
  const [spin, setSpin] = useState(item?.spin ?? false);
  const [files, setFiles] = useState<Partial<Record<Face, File>>>({});
  const [previews, setPreviews] = useState<Partial<Record<Face, string>>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // روابط معاينة محلية للصور المختارة — تُحرَّر عند التبديل والإغلاق
  useEffect(() => {
    const urls: Partial<Record<Face, string>> = {};
    for (const [k, f] of Object.entries(files) as [Face, File][]) urls[k] = URL.createObjectURL(f);
    setPreviews(urls);
    return () => { for (const u of Object.values(urls)) if (u) URL.revokeObjectURL(u); };
  }, [files]);

  const faceSrc = (f: Face) => previews[f] ?? item?.faces[f];
  const front = faceSrc('front');
  const pick = (f: Face, file: File | undefined) => setFiles(x => {
    const n = { ...x };
    if (file) n[f] = file; else delete n[f];
    return n;
  });

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const H = { Authorization: `Bearer ${token}` };
      let j: any;
      if (item) {
        j = await fetch(`${API}/api/showcase/${item.id}`, {
          method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, caption, shape, depth, scale, spin }),
        }).then(r => r.json());
      } else {
        if (!files.front) throw new Error('اختر الصورة الأمامية أولاً');
        const fd = new FormData();
        fd.append('title', title); fd.append('caption', caption); fd.append('shape', shape);
        fd.append('depth', String(depth)); fd.append('scale', String(scale)); fd.append('spin', String(spin));
        for (const [k, f] of Object.entries(files) as [Face, File][]) {
          if (shape === 'frame' && k !== 'front') continue;
          const blob = await shrinkImage(f);
          fd.append(k, blob, blob === f ? f.name : f.name.replace(/\.\w+$/, '') + '.jpg');
        }
        j = await fetch(`${API}/api/showcase`, { method: 'POST', headers: H, body: fd }).then(r => r.json());
      }
      if (!j?.success) throw new Error(j?.error || 'فشل الحفظ');
      onSaved(j.data);
    } catch (e: any) { setErr(e.message || 'فشل الحفظ'); }
    finally { setBusy(false); }
  };

  const facePicker = (f: Face) => (
    <label key={f} className={`s3d-face-pick ${faceSrc(f) ? 'has-img' : ''}`}>
      {faceSrc(f) ? <img src={faceSrc(f)} alt="" /> : <span>＋</span>}
      <small>{FACE_LABEL[f]}{f !== 'front' && ' (اختياري)'}</small>
      <input type="file" accept="image/*" hidden disabled={!!item}
        onChange={e => pick(f, e.target.files?.[0])} />
    </label>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal s3d-modal" onClick={e => e.stopPropagation()} dir="rtl">
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{item ? 'تعديل العنصر' : 'إضافة صورة للعرض'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="s3d-modal-body">
          <div className="s3d-preview">
            {front ? (
              <Box3D key={front} src={front} depth={effDepth({ shape, depth })} scale={scale} spin={spin} round={shape === 'box' ? BOX_ROUND : 0}
                faces={shape === 'box' ? boxFaces(faceSrc) : undefined}
                label={title || 'معاينة'} />
            ) : <div className="s3d-preview-empty">المعاينة تظهر بعد اختيار الصورة</div>}
          </div>

          <div className="s3d-form">
            <div className="s3d-seg" role="radiogroup">
              <button type="button" className={shape === 'box' ? 'is-on' : ''} onClick={() => setShape('box')}>📦 علبة / منتج</button>
              <button type="button" className={shape === 'frame' ? 'is-on' : ''} onClick={() => setShape('frame')}>🖼️ لوحة (شخص، مكان، أي صورة)</button>
            </div>

            <div className="s3d-faces">
              {facePicker('front')}
              {shape === 'box' && SIDE_FACES.map(facePicker)}
            </div>
            {item && <div className="s3d-hint">لتغيير الصور: احذف العنصر وأضفه من جديد.</div>}
            {shape === 'box' && !item && <div className="s3d-hint">بدون صور الجوانب تُلوَّن تلقائياً من حواف الصورة الأمامية.</div>}

            <label className="s3d-field">العنوان
              <input className="input" value={title} maxLength={80} onChange={e => setTitle(e.target.value)} placeholder="مثلاً: Amoklavin 1000 / د. أحمد / مكتب بغداد" />
            </label>
            <label className="s3d-field">وصف قصير (اختياري)
              <input className="input" value={caption} maxLength={120} onChange={e => setCaption(e.target.value)} />
            </label>
            {shape === 'box' && (
              <label className="s3d-field">عمق العلبة <small>{Math.round(depth * 100)}٪ من الارتفاع</small>
                <input type="range" min={0.05} max={1} step={0.01} value={depth} onChange={e => setDepth(Number(e.target.value))} />
              </label>
            )}
            <label className="s3d-field">الحجم داخل البطاقة <small>×{scale.toFixed(2)}</small>
              <input type="range" min={0.6} max={1.5} step={0.05} value={scale} onChange={e => setScale(Number(e.target.value))} />
            </label>
            <label className="s3d-check">
              <input type="checkbox" checked={spin} onChange={e => setSpin(e.target.checked)} />
              🔄 دوران كامل 360° <small>(الأفضل مع رفع الأوجه الستة)</small>
            </label>
            {err && <div className="s3d-err">{err}</div>}
          </div>
        </div>
        <div className="s3d-modal-foot">
          {onDelete && <button type="button" className="btn s3d-del" onClick={onDelete} disabled={busy}>🗑️ حذف</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>إلغاء</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || (!item && !files.front)}>
            {busy ? 'جاري الحفظ…' : 'حفظ'}
          </button>
        </div>
      </div>
    </div>
  );
}

// قواعد الدوّار والمجسّم منسوخة من الرئيسية تحت .s3d — HomePage لا تُركَّب إلا عند زيارتها،
// فلا يصحّ الاعتماد على أنماطها هنا. نافذة التعديل داخل .s3d أيضاً فتشملها المعاينة.
const CSS = `
.s3d { display: flex; flex-direction: column; gap: 12px; }
.s3d-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.s3d-bar small { opacity: .7; }
.s3d-err { color: #dc2626; font-size: 13px; font-weight: 600; }

.s3d-stage { position: relative; overflow: hidden; border-radius: 18px; min-height: 480px; padding: 40px 10px 18px;
  display: flex; flex-direction: column; justify-content: center;
  background: radial-gradient(ellipse at 50% 0%, #3a4a8a 0%, transparent 60%),
    linear-gradient(180deg, #2b3670 0%, #1f2856 55%, #161d40 100%); }
.s3d-stage:fullscreen { border-radius: 0; padding: 0 20px; }
.s3d-stage:fullscreen .cf-item { --w: min(720px, 80vw); --h: min(460px, 62vh); }
.s3d-stars { position: absolute; inset: 0; pointer-events: none; opacity: .75;
  background-image:
    radial-gradient(1.5px 1.5px at 12% 18%, #fff, transparent), radial-gradient(1px 1px at 28% 72%, #fff, transparent),
    radial-gradient(1.5px 1.5px at 44% 8%, #fff, transparent), radial-gradient(1px 1px at 63% 34%, #fff, transparent),
    radial-gradient(2px 2px at 81% 22%, #fff, transparent), radial-gradient(1px 1px at 92% 64%, #fff, transparent),
    radial-gradient(1.5px 1.5px at 6% 88%, #fff, transparent), radial-gradient(1px 1px at 54% 92%, #fff, transparent),
    radial-gradient(1px 1px at 72% 80%, #fff, transparent), radial-gradient(1.5px 1.5px at 35% 40%, #fff, transparent);
  animation: s3d-twinkle 6s ease-in-out infinite alternate; }
@keyframes s3d-twinkle { from { opacity: .45; } to { opacity: .9; } }
.s3d-empty { position: relative; color: #dbe4ff; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; font-size: 15px; }

.s3d .cf { position: relative; --w: min(480px, 84vw); --h: 280px; }
.s3d .cf-item { --w: min(520px, 80vw); --h: 300px; }
.s3d .cf-stage { position: relative; height: calc(var(--h) + 30px); perspective: 1000px; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
.s3d .cf-slot { position: absolute; top: 14px; left: calc(50% - var(--w) / 2); width: var(--w); height: var(--h);
  padding: 0; border: 0; background: none; cursor: pointer; font-family: inherit; text-align: right;
  transition: transform .6s cubic-bezier(.2,.8,.2,1), opacity .6s ease, filter .6s ease; }
.s3d .cf-slot:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; border-radius: 18px; }
.s3d .cf.is-dragging .cf-slot { transition: opacity .2s ease, filter .2s ease; }
.s3d .cf.is-dragging { cursor: grabbing; }
.s3d .cf.is-flinging .cf-slot { transition: transform .32s cubic-bezier(.25,.8,.3,1), opacity .3s ease, filter .3s ease; }
.s3d .cf-dots { display: flex; justify-content: center; gap: 6px; padding-top: 36px; }
.s3d .cf-dot { width: 7px; height: 7px; border-radius: 4px; border: 0; padding: 0; background: rgba(255,255,255,.3); cursor: pointer; transition: width .3s, background .3s; }
.s3d .cf-dot.is-on { width: 20px; background: #fff; }
@media (prefers-reduced-motion: reduce) { .s3d .cf-slot { transition: none; } }

.s3d-card { position: relative; height: 100%; }
.s3d-pill { position: absolute; left: 50%; bottom: -6px; transform: translateX(-50%); max-width: 92%;
  display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 5px 16px; border-radius: 999px;
  background: rgba(255,255,255,.88); color: #1e293b; box-shadow: 0 6px 18px rgba(0,0,0,.25); white-space: nowrap; }
.s3d-pill b { font-size: 14px; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.s3d-pill small { font-size: 11.5px; color: #475569; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

.s3d .b3d-scene, .s3d-preview .b3d-scene { position: absolute; inset: 0 0 34px 0; perspective: 900px; display: flex; align-items: center; justify-content: center; }
.s3d .b3d { position: relative; transform-style: preserve-3d; transform: rotateX(-10deg) rotateY(-26deg);
  animation: s3d-sway 9s ease-in-out infinite alternate; transition: transform .25s ease-out; }
.s3d .b3d.is-tilt { animation: none; }
@keyframes s3d-sway { 0% { transform: rotateX(-18deg) rotateY(-46deg); } 100% { transform: rotateX(-14deg) rotateY(46deg); } }
/* دوران spin يُدار بـJS في Box3D (كي يُسحب بالماوس) — لا animation ولا transition تعيق التحديث لكل إطار */
.s3d .b3d.is-spin { animation: none; transition: none; }
.s3d .b3d-scene.is-draggable { cursor: grab; touch-action: pan-y; }
.s3d .b3d-scene.is-draggable:active { cursor: grabbing; }
.s3d .b3d-face { position: absolute; top: 0; left: 0; backface-visibility: hidden; overflow: hidden; }
.s3d .b3d-face img { width: 100%; height: 100%; object-fit: fill; display: block; pointer-events: none; user-select: none; }
.s3d .b3d-light { position: absolute; inset: 0; pointer-events: none; }
.s3d .b3d-sheen { position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(115deg, rgba(255,255,255,.42) 0%, rgba(255,255,255,0) 40%, rgba(0,0,0,.03) 100%); }
.s3d .b3d-shadow { position: absolute; left: 50%; bottom: 8%; height: 26px; transform: translateX(-50%);
  background: radial-gradient(ellipse, rgba(0,0,0,.55), transparent 70%); filter: blur(7px); pointer-events: none;
  animation: s3d-shadow 5.5s ease-in-out infinite; }
.s3d .cf-slot:not(.is-active) .b3d { animation-play-state: paused; }
.s3d .b3d-bob { transform-style: preserve-3d; animation: s3d-bob 5.5s ease-in-out infinite; }
@keyframes s3d-bob { 0%, 100% { transform: translateY(6px); } 50% { transform: translateY(-12px); } }
@keyframes s3d-shadow { 0%, 100% { transform: translateX(-50%) scale(1); opacity: .9; } 50% { transform: translateX(-50%) scale(.72); opacity: .5; } }
.s3d .b3d-glow { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, rgba(96,165,250,.32), transparent 65%); filter: blur(12px); opacity: 0; transition: opacity .8s ease; }
.s3d .cf-slot.is-active .b3d-glow, .s3d-preview .b3d-glow { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .s3d .b3d, .s3d .b3d-bob, .s3d .b3d-shadow { animation: none; } }

.s3d-manage { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
.s3d-row { display: flex; align-items: center; gap: 8px; padding: 8px; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 12px; }
.s3d-row img { width: 54px; height: 42px; object-fit: cover; border-radius: 6px; flex-shrink: 0; }
.s3d-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.s3d-row-text b, .s3d-row-text small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.s3d-row-text small { color: var(--c-text-secondary); }
.s3d-icon { border: 1px solid var(--c-border); background: var(--c-bg); border-radius: 8px; width: 30px; height: 30px; cursor: pointer; font-size: 12px; flex-shrink: 0; }
.s3d-icon:disabled { opacity: .35; cursor: default; }
.s3d-icon.is-del:hover { background: #fee2e2; }

.s3d-modal { width: min(880px, 96vw); max-height: 94vh; display: flex; flex-direction: column; }
.s3d-modal-body { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 14px 18px; overflow: auto; }
.s3d-preview { position: relative; min-height: 320px; border-radius: 14px; overflow: hidden;
  background: linear-gradient(180deg, #2b3670 0%, #1f2856 55%, #161d40 100%); }
.s3d-preview-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #c7d2fe; font-size: 14px; }
.s3d-form { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.s3d-seg { display: flex; gap: 4px; background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 12px; padding: 4px; }
.s3d-seg button { flex: 1; border: 0; background: none; padding: 8px 6px; border-radius: 9px; cursor: pointer; font-family: inherit; font-weight: 700; font-size: 13px; color: var(--c-text-secondary); }
.s3d-seg button.is-on { background: var(--c-accent); color: #fff; }
.s3d-faces { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.s3d-check { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
.s3d-check small { font-weight: 500; color: var(--c-text-secondary); }
.s3d-face-pick { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; }
.s3d-face-pick > span, .s3d-face-pick > img { width: 100%; aspect-ratio: 1; border-radius: 10px; border: 2px dashed var(--c-border);
  display: flex; align-items: center; justify-content: center; font-size: 22px; color: var(--c-text-secondary); object-fit: cover; }
.s3d-face-pick.has-img > img { border-style: solid; border-color: var(--c-accent); }
.s3d-face-pick small { font-size: 11px; text-align: center; color: var(--c-text-secondary); }
.s3d-hint { font-size: 12px; color: var(--c-text-secondary); }
.s3d-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
.s3d-field small { font-weight: 500; color: var(--c-text-secondary); }
.s3d-modal-foot { display: flex; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--c-border-light, #eef2f7); }
.s3d-del { color: #dc2626; }
@media (max-width: 760px) {
  .s3d-stage { min-height: 400px; padding-top: 24px; }
  .s3d .cf-item { --w: 78vw; --h: 230px; }
  .s3d-modal-body { grid-template-columns: 1fr; }
  .s3d-preview { min-height: 240px; }
}
`;
