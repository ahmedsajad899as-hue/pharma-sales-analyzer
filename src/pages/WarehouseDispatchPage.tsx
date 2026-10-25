// ════════════════════════════════════════════════════════════════════════════
// WarehouseDispatchPage — «إرسال للمذاخر».
//
// الطلبيات التي تصل (من بوت الطلبيات أو من «طلبيات المذاخر») تُرسل لواتساب المذخر
// عبر رقم البوت الرسمي أو لكروب المذخر عبر «رقم الكروبات»، والمذخر يرد بأزرار
// (تم التجهيز / جزئي / رفض) أو بصورة الفاتورة فتتحدّث الحالة هنا ويُشعَر المندوب.
//
// تبويبات: الطلبيات | المذاخر (القناة والكروب والبدائل) | الإعدادات (وضع كل حساب
// + المهلة) | رقم الكروبات (أدمن: ربط الشريحة بكود).
// ════════════════════════════════════════════════════════════════════════════

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Send, RefreshCw, Check, X, Ban, Trash2, ChevronDown, ArrowLeftRight, AlertTriangle, Image as ImageIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './WarehouseDispatchPage.css';

const API = import.meta.env.VITE_API_URL || '';

type Status = 'needs_warehouse' | 'awaiting_approval' | 'sending' | 'sent' | 'prepared' | 'partial' | 'rejected' | 'no_response' | 'failed' | 'cancelled';
interface Line { item: string; quantity: number; bonus: number }
interface Dispatch {
  id: number; createdById: number; source: string; accountName: string | null; repName: string | null;
  pharmacyName: string | null; areaName: string | null; requestedWarehouse: string | null;
  warehouseId: number | null; warehouseName: string | null; lines: Line[]; notes: string | null;
  status: Status; channel: string | null; sendKind: string | null; sentAt: string | null; sentByName: string | null;
  deliveredAt: string | null; readAt: string | null; respondedAt: string | null; rejectReason: string | null;
  warehouseNote: string | null; invoiceImage: string | null; error: string | null; attempt: number; parentId: number | null;
  createdAt: string;
}
interface Usage { month: string; service: number; template: number; group: number; freeServiceTier: number }
interface Wh {
  id: number; name: string; phone: string; channel: 'cloud' | 'group' | 'manual'; groupJid: string | null; groupName: string | null;
  backupWarehouseIds: number[]; waLastInboundAt: string | null; windowOpen: boolean; ready: boolean;
}
interface Group { jid: string; name: string; size: number }
interface UserMode { id: number; name: string; role: string; mode: 'off' | 'auto' | 'approval' }
interface Config { responseTimeoutMin: number; autoBackup: boolean }

const STATUS_LABEL: Record<Status, string> = {
  needs_warehouse: 'بلا مذخر', awaiting_approval: 'بانتظار الإرسال', sending: 'يُرسل…', sent: 'أُرسلت',
  prepared: 'تم التجهيز', partial: 'تجهيز جزئي', rejected: 'مرفوضة', no_response: 'لا رد', failed: 'فشل الإرسال', cancelled: 'ملغاة',
};
type View = 'all' | 'waiting' | 'sent' | 'prepared' | 'problem' | 'cancelled';
const VIEW_LABEL: Record<View, string> = { all: 'الكل', waiting: 'بانتظار الإرسال', sent: 'عند المذخر', prepared: 'تم التجهيز', problem: 'رفض / لا رد / فشل', cancelled: 'ملغاة' };
const viewOf = (s: Status): View => (
  ['needs_warehouse', 'awaiting_approval'].includes(s) ? 'waiting'
    : ['sending', 'sent'].includes(s) ? 'sent'
      : ['prepared', 'partial'].includes(s) ? 'prepared'
        : s === 'cancelled' ? 'cancelled' : 'problem');
const PRE_SEND: Status[] = ['needs_warehouse', 'awaiting_approval', 'failed'];
const KIND_LABEL: Record<string, string> = { service: 'رسالة مجانية', template: 'قالب مدفوع', group: 'كروب' };
const MODE_LABEL = { off: 'متوقف', auto: 'فوري', approval: 'بعد الموافقة' };
// سعر تقريبي لرسالة قالب Utility في العراق (Meta، تشرين الأول 2026) — للعرض فقط
const TEMPLATE_USD = 0.008;

const fmtTime = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export default function WarehouseDispatchPage() {
  const { token, user } = useAuth();
  const isAdmin = ['admin', 'super_admin'].includes(String(user?.role || ''));
  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${API}/api${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.success === false) throw new Error(d.error || d.message || 'خطأ في الاتصال');
    return d;
  }, [token]);

  const [tab, setTab] = useState<'orders' | 'warehouses' | 'settings' | 'groups'>('orders');
  const [canManage, setCanManage] = useState(false);
  const [warehouses, setWarehouses] = useState<Wh[]>([]);
  const [error, setError] = useState('');

  const loadWarehouses = useCallback(() => {
    api('/warehouse-dispatch/warehouses').then(d => setWarehouses(d.warehouses || [])).catch(e => setError(e.message));
  }, [api]);
  useEffect(() => { if (token) loadWarehouses(); }, [token, loadWarehouses]);

  return (
    <div className="wd-page">
      <div className="wd-tabs">
        <button className={`wd-tab ${tab === 'orders' ? 'is-active' : ''}`} onClick={() => setTab('orders')}>الطلبيات</button>
        <button className={`wd-tab ${tab === 'warehouses' ? 'is-active' : ''}`} onClick={() => setTab('warehouses')}>المذاخر</button>
        {canManage && <button className={`wd-tab ${tab === 'settings' ? 'is-active' : ''}`} onClick={() => setTab('settings')}>الإعدادات</button>}
        {isAdmin && <button className={`wd-tab ${tab === 'groups' ? 'is-active' : ''}`} onClick={() => setTab('groups')}>رقم الكروبات</button>}
      </div>
      {error && <div className="wd-note wd-note--warn">{error}</div>}
      {tab === 'orders' && <OrdersTab api={api} warehouses={warehouses} onManage={setCanManage} />}
      {tab === 'warehouses' && <WarehousesTab api={api} warehouses={warehouses} reload={loadWarehouses} canManage={canManage} />}
      {tab === 'settings' && canManage && <SettingsTab api={api} />}
      {tab === 'groups' && isAdmin && <GroupsTab api={api} />}
    </div>
  );
}

type Api = (path: string, init?: RequestInit) => Promise<any>;

// ─── الطلبيات ────────────────────────────────────────────────────────────────

function OrdersTab({ api, warehouses, onManage }: { api: Api; warehouses: Wh[]; onManage: (v: boolean) => void }) {
  const [rows, setRows] = useState<Dispatch[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [channels, setChannels] = useState<{ cloud: boolean; groups: boolean } | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [days, setDays] = useState(7);
  const [view, setView] = useState<View>('all');
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    api(`/warehouse-dispatch?days=${days}`)
      .then(d => {
        setRows(d.dispatches || []); setUsage(d.usage); setChannels(d.channels);
        setCanManage(Boolean(d.canManage)); onManage(Boolean(d.canManage)); setError('');
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [api, days, onManage]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const counts = useMemo(() => {
    const c: Record<View, number> = { all: rows.length, waiting: 0, sent: 0, prepared: 0, problem: 0, cancelled: 0 };
    rows.forEach(r => { c[viewOf(r.status)]++; });
    return c;
  }, [rows]);
  const shown = rows.filter(r => view === 'all' || viewOf(r.status) === view);

  const act = async (id: number, fn: () => Promise<any>) => {
    setBusy(id); setError('');
    try { await fn(); load(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const send = (d: Dispatch, warehouseId?: number) => act(d.id, () => api(`/warehouse-dispatch/${d.id}/send`, { method: 'POST', body: JSON.stringify({ warehouseId }) }));
  const forward = (d: Dispatch, warehouseId: number) => act(d.id, () => api(`/warehouse-dispatch/${d.id}/forward`, { method: 'POST', body: JSON.stringify({ warehouseId }) }));
  const setWh = (d: Dispatch, warehouseId: number | null) => act(d.id, () => api(`/warehouse-dispatch/${d.id}`, { method: 'PUT', body: JSON.stringify({ warehouseId }) }));
  const mark = (d: Dispatch, status: string) => {
    let reason: string | null = null;
    if (status === 'rejected') reason = window.prompt('سبب الرفض (اختياري):') ?? null;
    if (status === 'cancelled' && !window.confirm(`إلغاء الطلبية رقم ${d.id}؟`)) return;
    return act(d.id, () => api(`/warehouse-dispatch/${d.id}/status`, { method: 'POST', body: JSON.stringify({ status, reason }) }));
  };
  const remove = (d: Dispatch) => {
    if (!window.confirm(`حذف الطلبية رقم ${d.id} من قائمة الإرسال؟`)) return;
    return act(d.id, () => api(`/warehouse-dispatch/${d.id}`, { method: 'DELETE' }));
  };

  return (
    <>
      {usage && (
        <div className="wd-usage">
          <span>رسائل هذا الشهر:</span>
          <span className="wd-pill wd-pill--ok">مجانية {usage.service} / {usage.freeServiceTier}</span>
          <span className="wd-pill wd-pill--paid">قوالب مدفوعة {usage.template} ≈ ${(usage.template * TEMPLATE_USD).toFixed(2)}</span>
          <span className="wd-pill">كروبات {usage.group}</span>
          <span className="wd-spacer" />
          {channels && (
            <>
              <span className={`wd-dot ${channels.cloud ? 'is-on' : ''}`}>بوت واتساب</span>
              <span className={`wd-dot ${channels.groups ? 'is-on' : ''}`}>رقم الكروبات</span>
            </>
          )}
        </div>
      )}

      <div className="wd-bar">
        <div className="wd-chips">
          {(Object.keys(VIEW_LABEL) as View[]).map(v => (
            <button key={v} className={`wd-chip wd-chip--${v} ${view === v ? 'is-active' : ''}`} onClick={() => setView(v)}>
              {VIEW_LABEL[v]} <b>{counts[v]}</b>
            </button>
          ))}
        </div>
        <span className="wd-spacer" />
        <select className="form-input wd-select" value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={1}>اليوم</option><option value={3}>آخر 3 أيام</option><option value={7}>آخر أسبوع</option><option value={30}>آخر شهر</option>
        </select>
        <button className="btn btn-secondary wd-icon-btn" onClick={load} title="تحديث"><RefreshCw size={15} /></button>
      </div>

      {error && <div className="wd-note wd-note--warn">{error}</div>}
      {loading ? <div className="wd-empty">جاري التحميل…</div> : shown.length === 0 ? (
        <div className="wd-empty">
          <div className="wd-strong">لا توجد طلبيات</div>
          <div className="wd-muted wd-small">الطلبيات تظهر هنا عندما يكون وضع الإرسال للحساب «فوري» أو «بعد الموافقة» (تبويب الإعدادات)، أو عند إرسال طلبية من صفحة «طلبيات المذاخر» عبر البوت.</div>
        </div>
      ) : (
        <div className="wd-list">
          {shown.map(d => {
            const isOpen = open === d.id;
            const preSend = PRE_SEND.includes(d.status);
            return (
              <Fragment key={d.id}>
                <div className={`wd-card wd-card--${viewOf(d.status)}`}>
                  <button className="wd-card__head" onClick={() => setOpen(isOpen ? null : d.id)}>
                    <ChevronDown size={15} className={`wd-chevron ${isOpen ? 'is-open' : ''}`} />
                    <span className="wd-no">#{d.id}{d.attempt > 1 ? <small> بديل {d.attempt - 1}</small> : null}</span>
                    <span className="wd-main">
                      <span className="wd-strong">{d.pharmacyName || 'بلا صيدلية'}</span>
                      {d.areaName && <span className="wd-muted"> — {d.areaName}</span>}
                      <span className="wd-sub">{d.repName || d.accountName || ''} · {d.lines.length} صنف · {fmtTime(d.createdAt)}</span>
                    </span>
                    <span className="wd-wh">{d.warehouseName || d.requestedWarehouse || '—'}</span>
                    <span className={`wd-status wd-status--${d.status}`}>{STATUS_LABEL[d.status]}</span>
                    {d.sentAt && (
                      <span className="wd-ticks" title={d.readAt ? `قُرئت ${fmtTime(d.readAt)}` : d.deliveredAt ? `وصلت ${fmtTime(d.deliveredAt)}` : `أُرسلت ${fmtTime(d.sentAt)}`}>
                        {d.readAt ? <span className="is-read">✓✓</span> : d.deliveredAt ? '✓✓' : '✓'}
                      </span>
                    )}
                    {d.invoiceImage && <ImageIcon size={15} className="wd-has-inv" />}
                  </button>

                  {isOpen && (
                    <div className="wd-card__body">
                      <table className="wd-lines">
                        <thead><tr><th>#</th><th>المادة</th><th>الكمية</th><th>البونص</th></tr></thead>
                        <tbody>{d.lines.map((l, i) => <tr key={i}><td>{i + 1}</td><td>{l.item}</td><td>{l.quantity}</td><td>{l.bonus || ''}</td></tr>)}</tbody>
                      </table>
                      <div className="wd-meta">
                        {d.requestedWarehouse && d.requestedWarehouse !== d.warehouseName && <div>المذخر كما كتبه المندوب: <b>{d.requestedWarehouse}</b></div>}
                        {d.sentAt && <div>أُرسلت {fmtTime(d.sentAt)}{d.sentByName ? ` بواسطة ${d.sentByName}` : ' تلقائياً'}{d.sendKind ? ` · ${KIND_LABEL[d.sendKind] || d.sendKind}` : ''}</div>}
                        {d.respondedAt && <div>ردّ المذخر {fmtTime(d.respondedAt)}</div>}
                        {d.rejectReason && <div className="wd-danger">سبب الرفض: {d.rejectReason}</div>}
                        {d.warehouseNote && <div className="wd-note-box">ملاحظة المذخر: {d.warehouseNote}</div>}
                        {d.notes && <div>ملاحظات: {d.notes}</div>}
                        {d.error && <div className="wd-danger"><AlertTriangle size={13} /> {d.error}</div>}
                      </div>
                      {d.invoiceImage && (
                        <a href={d.invoiceImage} target="_blank" rel="noreferrer" className="wd-inv">
                          <img src={d.invoiceImage} alt="فاتورة المذخر" />
                          <span>فاتورة التجهيز</span>
                        </a>
                      )}

                      {canManage && (
                        <div className="wd-actions">
                          {preSend && (
                            <>
                              <select className="form-input wd-select" value={d.warehouseId ?? ''} disabled={busy === d.id}
                                onChange={e => setWh(d, e.target.value ? Number(e.target.value) : null)}>
                                <option value="">— اختر المذخر —</option>
                                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}{w.ready ? '' : ' (غير مضبوط)'}</option>)}
                              </select>
                              <button className="btn btn-primary" disabled={busy === d.id || !d.warehouseId} onClick={() => send(d)}>
                                <Send size={14} /> {d.status === 'failed' ? 'إعادة المحاولة' : 'إرسال الآن'}
                              </button>
                            </>
                          )}
                          {!preSend && d.status !== 'cancelled' && (
                            <>
                              <button className="btn btn-secondary" disabled={busy === d.id} onClick={() => send(d)}><RefreshCw size={14} /> إعادة إرسال</button>
                              <ForwardPicker warehouses={warehouses.filter(w => w.id !== d.warehouseId)} disabled={busy === d.id} onPick={id => forward(d, id)} />
                            </>
                          )}
                          <span className="wd-spacer" />
                          {d.status !== 'cancelled' && (
                            <>
                              <button className="btn btn-secondary wd-ok" disabled={busy === d.id} onClick={() => mark(d, 'prepared')} title="المذخر أبلغ بالتجهيز (هاتفياً مثلاً)"><Check size={14} /> مجهزة</button>
                              <button className="btn btn-secondary" disabled={busy === d.id} onClick={() => mark(d, 'partial')}>جزئي</button>
                              <button className="btn btn-secondary wd-bad" disabled={busy === d.id} onClick={() => mark(d, 'rejected')}><X size={14} /> رفض</button>
                              <button className="btn btn-secondary" disabled={busy === d.id} onClick={() => mark(d, 'cancelled')}><Ban size={14} /> إلغاء</button>
                            </>
                          )}
                          {(preSend || d.status === 'cancelled') && (
                            <button className="btn btn-secondary wd-icon-btn wd-bad" disabled={busy === d.id} onClick={() => remove(d)} title="حذف"><Trash2 size={14} /></button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </>
  );
}

function ForwardPicker({ warehouses, disabled, onPick }: { warehouses: Wh[]; disabled: boolean; onPick: (id: number) => void }) {
  const [id, setId] = useState('');
  return (
    <span className="wd-inline">
      <select className="form-input wd-select" value={id} disabled={disabled} onChange={e => setId(e.target.value)}>
        <option value="">تحويل لمذخر آخر…</option>
        {warehouses.filter(w => w.ready).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      <button className="btn btn-secondary" disabled={disabled || !id} onClick={() => { onPick(Number(id)); setId(''); }}><ArrowLeftRight size={14} /> تحويل</button>
    </span>
  );
}

// ─── المذاخر ─────────────────────────────────────────────────────────────────

function WarehousesTab({ api, warehouses, reload, canManage }: { api: Api; warehouses: Wh[]; reload: () => void; canManage: boolean }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [groupsError, setGroupsError] = useState('');
  const [error, setError] = useState('');
  const needGroups = warehouses.some(w => w.channel === 'group');

  useEffect(() => {
    if (!canManage || !needGroups || groups) return;
    api('/warehouse-dispatch/groups').then(d => { setGroups(d.groups || []); setGroupsError(d.error || ''); }).catch(e => setGroupsError(e.message));
  }, [api, canManage, needGroups, groups]);

  const save = async (w: Wh, body: Partial<Wh>) => {
    setError('');
    try { await api(`/warehouse-dispatch/warehouses/${w.id}`, { method: 'PUT', body: JSON.stringify(body) }); reload(); }
    catch (e: any) { setError(e.message); }
  };
  const nameOf = (id: number) => warehouses.find(w => w.id === id)?.name || `#${id}`;

  if (!warehouses.length) {
    return <div className="wd-empty"><div className="wd-strong">لا توجد مذاخر</div><div className="wd-muted wd-small">أضف المذاخر وأرقامها من صفحة «طلبيات المذاخر» ← المذاخر، ثم اضبط قناة كل مذخر هنا.</div></div>;
  }
  return (
    <>
      <div className="wd-note">
        <b>القناة:</b> «رقم البوت» = رسالة لواتساب المذخر الفردي بأزرار. «كروب» = رسالة في كروب المذخر عبر رقم الكروبات. «يدوي» = لا إرسال آلي.
        <br /><b>البدائل:</b> عند الرفض أو عدم الرد تُرسل الطلبية تلقائياً للمذخر البديل التالي (إن كان التحويل التلقائي مفعّلاً في الإعدادات).
        <br /><b>النافذة:</b> «مفتوحة» = المذخر راسلنا خلال 24 ساعة، فالرسالة له مجانية. «مغلقة» = يُرسل قالب مدفوع (≈ ${TEMPLATE_USD}).
      </div>
      {error && <div className="wd-note wd-note--warn">{error}</div>}
      {groupsError && needGroups && <div className="wd-note wd-note--warn">قائمة الكروبات: {groupsError}</div>}
      <div className="wd-table-wrap">
        <table className="wd-table">
          <thead><tr><th>المذخر</th><th>الرقم</th><th>القناة</th><th>الكروب</th><th>البدائل بالترتيب</th><th>النافذة</th></tr></thead>
          <tbody>
            {warehouses.map(w => (
              <tr key={w.id}>
                <td className="wd-strong">{w.name} {!w.ready && <span className="wd-pill wd-pill--paid">غير مضبوط</span>}</td>
                <td dir="ltr" className="wd-small">{w.phone}</td>
                <td>
                  <select className="form-input wd-select" disabled={!canManage} value={w.channel} onChange={e => save(w, { channel: e.target.value as Wh['channel'] })}>
                    <option value="cloud">رقم البوت</option><option value="group">كروب</option><option value="manual">يدوي</option>
                  </select>
                </td>
                <td>
                  {w.channel === 'group' ? (
                    <select className="form-input wd-select" disabled={!canManage} value={w.groupJid || ''}
                      onChange={e => { const g = groups?.find(x => x.jid === e.target.value); save(w, { groupJid: e.target.value || null, groupName: g?.name || null }); }}>
                      <option value="">{groups ? '— اختر الكروب —' : (w.groupName || '…')}</option>
                      {w.groupJid && !groups?.some(g => g.jid === w.groupJid) && <option value={w.groupJid}>{w.groupName || w.groupJid}</option>}
                      {(groups || []).map(g => <option key={g.jid} value={g.jid}>{g.name} ({g.size})</option>)}
                    </select>
                  ) : <span className="wd-muted">—</span>}
                </td>
                <td>
                  <div className="wd-backups">
                    {w.backupWarehouseIds.map((id, i) => (
                      <span key={id} className="wd-pill">{i + 1}. {nameOf(id)}
                        {canManage && <button className="wd-x" onClick={() => save(w, { backupWarehouseIds: w.backupWarehouseIds.filter(x => x !== id) })}>×</button>}
                      </span>
                    ))}
                    {canManage && w.backupWarehouseIds.length < 5 && (
                      <select className="form-input wd-select wd-select--sm" value="" onChange={e => e.target.value && save(w, { backupWarehouseIds: [...w.backupWarehouseIds, Number(e.target.value)] })}>
                        <option value="">+ بديل</option>
                        {warehouses.filter(x => x.id !== w.id && !w.backupWarehouseIds.includes(x.id)).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    )}
                  </div>
                </td>
                <td className="wd-small">
                  {w.channel !== 'cloud' ? <span className="wd-muted">—</span>
                    : w.windowOpen ? <span className="wd-pill wd-pill--ok">مفتوحة</span>
                      : <span className="wd-pill">مغلقة</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── الإعدادات ───────────────────────────────────────────────────────────────

function SettingsTab({ api }: { api: Api }) {
  const [users, setUsers] = useState<UserMode[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [canEditConfig, setCanEditConfig] = useState(false);
  const [templateName, setTemplateName] = useState('new_order');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api('/warehouse-dispatch/settings').then(d => {
      setUsers(d.users || []); setConfig(d.config); setCanEditConfig(Boolean(d.canEditConfig)); setTemplateName(d.templateName || 'new_order');
    }).catch(e => setError(e.message));
  }, [api]);
  useEffect(load, [load]);

  const setMode = async (u: UserMode, mode: UserMode['mode']) => {
    setUsers(list => list.map(x => (x.id === u.id ? { ...x, mode } : x)));
    try { await api(`/warehouse-dispatch/settings/user/${u.id}`, { method: 'PUT', body: JSON.stringify({ mode }) }); }
    catch (e: any) { setError(e.message); load(); }
  };
  const saveConfig = async (patch: Partial<Config>) => {
    try { const d = await api('/warehouse-dispatch/settings/config', { method: 'PUT', body: JSON.stringify(patch) }); setConfig(d.config); }
    catch (e: any) { setError(e.message); }
  };

  const shown = users.filter(u => !q.trim() || u.name.includes(q.trim()));
  return (
    <>
      {error && <div className="wd-note wd-note--warn">{error}</div>}
      {config && (
        <div className="wd-panel">
          <div className="wd-panel__title">إعدادات عامة</div>
          <label className="wd-field">
            <span>مهلة رد المذخر (دقيقة)</span>
            <input className="form-input wd-select" type="number" min={10} max={1440} disabled={!canEditConfig} defaultValue={config.responseTimeoutMin}
              onBlur={e => Number(e.target.value) !== config.responseTimeoutMin && saveConfig({ responseTimeoutMin: Number(e.target.value) })} />
          </label>
          <label className="wd-field wd-field--row">
            <input type="checkbox" disabled={!canEditConfig} checked={config.autoBackup} onChange={e => saveConfig({ autoBackup: e.target.checked })} />
            <span>تحويل تلقائي للمذخر البديل عند الرفض أو انتهاء المهلة بلا رد</span>
          </label>
        </div>
      )}

      <div className="wd-panel">
        <div className="wd-panel__title">وضع الإرسال لكل حساب</div>
        <div className="wd-muted wd-small">«فوري» = الطلبية تُرسل للمذخر لحظة وصولها من البوت. «بعد الموافقة» = تنتظر في تبويب الطلبيات حتى يضغط المدير «إرسال» (ويمكنه تغيير المذخر). «متوقف» = لا شيء يتغيّر عن الآن.</div>
        <input className="form-input" placeholder="بحث بالاسم…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="wd-table-wrap">
          <table className="wd-table">
            <thead><tr><th>الحساب</th><th>وضع الإرسال</th></tr></thead>
            <tbody>
              {shown.map(u => (
                <tr key={u.id}>
                  <td>{u.name} <span className="wd-muted wd-small">{u.role}</span></td>
                  <td>
                    <div className="wd-seg">
                      {(['off', 'approval', 'auto'] as const).map(m => (
                        <button key={m} className={`wd-seg__btn ${u.mode === m ? `is-active is-${m}` : ''}`} onClick={() => setMode(u, m)}>{MODE_LABEL[m]}</button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wd-panel">
        <div className="wd-panel__title">قالب Meta المطلوب (لمراسلة مذخر لم يراسلنا خلال 24 ساعة)</div>
        <div className="wd-small">أنشئه مرة واحدة في WhatsApp Manager ← Message templates ← Create: الفئة <b>Utility</b>، الاسم <code>{templateName}</code>، اللغة <b>Arabic (ar)</b>:</div>
        <pre className="wd-pre">{`طلبية جديدة رقم {{1}}
من: {{2}}
الصيدلية: {{3}}
الأصناف: {{4}}

يرجى الرد بأحد الأزرار أدناه، أو إرسال صورة فاتورة التجهيز رداً على هذه الرسالة.`}</pre>
        <div className="wd-small">الأزرار: Quick reply ×3 بالترتيب: <b>تم التجهيز</b> · <b>تجهيز جزئي</b> · <b>رفض</b></div>
      </div>
    </>
  );
}

// ─── رقم الكروبات ────────────────────────────────────────────────────────────

function GroupsTab({ api }: { api: Api }) {
  const [st, setSt] = useState<any>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => { api('/wa-groups/admin/status').then(setSt).catch(e => setError(e.message)); }, [api]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const pair = async () => {
    setBusy(true); setError(''); setCode('');
    try { const d = await api('/wa-groups/admin/pair', { method: 'POST', body: JSON.stringify({ phone }) }); setCode(d.pairingCode || ''); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const logout = async () => {
    if (!window.confirm('فصل رقم الكروبات؟ ستتوقف رسائل الكروبات حتى يُربط من جديد.')) return;
    try { await api('/wa-groups/admin/logout', { method: 'POST' }); load(); } catch (e: any) { setError(e.message); }
  };

  const STATUS: Record<string, string> = { connected: 'متصل ✅', awaiting_link: 'بانتظار الربط', reconnecting: 'يعيد الاتصال…', logged_out: 'غير مربوط', starting: 'يبدأ…' };
  return (
    <>
      <div className="wd-note wd-note--warn">
        ⚠️ رقم الكروبات يعمل بطريقة غير رسمية (واتساب ويب). استعمل <b>شريحة مخصّصة جديدة</b> فقط — ليس رقم البوت الرسمي ولا رقماً مهماً — لأن احتمال حظره من واتساب قائم.
      </div>
      {error && <div className="wd-note wd-note--warn">{error}</div>}
      <div className="wd-panel">
        <div className="wd-panel__title">الحالة</div>
        {!st ? <div className="wd-muted">…</div> : st.error && !st.status ? (
          <div className="wd-muted">{st.error}</div>
        ) : (
          <>
            <div>الحالة: <b>{STATUS[st.status] || st.status || 'غير مشغّل'}</b>{st.me ? <span dir="ltr"> — {String(st.me).split(':')[0].split('@')[0]}</span> : null}</div>
            {st.error && <div className="wd-small wd-muted">{st.error}</div>}
          </>
        )}
        {st?.connected ? (
          <button className="btn btn-secondary wd-bad wd-self-start" onClick={logout}>فصل الرقم</button>
        ) : st?.status ? (
          <>
            <div className="wd-small">1) ضع الشريحة في هاتف وثبّت واتساب (عادي أو Business) وفعّله عليها. 2) اكتب الرقم هنا واضغط «كود الربط». 3) في واتساب الهاتف: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← «الربط برقم الهاتف بدلاً من ذلك» وأدخل الكود.</div>
            <div className="wd-inline">
              <input className="form-input" dir="ltr" placeholder="07XXXXXXXXX" value={phone} onChange={e => setPhone(e.target.value)} />
              <button className="btn btn-primary" disabled={busy || !phone.trim()} onClick={pair}>كود الربط</button>
            </div>
            {code && <div className="wd-code" dir="ltr">{code}</div>}
          </>
        ) : null}
      </div>
    </>
  );
}
