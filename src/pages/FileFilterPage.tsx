/**
 * FileFilterPage — صفحة تنقية الملفات
 *
 * مستقلة تماماً عن بقية الصفحات.
 * الوظيفة: رفع ملف Excel → تحديد قيم الفلترة لكل عمود → تعيين البونص لكل ايتم → تصدير الملف المنقى.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';

/* ─── Types ─────────────────────────────────────────── */
interface ColFilter {
  values: string[];        // All unique values in this column
  selected: Set<string>;   // Currently selected (kept) values
  search: string;          // Search input
}

interface BonusRule {
  item: string;
  bonus: string;           // numeric string entered by user
}

type Step = 'upload' | 'filter' | 'export';

/* ─── helpers ────────────────────────────────────────── */
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
        const rows = raw.slice(1).map(r => headers.map((_, i) => String(r[i] ?? '')));
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

function detectBonusCol(headers: string[]): number {
  for (const h of BONUS_COL_NAMES) {
    const idx = headers.findIndex(c => c.trim().toLowerCase() === h.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function detectItemCol(headers: string[]): number {
  const candidates = ['item', 'ايتم', 'اسم الايتم', 'المنتج', 'product', 'اسم المنتج'];
  for (const h of candidates) {
    const idx = headers.findIndex(c => c.trim().toLowerCase() === h.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

/* ─── Sub-components ─────────────────────────────────── */
function ColFilterPanel({
  colName, filter, onChange,
}: {
  colName: string;
  filter: ColFilter;
  onChange: (f: ColFilter) => void;
}) {
  const visible = filter.values.filter(v =>
    !filter.search || v.toLowerCase().includes(filter.search.toLowerCase())
  );
  const allVisible = visible.every(v => filter.selected.has(v));

  const toggle = (v: string) => {
    const next = new Set(filter.selected);
    next.has(v) ? next.delete(v) : next.add(v);
    onChange({ ...filter, selected: next });
  };

  const toggleAll = () => {
    if (allVisible) {
      const next = new Set(filter.selected);
      visible.forEach(v => next.delete(v));
      onChange({ ...filter, selected: next });
    } else {
      const next = new Set(filter.selected);
      visible.forEach(v => next.add(v));
      onChange({ ...filter, selected: next });
    }
  };

  return (
    <div style={{
      border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden',
      background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
    }}>
      {/* Header */}
      <div style={{
        background: '#f1f5f9', borderBottom: '1px solid #e2e8f0',
        padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: '#1e293b', flex: 1 }}>
          {colName}
          <span style={{ fontWeight: 400, fontSize: 11, color: '#64748b', marginRight: 6 }}>
            ({filter.selected.size}/{filter.values.length} محدد)
          </span>
        </span>
        <button
          onClick={toggleAll}
          style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
            background: allVisible ? '#fef2f2' : '#f0fdf4',
            color: allVisible ? '#dc2626' : '#16a34a',
            border: `1px solid ${allVisible ? '#fecaca' : '#bbf7d0'}`,
            fontWeight: 600,
          }}
        >
          {allVisible ? 'إلغاء الكل' : 'تحديد الكل'}
        </button>
      </div>
      {/* Search */}
      <div style={{ padding: '8px 14px', borderBottom: '1px solid #f1f5f9' }}>
        <input
          type="text"
          placeholder="بحث..."
          value={filter.search}
          onChange={e => onChange({ ...filter, search: e.target.value })}
          style={{
            width: '100%', padding: '6px 10px', borderRadius: 8,
            border: '1px solid #e2e8f0', fontSize: 12, outline: 'none',
            background: '#f8fafc', boxSizing: 'border-box',
          }}
        />
      </div>
      {/* Values */}
      <div style={{ maxHeight: 200, overflowY: 'auto', padding: '6px 0' }}>
        {visible.length === 0 ? (
          <div style={{ padding: '10px 14px', fontSize: 12, color: '#94a3b8' }}>لا توجد نتائج</div>
        ) : (
          visible.map(v => (
            <label
              key={v}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '5px 14px', cursor: 'pointer',
                background: filter.selected.has(v) ? '#f0fdf4' : undefined,
                transition: 'background .1s',
              }}
            >
              <input
                type="checkbox"
                checked={filter.selected.has(v)}
                onChange={() => toggle(v)}
                style={{ accentColor: '#1a56db', width: 14, height: 14, flexShrink: 0 }}
              />
              <span style={{ fontSize: 12, color: '#1e293b', wordBreak: 'break-word' }}>
                {v || <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>فارغ</span>}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────── */
export default function FileFilterPage() {
  /* State */
  const [step, setStep] = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [allRows, setAllRows] = useState<string[][]>([]);
  const [colFilters, setColFilters] = useState<Record<number, ColFilter>>({});
  const [bonusCol, setBonusCol] = useState<number>(-1);
  const [itemColIdx, setItemColIdx] = useState<number>(-1);
  const [bonusRules, setBonusRules] = useState<BonusRule[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [savedPresets, setSavedPresets] = useState<{ name: string; filters: Record<number, string[]>; bonusRules: BonusRule[] }[]>(() => {
    try { return JSON.parse(localStorage.getItem('ff_presets') || '[]'); } catch { return []; }
  });
  const [presetName, setPresetName] = useState('');
  const [showPresetPanel, setShowPresetPanel] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* Derived */
  const filteredRows = allRows.filter(row =>
    Object.entries(colFilters).every(([colIdx, f]) => {
      const val = row[Number(colIdx)] ?? '';
      return f.selected.size === 0 || f.selected.has(val);
    })
  );

  const exportRows = bonusCol >= 0
    ? filteredRows.map(row => {
        const itemVal = itemColIdx >= 0 ? row[itemColIdx] : '';
        const rule = bonusRules.find(r => r.item.trim().toLowerCase() === itemVal.trim().toLowerCase());
        if (rule && rule.bonus !== '') {
          const next = [...row];
          next[bonusCol] = rule.bonus;
          return next;
        }
        return row;
      })
    : filteredRows;

  /* File load */
  const handleFile = useCallback(async (file: File) => {
    setError('');
    setLoading(true);
    try {
      const { headers: h, rows } = await readXlsx(file);
      setFileName(file.name);
      setHeaders(h);
      setAllRows(rows);

      // Build col filters — all values selected by default
      const filters: Record<number, ColFilter> = {};
      h.forEach((_, ci) => {
        const unique = [...new Set(rows.map(r => r[ci] ?? ''))].sort((a, b) => a.localeCompare(b, 'ar'));
        filters[ci] = { values: unique, selected: new Set(unique), search: '' };
      });
      setColFilters(filters);

      const bIdx = detectBonusCol(h);
      setBonusCol(bIdx);
      const iIdx = detectItemCol(h);
      setItemColIdx(iIdx);

      // Init bonus rules with unique items
      if (bIdx >= 0 && iIdx >= 0) {
        const items = [...new Set(rows.map(r => r[iIdx] ?? ''))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ar'));
        setBonusRules(items.map(item => ({ item, bonus: '' })));
      } else {
        setBonusRules([]);
      }

      setStep('filter');
    } catch (err: any) {
      setError(err.message || 'خطأ أثناء قراءة الملف');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  /* Preset save/load */
  const savePreset = () => {
    if (!presetName.trim()) return;
    const preset = {
      name: presetName.trim(),
      filters: Object.fromEntries(
        Object.entries(colFilters).map(([k, v]) => [k, [...v.selected]])
      ),
      bonusRules: bonusRules.filter(r => r.bonus !== ''),
    };
    const next = [...savedPresets.filter(p => p.name !== preset.name), preset];
    setSavedPresets(next);
    localStorage.setItem('ff_presets', JSON.stringify(next));
    setPresetName('');
  };

  const loadPreset = (preset: typeof savedPresets[0]) => {
    setColFilters(prev => {
      const next = { ...prev };
      Object.entries(preset.filters).forEach(([k, vals]) => {
        const ci = Number(k);
        if (next[ci]) next[ci] = { ...next[ci], selected: new Set(vals as string[]) };
      });
      return next;
    });
    setBonusRules(prev => prev.map(r => {
      const rule = preset.bonusRules.find(br => br.item === r.item);
      return rule ? { ...r, bonus: rule.bonus } : r;
    }));
    setShowPresetPanel(false);
  };

  const deletePreset = (name: string) => {
    const next = savedPresets.filter(p => p.name !== name);
    setSavedPresets(next);
    localStorage.setItem('ff_presets', JSON.stringify(next));
  };

  /* ── Render: Upload Step ── */
  if (step === 'upload') {
    return (
      <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, direction: 'rtl' }}>
        <div style={{ maxWidth: 520, width: '100%' }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{ fontSize: 42, marginBottom: 10 }}>🗂️</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>تنقية الملفات</h1>
            <p style={{ margin: '8px 0 0', fontSize: 13, color: '#64748b' }}>
              ارفع ملف Excel لتصفيته وتنقيته وتصديره حسب متطلباتك
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
              borderRadius: 16,
              padding: '48px 24px',
              textAlign: 'center',
              cursor: 'pointer',
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
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); e.target.value = ''; }}
            />
          </div>

          {error && (
            <div style={{ marginTop: 16, padding: '10px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#dc2626', fontSize: 13 }}>
              {error}
            </div>
          )}

          {/* Saved Presets hint */}
          {savedPresets.length > 0 && (
            <div style={{ marginTop: 20, padding: '12px 16px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10, fontSize: 12, color: '#0369a1' }}>
              💡 لديك {savedPresets.length} إعداد محفوظ — سيتم تطبيقه تلقائياً بعد رفع الملف
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Render: Filter Step ── */
  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', direction: 'rtl' }}>
      {/* Top Bar */}
      <div style={{
        background: '#fff', borderBottom: '1px solid #e2e8f0',
        padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <button
          onClick={() => { setStep('upload'); setHeaders([]); setAllRows([]); }}
          style={{
            background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8,
            padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: '#475569', fontWeight: 600,
          }}
        >← رجوع</button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📄 {fileName}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
            {allRows.length.toLocaleString('ar-IQ')} صف ← بعد الفلترة: <strong style={{ color: '#1a56db' }}>{filteredRows.length.toLocaleString('ar-IQ')} صف</strong>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* Preset buttons */}
          <button
            onClick={() => setShowPresetPanel(v => !v)}
            style={{
              background: showPresetPanel ? '#eff6ff' : '#f1f5f9',
              border: `1px solid ${showPresetPanel ? '#bfdbfe' : '#e2e8f0'}`,
              borderRadius: 8, padding: '6px 14px', fontSize: 13, cursor: 'pointer',
              color: showPresetPanel ? '#1a56db' : '#475569', fontWeight: 600,
            }}
          >
            🔖 الإعدادات المحفوظة {savedPresets.length > 0 && `(${savedPresets.length})`}
          </button>

          <button
            onClick={() => exportXlsx(headers, exportRows, fileName)}
            disabled={filteredRows.length === 0}
            style={{
              background: filteredRows.length === 0 ? '#f1f5f9' : '#1a56db',
              border: 'none', borderRadius: 8, padding: '6px 18px',
              fontSize: 13, cursor: filteredRows.length === 0 ? 'not-allowed' : 'pointer',
              color: filteredRows.length === 0 ? '#94a3b8' : '#fff', fontWeight: 700,
            }}
          >
            ⬇️ تصدير Excel ({filteredRows.length.toLocaleString('ar-IQ')})
          </button>
        </div>
      </div>

      {/* Preset Panel */}
      {showPresetPanel && (
        <div style={{
          background: '#eff6ff', borderBottom: '1px solid #bfdbfe',
          padding: '16px 24px', direction: 'rtl',
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <input
              type="text"
              placeholder="اسم الإعداد الجديد..."
              value={presetName}
              onChange={e => setPresetName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') savePreset(); }}
              style={{
                flex: 1, minWidth: 180, padding: '7px 12px', borderRadius: 8,
                border: '1px solid #bfdbfe', fontSize: 13, outline: 'none', background: '#fff',
              }}
            />
            <button
              onClick={savePreset}
              disabled={!presetName.trim()}
              style={{
                background: presetName.trim() ? '#1a56db' : '#94a3b8',
                border: 'none', borderRadius: 8, padding: '7px 16px',
                fontSize: 13, cursor: presetName.trim() ? 'pointer' : 'not-allowed',
                color: '#fff', fontWeight: 700,
              }}
            >
              💾 حفظ الإعدادات الحالية
            </button>
          </div>
          {savedPresets.length > 0 ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {savedPresets.map(p => (
                <div key={p.name} style={{
                  background: '#fff', border: '1px solid #bfdbfe', borderRadius: 8,
                  padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <button
                    onClick={() => loadPreset(p)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#1a56db', fontWeight: 600 }}
                  >
                    🔖 {p.name}
                  </button>
                  <button
                    onClick={() => deletePreset(p.name)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#dc2626' }}
                    title="حذف"
                  >✕</button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#60a5fa' }}>لا توجد إعدادات محفوظة بعد</div>
          )}
        </div>
      )}

      {/* Main Content */}
      <div style={{ padding: 24, display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Column Filters */}
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#1e293b' }}>
            🔽 فلاتر الأعمدة
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
            {headers.map((h, ci) => (
              <ColFilterPanel
                key={ci}
                colName={h}
                filter={colFilters[ci] ?? { values: [], selected: new Set(), search: '' }}
                onChange={f => setColFilters(prev => ({ ...prev, [ci]: f }))}
              />
            ))}
          </div>
        </div>

        {/* Bonus Rules */}
        {bonusCol >= 0 && itemColIdx >= 0 && (
          <div style={{ flex: '0 0 280px', minWidth: 240 }}>
            <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#1e293b' }}>
              💰 تعيين البونص
            </h2>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
              عمود البونص: <strong>{headers[bonusCol]}</strong> | عمود الايتم: <strong>{headers[itemColIdx]}</strong>
            </div>
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ maxHeight: 460, overflowY: 'auto' }}>
                {bonusRules.map((rule, ri) => (
                  <div
                    key={rule.item}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 12px', borderBottom: ri < bonusRules.length - 1 ? '1px solid #f1f5f9' : undefined,
                    }}
                  >
                    <span style={{ flex: 1, fontSize: 12, color: '#1e293b', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {rule.item}
                    </span>
                    <input
                      type="number"
                      placeholder="0"
                      value={rule.bonus}
                      onChange={e => {
                        const next = [...bonusRules];
                        next[ri] = { ...next[ri], bonus: e.target.value };
                        setBonusRules(next);
                      }}
                      style={{
                        width: 80, padding: '4px 8px', borderRadius: 6,
                        border: rule.bonus !== '' ? '1px solid #86efac' : '1px solid #e2e8f0',
                        background: rule.bonus !== '' ? '#f0fdf4' : '#f8fafc',
                        fontSize: 12, outline: 'none', textAlign: 'left',
                      }}
                    />
                  </div>
                ))}
              </div>
              {/* Bulk clear */}
              <div style={{ padding: '8px 12px', borderTop: '1px solid #f1f5f9', textAlign: 'center' }}>
                <button
                  onClick={() => setBonusRules(prev => prev.map(r => ({ ...r, bonus: '' })))}
                  style={{
                    background: 'none', border: '1px solid #fecaca', borderRadius: 6,
                    padding: '4px 12px', fontSize: 11, cursor: 'pointer', color: '#dc2626',
                  }}
                >
                  مسح قيم البونص
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Preview Table */}
      <div style={{ padding: '0 24px 40px' }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#1e293b' }}>
          👁️ معاينة البيانات المنقاة ({filteredRows.length} صف)
        </h2>
        <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {headers.map((h, i) => (
                  <th key={i} style={{
                    padding: '8px 12px', textAlign: 'right', fontWeight: 700,
                    color: '#475569', fontSize: 11, borderBottom: '2px solid #e2e8f0',
                    whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {exportRows.slice(0, 50).map((row, ri) => (
                <tr key={ri} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{ padding: '6px 12px', color: '#1e293b', whiteSpace: 'nowrap' }}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
              {exportRows.length > 50 && (
                <tr>
                  <td colSpan={headers.length} style={{ padding: '10px', textAlign: 'center', color: '#94a3b8', fontSize: 11 }}>
                    ... و {(exportRows.length - 50).toLocaleString('ar-IQ')} صف إضافي (يتم تضمينها عند التصدير)
                  </td>
                </tr>
              )}
              {exportRows.length === 0 && (
                <tr>
                  <td colSpan={headers.length} style={{ padding: '28px', textAlign: 'center', color: '#94a3b8' }}>
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
