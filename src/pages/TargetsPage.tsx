import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import RepSelectOptions, { type GroupableRep } from '../components/RepSelectOptions';

const API = import.meta.env.VITE_API_URL || '';

interface NamedItem { id: number; name: string; }
interface ScientificRep extends GroupableRep { items: NamedItem[]; }
interface CommRep extends GroupableRep { items?: { item: NamedItem }[]; }
interface TargetRow { itemId: number; itemName: string; target: string; }
interface SavedTarget { id: number; itemId: number; item: NamedItem; target: number; month: number; year: number; }

const NOW = new Date();

// Roles allowed to create/sync targets for reps
const MANAGER_ROLES = new Set(['admin', 'manager', 'company_manager', 'team_leader', 'supervisor', 'office_manager', 'product_manager', 'commercial_supervisor', 'commercial_team_leader', 'office_employee']);

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
  const [actuals, setActuals] = useState<Map<number, number>>(new Map());
  const [loadingActuals, setLoadingActuals] = useState(false);

  // Broadcast state
  const [showBroadcast, setShowBroadcast]   = useState(false);
  const [broadcastSel, setBroadcastSel]     = useState<Set<number>>(new Set());
  const [broadcasting, setBroadcasting]     = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);

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

  // Load reps — unified list (system reps + standalone reps created by this manager)
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

  // Load actual net sales for selected sci rep/period to compare with targets
  useEffect(() => {
    if (!isManager || !selRepId || repType !== 'scientific' || activeFileIds.length === 0) {
      setActuals(new Map());
      return;
    }
    setLoadingActuals(true);
    const lastDay = new Date(year, month, 0).getDate();
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const qs = new URLSearchParams({ fileIds: activeFileIds.join(','), startDate, endDate });
    fetch(`${API}/api/scientific-reps/${selRepId}/report?${qs}`, { headers: H() })
      .then(r => r.json())
      .then(j => {
        const map = new Map<number, number>();
        (j.data?.byItem ?? []).forEach((it: any) => { map.set(it.itemId, it.totalQuantity); });
        setActuals(map);
      })
      .catch(() => setActuals(new Map()))
      .finally(() => setLoadingActuals(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRepId, repType, month, year, isManager, activeFileIds.join(','), token]);

  // When rep/period changes: load existing targets + build rows from rep's items
  // (manager view only — the rep's own view is fully managed by the "load MY
  // targets" effect above; selRepId is always empty for a rep, so without this
  // guard, this effect would re-fire and wipe rows to [] every time sciReps/
  // allItems finish loading after the my-targets fetch already populated them)
  const loadTargets = useCallback(async () => {
    if (!isManager) return;
    if (!selRepId) { setRows([]); return; }
    setLoading(true);
    try {
      // Get items for this rep
      let items: NamedItem[] = [];
      if (repType === 'scientific') {
        // نطاق ايتمات المندوب من السيرفر — نفس الدالة التي يحسب بها تقرير
        // مبيعاته (ScientificRepItem ∩ ايتمات المستخدم المعيّنة). كانت الصفحة
        // تقرأ ScientificRepItem وحده، وهو فارغ لأغلب المناديب لأن تعيين
        // الايتمات يتم من تبويب «الايتمات» في صفحة المستخدم (UserItemAssignment)،
        // فتسقط إلى «كل ايتمات المكتب» وتُظهر أهدافاً لايتمات لا تُحتسب مبيعاتها.
        try {
          const r = await fetch(`${API}/api/scientific-reps/${selRepId}/effective-items`, { headers: H() });
          const j = await r.json();
          items = Array.isArray(j.data) ? j.data : [];
        } catch {
          items = [];
        }
        if (items.length === 0) {
          // تعذّر الجلب أو لا ايتمات ضمن نطاقه — نرجع للسلوك القديم بدل جدول فارغ
          const rep = sciReps.find(r => r.id === parseInt(selRepId));
          items = rep?.items ?? allItems.filter(i => !i.name.includes('(مؤقت)'));
        }
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
  }, [isManager, selRepId, repType, month, year, sciReps, allItems, token]);

  useEffect(() => { loadTargets(); }, [loadTargets]);

  // Reset rep selection when switching type
  useEffect(() => { setSelRepId(''); setRows([]); setActuals(new Map()); }, [repType]);

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
        // For scientific reps: only apply rows for items the target rep carries.
        // BUT a rep with NO explicitly-assigned items is treated everywhere in
        // this page as carrying ALL items (see loadTargets). Mirror that here:
        // an empty items list must mean "apply every row", not "apply nothing" —
        // otherwise broadcasting to such reps silently saves an empty target set.
        let targets: { itemId: number; target: number }[];
        if (repType === 'scientific') {
          const targetRep = sciReps.find(r => r.id === repId);
          const targetItemIds = targetRep?.items && targetRep.items.length > 0
            ? new Set(targetRep.items.map(i => i.id))
            : null; // null = rep carries all items
          targets = rows
            .filter(r => targetItemIds === null || targetItemIds.has(r.itemId))
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
  const showActualCols = isManager && !!selRepId && repType === 'scientific';

  return (
    <div className="page" dir="rtl" style={{ maxWidth: 1000 }}>
      <div className="page-header">
        <div>
          <div className="page-title">🎯 التارگت الشهري</div>
          <div className="page-subtitle">
            {isManager
              ? 'تحديد ومتابعة الأهداف الشهرية لكل مندوب علمي أو تجاري، ومقارنتها بالمبيع الفعلي'
              : 'الأهداف الشهرية المعيّنة لك من قبل إدارة الشركة'}
          </div>
        </div>
      </div>

      {/* ── Rep-only banner ── */}
      {!isManager && (
        <div className="info-banner" style={{ marginBottom: 20 }}>
          <span className="info-banner-icon">🎯</span>
          <div>
            <strong>تارگتاتك الشهرية</strong>
            <p>هذه هي التارگتات المعيّنة لك من قبل مدير الشركة — للاطلاع فقط</p>
          </div>
        </div>
      )}

      {/* ── Controls ── */}
      <div className="filter-card" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
        {/* Rep type toggle — manager only */}
        {isManager && (
          <div className="form-group">
            <label className="form-label">نوع المندوب</label>
            <div className="tabs">
              {(['scientific', 'commercial'] as const).map(t => (
                <button
                  key={t}
                  className={`tab ${repType === t ? 'tab--active' : ''}`}
                  onClick={() => setRepType(t)}
                >
                  {t === 'scientific' ? '🔬 علمي' : '💼 تجاري'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Rep selector — manager only */}
        {isManager && (
          <div className="form-group" style={{ flex: 1, minWidth: 200 }}>
            <label className="form-label">المندوب</label>
            <select
              className="form-input"
              value={selRepId}
              onChange={e => setSelRepId(e.target.value)}
              style={{ cursor: 'pointer' }}
            >
              <option value="">— اختر مندوباً —</option>
              {/* مرتّبة: شركة ← قائد فريق ← مندوبوه. التجاريون بلا أدوار فتظهر قائمتهم مسطّحة */}
              <RepSelectOptions reps={reps} />
            </select>
          </div>
        )}

        {/* Month */}
        <div className="form-group">
          <label className="form-label">الشهر</label>
          <select
            className="form-input"
            value={month}
            onChange={e => setMonth(parseInt(e.target.value))}
            style={{ width: 'auto', cursor: 'pointer' }}
          >
            {months.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
          </select>
        </div>

        {/* Year */}
        <div className="form-group">
          <label className="form-label">السنة</label>
          <select
            className="form-input"
            value={year}
            onChange={e => setYear(parseInt(e.target.value))}
            style={{ width: 'auto', cursor: 'pointer' }}
          >
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {/* Broadcast — manager only */}
        {isManager && (
          <button
            className={`btn ${showBroadcast ? 'btn--primary' : 'btn--secondary'}`}
            onClick={() => { setShowBroadcast(v => !v); setBroadcastSel(new Set()); setBroadcastResult(null); }}
            disabled={!selRepId || rows.length === 0}
            title="مزامنة نفس التارگت مع مندوبين آخرين"
          >
            🔄 مزامنة مع مندوبين آخرين
          </button>
        )}
      </div>

      {/* ── Broadcast Panel — manager only ── */}
      {isManager && showBroadcast && selRepId && rows.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--c-text-primary)' }}>🔄 مزامنة التارگت مع مندوبين آخرين</div>
              <div style={{ fontSize: 12.5, color: 'var(--c-text-secondary)', marginTop: 2 }}>
                سيتم تطبيق تارگت {months[month - 1]} {year} على المندوبين المحددين أدناه
                {repType === 'scientific' && <span> (يُطبَّق فقط على الايتمات المشتركة)</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => setBroadcastSel(new Set(reps.filter(r => r.id !== parseInt(selRepId)).map(r => r.id)))}
              >تحديد الكل</button>
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => setBroadcastSel(new Set())}
              >إلغاء الكل</button>
            </div>
          </div>

          <div className="tag-list" style={{ marginBottom: 14 }}>
            {reps.filter(r => r.id !== parseInt(selRepId)).map(r => {
              const checked = broadcastSel.has(r.id);
              return (
                <div
                  key={r.id}
                  onClick={() => setBroadcastSel(prev => { const s = new Set(prev); checked ? s.delete(r.id) : s.add(r.id); return s; })}
                  className={`filter-chip ${checked ? 'filter-chip--active' : ''}`}
                >
                  {checked ? '✓' : '○'} {r.name}
                </div>
              );
            })}
            {reps.filter(r => r.id !== parseInt(selRepId)).length === 0 && (
              <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>لا يوجد مندوبون آخرون</span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn btn--primary"
              onClick={broadcast}
              disabled={broadcasting || broadcastSel.size === 0}
              style={{ minWidth: 160 }}
            >
              {broadcasting ? '⏳ جاري المزامنة...' : `🔄 مزامنة مع ${broadcastSel.size} مندوب`}
            </button>
            {broadcastResult && (
              <span style={{ fontSize: 13, fontWeight: 700, color: broadcastResult.startsWith('✓') ? 'var(--c-success)' : 'var(--c-danger)' }}>
                {broadcastResult}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Items Table ── */}
      {isManager && !selRepId && (
        <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--c-text-secondary)' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>🎯</div>
          اختر مندوباً لعرض التارگت الخاص به
        </div>
      )}

      {(isManager ? !!selRepId : true) && loading && (
        <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--c-text-secondary)' }}>⏳ جاري التحميل...</div>
      )}

      {(isManager ? !!selRepId : true) && !loading && rows.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--c-text-secondary)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📦</div>
          <div>{isManager ? 'لا توجد ايتمات مخصصة لهذا المندوب' : 'لم يتم تعيين أي تارگت لك هذا الشهر'}</div>
          {isManager && <div style={{ fontSize: 12, marginTop: 4 }}>قم بتعيين الايتمات من قسم المندوبين العلميين</div>}
        </div>
      )}

      {(isManager ? !!selRepId : true) && !loading && rows.length > 0 && (
        <div className="table-wrapper">
          <div style={{ background: 'var(--c-primary)', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>
              🎯 تارگت {months[month - 1]} {year}
            </span>
            <span style={{ color: '#aeb9d6', fontSize: 12 }}>{rows.length} ايتم</span>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>اسم الايتم</th>
                <th style={{ textAlign: 'center', width: 140, color: 'var(--c-accent)' }}>التارگت (عدد)</th>
                {showActualCols && <>
                  <th style={{ textAlign: 'center', width: 120 }}>المبيع النت</th>
                  <th style={{ textAlign: 'center', width: 90 }}>الانجاز</th>
                </>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const actual = actuals.get(row.itemId) ?? 0;
                const tgt = parseFloat(row.target) || 0;
                const pct = showActualCols && tgt > 0 ? Math.round((actual / tgt) * 100) : null;
                const pctVariant = pct === null ? 'gray' : pct >= 100 ? 'green' : pct >= 70 ? 'blue' : 'red';
                return (
                <tr key={row.itemId}>
                  <td style={{ color: 'var(--c-text-muted)', width: 40 }}>{i + 1}</td>
                  <td style={{ fontWeight: 600 }}>{row.itemName}</td>
                  <td style={{ textAlign: 'center' }}>
                    {isManager ? (
                      <input
                        className="form-input tgt-target-input"
                        type="number"
                        min="0"
                        placeholder="0"
                        value={row.target}
                        onChange={e => updateRow(i, e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const inputs = document.querySelectorAll<HTMLInputElement>('.tgt-target-input');
                            const next = inputs[i + 1];
                            if (next) { next.focus(); next.select(); }
                          }
                        }}
                        style={{ textAlign: 'center', direction: 'ltr', maxWidth: 110, margin: '0 auto' }}
                      />
                    ) : (
                      <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--c-accent)' }}>
                        {(parseFloat(row.target) || 0).toLocaleString('ar-IQ-u-nu-latn')}
                      </span>
                    )}
                  </td>
                  {showActualCols && <>
                    <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--c-text-secondary)' }}>
                      {loadingActuals ? <span style={{ color: 'var(--c-text-muted)' }}>⋯</span> : actual.toLocaleString('ar-IQ-u-nu-latn')}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {pct === null || loadingActuals ? (
                        <span style={{ color: 'var(--c-text-muted)', fontSize: 12 }}>—</span>
                      ) : (
                        <span className={`badge badge--${pctVariant}`}>{pct}%</span>
                      )}
                    </td>
                  </>}
                </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--c-accent-light)', borderTop: '2px solid var(--c-purple-border)' }}>
                <td colSpan={2} style={{ fontWeight: 700, color: 'var(--c-accent)' }}>
                  الإجمالي
                </td>
                <td style={{ textAlign: 'center', fontWeight: 800, fontSize: 15, color: 'var(--c-accent)' }}>
                  {rows.reduce((s, r) => s + (parseFloat(r.target) || 0), 0).toLocaleString('ar-IQ-u-nu-latn')}
                </td>
                {showActualCols && (() => {
                  const totalActual = rows.reduce((s, r) => s + (actuals.get(r.itemId) ?? 0), 0);
                  const totalTarget = rows.reduce((s, r) => s + (parseFloat(r.target) || 0), 0);
                  const overallPct = totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : null;
                  const overallVariant = overallPct === null ? 'gray' : overallPct >= 100 ? 'green' : overallPct >= 70 ? 'blue' : 'red';
                  return <>
                    <td style={{ textAlign: 'center', fontWeight: 800, fontSize: 15, color: 'var(--c-accent)' }}>
                      {totalActual.toLocaleString('ar-IQ-u-nu-latn')}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {overallPct !== null ? <span className={`badge badge--${overallVariant}`} style={{ fontSize: 13 }}>{overallPct}%</span> : '—'}
                    </td>
                  </>;
                })()}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {isManager && !!selRepId && !loading && rows.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16, gap: 12, alignItems: 'center' }}>
          {saved && <span style={{ color: 'var(--c-success)', fontWeight: 700, fontSize: 13 }}>✓ تم الحفظ بنجاح</span>}
          <button
            className="btn btn--primary"
            onClick={save}
            disabled={saving}
            style={{ minWidth: 150 }}
          >
            {saving ? '⏳ جاري الحفظ...' : '💾 حفظ التارگت'}
          </button>
        </div>
      )}
    </div>
  );
}
