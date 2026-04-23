/**
 * FileFilterPage — صفحة تنقية الملفات
 *
 * مستقلة تماماً عن بقية الصفحات.
 * الوظيفة: رفع ملف Excel → تحديد قيم الفلترة لكل عمود → تعيين البونص لكل ايتم → تصدير الملف المنقى.
 *
 * الذاكرة التلقائية:
 *  - ff_auto_excluded : Record<colName, string[]>  — قيم مُستثناة بشكل دائم لكل عمود
 *  - ff_auto_bonus    : Record<itemName, string>   — قيمة البونص لكل ايتم
 *  كلاهما يُحفظ فور التعديل ويُطبَّق على كل ملف جديد.
 */

import { useState, useCallback, useRef } from 'react';
import { useEffect } from 'react';
import * as XLSX from 'xlsx';

/* ─── localStorage keys ─────────────────────────────── */
const LS_EXCLUDED = 'ff_auto_excluded';  // Record<colName, string[]>
const LS_BONUS    = 'ff_auto_bonus';     // Record<itemName, string>
const LS_PRESETS  = 'ff_presets';

/* ─── Types ─────────────────────────────────────────── */
interface ColFilter {
  values: string[];
  selected: Set<string>;
  search: string;
}
interface BonusRule {
  item: string;
  bonus: string;
}
type Step = 'upload' | 'filter';

/* ─── Storage helpers ────────────────────────────────── */
function loadExcluded(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(LS_EXCLUDED) || '{}'); } catch { return {}; }
}
function loadBonusMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_BONUS) || '{}'); } catch { return {}; }
}
function saveExcluded(map: Record<string, string[]>) {
  localStorage.setItem(LS_EXCLUDED, JSON.stringify(map));
}
function saveBonusMap(map: Record<string, string>) {
  localStorage.setItem(LS_BONUS, JSON.stringify(map));
}

/* ─── File helpers ───────────────────────────────────── */
function readXlsx(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target!.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (raw.length === 0) { reject(new Error('الملف فارغ')); return; }
        const headers = (raw[0] as any[]).map(String);
        const rows    = raw.slice(1).map(r => headers.map((_, i) => String(r[i] ?? '')));
        resolve({ headers, rows });
      } catch (err: any) { reject(err); }
    };
    reader.onerror = () => reject(new Error('فشل قراءة الملف'));
    reader.readAsArrayBuffer(file);
  });
}

function exportXlsx(headers: string[], rows: string[][], fileName: string) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, fileName.replace(/\.(xlsx?|csv)$/i, '') + '_filtered.xlsx');
}

const BONUS_COL_NAMES = ['بونص', 'bonus', 'مكافأة', 'مكافاة', 'incentive', 'commission', 'عمولة'];
const ITEM_COL_NAMES  = ['item', 'ايتم', 'اسم الايتم', 'المنتج', 'product', 'اسم المنتج'];

function detectCol(headers: string[], candidates: string[]): number {
  for (const h of candidates) {
    const idx = headers.findIndex(c => c.trim().toLowerCase() === h.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

/* ─── SavedSettingsInfo ──────────────────────────────── */
function SavedSettingsInfo({ onReset }: { onReset: () => void }) {
  const excluded = loadExcluded();
  const bonuses  = loadBonusMap();
  const colsWithExclusions = Object.entries(excluded).filter(([, v]) => v.length > 0);
  const itemsWithBonus     = Object.entries(bonuses).filter(([, v]) => v !== '');

  if (colsWithExclusions.length === 0 && itemsWithBonus.length === 0) return null;

  return (
    <div style={{
      marginTop: 20, padding: '14px 16px',
      background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: '#166534' }}>⚡ إعدادات محفوظة — ستُطبَّق تلقائياً</span>
        <button
          onClick={onReset}
          style={{
            background: 'none', border: '1px solid #fca5a5', borderRadius: 6,
            padding: '3px 10px', fontSize: 11, cursor: 'pointer', color: '#dc2626',
          }}
        >مسح الكل</button>
      </div>
      {colsWithExclusions.length > 0 && (
        <div style={{ fontSize: 12, color: '#15803d', marginBottom: 4 }}>
          🔽 فلاتر أعمدة لـ {colsWithExclusions.length} عمود:&nbsp;
          {colsWithExclusions.map(([col, vals]) => (
            <span key={col} style={{ background: '#dcfce7', borderRadius: 4, padding: '1px 6px', marginLeft: 4 }}>
              {col} ({vals.length} مستثنى)
            </span>
          ))}
        </div>
      )}
      {itemsWithBonus.length > 0 && (
        <div style={{ fontSize: 12, color: '#15803d' }}>
          💰 قواعد بونص لـ {itemsWithBonus.length} ايتم
        </div>
      )}
    </div>
  );
}

/* ─── ColFilterPanel ─────────────────────────────────── */
function ColFilterPanel({
  colName, filter, onChange,
}: {
  colName: string;
  filter: ColFilter;
  onChange: (f: ColFilter) => void;
}) {
  const visible    = filter.values.filter(v => !filter.search || v.toLowerCase().includes(filter.search.toLowerCase()));
  const allVisible = visible.every(v => filter.selected.has(v));
  const excludedCount = filter.values.length - filter.selected.size;

  const toggle = (v: string) => {
    const next = new Set(filter.selected);
    next.has(v) ? next.delete(v) : next.add(v);
    onChange({ ...filter, selected: next });
  };

  const toggleAll = () => {
    const next = new Set(filter.selected);
    if (allVisible) visible.forEach(v => next.delete(v));
    else            visible.forEach(v => next.add(v));
    onChange({ ...filter, selected: next });
  };

  return (
    <div style={{
      border: `1px solid ${excludedCount > 0 ? '#bfdbfe' : '#e2e8f0'}`,
      borderRadius: 12, overflow: 'hidden',
      background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
    }}>
      <div style={{
        background: excludedCount > 0 ? '#eff6ff' : '#f1f5f9',
        borderBottom: '1px solid #e2e8f0',
        padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: '#1e293b', flex: 1 }}>
          {colName}
          {excludedCount > 0
            ? <span style={{ fontWeight: 500, fontSize: 11, color: '#1a56db', marginRight: 6 }}>
                ✅ {filter.selected.size}/{filter.values.length}
              </span>
            : <span style={{ fontWeight: 400, fontSize: 11, color: '#64748b', marginRight: 6 }}>
                ({filter.values.length})
              </span>
          }
        </span>
        <button
          onClick={toggleAll}
          style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
            background: allVisible ? '#fef2f2' : '#f0fdf4',
            color:      allVisible ? '#dc2626' : '#16a34a',
            border: `1px solid ${allVisible ? '#fecaca' : '#bbf7d0'}`,
            fontWeight: 600,
          }}
        >{allVisible ? 'إلغاء الكل' : 'تحديد الكل'}</button>
      </div>
      <div style={{ padding: '8px 14px', borderBottom: '1px solid #f1f5f9' }}>
        <input
          type="text" placeholder="بحث..."
          value={filter.search} onChange={e => onChange({ ...filter, search: e.target.value })}
          style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, outline: 'none', background: '#f8fafc', boxSizing: 'border-box' }}
        />
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto', padding: '6px 0' }}>
        {visible.length === 0
          ? <div style={{ padding: '10px 14px', fontSize: 12, color: '#94a3b8' }}>لا توجد نتائج</div>
          : visible.map(v => (
            <label key={v} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '5px 14px', cursor: 'pointer',
              background: filter.selected.has(v) ? '#f0fdf4' : '#fef2f2', transition: 'background .1s',
            }}>
              <input
                type="checkbox" checked={filter.selected.has(v)} onChange={() => toggle(v)}
                style={{ accentColor: '#1a56db', width: 14, height: 14, flexShrink: 0 }}
              />
              <span style={{ fontSize: 12, color: filter.selected.has(v) ? '#1e293b' : '#94a3b8', wordBreak: 'break-word' }}>
                {v || <span style={{ fontStyle: 'italic' }}>فارغ</span>}
              </span>
            </label>
          ))
        }
      </div>
    </div>
  );
}

/* ─── BonusSearch ────────────────────────────────────── */
function BonusSearch({ bonusRules, setBonusRules }: {
  bonusRules: BonusRule[];
  setBonusRules: React.Dispatch<React.SetStateAction<BonusRule[]>>;
}) {
  const [search, setSearch] = useState('');
  const visible = bonusRules.filter(r => !search || r.item.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9' }}>
        <input
          type="text" placeholder="بحث عن ايتم..." value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '5px 10px', borderRadius: 7, border: '1px solid #e2e8f0', fontSize: 12, outline: 'none', background: '#f8fafc', boxSizing: 'border-box' }}
        />
      </div>
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {visible.map((rule) => {
          const ri = bonusRules.indexOf(rule);
          return (
            <div key={rule.item} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
              borderBottom: ri < bonusRules.length - 1 ? '1px solid #f1f5f9' : undefined,
              background: rule.bonus !== '' ? '#f0fdf4' : undefined,
            }}>
              <span style={{ flex: 1, fontSize: 12, color: '#1e293b', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {rule.item}
              </span>
              <input
                type="number" placeholder="0" value={rule.bonus}
                onChange={e => {
                  setBonusRules(prev => {
                    const next = [...prev];
                    next[ri] = { ...next[ri], bonus: e.target.value };
                    return next;
                  });
                }}
                style={{
                  width: 78, padding: '4px 8px', borderRadius: 6,
                  border: rule.bonus !== '' ? '1px solid #86efac' : '1px solid #e2e8f0',
                  background: rule.bonus !== '' ? '#f0fdf4' : '#f8fafc',
                  fontSize: 12, outline: 'none', textAlign: 'left',
                }}
              />
            </div>
          );
        })}
        {visible.length === 0 && (
          <div style={{ padding: 14, textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>لا نتائج</div>
        )}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════ */
export default function FileFilterPage() {
  const [step, setStep]             = useState<Step>('upload');
  const [fileName, setFileName]     = useState('');
  const [headers, setHeaders]       = useState<string[]>([]);
  const [allRows, setAllRows]       = useState<string[][]>([]);
  const [colFilters, setColFilters] = useState<Record<number, ColFilter>>({});
  const [bonusCol, setBonusCol]     = useState<number>(-1);
  const [itemColIdx, setItemColIdx] = useState<number>(-1);
  const [bonusRules, setBonusRules] = useState<BonusRule[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [autoSaved, setAutoSaved]   = useState(false);
  const [appliedMsg, setAppliedMsg] = useState('');

  // Named presets
  const [savedPresets, setSavedPresets] = useState<{ name: string; filters: Record<string, string[]>; bonuses: Record<string, string> }[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_PRESETS) || '[]'); } catch { return []; }
  });
  const [presetName, setPresetName]           = useState('');
  const [showPresetPanel, setShowPresetPanel] = useState(false);

  const fileInputRef  = useRef<HTMLInputElement>(null);
  const saveTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Auto-save col filters (debounced 400ms) ── */
  useEffect(() => {
    if (step !== 'filter' || headers.length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const existing = loadExcluded();
      headers.forEach((colName, ci) => {
        if (!colFilters[ci]) return;
        existing[colName] = colFilters[ci].values.filter(v => !colFilters[ci].selected.has(v));
      });
      saveExcluded(existing);
      setAutoSaved(true);
      setTimeout(() => setAutoSaved(false), 1600);
    }, 400);
  }, [colFilters, step, headers]);

  /* ── Auto-save bonus rules ── */
  useEffect(() => {
    if (step !== 'filter') return;
    const existing = loadBonusMap();
    bonusRules.forEach(r => { existing[r.item] = r.bonus; });
    saveBonusMap(existing);
  }, [bonusRules, step]);

  /* ── Derived: filtered rows + apply bonus ── */
  const filteredRows = allRows.filter(row =>
    Object.entries(colFilters).every(([ci, f]) => {
      const val = row[Number(ci)] ?? '';
      return f.selected.size === 0 || f.selected.has(val);
    })
  );

  const exportRows = bonusCol >= 0
    ? filteredRows.map(row => {
        const itemVal = itemColIdx >= 0 ? row[itemColIdx] : '';
        const rule = bonusRules.find(r => r.item.trim().toLowerCase() === itemVal.trim().toLowerCase());
        if (rule && rule.bonus !== '') {
          const next = [...row]; next[bonusCol] = rule.bonus; return next;
        }
        return row;
      })
    : filteredRows;

  /* ── File load ── */
  const handleFile = useCallback(async (file: File) => {
    setError('');
    setLoading(true);
    try {
      const { headers: h, rows } = await readXlsx(file);
      setFileName(file.name);
      setHeaders(h);
      setAllRows(rows);

      const excludedMap = loadExcluded();
      const bonusMap    = loadBonusMap();
      let appliedCols   = 0;

      // Build col filters — apply saved exclusions by column NAME
      const filters: Record<number, ColFilter> = {};
      h.forEach((colName, ci) => {
        const unique   = [...new Set(rows.map(r => r[ci] ?? ''))].sort((a, b) => a.localeCompare(b, 'ar'));
        const excluded = new Set(excludedMap[colName] ?? []);
        // Only exclude values that actually exist in this file
        const effectiveExcluded = new Set([...excluded].filter(v => unique.includes(v)));
        const selected = new Set(unique.filter(v => !effectiveExcluded.has(v)));
        if (effectiveExcluded.size > 0) appliedCols++;
        filters[ci] = { values: unique, selected, search: '' };
      });
      setColFilters(filters);

      const bIdx = detectCol(h, BONUS_COL_NAMES);
      const iIdx = detectCol(h, ITEM_COL_NAMES);
      setBonusCol(bIdx);
      setItemColIdx(iIdx);

      // Build bonus rules — auto-fill from saved bonus map
      let appliedBonus = 0;
      if (bIdx >= 0 && iIdx >= 0) {
        const items = [...new Set(rows.map(r => r[iIdx] ?? ''))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ar'));
        const rules = items.map(item => {
          const saved = bonusMap[item] ?? '';
          if (saved !== '') appliedBonus++;
          return { item, bonus: saved };
        });
        setBonusRules(rules);
      } else {
        setBonusRules([]);
      }

      const parts: string[] = [];
      if (appliedCols  > 0) parts.push(`فلاتر ${appliedCols} عمود`);
      if (appliedBonus > 0) parts.push(`بونص ${appliedBonus} ايتم`);
      setAppliedMsg(parts.length > 0 ? `⚡ تم تطبيق: ${parts.join(' + ')} من الإعدادات المحفوظة` : '');

      setStep('filter');
    } catch (err: any) {
      setError(err.message || 'خطأ أثناء قراءة الملف');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  /* ── Named preset save/load ── */
  const savePreset = () => {
    if (!presetName.trim()) return;
    const filters: Record<string, string[]> = {};
    headers.forEach((colName, ci) => {
      if (colFilters[ci]) filters[colName] = colFilters[ci].values.filter(v => !colFilters[ci].selected.has(v));
    });
    const bonuses: Record<string, string> = {};
    bonusRules.forEach(r => { if (r.bonus !== '') bonuses[r.item] = r.bonus; });
    const preset = { name: presetName.trim(), filters, bonuses };
    const next   = [...savedPresets.filter(p => p.name !== preset.name), preset];
    setSavedPresets(next);
    localStorage.setItem(LS_PRESETS, JSON.stringify(next));
    setPresetName('');
  };

  const loadPreset = (preset: typeof savedPresets[0]) => {
    setColFilters(prev => {
      const next = { ...prev };
      headers.forEach((colName, ci) => {
        if (!next[ci]) return;
        const excluded = new Set(preset.filters[colName] ?? []);
        next[ci] = { ...next[ci], selected: new Set(next[ci].values.filter(v => !excluded.has(v))) };
      });
      return next;
    });
    setBonusRules(prev => prev.map(r => ({ ...r, bonus: preset.bonuses[r.item] ?? r.bonus })));
    setShowPresetPanel(false);
  };

  const deletePreset = (name: string) => {
    const next = savedPresets.filter(p => p.name !== name);
    setSavedPresets(next);
    localStorage.setItem(LS_PRESETS, JSON.stringify(next));
  };

  const resetAllAutoSettings = () => {
    localStorage.removeItem(LS_EXCLUDED);
    localStorage.removeItem(LS_BONUS);
    // Force re-render info panel
    setSavedPresets(prev => [...prev]);
  };

  /* ══════════════════════════════════════════════════
     RENDER — Upload step
  ══════════════════════════════════════════════════ */
  if (step === 'upload') {
    return (
      <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, direction: 'rtl' }}>
        <div style={{ maxWidth: 540, width: '100%' }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ fontSize: 42, marginBottom: 10 }}>🗂️</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>تنقية الملفات</h1>
            <p style={{ margin: '8px 0 0', fontSize: 13, color: '#64748b' }}>
              ارفع ملف Excel — سيتم تطبيق إعداداتك المحفوظة تلقائياً
            </p>
          </div>

          {/* Drop Zone */}
          <div
            onDragEnter={() => setDragActive(true)}
            onDragLeave={() => setDragActive(false)}
            onDragOver={e => { e.preventDefault(); setDragActive(true); }}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragActive ? '#1a56db' : '#cbd5e1'}`,
              borderRadius: 16, padding: '44px 24px', textAlign: 'center',
              cursor: loading ? 'wait' : 'pointer',
              background: dragActive ? '#eff6ff' : '#fff',
              transition: 'border-color .2s, background .2s',
            }}
          >
            <div style={{ fontSize: 36, marginBottom: 12 }}>{loading ? '⏳' : '📂'}</div>
            <div style={{ fontWeight: 600, color: '#1e293b', marginBottom: 4 }}>
              {loading ? 'جاري القراءة...' : 'اسحب الملف هنا أو اضغط للاختيار'}
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>xlsx, xls, csv</div>
            <input
              ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); e.target.value = ''; }}
            />
          </div>

          {error && (
            <div style={{ marginTop: 16, padding: '10px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#dc2626', fontSize: 13 }}>
              {error}
            </div>
          )}

          <SavedSettingsInfo onReset={resetAllAutoSettings} />
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════
     RENDER — Filter step
  ══════════════════════════════════════════════════ */
  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', direction: 'rtl' }}>

      {/* ── Top Bar ── */}
      <div style={{
        background: '#fff', borderBottom: '1px solid #e2e8f0',
        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        position: 'sticky', top: 0, zIndex: 10,
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
            {allRows.length.toLocaleString('ar-IQ')} صف ← بعد الفلترة:&nbsp;
            <strong style={{ color: '#1a56db' }}>{filteredRows.length.toLocaleString('ar-IQ')} صف</strong>
          </div>
        </div>

        {autoSaved && (
          <span style={{
            fontSize: 11, color: '#16a34a', fontWeight: 600,
            background: '#f0fdf4', border: '1px solid #bbf7d0',
            borderRadius: 6, padding: '3px 8px',
          }}>✅ تم الحفظ التلقائي</span>
        )}

        <button
          onClick={() => setShowPresetPanel(v => !v)}
          style={{
            background: showPresetPanel ? '#eff6ff' : '#f1f5f9',
            border: `1px solid ${showPresetPanel ? '#bfdbfe' : '#e2e8f0'}`,
            borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer',
            color: showPresetPanel ? '#1a56db' : '#475569', fontWeight: 600, flexShrink: 0,
          }}
        >🔖 لقطات {savedPresets.length > 0 && `(${savedPresets.length})`}</button>

        <button
          onClick={() => exportXlsx(headers, exportRows, fileName)}
          disabled={filteredRows.length === 0}
          style={{
            background: filteredRows.length === 0 ? '#f1f5f9' : '#1a56db',
            border: 'none', borderRadius: 8, padding: '6px 16px',
            fontSize: 13, cursor: filteredRows.length === 0 ? 'not-allowed' : 'pointer',
            color: filteredRows.length === 0 ? '#94a3b8' : '#fff', fontWeight: 700, flexShrink: 0,
          }}
        >⬇️ تصدير ({filteredRows.length.toLocaleString('ar-IQ')})</button>
      </div>

      {/* ── Applied banner ── */}
      {appliedMsg && (
        <div style={{ background: '#f0fdf4', borderBottom: '1px solid #bbf7d0', padding: '8px 20px', fontSize: 12, color: '#15803d', fontWeight: 600 }}>
          {appliedMsg}
        </div>
      )}

      {/* ── Preset Panel ── */}
      {showPresetPanel && (
        <div style={{ background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '14px 20px' }}>
          <div style={{ fontSize: 11, color: '#3b82f6', marginBottom: 8 }}>
            اللقطات تحفظ حالة الفلاتر والبونص في لحظة معينة (منفصلة عن الحفظ التلقائي)
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <input
              type="text" placeholder="اسم اللقطة..." value={presetName}
              onChange={e => setPresetName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') savePreset(); }}
              style={{ flex: 1, minWidth: 160, padding: '6px 12px', borderRadius: 8, border: '1px solid #bfdbfe', fontSize: 13, outline: 'none', background: '#fff' }}
            />
            <button
              onClick={savePreset} disabled={!presetName.trim()}
              style={{
                background: presetName.trim() ? '#1a56db' : '#94a3b8',
                border: 'none', borderRadius: 8, padding: '6px 14px',
                fontSize: 12, cursor: presetName.trim() ? 'pointer' : 'not-allowed',
                color: '#fff', fontWeight: 700,
              }}
            >💾 حفظ لقطة</button>
          </div>
          {savedPresets.length > 0 ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {savedPresets.map(p => (
                <div key={p.name} style={{ background: '#fff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button onClick={() => loadPreset(p)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#1a56db', fontWeight: 600 }}>
                    🔖 {p.name}
                  </button>
                  <button onClick={() => deletePreset(p.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#dc2626' }} title="حذف">✕</button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#60a5fa' }}>لا توجد لقطات بعد</div>
          )}
        </div>
      )}

      {/* ── Main Content ── */}
      <div style={{ padding: 20, display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Column Filters */}
        <div style={{ flex: '1 1 500px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#1e293b' }}>🔽 فلاتر الأعمدة</h2>
            <span style={{ fontSize: 11, color: '#64748b' }}>التغييرات تُحفظ تلقائياً وتُطبَّق على الملفات القادمة</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
            {headers.map((h, ci) => (
              <ColFilterPanel
                key={ci} colName={h}
                filter={colFilters[ci] ?? { values: [], selected: new Set(), search: '' }}
                onChange={f => setColFilters(prev => ({ ...prev, [ci]: f }))}
              />
            ))}
          </div>
        </div>

        {/* Bonus Rules */}
        {bonusCol >= 0 && itemColIdx >= 0 && (
          <div style={{ flex: '0 0 270px', minWidth: 230 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#1e293b' }}>💰 بونص الايتمات</h2>
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
              البونص: <strong>{headers[bonusCol]}</strong> | الايتم: <strong>{headers[itemColIdx]}</strong>
              <div style={{ color: '#15803d', fontWeight: 500, marginTop: 2 }}>يُحفظ تلقائياً ويُطبَّق على كل ملف قادم</div>
            </div>
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
              <BonusSearch bonusRules={bonusRules} setBonusRules={setBonusRules} />
            </div>
            <button
              onClick={() => setBonusRules(prev => prev.map(r => ({ ...r, bonus: '' })))}
              style={{ marginTop: 8, background: 'none', border: '1px solid #fca5a5', borderRadius: 6, padding: '4px 12px', fontSize: 11, cursor: 'pointer', color: '#dc2626', width: '100%' }}
            >مسح قيم البونص</button>
          </div>
        )}
      </div>

      {/* ── Preview Table ── */}
      <div style={{ padding: '0 20px 40px' }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700, color: '#1e293b' }}>
          👁️ معاينة ({filteredRows.length.toLocaleString('ar-IQ')} صف)
        </h2>
        <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {headers.map((h, i) => (
                  <th key={i} style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: '#475569', fontSize: 11, borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {exportRows.slice(0, 50).map((row, ri) => (
                <tr key={ri} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{ padding: '6px 12px', color: '#1e293b', whiteSpace: 'nowrap' }}>{cell}</td>
                  ))}
                </tr>
              ))}
              {exportRows.length > 50 && (
                <tr>
                  <td colSpan={headers.length} style={{ padding: 10, textAlign: 'center', color: '#94a3b8', fontSize: 11 }}>
                    ... و {(exportRows.length - 50).toLocaleString('ar-IQ')} صف إضافي (تُضمَّن عند التصدير)
                  </td>
                </tr>
              )}
              {exportRows.length === 0 && (
                <tr>
                  <td colSpan={headers.length} style={{ padding: 28, textAlign: 'center', color: '#94a3b8' }}>
                    لا توجد بيانات تطابق الفلاتر المحددة
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
