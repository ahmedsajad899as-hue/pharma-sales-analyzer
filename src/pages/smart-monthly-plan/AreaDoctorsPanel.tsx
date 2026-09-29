import { useEffect, useMemo, useRef, useState } from 'react';
import { smartPlanApi } from './api';
import type { AreaWithDoctors } from './types';

const panel: React.CSSProperties = {
  background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 'var(--radius-lg)',
  padding: 16, boxShadow: 'var(--shadow-sm)',
};

const chip = (active: boolean): React.CSSProperties => ({
  padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  border: '1px solid var(--c-border)',
  background: active ? 'var(--c-accent)' : 'var(--c-surface)',
  color: active ? '#fff' : 'var(--c-text-secondary)',
});

const miniBtn: React.CSSProperties = {
  padding: '4px 9px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)',
  background: 'var(--c-surface)', color: 'var(--c-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
};

const pill = (bg: string, color: string): React.CSSProperties => ({
  background: bg, color, borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
});

/**
 * مناطق المندوب العلمي → صيدلياتها → أطباء كل صيدلية (اختصاص/كلاس). الضغط على
 * الصيدلية يفتح أطباءها، والضغط على أي مكان في صف الطبيب يحدّده أو يلغيه.
 * كل صيدلية مؤشَّرة مفتوحة/غير مفتوحة حسب ملف «صيدليات مفتوحة».
 * الاختيار يُحفَظ تلقائياً (المستبعدون فقط) ويُطبَّق عند «توليد البلان».
 */
export default function AreaDoctorsPanel({
  token, planId, refreshKey,
}: {
  token: string; planId: number; refreshKey: string;
}) {
  const [areas, setAreas] = useState<AreaWithDoctors[]>([]);
  const [hasOpenFile, setHasOpenFile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [open, setOpen] = useState(true);
  const [collapsedAreas, setCollapsedAreas] = useState<Set<number>>(new Set());
  const [openPharmacies, setOpenPharmacies] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    smartPlanApi.getAreaDoctors(token, planId)
      .then(r => {
        if (cancelled) return;
        setAreas(r.areas);
        setHasOpenFile(r.hasOpenPharmaciesFile);
        // لا نستبدل اختياراً محلياً لم يُحفَظ بعد عند إعادة التحميل بسبب رفع ملف
        if (!dirty.current) {
          setExcluded(new Set(r.areas.flatMap(a => a.pharmacies.flatMap(p => p.doctors.filter(d => !d.included).map(d => d.key)))));
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, planId, refreshKey]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const persist = (next: Set<string>) => {
    setExcluded(next);
    dirty.current = true;
    setSaving('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await smartPlanApi.saveDoctorSelection(token, planId, [...next]);
        dirty.current = false;
        setSaving('saved');
      } catch (e: any) { setError(e.message); setSaving('idle'); }
    }, 500);
  };

  const setMany = (keys: string[], include: boolean) => {
    const next = new Set(excluded);
    for (const k of keys) include ? next.delete(k) : next.add(k);
    persist(next);
  };

  const togglePharmacy = (id: string) =>
    setOpenPharmacies(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const q = search.trim().toLowerCase();
  const visibleAreas = useMemo(() => areas.map(a => ({
    ...a,
    shown: a.pharmacies.map((p, idx) => ({ ...p, idx })).filter(p => {
      if (filter === 'open' && !p.openPharmacy) return false;
      if (filter === 'closed' && p.openPharmacy) return false;
      if (!q) return true;
      return p.name?.toLowerCase().includes(q) || p.doctors.some(d => d.name.toLowerCase().includes(q) || d.specialty?.toLowerCase().includes(q));
    }),
  })), [areas, filter, q]);

  const allDocs = areas.flatMap(a => a.pharmacies.flatMap(p => p.doctors.map(d => ({ d, open: p.openPharmacy }))));
  const totalPharmacies = areas.reduce((s, a) => s + a.pharmacies.filter(p => p.name).length, 0);
  const totalOpen = areas.reduce((s, a) => s + a.pharmacies.filter(p => p.openPharmacy).length, 0);
  const totalIncluded = allDocs.filter(x => !excluded.has(x.d.key)).length;
  const allKeys = allDocs.map(x => x.d.key);
  const openPharmCount = totalOpen;
  const closedPharmCount = totalPharmacies - totalOpen;
  const openDocCount = allDocs.filter(x => x.open).length;
  const closedDocCount = allDocs.length - openDocCount;

  return (
    <div style={panel}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}
      >
        <strong style={{ fontSize: 15, color: 'var(--c-text-primary)' }}>🗺️ مناطق المندوب وصيدلياتها وأطباؤها</strong>
        {!loading && (
          <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
            {areas.length} منطقة · {totalPharmacies} صيدلية · {allDocs.length} طبيب · محدَّد للبلان {totalIncluded}
            {hasOpenFile && ` · صيدليات مفتوحة ${totalOpen}`}
          </span>
        )}
        {saving !== 'idle' && (
          <span style={{ fontSize: 11, color: saving === 'saved' ? 'var(--c-success)' : 'var(--c-text-muted)' }}>
            {saving === 'saving' ? 'جارٍ الحفظ...' : '✓ تم الحفظ'}
          </span>
        )}
        <span style={{ marginInlineStart: 'auto', fontSize: 12, color: 'var(--c-text-muted)' }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          {error && <div style={{ color: 'var(--c-danger)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
          {loading ? (
            <div style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>جارٍ التحميل...</div>
          ) : areas.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>لا توجد مناطق مُعيَّنة لهذا المندوب العلمي.</div>
          ) : (
            <>
              {!hasOpenFile && (
                <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 10 }}>
                  ارفع ملف «صيدليات مفتوحة» أعلاه ليُؤشَّر أي صيدلية مفتوحة وأيها لا.
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                <input
                  placeholder="بحث باسم الصيدلية / الطبيب / الاختصاص..."
                  value={search} onChange={e => setSearch(e.target.value)}
                  style={{ flex: 1, minWidth: 200, padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)', fontSize: 13 }}
                />
                <button style={chip(filter === 'all')} onClick={() => setFilter('all')}>الكل ({totalPharmacies} صيدلية · {allDocs.length} طبيب)</button>
                {hasOpenFile && <button style={chip(filter === 'open')} onClick={() => setFilter('open')}>🏬 مفتوحة ({openPharmCount} صيدلية · {openDocCount} طبيب)</button>}
                {hasOpenFile && <button style={chip(filter === 'closed')} onClick={() => setFilter('closed')}>غير مفتوحة ({closedPharmCount} صيدلية · {closedDocCount} طبيب)</button>}
                <button style={miniBtn} onClick={() => setMany(allKeys, true)}>تحديد الكل</button>
                <button style={miniBtn} onClick={() => setMany(allKeys, false)}>إلغاء الكل</button>
                {hasOpenFile && (
                  <button style={miniBtn} onClick={() => {
                    const next = new Set(excluded);
                    for (const x of allDocs) x.open ? next.delete(x.d.key) : next.add(x.d.key);
                    persist(next);
                  }}>أطباء المفتوحة فقط</button>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 620, overflowY: 'auto' }}>
                {visibleAreas.map(a => {
                  if ((q || filter !== 'all') && a.shown.length === 0) return null;
                  const areaCollapsed = collapsedAreas.has(a.areaId);
                  const pharmacyCount = a.shown.filter(p => p.name).length;
                  const shownKeys = a.shown.flatMap(p => p.doctors.map(d => d.key));
                  const shownSelected = shownKeys.filter(k => !excluded.has(k)).length;
                  return (
                    <div key={a.areaId} style={{ border: '1px solid var(--c-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', flexShrink: 0 }}>
                      <div
                        onClick={() => setCollapsedAreas(prev => { const n = new Set(prev); n.has(a.areaId) ? n.delete(a.areaId) : n.add(a.areaId); return n; })}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--c-bg)', cursor: 'pointer' }}
                      >
                        <strong style={{ fontSize: 14, color: 'var(--c-text-primary)' }}>{a.areaName}</strong>
                        <span style={pill('var(--c-accent-light)', 'var(--c-accent)')}>🏬 {pharmacyCount} صيدلية</span>
                        <span style={pill('var(--c-success-bg)', 'var(--c-success)')}>👨‍⚕️ {shownSelected}/{shownKeys.length} طبيب</span>
                        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                          <button style={miniBtn} onClick={() => setMany(shownKeys, true)}>تحديد المنطقة</button>
                          <button style={miniBtn} onClick={() => setMany(shownKeys, false)}>إلغاء</button>
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{areaCollapsed ? '▼' : '▲'}</span>
                      </div>

                      {!areaCollapsed && (
                        a.pharmacies.length === 0 ? (
                          <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--c-text-muted)' }}>لا أطباء مسجَّلون في السيرفي لهذه المنطقة.</div>
                        ) : a.shown.map(p => {
                          const pid = `${a.areaId}:${p.idx}`;
                          const expanded = openPharmacies.has(pid) || (!!q && p.doctors.some(d => d.name.toLowerCase().includes(q)));
                          const keys = p.doctors.map(d => d.key);
                          const sel = keys.filter(k => !excluded.has(k)).length;
                          return (
                            <div key={pid} style={{ borderTop: '1px solid var(--c-border-light, var(--c-border))' }}>
                              <div
                                onClick={() => togglePharmacy(pid)}
                                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', flexWrap: 'wrap' }}
                              >
                                <span style={{
                                  width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                                  background: !hasOpenFile ? 'var(--c-accent)' : p.openPharmacy ? 'var(--c-success)' : 'var(--c-border)',
                                }} />
                                <strong style={{ fontSize: 13, color: 'var(--c-text-primary)' }}>{p.name ?? 'أطباء بلا صيدلية مسجَّلة'}</strong>
                                {hasOpenFile && p.name && (p.openPharmacy
                                  ? <span title={p.matchedOpenPharmacy ?? ''} style={pill('var(--c-success-bg)', 'var(--c-success)')}>✓ مفتوحة</span>
                                  : <span style={pill('var(--c-border-light, var(--c-bg))', 'var(--c-text-muted)')}>✗ غير مفتوحة</span>)}
                                <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                                  <span style={pill('var(--c-accent-light)', 'var(--c-accent)')}>{sel}/{keys.length} طبيب ▾</span>
                                </span>
                              </div>

                              {expanded && (
                                <div style={{ background: 'var(--c-bg)', padding: '4px 14px 10px' }}>
                                  <div style={{ display: 'flex', gap: 6, padding: '4px 0 6px' }}>
                                    <button style={miniBtn} onClick={() => setMany(keys, true)}>تحديد الكل</button>
                                    <button style={miniBtn} onClick={() => setMany(keys, false)}>إلغاء الكل</button>
                                  </div>
                                  {p.doctors.map(d => {
                                    const on = !excluded.has(d.key);
                                    return (
                                      <div
                                        key={d.id}
                                        onClick={() => setMany([d.key], !on)}
                                        style={{
                                          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', marginBottom: 4, cursor: 'pointer',
                                          borderRadius: 'var(--radius-sm)', userSelect: 'none',
                                          background: on ? 'var(--c-surface)' : 'transparent',
                                          border: `1px solid ${on ? 'var(--c-accent)' : 'var(--c-border)'}`,
                                          opacity: on ? 1 : 0.55,
                                        }}
                                      >
                                        <input type="checkbox" checked={on} readOnly style={{ pointerEvents: 'none' }} />
                                        <strong style={{ fontSize: 13, color: 'var(--c-text-primary)' }}>{d.name}</strong>
                                        <span style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{d.specialty || 'بدون اختصاص'}</span>
                                        {d.className && <span style={pill('var(--c-border-light, var(--c-bg))', 'var(--c-text-muted)')}>كلاس {d.className}</span>}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
