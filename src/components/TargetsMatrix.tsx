import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './TargetsMatrix.css';

/**
 * جدول التارگت الشامل: المندوبون أفقياً × الايتمات عمودياً لشهر واحد.
 * تحرير مباشر في الخلية، لصق كتلة من إكسل، تنقّل بالأسهم/Enter، تعميم قيمة على
 * صف كامل، إجماليات للصف والعمود، وتدرّج لوني هادئ حسب حجم التارگت.
 *
 * البيانات بطلب واحد: GET /api/targets/matrix (تارگتات + نطاق ايتمات كل مندوب
 * علمي). الحفظ upsert لكل مندوب عُدّل عبر PUT /api/targets — نفس مسار الصفحة.
 * خلية خارج نطاق ايتمات المندوب العلمي مقفلة (نفس قاعدة جدول المندوب الواحد).
 */

const API = import.meta.env.VITE_API_URL || '';

interface NamedItem { id: number; name: string; }
interface MatrixRep { id: number; name: string; company?: string | null; role?: string; }

interface Props {
  repType: 'scientific' | 'commercial';
  reps: MatrixRep[];
  allItems: NamedItem[];
  month: number;
  year: number;
  monthLabel: string;
  token: string | null;
  reloadKey?: number;
  onOpenRep: (repId: number) => void;
}

const key = (repId: number, itemId: number) => `${repId}:${itemId}`;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const AVATAR_COLORS = ['#3b6fd8', '#2f8f83', '#7a62c9', '#c0794a', '#4a8bb5', '#5b8a4f', '#b4587a', '#5a6a8a'];
const avatarColor = (s: string) => {
  let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
};
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('');
const clean = (v: string) => v.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\d.]/g, '');

export default function TargetsMatrix({ repType, reps, allItems, month, year, monthLabel, token, reloadKey = 0, onOpenRep }: Props) {
  const H = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState<Map<string, number>>(new Map());
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [scopes, setScopes] = useState<Record<number, Set<number> | null>>({});
  const [scopeItems, setScopeItems] = useState<NamedItem[]>([]);
  const [targetItems, setTargetItems] = useState<NamedItem[]>([]);

  const [search, setSearch] = useState('');
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [company, setCompany] = useState<string>('');
  const [fillItem, setFillItem] = useState<number | null>(null);
  const [fillVal, setFillVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());

  const tableRef = useRef<HTMLTableElement>(null);
  const colStyleRef = useRef<HTMLStyleElement>(null);
  const editsRef = useRef(edits); editsRef.current = edits;
  const periodRef = useRef({ month, year, repType });

  const repIdsKey = reps.map(r => r.id).join(',');

  // ── تحميل ──
  const load = useCallback(async () => {
    if (!repIdsKey) { setSaved(new Map()); setScopes({}); setScopeItems([]); setTargetItems([]); return; }
    setLoading(true);
    try {
      const qs = new URLSearchParams({ repType, month: String(month), year: String(year), repIds: repIdsKey });
      const r = await fetch(`${API}/api/targets/matrix?${qs}`, { headers: H });
      const j = await r.json();
      const d = j.data ?? { targets: [], scopes: {}, scopeItems: [] };
      const m = new Map<string, number>();
      const tItems = new Map<number, NamedItem>();
      for (const t of d.targets as { repId: number; itemId: number; target: number; item: NamedItem }[]) {
        m.set(key(t.repId, t.itemId), t.target);
        if (t.item) tItems.set(t.item.id, t.item);
      }
      const sc: Record<number, Set<number> | null> = {};
      for (const [id, ids] of Object.entries(d.scopes as Record<string, number[] | null>)) sc[+id] = ids ? new Set(ids) : null;
      setSaved(m); setScopes(sc); setScopeItems(d.scopeItems ?? []); setTargetItems([...tItems.values()]);
      setEdits(new Map());
    } catch {
      setMsg({ ok: false, text: 'تعذّر تحميل التارگتات' });
    } finally {
      setLoading(false);
    }
  }, [repType, month, year, repIdsKey, H]);

  // ── الحفظ (لفترة محددة — تُستعمل أيضاً لحفظ تعديلات شهر سابق قبل الانتقال) ──
  const saveEdits = useCallback(async (pending: Map<string, string>, period: { month: number; year: number; repType: string }) => {
    const byRep = new Map<number, { itemId: number; target: number }[]>();
    pending.forEach((v, k) => {
      const [repId, itemId] = k.split(':').map(Number);
      if (!byRep.has(repId)) byRep.set(repId, []);
      byRep.get(repId)!.push({ itemId, target: parseFloat(v) || 0 });
    });
    const queue = [...byRep.entries()];
    let ok = 0; const failed: number[] = [];
    const worker = async () => {
      while (queue.length) {
        const [repId, targets] = queue.shift()!;
        try {
          const res = await fetch(`${API}/api/targets`, {
            method: 'PUT', headers: H,
            body: JSON.stringify({ repType: period.repType, repId, month: period.month, year: period.year, targets }),
          });
          if (res.ok) ok++; else failed.push(repId);
        } catch { failed.push(repId); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));
    return { ok, failed };
  }, [H]);

  // تغيّر الفترة/النوع مع تعديلات معلّقة → اسأل قبل أن تضيع
  useEffect(() => {
    const prev = periodRef.current;
    const pending = editsRef.current;
    const changed = prev.month !== month || prev.year !== year || prev.repType !== repType;
    periodRef.current = { month, year, repType };
    if (changed && pending.size > 0 &&
        window.confirm(`لديك ${pending.size} تعديل غير محفوظ على تارگت الفترة السابقة — حفظها قبل الانتقال؟`)) {
      saveEdits(pending, prev).then(load);
      return;
    }
    load();
  }, [load, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (editsRef.current.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // ── الصفوف والأعمدة ──
  const inScope = useCallback((repId: number, itemId: number) => {
    const s = scopes[repId];
    return s === undefined || s === null || s.has(itemId);
  }, [scopes]);

  const companies = useMemo(() => {
    const set = new Set<string>();
    reps.forEach(r => set.add(r.company || ''));
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [reps]);

  const visReps = useMemo(() => {
    const list = company ? reps.filter(r => (r.company || '') === company) : reps;
    return list.slice().sort((a, b) => (a.company || '').localeCompare(b.company || '') || a.name.localeCompare(b.name));
  }, [reps, company]);

  const value = useCallback((repId: number, itemId: number): string => {
    const k = key(repId, itemId);
    if (edits.has(k)) return edits.get(k)!;
    const s = saved.get(k);
    return s === undefined ? '' : String(s);
  }, [edits, saved]);
  const num = (repId: number, itemId: number) => parseFloat(value(repId, itemId)) || 0;

  const allRows = useMemo(() => {
    const map = new Map<number, NamedItem>();
    const anyUnrestricted = reps.some(r => !scopes[r.id]);
    if (anyUnrestricted) allItems.forEach(i => { if (!i.name.includes('(مؤقت)')) map.set(i.id, i); });
    scopeItems.forEach(i => map.set(i.id, i));
    targetItems.forEach(i => map.set(i.id, i));
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [reps, scopes, allItems, scopeItems, targetItems]);

  const visRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter(it => {
      if (q && !it.name.toLowerCase().includes(q)) return false;
      // ايتم لا يحمله أي مندوب ظاهر لا معنى لصفّه
      if (!visReps.some(r => inScope(r.id, it.id))) return false;
      if (onlyFilled && !visReps.some(r => num(r.id, it.id) > 0)) return false;
      return true;
    });
  }, [allRows, search, onlyFilled, visReps, inScope, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxVal = useMemo(() => {
    let m = 0;
    visRows.forEach(it => visReps.forEach(r => { const v = num(r.id, it.id); if (v > m) m = v; }));
    return m;
  }, [visRows, visReps, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const colTotals = useMemo(() => visReps.map(r => visRows.reduce((s, it) => s + num(r.id, it.id), 0)),
    [visReps, visRows, value]); // eslint-disable-line react-hooks/exhaustive-deps
  const grand = colTotals.reduce((a, b) => a + b, 0);
  const filledCells = useMemo(() => {
    let n = 0; visRows.forEach(it => visReps.forEach(r => { if (num(r.id, it.id) > 0) n++; })); return n;
  }, [visRows, visReps, value]); // eslint-disable-line react-hooks/exhaustive-deps

  // مجموعات الشركات لرأس الجدول
  const groups = useMemo(() => {
    const g: { name: string; span: number }[] = [];
    visReps.forEach(r => {
      const n = r.company || 'بدون شركة';
      if (g.length && g[g.length - 1].name === n) g[g.length - 1].span++;
      else g.push({ name: n, span: 1 });
    });
    return g;
  }, [visReps]);
  const showGroups = groups.length > 1 || (groups.length === 1 && groups[0].name !== 'بدون شركة');

  // ── تحرير ──
  const setCell = (repId: number, itemId: number, raw: string) => {
    const k = key(repId, itemId);
    const v = clean(raw);
    setEdits(prev => {
      const n = new Map(prev);
      const orig = saved.get(k);
      if ((orig === undefined && v === '') || (orig !== undefined && v !== '' && parseFloat(v) === orig)) n.delete(k);
      else n.set(k, v);
      return n;
    });
    setMsg(null);
  };

  const focusCell = (r: number, c: number) => {
    const el = tableRef.current?.querySelector<HTMLInputElement>(`input[data-cell="${r}-${c}"]`);
    if (el) { el.focus(); el.select(); return true; }
    return false;
  };
  const move = (r: number, c: number, dr: number, dc: number) => {
    // يتخطّى الخلايا المقفلة (خارج النطاق)
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < visRows.length && nc >= 0 && nc < visReps.length) {
      if (focusCell(nr, nc)) return;
      nr += dr; nc += dc;
    }
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    // RTL: السهم الأيسر يتقدّم للعمود التالي بصرياً
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); move(r, c, 1, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(r, c, -1, 0); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(r, c, 0, 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(r, c, 0, -1); }
    else if (e.key === 'Escape') {
      const rep = visReps[c], it = visRows[r];
      setEdits(prev => { const n = new Map(prev); n.delete(key(rep.id, it.id)); return n; });
    }
  };
  // لصق كتلة من إكسل تبدأ من الخلية الحالية
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
    setEdits(prev => {
      const n = new Map(prev);
      grid.forEach((line, i) => line.forEach((cellVal, j) => {
        const it = visRows[r + i], rep = visReps[c + j];
        if (!it || !rep || !inScope(rep.id, it.id)) return;
        const v = clean(cellVal);
        if (v === '') return;
        const k = key(rep.id, it.id);
        if (saved.get(k) === parseFloat(v)) n.delete(k); else n.set(k, v);
      }));
      return n;
    });
  };

  const applyFill = (itemId: number) => {
    const v = clean(fillVal);
    if (v !== '') visReps.forEach(rep => { if (inScope(rep.id, itemId)) setCell(rep.id, itemId, v); });
    setFillItem(null); setFillVal('');
  };

  const save = async () => {
    if (edits.size === 0) return;
    setSaving(true); setMsg(null);
    const pending = new Map(edits);
    const { ok, failed } = await saveEdits(pending, { month, year, repType });
    const failedSet = new Set(failed);
    // ما نجح يُدمج في المحفوظ ويُومض، وما فشل يبقى معلّقاً
    setSaved(prev => {
      const n = new Map(prev);
      pending.forEach((v, k) => { if (!failedSet.has(+k.split(':')[0])) n.set(k, parseFloat(v) || 0); });
      return n;
    });
    setEdits(prev => {
      const n = new Map(prev);
      pending.forEach((_, k) => { if (!failedSet.has(+k.split(':')[0])) n.delete(k); });
      return n;
    });
    setFlash(new Set([...pending.keys()].filter(k => !failedSet.has(+k.split(':')[0]))));
    setTimeout(() => setFlash(new Set()), 1300);
    setSaving(false);
    setMsg(failed.length === 0
      ? { ok: true, text: `✓ حُفظ تارگت ${ok} مندوب` }
      : { ok: false, text: `⚠ فشل حفظ ${failed.length}: ${failed.map(id => reps.find(r => r.id === id)?.name ?? id).join('، ')}` });
  };

  // إبراز العمود تحت المؤشر — قاعدة CSS واحدة بدل إعادة رسم الجدول كله
  const onHover = (e: React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-c]');
    const c = cell?.dataset.c;
    if (colStyleRef.current) colStyleRef.current.textContent = c === undefined ? '' :
      `.tm-table [data-c="${c}"]:not(.tm-sticky){box-shadow:inset 0 0 0 999px rgba(26,86,219,.05)}`
      + `.tm-table thead [data-c="${c}"]{background:#e7edf8 !important}`;
  };

  if (reps.length === 0) {
    return (
      <div className="tm"><div className="tm-empty"><div>👥</div>
        {repType === 'commercial' ? 'لا يوجد مندوبون تجاريون — فعّل ملف مبيعات أولاً' : 'لا يوجد مندوبون علميون'}
      </div></div>
    );
  }

  return (
    <div className="tm">
      <style ref={colStyleRef} />
      <div className="tm-toolbar">
        <div className="tm-search">
          <span>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث عن ايتم…" />
        </div>
        <div className={`tm-toggle ${onlyFilled ? 'tm-toggle--on' : ''}`} onClick={() => setOnlyFilled(v => !v)}>
          {onlyFilled ? '☑' : '☐'} الايتمات ذات التارگت فقط
        </div>
        <div className="tm-stats">
          <div className="tm-stat"><b>{visReps.length}</b><small>مندوب</small></div>
          <div className="tm-stat"><b>{visRows.length}</b><small>ايتم</small></div>
          <div className="tm-stat"><b>{filledCells}</b><small>خلية معبّأة</small></div>
          <div className="tm-stat"><b>{fmt(grand)}</b><small>إجمالي {monthLabel}</small></div>
        </div>
      </div>

      {companies.length > 1 && (
        <div className="tm-companies">
          <span className={`tm-chip ${company === '' ? 'tm-chip--on' : ''}`} onClick={() => setCompany('')}>كل الشركات</span>
          {companies.map(c => (
            <span key={c} className={`tm-chip ${company === c ? 'tm-chip--on' : ''}`} onClick={() => setCompany(c)}>{c}</span>
          ))}
        </div>
      )}

      <div className="tm-scroll" style={{ marginTop: companies.length > 1 ? 10 : 0 }}>
        {loading ? (
          <div className="tm-empty"><div>⏳</div>جاري تحميل التارگتات…</div>
        ) : visRows.length === 0 ? (
          <div className="tm-empty"><div>📦</div>{search || onlyFilled ? 'لا توجد ايتمات مطابقة' : 'لا توجد ايتمات ضمن نطاق هؤلاء المندوبين'}</div>
        ) : (
          <table className="tm-table" ref={tableRef} onMouseOver={onHover} onMouseLeave={() => { if (colStyleRef.current) colStyleRef.current.textContent = ''; }}>
            <thead>
              {showGroups && (
                <tr className="tm-grp">
                  <th className="tm-sticky" rowSpan={2} style={{ verticalAlign: 'bottom' }}>
                    الايتم ╲ المندوب
                    <span className="tm-corner-sub">تارگت {monthLabel} {year} — بالعدد</span>
                  </th>
                  {groups.map((g, i) => <th key={i} colSpan={g.span}>{g.name}</th>)}
                  <th className="tm-total" rowSpan={2}>المجموع</th>
                </tr>
              )}
              <tr>
                {!showGroups && (
                  <th className="tm-sticky">
                    الايتم ╲ المندوب
                    <span className="tm-corner-sub">تارگت {monthLabel} {year} — بالعدد</span>
                  </th>
                )}
                {visReps.map((r, c) => (
                  <th key={r.id} data-c={c} className="tm-rep" onClick={() => onOpenRep(r.id)}
                    title={`${r.name}\nاضغط لعرض تفاصيله ومقارنة التارگت بالمبيع الفعلي`}>
                    <div className="tm-rep-av" style={{ background: avatarColor(r.name) }}>{initials(r.name)}</div>
                    <div className="tm-rep-name">{r.name}</div>
                    {(r.role === 'team_leader' || r.role === 'commercial_team_leader') && <div className="tm-rep-leader">قائد فريق</div>}
                    <div className="tm-rep-sum">{colTotals[c] ? fmt(colTotals[c]) : '—'}</div>
                  </th>
                ))}
                {!showGroups && <th className="tm-total">المجموع</th>}
              </tr>
            </thead>
            <tbody>
              {visRows.map((it, r) => {
                const rowTotal = visReps.reduce((s, rep) => s + num(rep.id, it.id), 0);
                return (
                  <tr key={it.id}>
                    <td className="tm-sticky tm-item">
                      <div className="tm-item-wrap">
                        <span className="tm-item-idx">{r + 1}</span>
                        <span className="tm-item-name" title={it.name}>{it.name}</span>
                        {fillItem === it.id ? (
                          <input autoFocus className="tm-fill-input" value={fillVal} placeholder="للكل"
                            onChange={e => setFillVal(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') applyFill(it.id); if (e.key === 'Escape') { setFillItem(null); setFillVal(''); } }}
                            onBlur={() => applyFill(it.id)} />
                        ) : (
                          <button className="tm-fill-btn" title="نفس القيمة لكل المندوبين الظاهرين في هذا الصف"
                            onClick={() => { setFillItem(it.id); setFillVal(''); }}>⇠ للكل</button>
                        )}
                      </div>
                    </td>
                    {visReps.map((rep, c) => {
                      if (!inScope(rep.id, it.id)) {
                        return <td key={rep.id} data-c={c} className="tm-cell tm-cell--off" title="خارج نطاق ايتمات هذا المندوب">·</td>;
                      }
                      const k = key(rep.id, it.id);
                      const v = value(rep.id, it.id);
                      const n = parseFloat(v) || 0;
                      const alpha = n > 0 && maxVal > 0 ? 0.035 + 0.16 * (n / maxVal) : 0;
                      return (
                        <td key={rep.id} data-c={c}
                          className={`tm-cell ${edits.has(k) ? 'tm-cell--dirty' : ''} ${flash.has(k) ? 'tm-flash' : ''}`}
                          style={alpha ? { backgroundColor: `rgba(26,86,219,${alpha.toFixed(3)})` } : undefined}>
                          <input data-cell={`${r}-${c}`} inputMode="decimal" value={v} placeholder="—"
                            onChange={e => setCell(rep.id, it.id, e.target.value)}
                            onKeyDown={e => onKey(e, r, c)}
                            onPaste={e => onPaste(e, r, c)}
                            onFocus={e => e.target.select()} />
                        </td>
                      );
                    })}
                    <td className="tm-total">{rowTotal ? fmt(rowTotal) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="tm-sticky">الإجمالي</td>
                {colTotals.map((t, c) => <td key={c} data-c={c}>{t ? fmt(t) : '—'}</td>)}
                <td className="tm-grand">{fmt(grand)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      <div className={`tm-savebar ${edits.size ? 'tm-savebar--dirty' : ''}`}>
        {edits.size > 0
          ? <span className="tm-dirty-count">● {edits.size} تعديل غير محفوظ</span>
          : <span className="tm-hint">اكتب مباشرة في الخلية • Enter/الأسهم للتنقل • الصق كتلة من إكسل • Esc يلغي تعديل الخلية • اضغط اسم المندوب لتفاصيله</span>}
        {msg && <span style={{ fontSize: 12.5, fontWeight: 700, color: msg.ok ? 'var(--c-success)' : 'var(--c-danger)' }}>{msg.text}</span>}
        <span className="spacer" />
        {edits.size > 0 && (
          <button className="btn btn--secondary btn--sm" onClick={() => setEdits(new Map())} disabled={saving}>↺ تراجع</button>
        )}
        <button className="btn btn--primary" onClick={save} disabled={saving || edits.size === 0} style={{ minWidth: 140 }}>
          {saving ? '⏳ جاري الحفظ…' : '💾 حفظ التعديلات'}
        </button>
      </div>
    </div>
  );
}
