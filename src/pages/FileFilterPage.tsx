/**
 * FileFilterPage — تنقية الملفات
 *
 * يعرض 3 لوحات فقط: 🏢 الشركة | 📦 الايتم (مع بونص%) | 👤 المندوب
 *
 * الذاكرة التلقائية:
 *   ff_excl_co   — string[] قيم الشركات المستثناة
 *   ff_excl_item — string[] قيم الايتمات المستثناة
 *   ff_excl_rep  — string[] قيم المندوبين المستثناة
 *   ff_bonus     — Record<item, bonus%> قيمة البونص لكل ايتم
 * تُحفظ تلقائياً وتُطبَّق على كل ملف جديد.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';

/* ══ Storage ══════════════════════════════════════════════ */
const LS_CO    = 'ff_excl_co';
const LS_ITEM  = 'ff_excl_item';
const LS_REP   = 'ff_excl_rep';
const LS_BONUS = 'ff_bonus';

function loadExcl(key: string): Set<string> {
  try { return new Set<string>(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveExcl(key: string, s: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...s]));
}
function loadBonusMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_BONUS) || '{}'); } catch { return {}; }
}
function saveBonusMap(m: Record<string, string>) {
  localStorage.setItem(LS_BONUS, JSON.stringify(m));
}

/* ══ Column auto-detection ════════════════════════════════ */
const H_CO    = ['الصنف','صنف','اسم الصنف','الشركة','الشركه','شركة','شركه','company','اسم الشركة','اسم الشركه','الشركات'];
const H_ITEM  = ['الايتم','ايتم','item','اسم الايتم','المنتج','product','اسم المنتج'];
const H_REP   = ['مندوب','المندوب','rep','اسم المندوب','ممثل','مسوق','المندوب','اسم المندوب'];
const H_BONUS = ['بونص','bonus','مكافأة','مكافاة','عمولة','incentive','commission'];

function findCol(headers: string[], hints: string[]): number {
  for (const h of hints) {
    const i = headers.findIndex(c => c.trim().toLowerCase() === h.toLowerCase());
    if (i !== -1) return i;
  }
  for (const h of hints) {
    const i = headers.findIndex(c => c.trim().toLowerCase().includes(h.toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}

/* ══ Types ════════════════════════════════════════════════ */
interface Entry { value: string; selected: boolean; bonus: string; }
type Step = 'upload' | 'filter';

/* ══ Cascade helpers ══════════════════════════════════════ */
/**
 * When companies change → select/deselect items based on company membership,
 * but ALWAYS respect manualExclItems (user's explicit deselections are never overridden).
 * Then cascade further to reps.
 */
function cascadeFromCompanies(
  nextCo: Entry[], curItems: Entry[], curReps: Entry[],
  rows: string[][], coIdx: number, itemIdx: number, repIdx: number,
  manualExclItems: Set<string>, manualExclReps: Set<string>,
): { items: Entry[]; reps: Entry[] } {
  const selCo = new Set(nextCo.filter(c => c.selected).map(c => c.value));

  // Items that have at least one row under a still-selected company
  const itemsUnderSelCo = new Set<string>();
  rows.forEach(row => {
    const co   = coIdx   >= 0 ? row[coIdx]   : null;
    const item = itemIdx >= 0 ? row[itemIdx] : null;
    if (item !== null && (co === null || selCo.has(co))) itemsUnderSelCo.add(item);
  });

  // Item is selected if it belongs to a selected company AND was NOT manually deselected by user
  const nextItems = curItems.map(it => ({
    ...it,
    selected: itemsUnderSelCo.has(it.value) && !manualExclItems.has(it.value),
  }));

  const { reps: nextReps } = cascadeFromItems(
    nextItems, nextCo, curReps, rows, coIdx, itemIdx, repIdx, manualExclReps,
  );
  return { items: nextItems, reps: nextReps };
}

/**
 * When items change → select/deselect reps based on whether they have a valid row,
 * but ALWAYS respect manualExclReps (user's explicit rep deselections are never overridden).
 */
function cascadeFromItems(
  nextItems: Entry[], curCo: Entry[], curReps: Entry[],
  rows: string[][], coIdx: number, itemIdx: number, repIdx: number,
  manualExclReps: Set<string>,
): { reps: Entry[] } {
  const selCo   = new Set(curCo.filter(c => c.selected).map(c => c.value));
  const selItem = new Set(nextItems.filter(i => i.selected).map(i => i.value));

  const repsWithValidRow = new Set<string>();
  rows.forEach(row => {
    const co   = coIdx   >= 0 ? row[coIdx]   : null;
    const item = itemIdx >= 0 ? row[itemIdx] : null;
    const rep  = repIdx  >= 0 ? row[repIdx]  : null;
    if (
      rep !== null &&
      (co   === null || selCo.has(co)) &&
      (item === null || selItem.has(item))
    ) repsWithValidRow.add(rep);
  });

  // Rep is selected if it has a valid row AND was NOT manually deselected by user
  const nextReps = curReps.map(r => ({
    ...r,
    selected: repsWithValidRow.has(r.value) && !manualExclReps.has(r.value),
  }));
  return { reps: nextReps };
}

/* ══ Excel helpers ════════════════════════════════════════ */
function readXlsx(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = e => {
      try {
        const wb   = XLSX.read(e.target!.result, { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (!raw.length) throw new Error('الملف فارغ');
        const headers = (raw[0] as any[]).map(String);
        const rows    = raw.slice(1).map(r => headers.map((_, i) => String(r[i] ?? '')));
        resolve({ headers, rows });
      } catch (e: any) { reject(e); }
    };
    fr.onerror = () => reject(new Error('فشل قراءة الملف'));
    fr.readAsArrayBuffer(file);
  });
}

/* ══ SavedInfo (shown on upload screen) ══════════════════ */
function SavedInfo({ resetKey, onReset }: { resetKey: number; onReset: () => void }) {
  // read fresh on every render (resetKey forces re-render)
  const exCo   = [...loadExcl(LS_CO)];
  const exItem = [...loadExcl(LS_ITEM)];
  const exRep  = [...loadExcl(LS_REP)];
  const bonuses = Object.entries(loadBonusMap()).filter(([, v]) => v !== '');

  if (!exCo.length && !exItem.length && !exRep.length && !bonuses.length) return null;
  void resetKey; // used only to trigger re-render

  return (
    <div style={{ marginTop: 20, padding: '14px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: '#166534' }}>⚡ إعدادات محفوظة — ستُطبَّق تلقائياً</span>
        <button
          onClick={onReset}
          style={{ background: 'none', border: '1px solid #fca5a5', borderRadius: 6, padding: '3px 10px', fontSize: 11, cursor: 'pointer', color: '#dc2626' }}
        >مسح الكل</button>
      </div>
      {exCo.length   > 0 && <div style={{ fontSize: 12, color: '#15803d', marginBottom: 2 }}>🏢 {exCo.length} شركة مستثناة</div>}
      {exItem.length > 0 && <div style={{ fontSize: 12, color: '#15803d', marginBottom: 2 }}>📦 {exItem.length} ايتم مستثنى</div>}
      {exRep.length  > 0 && <div style={{ fontSize: 12, color: '#15803d', marginBottom: 2 }}>👤 {exRep.length} مندوب مستثنى</div>}
      {bonuses.length > 0 && <div style={{ fontSize: 12, color: '#15803d' }}>💰 بونص% محفوظ لـ {bonuses.length} ايتم</div>}
    </div>
  );
}

/* ══ Panel Component ══════════════════════════════════════ */
function Panel({
  icon, title, items, onChange, showBonus,
}: {
  icon: string;
  title: string;
  items: Entry[];
  onChange: (next: Entry[]) => void;
  showBonus?: boolean;
}) {
  const [search, setSearch] = useState('');

  const visible    = items.filter(it => !search || it.value.toLowerCase().includes(search.toLowerCase()));
  const selCount   = items.filter(i => i.selected).length;
  const allVisSelected = visible.length > 0 && visible.every(i => i.selected);
  const visSet     = new Set(visible.map(v => v.value));

  const toggle = (val: string) =>
    onChange(items.map(i => i.value === val ? { ...i, selected: !i.selected } : i));

  const toggleAll = () => {
    if (allVisSelected)
      onChange(items.map(i => visSet.has(i.value) ? { ...i, selected: false } : i));
    else
      onChange(items.map(i => visSet.has(i.value) ? { ...i, selected: true  } : i));
  };

  const setBonus = (val: string, bonus: string) =>
    onChange(items.map(i => i.value === val ? { ...i, bonus } : i));

  return (
    <div style={{
      flex: showBonus ? '1 1 300px' : '1 1 220px',
      minWidth: 200, display: 'flex', flexDirection: 'column',
      background: '#fff', border: '1px solid #e2e8f0',
      borderRadius: 14, overflow: 'hidden',
      boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
    }}>

      {/* ── Header ── */}
      <div style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>{icon} {title}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: selCount === items.length ? '#16a34a' : '#1a56db', background: selCount === items.length ? '#f0fdf4' : '#eff6ff', padding: '2px 8px', borderRadius: 10, border: `1px solid ${selCount === items.length ? '#bbf7d0' : '#bfdbfe'}` }}>
            {selCount}/{items.length}
          </span>
        </div>
        <button
          onClick={toggleAll}
          style={{
            width: '100%', fontSize: 11, padding: '5px', borderRadius: 7, cursor: 'pointer', marginBottom: 8,
            background: allVisSelected ? '#fef2f2' : '#f0fdf4',
            color:      allVisSelected ? '#dc2626' : '#16a34a',
            border:     `1px solid ${allVisSelected ? '#fecaca' : '#bbf7d0'}`,
            fontWeight: 600,
          }}
        >{allVisSelected ? 'إلغاء تحديد الكل' : 'تحديد الكل'}</button>
        <input
          type="text" placeholder="بحث..." value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, outline: 'none', background: '#fff', boxSizing: 'border-box' }}
        />
      </div>

      {/* ── List ── */}
      <div style={{ overflowY: 'auto', flex: 1, maxHeight: 460 }}>
        {visible.length === 0 && (
          <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>لا نتائج</div>
        )}
        {visible.map(it => (
          <label
            key={it.value}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: showBonus ? '7px 12px' : '8px 14px',
              borderBottom: '1px solid #f1f5f9',
              background: it.selected ? '#f0fdf4' : '#fff',
              cursor: 'pointer', transition: 'background .1s',
            }}
          >
            <input
              type="checkbox" checked={it.selected} onChange={() => toggle(it.value)}
              style={{ accentColor: '#1a56db', width: 15, height: 15, flexShrink: 0, cursor: 'pointer' }}
            />
            <span style={{
              flex: 1, fontSize: 12, minWidth: 0,
              color: it.selected ? '#1e293b' : '#94a3b8',
              fontWeight: it.selected ? 500 : 400,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {it.value || '(فارغ)'}
            </span>

            {/* Bonus % input — only for items panel, only when selected */}
            {showBonus && it.selected && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }} onClick={e => e.preventDefault()}>
                <input
                  type="number" placeholder="0"
                  value={it.bonus}
                  onChange={e => setBonus(it.value, e.target.value)}
                  onClick={e => e.stopPropagation()}
                  style={{
                    width: 62, padding: '3px 6px', borderRadius: 6, fontSize: 12,
                    border: it.bonus ? '1px solid #86efac' : '1px solid #d1d5db',
                    background: it.bonus ? '#f0fdf4' : '#f8fafc',
                    outline: 'none', textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>%</span>
              </div>
            )}
          </label>
        ))}
      </div>
    </div>
  );
}

/* ══ Main Page ════════════════════════════════════════════ */
export default function FileFilterPage() {
  const [step,     setStep]     = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [headers,  setHeaders]  = useState<string[]>([]);
  const [allRows,  setAllRows]  = useState<string[][]>([]);

  // Detected column indices
  const [coIdx,    setCoIdx]    = useState(-1);
  const [itemIdx,  setItemIdx]  = useState(-1);
  const [repIdx,   setRepIdx]   = useState(-1);
  const [bonusIdx, setBonusIdx] = useState(-1);

  // Filter lists
  const [companies, setCompanies] = useState<Entry[]>([]);
  const [items,     setItems]     = useState<Entry[]>([]);
  const [reps,      setReps]      = useState<Entry[]>([]);

  const [dragActive,  setDragActive]  = useState(false);
  const [error,       setError]       = useState('');
  const [loading,     setLoading]     = useState(false);
  const [autoSaved,   setAutoSaved]   = useState(false);
  const [appliedMsg,  setAppliedMsg]  = useState('');
  const [resetKey,    setResetKey]    = useState(0);   // forces SavedInfo re-render

  const fileInputRef     = useRef<HTMLInputElement>(null);
  const saveTimer        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allRowsRef       = useRef<string[][]>([]);
  const manualExclItems  = useRef<Set<string>>(loadExcl(LS_ITEM)); // user's explicit item deselections
  const manualExclReps   = useRef<Set<string>>(loadExcl(LS_REP));  // user's explicit rep deselections
  allRowsRef.current = allRows;

  /* ── Auto-save selections (debounced 400ms) ── */
  useEffect(() => {
    if (step !== 'filter') return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveExcl(LS_CO,   new Set(companies.filter(c => !c.selected).map(c => c.value)));
      saveExcl(LS_ITEM, new Set(items.filter(i => !i.selected).map(i => i.value)));
      saveExcl(LS_REP,  new Set(reps.filter(r => !r.selected).map(r => r.value)));
      setAutoSaved(true);
      setTimeout(() => setAutoSaved(false), 1600);
    }, 400);
  }, [companies, items, reps, step]);

  /* ── Auto-save bonus (immediate) ── */
  useEffect(() => {
    if (step !== 'filter') return;
    const m = loadBonusMap();
    items.forEach(it => { m[it.value] = it.bonus; });
    saveBonusMap(m);
  }, [items, step]);

  /* ── Rebuild companies when coIdx changes manually ── */
  useEffect(() => {
    if (step !== 'filter' || !allRowsRef.current.length) return;
    if (coIdx < 0) { setCompanies([]); return; }
    const exCo  = loadExcl(LS_CO);
    const unique = [...new Set(allRowsRef.current.map(r => r[coIdx]))].sort((a, b) => a.localeCompare(b, 'ar'));
    setCompanies(unique.map(v => ({ value: v, selected: !exCo.has(v), bonus: '' })));
  }, [coIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Rebuild items when itemIdx changes manually ── */
  useEffect(() => {
    if (step !== 'filter' || !allRowsRef.current.length) return;
    if (itemIdx < 0) { setItems([]); return; }
    const exItem  = loadExcl(LS_ITEM);
    const bonusM  = loadBonusMap();
    const unique  = [...new Set(allRowsRef.current.map(r => r[itemIdx]))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ar'));
    setItems(unique.map(v => ({ value: v, selected: !exItem.has(v), bonus: bonusM[v] ?? '' })));
  }, [itemIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Rebuild reps when repIdx changes manually ── */
  useEffect(() => {
    if (step !== 'filter' || !allRowsRef.current.length) return;
    if (repIdx < 0) { setReps([]); return; }
    const exRep  = loadExcl(LS_REP);
    const unique = [...new Set(allRowsRef.current.map(r => r[repIdx]))].sort((a, b) => a.localeCompare(b, 'ar'));
    setReps(unique.map(v => ({ value: v, selected: !exRep.has(v), bonus: '' })));
  }, [repIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Derived: filtered rows ── */
  const selCo   = new Set(companies.filter(c => c.selected).map(c => c.value));
  const selItem = new Set(items.filter(i => i.selected).map(i => i.value));
  const selRep  = new Set(reps.filter(r => r.selected).map(r => r.value));

  const filteredRows = allRows.filter(row => {
    const co   = coIdx   >= 0 ? row[coIdx]   : null;
    const item = itemIdx >= 0 ? row[itemIdx] : null;
    const rep  = repIdx  >= 0 ? row[repIdx]  : null;
    return (co   === null || selCo.has(co))
        && (item === null || selItem.has(item))
        && (rep  === null || selRep.has(rep));
  });

  // Build export rows — fill bonus column if applicable
  const hasAnyBonus = items.some(i => i.bonus !== '');
  const exportHeaders = (bonusIdx < 0 && hasAnyBonus) ? [...headers, 'بونص%'] : headers;

  const exportRows = filteredRows.map(row => {
    const itemVal  = itemIdx >= 0 ? row[itemIdx] : '';
    const entry    = items.find(i => i.value.trim().toLowerCase() === itemVal.trim().toLowerCase());
    const bonusVal = entry?.bonus ?? '';

    if (bonusIdx >= 0 && bonusVal !== '') {
      // Fill existing bonus column
      const next = [...row]; next[bonusIdx] = bonusVal; return next;
    } else if (bonusIdx < 0 && hasAnyBonus) {
      // Append bonus% column
      return [...row, bonusVal];
    }
    return row;
  });

  /* ── File load ── */
  const handleFile = useCallback(async (file: File) => {
    setError('');
    setLoading(true);
    try {
      const { headers: h, rows } = await readXlsx(file);
      setFileName(file.name);
      setHeaders(h);
      setAllRows(rows);

      const ci = findCol(h, H_CO);
      let   ii = findCol(h, H_ITEM);
      const ri = findCol(h, H_REP);
      const bi = findCol(h, H_BONUS);
      // prevent same column being mapped to both company and item
      if (ci >= 0 && ii === ci) ii = -1;
      setCoIdx(ci); setItemIdx(ii); setRepIdx(ri); setBonusIdx(bi);

      const exCo   = loadExcl(LS_CO);
      const exItem = loadExcl(LS_ITEM);
      const exRep  = loadExcl(LS_REP);
      const bonusM = loadBonusMap();

      let applCo = 0, applItem = 0, applRep = 0, applBonus = 0;

      if (ci >= 0) {
        const unique = [...new Set(rows.map(r => r[ci]))].sort((a, b) => a.localeCompare(b, 'ar'));
        const list   = unique.map(v => ({ value: v, selected: !exCo.has(v), bonus: '' }));
        applCo = list.filter(x => !x.selected).length;
        setCompanies(list);
      } else setCompanies([]);

      if (ii >= 0) {
        const unique = [...new Set(rows.map(r => r[ii]))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ar'));
        const list: Entry[] = unique.map(v => {
          const bonus = bonusM[v] ?? '';
          if (bonus !== '') applBonus++;
          return { value: v, selected: !exItem.has(v), bonus };
        });
        applItem = list.filter(x => !x.selected).length;
        // Sync manual exclusion ref to match loaded state
        manualExclItems.current = new Set(list.filter(x => !x.selected).map(x => x.value));
        setItems(list);
      } else { manualExclItems.current = new Set(); setItems([]); }

      if (ri >= 0) {
        const unique = [...new Set(rows.map(r => r[ri]))].sort((a, b) => a.localeCompare(b, 'ar'));
        const list   = unique.map(v => ({ value: v, selected: !exRep.has(v), bonus: '' }));
        applRep = list.filter(x => !x.selected).length;
        // Sync manual exclusion ref to match loaded state
        manualExclReps.current = new Set(list.filter(x => !x.selected).map(x => x.value));
        setReps(list);
      } else { manualExclReps.current = new Set(); setReps([]); }

      const parts: string[] = [];
      if (applCo   > 0) parts.push(`${applCo} شركة`);
      if (applItem > 0) parts.push(`${applItem} ايتم`);
      if (applRep  > 0) parts.push(`${applRep} مندوب`);
      if (applBonus > 0) parts.push(`بونص ${applBonus} ايتم`);
      setAppliedMsg(parts.length > 0 ? `⚡ تم تطبيق: ${parts.join(' + ')} من الإعدادات المحفوظة` : '');

      setStep('filter');
    } catch (e: any) {
      setError(e.message || 'خطأ أثناء قراءة الملف');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragActive(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const doExport = () => {
    const ws = XLSX.utils.aoa_to_sheet([exportHeaders, ...exportRows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, fileName.replace(/\.(xlsx?|csv)$/i, '') + '_filtered.xlsx');
  };

  const resetSaved = () => {
    [LS_CO, LS_ITEM, LS_REP, LS_BONUS].forEach(k => localStorage.removeItem(k));
    setResetKey(k => k + 1);
  };

  /* ══════════════════════════════════════════════════════
     UPLOAD SCREEN
  ══════════════════════════════════════════════════════ */
  if (step === 'upload') {
    return (
      <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, direction: 'rtl' }}>
        <div style={{ maxWidth: 520, width: '100%' }}>

          {/* Title */}
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ fontSize: 44, marginBottom: 8 }}>🗂️</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>تنقية الملفات</h1>
            <p style={{ margin: '8px 0 0', fontSize: 13, color: '#64748b' }}>
              فلترة حسب الشركة والايتم والمندوب — مع تحديد البونص% لكل ايتم
            </p>
          </div>

          {/* Drop Zone */}
          <div
            onDragEnter={()  => setDragActive(true)}
            onDragLeave={()  => setDragActive(false)}
            onDragOver={e    => { e.preventDefault(); setDragActive(true); }}
            onDrop={handleDrop}
            onClick={() => !loading && fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragActive ? '#1a56db' : '#cbd5e1'}`,
              borderRadius: 16, padding: '48px 24px', textAlign: 'center',
              cursor: loading ? 'wait' : 'pointer',
              background: dragActive ? '#eff6ff' : '#fff',
              transition: 'all .2s',
            }}
          >
            <div style={{ fontSize: 38, marginBottom: 10 }}>{loading ? '⏳' : '📂'}</div>
            <div style={{ fontWeight: 600, fontSize: 15, color: '#1e293b', marginBottom: 4 }}>
              {loading ? 'جاري القراءة...' : 'اسحب ملف Excel هنا أو اضغط للاختيار'}
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>xlsx • xls • csv</div>
            <input
              ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); e.target.value = ''; }}
            />
          </div>

          {error && (
            <div style={{ marginTop: 14, padding: '10px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#dc2626', fontSize: 13 }}>
              {error}
            </div>
          )}

          <SavedInfo resetKey={resetKey} onReset={resetSaved} />
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════
     FILTER SCREEN
  ══════════════════════════════════════════════════════ */
  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', direction: 'rtl' }}>

      {/* ── Top Bar ── */}
      <div style={{
        background: '#fff', borderBottom: '1px solid #e2e8f0',
        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10,
        flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <button
          onClick={() => { setStep('upload'); setHeaders([]); setAllRows([]); setAppliedMsg(''); }}
          style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: '#475569', fontWeight: 600 }}
        >← رجوع</button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📄 {fileName}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
            {allRows.length.toLocaleString('ar-IQ')} صف إجمالاً ←&nbsp;
            <strong style={{ color: '#1a56db' }}>{filteredRows.length.toLocaleString('ar-IQ')} صف بعد الفلترة</strong>
          </div>
        </div>

        {autoSaved && (
          <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '3px 8px' }}>
            ✅ تم الحفظ التلقائي
          </span>
        )}

        <button
          onClick={doExport}
          disabled={filteredRows.length === 0}
          style={{
            background: filteredRows.length === 0 ? '#f1f5f9' : '#1a56db',
            border: 'none', borderRadius: 8, padding: '8px 18px',
            fontSize: 13, cursor: filteredRows.length === 0 ? 'not-allowed' : 'pointer',
            color: filteredRows.length === 0 ? '#94a3b8' : '#fff',
            fontWeight: 700, flexShrink: 0,
          }}
        >⬇️ تصدير ({filteredRows.length.toLocaleString('ar-IQ')})</button>
      </div>

      {/* ── Applied settings banner ── */}
      {appliedMsg && (
        <div style={{ background: '#f0fdf4', borderBottom: '1px solid #bbf7d0', padding: '8px 20px', fontSize: 12, color: '#15803d', fontWeight: 600 }}>
          {appliedMsg}
        </div>
      )}

      {/* ── Column picker (shown if any column not detected) ── */}
      {(coIdx < 0 || itemIdx < 0 || repIdx < 0) && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fde68a', padding: '12px 20px' }}>
          <div style={{ fontSize: 12, color: '#92400e', fontWeight: 600, marginBottom: 8 }}>
            ⚠️ لم يتم اكتشاف بعض الأعمدة تلقائياً — حددها يدوياً:
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            {([
              { label: '🏢 عمود الشركة',  idx: coIdx,    set: setCoIdx },
              { label: '📦 عمود الايتم',  idx: itemIdx,  set: setItemIdx },
              { label: '👤 عمود المندوب', idx: repIdx,   set: setRepIdx },
              { label: '💰 عمود البونص',  idx: bonusIdx, set: setBonusIdx },
            ] as const).map(({ label, idx, set }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: '#78350f', fontWeight: 600, whiteSpace: 'nowrap' }}>{label}:</span>
                <select
                  value={idx}
                  onChange={e => (set as (v: number) => void)(Number(e.target.value))}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #fde68a', background: '#fff', outline: 'none', cursor: 'pointer' }}
                >
                  <option value={-1}>— لا يوجد —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 3 Panels ── */}
      <div style={{ padding: 20, display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {coIdx >= 0 && companies.length > 0 && (
          <Panel icon="🏢" title="الشركة" items={companies} onChange={nextCo => {
            const { items: nextItems, reps: nextReps } =
              cascadeFromCompanies(
                nextCo, items, reps, allRows, coIdx, itemIdx, repIdx,
                manualExclItems.current, manualExclReps.current,
              );
            setCompanies(nextCo);
            setItems(nextItems);
            setReps(nextReps);
          }} />
        )}

        {itemIdx >= 0 && items.length > 0 && (
          <Panel icon="📦" title="الايتم" items={items} onChange={nextItems => {
            // Update manual exclusions ref — this is a user-driven change
            manualExclItems.current = new Set(
              nextItems.filter(i => !i.selected).map(i => i.value)
            );
            const { reps: nextReps } =
              cascadeFromItems(
                nextItems, companies, reps, allRows, coIdx, itemIdx, repIdx,
                manualExclReps.current,
              );
            setItems(nextItems);
            setReps(nextReps);
          }} showBonus />
        )}

        {repIdx >= 0 && reps.length > 0 && (
          <Panel icon="👤" title="المندوب" items={reps} onChange={nextReps => {
            // Update manual exclusions ref — this is a user-driven change
            manualExclReps.current = new Set(
              nextReps.filter(r => !r.selected).map(r => r.value)
            );
            setReps(nextReps);
          }} />
        )}

        {coIdx < 0 && itemIdx < 0 && repIdx < 0 && (
          <div style={{ width: '100%', padding: '60px 20px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
            لم يتم اكتشاف أعمدة الشركة أو الايتم أو المندوب.<br />
            حدد الأعمدة يدوياً من القائمة أعلاه.
          </div>
        )}
      </div>
    </div>
  );
}
