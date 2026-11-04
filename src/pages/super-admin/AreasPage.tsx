import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Modal, Spinner, UI, btnStyle } from './OfficesPage';

interface Area { id: number; name: string; provinceId: number | null; provinceConflict?: string | null; subProvinceId: number | null; userId: number | null; user?: { username: string } | null; needsReview?: boolean; }
interface Province { id: number; name: string; sortOrder?: number; }
interface SubProvince { id: number; name: string; provinceId: number; sortOrder?: number; }
interface MergeSuggestion { a: { id: number; name: string; sales: number }; b: { id: number; name: string; sales: number } }
interface ReviewQueueItem extends Area { suggestions: { id: number; name: string; score: number }[] }
interface PharmacyVisitDetail { repName: string | null; pharmacyName: string; visitDate: string }
interface DeleteInfo { id: number; name: string; usage: Record<string, number>; total: number; blocking: boolean; pharmacyVisitDetails: PharmacyVisitDetail[] }
interface UndoMove { label: string; items: { id: number; provinceId: number | null; subProvinceId: number | null }[] }

type Sel = 'all' | 'none' | number;
type SubTab = 'all' | 'direct' | number;
type Flag = 'conflict' | 'legacy' | null;
type Section = { key: string; title: string | null; onOpen?: () => void; areas: Area[] };

// توست خفيف — نفس النمط المستخدم في UsersPage.tsx، معزول هنا لأن هذه صفحة مستقلة.
function showToast(msg: string, color: string = '#16a34a') {
  // إجراءات متتالية (المراجعة بالكيبورد مثلاً): الجديد يحلّ محل السابق بدل التراكم فوقه.
  document.getElementById('ar-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'ar-toast';
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', top: '24px', left: '50%', transform: 'translateX(-50%)',
    background: color, color: '#fff', padding: '10px 22px', borderRadius: '10px',
    fontSize: '14px', fontWeight: '700', zIndex: '99999', direction: 'rtl',
    boxShadow: '0 4px 20px rgba(0,0,0,0.25)', opacity: '0', transition: 'opacity .15s',
  } as CSSStyleDeclaration);
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, 1800);
}

const USAGE_LABELS: Record<string, string> = {
  sales: 'مبيعات', plans: 'خطط شهرية', doctors: 'أطباء', pharmacies: 'صيدليات',
  pharmacyVisits: 'زيارات صيدليات', sciReps: 'مناديب علميون', reps: 'مناديب',
  assignments: 'مستخدمون معيّنون', surveyDoctors: 'سجلات سيرفي',
};

// البحث يتجاهل الهمزات والتاء المربوطة و«ال» — فـ«كراده» تجد «الكرادة».
const normAr = (s: string): string =>
  s.trim().toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ـً-ٟ]/g, '')
    .replace(/(^|\s)ال/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

const arCollator = new Intl.Collator('ar');

// كلمات لا تميّز مكاناً عن آخر، فلا يُعدّ اشتراكها تشابهاً في «أسماء قريبة».
const GENERIC_WORDS = new Set(['حي', 'منطقه', 'قرب', 'شارع', 'سوق', 'مدينه', 'قضاء', 'ناحيه', 'محله']);
const nameWords = (key: string) => key.split(' ').filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));

// مناطق بغداد قد تحمل قسماً من محافظة سابقة (صفوف نُقلت قبل تصفير القسم) — تُعامل «بلا قسم».
const effectiveSubId = (a: Area, subById: Map<number, SubProvince>): number | null => {
  if (a.subProvinceId == null) return null;
  const s = subById.get(a.subProvinceId);
  return s && s.provinceId === a.provinceId ? s.id : null;
};

const CSS = `
.ar-busy { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 2000; overflow: hidden; background: #e0e7ff; }
.ar-busy::after { content: ''; position: absolute; inset: 0; width: 35%; background: #4f46e5; animation: ar-slide 1s ease-in-out infinite; }
@keyframes ar-slide { from { transform: translateX(300%); } to { transform: translateX(-120%); } }
@keyframes ar-fade { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
@keyframes ar-pulse { 0% { box-shadow: 0 0 0 0 rgba(79,70,229,.55); } 100% { box-shadow: 0 0 0 12px rgba(79,70,229,0); } }
@keyframes ar-flash { 0%, 55% { background: #dcfce7; border-color: #22c55e; } 100% { background: #fff; border-color: #e2e8f0; } }
@keyframes ar-drawer { from { transform: translateX(-100%); } to { transform: none; } }
@keyframes ar-pop { from { opacity: 0; transform: scale(.97) translateY(6px); } to { opacity: 1; transform: none; } }

.ar-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
.ar-search { position: relative; flex: 1; min-width: 240px; }
.ar-search input { width: 100%; box-sizing: border-box; height: 44px; padding: 0 42px; border-radius: 12px; border: 1.5px solid #e2e8f0; background: #f8fafc; font-size: 14px; direction: rtl; outline: none; color: #1e293b; transition: border-color .15s, background .15s, box-shadow .15s; }
.ar-search input:focus { border-color: #818cf8; background: #fff; box-shadow: 0 0 0 3px rgba(99,102,241,.13); }
.ar-search-ico { position: absolute; top: 50%; right: 14px; transform: translateY(-50%); font-size: 14px; opacity: .55; pointer-events: none; }
.ar-search-x { position: absolute; top: 50%; left: 10px; transform: translateY(-50%); width: 26px; height: 26px; border-radius: 50%; border: none; background: #e2e8f0; color: #475569; cursor: pointer; font-size: 11px; }

.ar-pills { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.ar-pill { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 999px; border: 1px solid; font-size: 12.5px; font-weight: 600; cursor: pointer; transition: transform .12s, box-shadow .12s; white-space: nowrap; }
.ar-pill:hover { transform: translateY(-1px); box-shadow: 0 3px 9px rgba(15,23,42,.1); }
.ar-pill b { font-size: 13.5px; }

.ar-layout { display: grid; grid-template-columns: 252px minmax(0, 1fr); gap: 20px; align-items: start; }
.ar-rail { position: sticky; top: 4px; max-height: calc(100vh - 150px); overflow-y: auto; scrollbar-width: thin; padding: 2px; }
.ar-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.ar-tile { display: flex; align-items: center; justify-content: space-between; gap: 6px; height: 36px; min-width: 0; padding: 0 9px; border-radius: 9px; border: 1px solid transparent; font-size: 12.5px; font-weight: 600; color: #1e293b; cursor: pointer; transition: transform .12s, box-shadow .12s, opacity .15s; }
.ar-tile > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-tile:hover { transform: translateY(-1px); box-shadow: 0 3px 9px rgba(15,23,42,.12); }
.ar-tile-n { flex-shrink: 0; font-size: 11px; font-weight: 700; opacity: .72; }
.ar-tile-wide { grid-column: 1 / -1; }
.ar-tile.is-active { background: #4f46e5 !important; border-color: #4f46e5 !important; color: #fff !important; box-shadow: 0 4px 12px rgba(79,70,229,.3); }
.ar-tile.is-active .ar-tile-n { opacity: 1; }
.ar-tile.is-dim { opacity: .38; }
.ar-tile.is-drop { outline: 2px dashed #4f46e5; outline-offset: 1px; transform: scale(1.05); }
.ar-tile.is-pulse { animation: ar-pulse .9s ease-out; }
.ar-rail-hint { margin-top: 10px; font-size: 11px; line-height: 1.6; color: #94a3b8; padding: 0 2px; }

.ar-panel { min-width: 0; animation: ar-fade .18s ease-out; }
.ar-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; min-height: 30px; }
.ar-link { background: none; border: none; color: #4f46e5; cursor: pointer; font-size: 12px; font-weight: 600; padding: 4px 6px; border-radius: 6px; }
.ar-link:hover { background: #eef2ff; }

.ar-tabs { display: inline-flex; gap: 2px; padding: 3px; background: #f1f5f9; border-radius: 10px; margin-bottom: 12px; max-width: 100%; overflow-x: auto; }
.ar-tab { height: 30px; padding: 0 12px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: #475569; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: background .12s, color .12s; }
.ar-tab:hover { color: #1e293b; }
.ar-tab small { font-size: 11px; opacity: .7; margin-inline-start: 4px; }
.ar-tab.is-active { background: #fff; color: #4338ca; box-shadow: 0 1px 3px rgba(15,23,42,.13); }
.ar-tab.is-drop { outline: 2px dashed #4f46e5; background: #eef2ff; }

.ar-section + .ar-section { margin-top: 18px; }
.ar-sec { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12.5px; font-weight: 700; color: #475569; }
.ar-sec button { background: none; border: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.ar-sec button:hover { color: #4f46e5; }
.ar-sec small { font-size: 11px; font-weight: 600; color: #94a3b8; }
.ar-sec i { flex: 1; height: 1px; background: #eef1f6; }

.ar-chips { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 7px; }
.ar-chip { position: relative; min-width: 0; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; transition: border-color .12s, box-shadow .12s, transform .12s, background .12s; }
.ar-chip:hover { border-color: #a5b4fc; box-shadow: 0 3px 10px rgba(79,70,229,.12); transform: translateY(-1px); }
.ar-chip[draggable="true"] { cursor: grab; }
.ar-chip.is-checked { background: #eef2ff; border-color: #818cf8; }
.ar-chip.is-flash { animation: ar-flash 1.8s ease-out; }
.ar-chip-main { display: block; width: 100%; min-height: 38px; padding: 7px 10px; padding-inline-end: 28px; background: none; border: none; text-align: start; cursor: inherit; color: #1e293b; font-size: 13px; font-weight: 500; direction: rtl; }
.ar-chip-line { display: flex; align-items: center; gap: 5px; min-width: 0; }
.ar-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ar-dot { flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; }
.ar-chip-owner { display: block; margin-top: 2px; font-size: 10.5px; color: #6366f1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-check { position: absolute; top: 9px; inset-inline-end: 8px; width: 18px; height: 18px; padding: 0; border-radius: 5px; border: 1.5px solid #cbd5e1; background: #fff; color: #fff; font-size: 11px; line-height: 1; cursor: pointer; opacity: 0; transition: opacity .12s; }
.ar-chip:hover .ar-check, .ar-check:focus-visible, .ar-chips.has-selection .ar-check { opacity: 1; }
.ar-check.is-on { background: #4f46e5; border-color: #4f46e5; opacity: 1; }

.ar-add { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; margin-bottom: 14px; border: 1.5px dashed #86efac; border-radius: 11px; background: #f0fdf4; font-size: 13px; color: #166534; }
.ar-select { height: 32px; padding: 0 8px; border-radius: 8px; border: 1px solid #cbd5e1; background: #fff; font-size: 12.5px; direction: rtl; color: #1e293b; max-width: 190px; }
.ar-empty { padding: 34px 16px; text-align: center; font-size: 13px; color: #94a3b8; border: 1.5px dashed #e2e8f0; border-radius: 12px; }

.ar-dock { position: sticky; bottom: 10px; z-index: 6; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; padding: 9px 14px; border-radius: 12px; background: #1e293b; color: #f1f5f9; font-size: 12.5px; font-weight: 600; box-shadow: 0 10px 26px rgba(15,23,42,.28); animation: ar-pop .16s ease-out; }
.ar-dock button.ar-dock-btn { background: rgba(255,255,255,.12); border: none; color: #fff; height: 28px; padding: 0 11px; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; }
.ar-dock button.ar-dock-btn:hover { background: rgba(255,255,255,.22); }

.ar-menu-wrap { position: relative; }
.ar-menu { position: absolute; top: calc(100% + 6px); inset-inline-end: 0; z-index: 30; width: 300px; padding: 6px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 14px 34px rgba(15,23,42,.17); animation: ar-pop .14s ease-out; }
.ar-menu button { display: flex; gap: 10px; width: 100%; padding: 8px 10px; background: none; border: none; border-radius: 8px; cursor: pointer; text-align: start; }
.ar-menu button:hover:not(:disabled) { background: #f1f5f9; }
.ar-menu button:disabled { opacity: .5; cursor: default; }
.ar-menu b { display: block; font-size: 13px; color: #1e293b; font-weight: 600; }
.ar-menu small { display: block; font-size: 11px; color: #64748b; margin-top: 1px; }

.ar-scrim { position: fixed; inset: 0; z-index: 900; background: rgba(15,23,42,.22); }
.ar-drawer { position: fixed; top: 0; bottom: 0; left: 0; z-index: 901; width: min(390px, 100vw); box-sizing: border-box; overflow-y: auto; background: #fff; direction: rtl; box-shadow: 8px 0 34px rgba(15,23,42,.2); animation: ar-drawer .2s ease-out; }
.ar-dr-head { position: sticky; top: 0; z-index: 2; padding: 16px 18px 12px; background: #fff; border-bottom: 1px solid #eef1f6; }
.ar-dr-sec { padding: 14px 18px; border-bottom: 1px solid #f1f5f9; }
.ar-dr-title { margin-bottom: 8px; font-size: 12px; font-weight: 700; color: #64748b; }
.ar-grid-pick { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
.ar-pick { height: 30px; padding: 0 5px; border-radius: 8px; border: 1px solid #e2e8f0; background: #fff; color: #334155; font-size: 11.5px; font-weight: 600; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: border-color .12s, background .12s; }
.ar-pick:hover:not(:disabled) { border-color: #818cf8; background: #eef2ff; }
.ar-pick.is-on { background: #4f46e5; border-color: #4f46e5; color: #fff; }
.ar-pick:disabled { cursor: default; }
.ar-input { width: 100%; box-sizing: border-box; height: 36px; padding: 0 11px; border-radius: 9px; border: 1px solid #cbd5e1; font-size: 13px; direction: rtl; outline: none; }
.ar-input:focus { border-color: #818cf8; box-shadow: 0 0 0 3px rgba(99,102,241,.13); }
.ar-result { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 7px 10px; background: none; border: none; border-radius: 8px; cursor: pointer; font-size: 12.5px; color: #1e293b; text-align: start; }
.ar-result:hover:not(:disabled) { background: #fef3c7; }
.ar-result small { flex-shrink: 0; font-size: 11px; color: #94a3b8; }
.ar-option { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 8px 10px; margin-top: 6px; background: #fff; border: 1px solid #fecaca; border-radius: 9px; cursor: pointer; text-align: start; }
.ar-option:hover:not(:disabled) { background: #fff7f7; border-color: #f87171; }
.ar-option b { display: block; font-size: 12.5px; color: #1e293b; font-weight: 700; }
.ar-option small { display: block; font-size: 11px; line-height: 1.5; color: #64748b; margin-top: 1px; }

.ar-deck-wrap { position: fixed; inset: 0; z-index: 950; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(15,23,42,.5); }
.ar-deck { width: 100%; max-width: 520px; max-height: 92vh; box-sizing: border-box; overflow-y: auto; background: #fff; border-radius: 18px; direction: rtl; box-shadow: 0 24px 60px rgba(15,23,42,.3); animation: ar-pop .18s ease-out; }
.ar-progress { height: 5px; background: #eef2ff; overflow: hidden; }
.ar-progress div { height: 100%; background: #4f46e5; transition: width .25s ease; }
.ar-sug { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; margin-bottom: 6px; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; cursor: pointer; text-align: start; font-size: 13.5px; font-weight: 600; color: #1e293b; transition: border-color .12s, background .12s; }
.ar-sug:hover:not(:disabled) { border-color: #2dd4bf; background: #f0fdfa; }
.ar-sug kbd, .ar-kbd { display: inline-block; min-width: 16px; padding: 0 5px; border: 1px solid #cbd5e1; border-bottom-width: 2px; border-radius: 5px; background: #f8fafc; font-family: inherit; font-size: 10.5px; line-height: 17px; text-align: center; color: #64748b; }
.ar-bar { width: 58px; height: 5px; border-radius: 3px; background: #e2e8f0; overflow: hidden; flex-shrink: 0; }
.ar-bar div { height: 100%; background: #14b8a6; }

@media (max-width: 767px) {
  .ar-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .ar-rail { position: static; max-height: none; overflow-x: auto; }
  .ar-tiles { display: flex; }
  .ar-tile { flex-shrink: 0; }
  .ar-tile-wide { grid-column: auto; }
  .ar-rail-hint { display: none; }
  .ar-chips { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
}
@media (hover: none) { .ar-check { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .ar-panel, .ar-dock, .ar-menu, .ar-drawer, .ar-deck, .ar-tile.is-pulse, .ar-chip.is-flash { animation: none; }
}
`;

// خيارات «نقل إلى…» نفسها في شريط التحديد ومراجعة المناطق. القيمة: '__none' | 'p' | 'p:s'
function ProvinceOptions({ provinces, subProvinces }: { provinces: Province[]; subProvinces: SubProvince[] }) {
  return (
    <>
      {provinces.map(p => {
        const subs = subProvinces.filter(s => s.provinceId === p.id);
        if (subs.length === 0) return <option key={p.id} value={p.id}>{p.name}</option>;
        return (
          <optgroup key={p.id} label={p.name}>
            <option value={p.id}>{p.name} (بلا قسم)</option>
            {subs.map(s => <option key={s.id} value={`${p.id}:${s.id}`}>{p.name} - {s.name}</option>)}
          </optgroup>
        );
      })}
      <option value="__none">بلا محافظة</option>
    </>
  );
}

const parseTarget = (val: string): { provinceId: number | null; subProvinceId: number | null } => {
  if (val === '__none') return { provinceId: null, subProvinceId: null };
  const [p, s] = val.split(':').map(Number);
  return { provinceId: p, subProvinceId: s ?? null };
};

// ── بطاقة منطقة ───────────────────────────────────────────────────────────
interface AreaChipProps {
  a: Area; checked: boolean; flash: boolean;
  onActivate: (id: number) => void;
  onToggle: (id: number) => void;
  onDragStart: (e: DragEvent, id: number) => void;
  onDragEnd: () => void;
}
const AreaChip = memo(function AreaChip({ a, checked, flash, onActivate, onToggle, onDragStart, onDragEnd }: AreaChipProps) {
  return (
    <div className={`ar-chip${checked ? ' is-checked' : ''}${flash ? ' is-flash' : ''}`} data-area-id={a.id}
      draggable onDragStart={e => onDragStart(e, a.id)} onDragEnd={onDragEnd}>
      <button className="ar-chip-main" onClick={() => onActivate(a.id)} title={a.name}>
        <span className="ar-chip-line">
          <span className="ar-chip-name">{a.name}</span>
          {a.provinceConflict && <span className="ar-dot" style={{ background: '#ef4444' }} title={`تعارض محافظة: ${a.provinceConflict}`} />}
          {a.needsReview && <span className="ar-dot" style={{ background: '#3b82f6' }} title="بانتظار المراجعة" />}
        </span>
        {a.userId != null && <span className="ar-chip-owner">👤 {a.user?.username ?? `#${a.userId}`}</span>}
      </button>
      <button className={`ar-check${checked ? ' is-on' : ''}`} aria-pressed={checked} aria-label={`تحديد ${a.name}`} title="تحديد" onClick={() => onToggle(a.id)}>{checked ? '✓' : ''}</button>
    </div>
  );
});

// ── اللوحة الجانبية: كل إجراءات منطقة واحدة في مكان واحد ───────────────────
interface AreaDrawerProps {
  area: Area; areas: Area[]; provinces: Province[]; subProvinces: SubProvince[]; busy: boolean; inQueue: boolean;
  onClose: () => void;
  onRename: (id: number, name: string) => Promise<boolean>;
  onMove: (ids: number[], provinceId: number | null, subProvinceId: number | null) => void;
  onSub: (id: number, subProvinceId: number | null) => void;
  onPin: (a: Area) => void;
  onSplit: (a: Area, name: string) => Promise<boolean>;
  onMerge: (fromId: number, toId: number, fromName: string, toName: string) => void;
  onDelete: (id: number, name: string) => void;
  onConfirmReview: (id: number, name: string) => void;
}
function AreaDrawer({ area: a, areas, provinces, subProvinces, busy, inQueue, onClose, onRename, onMove, onSub, onPin, onSplit, onMerge, onDelete, onConfirmReview }: AreaDrawerProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(a.name);
  const [splitName, setSplitName] = useState<string | null>(null);
  const [mergeQuery, setMergeQuery] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editing && splitName === null) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, splitName, onClose]);

  const provinceName = (id: number | null) => provinces.find(p => p.id === id)?.name ?? null;
  const subs = a.provinceId != null ? subProvinces.filter(s => s.provinceId === a.provinceId) : [];
  const curSub = subs.find(s => s.id === a.subProvinceId) ?? null;
  const currentProvinceName = provinceName(a.provinceId) ?? '؟';
  const conflictProvince = provinces.find(p => p.name === a.provinceConflict);

  const mergeResults = useMemo(() => {
    const q = normAr(mergeQuery);
    const others = areas.filter(x => x.id !== a.id);
    if (q) {
      const hits = others.map(x => ({ x, key: normAr(x.name) })).filter(r => r.key.includes(q));
      hits.sort((m, n) => Number(n.key.startsWith(q)) - Number(m.key.startsWith(q)));
      return hits.slice(0, 8).map(r => r.x);
    }
    // بلا كتابة: أسماء تشترك معها بكلمة مميّزة، مع إظهار محافظتها — «العامرية» و«عامرية الفلوجة» مكانان مختلفان رغم الكلمة المشتركة.
    const words = new Set(nameWords(normAr(a.name)));
    if (words.size === 0) return [];
    return others.filter(x => nameWords(normAr(x.name)).some(w => words.has(w))).slice(0, 5);
  }, [areas, a.id, a.name, mergeQuery]);

  const saveName = async () => {
    const name = editName.trim();
    if (!name) return;
    if (name === a.name || await onRename(a.id, name)) setEditing(false);
  };
  const saveSplit = async () => {
    if (splitName?.trim() && await onSplit(a, splitName.trim())) setSplitName(null);
  };

  return (
    <>
      <div className="ar-scrim" onClick={onClose} />
      <aside className="ar-drawer" role="dialog" aria-label={`إجراءات منطقة ${a.name}`}>
        <div className="ar-dr-head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            {editing ? (
              <input className="ar-input" autoFocus disabled={busy} value={editName} onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setEditing(false); setEditName(a.name); } }} />
            ) : (
              <h3 style={{ flex: 1, margin: 0, fontSize: 17, fontWeight: 700, color: UI.ink, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{a.name}</h3>
            )}
            {editing ? (
              <button onClick={saveName} disabled={busy || !editName.trim()} style={{ ...btnStyle('#16a34a', true), height: 36 }}>حفظ</button>
            ) : (
              <button onClick={() => { setEditName(a.name); setEditing(true); }} disabled={busy} title="تعديل الاسم" style={{ ...btnStyle('#2563eb', true), padding: '5px 9px' }}>✏️</button>
            )}
            <button onClick={onClose} title="إغلاق" style={{ ...btnStyle('#64748b', true), padding: '5px 10px' }}>✕</button>
          </div>
          <div style={{ marginTop: 5, fontSize: 12, color: UI.muted }}>
            {provinceName(a.provinceId) ?? 'بلا محافظة'}{curSub ? ` ‹ ${curSub.name}` : ''}
          </div>
          {a.userId != null && (
            <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: '#3730a3', background: '#eef2ff', borderRadius: 7, padding: '5px 9px' }}>
              👤 صف قديم مرتبط بحساب {a.user?.username ?? `#${a.userId}`} — يمكن دمجه مع أي منطقة بنفس الاسم عبر «دمج المكررات».
            </div>
          )}
        </div>

        {inQueue && (
          <div className="ar-dr-sec" style={{ background: '#eff6ff' }}>
            <div style={{ fontSize: 12, color: '#1e40af', marginBottom: 8 }}>🕓 أُنشئت تلقائياً وما زالت بانتظار المراجعة.</div>
            <button onClick={() => onConfirmReview(a.id, a.name)} disabled={busy} style={btnStyle('#16a34a', true)}>✅ تأكيد كمنطقة جديدة</button>
          </div>
        )}

        {/* حسم تعارض المحافظة — يظهر فقط إن كانت على المنطقة بشارة تعارض */}
        {a.provinceConflict && (
          <div className="ar-dr-sec" style={{ background: '#fef2f2' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#991b1b' }}>
              ⚠️ ورد هذا الاسم في ملف بمحافظة «{a.provinceConflict}» والمحفوظة «{currentProvinceName}»
            </div>
            <button className="ar-option" disabled={busy} onClick={() => onPin(a)}>
              <span>📌</span><span><b>تثبيت في {currentProvinceName}</b><small>تجاهل التعارض وإبقاؤها كما هي بلا نقل بيانات.</small></span>
            </button>
            {conflictProvince && (
              <button className="ar-option" disabled={busy} onClick={() => onMove([a.id], conflictProvince.id, null)}>
                <span>↔️</span><span><b>نقل إلى {a.provinceConflict}</b><small>إن كان الاسم مكاناً واحداً ومحافظته المحفوظة خطأ — تتحرك كل بياناتها.</small></span>
              </button>
            )}
            {splitName === null ? (
              <button className="ar-option" disabled={busy} onClick={() => setSplitName(`${a.name} - ${a.provinceConflict}`)}>
                <span>✂️</span><span><b>فصل مكانَين اندمجا</b><small>مثل «العامرية» بغداد و«عامرية الفلوجة» — منطقة جديدة تأخذ الصفوف المؤكَّدة من المحافظة الأخرى فقط.</small></span>
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input className="ar-input" autoFocus disabled={busy} value={splitName} onChange={e => setSplitName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveSplit(); if (e.key === 'Escape') setSplitName(null); }}
                  placeholder={`اسم منطقة "${a.provinceConflict}"...`} />
                <button onClick={saveSplit} disabled={busy || !splitName.trim()} style={btnStyle('#b91c1c', true)}>فصل</button>
                <button onClick={() => setSplitName(null)} disabled={busy} style={btnStyle('#94a3b8', true)}>✕</button>
              </div>
            )}
          </div>
        )}

        <div className="ar-dr-sec">
          <div className="ar-dr-title">المحافظة — اضغط للنقل</div>
          <div className="ar-grid-pick">
            {provinces.map(p => (
              <button key={p.id} className={`ar-pick${p.id === a.provinceId ? ' is-on' : ''}`} title={p.name} disabled={busy}
                onClick={() => { if (p.id !== a.provinceId) onMove([a.id], p.id, null); }}>{p.name}</button>
            ))}
            <button className={`ar-pick${a.provinceId == null ? ' is-on' : ''}`} disabled={busy}
              onClick={() => { if (a.provinceId != null) onMove([a.id], null, null); }}>بلا محافظة</button>
          </div>
          {subs.length > 0 && (
            <>
              <div className="ar-dr-title" style={{ marginTop: 12 }}>القسم داخل {provinceName(a.provinceId)}</div>
              <div className="ar-grid-pick">
                {subs.map(s => (
                  <button key={s.id} className={`ar-pick${curSub?.id === s.id ? ' is-on' : ''}`} disabled={busy}
                    onClick={() => { if (curSub?.id !== s.id) onSub(a.id, s.id); }}>{s.name}</button>
                ))}
                <button className={`ar-pick${!curSub ? ' is-on' : ''}`} disabled={busy}
                  onClick={() => { if (curSub) onSub(a.id, null); }}>بلا قسم</button>
              </div>
            </>
          )}
        </div>

        <div className="ar-dr-sec">
          <div className="ar-dr-title">🔀 دمجها داخل منطقة أخرى</div>
          <input className="ar-input" disabled={busy} value={mergeQuery} onChange={e => setMergeQuery(e.target.value)} placeholder="اكتب اسم المنطقة..." />
          {!mergeQuery.trim() && mergeResults.length > 0 && <div style={{ margin: '9px 2px 2px', fontSize: 11, color: UI.faint }}>أسماء قريبة:</div>}
          {mergeQuery.trim() && mergeResults.length === 0 && <div style={{ padding: '9px 2px 0', fontSize: 12, color: UI.faint }}>لا توجد نتائج</div>}
          <div style={{ marginTop: 4 }}>
            {mergeResults.map(x => (
              <button key={x.id} className="ar-result" disabled={busy} onClick={() => onMerge(a.id, x.id, a.name, x.name)}>
                <span>{x.name}</span><small>{provinceName(x.provinceId) ?? 'بلا محافظة'}</small>
              </button>
            ))}
          </div>
        </div>

        <div style={{ padding: '14px 18px 22px' }}>
          <button onClick={() => onDelete(a.id, a.name)} disabled={busy} style={{ ...btnStyle('#dc2626', true), width: '100%' }}>🗑️ حذف المنطقة</button>
        </div>
      </aside>
    </>
  );
}

// ── مراجعة المناطق الجديدة: بطاقة بعد بطاقة بدل قائمة طويلة ────────────────
interface ReviewDeckProps {
  queue: ReviewQueueItem[]; areas: Area[]; provinces: Province[]; subProvinces: SubProvince[]; busy: boolean;
  onClose: () => void;
  onConfirm: (id: number, name: string) => void;
  onLink: (id: number, targetId: number, name: string, targetName: string) => void;
  onMove: (id: number, val: string) => void;
  onConfirmMany: (ids: number[]) => void;
}
function ReviewDeck({ queue, areas, provinces, subProvinces, busy, onClose, onConfirm, onLink, onMove, onConfirmMany }: ReviewDeckProps) {
  const [idx, setIdx] = useState(0);
  const total = useRef(queue.length);
  // ذات الاقتراحات أولاً: هي التي تحتاج قراراً فعلياً.
  const ordered = useMemo(() => [...queue].sort((a, b) => Number(b.suggestions.length > 0) - Number(a.suggestions.length > 0)), [queue]);
  const i = Math.min(idx, Math.max(ordered.length - 1, 0));
  const item = ordered[i] as ReviewQueueItem | undefined;
  const live = item ? areas.find(a => a.id === item.id) : undefined;
  const noSuggestion = ordered.filter(x => x.suggestions.length === 0);
  const done = total.current - ordered.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      const tag = (e.target as HTMLElement).tagName;
      if (!item || busy || tag === 'SELECT' || tag === 'INPUT') return;
      if (e.key === 'Enter') { e.preventDefault(); onConfirm(item.id, item.name); }
      else if (e.key === 'ArrowLeft') setIdx((i + 1) % ordered.length);
      else if (e.key === 'ArrowRight') setIdx((i - 1 + ordered.length) % ordered.length);
      else if (/^[1-5]$/.test(e.key)) {
        const s = item.suggestions[Number(e.key) - 1];
        if (s) onLink(item.id, s.id, item.name, s.name);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, i, ordered.length, busy, onClose, onConfirm, onLink]);

  const liveSub = live ? subProvinces.find(s => s.id === live.subProvinceId && s.provinceId === live.provinceId) : undefined;
  const currentVal = live?.provinceId == null ? '__none' : (liveSub ? `${live.provinceId}:${liveSub.id}` : String(live.provinceId));

  return (
    <div className="ar-deck-wrap" onClick={onClose}>
      <div className="ar-deck" onClick={e => e.stopPropagation()} role="dialog" aria-label="مراجعة المناطق الجديدة">
        <div className="ar-progress"><div style={{ width: `${total.current ? (done / total.current) * 100 : 100}%` }} /></div>
        <div style={{ padding: '16px 22px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <strong style={{ fontSize: 13.5, color: UI.ink }}>🕓 مراجعة المناطق الجديدة</strong>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {item && <span style={{ fontSize: 12, color: UI.muted }}>{i + 1} من {ordered.length}</span>}
              <button onClick={onClose} title="إغلاق" style={{ ...btnStyle('#64748b', true), padding: '4px 9px' }}>✕</button>
            </span>
          </div>

          {!item ? (
            <div style={{ textAlign: 'center', padding: '26px 0 12px' }}>
              <div style={{ fontSize: 34, marginBottom: 8 }}>🎉</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: UI.ink, marginBottom: 14 }}>انتهت المراجعة</div>
              <button onClick={onClose} style={btnStyle('#0f172a', true)}>إغلاق</button>
            </div>
          ) : (
            <div key={item.id} style={{ animation: 'ar-fade .16s ease-out' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: UI.ink, lineHeight: 1.45, overflowWrap: 'anywhere', marginBottom: 10 }}>{item.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 12, color: UI.muted }}>
                المحافظة:
                <select className="ar-select" value={currentVal} disabled={busy} onChange={e => onMove(item.id, e.target.value)}>
                  <ProvinceOptions provinces={provinces} subProvinces={subProvinces} />
                </select>
              </div>

              {item.suggestions.length > 0 ? (
                <>
                  <div style={{ fontSize: 12, fontWeight: 700, color: UI.muted, marginBottom: 7 }}>هل هي نفس إحدى هذه المناطق؟ اضغط للدمج:</div>
                  {item.suggestions.map((s, n) => (
                    <button key={s.id} className="ar-sug" disabled={busy} onClick={() => onLink(item.id, s.id, item.name, s.name)}>
                      <kbd>{n + 1}</kbd>
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{s.name}</span>
                      <span className="ar-bar" title={`تشابه ${(s.score * 100).toFixed(0)}%`}><div style={{ width: `${s.score * 100}%` }} /></span>
                      <span style={{ fontSize: 11, color: UI.muted, width: 30, textAlign: 'left' }}>{(s.score * 100).toFixed(0)}%</span>
                    </button>
                  ))}
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: UI.faint, padding: '10px 12px', background: UI.bg, borderRadius: 10 }}>لا توجد منطقة تشبهها في القائمة.</div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button onClick={() => onConfirm(item.id, item.name)} disabled={busy} style={{ ...btnStyle('#15803d'), flex: 1, background: '#15803d', color: '#fff' }}>
                  ✅ منطقة جديدة فعلاً
                </button>
                <button onClick={() => setIdx((i + 1) % ordered.length)} disabled={busy || ordered.length < 2} style={btnStyle('#64748b')}>تخطي ←</button>
              </div>
              <div style={{ marginTop: 10, fontSize: 11, color: UI.faint, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span><span className="ar-kbd">Enter</span> جديدة</span>
                {item.suggestions.length > 0 && <span><span className="ar-kbd">1</span>–<span className="ar-kbd">{item.suggestions.length}</span> دمج</span>}
                <span><span className="ar-kbd">←</span> <span className="ar-kbd">→</span> تنقّل</span>
                <span><span className="ar-kbd">Esc</span> إغلاق</span>
              </div>

              {noSuggestion.length >= 2 && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${UI.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', fontSize: 12, color: UI.muted }}>
                  <span>{noSuggestion.length} منطقة بلا أي اسم مشابه</span>
                  <button disabled={busy} onClick={() => onConfirmMany(noSuggestion.map(x => x.id))} style={btnStyle('#16a34a', true)}>تأكيدها كلها دفعة واحدة</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AreasPage() {
  const { token, logout } = useSuperAdmin();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [areas, setAreas]             = useState<Area[]>([]);
  const [provinces, setProvinces]     = useState<Province[]>([]);
  const [subProvinces, setSubProvinces] = useState<SubProvince[]>([]);
  const [loading, setLoading]         = useState(true);
  const [busy, setBusy]               = useState(false);

  const [search, setSearch]           = useState('');
  const [selected, setSelected]       = useState<Sel>('all');
  const [subTab, setSubTab]           = useState<SubTab>('all');
  const [flag, setFlag]               = useState<Flag>(null);
  const prevSel = useRef<Sel>('all');
  const selInit = useRef(false);

  const [newAreaProvince, setNewAreaProvince] = useState<number | ''>('');
  const [flashId, setFlashId]         = useState<number | null>(null);
  const [pulseKey, setPulseKey]       = useState<string | null>(null);

  const [inspectId, setInspectId]     = useState<number | null>(null);
  const [checked, setChecked]         = useState<Set<number>>(new Set());
  const [dropKey, setDropKey]         = useState<string | null>(null);
  const [dragCount, setDragCount]     = useState(0);
  const [undo, setUndo]               = useState<UndoMove | null>(null);
  const [toolsOpen, setToolsOpen]     = useState(false);

  const checkedRef = useRef(checked);
  checkedRef.current = checked;
  const dragIds = useRef<number[]>([]);

  const [mergeSugs, setMergeSugs]     = useState<MergeSuggestion[] | null>(null);
  const [mergeBusy, setMergeBusy]     = useState(false);

  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [reviewBusy, setReviewBusy]   = useState(false);
  const [reviewOpen, setReviewOpen]   = useState(false);

  const [deleteInfo, setDeleteInfo]   = useState<DeleteInfo | null>(null);
  const [deleteTransferTo, setDeleteTransferTo] = useState<number | ''>('');

  const handleAuthError = (r: Response): boolean => {
    if (r.status === 401) { showToast('انتهت صلاحية الجلسة — يرجى إعادة تسجيل الدخول', '#dc2626'); logout(); return true; }
    return false;
  };

  const load = async () => {
    setLoading(true);
    try {
      const [ar, pr, sp] = await Promise.all([
        fetch('/api/sa/areas?all=true', { headers: H() }).then(r => r.json()),
        fetch('/api/sa/provinces',       { headers: H() }).then(r => r.json()),
        fetch('/api/sa/sub-provinces',   { headers: H() }).then(r => r.json()),
      ]);
      if (ar.success) setAreas(ar.data);
      if (pr.success) setProvinces(pr.data);
      if (sp.success) setSubProvinces(sp.data);
      // أول فتح: أول محافظة فيها مناطق بدل قائمة كل العراق دفعة واحدة
      if (!selInit.current && ar.success && pr.success) {
        selInit.current = true;
        const first = [...pr.data as Province[]]
          .sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0))
          .find(p => (ar.data as Area[]).some(a => a.provinceId === p.id));
        if (first) { setSelected(first.id); prevSel.current = first.id; }
      }
    } finally { setLoading(false); }
    loadReviewQueue();
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // ── طابور المراجعة — مناطق أُنشئت تلقائياً بلا تطابق تام/ثقة عالية كافية ────
  const loadReviewQueue = async () => {
    try {
      const r = await fetch('/api/sa/areas/review-queue', { headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) setReviewQueue(j.data);
    } catch { /* صامت — طابور ثانوي، لا يمنع عمل الصفحة الأساسية */ }
  };

  const confirmReviewItem = async (id: number, name: string) => {
    setReviewBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/review-queue/${id}/confirm`, { method: 'POST', headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) {
        setAreas(j.data); setReviewQueue(prev => prev.filter(x => x.id !== id));
        showToast(`✅ "${name}" مؤكَّدة كمنطقة جديدة`);
      } else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setReviewBusy(false); }
  };

  const confirmManyReview = async (ids: number[]) => {
    if (!confirm(`تأكيد ${ids.length} منطقة كمناطق جديدة فعلاً؟ هذه المناطق لا يشبهها أي اسم في القائمة، وستُزال من طابور المراجعة بلا أي دمج.`)) return;
    setReviewBusy(true);
    try {
      const r = await fetch('/api/sa/areas/review-queue/confirm-bulk', { method: 'POST', headers: H(), body: JSON.stringify({ ids }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) {
        const gone = new Set(ids);
        setAreas(j.data); setReviewQueue(prev => prev.filter(x => !gone.has(x.id)));
        showToast(`✅ تم تأكيد ${j.updated} منطقة`);
      } else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setReviewBusy(false); }
  };

  const linkReviewItem = async (id: number, targetAreaId: number, name: string, targetName: string) => {
    if (!confirm(`ربط "${name}" بمنطقة "${targetName}" الموجودة؟ ستُنقل كل بياناتها وتُحذف "${name}"، ويُتذكَّر هذا الربط تلقائياً مستقبلاً. لا يمكن التراجع.`)) return;
    setReviewBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/review-queue/${id}/link`, { method: 'POST', headers: H(), body: JSON.stringify({ targetAreaId }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) {
        setAreas(j.data); setReviewQueue(prev => prev.filter(x => x.id !== id));
        showToast(`✅ تم الربط بـ"${targetName}"`);
      } else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setReviewBusy(false); }
  };

  // ── الانتقال إلى/من عرض «كل المحافظات» عند البحث أو تفعيل فلتر ─────────────
  const enterGlobal = () => {
    prevSel.current = selected;
    setNewAreaProvince(typeof selected === 'number' ? selected : '');
    setSelected('all'); setSubTab('all');
  };
  const onSearchChange = (v: string) => {
    const had = !!search.trim(), has = !!v.trim();
    if (!had && has && !flag) enterGlobal();
    if (had && !has && !flag) { setSelected(prevSel.current); setSubTab('all'); }
    setSearch(v);
  };
  const toggleFlag = (f: Exclude<Flag, null>) => {
    if (flag === f) {
      setFlag(null);
      if (!search.trim()) { setSelected(prevSel.current); setSubTab('all'); }
      return;
    }
    if (!flag && !search.trim()) enterGlobal();
    setFlag(f);
  };
  const pickSelection = (s: Sel) => { setSelected(s); setSubTab('all'); if (s !== 'all') prevSel.current = s; };

  // ── Area CRUD ────────────────────────────────────────────────────────────
  const createArea = async () => {
    const name = search.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas', { method: 'POST', headers: H(), body: JSON.stringify({ name }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (!j.success) { showToast('❌ ' + j.error, '#dc2626'); return; }
      setAreas(j.data);
      const created = j.data.find((a: Area) => a.name === name);
      // إن اختار المدير محافظة عند الإنشاء، أسندها فوراً بدل ترك المنطقة «غير محدد»
      if (newAreaProvince !== '' && created) await moveAreas([created.id], Number(newAreaProvince), null, { quiet: true });
      const dest: Sel = newAreaProvince !== '' ? Number(newAreaProvince) : 'none';
      setSearch(''); setFlag(null); pickSelection(dest);
      if (created) setFlashId(created.id);
      showToast('✅ تمت إضافة المنطقة');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  const renameArea = async (id: number, name: string): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/${id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ name }) });
      if (handleAuthError(r)) return false;
      const j = await r.json();
      if (j.success) { setAreas(j.data); showToast('✅ تم تعديل الاسم'); return true; }
      showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
    return false;
  };

  // تثبيت التعارض: نفس المحافظة ونفس القسم، والسيرفر يصفّر provinceConflict فقط.
  const pinConflict = async (a: Area) => {
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas/province-bulk', { method: 'PUT', headers: H(), body: JSON.stringify({ areaIds: [a.id], provinceId: a.provinceId }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) { setAreas(j.data); showToast('✅ تم تثبيت المنطقة'); }
      else showToast('❌ ' + (j.error || 'فشل التثبيت'), '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  // النقل الموحّد: السحب والتحديد واللوحة الجانبية كلها تمر من هنا. province-bulk
  // لا يلمس القسم، لذا يُصفَّر صراحةً هنا كي لا يعلق «الكرخ» على منطقة انتقلت خارج بغداد.
  const moveAreas = async (ids: number[], provinceId: number | null, subProvinceId: number | null, opts: { quiet?: boolean; noUndo?: boolean } = {}) => {
    if (ids.length === 0) return;
    const before = areas.filter(a => ids.includes(a.id));
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas/province-bulk', { method: 'PUT', headers: H(), body: JSON.stringify({ areaIds: ids, provinceId }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (!j.success) { showToast('❌ ' + (j.error || 'فشل النقل'), '#dc2626'); return; }
      let final: Area[] = j.data;
      const subTargets = subProvinceId != null ? ids : before.filter(a => a.subProvinceId != null).map(a => a.id);
      if (subTargets.length > 0) {
        const r2 = await fetch('/api/sa/areas/sub-province-bulk', { method: 'PUT', headers: H(), body: JSON.stringify({ areaIds: subTargets, subProvinceId }) });
        if (handleAuthError(r2)) return;
        const j2 = await r2.json();
        if (!j2.success) { setAreas(final); showToast('❌ ' + (j2.error || 'فشل تحديد القسم'), '#dc2626'); return; }
        final = j2.data;
      }
      setAreas(final);
      setPulseKey(provinceId == null ? 'none' : String(provinceId));
      if (opts.quiet) return;
      const destName = subProvinces.find(s => s.id === subProvinceId)?.name ?? provinces.find(p => p.id === provinceId)?.name ?? 'بلا محافظة';
      const label = ids.length === 1 ? `نُقلت «${before[0]?.name ?? ''}» إلى ${destName}` : `نُقلت ${ids.length} منطقة إلى ${destName}`;
      // النقل يصفّر علامة التعارض ولا طريق لإعادتها، فلا تراجع عن منطقة كانت عليها بشارة.
      if (opts.noUndo || before.some(a => a.provinceConflict)) showToast(`✅ ${label}`);
      else setUndo({ label, items: before.map(a => ({ id: a.id, provinceId: a.provinceId, subProvinceId: a.subProvinceId })) });
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  const undoMove = async () => {
    if (!undo) return;
    const items = undo.items;
    setUndo(null);
    const groups = new Map<string, number[]>();
    for (const it of items) {
      const k = `${it.provinceId ?? ''}:${it.subProvinceId ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), it.id]);
    }
    for (const [k, ids] of groups) {
      const [p, s] = k.split(':');
      await moveAreas(ids, p ? Number(p) : null, s ? Number(s) : null, { quiet: true });
    }
    showToast('↩️ تم التراجع');
  };

  const assignSubOnly = async (ids: number[], subProvinceId: number | null) => {
    if (ids.length === 0) return;
    const before = areas.filter(a => ids.includes(a.id));
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas/sub-province-bulk', { method: 'PUT', headers: H(), body: JSON.stringify({ areaIds: ids, subProvinceId }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (!j.success) { showToast('❌ ' + (j.error || 'فشل النقل'), '#dc2626'); return; }
      setAreas(j.data);
      const destName = subProvinces.find(s => s.id === subProvinceId)?.name ?? 'بلا قسم';
      const label = ids.length === 1 ? `نُقلت «${before[0]?.name ?? ''}» إلى ${destName}` : `نُقلت ${ids.length} منطقة إلى ${destName}`;
      if (before.some(a => a.provinceConflict)) showToast(`✅ ${label}`);
      else setUndo({ label, items: before.map(a => ({ id: a.id, provinceId: a.provinceId, subProvinceId: a.subProvinceId })) });
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  // عكس الدمج: منطقة عليها بشارة تعارض محافظة تعني أن اسماً من ملف رُبط خطأً
  // بصفّ منطقة أخرى (مثال حقيقي: "العامرية" بغداد/الكرخ ابتلعت "عامرية
  // الفلوجة" بالأنبار). الفصل يتحقق من عمود المحافظة الخام في كل صف مبيعات
  // قبل نقل أي شيء — راجع تعليق /api/sa/areas/:id/split-conflict في السيرفر.
  const splitConflict = async (a: Area, name: string): Promise<boolean> => {
    if (!name || !a.provinceConflict) return false;
    const targetProvince = provinces.find(p => p.name === a.provinceConflict);
    if (!targetProvince) { showToast('❌ تعذّر تحديد المحافظة المستهدفة', '#dc2626'); return false; }
    if (!confirm(`فصل "${name}" (محافظة ${a.provinceConflict}) عن "${a.name}"؟ ستُنقل فقط صفوف المبيعات التي تُثبت انتماءها فعلاً لهذه المحافظة إلى منطقة جديدة منفصلة — البقية تبقى في "${a.name}". لا يمكن التراجع.`)) return false;
    setBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/${a.id}/split-conflict`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ newName: name, newProvinceId: targetProvince.id }),
      });
      if (handleAuthError(r)) return false;
      const j = await r.json();
      if (j.success) {
        setAreas(j.data);
        showToast(`✅ تم فصل ${j.movedSales} صف مبيعات إلى منطقة "${name}" جديدة`);
        return true;
      }
      showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
    return false;
  };

  const mergeInto = async (fromId: number, toId: number, fromName: string, toName: string): Promise<boolean> => {
    if (!confirm(`دمج "${fromName}" داخل "${toName}"؟ ستُنقل كل بياناتها (مبيعات، أطباء، ...) ثم تُحذف "${fromName}". لا يمكن التراجع.`)) return false;
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas/merge', { method: 'POST', headers: H(), body: JSON.stringify({ fromId, toId }) });
      if (handleAuthError(r)) return false;
      const j = await r.json();
      if (j.success) { setAreas(j.data); showToast(`✅ تم الدمج في "${toName}"`); return true; }
      showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
    return false;
  };

  const openDelete = async (id: number, name: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/${id}/usage`, { headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (!j.success) { showToast('❌ ' + j.error, '#dc2626'); return; }
      setDeleteTransferTo('');
      setDeleteInfo({ id, name, usage: j.usage, total: j.total, blocking: j.blocking, pharmacyVisitDetails: j.pharmacyVisitDetails || [] });
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  const confirmDelete = async (mode: 'detach' | 'transfer') => {
    if (!deleteInfo) return;
    if (mode === 'transfer' && !deleteTransferTo) { showToast('اختر منطقة لنقل البيانات إليها', '#dc2626'); return; }
    setBusy(true);
    try {
      const body = mode === 'transfer' ? { transferTo: deleteTransferTo } : {};
      const r = await fetch(`/api/sa/areas/${deleteInfo.id}`, { method: 'DELETE', headers: H(), body: JSON.stringify(body) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) {
        setAreas(j.data); setDeleteInfo(null);
        showToast(mode === 'transfer' ? '✅ تم نقل البيانات وحذف المنطقة' : '✅ تم حذف المنطقة');
      } else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  // ── أدوات الدمج والمطابقة التلقائية على مستوى القائمة كاملة ───────────────
  const mergeDuplicates = async () => {
    if (!confirm('سيتم دمج المناطق المكررة المتطابقة بالاسم (مثل الحارثية/الحارثيه) في منطقة واحدة، مع نقل كل بياناتها. لا تُحذف أي بيانات. متابعة؟')) return;
    setMergeBusy(true);
    try {
      const r = await fetch('/api/sa/areas/merge-duplicates', { method: 'POST', headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) { setAreas(j.data); showToast(j.mergedCount > 0 ? `✅ تم دمج ${j.mergedCount} منطقة مكررة` : '✅ لا توجد مناطق مكررة متطابقة'); }
      else showToast('❌ ' + j.error, '#dc2626');
    } finally { setMergeBusy(false); }
  };

  const loadMergeSuggestions = async () => {
    setMergeBusy(true);
    try {
      const r = await fetch('/api/sa/areas/merge-suggestions', { headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) setMergeSugs(j.data);
      else showToast('❌ ' + j.error, '#dc2626');
    } finally { setMergeBusy(false); }
  };

  const resetFromSurvey = async () => {
    if (!confirm('سيتم مسح المناطق غير المستخدمة (بلا بيانات) وإعادة تحميل القائمة من السيرفي الرئيسي. المناطق المرتبطة ببيانات تبقى. متابعة؟')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas/reset-from-survey', { method: 'POST', headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) { await load(); showToast(`✅ تم التحديث — ${j.count} منطقة`); }
      else showToast('❌ ' + j.error, '#dc2626');
    } finally { setBusy(false); }
  };

  const autoMatchProvinces = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/sa/provinces/auto-match', { method: 'POST', headers: H(), body: JSON.stringify({}) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) {
        await load();
        const s = j.stats || {};
        showToast(`✅ مطابقة المحافظات: ${s.matchedFromSales ?? 0} من المبيعات، ${s.matchedFromName ?? 0} من الاسم، ${s.unresolved ?? 0} بقيت بلا محافظة`);
      } else showToast('❌ ' + j.error, '#dc2626');
    } finally { setBusy(false); }
  };

  const autoMatchSubProvinces = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/sa/sub-provinces/auto-match', { method: 'POST', headers: H(), body: JSON.stringify({}) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) {
        await load();
        const s = j.stats || {};
        showToast(`✅ توزيع كرخ/رصافة: ${s.matched ?? 0} تم توزيعها، ${s.unresolved ?? 0} بقيت بلا قسم`);
      } else showToast('❌ ' + j.error, '#dc2626');
    } finally { setBusy(false); }
  };

  // ── تفاعلات البطاقات: ثابتة المرجع كي لا يعيد memo رسم مئات البطاقات مع كل حرف ──
  const toggleChecked = useCallback((id: number) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const activateChip = useCallback((id: number) => {
    if (checkedRef.current.size > 0) toggleChecked(id);
    else setInspectId(id);
  }, [toggleChecked]);
  const chipDragStart = useCallback((e: DragEvent, id: number) => {
    const ids = checkedRef.current.has(id) ? [...checkedRef.current] : [id];
    dragIds.current = ids;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
    // تأجيل الرسم: تغيير الصفحة داخل dragstart نفسه قد يُلغي السحب في Chrome.
    setTimeout(() => setDragCount(ids.length), 0);
  }, []);
  const chipDragEnd = useCallback(() => { setDragCount(0); setDropKey(null); dragIds.current = []; }, []);
  const closeDrawer = useCallback(() => setInspectId(null), []);
  const closeReview = useCallback(() => setReviewOpen(false), []);

  const dropHandlers = (key: string, onDropIds: (ids: number[]) => void) => ({
    onDragOver: (e: DragEvent) => {
      if (dragIds.current.length === 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropKey !== key) setDropKey(key);
    },
    onDragLeave: () => setDropKey(k => (k === key ? null : k)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const ids = dragIds.current;
      chipDragEnd();
      setChecked(new Set());
      if (ids.length > 0) onDropIds(ids);
    },
  });

  // ── اشتقاق العرض ─────────────────────────────────────────────────────────
  const deferredSearch = useDeferredValue(search);
  const q = normAr(deferredSearch);

  const provincesSorted = useMemo(
    () => [...provinces].sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0) || arCollator.compare(x.name, y.name)),
    [provinces],
  );
  const subById = useMemo(() => new Map(subProvinces.map(s => [s.id, s])), [subProvinces]);
  const sortedAreas = useMemo(
    () => areas.map(a => ({ a, key: normAr(a.name) })).sort((x, y) => arCollator.compare(x.a.name, y.a.name)),
    [areas],
  );
  const conflictCount = useMemo(() => areas.filter(a => a.provinceConflict).length, [areas]);
  const legacyCount = useMemo(() => areas.filter(a => a.userId != null).length, [areas]);

  const matches = useMemo(() => {
    let rows = sortedAreas;
    if (q) rows = rows.filter(r => r.key.includes(q));
    if (flag === 'conflict') rows = rows.filter(r => r.a.provinceConflict);
    if (flag === 'legacy') rows = rows.filter(r => r.a.userId != null);
    return rows.map(r => r.a);
  }, [sortedAreas, q, flag]);

  const tileCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of matches) { const k = a.provinceId == null ? 'none' : String(a.provinceId); counts.set(k, (counts.get(k) ?? 0) + 1); }
    return counts;
  }, [matches]);

  // شدة لون كل محافظة تتبع عدد مناطقها الكلي (جذر تربيعي كي لا تطمس بغداد البقية).
  const { areaTotals, maxTotal } = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of areas) if (a.provinceId != null) m.set(a.provinceId, (m.get(a.provinceId) ?? 0) + 1);
    return { areaTotals: m, maxTotal: Math.max(1, ...m.values()) };
  }, [areas]);

  const panelSubs = useMemo(
    () => (typeof selected === 'number' ? subProvinces.filter(s => s.provinceId === selected) : [])
      .sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0) || arCollator.compare(x.name, y.name)),
    [selected, subProvinces],
  );

  const { sections, subCounts, visibleIds, selectedTotal } = useMemo(() => {
    const inScope = selected === 'all' ? matches
      : selected === 'none' ? matches.filter(a => a.provinceId == null)
      : matches.filter(a => a.provinceId === selected);

    const counts = new Map<string, number>();
    for (const a of inScope) {
      const sid = effectiveSubId(a, subById);
      const k = sid == null ? 'direct' : String(sid);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    const out: Section[] = [];
    if (selected === 'all') {
      const byProv = new Map<string, Area[]>();
      for (const a of inScope) { const k = a.provinceId == null ? 'none' : String(a.provinceId); byProv.set(k, [...(byProv.get(k) ?? []), a]); }
      for (const p of provincesSorted) {
        const rows = byProv.get(String(p.id));
        if (rows) out.push({ key: `p${p.id}`, title: p.name, onOpen: () => pickSelection(p.id), areas: rows });
      }
      const none = byProv.get('none');
      if (none) out.push({ key: 'none', title: 'بلا محافظة', onOpen: () => pickSelection('none'), areas: none });
    } else if (panelSubs.length > 0 && subTab === 'all') {
      for (const s of panelSubs) {
        const rows = inScope.filter(a => effectiveSubId(a, subById) === s.id);
        if (rows.length > 0) out.push({ key: `s${s.id}`, title: s.name, onOpen: () => setSubTab(s.id), areas: rows });
      }
      const direct = inScope.filter(a => effectiveSubId(a, subById) == null);
      if (direct.length > 0) out.push({ key: 'direct', title: 'بلا قسم', onOpen: () => setSubTab('direct'), areas: direct });
    } else {
      const rows = subTab === 'all' ? inScope
        : subTab === 'direct' ? inScope.filter(a => effectiveSubId(a, subById) == null)
        : inScope.filter(a => effectiveSubId(a, subById) === subTab);
      if (rows.length > 0) out.push({ key: 'one', title: null, areas: rows });
    }
    return { sections: out, subCounts: counts, visibleIds: out.flatMap(s => s.areas.map(a => a.id)), selectedTotal: inScope.length };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [matches, selected, subTab, panelSubs, provincesSorted, subById]);

  const exactExists = useMemo(() => !!q && sortedAreas.some(r => r.key === q), [sortedAreas, q]);

  // مناطق اختفت بدمج/حذف تخرج من التحديد
  useEffect(() => {
    setChecked(prev => {
      if (prev.size === 0) return prev;
      const ids = new Set(areas.map(a => a.id));
      const next = new Set([...prev].filter(id => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [areas]);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 10000);
    return () => clearTimeout(t);
  }, [undo]);

  useEffect(() => {
    if (!pulseKey) return;
    const t = setTimeout(() => setPulseKey(null), 950);
    return () => clearTimeout(t);
  }, [pulseKey]);

  useEffect(() => {
    if (flashId == null) return;
    const raf = requestAnimationFrame(() => {
      document.querySelector(`[data-area-id="${flashId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const t = setTimeout(() => setFlashId(null), 1900);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [flashId]);

  if (loading) return <Spinner />;

  const inspected = inspectId != null ? areas.find(a => a.id === inspectId) ?? null : null;
  const selectedProvince = typeof selected === 'number' ? provinces.find(p => p.id === selected) ?? null : null;
  const narrowed = !!q || !!flag;
  const anyBusy = busy || mergeBusy || reviewBusy;
  const tools = [
    { icon: '🧹', title: 'دمج المكررات', desc: 'يوحّد الأسماء المتطابقة مثل الحارثية/الحارثيه بلا فقدان بيانات', run: mergeDuplicates },
    { icon: '🔍', title: 'اقتراحات الدمج', desc: 'أسماء متشابهة (غير متطابقة) لمراجعتها يدوياً', run: loadMergeSuggestions },
    { icon: '🗺️', title: 'مطابقة المحافظات', desc: 'يسند محافظة لكل منطقة بلا محافظة تلقائياً', run: autoMatchProvinces },
    { icon: '🏙️', title: 'توزيع كرخ/رصافة', desc: 'يوزّع مناطق بغداد على الأقسام تلقائياً', run: autoMatchSubProvinces },
    { icon: '🔄', title: 'تحديث من السيرفي', desc: 'يعيد تحميل القائمة من السيرفي الرئيسي، والمرتبطة ببيانات تبقى', run: resetFromSurvey },
  ];

  const tile = (key: string, sel: Sel, label: string, count: number, extra: string, style: React.CSSProperties, onDropIds?: (ids: number[]) => void) => (
    <button key={key} title={label} onClick={() => pickSelection(sel)}
      className={`ar-tile ${extra}${selected === sel ? ' is-active' : ''}${narrowed && count === 0 && selected !== sel ? ' is-dim' : ''}${dropKey === key ? ' is-drop' : ''}${pulseKey === key ? ' is-pulse' : ''}`}
      style={style}
      {...(onDropIds ? dropHandlers(key, onDropIds) : {})}>
      <span>{label}</span><span className="ar-tile-n">{count}</span>
    </button>
  );

  const allChecked = visibleIds.length > 0 && visibleIds.every(id => checked.has(id));
  const panelTitle = flag === 'conflict' ? '⚠️ مناطق عليها تعارض محافظة'
    : flag === 'legacy' ? '👤 صفوف قديمة مرتبطة بحساب'
    : q ? 'نتائج البحث'
    : selected === 'all' ? 'كل المحافظات'
    : selected === 'none' ? 'مناطق بلا محافظة'
    : selectedProvince?.name ?? '';

  return (
    <div className="ar-root">
      <style>{CSS}</style>
      {anyBusy && <div className="ar-busy" />}

      <div className="ar-head">
        <div>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: '#0f172a' }}>🗺️ المحافظات والمناطق</h2>
          <div style={{ marginTop: 2, fontSize: 12, color: UI.muted }}>{provinces.length} محافظة · {areas.length} منطقة</div>
        </div>
        <div className="ar-search">
          <span className="ar-search-ico">🔍</span>
          <input type="text" value={search} placeholder="ابحث عن منطقة، أو اكتب اسماً جديداً لإضافته..." aria-label="بحث أو إضافة منطقة"
            onChange={e => onSearchChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onSearchChange('');
              if (e.key === 'Enter' && q) {
                if (matches.length === 1) setInspectId(matches[0].id);
                else if (matches.length === 0 && !exactExists && !busy) createArea();
              }
            }} />
          {search && <button className="ar-search-x" title="مسح" onClick={() => onSearchChange('')}>✕</button>}
        </div>
        <div className="ar-menu-wrap">
          <button onClick={() => setToolsOpen(o => !o)} aria-expanded={toolsOpen} style={{ ...btnStyle('#4f46e5', true), height: 36 }}>🧰 أدوات ذكية {toolsOpen ? '▴' : '▾'}</button>
          {toolsOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setToolsOpen(false)} />
              <div className="ar-menu">
                {tools.map(t => (
                  <button key={t.title} disabled={anyBusy} onClick={() => { setToolsOpen(false); t.run(); }}>
                    <span style={{ fontSize: 15 }}>{t.icon}</span>
                    <span><b>{t.title}</b><small>{t.desc}</small></span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {(reviewQueue.length > 0 || conflictCount > 0 || legacyCount > 0) && (
        <div className="ar-pills">
          {reviewQueue.length > 0 && (
            <button className="ar-pill" onClick={() => setReviewOpen(true)} title="مناطق أُنشئت تلقائياً من ملفات/سيرفي بلا تطابق أكيد"
              style={{ background: '#eff6ff', borderColor: '#93c5fd', color: '#1e40af' }}>
              🕓 <b>{reviewQueue.length}</b> بانتظار المراجعة · ابدأ ←
            </button>
          )}
          {conflictCount > 0 && (
            <button className="ar-pill" onClick={() => toggleFlag('conflict')} aria-pressed={flag === 'conflict'} title="ورد اسمها في ملف بمحافظة تختلف عن المحفوظة"
              style={flag === 'conflict' ? { background: '#dc2626', borderColor: '#dc2626', color: '#fff' } : { background: '#fef2f2', borderColor: '#fca5a5', color: '#991b1b' }}>
              ⚠️ <b>{conflictCount}</b> تعارض محافظة{flag === 'conflict' ? ' ✕' : ''}
            </button>
          )}
          {legacyCount > 0 && (
            <button className="ar-pill" onClick={() => toggleFlag('legacy')} aria-pressed={flag === 'legacy'} title="صفوف قديمة من قبل توحيد نظام المناطق، ما زالت مرتبطة بحساب"
              style={flag === 'legacy' ? { background: '#4338ca', borderColor: '#4338ca', color: '#fff' } : { background: '#eef2ff', borderColor: '#c7d2fe', color: '#3730a3' }}>
              👤 <b>{legacyCount}</b> مرتبطة بحساب{flag === 'legacy' ? ' ✕' : ''}
            </button>
          )}
        </div>
      )}

      <div className="ar-layout">
        <div className="ar-rail">
          <div className="ar-tiles">
            {tile('all', 'all', 'كل المحافظات', matches.length, 'ar-tile-wide', { background: UI.bg, borderColor: UI.line })}
            {provincesSorted.map(p => {
              const total = areaTotals.get(p.id) ?? 0;
              const heat = total === 0 ? 0 : Math.round(7 + 26 * Math.sqrt(total / maxTotal));
              return tile(String(p.id), p.id, p.name, tileCounts.get(String(p.id)) ?? 0, '',
                total === 0
                  ? { background: UI.bg, borderColor: UI.line, color: UI.faint }
                  : { background: `color-mix(in srgb, #4f46e5 ${heat}%, #fff)` },
                ids => moveAreas(ids, p.id, null));
            })}
            {tile('none', 'none', 'بلا محافظة', tileCounts.get('none') ?? 0, 'ar-tile-wide',
              { background: '#fffbeb', borderColor: '#fde68a', color: '#92400e' }, ids => moveAreas(ids, null, null))}
          </div>
          <div className="ar-rail-hint">
            {dragCount > 0
              ? <b style={{ color: UI.accent }}>أفلت {dragCount > 1 ? `${dragCount} مناطق` : 'المنطقة'} على المحافظة أو القسم</b>
              : '💡 اسحب أي منطقة إلى محافظة لنقلها. اللون الأغمق = مناطق أكثر.'}
          </div>
        </div>

        <div className="ar-panel" key={`${selected}`}>
          <div className="ar-panel-head">
            <div style={{ fontSize: 15, fontWeight: 700, color: UI.ink }}>
              {panelTitle} <span style={{ fontSize: 12.5, fontWeight: 500, color: UI.muted }}>({visibleIds.length})</span>
            </div>
            {visibleIds.length > 0 && (
              <button className="ar-link" onClick={() => setChecked(prev => {
                const next = new Set(prev);
                if (allChecked) visibleIds.forEach(id => next.delete(id)); else visibleIds.forEach(id => next.add(id));
                return next;
              })}>{allChecked ? 'إلغاء التحديد' : 'تحديد الكل'}</button>
            )}
          </div>

          {panelSubs.length > 0 && (
            <div className="ar-tabs">
              <button className={`ar-tab${subTab === 'all' ? ' is-active' : ''}`} onClick={() => setSubTab('all')}>الكل<small>{selectedTotal}</small></button>
              {panelSubs.map(s => (
                <button key={s.id} className={`ar-tab${subTab === s.id ? ' is-active' : ''}${dropKey === `sub${s.id}` ? ' is-drop' : ''}`} onClick={() => setSubTab(s.id)}
                  {...dropHandlers(`sub${s.id}`, ids => moveAreas(ids, s.provinceId, s.id))}>
                  {s.name}<small>{subCounts.get(String(s.id)) ?? 0}</small>
                </button>
              ))}
              <button className={`ar-tab${subTab === 'direct' ? ' is-active' : ''}${dropKey === 'subnone' ? ' is-drop' : ''}`} onClick={() => setSubTab('direct')}
                {...dropHandlers('subnone', ids => moveAreas(ids, panelSubs[0].provinceId, null))}>
                بلا قسم<small>{subCounts.get('direct') ?? 0}</small>
              </button>
            </div>
          )}

          {q && !exactExists && (
            <div className="ar-add">
              <span style={{ fontWeight: 600 }}>➕ إضافة «{search.trim()}»</span>
              <span style={{ fontSize: 12 }}>إلى:</span>
              <select className="ar-select" value={newAreaProvince} disabled={busy} onChange={e => setNewAreaProvince(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">بلا محافظة</option>
                {provincesSorted.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button onClick={createArea} disabled={busy} style={{ ...btnStyle('#15803d', true), background: '#15803d', color: '#fff' }}>إضافة</button>
            </div>
          )}

          {sections.length === 0 && (
            <div className="ar-empty">
              {narrowed ? 'لا توجد مناطق مطابقة.'
                : subTab !== 'all' ? 'لا توجد مناطق في هذا القسم بعد — اسحب مناطق إلى تبويبه.'
                : 'لا توجد مناطق هنا بعد — اسحب منطقة إلى هذه المحافظة، أو اكتب اسماً في البحث لإضافته.'}
            </div>
          )}

          {sections.map(sec => (
            <div key={sec.key} className="ar-section">
              {sec.title && (
                <div className="ar-sec">
                  <button onClick={sec.onOpen}>{sec.title}</button>
                  <small>{sec.areas.length}</small>
                  <i />
                </div>
              )}
              <div className={`ar-chips${checked.size > 0 ? ' has-selection' : ''}`}>
                {sec.areas.map(a => (
                  <AreaChip key={a.id} a={a} checked={checked.has(a.id)} flash={flashId === a.id}
                    onActivate={activateChip} onToggle={toggleChecked} onDragStart={chipDragStart} onDragEnd={chipDragEnd} />
                ))}
              </div>
            </div>
          ))}

          {checked.size > 0 ? (
            <div className="ar-dock">
              <span>✓ {checked.size} محددة</span>
              <select className="ar-select" value="" disabled={busy} aria-label="نقل المحددة إلى"
                onChange={e => {
                  if (!e.target.value) return;
                  const { provinceId, subProvinceId } = parseTarget(e.target.value);
                  moveAreas([...checked], provinceId, subProvinceId);
                  setChecked(new Set());
                }}>
                <option value="">نقل إلى…</option>
                <ProvinceOptions provinces={provincesSorted} subProvinces={subProvinces} />
              </select>
              <button className="ar-dock-btn" onClick={() => setChecked(new Set())} style={{ marginInlineStart: 'auto' }}>إلغاء</button>
            </div>
          ) : undo && (
            <div className="ar-dock">
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={undo.label}>✅ {undo.label}</span>
              <button className="ar-dock-btn" disabled={busy} onClick={undoMove}>↩ تراجع</button>
              <button className="ar-dock-btn" onClick={() => setUndo(null)} title="إغلاق">✕</button>
            </div>
          )}
        </div>
      </div>

      {inspected && (
        <AreaDrawer key={inspected.id} area={inspected} areas={areas} provinces={provincesSorted} subProvinces={subProvinces} busy={anyBusy}
          inQueue={reviewQueue.some(x => x.id === inspected.id)}
          onClose={closeDrawer} onRename={renameArea}
          onMove={(ids, p, s) => moveAreas(ids, p, s)} onSub={(id, s) => (s == null ? assignSubOnly([id], null) : moveAreas([id], inspected.provinceId, s))}
          onPin={pinConflict} onSplit={splitConflict} onMerge={mergeInto} onDelete={openDelete} onConfirmReview={confirmReviewItem} />
      )}

      {reviewOpen && (
        <ReviewDeck queue={reviewQueue} areas={areas} provinces={provincesSorted} subProvinces={subProvinces} busy={anyBusy}
          onClose={closeReview} onConfirm={confirmReviewItem} onLink={linkReviewItem} onConfirmMany={confirmManyReview}
          onMove={(id, val) => { const t = parseTarget(val); moveAreas([id], t.provinceId, t.subProvinceId, { noUndo: true }); }} />
      )}

      {mergeSugs !== null && (
        <Modal title={`🔍 اقتراحات دمج المناطق المتشابهة (${mergeSugs.length})`} maxWidth={640} onClose={() => setMergeSugs(null)}>
          {mergeSugs.length === 0 ? (
            <div style={{ fontSize: 13, color: UI.muted, padding: '6px 2px' }}>لا توجد مناطق متشابهة تحتاج مراجعة.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {mergeSugs.map((s, i) => {
                const keep = s.b.sales > s.a.sales ? s.b : s.a;
                const drop = keep === s.a ? s.b : s.a;
                return (
                  <div key={`${s.a.id}-${s.b.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 10, padding: '8px 12px', fontSize: 13, flexWrap: 'wrap' }}>
                    <span style={{ flex: 1, minWidth: 180 }}>
                      <b>{s.a.name}</b> <span style={{ color: UI.faint, fontSize: 11 }}>({s.a.sales} مبيعة)</span>
                      <span style={{ color: '#d97706', margin: '0 6px' }}>↔</span>
                      <b>{s.b.name}</b> <span style={{ color: UI.faint, fontSize: 11 }}>({s.b.sales} مبيعة)</span>
                    </span>
                    <button disabled={anyBusy} onClick={async () => { if (await mergeInto(drop.id, keep.id, drop.name, keep.name)) setMergeSugs(prev => prev ? prev.filter((_, idx) => idx !== i) : prev); }}
                      style={{ ...btnStyle('#0d9488', true), fontSize: 11.5, padding: '4px 10px' }}>دمج في «{keep.name}»</button>
                    <button disabled={anyBusy} onClick={() => setMergeSugs(prev => prev ? prev.filter((_, idx) => idx !== i) : prev)}
                      style={{ ...btnStyle('#94a3b8', true), fontSize: 11.5, padding: '4px 10px' }}>تجاهل</button>
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      )}

      {/* 🗑️ نافذة حذف منطقة */}
      {deleteInfo && (() => {
        const rows = Object.entries(deleteInfo.usage).filter(([, v]) => v > 0);
        const isEmpty = deleteInfo.total === 0;
        return (
          <div onClick={() => !busy && setDeleteInfo(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 22, width: 'min(460px, 92vw)', maxHeight: '85vh', overflowY: 'auto', direction: 'rtl', boxShadow: '0 20px 50px rgba(0,0,0,0.3)' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 17, color: '#0f172a' }}>🗑️ حذف منطقة «{deleteInfo.name}»</h3>
              {isEmpty ? (
                <p style={{ fontSize: 14, color: '#475569', margin: '0 0 16px' }}>لا توجد أي بيانات مرتبطة بهذه المنطقة. يمكن حذفها مباشرة.</p>
              ) : (
                <>
                  <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: 12, marginBottom: 14 }}>
                    <strong style={{ fontSize: 13, color: '#92400e' }}>⚠️ هذه المنطقة مرتبطة ببيانات:</strong>
                    <ul style={{ margin: '8px 0 0', paddingInlineStart: 20, fontSize: 13, color: '#78350f' }}>
                      {rows.map(([k, v]) => <li key={k}>{USAGE_LABELS[k] || k}: <b>{v}</b></li>)}
                    </ul>
                  </div>
                  {deleteInfo.pharmacyVisitDetails.length > 0 && (
                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, marginBottom: 14 }}>
                      <strong style={{ fontSize: 12.5, color: '#334155' }}>🧾 تفاصيل زيارات الصيدليات:</strong>
                      <ul style={{ margin: '6px 0 0', paddingInlineStart: 18, fontSize: 12.5, color: '#475569', maxHeight: 140, overflowY: 'auto' }}>
                        {deleteInfo.pharmacyVisitDetails.map((v, i) => (
                          <li key={i}>{v.repName ?? 'مندوب غير معروف'} — {v.pharmacyName} <span style={{ color: '#94a3b8' }}>({new Date(v.visitDate).toLocaleDateString('ar-IQ')})</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {deleteInfo.blocking && (
                    <p style={{ fontSize: 12.5, color: '#b91c1c', margin: '0 0 12px' }}>
                      ⛔ لوجود مبيعات مرتبطة لا يمكن «تصفير» المنطقة — يجب <b>نقل</b> بياناتها إلى منطقة أخرى قبل الحذف.
                    </p>
                  )}
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>① نقل البيانات إلى منطقة أخرى ثم الحذف:</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select value={deleteTransferTo} onChange={e => setDeleteTransferTo(e.target.value ? Number(e.target.value) : '')} disabled={busy}
                        style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl' }}>
                        <option value="">— اختر منطقة الوجهة —</option>
                        {areas.filter(a => a.id !== deleteInfo.id).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                      <button onClick={() => confirmDelete('transfer')} disabled={busy || !deleteTransferTo} style={{ ...btnStyle('#0d9488', true), fontSize: 13, opacity: (busy || !deleteTransferTo) ? 0.5 : 1 }}>نقل وحذف</button>
                    </div>
                  </div>
                </>
              )}
              {!deleteInfo.blocking && (
                <div style={{ marginBottom: 14 }}>
                  {!isEmpty && <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>② تصفير (فصل) البيانات ثم الحذف:</div>}
                  <button onClick={() => confirmDelete('detach')} disabled={busy} style={{ ...btnStyle('#dc2626', true), fontSize: 13, padding: '6px 16px', width: '100%' }}>
                    {busy ? '...' : (isEmpty ? '🗑️ حذف المنطقة' : '🗑️ تصفير البيانات وحذف المنطقة')}
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <button onClick={() => setDeleteInfo(null)} disabled={busy} style={{ ...btnStyle('#64748b', true), fontSize: 13 }}>إلغاء</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
