import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './TargetsMatrix.css';

/**
 * جدول التارگت الشامل: المندوبون أفقياً × الايتمات عمودياً لشهر واحد.
 * تحرير مباشر في الخلية، لصق كتلة من إكسل، تنقّل بالأسهم/Enter، تعميم قيمة على
 * صف كامل، وإجماليات للصف والعمود — بتصميم جدول الستوك (كثيف، رسمي، بلا ألوان).
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
  token: string | null;
  reloadKey?: number;
  /** أدوات الصفحة (العنوان، الشهر، السنة) — تُعرض في بداية شريط الجدول */
  controls?: ReactNode;
  /** أزرار الصفحة (الاستيراد) — تُعرض في نهاية شريط الجدول */
  actions?: ReactNode;
}

const key = (repId: number, itemId: number) => `${repId}:${itemId}`;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const clean = (v: string) => v.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\d.]/g, '');

export default function TargetsMatrix({ repType, reps, allItems, month, year, token, reloadKey = 0, controls, actions }: Props) {
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

  const colTotals = useMemo(() => visReps.map(r => visRows.reduce((s, it) => s + num(r.id, it.id), 0)),
    [visReps, visRows, value]); // eslint-disable-line react-hooks/exhaustive-deps
  const grand = colTotals.reduce((a, b) => a + b, 0);

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
  // شركة واحدة لا تضيف معلومة — صفها في الرأس ضجيج ويأخذ من مساحة الجدول
  const showGroups = groups.length > 1;

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
      `.tm-table tbody [data-c="${c}"],.tm-table tfoot [data-c="${c}"]{background:var(--c-bg)}`
      + `.tm-table thead [data-c="${c}"]{background:var(--c-border-light) !important}`;
  };

  const toolbar = (
    <div className="tg-bar">
      {controls}
      <span className="tg-grow" />
      {reps.length > 0 && <>
        <input className="tg-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث عن ايتم…" />
        {companies.length > 1 && (
          <select className="tg-sel" value={company} onChange={e => setCompany(e.target.value)}>
            <option value="">كل الشركات</option>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <button className={`tg-btn ${onlyFilled ? 'on' : ''}`} onClick={() => setOnlyFilled(v => !v)}
          title="إخفاء الايتمات التي لا تارگت لها">ذات التارگت فقط</button>
      </>}
      {actions}
      {msg && <span className={`tg-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</span>}
      {/* الحفظ في الشريط لا أسفل الجدول: الجدول يملأ الشاشة فما تحته يبقى خارجها */}
      {edits.size > 0 && <>
        <button className="tg-btn" onClick={() => setEdits(new Map())} disabled={saving}>تراجع</button>
        <button className="tg-btn tg-btn--primary" onClick={save} disabled={saving}>
          {saving ? 'جاري الحفظ…' : `حفظ التعديلات (${edits.size})`}
        </button>
      </>}
    </div>
  );

  if (reps.length === 0) {
    return (
      <div>
        {toolbar}
        <div className="tm-wrap"><div className="tm-empty">
          {repType === 'commercial' ? 'لا يوجد مندوبون تجاريون — فعّل ملف مبيعات أولاً' : 'لا يوجد مندوبون علميون'}
        </div></div>
      </div>
    );
  }

  return (
    <div>
      <style ref={colStyleRef} />
      {toolbar}

      <div className="tm-wrap">
        {loading ? (
          <div className="tm-empty">جاري تحميل التارگتات…</div>
        ) : visRows.length === 0 ? (
          <div className="tm-empty">{search || onlyFilled ? 'لا توجد ايتمات مطابقة' : 'لا توجد ايتمات ضمن نطاق هؤلاء المندوبين'}</div>
        ) : (
          <table className="tm-table" ref={tableRef} style={{ '--tm-reps': visReps.length } as CSSProperties}
            onMouseOver={onHover} onMouseLeave={() => { if (colStyleRef.current) colStyleRef.current.textContent = ''; }}>
            <colgroup>
              <col className="tm-col-item" />
              {visReps.map(r => <col key={r.id} />)}
              <col className="tm-col-total" />
            </colgroup>
            <thead>
              {showGroups && (
                <tr className="tm-grp">
                  <th className="tm-item" />
                  {groups.map((g, i) => <th key={i} colSpan={g.span}>{g.name}</th>)}
                  <th className="tm-total" />
                </tr>
              )}
              <tr>
                <th className="tm-item">الايتم</th>
                {visReps.map((r, c) => (
                  <th key={r.id} data-c={c} className="tm-rep" title={r.name}>
                    <span className="tm-rep-name">{r.name}</span>
                  </th>
                ))}
                <th className="tm-total">المجموع</th>
              </tr>
            </thead>
            <tbody>
              {visRows.map((it, r) => {
                const rowTotal = visReps.reduce((s, rep) => s + num(rep.id, it.id), 0);
                return (
                  <tr key={it.id}>
                    <td className="tm-item" title={it.name}>
                      {/* dir=auto: الأسماء الإنجليزية تُعرض بترتيبها الصحيح ولا تُقص من بدايتها */}
                      <span className="tm-item-name" dir="auto">{it.name}</span>
                      {fillItem === it.id ? (
                        <input autoFocus className="tm-fill-input" value={fillVal} placeholder="للكل"
                          onChange={e => setFillVal(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') applyFill(it.id); if (e.key === 'Escape') { setFillItem(null); setFillVal(''); } }}
                          onBlur={() => applyFill(it.id)} />
                      ) : (
                        <button className="tm-fill" title="نفس القيمة لكل المندوبين الظاهرين في هذا الصف"
                          onClick={() => { setFillItem(it.id); setFillVal(''); }}>تعميم</button>
                      )}
                    </td>
                    {visReps.map((rep, c) => {
                      if (!inScope(rep.id, it.id)) {
                        return <td key={rep.id} data-c={c} className="tm-cell tm-cell--off" title="خارج نطاق ايتمات هذا المندوب" />;
                      }
                      const k = key(rep.id, it.id);
                      return (
                        <td key={rep.id} data-c={c}
                          className={`tm-cell ${edits.has(k) ? 'tm-cell--dirty' : ''} ${flash.has(k) ? 'tm-flash' : ''}`}>
                          <input data-cell={`${r}-${c}`} inputMode="decimal" value={value(rep.id, it.id)}
                            onChange={e => setCell(rep.id, it.id, e.target.value)}
                            onKeyDown={e => onKey(e, r, c)}
                            onPaste={e => onPaste(e, r, c)}
                            onFocus={e => e.target.select()} />
                        </td>
                      );
                    })}
                    <td className="tm-total">{rowTotal ? fmt(rowTotal) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="tm-item tm-foot-label">المجموع · {visRows.length} ايتم</td>
                {colTotals.map((t, c) => <td key={c} data-c={c}>{t ? fmt(t) : ''}</td>)}
                <td className="tm-total">{fmt(grand)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
