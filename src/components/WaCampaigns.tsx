// ════════════════════════════════════════════════════════════════════════════
// WaCampaigns — «حملات واتساب»: عروض لقائمة أرقام من Excel عبر رقم البوت الرسمي.
// مشترك بين صفحة التطبيق (base = /api/wa-campaigns، موظفو المكتب) ولوحة الماستر
// أدمن (base = /api/sa/wa-campaigns).
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { RefreshCw, Upload, Send, Pause, Play, X, Trash2, Download, ChevronDown } from 'lucide-react';
import '../pages/WarehouseDispatchPage.css';
import './WaCampaigns.css';

const API = import.meta.env.VITE_API_URL || '';

// ─── أنواع ───────────────────────────────────────────────────────────────────
interface TplButton { index: number; type: string; text: string; url: string | null; dynamic: boolean }
interface Template {
  id: string | null; rejectedReason: string | null; quality: string | null;
  name: string; language: string; category: string; status: string; named: boolean;
  header: { format: string; text: string | null } | null; body: string; footer: string | null;
  buttons: TplButton[]; vars: { key: string; label: string }[]; problem: string | null;
}
interface Meta {
  templates: Template[]; templatesError: string | null; optOuts: number; price: number | null; maxRecipients: number;
  marketingPrice: { value: number; source: "actual" | "rate"; volume?: number };
  phone: { phone?: string; name?: string; quality?: string; tier?: string; dailyLimit?: number | null; error?: string };
  canPickOffice?: boolean; offices?: { id: number; name: string }[]; myOfficeId?: number | null;
}
type Counts = Record<'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'order' | 'visit' | 'stop' | 'text' | 'button' | 'billable', number>;
interface Campaign {
  id: number; title: string; templateName: string; templateLang: string; template: Template | null;
  itemName: string | null; status: string; lastError: string | null; total: number; headerMediaId: string | null;
  createdByName: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; replyText: string | null;
  counts: Counts | null; varMap: VarMap[];
  officeId: number | null; officeName: string | null; chatsHidden: boolean;
}
interface Recipient {
  id: number; waId: string; name: string | null; status: string; error: string | null;
  reply: string | null; replyText: string | null; sentAt: string | null; repliedAt: string | null;
}
interface Item { id: number; name: string; price: number | null; warehousePrice: number | null; hasImage: boolean; company: string | null }
type VarSource = 'name' | 'item' | 'price' | 'warehousePrice' | 'text' | 'col';
interface VarMap { key: string; source: VarSource; value: string }
interface Row { waId: string; name: string; extra: Record<string, string> }

// ─── أدوات ───────────────────────────────────────────────────────────────────
/** أرقام عراقية كما تُكتب في الإكسل: 0770…، 770… (الإكسل يحذف الصفر)، +964…، 00964… */
export function normPhone(v: unknown): string {
  let d = String(v ?? '')
    .replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^07\d{9}$/.test(d)) d = '964' + d.slice(1);
  else if (/^7\d{9}$/.test(d)) d = '964' + d;
  return d;
}
const validPhone = (d: string) => (d.startsWith('964') ? /^9647\d{9}$/.test(d) : /^\d{10,15}$/.test(d));

const fmtDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtNum = (n: number | null | undefined) => (n == null ? '' : Number(n).toLocaleString('en-US'));
const fmtMoney = (n: number) => `${n.toFixed(n < 1 ? 3 : n < 10 ? 2 : 0)}`;
const fmtRate = (n: number) => `${n.toFixed(4)}`;

const STATUS_AR: Record<string, string> = {
  draft: 'مسودة', sending: 'قيد الإرسال', paused: 'متوقفة', done: 'اكتملت', cancelled: 'أُلغيت',
};
const R_STATUS_AR: Record<string, string> = {
  pending: 'بالانتظار', sending: 'يُرسل', sent: 'أُرسلت', delivered: 'وصلت', read: 'قُرئت', failed: 'فشلت', skipped: 'تُخطّي',
};
const REPLY_AR: Record<string, string> = { order: 'طلب', visit: 'طلب زيارة', stop: 'أوقف العروض', text: 'ردّ', button: 'ضغط زر' };

const SOURCE_AR: Record<VarSource, string> = {
  name: 'اسم الشخص (من الإكسل)', item: 'اسم الايتم', price: 'سعر المكتب للايتم', warehousePrice: 'سعر المذخر للايتم', text: 'نص ثابت أكتبه', col: 'عمود من الإكسل',
};

function resolveVar(m: VarMap | undefined, row: Row | undefined, item: Item | null): string {
  if (!m) return '';
  switch (m.source) {
    case 'name': return row?.name?.trim() || m.value || 'عميلنا العزيز';
    case 'item': return item?.name || '';
    case 'price': return item?.price != null ? fmtNum(item.price) : '';
    case 'warehousePrice': return item?.warehousePrice != null ? fmtNum(item.warehousePrice) : '';
    case 'col': return row?.extra?.[m.value] ?? '';
    default: return m.value;
  }
}
function fillText(text: string, prefix: string, map: VarMap[], row: Row | undefined, item: Item | null) {
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k) => {
    const m = map.find(x => x.key === `${prefix}:${k}`);
    const v = resolveVar(m, row, item).replace(/[\r\n\t]+/g, ' • ').trim();
    return v || `{{${k}}}`;
  });
}

/** نص القالب الجاهز المقترح — يُلصق في WhatsApp Manager. */
const READY_TEMPLATE = {
  name: 'item_offer',
  body: `مرحباً {{1}} 👋
يسعدنا نبلغك بعرض خاص على *{{2}}*:
{{3}}
⏳ العرض ساري لغاية {{4}}.
للطلب اضغط «اطلب الآن» أو ردّ على هذه الرسالة.`,
  footer: 'لإيقاف رسائل العروض اضغط «إيقاف العروض»',
  samples: ['صيدلية النور', 'Panadol Extra', 'كل 10 علب + 2 بونص وبسعر 9,500 دينار', '30/11/2026'],
};

// ═════════════════════════════════════════════════════════════════════════════
export default function WaCampaigns({ base, token }: { base: string; token: string | null }) {
  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const isForm = init.body instanceof FormData;
    const res = await fetch(`${API}${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.success === false) throw new Error(d.error || d.message || 'خطأ في الاتصال');
    return d;
  }, [base, token]);

  const [tab, setTab] = useState<'list' | 'new' | 'templates' | 'cost' | 'optouts' | 'guide'>('list');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadMeta = useCallback((fresh = false) => {
    api(`/meta${fresh ? '?fresh=1' : ''}`).then(d => setMeta(d)).catch(e => setError(e.message));
  }, [api]);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  const tier = meta?.phone?.dailyLimit;
  // سعر الرسالة المعتمد للتقدير: ما كتبه المستخدم، وإلا المتوسط الفعلي من فواتير Meta، وإلا السعر الرسمي
  const unitPrice = meta ? (meta.price ?? meta.marketingPrice?.value ?? 0.0341) : 0.0341;

  return (
    <div className="wd-page wc-root">
      <div className="wc-head">
        <div className="wd-tabs">
          {([['list', 'الحملات'], ['templates', 'القوالب'], ['cost', 'الكلفة'], ['optouts', `الموقوفون${meta ? ` (${meta.optOuts})` : ''}`], ['guide', 'القواعد']] as const).map(([k, l]) => (
            <button key={k} className={`wd-tab ${tab === k ? 'is-active' : ''}`} onClick={() => { setTab(k); setError(''); setNotice(''); }}>{l}</button>
          ))}
        </div>
        <div className="wd-usage">
          {meta?.phone?.phone && <span className="wd-pill" dir="ltr">{meta.phone.phone}</span>}
          {meta?.phone?.quality && <span className={`wd-pill ${meta.phone.quality === 'GREEN' ? 'wd-pill--ok' : 'wd-pill--paid'}`} title="جودة الرقم">الجودة: {meta.phone.quality === 'GREEN' ? 'ممتازة' : meta.phone.quality === 'YELLOW' ? 'متوسطة' : meta.phone.quality === 'RED' ? 'منخفضة' : meta.phone.quality}</span>}
          {meta?.phone && 'dailyLimit' in meta.phone && <span className="wd-pill" title="حد الإرسال اليومي">الحد: {tier ? `${fmtNum(tier)}/يوم` : 'بلا حد'}</span>}
          <button className={`btn ${tab === 'new' ? 'btn-secondary' : 'btn-primary'}`} onClick={() => { setTab('new'); setError(''); setNotice(''); }}>+ حملة جديدة</button>
        </div>
      </div>

      {error && <div className="wd-note wd-note--warn">{error}</div>}
      {notice && <div className="wd-note wc-note--ok">{notice}</div>}

      {tab === 'list' && <CampaignList api={api} base={base} token={token} onError={setError} unitPrice={unitPrice} meta={meta} />}
      {tab === 'new' && meta && (
        <NewCampaign
          api={api} meta={meta} onError={setError} reloadMeta={() => loadMeta(true)}
          onDone={(msg) => { setNotice(msg); setTab('list'); }}
          onSavePrice={async (p) => { await api('/price', { method: 'PUT', body: JSON.stringify({ price: p }) }); loadMeta(); }}
        />
      )}
      {tab === 'new' && !meta && <div className="wd-empty">جاري التحميل…</div>}
      {tab === 'templates' && meta && <Templates api={api} meta={meta} onError={setError} reloadMeta={() => loadMeta(true)} />}
      {tab === 'cost' && meta && <CostView api={api} meta={meta} unitPrice={unitPrice} onError={setError} />}
      {tab === 'optouts' && <OptOuts api={api} onError={setError} onChange={() => loadMeta()} />}
      {tab === 'guide' && <Guide />}
    </div>
  );
}

// ─── قائمة الحملات ───────────────────────────────────────────────────────────
function CampaignList({ api, base, token, onError, unitPrice, meta }: { api: (p: string, i?: RequestInit) => Promise<any>; base: string; token: string | null; onError: (s: string) => void; unitPrice: number; meta: Meta | null }) {
  const [rows, setRows] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(() => {
    api('/campaigns').then(d => setRows(d.campaigns || [])).catch(e => onError(e.message)).finally(() => setLoading(false));
  }, [api, onError]);
  useEffect(() => { load(); }, [load]);
  const live = rows.some(r => r.status === 'sending');
  useEffect(() => {
    const t = setInterval(load, live ? 5_000 : 30_000);
    return () => clearInterval(t);
  }, [load, live]);

  if (loading) return <div className="wd-empty">جاري التحميل…</div>;
  if (!rows.length) return <div className="wd-empty"><span className="wd-muted">لا حملات بعد</span></div>;

  return (
    <div className="wd-list">
      {rows.map(c => (
        <CampaignCard key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)}
          api={api} base={base} token={token} onError={onError} reload={load} unitPrice={unitPrice} meta={meta} />
      ))}
    </div>
  );
}

function CampaignCard({ c, open, onToggle, api, base, token, onError, reload, unitPrice, meta }: {
  c: Campaign; open: boolean; onToggle: () => void; api: (p: string, i?: RequestInit) => Promise<any>;
  base: string; token: string | null; onError: (s: string) => void; reload: () => void; unitPrice: number; meta: Meta | null;
}) {
  const k = c.counts || ({} as Counts);
  const sent = (k.sent || 0) + (k.delivered || 0) + (k.read || 0);
  const delivered = (k.delivered || 0) + (k.read || 0);
  const done = sent + (k.failed || 0) + (k.skipped || 0);
  const pct = c.total ? Math.round((done / c.total) * 100) : 0;
  const replied = (k.text || 0) + (k.button || 0);

  const act = async (a: 'start' | 'pause' | 'cancel') => {
    if (a === 'cancel' && !confirm('إلغاء الحملة؟ الأرقام التي لم تُرسل بعد لن تُرسل.')) return;
    if (a === 'start' && c.status === 'draft' && !confirm(`إرسال الحملة إلى ${c.total} رقم؟`)) return;
    try { await api(`/campaigns/${c.id}/${a}`, { method: 'POST' }); reload(); } catch (e: any) { onError(e.message); }
  };
  const del = async () => {
    if (!confirm('حذف الحملة وسجلّها نهائياً؟')) return;
    try { await api(`/campaigns/${c.id}`, { method: 'DELETE' }); reload(); } catch (e: any) { onError(e.message); }
  };

  return (
    <div className={`wd-card wc-card--${c.status}`}>
      <button className="wd-card__head" onClick={onToggle}>
        <div className="wd-main">
          <span className="wd-strong">{c.title}</span>
          <span className="wd-sub">
            {[c.itemName, c.templateName, c.createdByName, fmtDate(c.createdAt), meta?.canPickOffice ? (c.officeName || 'الإدارة فقط') : null].filter(Boolean).join(' · ')}
            {c.chatsHidden && (c.officeId || !meta?.canPickOffice) ? ' · الردود مخفية' : ''}
          </span>
          <div className="wc-progress"><span style={{ width: `${pct}%` }} /></div>
          <span className="wc-stats">
            <span><b>{fmtNum(sent)}</b>/{fmtNum(c.total)} أُرسلت</span>
            <span><b>{fmtNum(delivered)}</b> وصلت</span>
            <span><b>{fmtNum(k.read || 0)}</b> قُرئت</span>
            {!!k.failed && <span className="wc-bad"><b>{k.failed}</b> فشلت</span>}
            {!!k.order && <span className="wc-good"><b>{k.order}</b> طلبوا</span>}
            {!!k.visit && <span className="wc-good"><b>{k.visit}</b> زيارة</span>}
            {!!replied && <span><b>{replied}</b> ردّوا</span>}
            {!!k.stop && <span><b>{k.stop}</b> أوقفوا</span>}
            {!!k.billable && <span title={`${fmtNum(k.billable)} رسالة مدفوعة × سعر الرسالة`}><b>{fmtMoney(k.billable * unitPrice)}</b> كلفة</span>}
          </span>
        </div>
        <span className={`wd-status wc-status--${c.status}`}>{STATUS_AR[c.status] || c.status}</span>
        <ChevronDown size={16} className={`wd-chevron ${open ? 'is-open' : ''}`} />
      </button>
      {c.lastError && <div className="wd-note wd-note--warn wc-inner">توقفت: {c.lastError}</div>}
      {open && <CampaignDetail c={c} api={api} base={base} token={token} onError={onError} act={act} del={del} reload={reload} meta={meta} />}
    </div>
  );
}

function CampaignDetail({ c, api, base, token, onError, act, del, reload, meta }: {
  c: Campaign; api: (p: string, i?: RequestInit) => Promise<any>; base: string; token: string | null;
  onError: (s: string) => void; act: (a: 'start' | 'pause' | 'cancel') => void; del: () => void; reload: () => void; meta: Meta | null;
}) {
  const [filter, setFilter] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [rows, setRows] = useState<Recipient[]>([]);
  const [img, setImg] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = filter === 'failed' ? '?status=failed' : filter === 'replied' ? '?reply=any' : filter ? `?reply=${filter}` : '';
    api(`/campaigns/${c.id}${q}`).then(d => setRows(d.recipients || [])).catch(e => onError(e.message));
  }, [api, c.id, filter, onError]);
  useEffect(() => { load(); }, [load, c.counts]);

  const showImg = async () => {
    try {
      const res = await fetch(`${API}${base}/campaigns/${c.id}/image`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('تعذّر جلب الصورة (صور واتساب تنتهي بعد 30 يوماً)');
      setImg(URL.createObjectURL(await res.blob()));
    } catch (e: any) { onError(e.message); }
  };

  const exportXlsx = () => {
    const data = rows.map(r => ({
      'الاسم': r.name || '', 'الرقم': `+${r.waId}`, 'الحالة': R_STATUS_AR[r.status] || r.status,
      'الرد': r.reply ? REPLY_AR[r.reply] : '', 'نص الرد': r.replyText || '', 'وقت الرد': fmtDate(r.repliedAt), 'سبب الفشل': r.error || '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'المستلمون');
    XLSX.writeFile(wb, `حملة-${c.id}.xlsx`);
  };

  const k = c.counts || ({} as Counts);
  return (
    <div className="wc-detail">
      <div className="wd-inline">
        {['draft', 'paused'].includes(c.status) && <button className="btn btn-primary" onClick={() => act('start')}><Play size={14} /> {c.status === 'draft' ? 'إرسال الآن' : 'متابعة الإرسال'}</button>}
        {c.status === 'sending' && <button className="btn btn-secondary" onClick={() => act('pause')}><Pause size={14} /> إيقاف مؤقت</button>}
        {['draft', 'sending', 'paused'].includes(c.status) && <button className="btn btn-secondary" onClick={() => act('cancel')}><X size={14} /> إلغاء</button>}
        {c.headerMediaId && !img && <button className="btn btn-secondary" onClick={showImg}>الصورة</button>}
        {c.status !== 'cancelled' && !adding && <button className="btn btn-secondary" onClick={() => setAdding(true)}><Upload size={14} /> إضافة أرقام</button>}
        <button className="btn btn-secondary" onClick={exportXlsx}><Download size={14} /> تصدير</button>
        <span className="wd-spacer" />
        {c.status !== 'sending' && <button className="btn btn-secondary wc-danger" onClick={del}><Trash2 size={14} /></button>}
      </div>
      <Visibility c={c} api={api} meta={meta} onError={onError} onSaved={reload} />
      {adding && <AddRecipients c={c} api={api} onError={onError} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); load(); }} />}
      {img && <img src={img} alt="" className="wc-img" />}
      {c.template && (
        <div className="wd-muted wd-small">ردّ «اطلب الآن»: {c.replyText || 'الافتراضي'}</div>
      )}
      <div className="wd-chips">
        {([['', 'الكل', c.total], ['order', 'طلبوا', k.order], ['visit', 'زيارة', k.visit], ['replied', 'كل الردود', (k.order || 0) + (k.visit || 0) + (k.text || 0) + (k.button || 0) + (k.stop || 0)], ['failed', 'فشلت', k.failed], ['stop', 'أوقفوا', k.stop]] as const).map(([v, l, n]) => (
          <button key={v} className={`wd-chip ${filter === v ? 'is-active' : ''}`} onClick={() => setFilter(v)}>{l} <b>{n || 0}</b></button>
        ))}
      </div>
      <div className="wc-table-wrap">
        <table className="wc-table">
          <thead><tr><th>الاسم</th><th>الرقم</th><th>الحالة</th><th>الرد</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{r.name || '—'}</td>
                <td dir="ltr" className="wc-num">+{r.waId}</td>
                <td>{R_STATUS_AR[r.status] || r.status}{r.error && <div className="wc-bad wd-small">{r.error}</div>}</td>
                <td>{r.reply ? <><b>{REPLY_AR[r.reply]}</b>{r.replyText && !['order', 'visit'].includes(r.reply) && <div className="wd-small">{r.replyText}</div>}<div className="wd-muted wd-small">{fmtDate(r.repliedAt)}</div></> : ''}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="wd-muted">لا شيء</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length >= 1000 && <div className="wd-muted wd-small">أول 1000 فقط</div>}
    </div>
  );
}

// ─── لمن تظهر الحملة وردودها ─────────────────────────────────────────────────
function Visibility({ c, api, meta, onError, onSaved }: {
  c: Campaign; api: (p: string, i?: RequestInit) => Promise<any>; meta: Meta | null; onError: (s: string) => void; onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const save = async (patch: { officeId?: number | null; chatsHidden?: boolean }) => {
    if (patch.officeId !== undefined && c.officeId && patch.officeId !== c.officeId
      && !confirm('نقل الحملة؟ المكتب الحالي لن يرى الحملة ولا ردودها بعد الآن.')) return;
    setBusy(true);
    try { await api(`/campaigns/${c.id}/visibility`, { method: 'PATCH', body: JSON.stringify(patch) }); onSaved(); }
    catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="wd-inline wc-visibility">
      {meta?.canPickOffice && (
        <label className="wd-small">تظهر لمكتب&nbsp;
          <select className="form-input" disabled={busy} value={c.officeId ?? ''} onChange={e => save({ officeId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">الإدارة فقط</option>
            {(meta.offices || []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      )}
      {(c.officeId || !meta?.canPickOffice) && (
        <label className="wd-small wc-check" title="تظهر في «محادثات واتساب» للمكتب">
          <input type="checkbox" disabled={busy} checked={!c.chatsHidden} onChange={e => save({ chatsHidden: !e.target.checked })} />
          إظهار الردود للمكتب
        </label>
      )}
    </div>
  );
}

// ─── إضافة أرقام لحملة قائمة ─────────────────────────────────────────────────
function AddRecipients({ c, api, onError, onClose, onDone }: {
  c: Campaign; api: (p: string, i?: RequestInit) => Promise<any>; onError: (s: string) => void; onClose: () => void; onDone: () => void;
}) {
  const [mode, setMode] = useState<'manual' | 'excel'>('manual');
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => (mode === 'manual'
    ? parseManual(text)
    : sheet ? parseRows(sheet.raw, sheet.headers, sheet.phoneCol, sheet.nameCol) : { ok: [] as Row[], bad: [] as string[], dup: 0 }), [mode, text, sheet]);
  const colVars = (c.varMap || []).filter(m => m.source === 'col').map(m => m.value);
  const sendNow = c.status === 'done' || c.status === 'sending';

  const submit = async () => {
    if (!confirm(`إضافة ${parsed.ok.length} رقم للحملة «${c.title}»؟${sendNow ? '\nتُرسل لهم نفس الرسالة فوراً.' : ''}`)) return;
    setBusy(true);
    try {
      const d = await api(`/campaigns/${c.id}/recipients`, { method: 'POST', body: JSON.stringify({ recipients: parsed.ok.map(r => ({ waId: r.waId, name: r.name, extra: r.extra })) }) });
      const parts = [`✓ أُضيف ${d.added} رقم`];
      if (d.duplicates) parts.push(`${d.duplicates} موجود سابقاً بالحملة (ما تكرر)`);
      if (d.optedOut) parts.push(`${d.optedOut} أوقف العروض (يُتخطّى)`);
      if (sendNow && d.toSend) parts.push(`جاري الإرسال لـ ${d.toSend} رقم.`);
      else if (c.status === 'paused') parts.push('الحملة متوقفة — اضغط «متابعة الإرسال».');
      else if (c.status === 'draft') parts.push('الحملة مسودة — اضغط «إرسال الآن».');
      alert(parts.join('\n'));
      onDone();
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="wc-add">
      <b>إضافة أرقام</b>
      <div className="wd-chips">
        <button className={`wd-chip ${mode === 'manual' ? 'is-active' : ''}`} onClick={() => setMode('manual')}>كتابة</button>
        <button className={`wd-chip ${mode === 'excel' ? 'is-active' : ''}`} onClick={() => setMode('excel')}>ملف إكسل</button>
      </div>
      {mode === 'manual' ? (
        <textarea className="form-input" rows={5} placeholder={'سطر لكل شخص، مثل:\nد. أحمد علي 07701234567\nصيدلية النور 07801234567'} value={text} onChange={e => setText(e.target.value)} />
      ) : (
        <div className="wd-inline">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={async e => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            try { setSheet(await readSheet(f)); } catch (err: any) { onError(`تعذّر قراءة الملف: ${err.message}`); }
          }} />
          <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}><Upload size={14} /> {sheet ? 'تغيير الملف' : 'رفع ملف'}</button>
          {sheet && (
            <>
              <select className="form-input wd-select" value={sheet.phoneCol} onChange={e => setSheet({ ...sheet, phoneCol: Number(e.target.value) })}>
                <option value={-1}>عمود الرقم…</option>
                {sheet.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
              </select>
              <select className="form-input wd-select" value={sheet.nameCol} onChange={e => setSheet({ ...sheet, nameCol: Number(e.target.value) })}>
                <option value={-1}>بلا اسم</option>
                {sheet.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
              </select>
            </>
          )}
        </div>
      )}
      <div className="wc-stats">
        <span className="wc-good"><b>{parsed.ok.length}</b> صالح</span>
        {!!parsed.dup && <span><b>{parsed.dup}</b> مكرر</span>}
        {!!parsed.bad.length && <span className="wc-bad" title={parsed.bad.slice(0, 20).join('، ')}><b>{parsed.bad.length}</b> غير صالح</span>}
      </div>
      {colVars.length > 0 && mode === 'manual' && (
        <div className="wd-note wd-note--warn">الرسالة تحتاج عمود «{colVars.join('، ')}» — استعمل ملف إكسل.</div>
      )}
      <div className="wd-inline">
        <button className="btn btn-primary" disabled={busy || !parsed.ok.length} onClick={submit}><Send size={14} /> {sendNow ? `إضافة وإرسال لـ ${parsed.ok.length}` : `إضافة ${parsed.ok.length}`}</button>
        <button className="btn btn-secondary" onClick={onClose}>إلغاء</button>
      </div>
    </div>
  );
}

// ─── حملة جديدة ──────────────────────────────────────────────────────────────
const PHONE_HDR = /رقم|هاتف|موبايل|موبايل|جوال|واتس|تلفون|phone|mobile|whats|tel|number/i;
const NAME_HDR = /اسم|الاسم|صيدلية|الصيدلية|زبون|عميل|الدكتور|طبيب|name|customer|pharmacy/i;

interface Sheet { fileName: string; headers: string[]; raw: string[][]; phoneCol: number; nameCol: number }

/** أول ورقة في الإكسل ⇒ عناوين + صفوف + تخمين عمودي الرقم والاسم. */
async function readSheet(f: File): Promise<Sheet> {
  const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const all = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '', raw: false }) as string[][];
  const hi = all.findIndex(r => r.filter(c => String(c).trim()).length >= 1);
  if (hi < 0) throw new Error('الملف فارغ');
  let hdr = all[hi].map((h, i) => String(h).trim() || `عمود ${i + 1}`);
  let body = all.slice(hi + 1);
  // صف أول فيه أرقام هواتف ⇒ لا عناوين
  if (hdr.some(h => validPhone(normPhone(h)))) { body = all.slice(hi); hdr = hdr.map((_, i) => `عمود ${i + 1}`); }
  body = body.filter(r => r.some(c => String(c).trim()));
  const raw = body.map(r => hdr.map((_, i) => String(r[i] ?? '').trim()));
  let pc = hdr.findIndex(h => PHONE_HDR.test(h));
  if (pc < 0) {
    const score = hdr.map((_, i) => raw.slice(0, 50).filter(r => validPhone(normPhone(r[i]))).length);
    pc = score.indexOf(Math.max(...score));
  }
  return { fileName: f.name, headers: hdr, raw, phoneCol: pc, nameCol: hdr.findIndex((h, i) => i !== pc && NAME_HDR.test(h)) };
}

/** صفوف ⇒ أرقام صالحة (موحّدة، بلا تكرار) + غير الصالحة. */
function parseRows(raw: string[][], headers: string[], phoneCol: number, nameCol: number) {
  const ok: Row[] = []; const bad: string[] = []; let dup = 0;
  const seen = new Set<string>();
  if (phoneCol < 0) return { ok, bad, dup };
  for (const r of raw) {
    const p = normPhone(r[phoneCol]);
    if (!validPhone(p)) { if (r[phoneCol]) bad.push(r[phoneCol]); else bad.push(`(فارغ) ${nameCol >= 0 ? r[nameCol] : ''}`); continue; }
    if (seen.has(p)) { dup++; continue; }
    seen.add(p);
    const extra: Record<string, string> = {};
    headers.forEach((h, i) => { if (r[i]) extra[h] = r[i]; });
    ok.push({ waId: p, name: nameCol >= 0 ? r[nameCol] : '', extra });
  }
  return { ok, bad, dup };
}

/** كتابة يدوية: سطر لكل شخص — «الاسم 0770…» أو «0770… الاسم» أو الرقم وحده. */
function parseManual(text: string) {
  const ok: Row[] = []; const bad: string[] = []; let dup = 0;
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/[+0-9٠-٩۰-۹][0-9٠-٩۰-۹\s-]{8,}[0-9٠-٩۰-۹]/);
    const p = m ? normPhone(m[0]) : '';
    if (!m || !validPhone(p)) { bad.push(t); continue; }
    if (seen.has(p)) { dup++; continue; }
    seen.add(p);
    const name = t.replace(m[0], ' ').replace(/[,،:|\t-]+/g, ' ').replace(/\s+/g, ' ').trim();
    ok.push({ waId: p, name, extra: {} });
  }
  return { ok, bad, dup };
}

function NewCampaign({ api, meta, onError, onDone, onSavePrice, reloadMeta }: {
  api: (p: string, i?: RequestInit) => Promise<any>; meta: Meta; onError: (s: string) => void;
  onDone: (msg: string) => void; onSavePrice: (p: number | null) => Promise<void>; reloadMeta: () => void;
}) {
  // 1) الإكسل
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [raw, setRaw] = useState<string[][]>([]);
  const [phoneCol, setPhoneCol] = useState(-1);
  const [nameCol, setNameCol] = useState(-1);
  const [optedOut, setOptedOut] = useState<Set<string>>(new Set());

  // 2) القالب والمتغيّرات
  const approved = meta.templates.filter(t => t.status === 'APPROVED' && !t.problem);
  const [tplKey, setTplKey] = useState('');
  const tpl = meta.templates.find(t => `${t.name}|${t.language}` === tplKey) || null;
  const [varMap, setVarMap] = useState<VarMap[]>([]);

  // 3) الايتم والصورة
  const [itemQ, setItemQ] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [item, setItem] = useState<Item | null>(null);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);

  // 4) الرد والإرسال
  const [title, setTitle] = useState('');
  const [replyText, setReplyText] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [price, setPrice] = useState(meta.price != null ? String(meta.price) : '');
  const [officeId, setOfficeId] = useState<number | null>(meta.myOfficeId ?? null);
  const [chatsHidden, setChatsHidden] = useState(false);

  // ── قراءة الإكسل
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const sh = await readSheet(f);
      setFileName(sh.fileName); setHeaders(sh.headers); setRaw(sh.raw); setPhoneCol(sh.phoneCol); setNameCol(sh.nameCol);
    } catch (e: any) { onError(`تعذّر قراءة الملف: ${e.message}`); }
  };

  const parsed = useMemo(() => parseRows(raw, headers, phoneCol, nameCol), [raw, phoneCol, nameCol, headers]);

  useEffect(() => {
    if (!parsed.ok.length) { setOptedOut(new Set()); return; }
    api('/optouts/check', { method: 'POST', body: JSON.stringify({ waIds: parsed.ok.map(r => r.waId) }) })
      .then(d => setOptedOut(new Set(d.optedOut || []))).catch(() => {});
  }, [api, parsed.ok]);
  const sendable = parsed.ok.filter(r => !optedOut.has(r.waId));

  const downloadSample = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['الاسم', 'الرقم'], ['صيدلية النور', '07701234567'], ['د. أحمد علي', '07801234567']]), 'الأرقام');
    XLSX.writeFile(wb, 'نموذج-أرقام-الحملة.xlsx');
  };

  // ── اختيار القالب ⇒ تعبئة افتراضية للمتغيّرات
  useEffect(() => {
    if (!tpl) { setVarMap([]); return; }
    const bodyVars = tpl.vars.filter(v => v.key.startsWith('b:'));
    setVarMap(tpl.vars.map(v => {
      const bi = bodyVars.indexOf(v);
      const source: VarSource = bi === 0 && nameCol >= 0 ? 'name' : bi === 1 ? 'item' : 'text';
      return { key: v.key, source, value: '' };
    }));
    setMediaId(null); setMediaPreview(null);
  }, [tplKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setVar = (key: string, patch: Partial<VarMap>) => setVarMap(m => m.map(x => (x.key === key ? { ...x, ...patch } : x)));

  // ── الايتمات
  useEffect(() => {
    const t = setTimeout(() => {
      api(`/items?q=${encodeURIComponent(itemQ)}`).then(d => setItems(d.items || [])).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [api, itemQ]);

  const useItemImage = async () => {
    if (!item) return;
    setMediaBusy(true);
    try { const d = await api(`/media/item/${item.id}`, { method: 'POST' }); setMediaId(d.mediaId); setMediaPreview('item'); }
    catch (e: any) { onError(e.message); } finally { setMediaBusy(false); }
  };
  const uploadImage = async (f: File | undefined) => {
    if (!f) return;
    setMediaBusy(true);
    try {
      const fd = new FormData(); fd.append('image', f);
      const d = await api('/media', { method: 'POST', body: fd });
      setMediaId(d.mediaId); setMediaPreview(URL.createObjectURL(f));
    } catch (e: any) { onError(e.message); } finally { setMediaBusy(false); }
  };

  // ── المعاينة
  const sample = sendable[0] || parsed.ok[0];
  const preview = tpl ? {
    header: tpl.header?.format === 'TEXT' && tpl.header.text ? fillText(tpl.header.text, 'h', varMap, sample, item) : null,
    body: fillText(tpl.body, 'b', varMap, sample, item),
  } : null;

  const missing: string[] = [];
  if (!sendable.length) missing.push('قائمة أرقام صالحة');
  if (!tpl) missing.push('القالب');
  if (tpl?.header?.format === 'IMAGE' && !mediaId) missing.push('صورة العرض');
  if (varMap.some(m => ['item', 'price', 'warehousePrice'].includes(m.source)) && !item) missing.push('الايتم');
  for (const m of varMap) if (['text', 'col'].includes(m.source) && !m.value.trim()) missing.push(`قيمة ${tpl?.vars.find(v => v.key === m.key)?.label}`);
  const autoTitle = `${item?.name || tpl?.name || 'عرض'} — ${new Date().toLocaleDateString('en-GB')}`;

  const payload = () => ({
    title: title.trim() || autoTitle,
    templateName: tpl?.name, templateLang: tpl?.language,
    varMap, headerMediaId: mediaId, itemId: item?.id ?? null, replyText,
  });

  const test = async () => {
    setBusy(true); setTestMsg('');
    try {
      await api('/test', { method: 'POST', body: JSON.stringify({ ...payload(), waId: normPhone(testPhone), sample: sample ? { name: sample.name, extra: sample.extra } : null }) });
      setTestMsg('أُرسلت التجربة');
    } catch (e: any) { setTestMsg(e.message); } finally { setBusy(false); }
  };

  const priceNum = price.trim() ? Number(price) : null;
  const effPrice = priceNum != null && Number.isFinite(priceNum) ? priceNum : meta.marketingPrice.value;
  const cost = effPrice * sendable.length;

  const create = async (start: boolean) => {
    if (start && !confirm(`إرسال العرض إلى ${sendable.length} رقم الآن؟\nالكلفة التقديرية ${fmtMoney(cost)}`)) return;
    setBusy(true);
    try {
      await api('/campaigns', { method: 'POST', body: JSON.stringify({ ...payload(), start, chatsHidden, ...(meta.canPickOffice ? { officeId } : {}), recipients: parsed.ok.map(r => ({ waId: r.waId, name: r.name, extra: r.extra })) }) });
      onDone(start ? `بدأ الإرسال إلى ${sendable.length} رقم` : 'حُفظت كمسودة');
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="wc-wizard">
      {/* 1 */}
      <section className="wc-step">
        <h3><span>1</span> الأرقام</h3>
        <div className="wd-inline">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}><Upload size={14} /> {fileName ? 'تغيير الملف' : 'رفع ملف إكسل'}</button>
          {fileName && <span className="wd-muted">{fileName} · {raw.length} صف</span>}
          <button className="btn btn-secondary" onClick={downloadSample} title="نموذج فارغ"><Download size={14} /> نموذج</button>
        </div>
        {headers.length > 0 && (
          <>
            <div className="wc-grid2">
              <label>عمود الرقم
                <select className="form-input" value={phoneCol} onChange={e => setPhoneCol(Number(e.target.value))}>
                  <option value={-1}>— اختر —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
              </label>
              <label>عمود الاسم
                <select className="form-input" value={nameCol} onChange={e => setNameCol(Number(e.target.value))}>
                  <option value={-1}>— بلا اسم —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
              </label>
            </div>
            <div className="wc-stats">
              <span className="wc-good"><b>{sendable.length}</b> سيُرسل لهم</span>
              {!!optedOut.size && <span><b>{optedOut.size}</b> موقوفون (يُتخطّون)</span>}
              {!!parsed.dup && <span><b>{parsed.dup}</b> مكرر</span>}
              {!!parsed.bad.length && <span className="wc-bad" title={parsed.bad.slice(0, 20).join('، ')}><b>{parsed.bad.length}</b> غير صالح</span>}
            </div>
            {sendable.length > meta.maxRecipients && <div className="wd-note wd-note--warn">الحد {fmtNum(meta.maxRecipients)} رقم للحملة — قسّم الملف.</div>}
            {meta.phone.dailyLimit && sendable.length > meta.phone.dailyLimit && (
              <div className="wd-note wd-note--warn">أكبر من الحد اليومي ({fmtNum(meta.phone.dailyLimit)}) — قسّمها على أكثر من يوم.</div>
            )}
          </>
        )}
      </section>

      {/* 2 */}
      <section className="wc-step">
        <h3><span>2</span> القالب <button className="btn btn-secondary wc-mini" onClick={reloadMeta} title="تحديث من Meta"><RefreshCw size={13} /></button></h3>
        {meta.templatesError && <div className="wd-note wd-note--warn">تعذّر جلب القوالب: {meta.templatesError}</div>}
        <select className="form-input" value={tplKey} onChange={e => setTplKey(e.target.value)}>
          <option value="">— اختر قالباً معتمداً —</option>
          {approved.map(t => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language}) {t.category === 'MARKETING' ? '· تسويقي' : t.category === 'UTILITY' ? '· خدمي' : `· ${t.category}`}</option>)}
        </select>
        {!approved.some(t => t.category === 'MARKETING') && (
          <div className="wd-muted wd-small">لا يوجد قالب تسويقي معتمد — أنشئه من «القوالب».</div>
        )}
        {meta.templates.filter(t => t.status !== 'APPROVED').length > 0 && (
          <div className="wd-muted wd-small">غير معتمدة: {meta.templates.filter(t => t.status !== 'APPROVED').map(t => `${t.name} (${t.status === 'PENDING' ? 'قيد المراجعة' : t.status === 'REJECTED' ? 'مرفوض' : t.status})`).join('، ')}</div>
        )}
        {tpl && tpl.category !== 'MARKETING' && <div className="wd-note wd-note--warn">قالب غير تسويقي — العروض به تخالف سياسة Meta.</div>}
      </section>

      {/* 3 */}
      {tpl && (
        <section className="wc-step">
          <h3><span>3</span> الايتم والمتغيّرات</h3>
          <div className="wc-item-pick">
            <input className="form-input" placeholder="ابحث عن الايتم…" value={itemQ} onChange={e => setItemQ(e.target.value)} />
            <div className="wc-item-list">
              {items.map(i => (
                <button key={i.id} className={`wc-item ${item?.id === i.id ? 'is-active' : ''}`} onClick={() => { setItem(i); if (mediaPreview === 'item') { setMediaId(null); setMediaPreview(null); } }}>
                  <b>{i.name}</b>
                  <span className="wd-muted wd-small">{i.company || ''}{i.price != null ? ` · ${fmtNum(i.price)}` : ''}{i.hasImage ? ' · صورة' : ''}</span>
                </button>
              ))}
              {!items.length && <span className="wd-muted wd-small">لا ايتمات</span>}
            </div>
          </div>
          {item && <div className="wd-small">الايتم: <b>{item.name}</b>{item.price != null && ` · سعر المكتب ${fmtNum(item.price)}`}{item.warehousePrice != null && ` · سعر المذخر ${fmtNum(item.warehousePrice)}`}</div>}

          {tpl.header?.format === 'IMAGE' && (
            <div className="wc-media">
              <b>صورة العرض</b>
              <div className="wd-inline">
                {item?.hasImage && <button className="btn btn-secondary" disabled={mediaBusy} onClick={useItemImage}>استعمل صورة الايتم</button>}
                <label className="btn btn-secondary">
                  ارفع صورة (JPG/PNG)
                  <input type="file" accept="image/jpeg,image/png" hidden onChange={e => { uploadImage(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {mediaBusy && <span className="wd-muted">جاري الرفع…</span>}
                {mediaId && <span className="wc-good">الصورة جاهزة</span>}
              </div>
              {mediaPreview && mediaPreview !== 'item' && <img src={mediaPreview} alt="" className="wc-img" />}
            </div>
          )}

          {tpl.vars.map(v => {
            const m = varMap.find(x => x.key === v.key);
            if (!m) return null;
            return (
              <div key={v.key} className="wc-var">
                <span className="wc-var__k">{v.label}</span>
                <select className="form-input" value={m.source} onChange={e => setVar(v.key, { source: e.target.value as VarSource, value: '' })}>
                  {(Object.keys(SOURCE_AR) as VarSource[]).map(s => <option key={s} value={s} disabled={(s === 'col' || s === 'name') && !headers.length}>{SOURCE_AR[s]}</option>)}
                </select>
                {m.source === 'text' && <input className="form-input" placeholder="النص…" value={m.value} onChange={e => setVar(v.key, { value: e.target.value })} />}
                {m.source === 'col' && (
                  <select className="form-input" value={m.value} onChange={e => setVar(v.key, { value: e.target.value })}>
                    <option value="">— العمود —</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                )}
                {m.source === 'name' && <input className="form-input" placeholder="إن كان الاسم فارغاً: عميلنا العزيز" value={m.value} onChange={e => setVar(v.key, { value: e.target.value })} />}
              </div>
            );
          })}
        </section>
      )}

      {/* 4 */}
      {tpl && (
        <section className="wc-step">
          <h3><span>4</span> الإرسال</h3>
          <div className="wc-preview-wrap">
            <div className="wc-bubble">
              {tpl.header?.format === 'IMAGE' && (mediaPreview && mediaPreview !== 'item' ? <img src={mediaPreview} alt="" /> : <div className="wc-bubble__img">{mediaId ? 'صورة الايتم' : 'صورة'}</div>)}
              {preview?.header && <b>{preview.header}</b>}
              <div className="wc-bubble__body">{preview?.body}</div>
              {tpl.footer && <div className="wc-bubble__foot">{tpl.footer}</div>}
              {tpl.buttons.map(b => <div key={b.index} className="wc-bubble__btn">{b.type === 'URL' ? '🔗 ' : ''}{b.text}</div>)}
            </div>
            <div className="wc-side">
              <label>اسم الحملة
                <input className="form-input" placeholder={autoTitle} value={title} onChange={e => setTitle(e.target.value)} />
              </label>
              {tpl.buttons.some(b => b.type === 'QUICK_REPLY') && (
                <label>ردّ «اطلب الآن»
                  <textarea className="form-input" rows={3} placeholder="شكراً لاهتمامك 🌷 تم تسجيل طلبك وسيتواصل معك فريقنا قريباً." value={replyText} onChange={e => setReplyText(e.target.value)} />
                </label>
              )}
              {meta.canPickOffice && (
                <label>المكتب
                  <select className="form-input" value={officeId ?? ''} onChange={e => setOfficeId(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">الإدارة فقط</option>
                    {(meta.offices || []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </label>
              )}
              {(officeId || !meta.canPickOffice) && (
                <label className="wc-check" title="تظهر في «محادثات واتساب» للمكتب">
                  <input type="checkbox" checked={!chatsHidden} onChange={e => setChatsHidden(!e.target.checked)} />
                  إظهار الردود للمكتب
                </label>
              )}
              <div className="wc-cost">
                <label>سعر الرسالة ($)
                  <input className="form-input" inputMode="decimal" placeholder={meta.marketingPrice.value.toFixed(4)} value={price} onChange={e => setPrice(e.target.value)} onBlur={() => onSavePrice(price.trim() ? Number(price) : null).catch(() => {})} />
                </label>
                <span title={priceNum != null ? 'بالسعر الذي كتبته' : meta.marketingPrice.source === 'actual' ? `متوسط فعلي من فواتيركم (${meta.marketingPrice.volume} رسالة)` : 'السعر الرسمي في العراق'}>
                  الكلفة: <b>{fmtMoney(cost)}</b> لـ {sendable.length} رسالة
                </span>
              </div>
              <div className="wd-inline">
                <input className="form-input wc-phone" dir="ltr" placeholder="07xxxxxxxxx" value={testPhone} onChange={e => setTestPhone(e.target.value)} />
                <button className="btn btn-secondary" disabled={busy || !!missing.filter(x => x !== 'قائمة أرقام صالحة').length || !validPhone(normPhone(testPhone))} onClick={test}><Send size={14} /> إرسال تجربة</button>
              </div>
              {testMsg && <div className="wd-small">{testMsg}</div>}
            </div>
          </div>
          {missing.length > 0 && <div className="wd-muted">ناقص: {missing.join('، ')}</div>}
          <div className="wd-inline">
            <button className="btn btn-primary" disabled={busy || missing.length > 0 || sendable.length > meta.maxRecipients} onClick={() => create(true)}><Send size={14} /> إرسال لـ {sendable.length} رقم</button>
            <button className="btn btn-secondary" disabled={busy || missing.length > 0 || sendable.length > meta.maxRecipients} onClick={() => create(false)}>حفظ كمسودة</button>
          </div>
        </section>
      )}
    </div>
  );
}

// ─── الموقوفون ───────────────────────────────────────────────────────────────
function OptOuts({ api, onError, onChange }: { api: (p: string, i?: RequestInit) => Promise<any>; onError: (s: string) => void; onChange: () => void }) {
  const [rows, setRows] = useState<{ waId: string; source: string | null; createdAt: string }[]>([]);
  const [add, setAdd] = useState('');
  const load = useCallback(() => { api('/optouts').then(d => setRows(d.optOuts || [])).catch(e => onError(e.message)); }, [api, onError]);
  useEffect(() => { load(); }, [load]);
  const SRC: Record<string, string> = { button: 'ضغط «إيقاف العروض»', text: 'كتب «ايقاف»', meta: 'أوقفها من واتساب', manual: 'أُضيف يدوياً' };
  return (
    <>
      <div className="wd-inline">
        <input className="form-input wc-phone" dir="ltr" placeholder="07xxxxxxxxx" value={add} onChange={e => setAdd(e.target.value)} />
        <button className="btn btn-secondary" disabled={!validPhone(normPhone(add))} onClick={async () => {
          try { await api('/optouts', { method: 'POST', body: JSON.stringify({ waId: normPhone(add) }) }); setAdd(''); load(); onChange(); } catch (e: any) { onError(e.message); }
        }}>إضافة</button>
      </div>
      <div className="wc-table-wrap">
        <table className="wc-table">
          <thead><tr><th>الرقم</th><th>السبب</th><th>التاريخ</th><th /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.waId}>
                <td dir="ltr" className="wc-num">+{r.waId}</td>
                <td>{SRC[r.source || ''] || r.source || '—'}</td>
                <td>{fmtDate(r.createdAt)}</td>
                <td><button className="btn btn-secondary wc-mini" title="السماح بالعروض مجدداً" onClick={async () => {
                  if (!confirm('إعادة السماح بإرسال العروض لهذا الرقم؟ تأكد أنه طلب ذلك بنفسه.')) return;
                  try { await api(`/optouts/${r.waId}`, { method: 'DELETE' }); load(); onChange(); } catch (e: any) { onError(e.message); }
                }}><X size={13} /></button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="wd-muted">لا أحد</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── القوالب: إنشاء في Meta من التطبيق ───────────────────────────────────────
const TPL_STATUS_AR: Record<string, string> = {
  APPROVED: 'معتمد', PENDING: 'قيد المراجعة', REJECTED: 'مرفوض', PAUSED: 'موقوف', DISABLED: 'معطّل', IN_APPEAL: 'اعتراض',
};
const REJECT_AR: Record<string, string> = {
  INVALID_FORMAT: 'صيغة غير صحيحة (متغيّرات أو أمثلة)', TAG_CONTENT_MISMATCH: 'المحتوى لا يطابق الفئة المختارة',
  ABUSIVE_CONTENT: 'محتوى مخالف', SCAM: 'يشبه الاحتيال', PROMOTIONAL: 'محتوى ترويجي في فئة غير تسويقية', INCORRECT_CATEGORY: 'الفئة غير صحيحة',
};

function Templates({ api, meta, onError, reloadMeta }: { api: (p: string, i?: RequestInit) => Promise<any>; meta: Meta; onError: (s: string) => void; reloadMeta: () => void }) {
  const [form, setForm] = useState(false);
  const pending = meta.templates.some(t => t.status === 'PENDING');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(reloadMeta, 30_000);
    return () => clearInterval(t);
  }, [pending, reloadMeta]);

  const del = async (t: Template) => {
    if (!confirm(`حذف القالب «${t.name}» من Meta؟ لا يمكن استعمال نفس الاسم خلال 30 يوماً.`)) return;
    try { await api(`/templates/${encodeURIComponent(t.name)}`, { method: 'DELETE' }); reloadMeta(); } catch (e: any) { onError(e.message); }
  };

  return (
    <div className="wc-wizard">
      <div className="wd-inline">
        {!form && <button className="btn btn-primary" onClick={() => setForm(true)}>+ قالب جديد</button>}
        <button className="btn btn-secondary wd-icon-btn" onClick={reloadMeta} title="تحديث"><RefreshCw size={14} /></button>
        {pending && <span className="wd-muted wd-small">يتحدّث تلقائياً</span>}
      </div>
      {form && <TemplateForm api={api} onError={onError} onCancel={() => setForm(false)} onCreated={() => { setForm(false); reloadMeta(); }} existing={meta.templates.map(t => t.name)} />}
      {meta.templatesError && <div className="wd-note wd-note--warn">تعذّر جلب القوالب: {meta.templatesError}</div>}
      <div className="wd-list">
        {meta.templates.map(t => (
          <div key={`${t.name}|${t.language}`} className="wd-card">
            <div className="wc-tpl">
              <div className="wd-inline">
                <b dir="ltr">{t.name}</b>
                <span className="wd-pill">{t.language}</span>
                <span className="wd-pill">{t.category === 'MARKETING' ? 'تسويقي' : t.category === 'UTILITY' ? 'خدمي' : t.category === 'AUTHENTICATION' ? 'تحقق' : t.category}</span>
                <span className={`wd-status wc-tstat--${t.status.toLowerCase()}`}>{TPL_STATUS_AR[t.status] || t.status}</span>
                {t.quality && t.quality !== 'UNKNOWN' && <span className="wd-pill">جودة: {t.quality === 'GREEN' ? 'عالية' : t.quality === 'YELLOW' ? 'متوسطة' : t.quality === 'RED' ? 'منخفضة' : t.quality}</span>}
                <span className="wd-spacer" />
                {t.category === 'MARKETING' && <button className="btn btn-secondary wc-mini wc-danger" title="حذف من Meta" onClick={() => del(t)}><Trash2 size={13} /></button>}
              </div>
              {t.rejectedReason && <div className="wc-bad wd-small">سبب الرفض: {REJECT_AR[t.rejectedReason] || t.rejectedReason}</div>}
              {t.header?.format === 'IMAGE' && <div className="wd-muted wd-small">مع صورة</div>}
              <div className="wc-tpl__body">{t.body}</div>
              {(t.footer || t.buttons.length > 0) && <div className="wd-muted wd-small">{t.footer}{t.buttons.length ? ` · أزرار: ${t.buttons.map(b => b.text).join(' / ')}` : ''}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateForm({ api, onError, onCancel, onCreated, existing }: {
  api: (p: string, i?: RequestInit) => Promise<any>; onError: (s: string) => void; onCancel: () => void; onCreated: () => void; existing: string[];
}) {
  const firstName = existing.includes(READY_TEMPLATE.name) ? `${READY_TEMPLATE.name}_${existing.filter(n => n.startsWith(READY_TEMPLATE.name)).length + 1}` : READY_TEMPLATE.name;
  const [name, setName] = useState(firstName);
  const [category, setCategory] = useState<'MARKETING' | 'UTILITY'>('MARKETING');
  const [headerType, setHeaderType] = useState<'image' | 'text' | 'none'>('image');
  const [headerText, setHeaderText] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [body, setBody] = useState(READY_TEMPLATE.body);
  const [samples, setSamples] = useState<string[]>(READY_TEMPLATE.samples);
  const [footer, setFooter] = useState(READY_TEMPLATE.footer);
  const [buttons, setButtons] = useState<string[]>(['اطلب الآن', 'إيقاف العروض']);
  const [busy, setBusy] = useState(false);

  const varNums = useMemo(() => [...new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => Number(m[1])))].sort((a, b) => a - b), [body]);
  const nextVar = (varNums[varNums.length - 1] || 0) + 1;
  const nameOk = /^[a-z0-9_]{1,60}$/.test(name);
  const dup = existing.includes(name);

  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('data', JSON.stringify({ name, category, language: 'ar', headerType, headerText, bodyText: body, samples, footer, buttons }));
      if (headerType === 'image' && image) fd.append('image', image);
      await api('/templates', { method: 'POST', body: fd });
      alert('أُرسل القالب للمراجعة');
      onCreated();
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <section className="wc-step">
      <h3>قالب جديد</h3>
      <div className="wc-grid2">
        <label>اسم القالب (إنكليزي صغير و _ فقط)
          <input className="form-input" dir="ltr" value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/[\s-]+/g, '_'))} />
          {!nameOk && <span className="wc-bad wd-small">حروف a-z وأرقام و _ فقط</span>}
          {dup && <span className="wc-bad wd-small">هذا الاسم موجود — اختر اسماً آخر</span>}
        </label>
        <label>الفئة
          <select className="form-input" value={category} onChange={e => setCategory(e.target.value as 'MARKETING' | 'UTILITY')}>
            <option value="MARKETING">تسويقي — عروض وترويج (الصحيح للعروض)</option>
            <option value="UTILITY">خدمي — إشعارات طلبيات/حسابات فقط بلا ترويج</option>
          </select>
        </label>
      </div>
      <label>رأس الرسالة
        <select className="form-input" value={headerType} onChange={e => setHeaderType(e.target.value as 'image' | 'text' | 'none')}>
          <option value="image">صورة (صورة الايتم تُرسل مع كل حملة)</option>
          <option value="text">عنوان نصّي</option>
          <option value="none">بلا رأس</option>
        </select>
      </label>
      {headerType === 'image' && (
        <div className="wc-media">
          <span className="wd-small wd-muted">صورة مثال للمراجعة فقط</span>
          <div className="wd-inline">
            <label className="btn btn-secondary">اختر صورة
              <input type="file" accept="image/jpeg,image/png" hidden onChange={e => { const f = e.target.files?.[0] || null; setImage(f); setImgUrl(f ? URL.createObjectURL(f) : null); e.target.value = ''; }} />
            </label>
            {image && <span className="wc-good">{image.name}</span>}
          </div>
          {imgUrl && <img src={imgUrl} alt="" className="wc-img" />}
        </div>
      )}
      {headerType === 'text' && <input className="form-input" maxLength={60} placeholder="مثلاً: عرض الأسبوع 🔥" value={headerText} onChange={e => setHeaderText(e.target.value)} />}
      <label>نص الرسالة
        <textarea className="form-input" rows={7} maxLength={1024} value={body} onChange={e => setBody(e.target.value)} />
      </label>
      <div className="wd-inline">
        <button className="btn btn-secondary wc-mini" onClick={() => setBody(b => `${b}{{${nextVar}}}`)}>+ متغيّر {`{{${nextVar}}}`}</button>
        <span className="wd-muted wd-small">{body.length}/1024 · لا تبدأ ولا تنتهِ بمتغيّر</span>
      </div>
      {varNums.length > 0 && (
        <div className="wc-samples">
          <span className="wd-small wd-muted">أمثلة للمراجعة</span>
          {varNums.map((n, i) => (
            <div key={n} className="wc-sample">
              <span className="wc-var__k">{`{{${n}}}`}</span>
              <input className="form-input" value={samples[i] || ''} onChange={e => setSamples(s => { const c = [...s]; c[i] = e.target.value; return c; })} />
            </div>
          ))}
        </div>
      )}
      <label>التذييل
        <input className="form-input" maxLength={60} value={footer} onChange={e => setFooter(e.target.value)} />
      </label>
      <div className="wc-samples">
        <span className="wd-small wd-muted" title="«إيقاف» يوقف العروض، «زيارة» طلب زيارة، وغيرهما «طلب»">الأزرار (حتى 3)</span>
        {buttons.map((b, i) => (
          <div key={i} className="wd-inline">
            <input className="form-input wc-phone" maxLength={25} value={b} onChange={e => setButtons(x => x.map((y, j) => (j === i ? e.target.value : y)))} />
            <button className="btn btn-secondary wc-mini" onClick={() => setButtons(x => x.filter((_, j) => j !== i))}><X size={13} /></button>
          </div>
        ))}
        {buttons.length < 3 && <button className="btn btn-secondary wc-mini wd-self-start" onClick={() => setButtons(x => [...x, ''])}>+ زر</button>}
      </div>
      <div className="wd-inline">
        <button className="btn btn-primary" disabled={busy || !nameOk || dup || !body.trim() || (headerType === 'image' && !image)} onClick={submit}><Send size={14} /> {busy ? '…' : 'إرسال للموافقة'}</button>
        <button className="btn btn-secondary" onClick={onCancel}>إلغاء</button>
      </div>
    </section>
  );
}

// ─── الكلفة الفعلية ──────────────────────────────────────────────────────────
const CAT_AR: Record<string, string> = {
  marketing: 'تسويق', utility: 'خدمي', authentication: 'رموز التحقق', service: 'ردود المحادثة', other: 'أخرى',
};
interface CostRow { date: string; category: string; type: string; country: string | null; volume: number; cost: number }
interface CostData { rows: CostRow[]; byCategory: Record<string, { volume: number; cost: number }>; totalCost: number; rates: { marketing: number; utility: number } }

function CostView({ api, meta, unitPrice, onError }: { api: (p: string, i?: RequestInit) => Promise<any>; meta: Meta; unitPrice: number; onError: (s: string) => void }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CostData | null>(null);
  const [camps, setCamps] = useState<Campaign[]>([]);
  useEffect(() => {
    setData(null);
    api(`/cost?days=${days}`).then(setData).catch(e => onError(e.message));
  }, [api, days, onError]);
  useEffect(() => { api('/campaigns').then(d => setCamps(d.campaigns || [])).catch(() => {}); }, [api]);

  const byDay = useMemo(() => {
    const m = new Map<string, { volume: number; cost: number; cats: Record<string, number> }>();
    for (const r of data?.rows || []) {
      const d = m.get(r.date) || { volume: 0, cost: 0, cats: {} };
      d.volume += r.volume; d.cost += r.cost; d.cats[r.category] = (d.cats[r.category] || 0) + r.volume;
      m.set(r.date, d);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data]);
  const campCost = camps.filter(c => c.counts?.billable).map(c => ({ c, n: c.counts!.billable, cost: c.counts!.billable * unitPrice }));

  return (
    <div className="wc-wizard">
      <div className="wd-inline">
        <div className="wd-seg">
          {[7, 30, 90].map(d => <button key={d} className={`wd-seg__btn ${days === d ? 'is-active' : ''}`} onClick={() => setDays(d)}>{d} يوم</button>)}
        </div>
        {data && <span className="wd-strong">المجموع: {fmtMoney(data.totalCost)}</span>}
        <span className="wd-muted wd-small" title="أسعار Meta الرسمية في العراق">تسويق {fmtRate(data?.rates.marketing ?? 0.0341)} · خدمي {fmtRate(data?.rates.utility ?? 0.0079)}</span>
      </div>
      {!data && <div className="wd-empty">جاري التحميل…</div>}
      {data && (
        <>
          <div className="wc-cost-cards">
            {Object.entries(data.byCategory).sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => (
              <div key={k} className="wc-cost-card">
                <span className="wd-small">{CAT_AR[k] || k}</span>
                <b>{fmtMoney(v.cost)}</b>
                <span className="wd-muted wd-small">{fmtNum(v.volume)} رسالة · {v.volume ? fmtRate(v.cost / v.volume) : '—'}</span>
              </div>
            ))}
            {!Object.keys(data.byCategory).length && <div className="wd-muted">لا رسائل مدفوعة</div>}
          </div>
          {byDay.length > 0 && (
            <div className="wc-table-wrap">
              <table className="wc-table">
                <thead><tr><th>اليوم</th><th>الرسائل</th><th>التفصيل</th><th>الكلفة</th></tr></thead>
                <tbody>
                  {byDay.map(([d, v]) => (
                    <tr key={d}>
                      <td className="wc-num">{d}</td>
                      <td>{fmtNum(v.volume)}</td>
                      <td className="wd-small">{Object.entries(v.cats).map(([c, n]) => `${(CAT_AR[c] || c)}: ${n}`).join(' · ')}</td>
                      <td><b>{fmtMoney(v.cost)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <section className="wc-step">
        <h3>كلفة كل حملة</h3>
        <span className="wd-muted wd-small">الرسائل المدفوعة × {fmtRate(unitPrice)}</span>
        {campCost.length ? (
          <div className="wc-table-wrap">
            <table className="wc-table">
              <thead><tr><th>الحملة</th><th>المدفوعة</th><th>الكلفة</th><th>طلبوا</th><th>كلفة كل طلب</th></tr></thead>
              <tbody>
                {campCost.map(({ c, n, cost }) => (
                  <tr key={c.id}>
                    <td>{c.title}<div className="wd-muted wd-small">{fmtDate(c.createdAt)}</div></td>
                    <td>{fmtNum(n)}</td>
                    <td><b>{fmtMoney(cost)}</b></td>
                    <td>{c.counts?.order || 0}</td>
                    <td>{c.counts?.order ? fmtMoney(cost / c.counts.order) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="wd-muted">لا حملات مُرسلة بعد</div>}
      </section>
    </div>
  );
}

// ─── الدليل ──────────────────────────────────────────────────────────────────
function Guide() {
  return (
    <div className="wc-guide">
      <section className="wc-step">
        <h3>كيف تبدأ</h3>
        <ol>
          <li>من تبويب <b>«القوالب»</b> اضغط «+ قالب جديد». النموذج معبّأ بالقالب الجاهز: اختر صورة مثال واضغط «إرسال لـ Meta للموافقة».</li>
          <li>انتظر لما تصير حالته <b>✓ معتمد</b> (عادة من دقائق لساعات).</li>
          <li>من <b>«+ حملة جديدة»</b> ارفع الإكسل واختر القالب والايتم، واربط المتغيّرات: {'{{1}}'} = اسم الشخص، {'{{2}}'} = اسم الايتم، {'{{3}}'} = تفاصيل العرض، {'{{4}}'} = تاريخ النهاية.</li>
          <li>أرسل تجربة لرقمك أولاً، وبعدها أرسل للكل.</li>
        </ol>
      </section>
      <section className="wc-step">
        <h3>تغيير القالب</h3>
        <ul>
          <li><b>تغيير الايتم أو السعر أو تفاصيل العرض أو التاريخ لا يحتاج تغيير القالب.</b> هذه متغيّرات تكتبها في كل حملة.</li>
          <li><b>قالب جديد:</b> تقدر تسوي أي عدد من القوالب (عرض شهري، ايتم جديد، تهنئة عيد…)، وكل قالب ياخذ موافقة Meta مستقلة. بعد الموافقة اضغط 🔄 في الحملة الجديدة فيظهر القالب.</li>
          <li><b>تعديل قالب معتمد:</b> Meta تسمح بتعديله مرة واحدة كل 24 ساعة، وبحد أقصى 10 مرات كل 30 يوماً. كل تعديل يرجع للمراجعة، ولا تقدر تغيّر الفئة أو اللغة. الحملات الجارية تبقى على النسخة اللي بدأت بيها.</li>
          <li><b>اسم القالب المحذوف</b> ما يتكرر خلال 30 يوماً، فاعطِ القالب الجديد اسماً جديداً (مثل item_offer_v2).</li>
        </ul>
      </section>
      <section className="wc-step">
        <h3>قواعد Meta</h3>
        <ul>
          <li>أرسل فقط لمن وافق يستلم منكم، مثل زبائنكم والصيدليات اللي تتعاملون وياها. البلاغات والحظر تنزّل «جودة الرقم»، وإذا نزلت كثيراً توقف Meta القالب أو تقلل حد الإرسال.</li>
          <li>كل رسالة تسويقية مدفوعة وتنسحب من بطاقة حساب Meta. الردود داخل المحادثة خلال 24 ساعة مجانية.</li>
          <li>بعض الرسائل ترجع «لم تسلّمها Meta (131049)». Meta تحدد كم رسالة تسويقية يستلم الشخص من كل الشركات، وهذا طبيعي حتى لو الرقم صحيح.</li>
          <li>من يضغط «إيقاف العروض» أو يكتب «ايقاف» ما تصله أي حملة بعدها.</li>
          <li>ردود الزبائن تظهر في الحملة نفسها (🛒 طلبوا، 💬 ردّوا)، وتظهر في «محادثات واتساب» حتى تردّ عليهم من رقم البوت.</li>
        </ul>
      </section>
    </div>
  );
}
