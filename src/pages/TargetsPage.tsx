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

  // Sync-to-system-rep modal state
  const [sysReps, setSysReps]           = useState<ScientificRep[]>([]);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncSelIds, setSyncSelIds]       = useState<Set<number>>(new Set());
  const [syncing, setSyncing]             = useState(false);
  const [syncResult, setSyncResult]       = useState<string | null>(null);

  // Load MY targets (scientific rep view — read-only)
  useEffect(() => {
    if (isManager) return;
    setLoading(true);
    const qs = new URLSearchParams({ month: String(month), year: String(year) });
    fetch(`${API}/api/targets/mine?${qs}`, { headers: H() })
      .then(r => r.json())
      .then(j => {
        const data: SavedTarget[] = j.data ?? [];
        setRows(data.map(t => ({ itemId: t.item.id, itemName: t.item.name, target: String(t.target) })));
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager, month, year, token]);

  // Load reps — standalone=1 so only manually-created reps scoped to this user
  // (created inside ScientificRepsPage / تحليل ملفات المندوبين) are shown.
  useEffect(() => {
    fetch(`${API}/api/scientific-reps?standalone=1`, { headers: H() })
      .then(r => r.json())
      .then(j => setSciReps(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Load system reps (created by master, linked to company manager) for sync modal
  useEffect(() => {
    if (repType !== 'scientific') return;
    fetch(`${API}/api/scientific-reps?excludeStandalone=1`, { headers: H() })
      .then(r => r.json())
      .then(j => setSysReps(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, repType]);

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

  // Sync current targets to selected system reps (also saves to standalone rep first)
  const syncToSystemReps = async () => {
    if (syncSelIds.size === 0 || rows.length === 0) return;
    setSyncing(true);
    setSyncResult(null);
    // Save to standalone rep first as reference
    if (selRepId) {
      try {
        await fetch(`${API}/api/targets`, {
          method: 'PUT', headers: H(),
          body: JSON.stringify({
            repType, repId: parseInt(selRepId), month, year,
            targets: rows.map(r => ({ itemId: r.itemId, target: parseFloat(r.target) || 0 })),
          }),
        });
      } catch { /* ignore standalone save error */ }
    }
    // Sync to each selected system rep
    let ok = 0, fail = 0;
    for (const repId of syncSelIds) {
      try {
        const sysRep = sysReps.find(r => r.id === repId);
        const sysItemIds = new Set((sysRep?.items ?? []).map(i => i.id));
        // Apply only items the system rep has assigned; if none assigned use all rows
        const targets = sysItemIds.size > 0
          ? rows.filter(r => sysItemIds.has(r.itemId)).map(r => ({ itemId: r.itemId, target: parseFloat(r.target) || 0 }))
          : rows.map(r => ({ itemId: r.itemId, target: parseFloat(r.target) || 0 }));
        const res = await fetch(`${API}/api/targets`, {
          method: 'PUT', headers: H(),
          body: JSON.stringify({ repType: 'scientific', repId, month, year, targets }),
        });
        if (res.ok) ok++; else fail++;
      } catch { fail++; }
    }
    setSyncing(false);
    setSyncResult(fail === 0
      ? `✅ تمت المزامنة مع ${ok} مندوب بنجاح — سيرى كل مندوب تارگته فوراً`
      : `⚠️ نجح ${ok} وفشل ${fail}`);
    setTimeout(() => { setSyncResult(null); setShowSyncModal(false); setSyncSelIds(new Set()); }, 3000);
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

      {/* ── Rep-only banner ── */}
      {!isManager && (
        <div style={{ background: '#eef2ff', border: '1.5px solid #c7d2fe', borderRadius: 12, padding: '12px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, direction: 'rtl' }}>
          <span style={{ fontSize: 22 }}>🎯</span>
          <div>
            <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: '#3730a3' }}>تارگتاتك الشهرية</p>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6366f1' }}>هذه هي التارگتات المعيّنة لك من قبل مدير الشركة — للاطلاع فقط</p>
          </div>
        </div>
      )}

      {/* ── Controls ── */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '18px 20px', marginBottom: 20, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        {/* Rep type toggle — manager only */}
        {isManager && <div>
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
        </div>}

        {/* Rep selector — manager only */}
        {isManager && <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 5, fontWeight: 600 }}>المندوب</div>
          <select
            value={selRepId}
            onChange={e => setSelRepId(e.target.value)}
            style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 14, cursor: 'pointer', background: '#fff' }}
          >
            <option value="">— اختر مندوباً —</option>
            {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>}

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

        {/* Sync to system rep — manager only */}
        {isManager && <button
          className="tgt-btn"
          onClick={() => { setSyncSelIds(new Set()); setSyncResult(null); setShowSyncModal(true); }}
          disabled={!selRepId || rows.length === 0}
          style={{ background: '#6366f1', color: '#fff', minWidth: 130, opacity: (!selRepId || rows.length === 0) ? 0.5 : 1 }}
        >
          🔄 مزامنة مع المندوب
        </button>}

        {/* Broadcast — manager only */}
        {isManager && <button
          className="tgt-btn"
          onClick={() => { setShowBroadcast(v => !v); setBroadcastSel(new Set()); setBroadcastResult(null); }}
          disabled={!selRepId || rows.length === 0}
          title="مزامنة نفس التارگت مع مندوبين آخرين"
          style={{ background: showBroadcast ? '#f59e0b' : '#fff', color: showBroadcast ? '#fff' : '#f59e0b', border: '1.5px solid #f59e0b', opacity: (!selRepId || rows.length === 0) ? 0.4 : 1 }}
        >
          🔄 مزامنة مع مندوبين آخرين
        </button>}
      </div>

      {/* ── Sync to System Rep Modal — manager only ── */}
      {isManager && showSyncModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { if (!syncing) { setShowSyncModal(false); setSyncSelIds(new Set()); } }}
        >
          <div
            style={{ background: '#fff', borderRadius: 16, padding: 24, width: '92%', maxWidth: 460, maxHeight: '85vh', overflowY: 'auto', direction: 'rtl', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <p style={{ margin: 0, fontWeight: 800, fontSize: 16, color: '#1e293b' }}>🔄 مزامنة مع المندوب</p>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: '#64748b' }}>
                  اختر المندوب/ين الذين سيُرسل لهم تارگت {months[month - 1]} {year}
                </p>
              </div>
              <button onClick={() => { setShowSyncModal(false); setSyncSelIds(new Set()); }}
                style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>

            {/* Select all / clear */}
            {sysReps.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button
                  onClick={() => setSyncSelIds(new Set(sysReps.map(r => r.id)))}
                  style={{ fontSize: 12, padding: '4px 12px', borderRadius: 7, background: '#eef2ff', color: '#4f46e5', border: '1px solid #c7d2fe', cursor: 'pointer', fontWeight: 600 }}
                >تحديد الكل</button>
                <button
                  onClick={() => setSyncSelIds(new Set())}
                  style={{ fontSize: 12, padding: '4px 12px', borderRadius: 7, background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0', cursor: 'pointer', fontWeight: 600 }}
                >إلغاء الكل</button>
              </div>
            )}

            {/* Reps list */}
            {sysReps.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '32px 0', color: '#94a3b8' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>👤</div>
                <p style={{ margin: 0, fontSize: 13 }}>لا يوجد مندوبون مرتبطون بهذا الحساب</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16, maxHeight: 300, overflowY: 'auto' }}>
                {sysReps.map(r => {
                  const checked = syncSelIds.has(r.id);
                  return (
                    <div
                      key={r.id}
                      onClick={() => setSyncSelIds(prev => { const s = new Set(prev); checked ? s.delete(r.id) : s.add(r.id); return s; })}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                        borderRadius: 10, cursor: 'pointer',
                        border: checked ? '1.5px solid #6366f1' : '1.5px solid #e2e8f0',
                        background: checked ? '#eef2ff' : '#fafafa',
                        transition: 'all .12s',
                      }}
                    >
                      <div style={{
                        width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                        border: checked ? 'none' : '2px solid #cbd5e1',
                        background: checked ? '#6366f1' : '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {checked && <span style={{ color: '#fff', fontSize: 13, fontWeight: 900 }}>✓</span>}
                      </div>
                      <div style={{ flex: 1 }}>
                        <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{r.name}</p>
                        {r.items.length > 0 && (
                          <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
                            {r.items.length} ايتم مخصص
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Sync result */}
            {syncResult && (
              <div style={{
                padding: '10px 14px', borderRadius: 9, marginBottom: 12, fontSize: 13, fontWeight: 700,
                background: syncResult.startsWith('✅') ? '#f0fdf4' : '#fffbeb',
                color:      syncResult.startsWith('✅') ? '#166534' : '#92400e',
                border:     `1px solid ${syncResult.startsWith('✅') ? '#bbf7d0' : '#fcd34d'}`,
              }}>
                {syncResult}
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={syncToSystemReps}
                disabled={syncing || syncSelIds.size === 0}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 9, border: 'none', cursor: 'pointer',
                  background: syncing || syncSelIds.size === 0 ? '#e2e8f0' : '#6366f1',
                  color: syncing || syncSelIds.size === 0 ? '#94a3b8' : '#fff',
                  fontWeight: 700, fontSize: 14,
                }}
              >
                {syncing ? '⏳ جاري المزامنة...' : `🔄 مزامنة مع ${syncSelIds.size} مندوب`}
              </button>
              <button
                onClick={() => { setShowSyncModal(false); setSyncSelIds(new Set()); }}
                disabled={syncing}
                style={{ padding: '10px 20px', borderRadius: 9, border: '1.5px solid #e2e8f0', background: '#fff', color: '#64748b', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
              >إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Broadcast Panel — manager only ── */}
      {isManager && showBroadcast && selRepId && rows.length > 0 && (
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
      {isManager && !selRepId && (
        <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8', fontSize: 15 }}>
          اختر مندوباً لعرض التارگت الخاص به
        </div>
      )}

      {(isManager ? !!selRepId : true) && loading && (
        <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>⏳ جاري التحميل...</div>
      )}

      {(isManager ? !!selRepId : true) && !loading && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: 48, background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', color: '#94a3b8' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📦</div>
          <div>{isManager ? 'لا توجد ايتمات مخصصة لهذا المندوب' : 'لم يتم تعيين أي تارگت لك هذا الشهر'}</div>
          {isManager && <div style={{ fontSize: 12, marginTop: 4 }}>قم بتعيين الايتمات من قسم المندوبين العلميين</div>}
        </div>
      )}

      {(isManager ? !!selRepId : true) && !loading && rows.length > 0 && (
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
                  <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                    {isManager ? (
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
                    ) : (
                      <span style={{ fontWeight: 800, fontSize: 15, color: '#4f46e5' }}>
                        {(parseFloat(row.target) || 0).toLocaleString('ar-IQ-u-nu-latn')}
                      </span>
                    )}
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
