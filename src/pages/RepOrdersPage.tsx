// ════════════════════════════════════════════════════════════════════════════
// RepOrdersPage — «طلبيات المذاخر».
// المندوب يكتب طلبيات اليوم (الصيدلية، المنطقة، المذخر، الأصناف والكميات، صورة
// فاتورة اختيارية) ويرسل الطلبية لرقم واتساب المذخر بضغطة (wa.me — يفتح محادثة
// المذخر والنص جاهز، والمندوب يضغط إرسال). المدير يرى طلبيات فريقه.
// • المصدر: /api/rep-orders (server/modules/rep-orders) — لا يدخل أي حسبة مبيعات.
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Send, Check, RotateCcw, Image as ImageIcon, Pencil, X, Warehouse, Ban } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './RepOrdersPage.css';

const API = import.meta.env.VITE_API_URL || '';

type Status = 'pending' | 'prepared' | 'cancelled';

interface OrderLine { id?: number; itemId: number | null; itemName: string; companyName: string | null; quantity: number; bonusQty: number }
interface Order {
  id: number; orderDate: string; createdById: number; repName: string;
  warehouseId: number | null; warehouseName: string; warehousePhone: string | null;
  pharmacyName: string; areaName: string | null; notes: string | null;
  status: Status; invoiceImage: string | null; sentAt: string | null; sentCount: number;
  preparedAt: string | null; preparedBy: string | null; lines: OrderLine[]; canEdit: boolean;
}
interface WarehouseRow { id: number; name: string; phone: string; notes: string | null; canEdit: boolean }
interface CatalogItem { id: number; name: string; company?: { name: string } | null; scientificCompany?: { name: string } | null }

const STATUS_LABEL: Record<Status, string> = { pending: 'بانتظار التجهيز', prepared: 'تم التجهيز', cancelled: 'ملغاة' };

// نفس تطبيع رقم wa.me المستعمل في ReportsPage: 07… ← 9647…، و00 تُحذف.
const toWaNumber = (raw?: string | null): string => {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('964')) return d;
  if (d.startsWith('0')) return '964' + d.slice(1);
  if (d.length <= 10) return '964' + d;
  return d;
};

const dayStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => dayStr(new Date());
const shiftDay = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return dayStr(d); };
const monthStart = () => { const d = new Date(); return dayStr(new Date(d.getFullYear(), d.getMonth(), 1)); };
const fmtDay = (iso: string) => String(iso).slice(0, 10);
const itemCompany = (i: CatalogItem) => i.scientificCompany?.name ?? i.company?.name ?? null;
const itemLabel = (i: CatalogItem) => (itemCompany(i) ? `${i.name} — ${itemCompany(i)}` : i.name);

function orderText(o: Order, withHeader = true): string {
  const out: string[] = [];
  if (withHeader) out.push(`*طلبية رقم ${o.id}*`);
  out.push(`التاريخ: ${fmtDay(o.orderDate)}`);
  out.push(`المندوب: ${o.repName}`);
  out.push(`الصيدلية: ${o.pharmacyName}`);
  if (o.areaName) out.push(`المنطقة: ${o.areaName}`);
  out.push(`المذخر: ${o.warehouseName}`);
  out.push('──────────');
  o.lines.forEach((l, i) => {
    const bonus = l.bonusQty ? ` + بونص ${l.bonusQty}` : '';
    out.push(`${i + 1}) ${l.itemName}${l.companyName ? ` (${l.companyName})` : ''} — الكمية: ${l.quantity}${bonus}`);
  });
  if (o.notes) out.push(`ملاحظات: ${o.notes}`);
  if (o.invoiceImage) out.push(`صورة الفاتورة: ${window.location.origin}${o.invoiceImage}`);
  return out.join('\n');
}

// تصغير الصورة في المتصفح قبل الرفع (القرص ضيّق على السيرفر)
async function compressImage(file: File, maxSide = 1600, quality = 0.8): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('تعذّر ضغط الصورة'))), 'image/jpeg', quality));
  } finally { URL.revokeObjectURL(url); }
}

export default function RepOrdersPage() {
  const { token } = useAuth();

  const api = useCallback(async <T = any>(path: string, init: RequestInit = {}): Promise<T> => {
    const isForm = init.body instanceof FormData;
    const res = await fetch(`${API}/api/rep-orders${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store',
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* بلا JSON */ }
    if (!res.ok || body?.success === false) throw new Error(body?.message || body?.error || `فشل الطلب (${res.status})`);
    return body as T;
  }, [token]);

  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState<'' | Status>('');
  const [warehouseId, setWarehouseId] = useState('');
  const [invoice, setInvoice] = useState<'' | 'yes' | 'no'>('');
  const [repUserId, setRepUserId] = useState('');
  const [groupBy, setGroupBy] = useState<'date' | 'warehouse' | 'rep'>('date');

  const [orders, setOrders] = useState<Order[]>([]);
  const [reps, setReps] = useState<{ id: number; name: string }[]>([]);
  const [isManager, setIsManager] = useState(false);
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Order | 'new' | null>(null);
  const [showWarehouses, setShowWarehouses] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const loadWarehouses = useCallback(() => {
    if (!token) return;
    api<{ warehouses: WarehouseRow[] }>('/warehouses').then(r => setWarehouses(r.warehouses)).catch(() => {});
  }, [token, api]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setErr(null);
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (status) q.set('status', status);
    if (warehouseId) q.set('warehouseId', warehouseId);
    if (invoice) q.set('invoice', invoice);
    if (repUserId) q.set('repUserId', repUserId);
    try {
      const r = await api<{ orders: Order[]; reps: { id: number; name: string }[]; viewer: { isManager: boolean } }>(`?${q}`);
      setOrders(r.orders); setReps(r.reps); setIsManager(r.viewer.isManager);
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [token, api, from, to, status, warehouseId, invoice, repUserId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadWarehouses(); }, [loadWarehouses]);

  const setRange = (f: string, t: string) => { setFrom(f); setTo(t); };

  const stats = useMemo(() => ({
    total: orders.length,
    pending: orders.filter(o => o.status === 'pending').length,
    prepared: orders.filter(o => o.status === 'prepared').length,
    withInvoice: orders.filter(o => o.invoiceImage).length,
    unsent: orders.filter(o => !o.sentAt && o.status !== 'cancelled').length,
  }), [orders]);

  const groups = useMemo(() => {
    const m = new Map<string, { key: string; title: string; orders: Order[]; warehouseId?: number | null; phone?: string | null }>();
    for (const o of orders) {
      const key = groupBy === 'date' ? fmtDay(o.orderDate) : groupBy === 'warehouse' ? `w${o.warehouseId ?? o.warehouseName}` : `r${o.createdById}`;
      const title = groupBy === 'date' ? fmtDay(o.orderDate) : groupBy === 'warehouse' ? o.warehouseName : o.repName;
      if (!m.has(key)) m.set(key, { key, title, orders: [], warehouseId: o.warehouseId, phone: o.warehousePhone });
      m.get(key)!.orders.push(o);
    }
    return [...m.values()];
  }, [orders, groupBy]);

  // ── الإرسال لواتساب المذخر ─────────────────────────────────────────────────
  // تُفتح النافذة قبل أي await كي لا يحجبها المتصفح كنافذة منبثقة.
  const sendToWarehouse = (list: Order[]) => {
    const phone = list[0]?.warehousePhone;
    const wa = toWaNumber(phone);
    if (!wa) { alert('لا يوجد رقم واتساب لهذا المذخر — أضفه من «دليل المذاخر» ثم اختر المذخر في الطلبية.'); return; }
    const text = list.length === 1
      ? orderText(list[0])
      : [`*${list.length} طلبيات — ${list[0].warehouseName}*`, ...list.map(o => `\n*طلبية رقم ${o.id}*\n${orderText(o, false)}`)].join('\n');
    window.open(`https://wa.me/${wa}?text=${encodeURIComponent(text)}`, '_blank');
    api('/mark-sent', { method: 'POST', body: JSON.stringify({ ids: list.map(o => o.id) }) }).then(load).catch(() => {});
  };

  const changeStatus = async (ids: number[], s: Status) => {
    try { await api('/status', { method: 'POST', body: JSON.stringify({ ids, status: s }) }); load(); } catch (e: any) { alert(e.message); }
  };

  const remove = async (o: Order) => {
    if (!window.confirm(`حذف طلبية ${o.pharmacyName} نهائياً؟`)) return;
    try { await api(`/${o.id}`, { method: 'DELETE' }); load(); } catch (e: any) { alert(e.message); }
  };

  const uploadInvoice = async (o: Order, file: File) => {
    try {
      const fd = new FormData();
      fd.append('image', await compressImage(file), 'invoice.jpg');
      await api(`/${o.id}/invoice`, { method: 'POST', body: fd });
      load();
    } catch (e: any) { alert(e.message); }
  };

  const removeInvoice = async (o: Order) => {
    if (!window.confirm('حذف صورة الفاتورة؟')) return;
    try { await api(`/${o.id}/invoice`, { method: 'DELETE' }); load(); } catch (e: any) { alert(e.message); }
  };

  return (
    <div className="ro-page">
      <div className="ro-toolbar">
        <div className="ro-segment" role="group" aria-label="الفترة">
          <button className={from === today() && to === today() ? 'is-active' : ''} onClick={() => setRange(today(), today())}>اليوم</button>
          <button className={from === shiftDay(-1) && to === shiftDay(-1) ? 'is-active' : ''} onClick={() => setRange(shiftDay(-1), shiftDay(-1))}>أمس</button>
          <button className={from === shiftDay(-6) && to === today() ? 'is-active' : ''} onClick={() => setRange(shiftDay(-6), today())}>آخر 7 أيام</button>
          <button className={from === monthStart() && to === today() ? 'is-active' : ''} onClick={() => setRange(monthStart(), today())}>هذا الشهر</button>
        </div>
        <label className="ro-inline">من <input className="form-input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="ro-inline">إلى <input className="form-input" type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <span className="ro-spacer" />
        <button className="btn btn--secondary btn--sm" onClick={() => setShowWarehouses(true)}><Warehouse size={14} /> دليل المذاخر</button>
        <button className="btn btn--primary btn--sm" onClick={() => setEditing('new')}><Plus size={14} /> طلبية جديدة</button>
      </div>

      <div className="ro-toolbar">
        <select className="form-input ro-select" value={status} onChange={e => setStatus(e.target.value as any)}>
          <option value="">كل الحالات</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select className="form-input ro-select" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
          <option value="">كل المذاخر</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select className="form-input ro-select" value={invoice} onChange={e => setInvoice(e.target.value as any)}>
          <option value="">الفاتورة: الكل</option>
          <option value="yes">فيها صورة فاتورة</option>
          <option value="no">بدون صورة فاتورة</option>
        </select>
        {isManager && reps.length > 1 && (
          <select className="form-input ro-select" value={repUserId} onChange={e => setRepUserId(e.target.value)}>
            <option value="">كل المندوبين</option>
            {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <span className="ro-spacer" />
        <div className="ro-segment" role="group" aria-label="التقسيم">
          <button className={groupBy === 'date' ? 'is-active' : ''} onClick={() => setGroupBy('date')}>حسب التاريخ</button>
          <button className={groupBy === 'warehouse' ? 'is-active' : ''} onClick={() => setGroupBy('warehouse')}>حسب المذخر</button>
          {isManager && <button className={groupBy === 'rep' ? 'is-active' : ''} onClick={() => setGroupBy('rep')}>حسب المندوب</button>}
        </div>
      </div>

      <div className="ro-stats">
        <div className="ro-stat"><span>الطلبيات</span><strong>{stats.total}</strong></div>
        <div className="ro-stat ro-stat--warn"><span>بانتظار التجهيز</span><strong>{stats.pending}</strong></div>
        <div className="ro-stat ro-stat--ok"><span>تم التجهيز</span><strong>{stats.prepared}</strong></div>
        <div className="ro-stat"><span>فيها فاتورة</span><strong>{stats.withInvoice}</strong></div>
        <div className="ro-stat"><span>لم تُرسل للمذخر</span><strong>{stats.unsent}</strong></div>
      </div>

      {err && <div className="ro-note ro-note--warn">⚠️ {err}</div>}
      {loading && <div className="ro-muted">جارٍ التحميل…</div>}
      {!loading && orders.length === 0 && (
        <div className="ro-empty">
          <div className="ro-empty__title">لا طلبيات في هذه الفترة</div>
          <button className="btn btn--primary btn--sm" onClick={() => setEditing('new')}><Plus size={14} /> اكتب أول طلبية</button>
        </div>
      )}

      {groups.map(g => {
        const unsent = g.orders.filter(o => !o.sentAt && o.status !== 'cancelled');
        return (
          <section key={g.key} className="ro-group">
            <div className="ro-group__head">
              <div className="ro-group__title">{g.title} <span className="ro-muted">— {g.orders.length} طلبية</span></div>
              {groupBy === 'warehouse' && g.phone && unsent.length > 1 && (
                <button className="btn btn--success btn--sm" onClick={() => sendToWarehouse(unsent)}>
                  <Send size={14} /> إرسال {unsent.length} طلبيات غير مرسلة للمذخر
                </button>
              )}
              {g.orders.some(o => o.status === 'pending') && (
                <button className="btn btn--secondary btn--sm" onClick={() => changeStatus(g.orders.filter(o => o.status === 'pending').map(o => o.id), 'prepared')}>
                  <Check size={14} /> تجهيز الكل
                </button>
              )}
            </div>
            <div className="ro-cards">
              {g.orders.map(o => (
                <OrderCard key={o.id} o={o} isManager={isManager}
                  onSend={() => sendToWarehouse([o])}
                  onStatus={s => changeStatus([o.id], s)}
                  onEdit={() => setEditing(o)}
                  onDelete={() => remove(o)}
                  onUpload={f => uploadInvoice(o, f)}
                  onRemoveInvoice={() => removeInvoice(o)}
                  onPreview={() => setPreview(o.invoiceImage)} />
              ))}
            </div>
          </section>
        );
      })}

      {editing && (
        <OrderForm token={token} api={api} order={editing === 'new' ? null : editing} warehouses={warehouses}
          onWarehousesChanged={loadWarehouses}
          onClose={() => setEditing(null)}
          onSaved={(d) => { setEditing(null); if (d && (d < from || d > to)) setRange(d, d); else load(); }} />
      )}
      {showWarehouses && (
        <WarehousesModal api={api} warehouses={warehouses} onChanged={() => { loadWarehouses(); load(); }} onClose={() => setShowWarehouses(false)} />
      )}
      {preview && (
        <div className="ro-modal" onClick={() => setPreview(null)}>
          <img className="ro-preview" src={`${API}${preview}`} alt="صورة الفاتورة" />
        </div>
      )}
    </div>
  );
}

// ─── بطاقة طلبية ─────────────────────────────────────────────────────────────

function OrderCard({ o, isManager, onSend, onStatus, onEdit, onDelete, onUpload, onRemoveInvoice, onPreview }: {
  o: Order; isManager: boolean;
  onSend: () => void; onStatus: (s: Status) => void; onEdit: () => void; onDelete: () => void;
  onUpload: (f: File) => void; onRemoveInvoice: () => void; onPreview: () => void;
}) {
  const total = o.lines.reduce((s, l) => s + l.quantity, 0);
  return (
    <div className={`ro-card ro-card--${o.status}`}>
      <div className="ro-card__head">
        <div>
          <div className="ro-card__title">{o.pharmacyName}</div>
          <div className="ro-card__meta">
            {o.areaName && <span>📍 {o.areaName}</span>}
            <span>🏬 {o.warehouseName}</span>
            <span>📅 {fmtDay(o.orderDate)}</span>
            {isManager && <span>👤 {o.repName}</span>}
            <span className="ro-muted">#{o.id}</span>
          </div>
        </div>
        <div className="ro-badges">
          <span className={`ro-badge ro-badge--${o.status}`}>{STATUS_LABEL[o.status]}</span>
          {o.sentAt
            ? <span className="ro-badge ro-badge--sent" title={new Date(o.sentAt).toLocaleString('ar-IQ')}>أُرسلت{o.sentCount > 1 ? ` ×${o.sentCount}` : ''}</span>
            : <span className="ro-badge">لم تُرسل</span>}
          {o.invoiceImage && <span className="ro-badge ro-badge--invoice">🧾 فاتورة</span>}
        </div>
      </div>

      <table className="ro-lines">
        <thead><tr><th>الصنف</th><th>الشركة</th><th>الكمية</th><th>بونص</th></tr></thead>
        <tbody>
          {o.lines.map((l, i) => (
            <tr key={l.id ?? i}><td>{l.itemName}</td><td className="ro-muted">{l.companyName ?? '—'}</td><td>{l.quantity}</td><td>{l.bonusQty || '—'}</td></tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={2}>المجموع</td><td>{total}</td><td /></tr></tfoot>
      </table>
      {o.notes && <div className="ro-card__notes">📝 {o.notes}</div>}
      {o.preparedBy && o.status === 'prepared' && <div className="ro-muted ro-small">جهّزها: {o.preparedBy}</div>}

      <div className="ro-card__actions">
        <button className="btn btn--success btn--sm" onClick={onSend} disabled={o.status === 'cancelled'} title={o.warehousePhone ? `واتساب ${o.warehousePhone}` : 'لا رقم واتساب للمذخر'}>
          <Send size={14} /> إرسال للمذخر
        </button>
        {o.status === 'pending' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('prepared')}><Check size={14} /> تم التجهيز</button>}
        {o.status !== 'pending' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('pending')}><RotateCcw size={14} /> إرجاع لانتظار</button>}
        {o.status === 'pending' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('cancelled')}><Ban size={14} /> إلغاء</button>}
        {o.invoiceImage ? (
          <>
            <button className="btn btn--secondary btn--sm" onClick={onPreview}><ImageIcon size={14} /> الفاتورة</button>
            {o.canEdit && <button className="ro-icon-btn" title="حذف صورة الفاتورة" onClick={onRemoveInvoice}><X size={14} /></button>}
          </>
        ) : (
          <label className="btn btn--secondary btn--sm ro-file">
            <ImageIcon size={14} /> إضافة فاتورة
            <input type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
          </label>
        )}
        <span className="ro-spacer" />
        {o.canEdit && <button className="ro-icon-btn" title="تعديل" onClick={onEdit}><Pencil size={14} /></button>}
        {o.canEdit && <button className="ro-icon-btn ro-icon-btn--danger" title="حذف" onClick={onDelete}><Trash2 size={14} /></button>}
      </div>
    </div>
  );
}

// ─── نموذج الطلبية ───────────────────────────────────────────────────────────

interface FormLine { key: number; text: string; itemId: number | null; companyName: string; quantity: string; bonusQty: string }
const newLine = (): FormLine => ({ key: Date.now() + Math.random(), text: '', itemId: null, companyName: '', quantity: '', bonusQty: '' });

function OrderForm({ token, api, order, warehouses, onWarehousesChanged, onClose, onSaved }: {
  token: string | null;
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>;
  order: Order | null; warehouses: WarehouseRow[];
  onWarehousesChanged: () => void; onClose: () => void; onSaved: (day: string | null) => void;
}) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [pharmacies, setPharmacies] = useState<{ name: string; areaName: string | null }[]>([]);
  const [head, setHead] = useState({
    orderDate: order ? fmtDay(order.orderDate) : today(),
    warehouseId: order?.warehouseId ? String(order.warehouseId) : '',
    pharmacyName: order?.pharmacyName ?? '',
    areaName: order?.areaName ?? '',
    notes: order?.notes ?? '',
  });
  const [lines, setLines] = useState<FormLine[]>(() => order
    ? order.lines.map(l => ({ key: Math.random(), text: l.itemName, itemId: l.itemId, companyName: l.companyName ?? '', quantity: String(l.quantity), bonusQty: l.bonusQty ? String(l.bonusQty) : '' }))
    : [newLine()]);
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [newWh, setNewWh] = useState<{ name: string; phone: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    fetch(`${API}/api/items`, { headers: h, cache: 'no-store' }).then(r => r.json()).then(j => setItems(Array.isArray(j?.data) ? j.data : [])).catch(() => {});
    fetch(`${API}/api/areas`, { headers: h }).then(r => r.json()).then(j => setAreas((j?.data ?? []).map((a: any) => a.name).filter(Boolean))).catch(() => {});
    api<{ pharmacies: { name: string; areaName: string | null }[] }>('/suggestions').then(r => setPharmacies(r.pharmacies)).catch(() => {});
  }, [token, api]);

  const itemByLabel = useMemo(() => {
    const m = new Map<string, CatalogItem>();
    for (const i of items) { m.set(itemLabel(i), i); if (!m.has(i.name)) m.set(i.name, i); }
    return m;
  }, [items]);

  const setLine = (key: number, patch: Partial<FormLine>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const onItemText = (key: number, text: string) => {
    const it = itemByLabel.get(text.trim());
    setLine(key, it ? { text: it.name, itemId: it.id, companyName: itemCompany(it) ?? '' } : { text, itemId: null });
  };
  const onPharmacy = (name: string) => {
    const known = pharmacies.find(p => p.name === name);
    setHead(h => ({ ...h, pharmacyName: name, areaName: known?.areaName && !h.areaName ? known.areaName : h.areaName }));
  };

  const addWarehouse = async () => {
    if (!newWh) return;
    try {
      const r = await api<{ warehouse: WarehouseRow }>('/warehouses', { method: 'POST', body: JSON.stringify(newWh) });
      onWarehousesChanged();
      setHead(h => ({ ...h, warehouseId: String(r.warehouse.id) }));
      setNewWh(null);
    } catch (e: any) { alert(e.message); }
  };
  const submit = async () => {
    setErr(null);
    const valid = lines.filter(l => l.text.trim() && Number(l.quantity) > 0);
    if (!head.warehouseId) return setErr('اختر المذخر (أو أضف مذخراً جديداً برقم واتسابه)');
    if (!head.pharmacyName.trim()) return setErr('اسم الصيدلية مطلوب');
    if (!valid.length) return setErr('أضف صنفاً واحداً على الأقل مع كميته');
    setSaving(true);
    try {
      const body = JSON.stringify({
        ...head,
        warehouseId: Number(head.warehouseId),
        lines: valid.map(l => ({ itemId: l.itemId, itemName: l.text.trim(), companyName: l.companyName || null, quantity: Number(l.quantity), bonusQty: Number(l.bonusQty) || 0 })),
      });
      const r = await api<{ order: { id: number } }>(order ? `/${order.id}` : '', { method: order ? 'PUT' : 'POST', body });
      if (invoiceFile) {
        const fd = new FormData();
        fd.append('image', await compressImage(invoiceFile), 'invoice.jpg');
        await api(`/${r.order.id}/invoice`, { method: 'POST', body: fd });
      }
      onSaved(head.orderDate);
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  };

  return (
    <div className="ro-modal" onClick={onClose}>
      <div className="ro-dialog" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head">
          <strong>{order ? `تعديل الطلبية #${order.id}` : 'طلبية جديدة'}</strong>
          <button className="ro-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ro-dialog__body">
          <div className="ro-form-grid">
            <label className="ro-field">التاريخ
              <input className="form-input" type="date" value={head.orderDate} onChange={e => setHead(h => ({ ...h, orderDate: e.target.value }))} />
            </label>
            <label className="ro-field">المذخر *
              <select className="form-input" value={head.warehouseId} onChange={e => e.target.value === '__new' ? setNewWh({ name: '', phone: '' }) : setHead(h => ({ ...h, warehouseId: e.target.value }))}>
                <option value="">اختر المذخر…</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                <option value="__new">+ مذخر جديد…</option>
              </select>
            </label>
            <label className="ro-field">الصيدلية *
              <input className="form-input" list="ro-pharmacies" value={head.pharmacyName} onChange={e => onPharmacy(e.target.value)} />
              <datalist id="ro-pharmacies">{pharmacies.map(p => <option key={p.name} value={p.name} />)}</datalist>
            </label>
            <label className="ro-field">المنطقة
              <input className="form-input" list="ro-areas" value={head.areaName} onChange={e => setHead(h => ({ ...h, areaName: e.target.value }))} />
              <datalist id="ro-areas">{areas.map(a => <option key={a} value={a} />)}</datalist>
            </label>
          </div>

          {newWh && (
            <div className="ro-newwh">
              <input className="form-input" placeholder="اسم المذخر (مثال: الناقوس)" value={newWh.name} onChange={e => setNewWh({ ...newWh, name: e.target.value })} />
              <input className="form-input" placeholder="رقم واتساب المذخر 07…" inputMode="tel" dir="ltr" value={newWh.phone} onChange={e => setNewWh({ ...newWh, phone: e.target.value })} />
              <button className="btn btn--primary btn--sm" onClick={addWarehouse}>حفظ المذخر</button>
              <button className="btn btn--secondary btn--sm" onClick={() => setNewWh(null)}>إلغاء</button>
            </div>
          )}

          <div className="ro-form-lines">
            <div className="ro-form-line ro-form-line--head"><span>الصنف</span><span>الشركة</span><span>الكمية</span><span>بونص</span><span /></div>
            {lines.map(l => (
              <div key={l.key} className="ro-form-line">
                <input className="form-input" list="ro-items" placeholder={items.length ? 'اكتب أو اختر الصنف…' : 'اسم الصنف'} value={l.text} onChange={e => onItemText(l.key, e.target.value)} />
                <input className="form-input" placeholder="تلقائياً" value={l.companyName} readOnly={!!l.itemId} onChange={e => setLine(l.key, { companyName: e.target.value })} />
                <input className="form-input" type="number" min={1} inputMode="numeric" placeholder="الكمية" value={l.quantity} onChange={e => setLine(l.key, { quantity: e.target.value })} />
                <input className="form-input" type="number" min={0} inputMode="numeric" placeholder="0" value={l.bonusQty} onChange={e => setLine(l.key, { bonusQty: e.target.value })} />
                <button className="ro-icon-btn" title="حذف السطر" disabled={lines.length === 1} onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}><Trash2 size={14} /></button>
              </div>
            ))}
            <datalist id="ro-items">{items.map(i => <option key={i.id} value={itemLabel(i)} />)}</datalist>
            <button className="btn btn--secondary btn--sm ro-self-start" onClick={() => setLines(ls => [...ls, newLine()])}><Plus size={14} /> صنف آخر</button>
          </div>

          <label className="ro-field">ملاحظات
            <input className="form-input" value={head.notes} onChange={e => setHead(h => ({ ...h, notes: e.target.value }))} />
          </label>
          {!order?.invoiceImage && (
            <label className="ro-field">صورة الفاتورة (اختياري)
              <input className="form-input" type="file" accept="image/*" onChange={e => setInvoiceFile(e.target.files?.[0] ?? null)} />
            </label>
          )}

          {err && <div className="ro-note ro-note--warn">⚠️ {err}</div>}
        </div>
        <div className="ro-dialog__foot">
          <button className="btn btn--primary" disabled={saving} onClick={submit}>{saving ? 'جارٍ الحفظ…' : 'حفظ الطلبية'}</button>
          <button className="btn btn--secondary" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

// ─── دليل المذاخر (الاسم + رقم الواتساب) ──────────────────────────────────────

function WarehousesModal({ api, warehouses, onChanged, onClose }: {
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>;
  warehouses: WarehouseRow[]; onChanged: () => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<{ id: number | null; name: string; phone: string; notes: string } | null>(null);

  const save = async () => {
    if (!draft) return;
    try {
      const body = JSON.stringify({ name: draft.name, phone: draft.phone, notes: draft.notes });
      await api(draft.id ? `/warehouses/${draft.id}` : '/warehouses', { method: draft.id ? 'PUT' : 'POST', body });
      setDraft(null); onChanged();
    } catch (e: any) { alert(e.message); }
  };
  const remove = async (w: WarehouseRow) => {
    if (!window.confirm(`حذف المذخر «${w.name}» من الدليل؟ الطلبيات السابقة تبقى باسمه.`)) return;
    try { await api(`/warehouses/${w.id}`, { method: 'DELETE' }); onChanged(); } catch (e: any) { alert(e.message); }
  };

  return (
    <div className="ro-modal" onClick={onClose}>
      <div className="ro-dialog ro-dialog--narrow" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head">
          <strong>دليل المذاخر</strong>
          <button className="ro-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ro-dialog__body">
          <div className="ro-muted ro-small">رقم الواتساب هو الذي تُرسل له الطلبية. الدليل مشترك بين حسابات المكتب.</div>
          {warehouses.length === 0 && <div className="ro-muted">لا مذاخر بعد.</div>}
          {warehouses.map(w => (
            <div key={w.id} className="ro-wh-row">
              <div>
                <strong>{w.name}</strong>
                <div className="ro-muted ro-small" dir="ltr">{w.phone}</div>
                {w.notes && <div className="ro-muted ro-small">{w.notes}</div>}
              </div>
              {w.canEdit && (
                <div className="ro-row-actions">
                  <button className="ro-icon-btn" title="تعديل" onClick={() => setDraft({ id: w.id, name: w.name, phone: w.phone, notes: w.notes ?? '' })}><Pencil size={14} /></button>
                  <button className="ro-icon-btn ro-icon-btn--danger" title="حذف" onClick={() => remove(w)}><Trash2 size={14} /></button>
                </div>
              )}
            </div>
          ))}
          {draft ? (
            <div className="ro-newwh">
              <input className="form-input" placeholder="اسم المذخر" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
              <input className="form-input" placeholder="رقم واتساب 07…" inputMode="tel" dir="ltr" value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} />
              <input className="form-input" placeholder="ملاحظة (اختياري)" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} />
              <button className="btn btn--primary btn--sm" onClick={save}>حفظ</button>
              <button className="btn btn--secondary btn--sm" onClick={() => setDraft(null)}>إلغاء</button>
            </div>
          ) : (
            <button className="btn btn--primary btn--sm ro-self-start" onClick={() => setDraft({ id: null, name: '', phone: '', notes: '' })}><Plus size={14} /> إضافة مذخر</button>
          )}
        </div>
      </div>
    </div>
  );
}
