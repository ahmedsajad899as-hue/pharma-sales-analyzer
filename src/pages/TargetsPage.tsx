import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface NamedItem { id: number; name: string; }
interface ScientificRep { id: number; name: string; items: NamedItem[]; }
interface CommRep { id: number; name: string; items?: { item: NamedItem }[]; }
interface TargetRow { itemId: number; itemName: string; target: string; }
interface SavedTarget { id: number; itemId: number; item: NamedItem; target: number; month: number; year: number; }

const NOW = new Date();

export default function TargetsPage({ activeFileIds = [] }: { activeFileIds?: number[] }) {
  const { token } = useAuth();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [repType, setRepType] = useState<'scientific' | 'commercial'>('scientific');
  const [sciReps, setSciReps] = useState<ScientificRep[]>([]);
  const [commReps, setCommReps] = useState<CommRep[]>([]);
  const [selRepId, setSelRepId] = useState('');
  const [month, setMonth] = useState(NOW.getMonth() + 1);
  const [year, setYear]   = useState(NOW.getFullYear());
  const [rows, setRows]   = useState<TargetRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [loading, setLoading] = useState(false);
  const [allItems, setAllItems] = useState<NamedItem[]>([]);

  // Load reps
  useEffect(() => {
    fetch(`${API}/api/scientific-reps`, { headers: H() })
      .then(r => r.json())
      .then(j => setSciReps(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (activeFileIds.length === 0) { setCommReps([]); return; }
    fetch(`${API}/api/representatives?fileIds=${activeFileIds.join(',')}`, { headers: H() })
      .then(r => r.json())
      .then(j => setCommReps(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeFileIds.join(',')]);

  // Load all items (for commercial rep — no item assignment)
  useEffect(() => {
    fetch(`${API}/api/items`, { headers: H() })
      .then(r => r.json())
      .then(j => setAllItems(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // When rep/period changes: load existing targets + build rows from rep's items
  const loadTargets = useCallback(async () => {
    if (!selRepId) { setRows([]); return; }
    setLoading(true);
    try {
      // Get items for this rep
      let items: NamedItem[] = [];
      if (repType === 'scientific') {
        const rep = sciReps.find(r => r.id === parseInt(selRepId));
        items = rep?.items ?? [];
      } else {
        // For commercial: use all items
        items = allItems.filter(i => !i.name.includes('(مؤقت)'));
      }

      // Load saved targets
      const qs = new URLSearchParams({ repType, repId: selRepId, month: String(month), year: String(year) });
      const res = await fetch(`${API}/api/targets?${qs}`, { headers: H() });
      const json = await res.json();
      const savedMap = new Map<number, number>(
        (json.data as SavedTarget[] ?? []).map(t => [t.itemId, t.target])
      );

      setRows(items.map(item => ({
        itemId: item.id,
        itemName: item.name,
        target: String(savedMap.get(item.id) ?? ''),
      })));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRepId, repType, month, year, sciReps, allItems, token]);

  useEffect(() => { loadTargets(); }, [loadTargets]);

  // Reset rep selection when switching type
  useEffect(() => { setSelRepId(''); setRows([]); }, [repType]);

  const updateRow = (idx: number, val: string) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, target: val } : r));
    setSaved(false);
  };

  const save = async () => {
    if (!selRepId) return;
    setSaving(true);
    try {
      await fetch(`${API}/api/targets`, {
        method: 'PUT',
        headers: H(),
        body: JSON.stringify({
          repType,
          repId: parseInt(selRepId),
          month,
          year,
          targets: rows.map(r => ({ itemId: r.itemId, target: parseFloat(r.target) || 0 })),
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const reps = repType === 'scientific' ? sciReps : commReps;
  const months = [
    'يناير','فبراير','مارس','أبريل','مايو','يونيو',
    'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر',
  ];
  const years = Array.from({ length: 5 }, (_, i) => NOW.getFullYear() - 2 + i);

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto', direction: 'rtl' }}>
      <style>{`
        .tgt-btn { padding: 8px 20px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 700; transition: all 0.15s; }
        .tgt-btn:hover { filter: brightness(0.93); }
        .tgt-input { width: 100%; padding: 6px 10px; border: 1.5px solid #e2e8f0; border-radius: 7px; font-size: 14px; text-align: center; direction: ltr; }
        .tgt-input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px #6366f133; }
      `}</style>

      <h2 style={{ margin: '0 0 20px', fontSize: 20, fontWeight: 800, color: '#0f172a' }}>🎯 التارگت الشهري</h2>

      {/* ── Controls ── */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '18px 20px', marginBottom: 20, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        {/* Rep type toggle */}
        <div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 5, fontWeight: 600 }}>نوع المندوب</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['scientific', 'commercial'] as const).map(t => (
              <button
                key={t}
                className="tgt-btn"
                onClick={() => setRepType(t)}
                style={{ background: repType === t ? '#6366f1' : '#f1f5f9', color: repType === t ? '#fff' : '#475569' }}
              >
                {t === 'scientific' ? '🔬 علمي' : '💼 تجاري'}
              </button>
            ))}
          </div>
        </div>

        {/* Rep selector */}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 5, fontWeight: 600 }}>المندوب</div>
          <select
            value={selRepId}
            onChange={e => setSelRepId(e.target.value)}
            style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 14, cursor: 'pointer', background: '#fff' }}
          >
            <option value="">— اختر مندوباً —</option>
            {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        {/* Month */}
        <div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 5, fontWeight: 600 }}>الشهر</div>
          <select
            value={month}
            onChange={e => setMonth(parseInt(e.target.value))}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 14, cursor: 'pointer', background: '#fff' }}
          >
            {months.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
          </select>
        </div>

        {/* Year */}
        <div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 5, fontWeight: 600 }}>السنة</div>
          <select
            value={year}
            onChange={e => setYear(parseInt(e.target.value))}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 14, cursor: 'pointer', background: '#fff' }}
          >
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {/* Save */}
        <button
          className="tgt-btn"
          onClick={save}
          disabled={saving || !selRepId || rows.length === 0}
          style={{ background: saved ? '#10b981' : '#6366f1', color: '#fff', minWidth: 100, opacity: (!selRepId || rows.length === 0) ? 0.5 : 1 }}
        >
          {saving ? '⏳ جاري...' : saved ? '✓ تم الحفظ' : '💾 حفظ'}
        </button>
      </div>

      {/* ── Items Table ── */}
      {!selRepId && (
        <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8', fontSize: 15 }}>
          اختر مندوباً لعرض التارگت الخاص به
        </div>
      )}

      {selRepId && loading && (
        <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>⏳ جاري التحميل...</div>
      )}

      {selRepId && !loading && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: 48, background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', color: '#94a3b8' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📦</div>
          <div>لا توجد ايتمات مخصصة لهذا المندوب</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>قم بتعيين الايتمات من قسم المندوبين العلميين</div>
        </div>
      )}

      {selRepId && !loading && rows.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
          <div style={{ background: 'linear-gradient(135deg,#6366f1,#4f46e5)', padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>
              🎯 تارگت {months[month - 1]} {year}
            </span>
            <span style={{ color: '#c7d2fe', fontSize: 12 }}>{rows.length} ايتم</span>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#475569', borderBottom: '1px solid #e2e8f0' }}>#</th>
                <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#475569', borderBottom: '1px solid #e2e8f0' }}>اسم الايتم</th>
                <th style={{ padding: '10px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#6366f1', borderBottom: '1px solid #e2e8f0', width: 140 }}>🎯 التارگت (قيمة)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.itemId} style={{ borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '10px 16px', fontSize: 13, color: '#94a3b8', width: 40 }}>{i + 1}</td>
                  <td style={{ padding: '10px 16px', fontSize: 14, fontWeight: 600, color: '#1e293b' }}>{row.itemName}</td>
                  <td style={{ padding: '8px 16px' }}>
                    <input
                      className="tgt-input"
                      type="number"
                      min="0"
                      placeholder="0"
                      value={row.target}
                      onChange={e => updateRow(i, e.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: '#f0f9ff', borderTop: '2px solid #bae6fd' }}>
                <td colSpan={2} style={{ padding: '10px 16px', fontWeight: 700, fontSize: 13, color: '#0369a1' }}>
                  إجمالي التارگت
                </td>
                <td style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 800, fontSize: 15, color: '#0369a1' }}>
                  {rows.reduce((s, r) => s + (parseFloat(r.target) || 0), 0).toLocaleString('ar-IQ-u-nu-latn')}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
