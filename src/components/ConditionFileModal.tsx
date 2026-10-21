// ════════════════════════════════════════════════════════════════════════════
// ConditionFileModal — فتح «ملف الكوديشن» داخل التطبيق: شيت (تبويب) لكل مندوب
// بمبيعاته من طلبيات البوت وإكسل الكوديشن، + ملخّص، + تصدير إكسل بنفس الشيتات.
// الخادم: GET /api/files/:id/condition-view و GET /api/files/:id/condition-export.
// التعديل تفاعلي مثل شبكة مراجعة طلبيات البوت (ComboCell باقتراحات): كل خانة
// تُحفظ عند الخروج منها (PATCH condition-rows) في جدول المبيعات نفسه، فتأخذ بها
// التقارير ويراها كل من يفتح الملف.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AutoText, ComboCell, type ComboOpt } from './ComboCell';

type Row = {
  id: number; date: string; invoice: string; pharmacy: string; area: string; warehouse: string;
  item: string; company: string; quantity: number; bonus: number; unitPrice: number; total: number; source: string;
  rep?: string;
  /** محافظة الصف — لزرّي «بغداد / المحافظات» */
  province?: string;
  /** طلبية ترانزيت من ملف المكتب — للقراءة فقط هنا */
  transit?: boolean; note?: string;
  /** الصف محسوب أيضاً في إكسل ميركاتو (flagConditionRowsInMercato في الخادم) */
  mercatoMatch?: {
    level: 'duplicate' | 'possible'; fileName: string; invoiceNumber?: string; date?: string;
    pharmacy?: string; warehouse?: string; rep?: string; sameQty: boolean; mercatoQty: number; reasons: string[];
  };
};
type Sheet = { rep: string; rows: Row[]; quantity: number; total: number; orders: number; all?: boolean };
type Month = { ym: string; label: string; count: number };

interface Props {
  fileId: number;
  fileName: string;
  currency: string;
  token: string | null;
  /** احتياط حتى يردّ الخادم بـ canEdit (المالك + المدراء المشارَك معهم) */
  canEdit?: boolean;
  onClose: () => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const SUMMARY = '__summary__';
// شيت «كل مبيعات الشركة» — كل صفوف ايتمات الشركة مهما كان المندوب (ومنها «بلا مندوب»).
const COMPANY = '__company__';
const NO_REP = 'بلا مندوب';
type Scope = 'baghdad' | 'provinces' | null;
const UNKNOWN_PROVINCE = 'غير محددة';
// نفس filterSheetsByProvince في server/lib/conditionFile.js: صف بلا محافظة معروفة يُعدّ من «المحافظات».
const inScope = (r: Row, scope: Scope) => !scope || ((r.province === 'بغداد') === (scope === 'baghdad'));
function scopeSheet(s: Sheet, scope: Scope, mercatoOnly = false): Sheet {
  if (!scope && !mercatoOnly) return s;
  const rows = s.rows.filter(r => inScope(r, scope) && (!mercatoOnly || r.mercatoMatch));
  return {
    ...s, rows,
    quantity: rows.reduce((a, r) => a + r.quantity, 0),
    total: rows.reduce((a, r) => a + r.total, 0),
    orders: new Set(rows.map(r => r.invoice || `${r.date}|${r.pharmacy}`)).size,
  };
}
const mercatoTitle = (r: Row) => {
  const m = r.mercatoMatch;
  if (!m) return '';
  return `${m.level === 'duplicate' ? 'محسوب أصلاً في مبيع ميركاتو' : 'ربما محسوب في ميركاتو'} «${m.fileName}»: `
    + [m.invoiceNumber && `طلبية ${m.invoiceNumber}`, m.pharmacy, m.date, m.warehouse, m.rep].filter(Boolean).join(' · ')
    + (m.sameQty ? '' : ` (كمية ميركاتو ${m.mercatoQty})`);
};
// عمود الصف ← حقل التعديل في PATCH /api/files/:id/condition-rows/:saleId
const EDIT_COLS: { key: string; label: string; w: number; num?: boolean; ro?: boolean }[] = [
  { key: 'date', label: 'التاريخ', w: 128 }, { key: 'invoice', label: 'رقم الفاتورة', w: 90 },
  { key: 'pharmacy', label: 'الصيدلية', w: 150 }, { key: 'area', label: 'المنطقة', w: 100 },
  { key: 'province', label: 'المحافظة', w: 80, ro: true },
  { key: 'warehouse', label: 'المذخر', w: 130 }, { key: 'item', label: 'الايتم', w: 160 },
  { key: 'company', label: 'الشركة', w: 100 }, { key: 'rep', label: 'المندوب', w: 120 },
  { key: 'quantity', label: 'الكمية', w: 64, num: true }, { key: 'bonus', label: 'البونص', w: 56, num: true },
  { key: 'unitPrice', label: 'السعر', w: 76, num: true }, { key: 'total', label: 'القيمة', w: 90, num: true },
];

type Suggest = { items: ComboOpt[]; companies: ComboOpt[]; areas: ComboOpt[]; reps: ComboOpt[]; warehouses: ComboOpt[] };
const NO_SUGGEST: Suggest = { items: [], companies: [], areas: [], reps: [], warehouses: [] };

/**
 * خانة تعديل واحدة: مسودّة محلية أثناء الكتابة، وحفظ عند الخروج/الاختيار إن تغيّرت.
 * الخانات النصية بقائمة اقتراحات (ComboCell)، والتاريخ والأرقام حقول عادية.
 */
function EditCell({ col, value, options, state, onSave }: {
  col: typeof EDIT_COLS[number]; value: string; options?: ComboOpt[];
  state?: 'saving' | 'ok' | 'err'; onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  const base = useRef(value);
  useEffect(() => { setV(value); base.current = value; }, [value]);
  const commit = (nv: string) => { if (nv.trim() !== base.current.trim()) { base.current = nv; onSave(nv); } };
  const tone: CSSProperties = state === 'saving' ? { opacity: 0.45 } : state === 'ok' ? { background: '#dcfce7' } : state === 'err' ? { background: '#fee2e2' } : {};
  const cs: CSSProperties = { width: col.w, minWidth: col.w, fontSize: 12, textAlign: col.num ? 'center' : 'right', transition: 'background .4s', ...tone };
  if (col.key === 'date' || col.num) {
    return (
      <input value={v} type={col.key === 'date' ? 'date' : 'text'} inputMode={col.num ? 'decimal' : undefined}
        onChange={e => setV(e.target.value)} onBlur={() => commit(v)}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setV(base.current); }}
        style={{ border: '1px solid transparent', borderRadius: 6, padding: '5px 6px', background: 'transparent', boxSizing: 'border-box', ...cs }}
        onFocus={e => { e.target.style.border = '1px solid var(--c-accent)'; }} onBlurCapture={e => { e.target.style.border = '1px solid transparent'; }} />
    );
  }
  return options
    ? <ComboCell value={v} onChange={setV} onCommit={commit} options={options} title={v} style={cs} />
    : <AutoText value={v} onChange={setV} onBlur={() => commit(v)} title={v} style={cs} />;
}

export default function ConditionFileModal({ fileId, fileName, currency, token, canEdit: canEditProp = false, onClose }: Props) {
  const [allSheets, setSheets] = useState<Sheet[]>([]);
  const [allCompanySheet, setCompanySheet] = useState<Sheet | null>(null);
  const [months, setMonths] = useState<Month[]>([]);
  // 'latest' = آخر شهر فيه بيانات (يحسمه الخادم ويُعيده في resolvedMonth).
  const [month, setMonth] = useState('latest');
  const [resolvedMonth, setResolvedMonth] = useState('all');
  const [scope, setScope] = useState<Scope>(null);
  // «🏬 المحسوب في ميركاتو فقط» — لمراجعة الصفوف المكررة وحذفها.
  const [mercatoOnly, setMercatoOnly] = useState(false);
  const [tab, setTab] = useState(SUMMARY);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [cellState, setCellState] = useState<Record<string, 'saving' | 'ok' | 'err'>>({});
  const [canEdit, setCanEdit] = useState(canEditProp);
  const [suggest, setSuggest] = useState<Suggest>(NO_SUGGEST);
  // إعادة جلب بعد حفظ خانة: بلا «جاري التحميل…» كي لا يقفز الجدول ويضيع موضع التمرير.
  const silentRef = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const silent = silentRef.current; silentRef.current = false;
      if (!silent) { setLoading(true); setError(''); }
      try {
        const res = await fetch(`/api/files/${fileId}/condition-view?month=${encodeURIComponent(month)}`, { headers: { Authorization: `Bearer ${token}` } });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'تعذّر فتح الملف');
        if (!alive) return;
        setSheets(j.data.sheets);
        setCompanySheet(j.data.companySheet ?? null);
        setMonths(j.data.months?.months ?? []);
        setResolvedMonth(j.data.month || 'all');
        if (typeof j.data.canEdit === 'boolean') setCanEdit(j.data.canEdit);
      } catch (e: any) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [fileId, token, month, reload]);

  // اقتراحات خانات التعديل — نفس مصادر شبكة مراجعة طلبيات البوت.
  useEffect(() => {
    if (!canEdit || !token) return;
    const h = { Authorization: `Bearer ${token}` };
    const get = (u: string) => fetch(u, { headers: h }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const opts = (xs: unknown) => (Array.isArray(xs) ? [...new Set(xs.filter(Boolean) as string[])].map(value => ({ value })) : []);
    Promise.all([get('/api/orders/catalog-suggest'), get('/api/orders/scientific-reps'), get('/api/sales/warehouse-gap-scope')]).then(([cat, reps, scope]) => {
      setSuggest({
        items: (cat?.data?.items ?? []).map((it: any) => ({ value: it.name, hint: it.company || undefined })),
        companies: opts(cat?.data?.companies),
        areas: opts(cat?.data?.areas),
        reps: opts((reps?.data ?? []).map((r: any) => r.name)),
        warehouses: opts(scope?.data?.warehouses),
      });
    });
  }, [canEdit, token]);

  // زرّا «بغداد / المحافظات»: تصفية الصفوف ومجاميعها، والشيت الذي فرغ يختفي.
  const sheets = useMemo(() => allSheets.map(s => scopeSheet(s, scope, mercatoOnly)).filter(s => s.rows.length > 0), [allSheets, scope, mercatoOnly]);
  const companySheet = useMemo(() => (allCompanySheet ? scopeSheet(allCompanySheet, scope, mercatoOnly) : null), [allCompanySheet, scope, mercatoOnly]);
  // صفوف الكوديشن المحسوبة أيضاً في ميركاتو (المندوب صوّر فاتورة طلبية جهّزها ميركاتو).
  const mercatoDup = useMemo(() => {
    const seen = new Map<number, Row>();
    for (const s of allSheets) for (const r of s.rows) if (r.mercatoMatch && inScope(r, scope)) seen.set(r.id, r);
    const rows = [...seen.values()];
    return { rows: rows.length, sure: rows.filter(r => r.mercatoMatch!.level === 'duplicate').length, total: rows.reduce((a, r) => a + r.total, 0) };
  }, [allSheets, scope]);
  useEffect(() => { if (mercatoOnly && mercatoDup.rows === 0) setMercatoOnly(false); }, [mercatoOnly, mercatoDup.rows]);
  // تفصيل المحافظات (زر «المحافظات»): مجموع كل محافظة — الصف يُعدّ مرة واحدة.
  const byProvince = useMemo(() => {
    if (scope !== 'provinces') return [];
    const seen = new Set<number>();
    const m = new Map<string, { province: string; rows: number; quantity: number; total: number; reps: Set<string> }>();
    for (const s of sheets) for (const r of s.rows) {
      const k = r.province || UNKNOWN_PROVINCE;
      if (!m.has(k)) m.set(k, { province: k, rows: 0, quantity: 0, total: 0, reps: new Set() });
      const g = m.get(k)!;
      g.reps.add(s.rep);
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      g.rows++; g.quantity += r.quantity; g.total += r.total;
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [sheets, scope]);
  const shownMonth = month === 'latest' ? resolvedMonth : month;

  // تبويب مندوب لم يعد موجوداً بعد تغيير الشهر ← الملخص.
  useEffect(() => {
    if (tab !== SUMMARY && tab !== COMPANY && !sheets.some(s => s.rep === tab)) setTab(SUMMARY);
  }, [sheets, tab]);

  const totals = useMemo(() => sheets.reduce(
    (a, s) => ({ orders: a.orders + s.orders, rows: a.rows + s.rows.length, quantity: a.quantity + s.quantity, total: a.total + s.total }),
    { orders: 0, rows: 0, quantity: 0, total: 0 },
  ), [sheets]);

  const exportExcel = async () => {
    setExporting(true); setError('');
    try {
      const res = await fetch(`/api/files/${fileId}/condition-export?month=${encodeURIComponent(shownMonth)}${scope ? `&scope=${scope}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'تعذّر التصدير'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `الكوديشن${shownMonth !== 'all' ? `_${shownMonth}` : ''}${scope === 'baghdad' ? '_بغداد' : scope === 'provinces' ? '_المحافظات' : ''}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setError(e.message); }
    finally { setExporting(false); }
  };

  const authJson = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  // تحديث متفائل: القيمة تظهر فوراً في كل الشيتات، ثم يُعاد الجلب بصمت (المجاميع،
  // انتقال الصف لشيت مندوب آخر، الايتم بعد توحيده).
  const patchLocal = (id: number, ch: Partial<Row>) => {
    const fix = (s: Sheet): Sheet => ({ ...s, rows: s.rows.map(r => (r.id === id ? { ...r, ...ch } : r)) });
    setSheets(ss => ss.map(fix));
    setCompanySheet(cs => (cs ? fix(cs) : cs));
  };
  // الصيدليات الموجودة في الملف مع منطقتها — اختيار صيدلية يملأ منطقتها إن كانت فارغة.
  const pharmacyOpts = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of allSheets) for (const r of s.rows) if (r.pharmacy && !r.transit && !m.has(r.pharmacy)) m.set(r.pharmacy, r.area);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ar')).map(([value, area]) => ({ value, hint: area || undefined }));
  }, [allSheets]);
  const pharmacyArea = useMemo(() => new Map(pharmacyOpts.map(o => [o.value, o.hint || ''])), [pharmacyOpts]);
  const optionsFor = (key: string): ComboOpt[] | undefined => ({
    item: suggest.items, company: suggest.companies, area: suggest.areas, rep: suggest.reps,
    warehouse: suggest.warehouses, pharmacy: pharmacyOpts,
  } as Record<string, ComboOpt[]>)[key];

  const saveCell = async (row: Row, key: string, value: string) => {
    const body: Record<string, string | number> = { [key]: value };
    const local = { [key]: (EDIT_COLS.find(c => c.key === key)?.num ? Number(value.replace(/,/g, '')) || 0 : value) } as Partial<Row>;
    // تغيير الكمية يُبقي السعر ويعيد حساب القيمة — كما في شبكة المراجعة.
    if (key === 'quantity' && row.unitPrice > 0) { body.unitPrice = row.unitPrice; local.total = Math.round(row.unitPrice * (Number(value) || 0)); }
    if (key === 'unitPrice') local.total = Math.round((Number(value) || 0) * row.quantity);
    if (key === 'pharmacy' && !row.area && pharmacyArea.get(value)) { body.area = pharmacyArea.get(value)!; local.area = String(body.area); }
    const ck = `${row.id}:${key}`;
    setCellState(m => ({ ...m, [ck]: 'saving' })); setError('');
    patchLocal(row.id, local);
    try {
      const res = await fetch(`/api/files/${fileId}/condition-rows/${row.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'تعذّر الحفظ');
      setCellState(m => ({ ...m, [ck]: 'ok' }));
      setTimeout(() => setCellState(m => { const n = { ...m }; if (n[ck] === 'ok') delete n[ck]; return n; }), 1200);
    } catch (e: any) {
      setError(e.message);
      setCellState(m => ({ ...m, [ck]: 'err' }));
    }
    silentRef.current = true;
    setReload(n => n + 1);
  };
  const deleteRow = async (row: Row) => {
    if (!window.confirm(`حذف هذا الصف نهائياً؟
${row.item} — ${row.pharmacy || ''}`)) return;
    setError('');
    try {
      const res = await fetch(`/api/files/${fileId}/condition-rows/${row.id}`, { method: 'DELETE', headers: authJson });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'تعذّر الحذف');
      setReload(n => n + 1);
    } catch (e: any) { setError(e.message); }
  };

  const current = tab === COMPANY ? companySheet : sheets.find(s => s.rep === tab);
  const hasData = sheets.length > 0 || (companySheet?.rows.length ?? 0) > 0;
  const th: CSSProperties = { padding: '6px 8px', background: '#f1f5f9', fontWeight: 700, fontSize: 11.5, whiteSpace: 'nowrap', textAlign: 'center', position: 'sticky', top: 0 };
  const td: CSSProperties = { padding: '5px 8px', borderTop: '1px solid #e2e8f0', fontSize: 12, textAlign: 'center', whiteSpace: 'nowrap' };
  const tabBtn = (active: boolean): CSSProperties => ({
    border: `1px solid ${active ? 'var(--c-accent)' : '#e2e8f0'}`, background: active ? 'var(--c-accent-light)' : '#fff',
    color: active ? 'var(--c-accent)' : '#334155', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} dir="rtl" style={{ background: '#fff', borderRadius: 14, width: 'min(1100px, 100%)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: 18, boxShadow: '0 20px 50px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 16, flex: '1 1 200px' }}>📋 {fileName}</h3>
          {/* بغداد / المحافظات — ضغطة ثانية على الزر نفسه تُرجع الكل */}
          {([['baghdad', '🏙️ بغداد'], ['provinces', '🗺️ المحافظات']] as [Exclude<Scope, null>, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setScope(sc => (sc === k ? null : k))} style={tabBtn(scope === k)}
              title={scope === k ? 'عرض الكل' : `عرض طلبيات ${k === 'baghdad' ? 'بغداد' : 'باقي المحافظات'} ومندوبيها فقط`}>
              {label}
            </button>
          ))}
          <select value={shownMonth} onChange={e => setMonth(e.target.value)} style={{ border: '1px solid #cbd5e1', borderRadius: 8, padding: '5px 8px', fontSize: 12 }}>
            <option value="all">كل الأشهر</option>
            {months.map(m => <option key={m.ym} value={m.ym}>{m.label}</option>)}
          </select>
          <button onClick={exportExcel} disabled={exporting || loading || !hasData}
            style={{ border: '1px solid var(--c-success-border)', background: 'var(--c-success-bg)', color: 'var(--c-success)', borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            {exporting ? '⏳ جاري التصدير…' : '⬇️ تصدير إكسل (شيت لكل مندوب)'}
          </button>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        {error && <div style={{ color: 'var(--c-danger)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {!loading && mercatoDup.rows > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--c-danger-bg)', border: '1px solid var(--c-danger-border)', color: 'var(--c-danger)', fontSize: 12.5 }}>
            <span style={{ flex: '1 1 260px' }}>
              🏬 {fmt(mercatoDup.rows)} صف ({fmt(mercatoDup.total)} {currency}) محسوب أيضاً في مبيع ميركاتو
              {mercatoDup.sure < mercatoDup.rows ? ` — ${fmt(mercatoDup.rows - mercatoDup.sure)} منها محتمل فقط` : ''}.
              غالباً صورة فاتورة طلبية جهّزها ميركاتو — {canEdit ? 'راجعها واحذف المكرر' : 'راجعها مع مالك الملف'}.
            </span>
            <button onClick={() => setMercatoOnly(v => !v)} style={{ border: '1px solid var(--c-danger-border)', background: mercatoOnly ? 'var(--c-danger)' : '#fff', color: mercatoOnly ? '#fff' : 'var(--c-danger)', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              {mercatoOnly ? 'عرض الكل' : 'عرضها فقط'}
            </button>
          </div>
        )}
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>جاري التحميل…</div>
        ) : !hasData ? (
          <div style={{ color: '#94a3b8', fontSize: 13, background: '#f8fafc', borderRadius: 8, padding: 20, textAlign: 'center' }}>
            لا توجد مبيعات في ملف الكوديشن{shownMonth !== 'all' ? ' لهذا الشهر' : ''}{scope === 'baghdad' ? ' في بغداد' : scope === 'provinces' ? ' في المحافظات' : ''} بعد. تُضاف إليه طلبيات بوت تلكرام عند حفظها وإكسل الكوديشن عند رفعه، وطلبيات الترانزيت من ملف المكتب المفعّل.
          </div>
        ) : (
          <>
            {/* الشيتات: ملخّص + مندوب لكل تبويب */}
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid #e2e8f0' }}>
              <button onClick={() => setTab(SUMMARY)} style={tabBtn(tab === SUMMARY)}>📊 الملخص</button>
              {companySheet && (
                <button onClick={() => setTab(COMPANY)} style={tabBtn(tab === COMPANY)}
                  title="كل مبيعات الشركة في الملف مهما كان المندوب — ومنها الطلبيات المحفوظة بلا مندوب">
                  🏢 كل مبيعات الشركة <span style={{ color: '#94a3b8', fontWeight: 400 }}>({companySheet.rows.length})</span>
                </button>
              )}
              {sheets.map(s => (
                <button key={s.rep} onClick={() => setTab(s.rep)} style={tabBtn(tab === s.rep)}>
                  {s.rep} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({s.rows.length})</span>
                </button>
              ))}
            </div>

            <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
              {tab === SUMMARY || !current ? (
                <>
                {byProvince.length > 0 && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #e2e8f0', marginBottom: 12 }}>
                    <thead>
                      <tr>
                        <th style={th}>المحافظة</th><th style={th}>المندوبون</th><th style={th}>الصفوف</th>
                        <th style={th}>الكمية</th><th style={th}>القيمة ({currency})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byProvince.map(g => (
                        <tr key={g.province}>
                          <td style={{ ...td, fontWeight: 700, textAlign: 'right' }}>{g.province}</td>
                          <td style={{ ...td, whiteSpace: 'normal' }}>{[...g.reps].join('، ')}</td>
                          <td style={td}>{fmt(g.rows)}</td>
                          <td style={td}>{fmt(g.quantity)}</td>
                          <td style={{ ...td, fontWeight: 700 }}>{fmt(g.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #e2e8f0' }}>
                  <thead>
                    <tr>
                      <th style={th}>المندوب</th><th style={th}>عدد الطلبيات</th><th style={th}>الصفوف</th>
                      <th style={th}>الكمية</th><th style={th}>القيمة ({currency})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheets.map(s => (
                      <tr key={s.rep} onClick={() => setTab(s.rep)} style={{ cursor: 'pointer' }}>
                        <td style={{ ...td, fontWeight: 700, textAlign: 'right' }}>{s.rep}</td>
                        <td style={td}>{fmt(s.orders)}</td>
                        <td style={td}>{fmt(s.rows.length)}</td>
                        <td style={td}>{fmt(s.quantity)}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{fmt(s.total)}</td>
                      </tr>
                    ))}
                    <tr style={{ background: '#f8fafc' }}>
                      <td style={{ ...td, fontWeight: 800, textAlign: 'right' }}>المجموع</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.orders)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.rows)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.quantity)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.total)}</td>
                    </tr>
                  </tbody>
                </table>
                </>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #e2e8f0' }}>
                  <thead>
                    <tr>
                      {EDIT_COLS.map(c => <th key={c.key} style={th}>{c.label}</th>)}
                      <th style={th}>المصدر</th>
                      {canEdit && <th style={th} />}
                    </tr>
                  </thead>
                  <tbody>
                    {current.rows.map(r => {
                      // صف الترانزيت يعيش في ملف المكتب — لا يُعدَّل ولا يُحذف من هنا.
                      const rowEditable = canEdit && !r.transit;
                      return (
                      <tr key={r.id} style={r.transit ? { background: '#f0f9ff' } : r.mercatoMatch ? { background: r.mercatoMatch.level === 'duplicate' ? '#fee2e2' : '#fef3c7' } : undefined}
                        title={r.transit ? r.note : r.mercatoMatch ? mercatoTitle(r) : undefined}>
                        {EDIT_COLS.map(c => {
                          const val = c.key === 'rep' ? (current.all ? (r.rep || NO_REP) : current.rep) : String((r as any)[c.key] ?? '');
                          const editable = rowEditable && !c.ro;
                          const shown = (c.key === 'rep' && val === NO_REP) || (val === '0' && (c.key === 'bonus' || c.key === 'unitPrice')) ? '' : val;
                          return (
                            <td key={c.key} style={{ ...td, padding: editable ? 2 : td.padding,
                              ...(c.key === 'rep' && val === NO_REP ? { background: '#fef3c7', color: '#92400e', fontWeight: 700 } : null) }}>
                              {editable ? (
                                <EditCell col={c} value={shown} options={optionsFor(c.key)} state={cellState[`${r.id}:${c.key}`]}
                                  onSave={v => saveCell(r, c.key, v)} />
                              ) : (c.num ? (val && val !== '0' ? fmt(Number(val)) : '—') : (val || '—'))}
                            </td>
                          );
                        })}
                        <td style={{ ...td, color: '#64748b' }}>
                          {r.transit
                            ? <span style={{ background: '#e0f2fe', color: '#0369a1', border: '1px solid #7dd3fc', borderRadius: 6, padding: '1px 8px', fontWeight: 700 }}>🔁 ترانزيت</span>
                            : <>
                                {r.source || '—'}
                                {r.mercatoMatch && (
                                  <span title={mercatoTitle(r)} style={{ marginInlineStart: 6, background: '#fff', color: r.mercatoMatch.level === 'duplicate' ? 'var(--c-danger)' : '#92400e', border: '1px solid currentColor', borderRadius: 6, padding: '0 6px', fontWeight: 700 }}>
                                    🏬 {r.mercatoMatch.level === 'duplicate' ? 'في ميركاتو' : 'ربما ميركاتو'}
                                  </span>
                                )}
                              </>}
                        </td>
                        {canEdit && (
                          <td style={td}>
                            {rowEditable && <button onClick={() => deleteRow(r)} title="حذف الصف" style={{ border: '1px solid var(--c-danger-border)', background: 'var(--c-danger-bg)', color: 'var(--c-danger)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>×</button>}
                          </td>
                        )}
                      </tr>
                      );
                    })}
                    <tr style={{ background: '#f8fafc' }}>
                      <td style={{ ...td, fontWeight: 800 }} colSpan={9}>المجموع — {fmt(current.orders)} طلبية</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(current.quantity)}</td>
                      <td style={td} colSpan={2} />
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(current.total)}</td>
                      <td style={td} colSpan={canEdit ? 2 : 1} />
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
