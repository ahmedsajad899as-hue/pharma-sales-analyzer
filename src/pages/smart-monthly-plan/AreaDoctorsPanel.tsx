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

/**
 * مناطق المندوب العلمي + أطباؤها (اختصاص/صيدلية/كلاس — نفس مصدر تحليل الزيارات)،
 * مع تأشير كل طبيب: صيدليته مفتوحة أم لا، وإمكانية تحديد من يدخل اختيار البلان.
 * الاختيار يُحفَظ تلقائياً (المستبعدون فقط) ويُطبَّق عند "توليد البلان".
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
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
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
          setExcluded(new Set(r.areas.flatMap(a => a.doctors.filter(d => !d.included).map(d => d.key))));
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

  const q = search.trim().toLowerCase();
  const visibleAreas = useMemo(() => areas.map(a => ({
    ...a,
    shown: a.doctors.filter(d => {
      if (filter === 'open' && !d.openPharmacy) return false;
      if (filter === 'closed' && d.openPharmacy) return false;
      if (!q) return true;
      return [d.name, d.specialty, d.pharmacyName, d.className].some(v => v?.toLowerCase().includes(q));
    }),
  })), [areas, filter, q]);

  const totalDoctors = areas.reduce((s, a) => s + a.doctors.length, 0);
  const totalOpen = areas.reduce((s, a) => s + a.doctors.filter(d => d.openPharmacy).length, 0);
  const totalIncluded = areas.reduce((s, a) => s + a.doctors.filter(d => !excluded.has(d.key)).length, 0);
  const allKeys = areas.flatMap(a => a.doctors.map(d => d.key));

  return (
    <div style={panel}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}
      >
        <strong style={{ fontSize: 15, color: 'var(--c-text-primary)' }}>🗺️ مناطق المندوب وأطباؤها</strong>
        {!loading && (
          <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
            {areas.length} منطقة · {totalDoctors} طبيب · محدَّد للبلان {totalIncluded}
            {hasOpenFile && ` · صيدلية مفتوحة ${totalOpen}`}
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
                  ارفع ملف «صيدليات مفتوحة» أعلاه ليُؤشَّر أي طبيب صيدليته مفتوحة وأيهم لا.
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                <input
                  placeholder="بحث باسم الطبيب / الاختصاص / الصيدلية..."
                  value={search} onChange={e => setSearch(e.target.value)}
                  style={{ flex: 1, minWidth: 200, padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)', fontSize: 13 }}
                />
                <button style={chip(filter === 'all')} onClick={() => setFilter('all')}>الكل</button>
                {hasOpenFile && <button style={chip(filter === 'open')} onClick={() => setFilter('open')}>🏬 صيدليته مفتوحة</button>}
                {hasOpenFile && <button style={chip(filter === 'closed')} onClick={() => setFilter('closed')}>غير مفتوحة</button>}
                <button style={miniBtn} onClick={() => setMany(allKeys, true)}>تحديد الكل</button>
                <button style={miniBtn} onClick={() => setMany(allKeys, false)}>إلغاء الكل</button>
                {hasOpenFile && (
                  <button style={miniBtn} onClick={() => {
                    const open = areas.flatMap(a => a.doctors.filter(d => d.openPharmacy).map(d => d.key));
                    const closed = areas.flatMap(a => a.doctors.filter(d => !d.openPharmacy).map(d => d.key));
                    const next = new Set(excluded);
                    open.forEach(k => next.delete(k)); closed.forEach(k => next.add(k));
                    persist(next);
                  }}>المفتوحة فقط</button>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 520, overflowY: 'auto' }}>
                {visibleAreas.map(a => {
                  const keys = a.doctors.map(d => d.key);
                  const selectedInArea = keys.filter(k => !excluded.has(k)).length;
                  const openInArea = a.doctors.filter(d => d.openPharmacy).length;
                  const isCollapsed = collapsed.has(a.areaId);
                  if ((q || filter !== 'all') && a.shown.length === 0) return null;
                  return (
                    <div key={a.areaId} style={{ border: '1px solid var(--c-border-light, var(--c-border))', borderRadius: 'var(--radius-md)' }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px',
                        background: 'var(--c-bg)', borderRadius: 'var(--radius-md)',
                      }}>
                        <button
                          onClick={() => setCollapsed(prev => { const n = new Set(prev); n.has(a.areaId) ? n.delete(a.areaId) : n.add(a.areaId); return n; })}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--c-text-muted)' }}
                        >{isCollapsed ? '◀' : '▼'}</button>
                        <strong style={{ fontSize: 13, color: 'var(--c-text-primary)' }}>{a.areaName}</strong>
                        <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
                          {a.doctors.length} طبيب · محدَّد {selectedInArea}{hasOpenFile && ` · مفتوحة ${openInArea}`}
                        </span>
                        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
                          <button style={miniBtn} onClick={() => setMany(keys, true)}>تحديد المنطقة</button>
                          <button style={miniBtn} onClick={() => setMany(keys, false)}>إلغاء</button>
                        </span>
                      </div>

                      {!isCollapsed && (
                        a.doctors.length === 0 ? (
                          <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--c-text-muted)' }}>لا أطباء مسجَّلون في السيرفي لهذه المنطقة.</div>
                        ) : (
                          <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead>
                                <tr style={{ color: 'var(--c-text-muted)', textAlign: 'start' }}>
                                  <th style={{ padding: '6px 10px', width: 30 }}></th>
                                  <th style={{ padding: '6px 10px', textAlign: 'start' }}>الطبيب</th>
                                  <th style={{ padding: '6px 10px', textAlign: 'start' }}>الاختصاص</th>
                                  <th style={{ padding: '6px 10px', textAlign: 'start' }}>الصيدلية</th>
                                  <th style={{ padding: '6px 10px', textAlign: 'start' }}>الكلاس</th>
                                  {hasOpenFile && <th style={{ padding: '6px 10px', textAlign: 'start' }}>صيدلية مفتوحة</th>}
                                </tr>
                              </thead>
                              <tbody>
                                {a.shown.map(d => {
                                  const on = !excluded.has(d.key);
                                  return (
                                    <tr key={d.id} style={{ borderTop: '1px solid var(--c-border-light, var(--c-border))', opacity: on ? 1 : 0.5 }}>
                                      <td style={{ padding: '6px 10px' }}>
                                        <input type="checkbox" checked={on} onChange={() => setMany([d.key], !on)} />
                                      </td>
                                      <td style={{ padding: '6px 10px', fontWeight: 600, color: 'var(--c-text-primary)' }}>{d.name}</td>
                                      <td style={{ padding: '6px 10px', color: 'var(--c-text-secondary)' }}>{d.specialty || '—'}</td>
                                      <td style={{ padding: '6px 10px', color: 'var(--c-text-secondary)' }}>{d.pharmacyName || '—'}</td>
                                      <td style={{ padding: '6px 10px', color: 'var(--c-text-secondary)' }}>{d.className || '—'}</td>
                                      {hasOpenFile && (
                                        <td style={{ padding: '6px 10px' }}>
                                          {d.openPharmacy ? (
                                            <span title={d.matchedOpenPharmacy ?? ''} style={{ background: 'var(--c-success-bg)', color: 'var(--c-success)', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600 }}>✓ مفتوحة</span>
                                          ) : (
                                            <span style={{ background: 'var(--c-border-light, var(--c-bg))', color: 'var(--c-text-muted)', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600 }}>✗ لا</span>
                                          )}
                                        </td>
                                      )}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )
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
