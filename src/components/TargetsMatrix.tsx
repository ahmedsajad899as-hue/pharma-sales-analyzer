import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './TargetsMatrix.css';
import { fetchActuals, fmtQty, pctClass, pctText, TargetCompareModal, type ActualRow, type RepActuals } from './TargetCompare';
import { buildTargetGroups, isLeader, isManagerCol, orderGroupColumns, type MatrixRep, type TargetGroup } from './targetGroups';

/**
 * جدول التارگت: تبويب لكل شركة (مدير شركة) + «مسوقين بغداد» + «مسوقين المحافظات».
 * التبويب يعرض مندوبي تلك المجموعة أعمدةً × ايتمات مديرها صفوفاً — فالأعمدة قليلة
 * وعريضة والأسماء كاملة. تحرير مباشر، لصق كتلة من إكسل، تنقّل بالأسهم/Enter،
 * وعمود «للكل» ثابت بجانب الايتم يعمّم القيمة على كل مندوبي الصف أو على المحدَّدين
 * منهم فقط (مربع الاختيار في رأس العمود). أسفل كل عمود المبيع النت والإنجاز، والضغط
 * على الاسم يفتح المقارنة ايتماً ايتماً. عمود المدير (معرّف سالب) لا يدخل المجموع.
 *
 * البيانات بطلب واحد: GET /api/targets/matrix لكل الأشخاص (تارگتات + نطاق ايتمات كل
 * شخص). الحفظ upsert لكل مندوب عُدّل عبر PUT /api/targets.
 */

const API = import.meta.env.VITE_API_URL || '';
const GROUP_STORE = 'targets:group';

interface NamedItem { id: number; name: string; }

interface Props {
  repType: 'scientific' | 'commercial';
  reps: MatrixRep[];
  allItems: NamedItem[];
  month: number;
  year: number;
  monthLabel: string;
  activeFileIds: number[];
  token: string | null;
  reloadKey?: number;
  /** أدوات الصفحة (العنوان، الشهر، السنة) — بداية الشريط العلوي */
  controls?: ReactNode;
  /** أزرار الصفحة (الاستيراد) — تستلم مندوبي المجموعة المعروضة */
  actions?: (ctx: { reps: MatrixRep[]; groupName: string }) => ReactNode;
}

type Region = 'all' | 'baghdad' | 'province';

const key = (repId: number, itemId: number) => `${repId}:${itemId}`;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const clean = (v: string) => v.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\d.]/g, '');

const readGroup = () => { try { return localStorage.getItem(GROUP_STORE) || ''; } catch { return ''; } };
const writeGroup = (k: string) => { try { localStorage.setItem(GROUP_STORE, k); } catch { /* تفضيل عرض */ } };

function roleLabel(r: MatrixRep): string {
  if (isManagerCol(r.id)) return r.repKind === 'pharmacy' ? 'مدير المسوقين' : 'مدير';
  const parts: string[] = [];
  if (isLeader(r)) parts.push('قائد فريق');
  if (r.provinceNames?.length) parts.push(r.provinceNames.join('، '));
  else if (r.isProvinceMember) parts.push('محافظة');
  return parts.join(' · ');
}

export default function TargetsMatrix({ repType, reps, allItems, month, year, monthLabel, activeFileIds, token, reloadKey = 0, controls, actions }: Props) {
  const H = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState<Map<string, number>>(new Map());
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [scopes, setScopes] = useState<Record<number, Set<number> | null>>({});
  const [scopeItems, setScopeItems] = useState<NamedItem[]>([]);
  const [targetItems, setTargetItems] = useState<NamedItem[]>([]);

  const [groupKey, setGroupKey] = useState<string>(readGroup);
  // داخل الشركة: بغداد افتراضياً
  const [region, setRegion] = useState<Region>('baghdad');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState<Map<number, string>>(new Map());
  const [search, setSearch] = useState('');
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());

  const tableRef = useRef<HTMLTableElement>(null);
  const colStyleRef = useRef<HTMLStyleElement>(null);
  const editsRef = useRef(edits); editsRef.current = edits;
  const periodRef = useRef({ month, year, repType });

  const repIdsKey = reps.map(r => r.id).join(',');

  // ── المجموعات ──
  const groups = useMemo(() => buildTargetGroups(reps), [reps]);
  const group: TargetGroup | undefined = groups.find(g => g.key === groupKey) ?? groups[0];
  const pickGroup = (k: string) => {
    setGroupKey(k); writeGroup(k);
    setSelected(new Set()); setBulk(new Map()); setRegion('baghdad');
  };

  const ordered = useMemo(() => (group ? orderGroupColumns(group) : { cols: [], blocks: [] }), [group]);
  // بغداد/محافظات داخل الشركة — فقط حين تجمع الشركة الاثنين
  const hasRegions = useMemo(() => {
    const rs = group?.reps ?? [];
    return group?.kind !== 'marketers' && rs.some(r => r.isProvinceMember) && rs.some(r => !r.isProvinceMember);
  }, [group]);
  const visReps = useMemo(() => {
    if (!hasRegions || region === 'all') return ordered.cols;
    const wantProv = region === 'province';
    return ordered.cols.filter(r => isManagerCol(r.id) || !!r.isProvinceMember === wantProv);
  }, [ordered, hasRegions, region]);
  const blocks = useMemo(() => {
    // نفس كتل الرأس بعد فلتر المنطقة: يُعاد عدّها على الأعمدة الظاهرة
    if (visReps.length === ordered.cols.length) return ordered.blocks;
    const shown = new Set(visReps.map(r => r.id));
    const out: { label: string; span: number }[] = [];
    let i = 0;
    for (const b of ordered.blocks) {
      const span = ordered.cols.slice(i, i + b.span).filter(r => shown.has(r.id)).length;
      i += b.span;
      if (span) out.push({ label: b.label, span });
    }
    return out;
  }, [visReps, ordered]);
  const showBlocks = blocks.length > 1;
  const visIdsKey = visReps.map(r => r.id).join(',');

  // ── المبيع النت لكل شخص — يُطلب لأعمدة التبويب الظاهر فقط، ويبقى محفوظاً عند التنقل ──
  const compareOn = repType === 'scientific';
  const fileKey = activeFileIds.join(',');
  const noFiles = compareOn && activeFileIds.length === 0;
  const [actuals, setActuals] = useState<Record<number, RepActuals>>({});
  const [actualsPending, setActualsPending] = useState(0);
  const [actualsNonce, setActualsNonce] = useState(0);
  const [compareRepId, setCompareRepId] = useState<number | null>(null);
  const actualsScopeRef = useRef('');
  const fetchedRef = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    const scope = `${month}|${year}|${fileKey}`;
    if (actualsScopeRef.current !== scope) {
      actualsScopeRef.current = scope;
      fetchedRef.current = new Map();
      setActuals({});
    }
    if (!compareOn || !fileKey || !visIdsKey) { setActualsPending(0); return; }
    const stamp = `${scope}|${actualsNonce}|${reloadKey}`;
    const queue = visIdsKey.split(',').map(Number).filter(id => fetchedRef.current.get(id) !== stamp);
    if (!queue.length) { setActualsPending(0); return; }
    let cancelled = false;
    const fileIds = fileKey.split(',').map(Number);
    setActualsPending(queue.length);
    // التقرير ثقيل والخادم بمعالج واحد: طلبان معاً فتمتلئ الأعمدة تدريجياً
    const worker = async () => {
      while (queue.length && !cancelled) {
        const id = queue.shift()!;
        try {
          const data = await fetchActuals(id, { month, year, fileIds }, token);
          if (!cancelled) { fetchedRef.current.set(id, stamp); setActuals(prev => ({ ...prev, [id]: data })); }
        } catch { /* يبقى عموده بلا رقم */ }
        if (!cancelled) setActualsPending(n => n - 1);
      }
    };
    worker(); worker();
    return () => { cancelled = true; };
  }, [compareOn, month, year, fileKey, visIdsKey, token, actualsNonce, reloadKey]);

  const actualByCell = useMemo(() => {
    const out: Record<number, Map<number, ActualRow>> = {};
    for (const [id, a] of Object.entries(actuals)) {
      const m = new Map<number, ActualRow>();
      a.rows.forEach(row => row.itemIds.forEach(itemId => m.set(itemId, row)));
      out[+id] = m;
    }
    return out;
  }, [actuals]);

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

  // ── القيم ──
  const inScope = useCallback((repId: number, itemId: number) => {
    const s = scopes[repId];
    return s === undefined || s === null || s.has(itemId);
  }, [scopes]);

  const value = useCallback((repId: number, itemId: number): string => {
    const k = key(repId, itemId);
    if (edits.has(k)) return edits.get(k)!;
    const s = saved.get(k);
    return s === undefined ? '' : String(s);
  }, [edits, saved]);
  const num = (repId: number, itemId: number) => parseFloat(value(repId, itemId)) || 0;

  // مجموع كل شخص (المحفوظ + التعديل) — لأرقام التبويبات
  const repTotals = useMemo(() => {
    const t = new Map<number, number>();
    const add = (k: string, v: number) => { const id = +k.split(':')[0]; t.set(id, (t.get(id) ?? 0) + v); };
    saved.forEach((v, k) => { if (!edits.has(k)) add(k, v); });
    edits.forEach((v, k) => add(k, parseFloat(v) || 0));
    return t;
  }, [saved, edits]);
  const dirtyReps = useMemo(() => new Set([...edits.keys()].map(k => +k.split(':')[0])), [edits]);

  // ── صفوف التبويب: ايتمات مدير الشركة (أو نطاق مندوبيها إن لم يكن لها مدير) ──
  const itemById = useMemo(() => {
    const m = new Map<number, NamedItem>();
    [...allItems, ...scopeItems, ...targetItems].forEach(i => m.set(i.id, i));
    return m;
  }, [allItems, scopeItems, targetItems]);

  const groupRows = useMemo(() => {
    if (!group) return [];
    const map = new Map<number, NamedItem>();
    const add = (it: NamedItem | undefined) => { if (it && !it.name.includes('(مؤقت)')) map.set(it.id, it); };
    const sources = group.managers.length ? group.managers : group.reps;
    const sets = sources.map(p => scopes[p.id]);
    if (!sets.length || sets.some(s => s === undefined || s === null)) allItems.forEach(add);
    sets.forEach(s => s?.forEach(id => add(itemById.get(id))));
    // تارگت محفوظ خارج النطاق يبقى ظاهراً حتى لا يختفي رقم قائم
    const colIds = new Set(ordered.cols.map(r => r.id));
    saved.forEach((v, k) => {
      const [rid, iid] = k.split(':').map(Number);
      if (v > 0 && colIds.has(rid)) add(itemById.get(iid));
    });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [group, ordered, scopes, allItems, itemById, saved]);

  const visRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groupRows.filter(it => {
      if (q && !it.name.toLowerCase().includes(q)) return false;
      if (!visReps.some(r => inScope(r.id, it.id))) return false;
      if (onlyFilled && !visReps.some(r => num(r.id, it.id) > 0)) return false;
      return true;
    });
  }, [groupRows, search, onlyFilled, visReps, inScope, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const colTotals = useMemo(() => visReps.map(r => visRows.reduce((s, it) => s + num(r.id, it.id), 0)),
    [visReps, visRows, value]); // eslint-disable-line react-hooks/exhaustive-deps
  const grand = colTotals.reduce((a, b, c) => (isManagerCol(visReps[c].id) ? a : a + b), 0);

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

  // التعميم: على المحدَّدين إن وُجدوا، وإلا كل مندوبي الصف (بلا المدير)
  const bulkTargets = useMemo(() => (selected.size
    ? visReps.filter(r => selected.has(r.id))
    : visReps.filter(r => !isManagerCol(r.id))), [selected, visReps]);
  const applyBulk = (itemId: number, raw: string) => {
    const v = clean(raw);
    if (v !== '') bulkTargets.forEach(rep => { if (inScope(rep.id, itemId)) setCell(rep.id, itemId, v); });
    setBulk(prev => { const n = new Map(prev); n.delete(itemId); return n; });
  };

  const focusCell = (r: number, c: number) => {
    const el = tableRef.current?.querySelector<HTMLInputElement>(`input[data-cell="${r}-${c}"]`);
    if (el) { el.focus(); el.select(); return true; }
    return false;
  };
  // عمود «للكل» = العمود -1 في التنقل
  const move = (r: number, c: number, dr: number, dc: number) => {
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < visRows.length && nc >= -1 && nc < visReps.length) {
      if (focusCell(nr, nc)) return;
      nr += dr; nc += dc;
    }
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    // RTL: السهم الأيسر يتقدّم للعمود التالي بصرياً
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (c === -1) applyBulk(visRows[r].id, (e.target as HTMLInputElement).value);
      move(r, c, 1, 0);
    }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(r, c, -1, 0); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(r, c, 0, 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(r, c, 0, -1); }
    else if (e.key === 'Escape') {
      const it = visRows[r];
      if (c === -1) { setBulk(prev => { const n = new Map(prev); n.delete(it.id); return n; }); return; }
      const rep = visReps[c];
      setEdits(prev => { const n = new Map(prev); n.delete(key(rep.id, it.id)); return n; });
    }
  };
  // لصق كتلة من إكسل تبدأ من الخلية الحالية؛ في عمود «للكل» كل سطر يُعمَّم على صفّه
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
    if (c === -1) {
      grid.forEach((line, i) => { const it = visRows[r + i]; if (it) applyBulk(it.id, line[0] ?? ''); });
      return;
    }
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

  const toggleSel = (id: number) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

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
    setActualsNonce(n => n + 1); // الإنجاز يُحسب على التارگت المحفوظ
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

  const bulkLabel = selected.size ? `للمحدَّدين (${selected.size})` : 'للكل';

  // ── شريط واحد: الفترة + بغداد/المحافظات + البحث + الإجراءات + الحفظ ──
  const topBar = (
    <div className="tg-bar">
      {controls}
      {group && hasRegions && (
        <div className="tg-seg" role="group" aria-label="المنطقة">
          {([['baghdad', 'بغداد'], ['province', 'المحافظات'], ['all', 'الكل']] as [Region, string][]).map(([v, l]) => (
            <button key={v} className={region === v ? 'on' : ''} onClick={() => setRegion(v)}>{l}</button>
          ))}
        </div>
      )}
      <span className="tg-grow" />
      {selected.size > 0 && (
        <span className="tg-sel-info">
          محدَّد {selected.size}
          <button className="tg-link" onClick={() => setSelected(new Set())}>إلغاء</button>
        </span>
      )}
      {group && <>
        <input className="tg-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث عن ايتم…" />
        <button className={`tg-btn ${onlyFilled ? 'on' : ''}`} onClick={() => setOnlyFilled(v => !v)}
          title="إخفاء الايتمات التي لا تارگت لها">ذات التارگت فقط</button>
      </>}
      {actions?.({ reps: (group?.reps ?? []), groupName: group?.name ?? '' })}
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

  if (reps.length === 0 || !group) {
    return (
      <div>
        {topBar}
        <div className="tm-wrap"><div className="tm-empty">
          {repType === 'commercial' ? 'لا يوجد مندوبون تجاريون — فعّل ملف مبيعات أولاً' : 'لا يوجد مندوبون علميون'}
        </div></div>
      </div>
    );
  }

  // ── تبويبات الشركات ──
  const tabs = groups.length > 1 && (
    <div className="tg-tabs" role="tablist">
      {groups.map((g, i) => {
        const total = g.reps.reduce((s, r) => s + (repTotals.get(r.id) ?? 0), 0);
        const dirty = [...g.managers, ...g.reps].some(r => dirtyReps.has(r.id));
        const sub = g.kind === 'company'
          ? g.managers.map(m => m.name).join('، ')
          : g.kind === 'marketers' ? (g.managers.map(m => m.name).join('، ') || 'للمكتب كله') : 'بلا مدير شركة';
        const firstMarketers = g.kind === 'marketers' && groups[i - 1]?.kind !== 'marketers';
        return (
          <button key={g.key} role="tab" aria-selected={g.key === group.key}
            className={`tg-tab ${g.key === group.key ? 'on' : ''} ${firstMarketers ? 'tg-tab--sep' : ''}`}
            onClick={() => pickGroup(g.key)} title={`${g.name} — ${sub}`}>
            <span className="tg-tab-row">
              <span className="tg-tab-name" dir="auto">{g.name}{dirty && <i className="tg-tab-dot" title="تعديلات غير محفوظة" />}</span>
              <b className="tg-tab-total">{total ? fmt(total) : '—'}</b>
            </span>
            <span className="tg-tab-row tg-tab-sub">
              <span dir="auto">{sub}</span>
              <span>{g.reps.length} مندوب</span>
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div>
      <style ref={colStyleRef} />
      {topBar}
      {tabs}

      <div className="tm-wrap">
        {loading ? (
          <div className="tm-empty">جاري تحميل التارگتات…</div>
        ) : visReps.length === 0 ? (
          <div className="tm-empty">لا يوجد مندوبون في هذه المجموعة</div>
        ) : visRows.length === 0 ? (
          <div className="tm-empty">{search || onlyFilled ? 'لا توجد ايتمات مطابقة' : 'لا توجد ايتمات معيّنة لمدير هذه الشركة'}</div>
        ) : (
          <table className="tm-table" ref={tableRef} style={{ '--tm-reps': visReps.length } as CSSProperties}
            onMouseOver={onHover} onMouseLeave={() => { if (colStyleRef.current) colStyleRef.current.textContent = ''; }}>
            <colgroup>
              <col className="tm-col-item" />
              <col className="tm-col-bulk" />
              {visReps.map(r => <col key={r.id} />)}
              <col className="tm-col-total" />
            </colgroup>
            <thead>
              {showBlocks && (
                <tr className="tm-grp">
                  <th className="tm-item" />
                  <th className="tm-bulk" />
                  {blocks.map((b, i) => <th key={i} colSpan={b.span} title={b.label}><span className="tm-grp-label">{b.label}</span></th>)}
                  <th className="tm-total" />
                </tr>
              )}
              <tr>
                <th className="tm-item">الايتم</th>
                <th className="tm-bulk" title="القيمة المكتوبة هنا تُوضع لكل مندوبي الصف — أو للمحدَّدين فقط إن حدّدت مندوبين">{bulkLabel}</th>
                {visReps.map((r, c) => {
                  const role = roleLabel(r);
                  return (
                    <th key={r.id} data-c={c} className={`tm-rep ${isManagerCol(r.id) ? 'tm-rep--mgr' : ''} ${selected.has(r.id) ? 'tm-rep--sel' : ''}`} title={r.name}>
                      <label className="tm-rep-check" title="تحديد للتعميم">
                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} />
                      </label>
                      <button type="button" className={`tm-rep-name ${compareOn ? 'tm-rep-name--open' : ''}`}
                        onClick={compareOn ? () => setCompareRepId(r.id) : undefined}
                        title={compareOn ? `${r.name} — التارگت مقابل المبيع` : r.name}>{r.name}</button>
                      {role && <span className="tm-rep-role">{role}</span>}
                    </th>
                  );
                })}
                <th className="tm-total" title="مجموع المندوبين، بلا أعمدة المدراء">المجموع</th>
              </tr>
            </thead>
            <tbody>
              {visRows.map((it, r) => {
                const rowTotal = visReps.reduce((s, rep) => (isManagerCol(rep.id) ? s : s + num(rep.id, it.id)), 0);
                return (
                  <tr key={it.id}>
                    <td className="tm-item" title={it.name}>
                      {/* dir=auto: الأسماء الإنجليزية تُعرض بترتيبها الصحيح ولا تُقص من بدايتها */}
                      <span className="tm-item-name" dir="auto">{it.name}</span>
                    </td>
                    <td className="tm-bulk tm-cell">
                      <input data-cell={`${r}--1`} inputMode="decimal" placeholder="—"
                        value={bulk.get(it.id) ?? ''}
                        onChange={e => { const v = clean(e.target.value); setBulk(prev => new Map(prev).set(it.id, v)); }}
                        onKeyDown={e => onKey(e, r, -1)}
                        onPaste={e => onPaste(e, r, -1)}
                        onBlur={e => { if (e.target.value) applyBulk(it.id, e.target.value); }} />
                    </td>
                    {visReps.map((rep, c) => {
                      if (!inScope(rep.id, it.id)) {
                        return <td key={rep.id} data-c={c} className="tm-cell tm-cell--off" title="خارج نطاق ايتمات هذا المندوب" />;
                      }
                      const k = key(rep.id, it.id);
                      const cmp = actualByCell[rep.id]?.get(it.id);
                      return (
                        <td key={rep.id} data-c={c}
                          title={cmp ? `التارگت ${fmtQty(cmp.target)} · المبيع النت ${fmtQty(cmp.net)} · الإنجاز ${pctText(cmp.pct)}` : undefined}
                          className={`tm-cell ${isManagerCol(rep.id) ? 'tm-cell--mgr' : ''} ${edits.has(k) ? 'tm-cell--dirty' : ''} ${flash.has(k) ? 'tm-flash' : ''}`}>
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
                <td className="tm-item tm-foot-label">التارگت · {visRows.length} ايتم</td>
                <td className="tm-bulk" />
                {colTotals.map((t, c) => <td key={c} data-c={c}>{t ? fmt(t) : ''}</td>)}
                <td className="tm-total">{fmt(grand)}</td>
              </tr>
              {compareOn && (noFiles ? (
                <tr className="tm-foot-compare">
                  <td className="tm-item tm-foot-label">المبيع النت</td>
                  <td className="tm-bulk" />
                  <td colSpan={visReps.length} className="tm-foot-hint">فعّل ملف مبيعات لعرض المبيع النت</td>
                  <td className="tm-total" />
                </tr>
              ) : <>
                <tr className="tm-foot-compare">
                  <td className="tm-item tm-foot-label">
                    المبيع النت{actualsPending > 0 && <span className="tm-foot-progress"> · جاري الحساب {visReps.length - actualsPending}/{visReps.length}</span>}
                  </td>
                  <td className="tm-bulk" />
                  {visReps.map((r, c) => {
                    const a = actuals[r.id];
                    return <td key={r.id} data-c={c}>{a ? (a.totalTarget > 0 ? fmtQty(a.totalNet) : '') : actualsPending > 0 ? '…' : '—'}</td>;
                  })}
                  <td className="tm-total" />
                </tr>
                <tr className="tm-foot-compare">
                  <td className="tm-item tm-foot-label">الإنجاز</td>
                  <td className="tm-bulk" />
                  {visReps.map((r, c) => {
                    const a = actuals[r.id];
                    return <td key={r.id} data-c={c} className={pctClass(a?.pct ?? null)}>{a?.pct != null ? `${a.pct}%` : ''}</td>;
                  })}
                  <td className="tm-total" />
                </tr>
              </>)}
            </tfoot>
          </table>
        )}
      </div>

      {compareRepId !== null && (() => {
        const rep = reps.find(r => r.id === compareRepId);
        if (!rep) return null;
        return (
          <TargetCompareModal
            name={rep.name}
            subtitle={`${isManagerCol(rep.id) ? 'مدير — مبيع فريقه · ' : ''}${monthLabel} ${year}`}
            data={actuals[rep.id]}
            loading={actualsPending > 0}
            noFiles={noFiles}
            onClose={() => setCompareRepId(null)}
          />
        );
      })()}
    </div>
  );
}
