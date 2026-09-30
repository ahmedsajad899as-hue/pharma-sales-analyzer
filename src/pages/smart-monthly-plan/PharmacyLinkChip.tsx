import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../config/icons';
import { pharmacyKey, rankPharmacies } from '../../lib/pharmacyMatch';
import { smartPlanApi } from './api';
import type { AreaPharmacy, AreaWithDoctors, PharmacyLookupHit, SurveyPharmacyRef } from './types';

/**
 * حالة ربط صيدلية «مفتوحة في الملف» بالسيرفي — شريحة واحدة داخل صف الصيدلية
 * (بأسلوب زر المبيعات المؤطَّر) بدل الشريط القديم الذي كان يحشر الاقتراحات وقائمة
 * منسدلة بكل صيدليات المنطقة أسفل كل صف. الاختيار انتقل إلى نافذة فيها بحث ذكي
 * يرتّب الأسماء بدرجة قرب، فيفيد حتى حين لا يجد الخادم أي اسم قريب بعتبته الصارمة.
 *
 *  • غير موجودة في السيرفي  → شريحة تحذيرية تفتح نافذة الاختيار.
 *  • مربوطة يدوياً          → شريحة زرقاء باسمها في الملف، الضغط يفكّ الربط.
 *  • مؤكَّدة مستقلة          → شريحة رمادية، الضغط يُعيد السؤال.
 *
 * التعريف يُحفَظ عالمياً (OpenPharmacyLink) فلا يتكرر السؤال على أي حساب.
 */
export default function PharmacyLinkChip({
  token, planId, area, pharmacy: p, surveyPharmacies, onDone, onError,
}: {
  token: string; planId: number; area: AreaWithDoctors; pharmacy: AreaPharmacy;
  surveyPharmacies: SurveyPharmacyRef[];
  onDone: () => void; onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [allAreas, setAllAreas] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<{ results: PharmacyLookupHit[]; repAreaNames: string[] } | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const name = p.name ?? '';
  const askLink = p.notInSurvey && !p.separate;

  // مجموعة البحث: كل أسماء السيرفي المعروفة عدا الصيدلية نفسها. صيدليات المنطقة
  // أولاً لأن الربط لا يُطبَّق فعلياً إلا داخل منطقة الملف (راجع entriesForArea).
  const pool = useMemo(() => {
    const self = pharmacyKey(name);
    return surveyPharmacies.filter(s => !(s.areaId === area.areaId && pharmacyKey(s.name) === self));
  }, [surveyPharmacies, area.areaId, name]);

  const sameArea = useMemo(() => pool.filter(s => s.areaId === area.areaId), [pool, area.areaId]);
  const scope = allAreas ? pool : sameArea;

  const ranked = useMemo(
    () => rankPharmacies({ pool: scope, sourceName: name, query, limit: query ? 12 : 8 }),
    [scope, name, query],
  );
  // عدد الاقتراحات القوية وحدها — لتمييز «فيها ترشيح جاهز» عن «تحتاج بحثاً».
  const strongCount = useMemo(
    () => (askLink ? rankPharmacies({ pool: sameArea, sourceName: name, limit: 20, minScore: 0.62 }).length : 0),
    [askLink, sameArea, name],
  );

  // عند فتح النافذة: نسأل الخادم أين يوجد هذا الاسم فعلاً (بلا قيد منطقة) — هذا
  // ما يفسّر «أراها في تحليل الكولات لكنها هنا غير موجودة في السيرفي».
  useEffect(() => {
    if (!open || !name) return;
    let cancelled = false;
    setLookupBusy(true); setLookup(null);
    smartPlanApi.lookupPharmacy(token, planId, name)
      .then(r => { if (!cancelled) setLookup({ results: r.results, repAreaNames: r.repAreaNames }); })
      .catch(() => { /* التشخيص إضافي — فشله لا يمنع الربط اليدوي */ })
      .finally(() => { if (!cancelled) setLookupBusy(false); });
    return () => { cancelled = true; };
  }, [open, name, token, planId]);

  useEffect(() => {
    if (!open) { setQuery(''); setAllAreas(false); return; }
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!name) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); setOpen(false); onDone(); }
    catch (e: any) { onError(e.message); }
    finally { setBusy(false); }
  };

  const fromName = p.fileEntry?.name ?? name;
  const fromArea = p.fileEntry?.areaName ?? area.areaName;

  const link = (toName: string | null) =>
    run(() => smartPlanApi.savePharmacyLink(token, planId, { fromName, areaName: fromArea, toName }));
  const unlink = () =>
    run(() => smartPlanApi.removePharmacyLink(token, planId, { fromName, areaName: fromArea }));

  const pick = (s: SurveyPharmacyRef) => {
    if (s.areaId !== area.areaId && !window.confirm(
      `«${s.name}» مسجَّلة في منطقة «${s.areaName}» لا «${area.areaName}».\n`
      + 'سيُحفَظ الربط بالاسم، لكن أطباءها لن يُحسبوا ضمن هذه المنطقة ما لم تُصحَّح منطقتها في السيرفي. متابعة؟',
    )) return;
    link(s.name);
  };

  // ── الشريحة داخل الصف ────────────────────────────────────────────────────
  const chipBase: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 7, padding: '2px 8px',
    fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0, lineHeight: 1.5, whiteSpace: 'nowrap',
  };
  const toneChip = (c: string): React.CSSProperties => ({
    ...chipBase, border: `2px solid ${c}`, background: `color-mix(in srgb, ${c} 15%, transparent)`, color: c,
  });

  if (p.linkedFrom) {
    return (
      <button
        onClick={e => { e.stopPropagation(); if (window.confirm(`فك ربط «${p.linkedFrom}» عن «${name}»؟`)) unlink(); }}
        disabled={busy} title={`مربوطة بالاسم «${p.linkedFrom}» من ملف المفتوحة — اضغط لفك الربط`}
        style={toneChip('var(--c-accent)')}
      >
        <Icon name="link" size={11} /> {p.linkedFrom}
      </button>
    );
  }

  if (p.separate) {
    return (
      <button
        onClick={e => { e.stopPropagation(); unlink(); }} disabled={busy}
        title="مؤكَّدة كصيدلية مستقلة — اضغط لإعادة السؤال"
        style={{ ...toneChip('var(--c-text-muted)'), fontWeight: 600 }}
      >
        <Icon name="checkCircle" size={11} /> مستقلة
      </button>
    );
  }

  if (!askLink) return null;

  const tone = strongCount > 0 ? 'var(--c-accent)' : 'var(--c-warning)';

  return (
    <>
      <button
        onClick={e => { e.stopPropagation(); setOpen(true); }} disabled={busy}
        title="غير موجودة في السيرفي — ابحث عن الصيدلية المطابقة أو أكّد أنها مستقلة"
        style={toneChip(tone)}
      >
        <Icon name="link" size={11} />
        {strongCount > 0 ? `${strongCount} مطابقة محتملة` : 'غير موجودة في السيرفي'}
      </button>

      {open && (
        <div onClick={e => e.stopPropagation()}>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1200 }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            background: 'var(--c-surface, #fff)', borderRadius: 16, border: '1px solid var(--c-border)',
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)', zIndex: 1201, width: 'min(94vw,460px)', maxHeight: '85vh',
            display: 'flex', flexDirection: 'column', direction: 'rtl', overflow: 'hidden',
          }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--c-border-light, var(--c-border))', background: 'var(--c-bg)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Icon name="link" size={13} /> ربط الصيدلية بالسيرفي
                </div>
                <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', display: 'flex' }}>
                  <Icon name="close" size={20} />
                </button>
              </div>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, background: 'var(--c-warning-bg)', color: 'var(--c-warning)', borderRadius: 6, padding: '2px 8px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="pharmacy" size={11} /> {name}
                </span>
                <span style={{ fontSize: 11, background: 'var(--c-bg)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)', borderRadius: 6, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="location" size={11} /> {area.areaName}
                </span>
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--c-text-muted)', lineHeight: 1.7 }}>
                مفتوحة في الملف لكنها غير مسجَّلة في السيرفي بهذا الاسم. اختر الصيدلية التي تقصدها ليُحفَظ التعريف لكل الحسابات.
              </div>
            </div>

            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--c-border-light, var(--c-border))', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', insetInlineStart: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--c-text-muted)', display: 'flex' }}>
                  <Icon name="search" size={14} />
                </span>
                <input
                  ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="ابحث باسم الصيدلية أو جزء منه..."
                  style={{
                    width: '100%', padding: '8px 10px', paddingInlineStart: 32, borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--c-border)', fontSize: 13, background: 'var(--c-surface)', color: 'var(--c-text-primary)',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {([[false, `${area.areaName} (${sameArea.length})`], [true, `كل المناطق (${pool.length})`]] as const).map(([v, label]) => (
                  <button key={String(v)} onClick={() => setAllAreas(v)} style={{
                    padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                    border: `1px solid ${allAreas === v ? 'var(--c-accent)' : 'var(--c-border)'}`,
                    background: allAreas === v ? 'var(--c-accent)' : 'var(--c-surface)',
                    color: allAreas === v ? '#fff' : 'var(--c-text-secondary)',
                  }}>{label}</button>
                ))}
                <span style={{ marginInlineStart: 'auto', fontSize: 10, color: 'var(--c-text-muted)' }}>
                  {query ? 'نتائج البحث' : 'الأقرب للاسم تلقائياً'}
                </span>
              </div>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, padding: '12px 16px' }}>
              {/* ── تشخيص: أين يوجد هذا الاسم فعلاً؟ ──────────────────────── */}
              {(lookupBusy || lookup) && (() => {
                const hits = lookup?.results ?? [];
                const surveyHits = hits.filter(h => h.inSurvey || h.doctorCount > 0);
                const outOfScope = surveyHits.filter(h => !h.inRepScope);
                const visitOnly = hits.filter(h => !h.inSurvey && h.doctorCount === 0 && h.visitCount > 0);
                let verdict = '';
                let tone = 'var(--c-text-muted)';
                if (lookupBusy) verdict = 'جارٍ فحص مصادر هذا الاسم…';
                else if (surveyHits.some(h => h.inRepScope)) {
                  verdict = 'الاسم موجود في السيرفي ضمن مناطق هذا المندوب — اختره من القائمة ليُربَط.';
                  tone = 'var(--c-success)';
                } else if (outOfScope.length) {
                  verdict = `مسجَّلة في السيرفي لكن ضمن منطقة «${outOfScope[0].areaName || 'بلا منطقة'}» وهي ليست من مناطق هذا المندوب — لذلك لا تظهر هنا.`;
                  tone = 'var(--c-warning)';
                } else if (visitOnly.length) {
                  verdict = 'هذا الاسم معروف من زيارات الصيدليات فقط ولا صف له في السيرفي — لذلك لا أطباء له في البلان.';
                  tone = 'var(--c-warning)';
                } else {
                  verdict = 'لم يُعثر على هذا الاسم في السيرفي ولا في زيارات الصيدليات — صيدلية جديدة على النظام.';
                }
                return (
                  <div style={{
                    background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: 10,
                    padding: '9px 11px', marginBottom: 10,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-text-secondary)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
                      <Icon name="search" size={11} /> أين يوجد هذا الاسم؟
                    </div>
                    <div style={{ fontSize: 11.5, color: tone, lineHeight: 1.7 }}>{verdict}</div>
                    {/* لا صفّ لها في السيرفي أصلاً: الربط عديم الفائدة، والحل تسجيلها مرة واحدة */}
                    {!lookupBusy && surveyHits.length === 0 && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          const regName = visitOnly[0]?.name || name;
                          if (!window.confirm(
                            `تسجيل «${regName}» في السيرفي ضمن منطقة «${area.areaName}»؟\n`
                            + 'ستظهر لكل الحسابات كصيدلية مسجَّلة، ويمكن إضافة أطبائها لاحقاً.',
                          )) return;
                          run(() => smartPlanApi.registerPharmacyInSurvey(token, planId, { name: regName, areaName: area.areaName }));
                        }}
                        style={{
                          marginTop: 8, width: '100%', border: '1px solid var(--c-accent)', background: 'var(--c-accent)',
                          color: '#fff', borderRadius: 8, padding: '7px 10px', fontSize: 12, fontWeight: 700,
                          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                        }}
                      >
                        <Icon name="add" size={12} /> سجّلها في السيرفي — منطقة {area.areaName}
                      </button>
                    )}
                    {hits.length > 0 && (
                      <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {hits.slice(0, 5).map(h => {
                          const linkable = h.inSurvey || h.doctorCount > 0;
                          return (
                            <div key={`${h.name}|${h.areaName}`} style={{
                              display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                              background: 'var(--c-surface)', border: '1px solid var(--c-border)',
                              borderRadius: 8, padding: '5px 8px', fontSize: 11,
                            }}>
                              <span style={{ fontWeight: 700, color: 'var(--c-text-primary)' }}>{h.name}</span>
                              <span style={{ color: h.inRepScope ? 'var(--c-text-muted)' : 'var(--c-warning)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                <Icon name="location" size={10} /> {h.areaName || 'بلا منطقة'}{h.inRepScope ? '' : ' (خارج مناطق المندوب)'}
                              </span>
                              {h.inSurvey && <span style={{ color: 'var(--c-success)' }}>في السيرفي</span>}
                              {h.doctorCount > 0 && <span style={{ color: 'var(--c-text-secondary)' }}>{h.doctorCount} طبيب</span>}
                              {h.visitCount > 0 && <span style={{ color: 'var(--c-text-secondary)' }}>{h.visitCount} زيارة</span>}
                              {linkable && (
                                <button
                                  disabled={busy}
                                  onClick={() => {
                                    if (!h.inRepScope && !window.confirm(
                                      `«${h.name}» مسجَّلة في منطقة «${h.areaName || 'بلا منطقة'}» خارج مناطق هذا المندوب.\n`
                                      + 'سيُحفَظ الربط بالاسم، لكن أطباءها لن يدخلوا البلان ما لم تُضَف تلك المنطقة للمندوب أو تُصحَّح منطقتها في السيرفي. متابعة؟',
                                    )) return;
                                    link(h.name);
                                  }}
                                  style={{
                                    marginInlineStart: 'auto', border: '1px solid var(--c-accent)', background: 'var(--c-accent-light)',
                                    color: 'var(--c-accent)', borderRadius: 6, padding: '2px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                                  }}
                                >ربط بهذه</button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {ranked.length === 0 ? (
                <div style={{ padding: '18px 12px', textAlign: 'center', fontSize: 12, color: 'var(--c-text-muted)', lineHeight: 1.9 }}>
                  {query ? 'لا نتائج مطابقة.' : 'لا توجد صيدلية قريبة من هذا الاسم في المنطقة.'}
                  <br />
                  جرّب البحث بكلمة واحدة من الاسم{!allAreas && ' أو وسّع البحث إلى كل المناطق'}.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {ranked.map(({ item, score, reason }) => {
                    const pct = Math.round(score * 100);
                    const c = score >= 0.85 ? 'var(--c-success)' : score >= 0.6 ? 'var(--c-accent)' : 'var(--c-warning)';
                    return (
                      <button
                        key={`${item.areaId}:${item.name}`} disabled={busy} onClick={() => pick(item)}
                        style={{
                          textAlign: 'start', background: 'var(--c-bg)', borderRadius: 10, padding: '10px 12px',
                          border: '1px solid var(--c-border)', borderInlineStart: `3px solid ${c}`,
                          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, display: 'block', width: '100%',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)' }}>{item.name}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, borderRadius: 999, padding: '2px 8px', flexShrink: 0 }}>
                            {pct}%
                          </span>
                        </div>
                        <div style={{ marginTop: 5, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          {reason && <span style={{ fontSize: 10, color: 'var(--c-text-muted)' }}>{reason}</span>}
                          <span style={{ fontSize: 10, color: 'var(--c-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <Icon name="doctor" size={10} /> {item.doctorCount} طبيب
                          </span>
                          {item.areaId !== area.areaId && (
                            <span style={{ fontSize: 10, color: 'var(--c-warning)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              <Icon name="location" size={10} /> {item.areaName}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--c-border-light, var(--c-border))', background: 'var(--c-bg)', flexShrink: 0, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                disabled={busy} onClick={() => link(null)}
                title="لا تُقترح لها روابط بعد الآن (يُطبَّق على كل الحسابات)"
                style={{
                  padding: '6px 12px', borderRadius: 'var(--radius-sm)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: '1px solid var(--c-danger-border)', background: 'var(--c-danger-bg)', color: 'var(--c-danger)',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                }}
              >
                <Icon name="blocked" size={12} /> صيدلية مستقلة — لا تسأل مجدداً
              </button>
              <button
                disabled={busy} onClick={() => setOpen(false)}
                style={{
                  marginInlineStart: 'auto', padding: '6px 12px', borderRadius: 'var(--radius-sm)', fontSize: 12,
                  fontWeight: 600, cursor: 'pointer', border: '1px solid var(--c-border)',
                  background: 'var(--c-surface)', color: 'var(--c-text-secondary)',
                }}
              >إغلاق</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
