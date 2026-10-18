import { useEffect, useMemo, useRef, useState } from 'react';
import { smartPlanApi } from './api';
import { Icon } from '../../config/icons';
import PharmacyLinkChip from './PharmacyLinkChip';
import PharmacyTools from './PharmacyTools';
import PharmacySalesButton, { usePharmacyNet } from './PharmacySalesButton';
import { FilterStat, Tag, TriCheck, btnMini, inputStyle } from './ui';
import type { AreaWithDoctors, SurveyPharmacyRef } from './types';

/**
 * شريحة العرض — واحدة فقط في كل لحظة، وتُختار من بطاقات الأرقام نفسها بدل شريط
 * فلاتر منفصل. «مفتوحة بلا مبيع» و«غير مفتوحة وبلا مبيع» هما الحالتان الأهم للبلان.
 */
type View = 'all' | 'open' | 'sales' | 'openNoSales' | 'dead' | 'selected' | 'link';

/**
 * مناطق المندوب العلمي → صيدلياتها → أطباء كل صيدلية (اختصاص/كلاس). الضغط على
 * الصيدلية يفتح أطباءها، والضغط على أي مكان في صف الطبيب يحدّده أو يلغيه، ومربع
 * التحديد الثلاثي على المنطقة/الصيدلية يحدّد أطباءها كلهم دفعة واحدة.
 * الاختيار يُحفَظ تلقائياً ويُطبَّق عند «توليد البلان».
 */
export default function AreaDoctorsPanel({
  token, planId, refreshKey, onSelectionChange,
}: {
  token: string; planId: number; refreshKey: string;
  onSelectionChange?: (selected: number, total: number) => void;
}) {
  const [areas, setAreas] = useState<AreaWithDoctors[]>([]);
  const [surveyPharmacies, setSurveyPharmacies] = useState<SurveyPharmacyRef[]>([]);
  const [hasOpenFile, setHasOpenFile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [expandedAreas, setExpandedAreas] = useState<Set<number>>(new Set());
  const [openPharmacies, setOpenPharmacies] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>('all');
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
    const has = (p: AreaWithDoctors['pharmacies'][number]) => (salesOf(p.name) ?? 0) > 0;
    const keep = (p: AreaWithDoctors['pharmacies'][number]) => {
      switch (view) {
        case 'open': if (!p.openPharmacy) return false; break;
        case 'sales': if (!has(p)) return false; break;
        case 'openNoSales': if (!p.openPharmacy || has(p)) return false; break;
        case 'dead': if (!p.name || p.openPharmacy || has(p)) return false; break;
        case 'selected': if (!p.doctors.some(d => selected.has(d.key))) return false; break;
        case 'link': if (!(p.name && p.notInSurvey && !p.separate)) return false; break;
      }
      if (!q) return true;
      return !!p.name?.toLowerCase().includes(q)
        || p.doctors.some(d => d.name.toLowerCase().includes(q) || d.specialty?.toLowerCase().includes(q));
    };
    return areas.map(a => ({
      ...a,
      shown: a.pharmacies.map((p, idx) => ({ ...p, idx })).filter(keep),
    }));
  }, [areas, view, q, salesOf, selected]);

  const allDocs = areas.flatMap(a => a.pharmacies.flatMap(p => p.doctors.map(d => ({ d, open: p.openPharmacy, pharm: p.name }))));
  const allPharms = areas.flatMap(a => a.pharmacies).filter(p => p.name);
  const totalPharmacies = allPharms.length;
  const totalOpen = allPharms.filter(p => p.openPharmacy).length;
  // صيدليات ينتظر النظام قراراً بشأنها — شريط تنبيه مستقل عن بطاقات العرض
  const needLinkCount = allPharms.filter(p => p.notInSurvey && !p.separate).length;
  const totalIncluded = allDocs.filter(x => selected.has(x.d.key)).length;
  const allKeys = allDocs.map(x => x.d.key);
  const hasSales = (name: string | null) => (salesOf(name) ?? 0) > 0;
  const withSalesCount = net.ready ? allPharms.filter(p => hasSales(p.name)).length : 0;
  const openNoSalesCount = (hasOpenFile && net.ready) ? allPharms.filter(p => p.openPharmacy && !hasSales(p.name)).length : 0;
  // غير مفتوحة ولا لها مبيع بنفس الوقت — صيدليات بلا أي نشاط مسجَّل، تحتاج أهم متابعة
  const deadCount = (hasOpenFile && net.ready) ? allPharms.filter(p => !p.openPharmacy && !hasSales(p.name)).length : 0;

  useEffect(() => { onSelectionChange?.(totalIncluded, allDocs.length); }, [totalIncluded, allDocs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownPharmCount = visibleAreas.reduce((s, a) => s + a.shown.filter(p => p.name).length, 0);
  const shownKeysAll = visibleAreas.flatMap(a => a.shown.flatMap(p => p.doctors.map(d => d.key)));
  const filtersActive = view !== 'all' || !!q;
  const pickView = (v: View) => setView(cur => (cur === v ? 'all' : v));

  const classes = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const x of allDocs) {
      const c = x.d.className?.trim();
      if (!c) continue;
      if (!m.has(c)) m.set(c, []);
      m.get(c)!.push(x.d.key);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [areas]); // eslint-disable-line react-hooks/exhaustive-deps

  const allExpanded = areas.length > 0 && expandedAreas.size >= areas.length;

  const toolGroups: { title: string; items: { label: string; run: () => void; disabled?: boolean }[] }[] = [
    {
      title: 'التحديد',
      items: [
        { label: `تحديد كل الأطباء (${allKeys.length})`, run: () => setMany(allKeys, true) },
        { label: 'إلغاء تحديد الكل', run: () => setMany(allKeys, false) },
        { label: `تحديد المعروض حالياً (${shownKeysAll.length})`, run: () => setMany(shownKeysAll, true), disabled: !filtersActive },
        { label: 'إلغاء المعروض حالياً', run: () => setMany(shownKeysAll, false), disabled: !filtersActive },
      ],
    },
    {
      title: 'استبدال التحديد بـ',
      items: [
        ...(hasOpenFile ? [{
          label: 'أطباء الصيدليات المفتوحة فقط',
          run: () => persist(new Set(allDocs.filter(x => x.open).map(x => x.d.key))),
        }] : []),
        ...(net.ready ? [{
          label: 'أطباء الصيدليات التي لها مبيع فقط',
          run: () => persist(new Set(allDocs.filter(x => hasSales(x.pharm)).map(x => x.d.key))),
        }] : []),
        ...(hasOpenFile && net.ready ? [{
          label: 'المفتوحة + التي لها مبيع',
          run: () => persist(new Set(allDocs.filter(x => x.open || hasSales(x.pharm)).map(x => x.d.key))),
        }] : []),
      ],
    },
    {
      title: 'إضافة حسب الكلاس',
      items: classes.map(([c, keys]) => ({ label: `إضافة كلاس ${c} (${keys.length})`, run: () => setMany(keys, true) })),
    },
    {
      title: 'العرض',
      items: [{
        label: allExpanded ? 'طي كل المناطق' : 'فتح كل المناطق',
        run: () => setExpandedAreas(allExpanded ? new Set() : new Set(areas.map(a => a.areaId))),
      }],
    },
  ].filter(g => g.items.length);

  const registerAll = async () => {
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
      if (view === 'link') setView('all');
      setReloadTick(t => t + 1);
    } catch (e: any) { setError(e.message); }
    finally { setRegistering(false); }
  };

  if (loading && !areas.length) return <div style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>جارٍ التحميل…</div>;
  if (!loading && areas.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
        {error || 'لا توجد مناطق مُعيَّنة لهذا المندوب العلمي.'}
      </div>
    );
  }

  return (
    <div>
      {error && <div style={{ color: 'var(--c-danger)', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {/* بطاقات الأرقام = فلاتر العرض */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <FilterStat label="كل الصيدليات" value={totalPharmacies} active={view === 'all'} onClick={() => setView('all')} />
        {hasOpenFile && <FilterStat label="مفتوحة" value={totalOpen} tone="success" active={view === 'open'} onClick={() => pickView('open')} />}
        {net.ready && <FilterStat label="لها مبيع" value={withSalesCount} tone="success" active={view === 'sales'} onClick={() => pickView('sales')} />}
        {hasOpenFile && net.ready && (
          <FilterStat label="مفتوحة بلا مبيع" value={openNoSalesCount} tone="accent" active={view === 'openNoSales'} onClick={() => pickView('openNoSales')}
            title="صيدلية مفتوحة من المكتب ولا يوجد لها مبيع — فرصة مباشرة للبلان" />
        )}
        {hasOpenFile && net.ready && (
          <FilterStat label="غير مفتوحة وبلا مبيع" value={deadCount} tone="danger" active={view === 'dead'} onClick={() => pickView('dead')} />
        )}
        <FilterStat label="محدَّد للبلان" value={`${totalIncluded} / ${allDocs.length}`} tone="accent" active={view === 'selected'} onClick={() => pickView('selected')}
          title="عرض الصيدليات التي فيها أطباء محدَّدون فقط" />
      </div>

      {!hasOpenFile && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--c-text-secondary)',
          background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: 10,
          padding: '8px 12px', marginBottom: 12,
        }}>
          <Icon name="warning" size={13} style={{ color: 'var(--c-text-muted)' }} />
          ارفع ملف «صيدليات مفتوحة» في خطوة الملفات ليُؤشَّر أي صيدلية مفتوحة وأيها لا.
        </div>
      )}

      {/* تنبيه الربط — منفصل عن أدوات العرض لأنه قرار يحتاجه النظام لا فلتر */}
      {needLinkCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5,
          background: 'var(--c-warning-bg)', border: '1px solid var(--c-warning-border)', borderRadius: 10,
          padding: '8px 12px', marginBottom: 12, color: 'var(--c-text-primary)',
        }}>
          <Icon name="link" size={13} style={{ color: 'var(--c-warning)' }} />
          <span><strong>{needLinkCount}</strong> صيدلية مفتوحة غير موجودة في السيرفي — تحتاج ربطاً أو تسجيلاً</span>
          <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => pickView('link')} style={{
              ...btnMini,
              ...(view === 'link' ? { background: 'var(--c-warning)', color: '#fff', borderColor: 'var(--c-warning)' } : {}),
            }}>
              {view === 'link' ? 'إخفاؤها' : 'عرضها للمراجعة'}
            </button>
            <button disabled={registering} onClick={registerAll} style={{
              ...btnMini, background: 'var(--c-accent)', color: '#fff', borderColor: 'var(--c-accent)', opacity: registering ? 0.6 : 1,
            }}>
              {registering
                ? <><Icon name="loading" size={12} className="icon-spin" /> جارٍ التسجيل…</>
                : <><Icon name="add" size={12} /> سجّلها كلها في السيرفي</>}
            </button>
          </span>
        </div>
      )}

      {registerMsg && (
        <div style={{
          fontSize: 12, color: 'var(--c-success)', background: 'var(--c-success-bg)',
          border: '1px solid var(--c-success-border)', borderRadius: 9, padding: '7px 11px', marginBottom: 10,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Icon name="checkCircle" size={13} /> {registerMsg}
        </div>
      )}

      {/* بحث + أدوات */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 190 }}>
          <Icon name="search" size={13} style={{ position: 'absolute', insetInlineStart: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--c-text-muted)' }} />
          <input
            placeholder="بحث باسم الصيدلية أو الطبيب أو الاختصاص…"
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ ...inputStyle, width: '100%', paddingInlineStart: 30 }}
          />
        </div>

        {saving !== 'idle' && (
          <Tag tone={saving === 'saved' ? 'success' : 'neutral'}>{saving === 'saving' ? 'جارٍ الحفظ…' : 'تم الحفظ'}</Tag>
        )}

        <div style={{ position: 'relative' }}>
          <button onClick={() => setToolsOpen(v => !v)} style={{ ...btnMini, padding: '8px 12px', fontSize: 12 }}>
            <Icon name="check" size={12} /> أدوات التحديد ▾
          </button>
          {toolsOpen && (
            <>
              <div onClick={() => setToolsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={{
                position: 'absolute', insetInlineEnd: 0, top: 'calc(100% + 6px)', zIndex: 41,
                background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 11,
                boxShadow: 'var(--shadow-md)', padding: 5, minWidth: 250, maxHeight: 420, overflowY: 'auto',
              }}>
                {toolGroups.map((g, gi) => (
                  <div key={g.title} style={{ borderTop: gi ? '1px solid var(--c-border-light)' : 'none', paddingTop: gi ? 4 : 0, marginTop: gi ? 4 : 0 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--c-text-muted)', fontWeight: 700, padding: '4px 10px' }}>{g.title}</div>
                    {g.items.map(t => (
                      <button
                        key={t.label} disabled={t.disabled}
                        onClick={() => { t.run(); setToolsOpen(false); }}
                        style={{
                          display: 'block', width: '100%', textAlign: 'start', border: 'none', borderRadius: 8,
                          background: 'transparent', padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit',
                          color: t.disabled ? 'var(--c-text-muted)' : 'var(--c-text-secondary)',
                          cursor: t.disabled ? 'default' : 'pointer', fontWeight: 600,
                        }}
                      >{t.label}</button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--c-text-muted)', marginBottom: 12 }}>
        {filtersActive
          ? <>يُعرض الآن <strong style={{ color: 'var(--c-text-secondary)' }}>{shownPharmCount}</strong> صيدلية · <strong style={{ color: 'var(--c-text-secondary)' }}>{shownKeysAll.length}</strong> طبيب</>
          : `${areas.length} منطقة · ${totalPharmacies} صيدلية · ${allDocs.length} طبيب — اضغط المنطقة لعرض صيدلياتها، والمربع بجانبها لتحديد أطبائها كلهم.`}
        {filtersActive && (
          <button
            onClick={() => { setView('all'); setSearch(''); }}
            style={{ ...btnMini, padding: '2px 8px', fontSize: 11, marginInlineStart: 8 }}
          >مسح الفلاتر</button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {visibleAreas.map(a => {
          if (filtersActive && a.shown.length === 0) return null;
          // عند الفلترة تُفتح المناطق تلقائياً حتى تظهر النتائج دون نقرة إضافية
          const areaCollapsed = !expandedAreas.has(a.areaId) && !filtersActive;
          const pharmacyCount = a.shown.filter(p => p.name).length;
          const shownKeys = a.shown.flatMap(p => p.doctors.map(d => d.key));
          const shownSelected = shownKeys.filter(k => selected.has(k)).length;
          const openPharmaciesInArea = a.shown.filter(p => p.name && p.openPharmacy).length;
          return (
            <div key={a.areaId} style={{ border: '1px solid var(--c-border)', borderRadius: 12, overflow: 'hidden', background: 'var(--c-surface)' }}>
              <div
                onClick={() => setExpandedAreas(prev => { const n = new Set(prev); n.has(a.areaId) ? n.delete(a.areaId) : n.add(a.areaId); return n; })}
                style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--c-bg)', cursor: 'pointer' }}
              >
                <TriCheck total={shownKeys.length} selected={shownSelected} onChange={inc => setMany(shownKeys, inc)} />
                <strong style={{ fontSize: 13.5, color: 'var(--c-text-primary)' }}>{a.areaName}</strong>
                <Tag>{pharmacyCount} صيدلية</Tag>
                {hasOpenFile && openPharmaciesInArea > 0 && <Tag tone="success">{openPharmaciesInArea} مفتوحة</Tag>}
                <Tag tone={shownSelected > 0 ? 'accent' : 'neutral'}>{shownSelected}/{shownKeys.length} طبيب</Tag>
                <span style={{ marginInlineStart: 'auto', fontSize: 11, color: 'var(--c-text-muted)' }}>{areaCollapsed ? '▼' : '▲'}</span>
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
                          display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px', cursor: 'pointer', flexWrap: 'wrap',
                          borderInlineStart: `3px solid ${hasOpenFile && p.openPharmacy ? 'var(--c-success)' : 'transparent'}`,
                        }}
                      >
                        <TriCheck total={keys.length} selected={sel} onChange={inc => setMany(keys, inc)} />
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
                          <span style={{ fontSize: 10, color: 'var(--c-text-muted)', width: 10 }}>{expanded ? '▲' : '▼'}</span>
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
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 5 }}>
                              {p.doctors.map(d => {
                                const on = selected.has(d.key);
                                return (
                                  <div
                                    key={d.id}
                                    onClick={() => setMany([d.key], !on)}
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', cursor: 'pointer',
                                      borderRadius: 8, userSelect: 'none',
                                      background: on ? 'var(--c-surface)' : 'transparent',
                                      border: `1px solid ${on ? 'var(--c-accent)' : 'var(--c-border)'}`,
                                      transition: 'border-color 0.15s, background 0.15s',
                                    }}
                                  >
                                    <input type="checkbox" checked={on} readOnly style={{ pointerEvents: 'none', accentColor: 'var(--c-accent)', margin: 0 }} />
                                    <div style={{ minWidth: 0, flex: 1, fontSize: 12.5, fontWeight: 600, color: on ? 'var(--c-text-primary)' : 'var(--c-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {d.name}
                                      <span style={{ fontSize: 11, color: 'var(--c-text-muted)', fontWeight: 500 }}> · {d.specialty || 'بدون اختصاص'}</span>
                                    </div>
                                    {d.className && <Tag>{d.className}</Tag>}
                                  </div>
                                );
                              })}
                            </div>
                          )}
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
    </div>
  );
}
