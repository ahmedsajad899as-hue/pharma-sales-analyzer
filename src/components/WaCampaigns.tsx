// ════════════════════════════════════════════════════════════════════════════
// WaCampaigns — «حملات واتساب»: عروض لقائمة أرقام من Excel عبر رقم البوت الرسمي.
// مشترك بين صفحة التطبيق (base = /api/wa-campaigns، موظفو المكتب) ولوحة الماستر
// أدمن (base = /api/sa/wa-campaigns).
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { RefreshCw, Upload, Send, Pause, Play, X, Trash2, Copy, Download, ChevronDown } from 'lucide-react';
import '../pages/WarehouseDispatchPage.css';
import './WaCampaigns.css';

const API = import.meta.env.VITE_API_URL || '';

// ─── أنواع ───────────────────────────────────────────────────────────────────
interface TplButton { index: number; type: string; text: string; url: string | null; dynamic: boolean }
interface Template {
  name: string; language: string; category: string; status: string; named: boolean;
  header: { format: string; text: string | null } | null; body: string; footer: string | null;
  buttons: TplButton[]; vars: { key: string; label: string }[]; problem: string | null;
}
interface Meta {
  templates: Template[]; templatesError: string | null; optOuts: number; price: number | null; maxRecipients: number;
  phone: { phone?: string; name?: string; quality?: string; tier?: string; dailyLimit?: number | null; error?: string };
}
type Counts = Record<'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'order' | 'stop' | 'text' | 'button', number>;
interface Campaign {
  id: number; title: string; templateName: string; templateLang: string; template: Template | null;
  itemName: string | null; status: string; lastError: string | null; total: number; headerMediaId: string | null;
  createdByName: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; replyText: string | null;
  counts: Counts | null;
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
const fmtMoney = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

const STATUS_AR: Record<string, string> = {
  draft: 'مسودة', sending: 'قيد الإرسال', paused: 'متوقفة', done: 'اكتملت', cancelled: 'أُلغيت',
};
const R_STATUS_AR: Record<string, string> = {
  pending: '⏳ بالانتظار', sending: '… يُرسل', sent: '✓ أُرسلت', delivered: '✓✓ وصلت', read: '👁️ قُرئت', failed: '❌ فشلت', skipped: '⛔ تُخطّي',
};
const REPLY_AR: Record<string, string> = { order: '🛒 طلب', stop: '⛔ أوقف العروض', text: '💬 ردّ', button: '🔘 ضغط زر' };

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

  const [tab, setTab] = useState<'list' | 'new' | 'optouts' | 'guide'>('list');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadMeta = useCallback((fresh = false) => {
    api(`/meta${fresh ? '?fresh=1' : ''}`).then(d => setMeta(d)).catch(e => setError(e.message));
  }, [api]);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  const tier = meta?.phone?.dailyLimit;

  return (
    <div className="wd-page">
      <div className="wd-usage">
        {meta?.phone?.phone && <span className="wd-pill" dir="ltr">{meta.phone.phone}</span>}
        {meta?.phone?.quality && <span className={`wd-pill ${meta.phone.quality === 'GREEN' ? 'wd-pill--ok' : 'wd-pill--paid'}`}>جودة الرقم: {meta.phone.quality === 'GREEN' ? 'ممتازة' : meta.phone.quality === 'YELLOW' ? 'متوسطة ⚠️' : meta.phone.quality === 'RED' ? 'منخفضة ⚠️' : meta.phone.quality}</span>}
        {meta?.phone && 'dailyLimit' in meta.phone && <span className="wd-pill">حد الإرسال: {tier ? `${fmtNum(tier)} شخص باليوم` : 'بلا حد'}</span>}
        {meta && <span className="wd-pill">أوقفوا العروض: {meta.optOuts}</span>}
      </div>

      <div className="wd-tabs">
        {([['list', 'الحملات'], ['new', '+ حملة جديدة'], ['optouts', 'الموقوفون'], ['guide', 'نص القالب والقواعد']] as const).map(([k, l]) => (
          <button key={k} className={`wd-tab ${tab === k ? 'is-active' : ''}`} onClick={() => { setTab(k); setError(''); setNotice(''); }}>{l}</button>
        ))}
      </div>

      {error && <div className="wd-note wd-note--warn">{error}</div>}
      {notice && <div className="wd-note wc-note--ok">{notice}</div>}

      {tab === 'list' && <CampaignList api={api} base={base} token={token} onError={setError} />}
      {tab === 'new' && meta && (
        <NewCampaign
          api={api} meta={meta} onError={setError} reloadMeta={() => loadMeta(true)}
          onDone={(msg) => { setNotice(msg); setTab('list'); }}
          onSavePrice={async (p) => { await api('/price', { method: 'PUT', body: JSON.stringify({ price: p }) }); loadMeta(); }}
        />
      )}
      {tab === 'new' && !meta && <div className="wd-empty">جاري التحميل…</div>}
      {tab === 'optouts' && <OptOuts api={api} onError={setError} onChange={() => loadMeta()} />}
      {tab === 'guide' && <Guide />}
    </div>
  );
}

// ─── قائمة الحملات ───────────────────────────────────────────────────────────
function CampaignList({ api, base, token, onError }: { api: (p: string, i?: RequestInit) => Promise<any>; base: string; token: string | null; onError: (s: string) => void }) {
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
  if (!rows.length) return <div className="wd-empty"><b>لا حملات بعد</b><span className="wd-muted">اضغط «+ حملة جديدة» وارفع ملف إكسل فيه الأسماء والأرقام.</span></div>;

  return (
    <div className="wd-list">
      {rows.map(c => (
        <CampaignCard key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)}
          api={api} base={base} token={token} onError={onError} reload={load} />
      ))}
    </div>
  );
}

function CampaignCard({ c, open, onToggle, api, base, token, onError, reload }: {
  c: Campaign; open: boolean; onToggle: () => void; api: (p: string, i?: RequestInit) => Promise<any>;
  base: string; token: string | null; onError: (s: string) => void; reload: () => void;
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
          <span className="wd-sub">{c.itemName ? `${c.itemName} · ` : ''}قالب {c.templateName} · {c.createdByName || '—'} · {fmtDate(c.createdAt)}</span>
          <div className="wc-progress"><span style={{ width: `${pct}%` }} /></div>
          <span className="wc-stats">
            <span>{fmtNum(sent)}/{fmtNum(c.total)} أُرسلت</span>
            <span>✓✓ {fmtNum(delivered)} وصلت</span>
            <span>👁️ {fmtNum(k.read || 0)} قُرئت</span>
            {!!k.failed && <span className="wc-bad">❌ {k.failed} فشلت</span>}
            {!!k.order && <span className="wc-good">🛒 {k.order} طلبوا</span>}
            {!!replied && <span>💬 {replied} ردّوا</span>}
            {!!k.stop && <span>⛔ {k.stop} أوقفوا</span>}
          </span>
        </div>
        <span className={`wd-status wc-status--${c.status}`}>{STATUS_AR[c.status] || c.status}</span>
        <ChevronDown size={16} className={`wd-chevron ${open ? 'is-open' : ''}`} />
      </button>
      {c.lastError && <div className="wd-note wd-note--warn wc-inner">⚠️ توقفت: {c.lastError}</div>}
      {open && <CampaignDetail c={c} api={api} base={base} token={token} onError={onError} act={act} del={del} />}
    </div>
  );
}

function CampaignDetail({ c, api, base, token, onError, act, del }: {
  c: Campaign; api: (p: string, i?: RequestInit) => Promise<any>; base: string; token: string | null;
  onError: (s: string) => void; act: (a: 'start' | 'pause' | 'cancel') => void; del: () => void;
}) {
  const [filter, setFilter] = useState<string>('');
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
        {c.headerMediaId && !img && <button className="btn btn-secondary" onClick={showImg}>🖼️ الصورة</button>}
        <button className="btn btn-secondary" onClick={exportXlsx}><Download size={14} /> تصدير</button>
        <span className="wd-spacer" />
        {c.status !== 'sending' && <button className="btn btn-secondary wc-danger" onClick={del}><Trash2 size={14} /></button>}
      </div>
      {img && <img src={img} alt="" className="wc-img" />}
      {c.template && (
        <div className="wd-muted wd-small">ردّ البوت على «اطلب الآن»: {c.replyText || 'الرد الافتراضي (شكراً لاهتمامك… سيتواصل معك فريقنا)'}</div>
      )}
      <div className="wd-chips">
        {([['', 'الكل', c.total], ['order', '🛒 طلبوا', k.order], ['replied', '💬 كل الردود', (k.order || 0) + (k.text || 0) + (k.button || 0) + (k.stop || 0)], ['failed', '❌ فشلت', k.failed], ['stop', '⛔ أوقفوا', k.stop]] as const).map(([v, l, n]) => (
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
                <td>{r.reply ? <><b>{REPLY_AR[r.reply]}</b>{r.replyText && r.reply !== 'order' && <div className="wd-small">{r.replyText}</div>}<div className="wd-muted wd-small">{fmtDate(r.repliedAt)}</div></> : ''}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="wd-muted">لا شيء</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length >= 1000 && <div className="wd-muted wd-small">يُعرض أول 1000 — التصدير يحمل نفس المعروض.</div>}
    </div>
  );
}

// ─── حملة جديدة ──────────────────────────────────────────────────────────────
const PHONE_HDR = /رقم|هاتف|موبايل|موبايل|جوال|واتس|تلفون|phone|mobile|whats|tel|number/i;
const NAME_HDR = /اسم|الاسم|صيدلية|الصيدلية|زبون|عميل|الدكتور|طبيب|name|customer|pharmacy/i;

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

  // ── قراءة الإكسل
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
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
      setFileName(f.name); setHeaders(hdr); setRaw(body.map(r => hdr.map((_, i) => String(r[i] ?? '').trim())));
      let pc = hdr.findIndex(h => PHONE_HDR.test(h));
      if (pc < 0) {
        const score = hdr.map((_, i) => body.slice(0, 50).filter(r => validPhone(normPhone(r[i]))).length);
        pc = score.indexOf(Math.max(...score));
      }
      setPhoneCol(pc);
      setNameCol(hdr.findIndex((h, i) => i !== pc && NAME_HDR.test(h)));
    } catch (e: any) { onError(`تعذّر قراءة الملف: ${e.message}`); }
  };

  const parsed = useMemo(() => {
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
  }, [raw, phoneCol, nameCol, headers]);

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
      setTestMsg('✓ أُرسلت رسالة التجربة — افتح واتساب على الرقم وتأكد من شكلها.');
    } catch (e: any) { setTestMsg(`❌ ${e.message}`); } finally { setBusy(false); }
  };

  const priceNum = price.trim() ? Number(price) : null;
  const cost = priceNum != null && Number.isFinite(priceNum) ? priceNum * sendable.length : null;

  const create = async (start: boolean) => {
    if (start && !confirm(`إرسال العرض إلى ${sendable.length} رقم الآن؟${cost != null ? `\nالكلفة التقديرية ${fmtMoney(cost)}` : ''}`)) return;
    setBusy(true);
    try {
      await api('/campaigns', { method: 'POST', body: JSON.stringify({ ...payload(), start, recipients: parsed.ok.map(r => ({ waId: r.waId, name: r.name, extra: r.extra })) }) });
      onDone(start ? `✓ بدأ إرسال الحملة إلى ${sendable.length} رقم — تتابع التقدّم من هنا.` : '✓ حُفظت الحملة كمسودة.');
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="wc-wizard">
      {/* 1 */}
      <section className="wc-step">
        <h3><span>1</span> قائمة الأرقام (Excel)</h3>
        <div className="wd-inline">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}><Upload size={14} /> {fileName ? 'تغيير الملف' : 'رفع ملف إكسل'}</button>
          {fileName && <span className="wd-muted">{fileName} · {raw.length} صف</span>}
          <button className="btn btn-secondary" onClick={downloadSample}><Download size={14} /> نموذج فارغ</button>
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
              <span className="wc-good">✓ {sendable.length} رقم سيُرسل له</span>
              {!!optedOut.size && <span>⛔ {optedOut.size} أوقفوا العروض سابقاً (يُتخطّون)</span>}
              {!!parsed.dup && <span>🔁 {parsed.dup} مكرر</span>}
              {!!parsed.bad.length && <span className="wc-bad">❌ {parsed.bad.length} رقم غير صالح</span>}
            </div>
            {!!parsed.bad.length && <div className="wd-muted wd-small">غير صالح: {parsed.bad.slice(0, 8).join('، ')}{parsed.bad.length > 8 ? ' …' : ''}</div>}
            {sendable.length > meta.maxRecipients && <div className="wd-note wd-note--warn">الحد {fmtNum(meta.maxRecipients)} رقم للحملة الواحدة — قسّم الملف.</div>}
            {meta.phone.dailyLimit && sendable.length > meta.phone.dailyLimit && (
              <div className="wd-note wd-note--warn">القائمة أكبر من حد الرقم اليومي ({fmtNum(meta.phone.dailyLimit)} شخص خلال 24 ساعة). الزائد سترفضه Meta — قسّمها على أكثر من يوم.</div>
            )}
          </>
        )}
      </section>

      {/* 2 */}
      <section className="wc-step">
        <h3><span>2</span> القالب <button className="btn btn-secondary wc-mini" onClick={reloadMeta} title="تحديث من Meta"><RefreshCw size={13} /></button></h3>
        {meta.templatesError && <div className="wd-note wd-note--warn">تعذّر جلب القوالب من Meta: {meta.templatesError}</div>}
        <select className="form-input" value={tplKey} onChange={e => setTplKey(e.target.value)}>
          <option value="">— اختر قالباً معتمداً —</option>
          {approved.map(t => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language}) {t.category === 'MARKETING' ? '· تسويقي' : t.category === 'UTILITY' ? '· خدمي' : `· ${t.category}`}</option>)}
        </select>
        {!approved.some(t => t.category === 'MARKETING') && (
          <div className="wd-note">لا يوجد قالب تسويقي معتمد بعد. افتح تبويب «نص القالب والقواعد» وانسخ القالب الجاهز إلى WhatsApp Manager، وبعد الموافقة اضغط 🔄 هنا.</div>
        )}
        {meta.templates.filter(t => t.status !== 'APPROVED').length > 0 && (
          <div className="wd-muted wd-small">بانتظار الموافقة/مرفوضة: {meta.templates.filter(t => t.status !== 'APPROVED').map(t => `${t.name} (${t.status === 'PENDING' ? 'قيد المراجعة' : t.status === 'REJECTED' ? 'مرفوض' : t.status})`).join('، ')}</div>
        )}
        {tpl && tpl.category !== 'MARKETING' && <div className="wd-note wd-note--warn">هذا القالب ليس «تسويقي». إرسال عروض بقالب خدمي يخالف سياسة Meta وقد يُوقف القالب.</div>}
      </section>

      {/* 3 */}
      {tpl && (
        <section className="wc-step">
          <h3><span>3</span> الايتم ومتغيّرات الرسالة</h3>
          <div className="wc-item-pick">
            <input className="form-input" placeholder="ابحث عن الايتم…" value={itemQ} onChange={e => setItemQ(e.target.value)} />
            <div className="wc-item-list">
              {items.map(i => (
                <button key={i.id} className={`wc-item ${item?.id === i.id ? 'is-active' : ''}`} onClick={() => { setItem(i); if (mediaPreview === 'item') { setMediaId(null); setMediaPreview(null); } }}>
                  <b>{i.name}</b>
                  <span className="wd-muted wd-small">{i.company || ''}{i.price != null ? ` · ${fmtNum(i.price)}` : ''}{i.hasImage ? ' · 🖼️' : ''}</span>
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
                {mediaId && <span className="wc-good">✓ الصورة جاهزة</span>}
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
          <div className="wd-muted wd-small">المتغيّر لا يقبل أسطراً جديدة — واتساب يحوّلها إلى «•».</div>
        </section>
      )}

      {/* 4 */}
      {tpl && (
        <section className="wc-step">
          <h3><span>4</span> المعاينة والإرسال</h3>
          <div className="wc-preview-wrap">
            <div className="wc-bubble">
              {tpl.header?.format === 'IMAGE' && (mediaPreview && mediaPreview !== 'item' ? <img src={mediaPreview} alt="" /> : <div className="wc-bubble__img">{mediaId ? '🖼️ صورة الايتم' : '🖼️ (صورة)'}</div>)}
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
                <label>ردّ البوت حين يضغط الشخص «اطلب الآن»
                  <textarea className="form-input" rows={3} placeholder="شكراً لاهتمامك 🌷 تم تسجيل طلبك وسيتواصل معك فريقنا قريباً." value={replyText} onChange={e => setReplyText(e.target.value)} />
                </label>
              )}
              <div className="wc-cost">
                <label>سعر رسالة التسويق ($)
                  <input className="form-input" inputMode="decimal" placeholder="مثلاً 0.05" value={price} onChange={e => setPrice(e.target.value)} onBlur={() => onSavePrice(price.trim() ? Number(price) : null).catch(() => {})} />
                </label>
                <span>{cost != null ? <>الكلفة التقديرية: <b>{fmtMoney(cost)}</b> لـ {sendable.length} رسالة</> : <span className="wd-muted wd-small">اكتب سعر الرسالة من فاتورة Meta لتظهر الكلفة</span>}</span>
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
      <div className="wd-note">هذه الأرقام لا تصلها أي حملة. الإضافة تلقائية حين يضغط الشخص «إيقاف العروض» أو يكتب «ايقاف»، أو حين يوقف رسائلكم من واتساب نفسه.</div>
      <div className="wd-inline">
        <input className="form-input wc-phone" dir="ltr" placeholder="07xxxxxxxxx" value={add} onChange={e => setAdd(e.target.value)} />
        <button className="btn btn-secondary" disabled={!validPhone(normPhone(add))} onClick={async () => {
          try { await api('/optouts', { method: 'POST', body: JSON.stringify({ waId: normPhone(add) }) }); setAdd(''); load(); onChange(); } catch (e: any) { onError(e.message); }
        }}>إضافة للموقوفين</button>
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

// ─── الدليل ──────────────────────────────────────────────────────────────────
function CopyBox({ label, text }: { label: string; text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="wc-copy">
      <div className="wc-copy__head"><b>{label}</b>
        <button className="btn btn-secondary wc-mini" onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }}>
          <Copy size={13} /> {ok ? 'نُسخ' : 'نسخ'}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

function Guide() {
  return (
    <div className="wc-guide">
      <section className="wc-step">
        <h3>القالب الجاهز</h3>
        <p className="wd-muted">من <b>WhatsApp Manager ← Message templates ← Create template</b>:</p>
        <ol>
          <li>الفئة <b>Marketing</b> ← النوع <b>Default</b>.</li>
          <li>الاسم وكل الحروف إنكليزية صغيرة: <code>{READY_TEMPLATE.name}</code> — اللغة <b>Arabic</b>.</li>
          <li>Header: اختر <b>Image</b> وارفع أي صورة كمثال. التطبيق يرسل صورة الايتم الحقيقية مع كل حملة.</li>
          <li>Body: الصق النص التالي، واكتب في خانات الأمثلة (Samples) قيماً مثل التي تحته.</li>
          <li>Footer: الصق السطر الأخير.</li>
          <li>Buttons: زر <b>Quick reply</b> باسم «اطلب الآن»، ثم زر <b>Marketing opt-out</b> (أو Quick reply) باسم «إيقاف العروض».</li>
        </ol>
        <CopyBox label="Body" text={READY_TEMPLATE.body} />
        <CopyBox label="Footer" text={READY_TEMPLATE.footer} />
        <CopyBox label="Samples (أمثلة للمتغيّرات)" text={READY_TEMPLATE.samples.map((s, i) => `{{${i + 1}}} = ${s}`).join('\n')} />
        <p className="wd-muted">في الحملة اربط المتغيّرات هكذا: {'{{1}}'} = اسم الشخص، {'{{2}}'} = اسم الايتم، {'{{3}}'} = تفاصيل العرض (نص ثابت)، {'{{4}}'} = تاريخ نهاية العرض (نص ثابت). كل عرض جديد يحتاج تغيير هذه القيم فقط، والقالب يبقى كما هو.</p>
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
