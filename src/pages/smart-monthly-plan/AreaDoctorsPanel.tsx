import { useEffect, useMemo, useRef, useState } from 'react';
import { smartPlanApi } from './api';
import { Icon } from '../../config/icons';
import PharmacyLinkChip from './PharmacyLinkChip';
import PharmacyTools from './PharmacyTools';
import PharmacySalesButton, { usePharmacyNet } from './PharmacySalesButton';
import { Stat, Tag, SegmentedFilter, btnMini, inputStyle, panel, sectionTitle } from './ui';
import type { AreaWithDoctors, SurveyPharmacyRef } from './types';

type OpenFilter = 'all' | 'open' | 'closed';
type SalesFilter = 'all' | 'sales' | 'nosales';

/**
 * مناطق المندوب العلمي → صيدلياتها → أطباء كل صيدلية (اختصاص/كلاس). الضغط على
 * الصيدلية يفتح أطباءها، والضغط على أي مكان في صف الطبيب يحدّده أو يلغيه.
 *
 * الفلترة بُعدان مستقلان يُجمعان معاً (حالة الفتح × حالة المبيع) بدل شرائح
 * متنافية — فيمكن مثلاً عرض «مفتوحة وبلا مبيع» وهي الحالة الأهم للبلان.
 * الاختيار يُحفَظ تلقائياً (المستبعدون فقط) ويُطبَّق عند «توليد البلان».
 */
export default function AreaDoctorsPanel({
  token, planId, refreshKey,
}: {
  token: string; planId: number; refreshKey: string;
}) {
  const [areas, setAreas] = useState<AreaWithDoctors[]>([]);
  const [surveyPharmacies, setSurveyPharmacies] = useState<SurveyPharmacyRef[]>([]);
  const [hasOpenFile, setHasOpenFile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [open, setOpen] = useState(true);
  const [expandedAreas, setExpandedAreas] = useState<Set<number>>(new Set());
  const [openPharmacies, setOpenPharmacies] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [openFilter, setOpenFilter] = useState<OpenFilter>('all');
  const [salesFilter, setSalesFilter] = useState<SalesFilter>('all');
  const [linkOnly, setLinkOnly] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerMsg, setRegisterMsg] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const [reloadTick, setReloadTick] = useState(0);
  const net = usePharmacyNet(token);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    smartPlanApi.getAreaDoctors(token, planId)
      .then(r => {
        if (cancelled) return;
        setAreas(r.areas);
        setSurveyPharmacies(r.surveyPharmacies ?? []);
        setHasOpenFile(r.hasOpenPharmaciesFile);
        // لا نستبدل اختياراً محلياً لم يُحفَظ بعد عند إعادة التحميل بسبب رفع ملف
        if (!dirty.current) {
          setSelected(new Set(r.areas.flatMap(a => a.pharmacies.flatMap(p => p.doctors.filter(d => d.included).map(d => d.key)))));
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, planId, refreshKey, reloadTick]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const persist = (next: Set<string>) => {
    setSelected(next);
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
    const next = new Set(selected);
    for (const k of keys) include ? next.add(k) : next.delete(k);
    persist(next);
  };

  const togglePharmacy = (id: string) =>
    setOpenPharmacies(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  /** قيمة مبيع الصيدلية من «الصيدليات نت» — null إذا لا يوجد ملف مبيع أصلاً. */
  const salesOf = useMemo(() => {
    if (!net.ready) return (_name: string | null) => null as number | null;
    return (name: string | null): number | null => {
      if (!name) return null;
      const hit = net.lookup(name);
      return hit ? hit.totalValue : 0;
    };
  }, [net]);

  const q = search.trim().toLowerCase();

  const visibleAreas = useMemo(() => {
    const keep = (p: AreaWithDoctors['pharmacies'][number]) => {
      if (openFilter === 'open' && !p.openPharmacy) return false;
      if (openFilter === 'closed' && p.openPharmacy) return false;
      if (linkOnly && !(p.name && p.notInSurvey && !p.separate)) return false;
      if (salesFilter !== 'all') {
        const v = salesOf(p.name);
        if (v === null) return false;
        if (salesFilter === 'sales' && !(v > 0)) return false;
        if (salesFilter === 'nosales' && v > 0) return false;
      }
      if (!q) return true;
      return !!p.name?.toLowerCase().includes(q)
        || p.doctors.some(d => d.name.toLowerCase().includes(q) || d.specialty?.toLowerCase().includes(q));
    };
    return areas.map(a => ({
      ...a,
      shown: a.pharmacies.map((p, idx) => ({ ...p, idx })).filter(keep),
    }));
  }, [areas, openFilter, salesFilter, linkOnly, q, salesOf]);

  const allDocs = areas.flatMap(a => a.pharmacies.flatMap(p => p.doctors.map(d => ({ d, open: p.openPharmacy, pharm: p.name }))));
  const allPharms = areas.flatMap(a => a.pharmacies).filter(p => p.name);
  const totalPharmacies = allPharms.length;
  const totalOpen = areas.reduce((s, a) => s + a.pharmacies.filter(p => p.openPharmacy).length, 0);
  // صيدليات ينتظر النظام قراراً بشأنها — شريحة تنبيه مستقلة عن فلاتر الحالة
  const needLinkCount = areas.reduce((s, a) => s + a.pharmacies.filter(p => p.name && p.notInSurvey && !p.separate).length, 0);
  const totalIncluded = allDocs.filter(x => selected.has(x.d.key)).length;
  const allKeys = allDocs.map(x => x.d.key);
  const withSalesCount = net.ready ? allPharms.filter(p => (salesOf(p.name) ?? 0) > 0).length : 0;
  const noSalesCount = net.ready ? totalPharmacies - withSalesCount : 0;
  // غير مفتوحة ولا لها مبيع بنفس الوقت — صيدليات بلا أي نشاط مسجَّل، تحتاج أهم متابعة
  const deadCount = (hasOpenFile && net.ready)
    ? allPharms.filter(p => !p.openPharmacy && (salesOf(p.name) ?? 0) === 0).length
    : 0;

  const shownPharmCount = visibleAreas.reduce((s, a) => s + a.shown.filter(p => p.name).length, 0);
  const shownKeysAll = visibleAreas.flatMap(a => a.shown.flatMap(p => p.doctors.map(d => d.key)));
  const filtersActive = openFilter !== 'all' || salesFilter !== 'all' || linkOnly || !!q;

  const openSegments = [
    { key: 'all', label: 'الكل', count: totalPharmacies },
    { key: 'open', label: 'مفتوحة', count: totalOpen, tone: 'success' as const },
    { key: 'closed', label: 'غير مفتوحة', count: totalPharmacies - totalOpen },
  ];
  const salesSegments = [
    { key: 'all', label: 'الكل' },
    { key: 'sales', label: 'لها مبيع', count: withSalesCount, tone: 'success' as const },
    { key: 'nosales', label: 'بلا مبيع', count: noSalesCount },
  ];

  const toolItems: { label: string; run: () => void; disabled?: boolean }[] = [
    { label: 'تحديد كل الأطباء', run: () => setMany(allKeys, true) },
    { label: 'إلغاء تحديد الكل', run: () => setMany(allKeys, false) },
    { label: 'تحديد المعروض حالياً (' + shownKeysAll.length + ')', run: () => setMany(shownKeysAll, true), disabled: !filtersActive },
    { label: 'إلغاء المعروض حالياً', run: () => setMany(shownKeysAll, false), disabled: !filtersActive },
  ];
  if (hasOpenFile) {
    toolItems.push({
      label: 'أطباء الصيدليات المفتوحة فقط',
      run: () => {
        const next = new Set(selected);
        for (const x of allDocs) x.open ? next.add(x.d.key) : next.delete(x.d.key);
        persist(next);
      },
    });
  }
  if (net.ready) {
    toolItems.push({
      label: 'أطباء الصيدليات التي لها مبيع فقط',
      run: () => {
        const next = new Set(selected);
        for (const x of allDocs) (salesOf(x.pharm) ?? 0) > 0 ? next.add(x.d.key) : next.delete(x.d.key);
        persist(next);
      },
    });
  }

  const allExpanded = areas.length > 0 && expandedAreas.size >= areas.length;

  return (
    <div style={panel}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}
      >
        <h3 style={sectionTitle}>
          <Icon name="location" size={15} style={{ color: 'var(--c-accent)' }} />
          مناطق المندوب وصيدلياتها وأطباؤها
        </h3>
        {!loading && (
          <span style={{ fontSize: 11.5, color: 'var(--c-text-muted)' }}>
            {areas.length} منطقة · {totalPharmacies} صيدلية · {allDocs.length} طبيب
          </span>
        )}
        {saving !== 'idle' && (
          <Tag tone={saving === 'saved' ? 'success' : 'neutral'}>
            {saving === 'saving' ? 'جارٍ الحفظ…' : 'تم الحفظ'}
          </Tag>
        )}
        <span style={{ marginInlineStart: 'auto', fontSize: 11, color: 'var(--c-text-muted)' }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          {error && <div style={{ color: 'var(--c-danger)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
          {loading ? (
            <div style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>جارٍ التحميل…</div>
          ) : areas.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>لا توجد مناطق مُعيَّنة لهذا المندوب العلمي.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                <Stat label="مناطق" value={areas.length} />
                <Stat label="صيدليات" value={totalPharmacies} />
                {hasOpenFile && <Stat label="مفتوحة" value={totalOpen} tone="success" />}
                {net.ready && <Stat label="لها مبيع" value={withSalesCount} tone="success" />}
                {hasOpenFile && net.ready && <Stat label="غير مفتوحة وبلا مبيع" value={deadCount} tone="danger" />}
                <Stat label="أطباء" value={allDocs.length} />
                <Stat label="محدَّد للبلان" value={totalIncluded} tone="accent" />
              </div>

              {!hasOpenFile && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--c-text-secondary)',
                  background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: 10,
                  padding: '8px 12px', marginBottom: 12,
                }}>
                  <Icon name="warning" size={13} style={{ color: 'var(--c-text-muted)' }} />
                  ارفع ملف «صيدليات مفتوحة» أعلاه ليُؤشَّر أي صيدلية مفتوحة وأيها لا.
                </div>
              )}

              {/* شريط الأدوات: بحث + فلترة بُعدين + تنبيه الربط + قائمة أدوات التحديد */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 190 }}>
                  <Icon name="search" size={13} style={{ position: 'absolute', insetInlineStart: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--c-text-muted)' }} />
                  <input
                    placeholder="بحث باسم الصيدلية أو الطبيب أو الاختصاص…"
                    value={search} onChange={e => setSearch(e.target.value)}
                    style={{ ...inputStyle, width: '100%', paddingInlineStart: 30 }}
                  />
                </div>

                {hasOpenFile && (
                  <SegmentedFilter
                    segments={openSegments}
                    value={openFilter}
                    onChange={k => setOpenFilter(k as OpenFilter)}
                  />
                )}
                {net.ready && (
                  <SegmentedFilter
                    segments={salesSegments}
                    value={salesFilter}
                    onChange={k => setSalesFilter(k as SalesFilter)}
                  />
                )}

                {needLinkCount > 0 && (
                  <button
                    onClick={() => setLinkOnly(v => !v)}
                    title="صيدليات مفتوحة غير موجودة في السيرفي — تحتاج ربطاً يدوياً"
                    style={{
                      ...btnMini, padding: '7px 12px', fontSize: 12,
                      border: `1px solid ${linkOnly ? 'var(--c-warning)' : 'var(--c-warning-border)'}`,
                      background: linkOnly ? 'var(--c-warning)' : 'var(--c-warning-bg)',
                      color: linkOnly ? '#fff' : 'var(--c-warning)',
                    }}
                  >
                    <Icon name="link" size={12} /> تحتاج ربطاً ({needLinkCount})
                  </button>
                )}

                {/* تسجيل جماعي: أغلب هذه الصيدليات ليست في السيرفي أصلاً، فالربط لا يفيدها */}
                {needLinkCount > 0 && (
                  <button
                    disabled={registering}
                    title="تسجيل كل صيدلية مفتوحة غير موجودة في السيرفي كصفّ سيرفي ضمن منطقتها"
                    onClick={async () => {
                      if (!window.confirm(
                        `سيتم تسجيل ${needLinkCount} صيدلية مفتوحة غير موجودة في السيرفي، كلٌّ ضمن منطقتها من الملف.\n\n`
                        + 'الصيدليات الموجودة مسبقاً لن تتكرّر، والاسم يُؤخذ من زيارات الصيدليات إن وُجدت.\n'
                        + 'ستظهر لكل الحسابات ويمكن تعطيل أي منها لاحقاً من صفحة السيرفي. متابعة؟',
                      )) return;
                      setRegistering(true); setRegisterMsg(''); setError('');
                      try {
                        const r = await smartPlanApi.registerAllOpenPharmacies(token, planId);
                        setRegisterMsg(
                          `تم تسجيل ${r.created} صيدلية`
                          + (r.duplicate ? ` · ${r.duplicate} كانت موجودة مسبقاً` : '')
                          + (r.failed ? ` · تعذّر ${r.failed}` : ''),
                        );
                        setReloadTick(t => t + 1);
                      } catch (e: any) { setError(e.message); }
                      finally { setRegistering(false); }
                    }}
                    style={{
                      ...btnMini, padding: '7px 12px', fontSize: 12,
                      border: '1px solid var(--c-accent)', background: 'var(--c-accent)', color: '#fff',
                      opacity: registering ? 0.6 : 1,
                    }}
                  >
                    {registering
                      ? <><Icon name="loading" size={12} className="icon-spin" /> جارٍ التسجيل…</>
                      : <><Icon name="add" size={12} /> سجّلها كلها في السيرفي</>}
                  </button>
                )}

                <button
                  onClick={() => setExpandedAreas(allExpanded ? new Set() : new Set(areas.map(a => a.areaId)))}
                  style={{ ...btnMini, padding: '7px 12px', fontSize: 12 }}
                >
                  {allExpanded ? '▲ طي الكل' : '▼ فتح الكل'}
                </button>

                <div style={{ position: 'relative' }}>
                  <button onClick={() => setToolsOpen(v => !v)} style={{ ...btnMini, padding: '7px 12px', fontSize: 12 }}>
                    <Icon name="check" size={12} /> أدوات التحديد ▾
                  </button>
                  {toolsOpen && (
                    <>
                      <div onClick={() => setToolsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                      <div style={{
                        position: 'absolute', insetInlineEnd: 0, top: 'calc(100% + 6px)', zIndex: 41,
                        background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 11,
                        boxShadow: 'var(--shadow-md)', padding: 5, minWidth: 230,
                      }}>
                        {toolItems.map(t => (
                          <button
                            key={t.label} disabled={t.disabled}
                            onClick={() => { t.run(); setToolsOpen(false); }}
                            style={{
                              display: 'block', width: '100%', textAlign: 'start', border: 'none', borderRadius: 8,
                              background: 'transparent', padding: '8px 10px', fontSize: 12.5, fontFamily: 'inherit',
                              color: t.disabled ? 'var(--c-text-muted)' : 'var(--c-text-secondary)',
                              cursor: t.disabled ? 'default' : 'pointer', fontWeight: 600,
                            }}
                          >{t.label}</button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {registerMsg && (
                <div style={{
                  fontSize: 12, color: 'var(--c-success)', background: 'var(--c-success-bg)',
                  border: '1px solid var(--c-success-border)', borderRadius: 9, padding: '7px 11px', marginBottom: 8,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <Icon name="checkCircle" size={13} /> {registerMsg}
                </div>
              )}

              <div style={{ fontSize: 11.5, color: 'var(--c-text-muted)', marginBottom: 12 }}>
                {filtersActive
                  ? <>يُعرض الآن <strong style={{ color: 'var(--c-text-secondary)' }}>{shownPharmCount}</strong> صيدلية · <strong style={{ color: 'var(--c-text-secondary)' }}>{shownKeysAll.length}</strong> طبيب</>
                  : 'اضغط على المنطقة لعرض صيدلياتها، وعلى الصيدلية لعرض أطبائها.'}
                {filtersActive && (
                  <button
                    onClick={() => { setOpenFilter('all'); setSalesFilter('all'); setLinkOnly(false); setSearch(''); }}
                    style={{ ...btnMini, padding: '2px 8px', fontSize: 11, marginInlineStart: 8 }}
                  >مسح الفلاتر</button>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 640, overflowY: 'auto', paddingInlineEnd: 2 }}>
                {visibleAreas.map(a => {
                  if (filtersActive && a.shown.length === 0) return null;
                  const areaCollapsed = !expandedAreas.has(a.areaId) && !q;
                  const pharmacyCount = a.shown.filter(p => p.name).length;
                  const shownKeys = a.shown.flatMap(p => p.doctors.map(d => d.key));
                  const shownSelected = shownKeys.filter(k => selected.has(k)).length;
                  const openPharmaciesInArea = a.shown.filter(p => p.name && p.openPharmacy).length;
                  return (
                    <div key={a.areaId} style={{ border: '1px solid var(--c-border)', borderRadius: 12, overflow: 'hidden', flexShrink: 0, background: 'var(--c-surface)' }}>
                      <div
                        onClick={() => setExpandedAreas(prev => { const n = new Set(prev); n.has(a.areaId) ? n.delete(a.areaId) : n.add(a.areaId); return n; })}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--c-bg)', cursor: 'pointer' }}
                      >
                        <span style={{ fontSize: 11, color: 'var(--c-text-muted)', width: 12 }}>{areaCollapsed ? '▼' : '▲'}</span>
                        <strong style={{ fontSize: 13.5, color: 'var(--c-text-primary)' }}>{a.areaName}</strong>
                        <Tag>{pharmacyCount} صيدلية</Tag>
                        {hasOpenFile && openPharmaciesInArea > 0 && <Tag tone="success">{openPharmaciesInArea} مفتوحة</Tag>}
                        <Tag tone={shownSelected > 0 ? 'accent' : 'neutral'}>{shownSelected}/{shownKeys.length} طبيب</Tag>
                        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                          <button style={btnMini} onClick={() => setMany(shownKeys, true)}>تحديد المنطقة</button>
                          <button style={btnMini} onClick={() => setMany(shownKeys, false)}>إلغاء</button>
                        </span>
                      </div>

                      {!areaCollapsed && (
                        a.pharmacies.length === 0 ? (
                          <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--c-text-muted)' }}>لا أطباء مسجَّلون في السيرفي لهذه المنطقة.</div>
                        ) : a.shown.map(p => {
                          const pid = `${a.areaId}:${p.idx}`;
                          const expanded = openPharmacies.has(pid) || (!!q && p.doctors.some(d => d.name.toLowerCase().includes(q)));
                          const keys = p.doctors.map(d => d.key);
                          const sel = keys.filter(k => selected.has(k)).length;
                          return (
                            <div key={pid} style={{ borderTop: '1px solid var(--c-border-light)' }}>
                              <div
                                onClick={() => togglePharmacy(pid)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', cursor: 'pointer', flexWrap: 'wrap',
                                  borderInlineStart: `3px solid ${hasOpenFile && p.openPharmacy ? 'var(--c-success)' : 'transparent'}`,
                                }}
                              >
                                <span style={{ fontSize: 10, color: 'var(--c-text-muted)', width: 10 }}>{expanded ? '▲' : '▼'}</span>
                                <strong style={{ fontSize: 13, color: 'var(--c-text-primary)' }}>{p.name ?? 'أطباء بلا صيدلية مسجَّلة'}</strong>
                                {/* المفتوحة = علامة صح خضراء فقط، وغير المفتوحة بلا أي إشارة */}
                                {hasOpenFile && p.name && p.openPharmacy && (
                                  <span
                                    title={p.matchedOpenPharmacy ? `صيدلية مفتوحة — ${p.matchedOpenPharmacy}` : 'صيدلية مفتوحة'}
                                    style={{ display: 'inline-flex', color: 'var(--c-success)', flexShrink: 0 }}
                                  >
                                    <Icon name="checkCircle" size={15} />
                                  </span>
                                )}
                                {p.name && (
                                  <PharmacyLinkChip
                                    token={token} planId={planId} area={a} pharmacy={p}
                                    surveyPharmacies={surveyPharmacies}
                                    onDone={() => setReloadTick(t => t + 1)} onError={setError}
                                  />
                                )}
                                <span style={{ marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                                  {p.name && <PharmacySalesButton token={token} net={net} pharmName={p.name} areaName={a.areaName} />}
                                  <Tag tone={sel > 0 ? 'accent' : 'neutral'}>{sel}/{keys.length} طبيب</Tag>
                                </span>
                              </div>

                              <PharmacyTools
                                key={`${pid}:${p.name}`}
                                token={token} planId={planId} area={a} pharmacy={p} expanded={expanded}
                                onDone={() => setReloadTick(t => t + 1)} onError={setError}
                              />

                              {expanded && (
                                <div style={{ background: 'var(--c-bg)', padding: '8px 14px 12px' }}>
                                  {p.doctors.length === 0 ? (
                                    <div style={{ fontSize: 12, color: 'var(--c-text-muted)', padding: '6px 0' }}>لا أطباء مسجَّلون لهذه الصيدلية في السيرفي.</div>
                                  ) : (
                                    <div style={{ display: 'flex', gap: 6, paddingBottom: 8 }}>
                                      <button style={btnMini} onClick={() => setMany(keys, true)}>تحديد الكل</button>
                                      <button style={btnMini} onClick={() => setMany(keys, false)}>إلغاء الكل</button>
                                    </div>
                                  )}
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6 }}>
                                    {p.doctors.map(d => {
                                      const on = selected.has(d.key);
                                      return (
                                        <div
                                          key={d.id}
                                          onClick={() => setMany([d.key], !on)}
                                          style={{
                                            display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', cursor: 'pointer',
                                            borderRadius: 9, userSelect: 'none',
                                            background: on ? 'var(--c-surface)' : 'transparent',
                                            border: `1px solid ${on ? 'var(--c-accent)' : 'var(--c-border)'}`,
                                            boxShadow: on ? 'var(--shadow-sm)' : 'none',
                                            transition: 'border-color 0.15s, background 0.15s',
                                          }}
                                        >
                                          <input type="checkbox" checked={on} readOnly style={{ pointerEvents: 'none', accentColor: 'var(--c-accent)' }} />
                                          <div style={{ minWidth: 0, flex: 1 }}>
                                            <div style={{ fontSize: 12.5, fontWeight: 600, color: on ? 'var(--c-text-primary)' : 'var(--c-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                                            <div style={{ fontSize: 11, color: 'var(--c-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                              {d.specialty || 'بدون اختصاص'}{d.className ? ` · كلاس ${d.className}` : ''}
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
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
