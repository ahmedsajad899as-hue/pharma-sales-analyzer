import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface NamedItem { id: number; name: string; }
interface ScientificRep { id: number; name: string; items: NamedItem[]; }
interface CommRep { id: number; name: string; items?: { item: NamedItem }[]; }
interface TargetRow { itemId: number; itemName: string; target: string; }
interface SavedTarget { id: number; itemId: number; item: NamedItem; target: number; month: number; year: number; }

const NOW = new Date();

// Roles allowed to create/sync targets for reps
const MANAGER_ROLES = new Set(['admin', 'manager', 'company_manager', 'team_leader', 'supervisor', 'office_manager', 'product_manager', 'commercial_supervisor', 'commercial_team_leader']);

export default function TargetsPage({ activeFileIds = [] }: { activeFileIds?: number[] }) {
  const { token, user } = useAuth();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const isManager = MANAGER_ROLES.has(user?.role ?? '');

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

  // Broadcast state
  const [showBroadcast, setShowBroadcast]   = useState(false);
  const [broadcastSel, setBroadcastSel]     = useState<Set<number>>(new Set());
  const [broadcasting, setBroadcasting]     = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);

  // Load reps — standalone=1 returns ONLY records manually created in
  // the المندوبون العلميون tab (not every system user account).
  useEffect(() => {
    fetch(`${API}/api/scientific-reps?standalone=1`, { headers: H() })
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

      setRows(items.slice().sort((a, b) => a.name.localeCompare(b.name)).map(item => ({
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
      const res = await fetch(`${API}/api/targets`, {
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
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        alert(`فشل حفظ التارگت (${res.status})\n${txt}`);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      alert(`خطأ في الاتصال: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const broadcast = async () => {
    if (broadcastSel.size === 0 || rows.length === 0) return;
    setBroadcasting(true);
    setBroadcastResult(null);
    let ok = 0; let fail = 0;
    for (const repId of broadcastSel) {
      try {
        // For scientific reps: get the target rep's items and only apply matching rows
        let targets: { itemId: number; target: number }[];
        if (repType === 'scientific') {
          const targetRep = sciReps.find(r => r.id === repId);
          const targetItemIds = new Set((targetRep?.items ?? []).map(i => i.id));
          targets = rows
            .filter(r => targetItemIds.has(r.itemId))
            .map(r => ({ itemId: r.itemId, target: parseFloat(r.target) || 0 }));
        } else {
          targets = rows.map(r => ({ itemId: r.itemId, target: parseFloat(r.target) || 0 }));
        }
        const res = await fetch(`${API}/api/targets`, {
          method: 'PUT', headers: H(),
          body: JSON.stringify({ repType, repId, month, year, targets }),
        });
        if (res.ok) ok++; else fail++;
      } catch { fail++; }
    }
    setBroadcasting(false);
    setBroadcastResult(fail === 0
      ? `✓ تمت المزامنة مع ${ok} مندوب — سيرى كل مندوب تارگته فوراً`
      : `⚠ نجح ${ok} وفشل ${fail}`);
    setTimeout(() => { setBroadcastResult(null); setShowBroadcast(false); setBroadcastSel(new Set()); }, 3500);
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

        {/* Save / Sync */}
        <button
          className="tgt-btn"
          onClick={save}
          disabled={saving || !selRepId || rows.length === 0}
          style={{ background: saved ? '#10b981' : '#6366f1', color: '#fff', minWidth: 130, opacity: (!selRepId || rows.length === 0) ? 0.5 : 1 }}
        >
          {saving ? '⏳ جاري...' : saved ? '✅ تمت المزامنة' : '🔄 مزامنة مع المندوب'}
        </button>
        {saved && (
          <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>
            سيظهر التارگت عند المندوب فوراً
          </span>
        )}

        {/* Broadcast */}
        <button
          className="tgt-btn"
          onClick={() => { setShowBroadcast(v => !v); setBroadcastSel(new Set()); setBroadcastResult(null); }}
          disabled={!selRepId || rows.length === 0}
          title="مزامنة نفس التارگت مع مندوبين آخرين"
          style={{ background: showBroadcast ? '#f59e0b' : '#fff', color: showBroadcast ? '#fff' : '#f59e0b', border: '1.5px solid #f59e0b', opacity: (!selRepId || rows.length === 0) ? 0.4 : 1 }}
        >
          🔄 مزامنة مع مندوبين آخرين
        </button>
      </div>

      {/* ── Broadcast Panel ── */}
      {showBroadcast && selRepId && rows.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1.5px solid #fcd34d', borderRadius: 14, padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <span style={{ fontWeight: 800, fontSize: 14, color: '#92400e' }}>� مزامنة التارگت مع مندوبين آخرين</span>
              <div style={{ fontSize: 12, color: '#b45309', marginTop: 2 }}>
                سيتم تطبيق تارگت {months[month - 1]} {year} على المندوبين المحددين أدناه
                {repType === 'scientific' && <span> (يُطبَّق فقط على الايتمات المشتركة)</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="tgt-btn"
                onClick={() => setBroadcastSel(new Set(reps.filter(r => r.id !== parseInt(selRepId)).map(r => r.id)))}
                style={{ background: '#f59e0b', color: '#fff', fontSize: 12, padding: '5px 14px' }}
              >تحديد الكل</button>              <button
                className="tgt-btn"
                onClick={() => setBroadcastSel(new Set())}
                style={{ background: '#f1f5f9', color: '#374151', fontSize: 12, padding: '5px 14px' }}
              >إلغاء الكل</button>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {reps.filter(r => r.id !== parseInt(selRepId)).map(r => {
              const checked = broadcastSel.has(r.id);
              return (
                <div
                  key={r.id}
                  onClick={() => setBroadcastSel(prev => { const s = new Set(prev); checked ? s.delete(r.id) : s.add(r.id); return s; })}
                  style={{
                    padding: '6px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 13, fontWeight: checked ? 700 : 400,
                    border: checked ? '1.5px solid #f59e0b' : '1.5px solid #e2e8f0',
                    background: checked ? '#fef3c7' : '#fff',
                    color: checked ? '#92400e' : '#64748b',
                    transition: 'all .12s',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                >
                  {checked ? '✓' : '○'} {r.name}
                </div>
              );
            })}
            {reps.filter(r => r.id !== parseInt(selRepId)).length === 0 && (
              <span style={{ fontSize: 13, color: '#94a3b8' }}>لا يوجد مندوبون آخرون</span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="tgt-btn"
              onClick={broadcast}
              disabled={broadcasting || broadcastSel.size === 0}
              style={{ background: '#f59e0b', color: '#fff', opacity: broadcastSel.size === 0 ? 0.4 : 1, minWidth: 140 }}
            >
              {broadcasting ? '⏳ جاري المزامنة...' : `🔄 مزامنة مع ${broadcastSel.size} مندوب`}
            </button>
            {broadcastResult && (
              <span style={{ fontSize: 13, fontWeight: 700, color: broadcastResult.startsWith('✓') ? '#059669' : '#d97706' }}>
                {broadcastResult}
              </span>
            )}
          </div>
        </div>
      )}

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
                <th style={{ padding: '10px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#6366f1', borderBottom: '1px solid #e2e8f0', width: 140 }}>🎯 التارگت (عدد)</th>
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
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const inputs = document.querySelectorAll<HTMLInputElement>('.tgt-input');
                          const next = inputs[i + 1];
                          if (next) { next.focus(); next.select(); }
                        }
                      }}
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
