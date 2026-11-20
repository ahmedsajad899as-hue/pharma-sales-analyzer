// ════════════════════════════════════════════════════════════════════════════
// ConditionFileModal — فتح «ملف الكوديشن» داخل التطبيق: شيت (تبويب) لكل مندوب
// بمبيعاته من طلبيات البوت وإكسل الكوديشن، + ملخّص، + تصدير إكسل بنفس الشيتات.
// الخادم: GET /api/files/:id/condition-view و GET /api/files/:id/condition-export.
// التعديل تفاعلي مثل شبكة مراجعة طلبيات البوت (ComboCell باقتراحات): كل خانة
// تُحفظ عند الخروج منها (PATCH condition-rows) في جدول المبيعات نفسه، فتأخذ بها
// التقارير ويراها كل من يفتح الملف.
// ════════════════════════════════════════════════════════════════════════════

import { Fragment, memo, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AutoText, ComboCell, type ComboOpt } from './ComboCell';

/** الطلبية المطابقة بأعمدة الجدول نفسها — تُعرض تحت الصف المشتبه للمقارنة. */
type CompareLine = {
  id: number; date: string; invoice: string; pharmacy: string; area: string; province?: string; warehouse: string;
  item: string; company: string; rep: string; quantity: number; bonus: number; unitPrice: number; total: number;
  source: string; transit?: boolean; currency?: string;
};
type Row = {
  id: number; date: string; invoice: string; pharmacy: string; area: string; warehouse: string;
  item: string; company: string; quantity: number; bonus: number; unitPrice: number; total: number; source: string;
  rep?: string;
  /** شركة (تيم) ايتم الصف — لزر الشركة على شيت «كل مبيعات الشركة» */
  team?: string | null;
  /** محافظة الصف — لزرّي «بغداد / المحافظات» */
  province?: string;
  /** طلبية ترانزيت من ملف المكتب — للقراءة فقط هنا */
  transit?: boolean; note?: string;
  /** الصف محسوب أيضاً في إكسل ميركاتو (flagConditionRowsInMercato في الخادم) */
  mercatoMatch?: {
    level: 'duplicate' | 'possible'; fileName: string; invoiceNumber?: string; date?: string;
    pharmacy?: string; warehouse?: string; rep?: string; sameQty: boolean; mercatoQty: number; reasons: string[];
    itemCount?: number; line?: CompareLine | null;
  };
  /** اشتباه تكرار بين صف بوت/فاتورة وطلبية ترانزيت (flagConditionTransitDups في الخادم) — على الطرفين */
  transitMatch?: {
    level: 'duplicate' | 'possible'; reasons: string[]; date: string; warehouse: string; pharmacy: string;
    quantity: number; total: number; otherId: number; source?: string; other?: CompareLine;
  };
  /** نفس الطلبية محفوظة مرتين داخل الملف (flagConditionSelfDups في الخادم) — على الطرفين */
  selfDup?: {
    level: 'duplicate' | 'possible'; reasons: string[]; date: string; warehouse: string; pharmacy: string;
    quantity: number; invoice?: string; otherId: number; source?: string; other?: CompareLine;
  };
};
/** team: شركة المندوب أو «مسوقين الكرخ/الرصافة» (attachConditionTeams في الخادم) */
type Sheet = { rep: string; rows: Row[]; quantity: number; total: number; orders: number; all?: boolean; team?: string | null };
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
function scopeSheet(s: Sheet, scope: Scope, mercatoOnly = false, transitOnly = false, selfOnly = false): Sheet {
  if (!scope && !mercatoOnly && !transitOnly && !selfOnly) return s;
  const rows = s.rows.filter(r => inScope(r, scope) && (!mercatoOnly || r.mercatoMatch) && (!transitOnly || r.transitMatch) && (!selfOnly || r.selfDup));
  return {
    ...s, rows,
    quantity: rows.reduce((a, r) => a + r.quantity, 0),
    total: rows.reduce((a, r) => a + r.total, 0),
    orders: new Set(rows.map(r => r.invoice || `${r.date}|${r.pharmacy}`)).size,
  };
}
const totalsOf = (s: Sheet, rows: Row[]): Sheet => ({
  ...s, rows,
  quantity: rows.reduce((a, r) => a + r.quantity, 0),
  total: rows.reduce((a, r) => a + r.total, 0),
  orders: new Set(rows.map(r => r.invoice || `${r.date}|${r.pharmacy}`)).size,
});
// زر الشركة — نفس filterConditionByTeam في server/lib/conditionFile.js: «الشركة» = التيم
// (ايتماتها المملوكة، row.team) — كل مندوب علمي له صفوف منها يظهر بتلك الصفوف فقط (تيم
// ليدر المحافظات يبيع لعدة شركات)؛ صف ايتمه بلا مالك يُحسب لشركة مندوبه. المسوقون لا
// يُدمجون مع العلميين — تحت زر «مسوقين …» وحده بشيتاتهم كاملة.
const isMarketerTeam = (t?: string | null) => !!t && t.startsWith('مسوقين');
const NO_TEAM = 'بلا شركة';
/** شركة الصف داخل شيت مندوب: المسوق ← قسمه دائماً؛ العلمي ← مالك الايتم وإلا شركة المندوب. */
const rowTeam = (r: Row, sheetTeam?: string | null) => (isMarketerTeam(sheetTeam) ? sheetTeam! : (r.team ?? sheetTeam ?? null));
function applyTeam(sheets: Sheet[], company: Sheet | null, team: string | null): { sheets: Sheet[]; company: Sheet | null } {
  if (!team) return { sheets, company };
  if (isMarketerTeam(team)) {
    const kept = sheets.filter(s => s.team === team);
    if (!company) return { sheets: kept, company };
    const rows = [...new Map(kept.flatMap(s => s.rows).map(r => [r.id, r])).values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    return { sheets: kept, company: totalsOf(company, rows) };
  }
  const repTeam = new Map(sheets.map(s => [s.rep, s.team]));
  const kept = sheets.map(s => totalsOf(s, s.rows.filter(r => rowTeam(r, s.team) === team))).filter(s => s.rows.length > 0);
  return { sheets: kept, company: company ? totalsOf(company, company.rows.filter(r => rowTeam(r, repTeam.get(r.rep || '')) === team)) : company };
}
const transitTitle = (r: Row) => {
  const m = r.transitMatch;
  if (!m) return '';
  const other = r.transit ? `صف ${m.source || 'الكوديشن'}` : 'طلبية ترانزيت';
  return `${m.level === 'duplicate' ? 'مشتبه تكراره' : 'ربما مكرر'} مع ${other}: `
    + [m.date, m.pharmacy, m.warehouse, `الكمية ${m.quantity}`].filter(Boolean).join(' · ')
    + ` — ${m.reasons.join('، ')}`;
};
const mercatoTitle = (r: Row) => {
  const m = r.mercatoMatch;
  if (!m) return '';
  return `${m.level === 'duplicate' ? 'محسوب أصلاً في مبيع ميركاتو' : 'ربما محسوب في ميركاتو'} «${m.fileName}»: `
    + [m.invoiceNumber && `طلبية ${m.invoiceNumber}`, m.pharmacy, m.date, m.warehouse, m.rep].filter(Boolean).join(' · ')
    + (m.sameQty ? '' : ` (كمية ميركاتو ${m.mercatoQty})`);
};
/** أقسام المقارنة تحت الصف: ترانزيت و/أو ميركاتو (قد يُعلَّم الصف بالاثنين). */
type CompareSection = { key: string; color: string; bg: string; caption: string; line?: CompareLine | null };
function compareSections(r: Row): CompareSection[] {
  const out: CompareSection[] = [];
  const t = r.transitMatch;
  if (t) {
    out.push({
      key: 'transit', color: '#9a3412', bg: '#fff7ed', line: t.other,
      caption: `⚠️ ${t.level === 'duplicate' ? 'مشتبه تكراره' : 'ربما مكرر'} مع ${r.transit ? `صف ${t.source || 'اللكوديشن'}` : 'طلبية ترانزيت'}: `
        + [t.date, t.pharmacy, t.warehouse].filter(Boolean).join(' · ') + ` — ${t.reasons.join('، ')}`,
    });
  }
  const d = r.selfDup;
  if (d) {
    out.push({
      key: 'self', color: '#b91c1c', bg: '#fef2f2', line: d.other,
      caption: `⚠️ ${d.level === 'duplicate' ? 'مكرر داخل الملف' : 'ربما مكرر داخل الملف'} مع صف آخر: `
        + [d.date, d.pharmacy, d.warehouse, d.source].filter(Boolean).join(' · ') + ` — ${d.reasons.join('، ')}`,
    });
  }
  const m = r.mercatoMatch;
  if (m) {
    const danger = m.level === 'duplicate';
    out.push({
      key: 'mercato', color: danger ? 'var(--c-danger)' : '#92400e', bg: danger ? 'var(--c-danger-bg)' : '#fffbeb', line: m.line,
      caption: `🏬 ${danger ? 'محسوب أصلاً في مبيع ميركاتو' : 'ربما محسوب في ميركاتو'} «${m.fileName}»: `
        + [m.invoiceNumber && `طلبية ${m.invoiceNumber}`, m.date, m.pharmacy, m.warehouse].filter(Boolean).join(' · ')
        + ` — ${m.reasons.join('، ')}`
        + ((m.itemCount ?? 0) > 1 ? ` — طلبية ميركاتو فيها ${m.itemCount} أصناف، المعروض الصنف المطابق لهذا الصف` : ''),
    });
  }
  return out;
}
const fmtExact = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
/**
 * هل تختلف قيمة العمود عن الصف أعلاه؟ للأرقام والتاريخ فقط: الأسماء تُكتب بأشكال مختلفة بين
 * المصادر («مذخر بلاتين» / «بلاتين - بغداد») فتظليلها يوهم باختلاف غير حقيقي. الترانزيت
 * لا يحمل بونصاً، والسعر والقيمة لا يُقارنان بين عملتين، والسعر الصفر يعني أنه غير مقروء.
 */
function cellDiffers(r: Row, l: CompareLine, key: string, currency: string): boolean {
  if (key === 'date') return !!r.date && !!l.date && r.date !== l.date;
  if (key === 'quantity') return r.quantity !== l.quantity;
  if (key === 'bonus') return !r.transit && !l.transit && (r.bonus || 0) !== (l.bonus || 0);
  if (key === 'unitPrice' || key === 'total') {
    if (l.currency && l.currency !== currency) return false;
    const a = Number((r as any)[key]) || 0, b = Number((l as any)[key]) || 0;
    return a > 0 && b > 0 && Math.abs(a - b) > Math.max(a, b) * 0.005;
  }
  return false;
}
// عمود الصف ← حقل التعديل في PATCH /api/files/:id/condition-rows/:saleId
// w = وزن العرض (نسبة من عرض الجدول) — الجدول كله بعرض النافذة بلا تمرير أفقي (طلب صاحب المشروع
// 2026-11-18): النص يلتفّ بدل أن يمدّ العمود، والمحافظة سطر صغير تحت المنطقة لا عموداً،
// والمندوب عمود فقط في الشيتات الجامعة (في شيت المندوب كل الصفوف له).
const EDIT_COLS: { key: string; label: string; w: number; num?: boolean; ro?: boolean }[] = [
  { key: 'date', label: 'التاريخ', w: 8.5 }, { key: 'invoice', label: 'الفاتورة', w: 6 },
  { key: 'pharmacy', label: 'الصيدلية', w: 11.5 }, { key: 'area', label: 'المنطقة', w: 8.5 },
  { key: 'warehouse', label: 'المذخر', w: 10 }, { key: 'item', label: 'الايتم', w: 14 },
  { key: 'company', label: 'الشركة', w: 6.5 }, { key: 'rep', label: 'المندوب', w: 9 },
  { key: 'quantity', label: 'الكمية', w: 4.5, num: true }, { key: 'bonus', label: 'بونص', w: 4, num: true },
  { key: 'unitPrice', label: 'السعر', w: 5.5, num: true }, { key: 'total', label: 'القيمة', w: 6.5, num: true },
];
/** رقم فاتورة تركيبي (طلبية بوت/فايبر بلا رقم) — لا معنى لعرضه كاملاً ولا لتعديله. */
const isSyntheticInvoice = (v: string) => /^BOT-/i.test(v);

type Suggest = { items: ComboOpt[]; companies: ComboOpt[]; areas: ComboOpt[]; reps: ComboOpt[]; warehouses: ComboOpt[] };
const NO_SUGGEST: Suggest = { items: [], companies: [], areas: [], reps: [], warehouses: [] };

type CellState = 'saving' | 'ok' | 'err';
type Col = typeof EDIT_COLS[number];
const toneOf = (state?: CellState): CSSProperties =>
  (state === 'saving' ? { opacity: 0.45 } : state === 'ok' ? { background: '#dcfce7' } : state === 'err' ? { background: '#fee2e2' } : {});

const TH: CSSProperties = { padding: '6px 8px', background: '#f1f5f9', fontWeight: 700, fontSize: 11.5, whiteSpace: 'nowrap', textAlign: 'center', position: 'sticky', top: 0 };
const TD: CSSProperties = { padding: '5px 8px', borderTop: '1px solid #e2e8f0', fontSize: 12, textAlign: 'center', whiteSpace: 'nowrap' };
// جدول الصفوف: النص يلتفّ داخل عموده (بلا تمرير أفقي)
const CELL_WRAP: CSSProperties = { whiteSpace: 'normal', overflowWrap: 'anywhere', fontSize: 11.5, lineHeight: 1.35 };

/**
 * خانة تعديل واحدة: مسودّة محلية أثناء الكتابة، وحفظ عند الخروج/الاختيار إن تغيّرت.
 * الخانات النصية بقائمة اقتراحات (ComboCell)، والتاريخ والأرقام حقول عادية.
 * تُركَّب للخانة المركَّز عليها فقط (SheetRow) — تأخذ التركيز فوراً، وعند مغادرتها
 * تعود الخانة نصّاً عادياً (onDone).
 */
function EditCell({ col, value, options, state, onSave, onDone }: {
  col: Col; value: string; options?: ComboOpt[];
  state?: CellState; onSave: (v: string) => void; onDone: () => void;
}) {
  const [v, setV] = useState(value);
  const base = useRef(value);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => { setV(value); base.current = value; }, [value]);
  useEffect(() => {
    const el = wrap.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    if (!el) return;
    el.focus({ preventScroll: true });
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* حقل لا يدعم التحديد */ }
  }, []);
  const commit = (nv: string) => { if (nv.trim() !== base.current.trim()) { base.current = nv; onSave(nv); } };
  const cs: CSSProperties = { width: '100%', minWidth: 0, fontSize: 11.5, textAlign: col.num ? 'center' : 'right', transition: 'background .4s', ...toneOf(state) };
  let field: ReactNode;
  if (col.key === 'date' || col.num) {
    // التاريخ نصّاً YYYY-MM-DD: حقل type=date يحتاج عرضاً ثابتاً كبيراً فيقصّ السنة في عمود ضيّق
    field = (
      <input value={v} type="text" inputMode={col.num ? 'decimal' : undefined} placeholder={col.key === 'date' ? 'YYYY-MM-DD' : undefined}
        onChange={e => setV(e.target.value)} onBlur={() => commit(v)}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setV(base.current); }}
        style={{ border: '1px solid var(--c-accent)', borderRadius: 6, padding: '4px 3px', background: '#fff', boxSizing: 'border-box', ...cs }} />
    );
  } else {
    field = options
      ? <ComboCell value={v} onChange={setV} onCommit={commit} options={options} title={v} style={cs} />
      : <AutoText value={v} onChange={setV} onBlur={() => commit(v)} title={v} style={cs} />;
  }
  // القائمة المنسدلة داخل الغلاف نفسه: التنقّل إليها ليس مغادرة للخانة.
  return <div ref={wrap} onBlur={e => { if (!wrap.current?.contains(e.relatedTarget as Node | null)) onDone(); }}>{field}</div>;
}

/**
 * الخانة القابلة للتعديل تُعرض نصّاً عادياً حتى يُركَّز عليها (نقرة أو Tab) فيُركَّب
 * محرّرها. كانت كل خانة محرّراً حيّاً: «كل مبيعات الشركة» بـ124 صفاً = ~1000 حقل، كلٌّ
 * يقيس ارتفاعه (إعادة تخطيط الجدول كله) ويُصفّي قائمة الايتمات كاملة في كل رسم — فتجمّد
 * التطبيق عند فتح التبويب ومع كل نقرة (شكوى صاحب المشروع 2026-11-20).
 */
const VIEW_CELL: CSSProperties = {
  boxSizing: 'border-box', width: '100%', border: '1px solid transparent', borderRadius: 7, cursor: 'text',
  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11.5, lineHeight: 1.45, color: '#1e293b', transition: 'background .4s',
};
const VIEW_SHORT: CSSProperties = { padding: '4px 3px', minHeight: 26 };
const VIEW_TEXT: CSSProperties = { padding: '6px 7px', minHeight: 32 };
const VIEW_CSS = '.cfm-cell:hover{border-color:#cbd5e1!important;background:#f8fafc}.cfm-cell:focus{outline:none;border-color:var(--c-accent)!important}';

type RowActions = {
  save: (r: Row, key: string, v: string) => void;
  del: (r: Row) => void;
  toggle: (id: number) => void;
  /** تركيز خانة («id:col») ← يُركَّب محرّرها؛ مغادرتها ← تعود نصّاً. */
  enter: (cellKey: string) => void;
  leave: (cellKey: string) => void;
};

/**
 * صفوف الشيت شبكة (CSS grid) لا جدول HTML: في الجدول أي تغيير في خانة واحدة (تركيز،
 * حرف، ارتفاع) يعيد تخطيط الجدول كله — 25–80ms عند 124 صفاً و130–260ms عند 600، وعدة
 * مرات في كل تعديل. كل صف هنا مستقل، والصف خارج الشاشة لا يُخطَّط ولا يُرسم
 * (content-visibility) — فكلفة التعديل لا تكبر مع عدد الصفوف.
 * الأعمدة بأوزان EDIT_COLS (fr) فتتطابق بين الصفوف والرأس، بلا تمرير أفقي.
 */
const ROW_CELL: CSSProperties = {
  ...CELL_WRAP, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', minWidth: 0, boxSizing: 'border-box',
};
const HEAD_CELL: CSSProperties = { padding: '6px 3px', fontWeight: 700, fontSize: 11.5, textAlign: 'center', overflowWrap: 'anywhere', alignSelf: 'center' };
const TOTAL_CELL: CSSProperties = { padding: '6px 4px', fontWeight: 800, fontSize: 12, textAlign: 'center' };
const ROW_SEP = '1px solid #e2e8f0';
const gridTemplate = (cols: Col[], canEdit: boolean) =>
  [...cols.map(c => `minmax(0, ${c.w}fr)`), 'minmax(0, 7fr)', ...(canEdit ? ['34px'] : [])].join(' ');
const BADGE: CSSProperties = { background: '#fff', border: '1px solid currentColor', borderRadius: 6, fontWeight: 700 };

/**
 * صف الشيت + أسطر المقارنة تحته. مُذكَّر (memo): حفظ خانة أو فتح مقارنة يعيد رسم
 * الصف المعني وحده لا الجدول كله. كل الدوال تصله عبر act الثابت.
 */
const SheetRow = memo(function SheetRow({ r, cols, template, sheetRep, canEdit, states, editCol, editOptions, open, currency, act }: {
  r: Row; cols: Col[]; template: string;
  /** null = شيت جامع (المندوب عمود لكل صف)، وإلا اسم مندوب الشيت */
  sheetRep: string | null;
  canEdit: boolean; states?: Record<string, CellState>;
  /** عمود الخانة الجاري تعديلها في هذا الصف، وإلا null */
  editCol: string | null; editOptions?: ComboOpt[];
  open: boolean; currency: string; act: RowActions;
}) {
  // صف الترانزيت يعيش في ملف المكتب — لا يُعدَّل ولا يُحذف من هنا.
  const rowEditable = canEdit && !r.transit;
  const sections = r.transitMatch || r.mercatoMatch || r.selfDup ? compareSections(r) : [];
  const grid: CSSProperties = { display: 'grid', gridTemplateColumns: template };
  const rowBg = r.selfDup ? '#fee2e2' : r.transitMatch ? '#ffedd5' : r.transit ? '#f0f9ff'
    : r.mercatoMatch ? (r.mercatoMatch.level === 'duplicate' ? '#fee2e2' : '#fef3c7') : undefined;
  const rowTitle = r.selfDup ? sections[0]?.caption : r.transitMatch ? transitTitle(r) : r.transit ? r.note : r.mercatoMatch ? mercatoTitle(r) : undefined;
  // الصف الجاري تعديله بلا احتواء: content-visibility يجعل الصف حاوياً لما هو position:fixed
  // ويقصّه، فتنحبس قائمة اقتراحات ComboCell داخله.
  const contain: CSSProperties | null = editCol ? null : { contentVisibility: 'auto', containIntrinsicSize: 'auto 40px' };
  return (
    <div data-row="" style={{ borderTop: ROW_SEP, ...contain }}>
      <div role="row" style={{ ...grid, background: rowBg }} title={rowTitle}>
        {cols.map(c => {
          const val = c.key === 'rep' ? (sheetRep ?? (r.rep || NO_REP)) : String((r as any)[c.key] ?? '');
          const synthetic = c.key === 'invoice' && isSyntheticInvoice(val);
          const editable = rowEditable && !c.ro && !synthetic;
          const shown = (c.key === 'rep' && val === NO_REP) || (val === '0' && (c.key === 'bonus' || c.key === 'unitPrice')) ? '' : val;
          const ck = `${r.id}:${c.key}`;
          let body: ReactNode;
          if (synthetic) body = <span title={val} style={{ color: '#94a3b8', fontSize: 11 }}>تلقائي</span>;
          else if (!editable) body = c.num ? (val && val !== '0' ? fmt(Number(val)) : '—') : (val || '—');
          else if (editCol === c.key) {
            body = (
              <EditCell col={c} value={shown} options={editOptions} state={states?.[c.key]}
                onSave={v => act.save(r, c.key, v)} onDone={() => act.leave(ck)} />
            );
          } else {
            const n = c.num && shown !== '' ? Number(shown) : NaN;
            const box = c.key === 'date' || c.num ? VIEW_SHORT : VIEW_TEXT;
            body = (
              <div className="cfm-cell" tabIndex={0} onFocus={() => act.enter(ck)} title={shown || undefined}
                style={{ ...VIEW_CELL, ...box, textAlign: c.num ? 'center' : 'right', ...toneOf(states?.[c.key]) }}>
                {Number.isFinite(n) ? fmtExact(n) : shown}
              </div>
            );
          }
          const noRep = c.key === 'rep' && val === NO_REP;
          return (
            <div key={c.key} role="cell"
              style={{ ...ROW_CELL, padding: editable ? 1 : '4px 3px', ...(noRep ? { background: '#fef3c7', color: '#92400e', fontWeight: 700 } : null) }}>
              {body}
              {/* المحافظة سطر صغير تحت المنطقة (كانت عموداً مستقلاً) */}
              {c.key === 'area' && r.province && <div style={{ fontSize: 10.5, color: '#94a3b8', lineHeight: 1.2 }}>{r.province}</div>}
            </div>
          );
        })}
        <div role="cell" style={{ ...ROW_CELL, color: '#64748b', fontSize: 11, padding: '4px 4px' }}>
          <div>
            {r.selfDup && (
              <span style={{ ...BADGE, display: 'inline-block', marginInlineEnd: 4, marginBottom: 2, color: '#b91c1c', padding: '0 5px' }}>
                ⚠️ {r.selfDup.level === 'duplicate' ? 'مكرر' : 'ربما مكرر'}
              </span>
            )}
            {r.transitMatch && (
              <span title={transitTitle(r)} style={{ ...BADGE, marginInlineEnd: 6, color: '#c2410c', padding: '0 6px', whiteSpace: 'nowrap' }}>
                ⚠️ {r.transitMatch.level === 'duplicate' ? 'مشتبه تكرار' : 'ربما مكرر'}
              </span>
            )}
            {r.transit ? (
              <span style={{ background: '#e0f2fe', color: '#0369a1', border: '1px solid #7dd3fc', borderRadius: 6, padding: '1px 8px', fontWeight: 700 }}>🔁 ترانزيت</span>
            ) : (
              <>
                {r.source || '—'}
                {r.mercatoMatch && (
                  <span title={mercatoTitle(r)}
                    style={{ ...BADGE, marginInlineStart: 6, color: r.mercatoMatch.level === 'duplicate' ? 'var(--c-danger)' : '#92400e', padding: '0 6px' }}>
                    🏬 {r.mercatoMatch.level === 'duplicate' ? 'في ميركاتو' : 'ربما ميركاتو'}
                  </span>
                )}
              </>
            )}
            {sections.length > 0 && (
              <button onClick={() => act.toggle(r.id)} aria-expanded={open}
                title="عرض الطلبية المشابهة تحت هذا الصف للمقارنة"
                style={{ marginInlineStart: 6, border: '1px solid #334155', background: open ? '#334155' : '#fff', color: open ? '#fff' : '#334155', borderRadius: 6, padding: '1px 8px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {open ? '▴ إخفاء' : '▾ قارن'}
              </button>
            )}
          </div>
        </div>
        {canEdit && (
          <div role="cell" style={{ ...ROW_CELL, alignItems: 'center', padding: 2 }}>
            {rowEditable && (
              <button onClick={() => act.del(r)} title="حذف الصف"
                style={{ border: '1px solid var(--c-danger-border)', background: 'var(--c-danger-bg)', color: 'var(--c-danger)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>×</button>
            )}
          </div>
        )}
      </div>
      {open && sections.map(sec => {
        const l = sec.line;
        const anyDiff = !!l && cols.some(c => cellDiffers(r, l, c.key, currency));
        const otherCurrency = l?.currency && l.currency !== currency ? l.currency : '';
        return (
          <Fragment key={sec.key}>
            <div style={{ background: sec.bg, borderTop: ROW_SEP, padding: '5px 8px', color: sec.color, fontWeight: 600, fontSize: 12, textAlign: 'right' }}>
              {sec.caption}
              {otherCurrency && ` — قيمة ميركاتو بعملة ${otherCurrency}`}
              {anyDiff && <span style={{ marginInlineStart: 6, background: '#fef08a', color: '#713f12', borderRadius: 4, padding: '0 5px' }}>المظلَّل يختلف عن الصف أعلاه</span>}
            </div>
            {l && (
              <div role="row" style={{ ...grid, background: '#fff', borderTop: ROW_SEP }}>
                {cols.map(c => {
                  const raw = (l as any)[c.key];
                  const diff = cellDiffers(r, l, c.key, currency);
                  return (
                    <div key={c.key} role="cell" style={{ ...ROW_CELL, padding: '4px 3px', ...(diff ? { background: '#fef08a', color: '#713f12', fontWeight: 800 } : null) }}>
                      {c.num ? (raw ? fmtExact(Number(raw)) : '—') : (raw || '—')}
                    </div>
                  );
                })}
                <div role="cell" style={{ ...ROW_CELL, padding: '4px 3px', color: sec.color, fontWeight: 700 }}>{l.transit ? '🔁 ترانزيت' : (l.source || '—')}</div>
                {canEdit && <div />}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
});

/**
 * إعادة الجلب الصامتة تُرجع كل الصفوف كائنات جديدة: يُبقى كائن الصف القديم إن لم
 * يتغيّر محتواه، فلا يُعاد رسم إلا الصفوف التي تغيّرت فعلاً (SheetRow مُذكَّر بالصف).
 */
function rowReuser(prev: Row[]) {
  const old = new Map<string, Row>();
  for (const r of prev) old.set(JSON.stringify(r), r);
  return (s: Sheet): Sheet => ({ ...s, rows: s.rows.map(r => old.get(JSON.stringify(r)) ?? r) });
}

export default function ConditionFileModal({ fileId, fileName, currency, token, canEdit: canEditProp = false, onClose }: Props) {
  const [allSheets, setSheets] = useState<Sheet[]>([]);
  const [allCompanySheet, setCompanySheet] = useState<Sheet | null>(null);
  const [months, setMonths] = useState<Month[]>([]);
  // 'latest' = آخر شهر فيه بيانات (يحسمه الخادم ويُعيده في resolvedMonth).
  const [month, setMonth] = useState('latest');
  const [resolvedMonth, setResolvedMonth] = useState('all');
  const [scope, setScope] = useState<Scope>(null);
  // زر الشركة/المسوقين في الأعلى — null = الكل.
  const [team, setTeam] = useState<string | null>(null);
  // «🏬 المحسوب في ميركاتو فقط» — لمراجعة الصفوف المكررة وحذفها.
  const [mercatoOnly, setMercatoOnly] = useState(false);
  // «⚠️ اشتباه تكرار مع الترانزيت فقط» — صف البوت وطلبية الترانزيت التي تشبهه.
  const [transitOnly, setTransitOnly] = useState(false);
  // «مكرر داخل الملف فقط» — نفس الطلبية محفوظة مرتين (flagConditionSelfDups)
  const [selfOnly, setSelfOnly] = useState(false);
  // الصفوف المفتوحة مقارنتها — بالمعرّف كي تبقى مفتوحة بعد إعادة الجلب الصامتة عند حفظ خانة.
  const [compareOpen, setCompareOpen] = useState<Set<number>>(() => new Set());
  const toggleCompare = (id: number) => setCompareOpen(cur => {
    const next = new Set(cur);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const [tab, setTab] = useState(SUMMARY);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [cellState, setCellState] = useState<Record<string, CellState>>({});
  // الخانة الجاري تعديلها «id:col» — محرّر واحد في الجدول كله، والباقي نصّ عادي.
  const [editing, setEditing] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(canEditProp);
  const [suggest, setSuggest] = useState<Suggest>(NO_SUGGEST);
  // إعادة جلب بعد حفظ خانة: بلا «جاري التحميل…» كي لا يقفز الجدول ويضيع موضع التمرير.
  const silentRef = useRef(false);
  // عدّاد التعديلات المحلية: رد جلب صامت بدأ قبل تعديل أحدث يحمل القيمة القديمة فيُهمَل
  // (جلب آخر مجدول بعده أصلاً) — كي لا ترتدّ الخانة لقيمتها السابقة.
  const editSeq = useRef(0);
  const latest = useRef<{ sheets: Sheet[]; company: Sheet | null }>({ sheets: [], company: null });
  latest.current = { sheets: allSheets, company: allCompanySheet };

  useEffect(() => {
    let alive = true;
    (async () => {
      const silent = silentRef.current; silentRef.current = false;
      const seq = editSeq.current;
      if (!silent) { setLoading(true); setError(''); }
      try {
        const res = await fetch(`/api/files/${fileId}/condition-view?month=${encodeURIComponent(month)}`, { headers: { Authorization: `Bearer ${token}` } });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'تعذّر فتح الملف');
        if (!alive || (silent && seq !== editSeq.current)) return;
        let nextSheets: Sheet[] = j.data.sheets;
        let nextCompany: Sheet | null = j.data.companySheet ?? null;
        if (silent) {
          const reuse = rowReuser([...latest.current.sheets.flatMap(s => s.rows), ...(latest.current.company?.rows ?? [])]);
          nextSheets = nextSheets.map(reuse);
          nextCompany = nextCompany && reuse(nextCompany);
        }
        setSheets(nextSheets);
        setCompanySheet(nextCompany);
        setMonths(j.data.months?.months ?? []);
        setResolvedMonth(j.data.month || 'all');
        if (typeof j.data.canEdit === 'boolean') setCanEdit(j.data.canEdit);
        // تحميل الشهر السابق بالخلفية بعد الفتح الأول: يحفظه مخبأ الخادم فيصير التبديل إليه فورياً.
        if (!silent && month === 'latest') {
          const yms = ((j.data.months?.months ?? []) as Month[]).map(m => m.ym).sort();
          const prev = yms[yms.indexOf(j.data.month) - 1];
          if (prev) setTimeout(() => {
            fetch(`/api/files/${fileId}/condition-view?month=${encodeURIComponent(prev)}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
          }, 1500);
        }
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

  // التبويب والشركة والنطاق والفلاتر: الزر يتلوّن فوراً (القيم الفورية)، ورسم الجدول الجديد
  // يجري بأولوية منخفضة قابلة للمقاطعة (useDeferredValue) — فلا تتجمّد النافذة أثناءه.
  const filters = useMemo(() => ({ tab, team, scope, mercatoOnly, transitOnly, selfOnly }), [tab, team, scope, mercatoOnly, transitOnly, selfOnly]);
  const vf = useDeferredValue(filters);
  const switching = vf !== filters;
  // زرّا «بغداد / المحافظات»: تصفية الصفوف ومجاميعها، والشيت الذي فرغ يختفي.
  const scopedSheets = useMemo(() => allSheets.map(s => scopeSheet(s, vf.scope, vf.mercatoOnly, vf.transitOnly, vf.selfOnly)).filter(s => s.rows.length > 0), [allSheets, vf]);
  const scopedCompany = useMemo(() => (allCompanySheet ? scopeSheet(allCompanySheet, vf.scope, vf.mercatoOnly, vf.transitOnly, vf.selfOnly) : null), [allCompanySheet, vf]);
  // الشركات الموجودة في الملف (لأزرار الأعلى): الشركات أبجدياً ثم المسوقون.
  const teams = useMemo(() => [...new Set(allSheets.map(s => s.team).filter((t): t is string => !!t))]
    .sort((a, b) => Number(isMarketerTeam(a)) - Number(isMarketerTeam(b)) || a.localeCompare(b, 'ar')), [allSheets]);
  useEffect(() => { if (team && !teams.includes(team)) setTeam(null); }, [team, teams]);
  const { sheets, company: companySheet } = useMemo(() => applyTeam(scopedSheets, scopedCompany, vf.team), [scopedSheets, scopedCompany, vf.team]);
  // صفوف الكوديشن المحسوبة أيضاً في ميركاتو (المندوب صوّر فاتورة طلبية جهّزها ميركاتو).
  const mercatoDup = useMemo(() => {
    const seen = new Map<number, Row>();
    for (const s of allSheets) for (const r of s.rows) if (r.mercatoMatch && inScope(r, scope)) seen.set(r.id, r);
    const rows = [...seen.values()];
    return { rows: rows.length, sure: rows.filter(r => r.mercatoMatch!.level === 'duplicate').length, total: rows.reduce((a, r) => a + r.total, 0) };
  }, [allSheets, scope]);
  useEffect(() => { if (mercatoOnly && mercatoDup.rows === 0) setMercatoOnly(false); }, [mercatoOnly, mercatoDup.rows]);
  // أزواج (صف كوديشن ↔ ترانزيت) المشتبه بتكرارها — يُعدّ صف الكوديشن (طرف الزوج غير الترانزيت).
  const transitDup = useMemo(() => {
    const seen = new Map<number, Row>();
    for (const s of allSheets) for (const r of s.rows) if (r.transitMatch && !r.transit && inScope(r, scope)) seen.set(r.id, r);
    const rows = [...seen.values()];
    return { pairs: rows.length, sure: rows.filter(r => r.transitMatch!.level === 'duplicate').length, total: rows.reduce((a, r) => a + r.total, 0) };
  }, [allSheets, scope]);
  useEffect(() => { if (transitOnly && transitDup.pairs === 0) setTransitOnly(false); }, [transitOnly, transitDup.pairs]);
  const selfDup = useMemo(() => {
    const seen = new Map<number, Row>();
    for (const s of allSheets) for (const r of s.rows) if (r.selfDup && inScope(r, scope)) seen.set(r.id, r);
    const rows = [...seen.values()];
    return { rows: rows.length, sure: rows.filter(r => r.selfDup!.level === 'duplicate').length };
  }, [allSheets, scope]);
  useEffect(() => { if (selfOnly && selfDup.rows === 0) setSelfOnly(false); }, [selfOnly, selfDup.rows]);
  // تفصيل المحافظات (زر «المحافظات»): مجموع كل محافظة — الصف يُعدّ مرة واحدة.
  const byProvince = useMemo(() => {
    if (vf.scope !== 'provinces') return [];
    const seen = new Set<number>();
    const m = new Map<string, { province: string; rows: number; quantity: number; total: number; reps: Set<string> }>();
    for (const s of sheets) for (const r of s.rows) {
      const k = r.province || UNKNOWN_PROVINCE;
      if (!m.has(k)) m.set(k, { province: k, rows: 0, quantity: 0, total: 0, reps: new Set() });
      const g = m.get(k)!;
      g.reps.add(teams.length > 1 && vf.team === null ? (s.team || NO_TEAM) : s.rep);
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      g.rows++; g.quantity += r.quantity; g.total += r.total;
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [sheets, vf.scope, teams.length, vf.team]);
  const shownMonth = month === 'latest' ? resolvedMonth : month;

  // تبويب مندوب لم يعد موجوداً بعد تغيير الشهر ← الملخص.
  useEffect(() => {
    if (tab !== SUMMARY && tab !== COMPANY && !sheets.some(s => s.rep === tab)) setTab(SUMMARY);
  }, [sheets, tab]);

  // «الكل» مع أكثر من شركة: الملخص بالشركات فقط، وأسماء المندوبين تظهر عند الضغط على شركة.
  const teamsFirst = teams.length > 1 && vf.team === null;
  const byTeam = useMemo(() => {
    if (!teamsFirst) return [];
    // بالصفوف لا بالشيت: مبيع تيم ليدر المحافظات يتوزّع على شركات ايتماته.
    const m = new Map<string, { team: string; reps: Set<string>; orders: Set<string>; rows: number; quantity: number; total: number }>();
    for (const s of sheets) for (const r of s.rows) {
      const k = rowTeam(r, s.team) || NO_TEAM;
      if (!m.has(k)) m.set(k, { team: k, reps: new Set(), orders: new Set(), rows: 0, quantity: 0, total: 0 });
      const g = m.get(k)!;
      g.reps.add(s.rep); g.orders.add(r.invoice || `${r.date}|${r.pharmacy}`);
      g.rows++; g.quantity += r.quantity; g.total += r.total;
    }
    const rank = (t: string) => (t === NO_TEAM ? 2 : isMarketerTeam(t) ? 1 : 0);
    return [...m.values()]
      .map(g => ({ team: g.team, reps: g.reps.size, orders: g.orders.size, rows: g.rows, quantity: g.quantity, total: g.total }))
      .sort((a, b) => rank(a.team) - rank(b.team) || b.total - a.total);
  }, [sheets, teamsFirst]);
  useEffect(() => { if (teamsFirst && tab !== SUMMARY && tab !== COMPANY) setTab(SUMMARY); }, [teamsFirst, tab]);

  const totals = useMemo(() => sheets.reduce(
    (a, s) => ({ orders: a.orders + s.orders, rows: a.rows + s.rows.length, quantity: a.quantity + s.quantity, total: a.total + s.total }),
    { orders: 0, rows: 0, quantity: 0, total: 0 },
  ), [sheets]);

  const exportExcel = async () => {
    setExporting(true); setError('');
    try {
      const res = await fetch(`/api/files/${fileId}/condition-export?month=${encodeURIComponent(shownMonth)}${scope ? `&scope=${scope}` : ''}${team ? `&team=${encodeURIComponent(team)}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'تعذّر التصدير'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `اللكوديشن${shownMonth !== 'all' ? `_${shownMonth}` : ''}${scope === 'baghdad' ? '_بغداد' : scope === 'provinces' ? '_المحافظات' : ''}${team ? `_${team}` : ''}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setError(e.message); }
    finally { setExporting(false); }
  };

  const authJson = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  // تحديث متفائل: القيمة تظهر فوراً في كل الشيتات، ثم يُعاد الجلب بصمت (المجاميع،
  // انتقال الصف لشيت مندوب آخر، الايتم بعد توحيده).
  // الشيت الذي لا يحوي الصف يبقى الكائن نفسه (لا يُعاد رسمه)، والمجاميع تُحسب فوراً.
  const patchLocal = (id: number, ch: Partial<Row>) => {
    const fix = (s: Sheet): Sheet => (s.rows.some(r => r.id === id) ? totalsOf(s, s.rows.map(r => (r.id === id ? { ...r, ...ch } : r))) : s);
    setSheets(ss => ss.map(fix));
    setCompanySheet(cs => (cs ? fix(cs) : cs));
  };
  const removeLocal = (id: number) => {
    const drop = (s: Sheet): Sheet => (s.rows.some(r => r.id === id) ? totalsOf(s, s.rows.filter(r => r.id !== id)) : s);
    setSheets(ss => ss.map(drop).filter(s => s.rows.length > 0));
    setCompanySheet(cs => (cs ? drop(cs) : cs));
  };
  // الجلب الصامت بعد الحفظ يكلّف الخادم 2–4 ثوانٍ (يُعاد حساب الملف كله): تعديلات
  // متتالية تُجمع في جلب واحد بعد أن تهدأ، والقيمة تظهر قبله محلياً (patchLocal).
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  const scheduleRefresh = () => {
    editSeq.current++;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { silentRef.current = true; setReload(n => n + 1); }, 1500);
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
    scheduleRefresh();
  };
  const deleteRow = async (row: Row) => {
    if (!window.confirm(`حذف هذا الصف نهائياً؟
${row.item} — ${row.pharmacy || ''}`)) return;
    setError('');
    try {
      const res = await fetch(`/api/files/${fileId}/condition-rows/${row.id}`, { method: 'DELETE', headers: authJson });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'تعذّر الحذف');
      // يختفي فوراً ويبقى موضع التمرير؛ علامات التكرار على شريكه تتحدّث بالجلب الصامت.
      removeLocal(row.id);
      scheduleRefresh();
    } catch (e: any) { setError(e.message); }
  };

  // دوال الصفوف عبر مرجع ثابت — كي لا تكسر تذكير SheetRow بدوال جديدة في كل رسم.
  const actRef = useRef({ saveCell, deleteRow, toggleCompare });
  actRef.current = { saveCell, deleteRow, toggleCompare };
  const act = useMemo<RowActions>(() => ({
    save: (r, k, v) => { void actRef.current.saveCell(r, k, v); },
    del: r => { void actRef.current.deleteRow(r); },
    toggle: id => actRef.current.toggleCompare(id),
    enter: key => setEditing(key),
    leave: key => setEditing(cur => (cur === key ? null : cur)),
  }), []);
  // حالة الحفظ لكل صف — الصف بلا حالة يأخذ undefined فلا يُعاد رسمه.
  const rowStates = useMemo(() => {
    const m = new Map<number, Record<string, CellState>>();
    for (const [k, st] of Object.entries(cellState)) {
      const i = k.indexOf(':');
      const id = Number(k.slice(0, i));
      m.set(id, { ...m.get(id), [k.slice(i + 1)]: st });
    }
    return m;
  }, [cellState]);
  const editSep = editing ? editing.indexOf(':') : -1;
  const editId = editing ? Number(editing.slice(0, editSep)) : NaN;
  const editCol = editing ? editing.slice(editSep + 1) : null;

  const current = vf.tab === COMPANY ? companySheet : sheets.find(s => s.rep === vf.tab);
  const hasData = sheets.length > 0 || (companySheet?.rows.length ?? 0) > 0;
  const th = TH;
  const td = TD;
  const showRep = !!current?.all;
  const cols = useMemo(() => EDIT_COLS.filter(c => c.key !== 'rep' || showRep), [showRep]);
  const template = useMemo(() => gridTemplate(cols, canEdit), [cols, canEdit]);
  const tabBtn = (active: boolean): CSSProperties => ({
    border: `1px solid ${active ? 'var(--c-accent)' : '#e2e8f0'}`, background: active ? 'var(--c-accent-light)' : '#fff',
    color: active ? 'var(--c-accent)' : '#334155', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} dir="rtl" style={{ background: '#fff', borderRadius: 14, width: 'min(1320px, 100%)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: 18, boxShadow: '0 20px 50px rgba(0,0,0,.25)' }}>
        <style>{VIEW_CSS}</style>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap', flexShrink: 0 }}>
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

        {/* الشركات — اختيار شركة واحدة (أو مسوقي الكرخ/الرصافة) أو الكل */}
        {teams.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0, marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#64748b' }}>الشركة:</span>
            <button onClick={() => setTeam(null)} style={tabBtn(team === null)}>الكل</button>
            {teams.map(t => (
              <button key={t} onClick={() => setTeam(cur => (cur === t ? null : t))} style={tabBtn(team === t)}>{t}</button>
            ))}
          </div>
        )}

        {error && <div style={{ color: 'var(--c-danger)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {!loading && mercatoDup.rows > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0, marginBottom: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--c-danger-bg)', border: '1px solid var(--c-danger-border)', color: 'var(--c-danger)', fontSize: 12.5 }}>
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
        {!loading && transitDup.pairs > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0, marginBottom: 8, padding: '6px 10px', borderRadius: 8, background: '#fff7ed', border: '1px solid #fdba74', color: '#9a3412', fontSize: 12.5 }}>
            <span style={{ flex: '1 1 260px' }}>
              ⚠️ اشتباه تكرار: {fmt(transitDup.pairs)} صف ({fmt(transitDup.total)} {currency}) يشبه طلبية ترانزيت —
              نفس الصيدلية والايتم والكمية{transitDup.sure < transitDup.pairs ? '' : ' والمذخر'} بتاريخ قريب. غالباً الطلبية نفسها حُسبت مرتين — {canEdit ? 'راجعها واحذف المكرر' : 'راجعها مع مالك الملف'}.
            </span>
            <button onClick={() => setTransitOnly(v => !v)} style={{ border: '1px solid #fdba74', background: transitOnly ? '#ea580c' : '#fff', color: transitOnly ? '#fff' : '#9a3412', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              {transitOnly ? 'عرض الكل' : 'عرضها فقط'}
            </button>
          </div>
        )}
        {!loading && selfDup.rows > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0, marginBottom: 8, padding: '6px 10px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fca5a5', color: '#b91c1c', fontSize: 12.5 }}>
            <span style={{ flex: '1 1 260px' }}>
              ⚠️ {fmt(selfDup.rows)} صف يشبه صفاً آخر في الملف — نفس الصيدلية والايتم والكمية خلال 3 أيام
              {selfDup.sure < selfDup.rows ? ` (${fmt(selfDup.rows - selfDup.sure)} منها محتمل فقط: مذخر مكتوب بشكل آخر أو يوم مختلف)` : ''}.
              غالباً الطلبية نفسها حُفظت مرتين — {canEdit ? 'قارنها واحذف المكرر' : 'راجعها مع مالك الملف'}.
            </span>
            <button onClick={() => setSelfOnly(v => !v)} style={{ border: '1px solid #fca5a5', background: selfOnly ? '#dc2626' : '#fff', color: selfOnly ? '#fff' : '#b91c1c', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              {selfOnly ? 'عرض الكل' : 'عرضها فقط'}
            </button>
          </div>
        )}
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>جاري التحميل…</div>
        ) : !hasData ? (
          <div style={{ color: '#94a3b8', fontSize: 13, background: '#f8fafc', borderRadius: 8, padding: 20, textAlign: 'center' }}>
            لا توجد مبيعات في ملف اللكوديشن{shownMonth !== 'all' ? ' لهذا الشهر' : ''}{scope === 'baghdad' ? ' في بغداد' : scope === 'provinces' ? ' في المحافظات' : ''} بعد. تُضاف إليه طلبيات بوت تلكرام عند حفظها وإكسل اللكوديشن عند رفعه، وطلبيات الترانزيت من ملف المكتب المفعّل.
          </div>
        ) : (
          <>
            {/* الشيتات: ملخّص + مندوب لكل تبويب. flexShrink:0 — داخل نافذة عمودية بارتفاع
                أقصى كان الجدول الطويل يضغط صف التبويبات فيُقصّ وتتداخل أزراره معه؛ والتفاف
                الأزرار بدل التمرير الأفقي يُبقي كل المندوبين ظاهرين. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flexShrink: 0, paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid #e2e8f0' }}>
              <button onClick={() => setTab(SUMMARY)} style={tabBtn(tab === SUMMARY)}>📊 الملخص</button>
              {companySheet && (
                <button onClick={() => setTab(COMPANY)} style={tabBtn(tab === COMPANY)}
                  title="كل مبيعات الشركة في الملف مهما كان المندوب — ومنها الطلبيات المحفوظة بلا مندوب">
                  🏢 كل مبيعات الشركة <span style={{ color: '#94a3b8', fontWeight: 400 }}>({companySheet.rows.length})</span>
                </button>
              )}
              {!teamsFirst && sheets.map(s => (
                <button key={s.rep} onClick={() => setTab(s.rep)} style={tabBtn(tab === s.rep)}>
                  {s.rep} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({s.rows.length})</span>
                </button>
              ))}
            </div>

            {/* أثناء رسم التبويب/الشركة الجديدة بالخلفية يخفت المعروض بدل أن تتجمّد النافذة */}
            <div style={{ overflow: 'auto', flex: 1, minHeight: 0, opacity: switching ? 0.55 : 1, transition: 'opacity .12s' }}>
              {vf.tab === SUMMARY || !current ? (
                <>
                {byProvince.length > 0 && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #e2e8f0', marginBottom: 12 }}>
                    <thead>
                      <tr>
                        <th style={th}>المحافظة</th><th style={th}>{teamsFirst ? 'الشركات' : 'المندوبون'}</th><th style={th}>الصفوف</th>
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
                      <th style={th}>{teamsFirst ? 'الشركة' : 'المندوب'}</th><th style={th}>{teamsFirst ? '' : 'الشركة'}</th><th style={th}>عدد الطلبيات</th><th style={th}>الصفوف</th>
                      <th style={th}>الكمية</th><th style={th}>القيمة ({currency})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamsFirst ? byTeam.map(g => (
                      <tr key={g.team} onClick={() => g.team !== NO_TEAM && setTeam(g.team)} style={{ cursor: g.team !== NO_TEAM ? 'pointer' : 'default' }}
                        title={g.team !== NO_TEAM ? `اضغط لعرض مندوبي «${g.team}»` : 'مندوبون لم يُعرف لهم حساب/شركة في المكتب'}>
                        <td style={{ ...td, fontWeight: 700, textAlign: 'right' }}>{g.team} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({g.reps} مندوب)</span></td>
                        <td style={{ ...td, color: '#94a3b8' }}>{g.team !== NO_TEAM ? 'عرض المندوبين ◂' : ''}</td>
                        <td style={td}>{fmt(g.orders)}</td>
                        <td style={td}>{fmt(g.rows)}</td>
                        <td style={td}>{fmt(g.quantity)}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{fmt(g.total)}</td>
                      </tr>
                    )) : sheets.map(s => (
                      <tr key={s.rep} onClick={() => setTab(s.rep)} style={{ cursor: 'pointer' }}>
                        <td style={{ ...td, fontWeight: 700, textAlign: 'right' }}>{s.rep}</td>
                        <td style={{ ...td, color: s.team ? '#334155' : '#cbd5e1' }}>{s.team || '—'}</td>
                        <td style={td}>{fmt(s.orders)}</td>
                        <td style={td}>{fmt(s.rows.length)}</td>
                        <td style={td}>{fmt(s.quantity)}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{fmt(s.total)}</td>
                      </tr>
                    ))}
                    <tr style={{ background: '#f8fafc' }}>
                      <td style={{ ...td, fontWeight: 800, textAlign: 'right' }}>المجموع</td>
                      <td style={td} />
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.orders)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.rows)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.quantity)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.total)}</td>
                    </tr>
                  </tbody>
                </table>
                </>
              ) : (
                <div role="table" style={{ border: ROW_SEP }}>
                  <div role="row" style={{ display: 'grid', gridTemplateColumns: template, position: 'sticky', top: 0, zIndex: 2, background: '#f1f5f9' }}>
                    {cols.map(c => <div key={c.key} role="columnheader" style={HEAD_CELL}>{c.label}</div>)}
                    <div role="columnheader" style={HEAD_CELL}>المصدر</div>
                    {canEdit && <div />}
                  </div>
                  {current.rows.map(r => (
                    <SheetRow key={r.id} r={r} cols={cols} template={template} sheetRep={current.all ? null : current.rep} canEdit={canEdit}
                      states={rowStates.get(r.id)} editCol={r.id === editId ? editCol : null}
                      editOptions={r.id === editId && editCol ? optionsFor(editCol) : undefined}
                      open={compareOpen.has(r.id)} currency={currency} act={act} />
                  ))}
                  <div role="row" style={{ display: 'grid', gridTemplateColumns: template, background: '#f8fafc', borderTop: ROW_SEP }}>
                    <div style={{ ...TOTAL_CELL, gridColumn: `span ${cols.findIndex(c => c.key === 'quantity')}` }}>المجموع — {fmt(current.orders)} طلبية</div>
                    <div style={TOTAL_CELL}>{fmt(current.quantity)}</div>
                    <div style={{ gridColumn: 'span 2' }} />
                    <div style={TOTAL_CELL}>{fmt(current.total)}</div>
                    <div style={{ gridColumn: `span ${canEdit ? 2 : 1}` }} />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
