// ════════════════════════════════════════════════════════════════════════════
// RepSalesPage — «مبيعات المندوبين».
// المندوب يسجّل مبيعه اليومي (الصيدلية، المنطقة، الايتمات والأعداد، صورة الفاتورة
// اختيارية): مؤكد مباشرةً، أو طلبية غير مؤكدة حتى يؤكدها بالأرقام نفسها أو بالفاتورة.
// المدير يرى ما سجّله فريقه ومجموع كل مندوب وكل ايتم.
// • المصدر: /api/rep-sales (server/modules/rep-sales) — سجلّ مستقل لا يدخل التقارير.
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Check, RotateCcw, Pencil, X, Ban, ChevronDown, Camera, Search, ReceiptText } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ItemPicker, itemCompany, normSearch, type CatalogItem } from '../components/OrderItemPicker';
import { compressImage } from '../lib/localImage';
import './RepOrdersPage.css';
import './RepSalesPage.css';

const API = import.meta.env.VITE_API_URL || '';

type Status = 'pending' | 'confirmed' | 'cancelled';
interface SaleLine { id: number; itemId: number | null; itemName: string; companyName: string | null; quantity: number; bonusQty: number; unitPrice: number | null }
interface Sale {
  id: number; saleDate: string; createdById: number; repName: string;
  pharmacyName: string; areaName: string | null; warehouseName: string | null;
  invoiceNumber: string | null; notes: string | null; status: Status; invoiceImage: string | null;
  confirmedAt: string | null; confirmedBy: string | null; createdAt: string; lines: SaleLine[]; canEdit: boolean;
}
interface ListResponse { sales: Sale[]; reps: { id: number; name: string }[]; truncated: boolean; viewer: { id: number; isManager: boolean } }
type Api = <T = any>(path: string, init?: RequestInit) => Promise<T>;

type Period = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth' | 'all' | 'custom';
type StatusView = 'all' | Status;
type Tab = 'list' | 'reps' | 'items';

const PERIOD_LABEL: Record<Period, string> = { today: 'اليوم', yesterday: 'أمس', week: 'آخر 7 أيام', month: 'هذا الشهر', lastMonth: 'الشهر السابق', all: 'كل التواريخ', custom: 'تاريخ محدد' };
const STATUS_LABEL: Record<Status, string> = { confirmed: 'مؤكد', pending: 'غير مؤكد', cancelled: 'لم تتم' };

const dayStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => dayStr(new Date());
const shiftDay = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return dayStr(d); };
const fmtDay = (iso: string) => String(iso).slice(0, 10);
const fmtMoney = (n: number) => Math.round(n).toLocaleString('en-US');
const dayTitle = (day: string) => (day === today() ? `اليوم ${day}` : day === shiftDay(-1) ? `أمس ${day}` : day);

function periodRange(p: Period): [string, string] {
  const now = new Date();
  switch (p) {
    case 'today': return [today(), today()];
    case 'yesterday': return [shiftDay(-1), shiftDay(-1)];
    case 'week': return [shiftDay(-6), today()];
    case 'month': return [dayStr(new Date(now.getFullYear(), now.getMonth(), 1)), today()];
    case 'lastMonth': return [dayStr(new Date(now.getFullYear(), now.getMonth() - 1, 1)), dayStr(new Date(now.getFullYear(), now.getMonth(), 0))];
    default: return ['', ''];
  }
}

const lineValue = (l: SaleLine) => l.quantity * (l.unitPrice ?? 0);
const saleValue = (s: Sale) => s.lines.reduce((sum, l) => sum + lineValue(l), 0);
const saleQty = (s: Sale) => s.lines.reduce((sum, l) => sum + l.quantity, 0);
const lineSummary = (s: Sale) => s.lines.map(l => `${l.itemName} ×${l.quantity}${l.bonusQty ? ` +${l.bonusQty}` : ''}`).join('، ');
const searchTextOf = (s: Sale) => normSearch([
  s.pharmacyName, s.areaName, s.repName, s.warehouseName, s.invoiceNumber, s.notes,
  ...s.lines.flatMap(l => [l.itemName, l.companyName]),
].filter(Boolean).join(' '));

// المجموع: «لم تتم» خارج كل الحسابات، والمؤكد وغير المؤكد لا يُجمعان في رقم واحد
interface Tally { count: number; qty: number; value: number }
const emptyTally = (): Tally => ({ count: 0, qty: 0, value: 0 });
function addTo(t: Tally, s: Sale) { t.count += 1; t.qty += saleQty(s); t.value += saleValue(s); }

interface RepRow { id: number; name: string; confirmed: Tally; pending: Tally; noInvoice: number }
interface ItemRow { key: string; name: string; company: string | null; qty: number; bonus: number; value: number; pendingQty: number; pendingValue: number }

function useObjectUrl(file: Blob | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

export default function RepSalesPage() {
  const { token } = useAuth();
  const api = useCallback<Api>(async (path, init = {}) => {
    const isForm = init.body instanceof FormData;
    const res = await fetch(`${API}/api/rep-sales${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store',
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* بلا JSON */ }
    if (!res.ok || body?.success === false) throw new Error(body?.message || body?.error || `فشل الطلب (${res.status})`);
    return body;
  }, [token]);

  const [period, setPeriod] = useState<Period>('month');
  const [customFrom, setCustomFrom] = useState(today());
  const [customTo, setCustomTo] = useState(today());
  const [repFilter, setRepFilter] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<StatusView>('all');
  const [tab, setTab] = useState<Tab | null>(null); // null = الافتراضي حسب الدور بعد أول تحميل

  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Sale | 'new' | null>(null);
  const [confirming, setConfirming] = useState<Sale | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const [from, to] = period === 'custom' ? [customFrom, customTo] : periodRange(period);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setErr(null);
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    try {
      setData(await api<ListResponse>(`?${q}`));
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [token, api, from, to]);
  useEffect(() => { load(); }, [load]);

  const isManager = !!data?.viewer.isManager;
  const activeTab: Tab = tab ?? (isManager ? 'reps' : 'list');

  // زر الرجوع يغلق أعلى طبقة مفتوحة بدل مغادرة الصفحة (نفس عقد طلبيات المذاخر)
  useEffect(() => {
    const onBack = (e: Event) => {
      const ce = e as CustomEvent<{ activePage?: string }>;
      if (ce.detail?.activePage !== 'rep-sales' || ce.defaultPrevented) return;
      if (preview)         { ce.preventDefault(); setPreview(null); return; }
      if (confirming)      { ce.preventDefault(); setConfirming(null); return; }
      if (editing)         { ce.preventDefault(); setEditing(null); return; }
      if (openId != null)  { ce.preventDefault(); setOpenId(null); }
    };
    window.addEventListener('before-navigate-back', onBack);
    return () => window.removeEventListener('before-navigate-back', onBack);
  }, [preview, confirming, editing, openId]);

  // فلتر المندوب والبحث يحددان كل الأرقام؛ شرائح الحالة تفلتر القائمة فقط لأنها العدّاد نفسه
  const filtered = useMemo(() => {
    const terms = normSearch(query).split(/\s+/).filter(Boolean);
    return (data?.sales ?? []).filter(s =>
      (!repFilter || String(s.createdById) === repFilter) &&
      (!terms.length || terms.every(t => searchTextOf(s).includes(t))));
  }, [data, repFilter, query]);

  const totals = useMemo(() => {
    const confirmed = emptyTally(); const pending = emptyTally();
    let cancelled = 0; let noInvoice = 0;
    for (const s of filtered) {
      if (s.status === 'cancelled') { cancelled += 1; continue; }
      addTo(s.status === 'confirmed' ? confirmed : pending, s);
      if (s.status === 'confirmed' && !s.invoiceImage) noInvoice += 1;
    }
    return { confirmed, pending, cancelled, noInvoice };
  }, [filtered]);

  const visible = useMemo(() => filtered.filter(s => view === 'all' || s.status === view), [filtered, view]);

  const days = useMemo(() => {
    const map = new Map<string, Sale[]>();
    for (const s of visible) {
      const d = fmtDay(s.saleDate);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(s);
    }
    return [...map];
  }, [visible]);

  const repRows = useMemo<RepRow[]>(() => {
    const rows = new Map<number, RepRow>();
    const row = (id: number, name: string) => {
      if (!rows.has(id)) rows.set(id, { id, name, confirmed: emptyTally(), pending: emptyTally(), noInvoice: 0 });
      return rows.get(id)!;
    };
    // بلا بحث يظهر الفريق كله، فيُرى من لم يسجّل شيئاً بعد
    if (!query.trim()) for (const r of data?.reps ?? []) if (!repFilter || String(r.id) === repFilter) row(r.id, r.name);
    for (const s of filtered) {
      if (s.status === 'cancelled') continue;
      const r = row(s.createdById, s.repName);
      addTo(s.status === 'confirmed' ? r.confirmed : r.pending, s);
      if (s.status === 'confirmed' && !s.invoiceImage) r.noInvoice += 1;
    }
    return [...rows.values()].sort((a, b) => b.confirmed.value - a.confirmed.value || b.pending.value - a.pending.value || a.name.localeCompare(b.name, 'ar'));
  }, [data, filtered, query, repFilter]);

  const itemRows = useMemo<ItemRow[]>(() => {
    const rows = new Map<string, ItemRow>();
    for (const s of filtered) {
      if (s.status === 'cancelled') continue;
      for (const l of s.lines) {
        const key = l.itemId ? `i${l.itemId}` : `n${normSearch(l.itemName)}`;
        if (!rows.has(key)) rows.set(key, { key, name: l.itemName, company: l.companyName, qty: 0, bonus: 0, value: 0, pendingQty: 0, pendingValue: 0 });
        const r = rows.get(key)!;
        if (s.status === 'confirmed') { r.qty += l.quantity; r.bonus += l.bonusQty; r.value += lineValue(l); } else { r.pendingQty += l.quantity; r.pendingValue += lineValue(l); }
      }
    }
    return [...rows.values()].sort((a, b) => b.value - a.value || b.qty - a.qty || b.pendingQty - a.pendingQty);
  }, [filtered]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); await load(); } catch (e: any) { setErr(e.message); }
  };
  const setStatus = (s: Sale, status: Status) => act(() => api(`/${s.id}/status`, { method: 'POST', body: JSON.stringify({ status }) }));
  const remove = (s: Sale) => { if (window.confirm(`حذف مبيع «${s.pharmacyName}»؟`)) act(() => api(`/${s.id}`, { method: 'DELETE' })); };
  const removeImage = (s: Sale) => { if (window.confirm('حذف صورة الفاتورة؟')) act(() => api(`/${s.id}/image`, { method: 'DELETE' })); };
  const attachImage = (s: Sale, file: File) => act(async () => {
    const fd = new FormData();
    fd.append('image', await compressImage(file), 'invoice.jpg');
    await api(`/${s.id}/image`, { method: 'POST', body: fd });
  });
  const openRep = (id: number) => { setRepFilter(String(id)); setTab('list'); setView('all'); };

  return (
    <div className="rs-page">
      <div className="ro-bar">
        <button className="btn btn--primary btn--sm" onClick={() => setEditing('new')}><Plus size={15} /> تسجيل مبيع</button>
        <select className="form-input ro-select" aria-label="الفترة" value={period} onChange={e => setPeriod(e.target.value as Period)}>
          {(Object.keys(PERIOD_LABEL) as Period[]).map(p => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
        </select>
        {period === 'custom' && (
          <span className="ro-dates">
            <input className="form-input" type="date" aria-label="من" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
            <input className="form-input" type="date" aria-label="إلى" value={customTo} onChange={e => setCustomTo(e.target.value)} />
          </span>
        )}
        {isManager && (
          <select className="form-input ro-select" aria-label="المندوب" value={repFilter} onChange={e => setRepFilter(e.target.value)}>
            <option value="">كل المندوبين</option>
            {data?.reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <span className="rs-search">
          <Search size={14} />
          <input className="form-input" type="search" placeholder="صيدلية، منطقة، ايتم…" aria-label="بحث" value={query} onChange={e => setQuery(e.target.value)} />
        </span>
      </div>

      {err && <div className="ro-note ro-note--warn">⚠️ {err}</div>}
      {data?.truncated && <div className="ro-note ro-note--warn">⚠️ النتائج أكثر من الحد المعروض والمجاميع ناقصة — اختر فترة أقصر.</div>}

      <div className="rs-tiles">
        <div className="rs-tile rs-tile--confirmed">
          <span className="rs-tile__label">مؤكد</span>
          <strong className="rs-tile__value">{fmtMoney(totals.confirmed.value)}</strong>
          <span className="rs-tile__sub">{totals.confirmed.count} مبيع · {totals.confirmed.qty} قطعة</span>
        </div>
        <div className="rs-tile rs-tile--pending">
          <span className="rs-tile__label">غير مؤكد</span>
          <strong className="rs-tile__value">{fmtMoney(totals.pending.value)}</strong>
          <span className="rs-tile__sub">{totals.pending.count} طلبية · {totals.pending.qty} قطعة</span>
        </div>
        <div className="rs-tile">
          <span className="rs-tile__label">مؤكد بلا فاتورة</span>
          <strong className="rs-tile__value">{totals.noInvoice}</strong>
          <span className="rs-tile__sub">بانتظار صورة الفاتورة</span>
        </div>
      </div>

      <div className="rs-tabs" role="tablist">
        <button role="tab" aria-selected={activeTab === 'list'} className={activeTab === 'list' ? 'is-active' : ''} onClick={() => setTab('list')}>المبيعات</button>
        {isManager && <button role="tab" aria-selected={activeTab === 'reps'} className={activeTab === 'reps' ? 'is-active' : ''} onClick={() => setTab('reps')}>حسب المندوب</button>}
        <button role="tab" aria-selected={activeTab === 'items'} className={activeTab === 'items' ? 'is-active' : ''} onClick={() => setTab('items')}>حسب الايتم</button>
      </div>

      {activeTab === 'reps' && (
        <div className="rs-table-wrap">
          <table className="rs-table">
            <thead><tr><th>المندوب</th><th>مؤكد</th><th>غير مؤكد</th><th className="rs-num">بلا فاتورة</th></tr></thead>
            <tbody>
              {repRows.map(r => (
                <tr key={r.id} className="rs-click" onClick={() => openRep(r.id)}>
                  <td className="ro-strong">{r.name}</td>
                  <td><b className="rs-ok">{fmtMoney(r.confirmed.value)}</b><div className="rs-cell-sub">{r.confirmed.count} مبيع · {r.confirmed.qty} قطعة</div></td>
                  <td><b className="rs-wait">{fmtMoney(r.pending.value)}</b><div className="rs-cell-sub">{r.pending.count} طلبية · {r.pending.qty} قطعة</div></td>
                  <td className="rs-num">{r.noInvoice || '—'}</td>
                </tr>
              ))}
              {!repRows.length && <tr><td colSpan={4} className="rs-empty-cell">{loading ? 'جارٍ التحميل…' : 'لا يوجد مندوبون في هذا النطاق.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'items' && (
        <div className="rs-table-wrap">
          <table className="rs-table">
            <thead><tr><th>الايتم</th><th className="rs-num">مؤكد</th><th className="rs-num">بونص</th><th className="rs-num">القيمة</th><th className="rs-num">غير مؤكد</th></tr></thead>
            <tbody>
              {itemRows.map(r => (
                <tr key={r.key}>
                  <td><span className="ro-strong">{r.name}</span>{r.company && <div className="rs-cell-sub">{r.company}</div>}</td>
                  <td className="rs-num"><b className="rs-ok">{r.qty}</b></td>
                  <td className="rs-num">{r.bonus || '—'}</td>
                  <td className="rs-num">{fmtMoney(r.value)}</td>
                  <td className="rs-num rs-wait">{r.pendingQty || '—'}</td>
                </tr>
              ))}
              {!itemRows.length && <tr><td colSpan={5} className="rs-empty-cell">{loading ? 'جارٍ التحميل…' : 'لا مبيعات في هذه الفترة.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'list' && (
        <>
          <div className="ro-chips">
            <button className={`ro-chip ${view === 'all' ? 'is-active' : ''}`} onClick={() => setView('all')}>الكل <b>{filtered.length}</b></button>
            <button className={`ro-chip ${view === 'confirmed' ? 'is-active' : ''}`} onClick={() => setView('confirmed')}>مؤكد <b>{totals.confirmed.count}</b></button>
            <button className={`ro-chip ${view === 'pending' ? 'is-active' : ''}`} onClick={() => setView('pending')}>غير مؤكد <b>{totals.pending.count}</b></button>
            <button className={`ro-chip ${view === 'cancelled' ? 'is-active' : ''}`} onClick={() => setView('cancelled')}>لم تتم <b>{totals.cancelled}</b></button>
          </div>

          {days.map(([day, list]) => (
            <section key={day} className="rs-day">
              <h3 className="rs-day__title">
                <span>{dayTitle(day)}</span>
                <span className="rs-cell-sub">{list.length} · مؤكد {fmtMoney(list.filter(s => s.status === 'confirmed').reduce((sum, s) => sum + saleValue(s), 0))}</span>
              </h3>
              {list.map(s => (
                <SaleCard
                  key={s.id} sale={s} open={openId === s.id} showRep={isManager}
                  onToggle={() => setOpenId(id => (id === s.id ? null : s.id))}
                  onConfirm={() => setConfirming(s)} onEdit={() => setEditing(s)} onDelete={() => remove(s)}
                  onStatus={st => setStatus(s, st)} onAttach={f => attachImage(s, f)}
                  onRemoveImage={() => removeImage(s)} onPreview={setPreview}
                />
              ))}
            </section>
          ))}
          {!days.length && (
            <div className="ro-empty">
              <ReceiptText size={28} className="ro-muted" />
              <div className="ro-empty__title">{loading ? 'جارٍ التحميل…' : 'لا مبيعات هنا'}</div>
              {!loading && <button className="btn btn--primary btn--sm" onClick={() => setEditing('new')}><Plus size={15} /> تسجيل مبيع</button>}
            </div>
          )}
        </>
      )}

      {editing && <SaleForm api={api} token={token} sale={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {confirming && <ConfirmDialog api={api} sale={confirming} onClose={() => setConfirming(null)} onDone={() => { setConfirming(null); load(); }} />}
      {preview && (
        <div className="ro-modal" onClick={() => setPreview(null)}>
          <img className="ro-preview" src={`${API}${preview}`} alt="صورة الفاتورة" />
        </div>
      )}
    </div>
  );
}

// ─── بطاقة المبيع ─────────────────────────────────────────────────────────────

function SaleCard({ sale: s, open, showRep, onToggle, onConfirm, onEdit, onDelete, onStatus, onAttach, onRemoveImage, onPreview }: {
  sale: Sale; open: boolean; showRep: boolean;
  onToggle: () => void; onConfirm: () => void; onEdit: () => void; onDelete: () => void;
  onStatus: (st: Status) => void; onAttach: (f: File) => void; onRemoveImage: () => void; onPreview: (src: string) => void;
}) {
  const value = saleValue(s);
  const canAttach = s.status === 'confirmed' && (!s.invoiceImage || s.canEdit);
  return (
    <article className={`rs-card rs-card--${s.status}`}>
      <div className="rs-card__head">
        <button type="button" className="rs-card__summary" aria-expanded={open} onClick={onToggle}>
          <span className="rs-card__title">
            <span className="ro-strong">{s.pharmacyName}</span>
            {s.areaName && <span className="ro-muted"> — {s.areaName}</span>}
          </span>
          <span className="rs-card__items">{lineSummary(s)}</span>
          <span className="rs-card__meta">
            <span className={`rs-badge rs-badge--${s.status}`}>{STATUS_LABEL[s.status]}</span>
            {s.status === 'confirmed' && !s.invoiceImage && <span className="rs-badge">بلا فاتورة</span>}
            {showRep && <span>{s.repName}</span>}
            <b className="rs-card__value">{fmtMoney(value)}</b>
            <ChevronDown size={14} className={`rs-chevron ${open ? 'is-open' : ''}`} />
          </span>
        </button>
        {s.status === 'pending' && s.canEdit && (
          <button className="btn btn--primary btn--sm rs-card__confirm" onClick={onConfirm}><Check size={14} /> تأكيد</button>
        )}
      </div>

      {open && (
        <div className="rs-card__body">
          <div className="rs-table-wrap">
            <table className="rs-table">
              <thead><tr><th>الايتم</th><th className="rs-num">الكمية</th><th className="rs-num">بونص</th><th className="rs-num">القيمة</th></tr></thead>
              <tbody>
                {s.lines.map(l => (
                  <tr key={l.id}>
                    <td><span className="ro-strong">{l.itemName}</span>{l.companyName && <div className="rs-cell-sub">{l.companyName}</div>}</td>
                    <td className="rs-num">{l.quantity}</td>
                    <td className="rs-num">{l.bonusQty || '—'}</td>
                    <td className="rs-num">{l.unitPrice == null ? '—' : fmtMoney(lineValue(l))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="ro-info">
            {s.warehouseName && <><dt>المذخر</dt><dd>{s.warehouseName}</dd></>}
            {s.invoiceNumber && <><dt>رقم الفاتورة</dt><dd>{s.invoiceNumber}</dd></>}
            {s.notes && <><dt>ملاحظات</dt><dd>{s.notes}</dd></>}
            <dt>سجّله</dt><dd>{s.repName}</dd>
            {s.confirmedAt && <><dt>التأكيد</dt><dd>{fmtDay(s.confirmedAt)}{s.confirmedBy ? ` — ${s.confirmedBy}` : ''}{s.invoiceImage ? ' (بالفاتورة)' : ' (بالأرقام)'}</dd></>}
          </dl>

          {s.invoiceImage && (
            <div className="rs-thumb">
              <img src={`${API}${s.invoiceImage}`} alt="صورة الفاتورة" onClick={() => onPreview(s.invoiceImage!)} />
              {s.canEdit && <button className="ro-link" onClick={onRemoveImage}><X size={13} /> حذف الصورة</button>}
            </div>
          )}

          <div className="rs-card__actions">
            {canAttach && (
              <label className="btn btn--secondary btn--sm">
                <Camera size={14} /> {s.invoiceImage ? 'استبدال الفاتورة' : 'إرفاق الفاتورة'}
                <input type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onAttach(f); }} />
              </label>
            )}
            {s.canEdit && s.status !== 'cancelled' && <button className="btn btn--secondary btn--sm" onClick={onEdit}><Pencil size={14} /> تعديل</button>}
            {s.canEdit && s.status === 'pending' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('cancelled')}><Ban size={14} /> لم تتم</button>}
            {s.canEdit && s.status !== 'pending' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('pending')}><RotateCcw size={14} /> إرجاعها غير مؤكدة</button>}
            {s.canEdit && <button className="btn btn--secondary btn--sm rs-danger" onClick={onDelete}><Trash2 size={14} /> حذف</button>}
            {!s.canEdit && <span className="rs-cell-sub">مؤكد — التعديل عليه من صلاحية المدير.</span>}
          </div>
        </div>
      )}
    </article>
  );
}

// ─── تأكيد طلبية معلّقة ───────────────────────────────────────────────────────

function ConfirmDialog({ api, sale, onClose, onDone }: { api: Api; sale: Sale; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState(() => sale.lines.map(l => ({ id: l.id, itemName: l.itemName, quantity: String(l.quantity), bonusQty: l.bonusQty ? String(l.bonusQty) : '' })));
  const [file, setFile] = useState<File | null>(null);
  const url = useObjectUrl(file);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const changed = rows.some((r, i) => Number(r.quantity) !== sale.lines[i].quantity || (Number(r.bonusQty) || 0) !== sale.lines[i].bonusQty);
  const label = file ? 'تأكيد بالفاتورة' : changed ? 'تأكيد بالأرقام المعدّلة' : 'تأكيد بالأرقام نفسها';
  const setRow = (id: number, patch: Partial<(typeof rows)[number]>) => setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));

  const submit = async () => {
    setSaving(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append('lines', JSON.stringify(rows.map(r => ({ id: r.id, quantity: Number(r.quantity) || 0, bonusQty: Number(r.bonusQty) || 0 }))));
      if (file) fd.append('image', await compressImage(file), 'invoice.jpg');
      await api(`/${sale.id}/confirm`, { method: 'POST', body: fd });
      onDone();
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  return (
    <div className="ro-modal" onClick={onClose}>
      <div className="ro-dialog ro-dialog--narrow" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head">
          <strong>تأكيد مبيع «{sale.pharmacyName}»</strong>
          <button className="ro-icon-btn" aria-label="إغلاق" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ro-dialog__body">
          <div className="rs-confirm-lines">
            <div className="rs-confirm-line rs-confirm-line--head"><span>الايتم</span><span>الكمية</span><span>بونص</span></div>
            {rows.map(r => (
              <div key={r.id} className="rs-confirm-line">
                <span className="ro-strong">{r.itemName}</span>
                <input className="form-input" type="number" min={0} inputMode="numeric" aria-label={`كمية ${r.itemName}`} value={r.quantity} onChange={e => setRow(r.id, { quantity: e.target.value })} />
                <input className="form-input" type="number" min={0} inputMode="numeric" aria-label={`بونص ${r.itemName}`} value={r.bonusQty} onChange={e => setRow(r.id, { bonusQty: e.target.value })} />
              </div>
            ))}
          </div>
          <div className="rs-hint">إن اختلف ما تجهّز عدّل الأرقام. الايتم الذي لم يتجهز اجعل كميته 0 فيُحذف من المبيع.</div>
          <InvoiceInput file={file} url={url} onChange={setFile} />
          {err && <div className="ro-note ro-note--warn">⚠️ {err}</div>}
        </div>
        <div className="ro-dialog__foot">
          <button className="btn btn--primary" disabled={saving} onClick={submit}>{saving ? 'جارٍ الحفظ…' : label}</button>
          <button className="btn btn--secondary" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

function InvoiceInput({ file, url, onChange }: { file: File | null; url: string | null; onChange: (f: File | null) => void }) {
  return (
    <div className="rs-invoice">
      <label className="btn btn--secondary btn--sm">
        <Camera size={14} /> {file ? 'تغيير صورة الفاتورة' : 'إرفاق صورة الفاتورة'}
        <input type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onChange(f); }} />
      </label>
      {url && (
        <span className="rs-invoice__preview">
          <img src={url} alt="معاينة الفاتورة" />
          <button type="button" className="ro-link" onClick={() => onChange(null)}><X size={13} /> إزالة</button>
        </span>
      )}
    </div>
  );
}

// ─── نموذج تسجيل مبيع ─────────────────────────────────────────────────────────

interface FormLine { key: number; text: string; itemId: number | null; companyName: string; quantity: string; bonusQty: string }
const newLine = (text = '', itemId: number | null = null, companyName = ''): FormLine => ({ key: Date.now() + Math.random(), text, itemId, companyName, quantity: '', bonusQty: '' });

function SaleForm({ api, token, sale, onClose, onSaved }: { api: Api; token: string | null; sale: Sale | null; onClose: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [pharmacies, setPharmacies] = useState<{ name: string; areaName: string | null }[]>([]);
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [head, setHead] = useState({
    saleDate: sale ? fmtDay(sale.saleDate) : today(),
    pharmacyName: sale?.pharmacyName ?? '',
    areaName: sale?.areaName ?? '',
    warehouseName: sale?.warehouseName ?? '',
    invoiceNumber: sale?.invoiceNumber ?? '',
    notes: sale?.notes ?? '',
  });
  const [lines, setLines] = useState<FormLine[]>(() => (sale?.lines ?? []).map(l => ({ key: Math.random(), text: l.itemName, itemId: l.itemId, companyName: l.companyName ?? '', quantity: String(l.quantity), bonusQty: l.bonusQty ? String(l.bonusQty) : '' })));
  // الافتراضي «غير مؤكد»: ما لم يختر المندوب التأكيد صراحةً لا يدخل مجموع المؤكد
  const [status, setStatus] = useState<'pending' | 'confirmed'>('pending');
  const [file, setFile] = useState<File | null>(null);
  const url = useObjectUrl(file);
  const [pickItems, setPickItems] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const notesRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    fetch(`${API}/api/items`, { headers: h, cache: 'no-store' }).then(r => r.json()).then(j => setItems(Array.isArray(j?.data) ? j.data : [])).catch(() => {});
    fetch(`${API}/api/areas`, { headers: h }).then(r => r.json()).then(j => setAreas((j?.data ?? []).map((a: any) => a.name).filter(Boolean))).catch(() => {});
    const own = api<{ pharmacies: { name: string; areaName: string | null }[]; warehouses: string[] }>('/suggestions');
    own.then(r => setPharmacies(r.pharmacies)).catch(() => {});
    const directory = fetch(`${API}/api/rep-orders/warehouses`, { headers: h }).then(r => r.json()).then(j => (j?.warehouses ?? []).map((w: any) => w.name as string)).catch(() => [] as string[]);
    Promise.all([own.catch(() => ({ warehouses: [] as string[] })), directory]).then(([o, d]) => setWarehouses([...new Set([...o.warehouses, ...d])]));
  }, [token, api]);

  const setLine = (key: number, patch: Partial<FormLine>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const pickedIds = useMemo(() => new Set(lines.map(l => l.itemId).filter((x): x is number => x != null)), [lines]);
  const addItems = (picked: CatalogItem[], freeText: string | null) => {
    setLines(ls => [
      ...ls,
      ...picked.filter(i => !pickedIds.has(i.id)).map(i => newLine(i.name, i.id, itemCompany(i) ?? '')),
      ...(freeText ? [newLine(freeText)] : []),
    ]);
    setPickItems(false);
  };
  const onPharmacy = (name: string) => {
    const known = pharmacies.find(p => p.name === name);
    setHead(h => ({ ...h, pharmacyName: name, areaName: known?.areaName && !h.areaName ? known.areaName : h.areaName }));
  };
  // Enter و«التالي» بكيبورد الهاتف ينقلان للخانة التالية
  const onLinesKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLInputElement;
    if (el.tagName !== 'INPUT' || e.key !== 'Enter') return;
    e.preventDefault();
    const fields = Array.from(e.currentTarget.querySelectorAll<HTMLInputElement>('input'));
    const target = fields[fields.indexOf(el) + 1] ?? notesRef.current;
    target?.focus();
    target?.select();
  };
  const pickFile = (f: File | null) => { setFile(f); if (f) setStatus('confirmed'); };

  const submit = async () => {
    setErr(null);
    const valid = lines.filter(l => l.text.trim() && Number(l.quantity) > 0);
    if (!head.pharmacyName.trim()) return setErr('اسم الصيدلية مطلوب');
    if (!head.areaName.trim()) return setErr('المنطقة مطلوبة');
    if (!valid.length) return setErr('أضف ايتماً واحداً على الأقل مع كميته');
    setSaving(true);
    try {
      const data = {
        ...head,
        status,
        lines: valid.map(l => ({ itemId: l.itemId, itemName: l.text.trim(), companyName: l.companyName || null, quantity: Number(l.quantity), bonusQty: Number(l.bonusQty) || 0 })),
      };
      if (sale) {
        await api(`/${sale.id}`, { method: 'PUT', body: JSON.stringify(data) });
      } else {
        const fd = new FormData();
        fd.append('data', JSON.stringify(data));
        if (file) fd.append('image', await compressImage(file), 'invoice.jpg');
        await api('', { method: 'POST', body: fd });
      }
      onSaved();
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  return (
    <div className="ro-modal" onClick={onClose}>
      <div className="ro-dialog" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head">
          <strong>{sale ? 'تعديل المبيع' : 'تسجيل مبيع'}</strong>
          <button className="ro-icon-btn" aria-label="إغلاق" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ro-dialog__body">
          {!sale && (
            <div className="rs-kind" role="radiogroup" aria-label="حالة المبيع">
              <button type="button" role="radio" aria-checked={status === 'pending'} disabled={!!file} className={status === 'pending' ? 'is-active is-pending' : ''} onClick={() => setStatus('pending')}>
                <b>طلبية غير مؤكدة</b><span>كتبتها وبعد لم أتأكد من تجهيزها</span>
              </button>
              <button type="button" role="radio" aria-checked={status === 'confirmed'} className={status === 'confirmed' ? 'is-active is-confirmed' : ''} onClick={() => setStatus('confirmed')}>
                <b>مبيع مؤكد</b><span>تم البيع وتجهّز فعلاً</span>
              </button>
            </div>
          )}

          <div className="ro-form-grid">
            <label className="ro-field">التاريخ
              <input className="form-input" type="date" value={head.saleDate} onChange={e => setHead(h => ({ ...h, saleDate: e.target.value }))} />
            </label>
            <label className="ro-field">الصيدلية *
              <input className="form-input" list="rs-pharmacies" value={head.pharmacyName} onChange={e => onPharmacy(e.target.value)} />
              <datalist id="rs-pharmacies">{pharmacies.map(p => <option key={p.name} value={p.name} />)}</datalist>
            </label>
            <label className="ro-field">المنطقة *
              <input className="form-input" list="rs-areas" value={head.areaName} onChange={e => setHead(h => ({ ...h, areaName: e.target.value }))} />
              <datalist id="rs-areas">{areas.map(a => <option key={a} value={a} />)}</datalist>
            </label>
            <label className="ro-field">المذخر
              <input className="form-input" list="rs-warehouses" value={head.warehouseName} onChange={e => setHead(h => ({ ...h, warehouseName: e.target.value }))} />
              <datalist id="rs-warehouses">{warehouses.map(w => <option key={w} value={w} />)}</datalist>
            </label>
            <label className="ro-field">رقم الفاتورة
              <input className="form-input" value={head.invoiceNumber} onChange={e => setHead(h => ({ ...h, invoiceNumber: e.target.value }))} />
            </label>
          </div>

          <div className="ro-form-lines" onKeyDown={onLinesKey}>
            {lines.length > 0 && <div className="ro-form-line ro-form-line--head"><span>الايتم</span><span>الشركة</span><span>الكمية</span><span>بونص</span><span /></div>}
            {lines.map(l => (
              <div key={l.key} className="ro-form-line">
                <div className="ro-line-item"><span className="ro-strong">{l.text}</span>{l.itemId && l.companyName && <span className="ro-show-sm ro-muted ro-small"> — {l.companyName}</span>}</div>
                {l.itemId
                  ? <div className="ro-line-co ro-muted">{l.companyName || '—'}</div>
                  : <input className="form-input" enterKeyHint="next" placeholder="الشركة" value={l.companyName} onChange={e => setLine(l.key, { companyName: e.target.value })} />}
                <input className="form-input" type="number" min={1} inputMode="numeric" enterKeyHint="next" placeholder="الكمية" aria-label={`كمية ${l.text}`} value={l.quantity} onChange={e => setLine(l.key, { quantity: e.target.value })} />
                <input className="form-input" type="number" min={0} inputMode="numeric" enterKeyHint="next" placeholder="بونص" aria-label={`بونص ${l.text}`} value={l.bonusQty} onChange={e => setLine(l.key, { bonusQty: e.target.value })} />
                <button className="ro-icon-btn" tabIndex={-1} title="حذف السطر" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}><Trash2 size={14} /></button>
              </div>
            ))}
            <button className="btn btn--secondary btn--sm ro-self-start" onClick={() => setPickItems(true)}><Plus size={14} /> {lines.length ? 'ايتمات أخرى' : 'اختيار الايتمات'}</button>
          </div>
          {pickItems && <ItemPicker items={items} have={pickedIds} onAdd={addItems} onClose={() => setPickItems(false)} />}

          <label className="ro-field">ملاحظات
            <input ref={notesRef} className="form-input" value={head.notes} onChange={e => setHead(h => ({ ...h, notes: e.target.value }))} />
          </label>
          {!sale && <InvoiceInput file={file} url={url} onChange={pickFile} />}
          {!sale && file && <div className="rs-hint">مع صورة الفاتورة يُحفظ المبيع مؤكداً.</div>}

          {err && <div className="ro-note ro-note--warn">⚠️ {err}</div>}
        </div>
        <div className="ro-dialog__foot">
          <button className="btn btn--primary" disabled={saving} onClick={submit}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
          <button className="btn btn--secondary" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}
