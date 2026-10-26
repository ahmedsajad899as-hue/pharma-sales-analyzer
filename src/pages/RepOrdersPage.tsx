// ════════════════════════════════════════════════════════════════════════════
// RepOrdersPage — «طلبيات المذاخر».
// المندوب يكتب طلبيات اليوم (الصيدلية، المنطقة، المذخر، الأصناف والكميات، صورة
// ختم الصيدلية اختيارية) ويرسل الطلبية لرقم واتساب المذخر بضغطة (wa.me — يفتح محادثة
// المذخر والنص جاهز، والمندوب يضغط إرسال). المدير يرى طلبيات فريقه.
// • المصدر: /api/rep-orders (server/modules/rep-orders) — لا يدخل أي حسبة مبيعات.
// ════════════════════════════════════════════════════════════════════════════

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Send, Share2, Check, RotateCcw, Pencil, X, Warehouse, Ban, ChevronDown, Camera, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './RepOrdersPage.css';

const API = import.meta.env.VITE_API_URL || '';
const SHARE_CACHE = 'ordine-share'; // نفس الاسم في public/sw.js

type Status = 'pending' | 'prepared' | 'cancelled';

interface OrderLine { id?: number; itemId: number | null; itemName: string; companyName: string | null; quantity: number; bonusQty: number; preparedQty?: number | null; preparedBonus?: number | null; unitPrice?: number | null }
interface OrderWh { id: number | null; name: string; phone: string | null; groupLink?: string | null }
interface Order {
  id: number; orderDate: string; createdById: number; repName: string;
  warehouseId: number | null; warehouseName: string; warehousePhone: string | null;
  warehouses: OrderWh[]; lastSentWarehouseId: number | null;
  pharmacyName: string; areaName: string | null; notes: string | null;
  status: Status; invoiceImage: string | null; preparedImage: string | null; invoiceNumber?: string | null; createdAt: string; sentAt: string | null; sentCount: number;
  preparedAt: string | null; preparedBy: string | null; lines: OrderLine[]; canEdit: boolean;
}
interface WarehouseRow { id: number; name: string; phone: string; groupLink: string | null; notes: string | null; canEdit: boolean }
interface CatalogItem { id: number; name: string; company?: { name: string } | null; scientificCompany?: { name: string } | null }


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
const fmtMoney = (n: number) => Math.round(n).toLocaleString('en-US');
const itemCompany = (i: CatalogItem) => i.scientificCompany?.name ?? i.company?.name ?? null;
const itemLabel = (i: CatalogItem) => (itemCompany(i) ? `${i.name} — ${itemCompany(i)}` : i.name);

/** المذخر الحالي للطلبية: آخر مذخر أُرسلت له، وإلا الأساسي. */
const currentWh = (o: Order): OrderWh => o.warehouses.find(w => w.id != null && w.id === o.lastSentWarehouseId) ?? o.warehouses[0] ?? { id: o.warehouseId, name: o.warehouseName, phone: o.warehousePhone };

/** المذخر المقترح للإرسال التالي: الأول إن لم تُرسل، وإلا الاحتياط الذي يلي آخر مذخر أُرسلت له. */
const nextWh = (o: Order): OrderWh => {
  if (!o.sentAt || o.lastSentWarehouseId == null) return o.warehouses[0];
  const i = o.warehouses.findIndex(w => w.id === o.lastSentWarehouseId);
  return o.warehouses[i + 1] ?? o.warehouses[Math.max(0, i)];
};

function orderText(o: Order, withHeader = true, whName = currentWh(o).name): string {
  const out: string[] = [];
  if (withHeader) out.push(`*طلبية رقم ${o.id}*`);
  out.push(`التاريخ: ${fmtDay(o.orderDate)}`);
  out.push(`المندوب: ${o.repName}`);
  out.push(`الصيدلية: ${o.pharmacyName}`);
  if (o.areaName) out.push(`المنطقة: ${o.areaName}`);
  out.push(`المذخر: ${whName}`);
  out.push('──────────');
  o.lines.forEach((l, i) => {
    const bonus = l.bonusQty ? ` + بونص ${l.bonusQty}` : '';
    out.push(`${i + 1}) ${l.itemName}${l.companyName ? ` (${l.companyName})` : ''} — الكمية: ${l.quantity}${bonus}`);
  });
  if (o.notes) out.push(`ملاحظات: ${o.notes}`);
  if (o.invoiceImage) out.push(`صورة ختم الصيدلية: ${window.location.origin}${o.invoiceImage}`);
  return out.join('\n');
}

/** نص رسالة المذخر: طلبية واحدة أو عدة طلبيات في رسالة واحدة. */
const ordersText = (list: Order[], whName: string) => (list.length === 1
  ? orderText(list[0], true, whName)
  : [`*${list.length} طلبيات — ${whName}*`, ...list.map(o => `\n*طلبية رقم ${o.id}*\n${orderText(o, false, whName)}`)].join('\n'));

// نسخ متزامن داخل ضغطة الزر (قبل فتح واتساب) — execCommand يعمل حتى حيث لا تتوفر clipboard API
function copyText(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  if (!ok) navigator.clipboard?.writeText(text).catch(() => {});
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

type Period = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'custom';
// invoice = صورة ختم الصيدلية يرفقها المندوب مع الطلبية (اسم الحقل تاريخي)،
// prepared = فاتورة المذخر بعد التجهيز — هي التي تُقرأ بالذكاء وتُعلِّم الطلبية مجهّزة.
type ImageKind = 'invoice' | 'prepared';
type GroupType = 'date' | 'warehouse' | 'rep';

// حالات العرض الأربع:
//  جديد         — وصلت من المندوب ولم تُرسل لمذخر ولا صورة لها
//  قيد المتابعة — أُرسلت لمذخر ولم تصل فاتورتها بعد ولم تُلغَ
//  تم التجهيز   — فيها صورة تجهيز (فاتورة المذخر) أو أُشّرت مجهّزة يدوياً.
//                 صورة ختم الصيدلية لا تعني تجهيزاً — تُرفق مع الطلبية نفسها.
//  ملغاة
type DisplayState = 'new' | 'following' | 'prepared' | 'cancelled';
const stateOf = (o: Order): DisplayState => {
  if (o.status === 'cancelled') return 'cancelled';
  if (o.preparedImage || o.status === 'prepared') return 'prepared';
  return o.sentAt ? 'following' : 'new';
};
const STATE_LABEL: Record<DisplayState, string> = { new: 'جديد', following: 'قيد المتابعة', prepared: 'تم التجهيز', cancelled: 'ملغاة' };
type View = 'all' | DisplayState;
const VIEWS: View[] = ['all', 'new', 'following', 'prepared', 'cancelled'];
const VIEW_LABEL: Record<View, string> = { all: 'الكل', ...STATE_LABEL };
const inView = (o: Order, v: View) => v === 'all' || stateOf(o) === v;

const GROUP_LABEL: Record<GroupType, string> = { date: 'التاريخ', warehouse: 'المذخر', rep: 'المندوب' };
const groupKey = (o: Order, t: GroupType) => (t === 'date' ? fmtDay(o.orderDate) : t === 'warehouse' ? `w${currentWh(o).id ?? currentWh(o).name}` : `r${o.createdById}`);
const groupTitle = (o: Order, t: GroupType) => (t === 'date' ? fmtDay(o.orderDate) : t === 'warehouse' ? currentWh(o).name : o.repName);

const periodRange = (p: Period): [string, string] => {
  if (p === 'all') return ['', ''];
  if (p === 'yesterday') return [shiftDay(-1), shiftDay(-1)];
  if (p === 'week') return [shiftDay(-6), today()];
  if (p === 'month') return [monthStart(), today()];
  return [today(), today()];
};

// البحث الذكي: يطبّع الهمزات/التاء المربوطة/الياء والتشكيل، وكل كلمة يجب أن توجد في
// مكانٍ ما من الطلبية (مذخر، صيدلية، منطقة، مندوب، صنف، شركة، ملاحظة، رقم).
const normSearch = (v: unknown) => String(v ?? '').toLowerCase()
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ً-ْـ]/g, '');
const searchTextOf = (o: Order) => normSearch([
  o.id, `#${o.id}`, o.pharmacyName, o.areaName, o.repName, o.notes, o.invoiceNumber,
  ...o.warehouses.map(w => w.name), o.warehouseName,
  ...o.lines.flatMap(l => [l.itemName, l.companyName]),
].filter(Boolean).join(' '));

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ar-IQ', { dateStyle: 'short', timeStyle: 'short' }) : '');

export default function RepOrdersPage() {
  const { token, hasFeature } = useAuth();
  // «إرسال للمذاخر»: البوت يرسل الطلبية للمذخر ويستقبل ردّه بدل فتح wa.me
  const canBotSend = hasFeature('warehouse_dispatch');
  const [viaBot, setViaBot] = useState<boolean>(() => { try { return localStorage.getItem('ro-via-bot') === '1'; } catch { return false; } });
  const toggleViaBot = (v: boolean) => { setViaBot(v); try { localStorage.setItem('ro-via-bot', v ? '1' : '0'); } catch {} };

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

  // الافتراضي: كل الطلبيات بلا قيد تاريخ — والتاريخ اختياري
  const [period, setPeriod] = useState<Period>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState<GroupType | 'none'>('date');
  const [groupFilter, setGroupFilter] = useState<{ type: GroupType; key: string; title: string } | null>(null);
  const [view, setView] = useState<View>('all');
  const [query, setQuery] = useState('');

  const [orders, setOrders] = useState<Order[]>([]);
  const [isManager, setIsManager] = useState(false);
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // طلبية واحدة مفتوحة فقط، وتُخفى البقية حتى ينصبّ التركيز على صيدليتها
  const [openId, setOpenId] = useState<number | null>(null);
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
    try {
      const r = await api<{ orders: Order[]; viewer: { isManager: boolean } }>(`?${q}`);
      setOrders(r.orders); setIsManager(r.viewer.isManager);
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [token, api, from, to]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadWarehouses(); }, [loadWarehouses]);

  // صور وصلت عبر «مشاركة ← Ordine» (sw.js خزّنها في كاش ordine-share)
  const [shared, setShared] = useState<Blob[]>([]);
  useEffect(() => {
    try { sessionStorage.removeItem('ro-share'); } catch { /* ignore */ }
    if (!('caches' in window)) return;
    (async () => {
      const cache = await caches.open(SHARE_CACHE);
      const keys = await cache.keys();
      const blobs = await Promise.all(keys.map(async k => (await cache.match(k))!.blob()));
      if (blobs.length) setShared(blobs);
    })().catch(() => {});
  }, []);
  const clearShared = () => {
    setShared([]);
    if ('caches' in window) caches.delete(SHARE_CACHE).catch(() => {});
  };

  const pickPeriod = (p: Period) => {
    setPeriod(p);
    if (p !== 'custom') { const [f, t] = periodRange(p); setFrom(f); setTo(t); }
    else if (!from) { setFrom(today()); setTo(today()); }
  };

  const terms = useMemo(() => normSearch(query).split(/\s+/).filter(Boolean), [query]);
  const searchIndex = useMemo(() => new Map(orders.map(o => [o.id, searchTextOf(o)])), [orders]);
  const bySearch = useCallback((o: Order) => !terms.length || terms.every(t => searchIndex.get(o.id)!.includes(t)), [terms, searchIndex]);
  const byGroup = useCallback((o: Order) => (!groupFilter || groupKey(o, groupFilter.type) === groupFilter.key) && bySearch(o), [groupFilter, bySearch]);

  // عدد كل حالة = بقية الفلاتر مطبّقة عدا الحالة — يتحدّث فور أي إرسال/تجهيز/إلغاء
  const counts = useMemo(() => {
    const base = orders.filter(byGroup);
    return Object.fromEntries(VIEWS.map(v => [v, base.filter(o => inView(o, v)).length])) as Record<View, number>;
  }, [orders, byGroup]);

  // قيم كل نوع تقسيم (لقائمة السهم): الاسم + العدد ضمن الحالة المختارة
  const groupOptions = useMemo(() => {
    const out = {} as Record<GroupType, { key: string; title: string; count: number }[]>;
    for (const t of ['date', 'warehouse', 'rep'] as GroupType[]) {
      const m = new Map<string, { key: string; title: string; count: number }>();
      for (const o of orders) {
        if (!inView(o, view) || !bySearch(o)) continue;
        const k = groupKey(o, t);
        if (!m.has(k)) m.set(k, { key: k, title: groupTitle(o, t), count: 0 });
        m.get(k)!.count++;
      }
      out[t] = [...m.values()].sort((a, b) => (t === 'date' ? b.key.localeCompare(a.key) : b.count - a.count || a.title.localeCompare(b.title, 'ar')));
    }
    return out;
  }, [orders, view, bySearch]);

  const visible = useMemo(() => orders.filter(o => inView(o, view) && byGroup(o)), [orders, view, byGroup]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', title: '', orders: visible }];
    const m = new Map<string, { key: string; title: string; orders: Order[] }>();
    for (const o of visible) {
      const key = groupKey(o, groupBy);
      if (!m.has(key)) m.set(key, { key, title: groupTitle(o, groupBy), orders: [] });
      m.get(key)!.orders.push(o);
    }
    return [...m.values()];
  }, [visible, groupBy]);

  const toggleOpen = (id: number) => setOpenId(x => (x === id ? null : id));
  // تُعرض حتى لو خرجت من فلتر الحالة الحالي (أُرسلت من «جديد» مثلاً) كي لا تختفي من تحت المستخدم
  const focused = openId != null ? orders.find(o => o.id === openId) ?? null : null;
  useEffect(() => {
    if (openId == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId]);

  // زر الرجوع / سحب الشاشة للخلف: App.tsx يطلق before-navigate-back قبل أي تنقّل،
  // فنغلق أعلى طبقة مفتوحة هنا بدل مغادرة الصفحة. الصفحات تبقى مركّبة مخفية
  // (keep-alive) فلا نعترض إلا وهذه الصفحة هي الظاهرة.
  useEffect(() => {
    const onBack = (e: Event) => {
      const ce = e as CustomEvent<{ activePage?: string }>;
      if (ce.detail?.activePage !== 'rep-orders' || ce.defaultPrevented) return;
      if (preview)        { ce.preventDefault(); setPreview(null); return; }
      if (editing)        { ce.preventDefault(); setEditing(null); return; }
      if (showWarehouses) { ce.preventDefault(); setShowWarehouses(false); return; }
      if (openId != null) { ce.preventDefault(); setOpenId(null); }
    };
    window.addEventListener('before-navigate-back', onBack);
    return () => window.removeEventListener('before-navigate-back', onBack);
  }, [preview, editing, showWarehouses, openId]);


  // ── الإرسال لواتساب المذخر ─────────────────────────────────────────────────
  // تُفتح النافذة قبل أي await كي لا يحجبها المتصفح كنافذة منبثقة.
  // الأولوية: كروب المذخر (رابط الدعوة يفتح الكروب والنص منسوخ — wa.me لا يصل للكروبات)
  // ← رقمه (wa.me والنص جاهز) ← قائمة المشاركة يختار منها المندوب أي محادثة/كروب.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  const markSent = (list: Order[], wh: OrderWh) =>
    api('/mark-sent', { method: 'POST', body: JSON.stringify({ ids: list.map(o => o.id), warehouseId: wh.id }) }).then(load).catch(() => {});

  const sendToWarehouse = (list: Order[], wh: OrderWh) => {
    if (canBotSend && viaBot && wh?.id != null) { sendViaBot(list, wh); return; }
    const text = ordersText(list, wh.name);
    if (wh?.groupLink) {
      copyText(text);
      window.open(wh.groupLink, '_blank');
      // رابط الكروب لا يحمل نصاً (بخلاف wa.me) — اللصق خطوة لا مفرّ منها
      const isTouch = window.matchMedia?.('(pointer: coarse)').matches;
      setNotice(`✓ نُسخت الطلبية. في كروب «${wh.name}» ${isTouch ? 'اضغط مطوّلاً على خانة الكتابة ← لصق' : 'اضغط على خانة الكتابة ثم Ctrl+V'} ← إرسال.`);
      markSent(list, wh);
      return;
    }
    const wa = toWaNumber(wh?.phone);
    if (!wa) { shareOrders(list, wh); return; }
    window.open(`https://wa.me/${wa}?text=${encodeURIComponent(text)}`, '_blank');
    markSent(list, wh);
  };

  // قائمة المشاركة في الموبايل (واتساب ← أي كروب أو محادثة والنص جاهز).
  // تُعلَّم مُرسلة فقط إن اختار المندوب وجهة؛ الإلغاء لا يغيّر شيئاً.
  const shareOrders = (list: Order[], wh: OrderWh) => {
    const text = ordersText(list, wh.name);
    if (typeof navigator.share === 'function') {
      navigator.share({ text }).then(() => markSent(list, wh)).catch(() => {});
      return;
    }
    copyText(text);
    setNotice('المشاركة غير مدعومة في هذا المتصفح — نُسخت الطلبية، الصقها في كروب المذخر.');
  };

  const sendViaBot = async (list: Order[], wh: OrderWh) => {
    const failed: string[] = [];
    for (const o of list) {
      try {
        const res = await fetch(`${API}/api/warehouse-dispatch/rep-order/${o.id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ warehouseId: wh.id }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d.success === false) throw new Error(d.error || d.message || 'تعذّر الإرسال');
        if (d.dispatch?.status !== 'sent') throw new Error(d.dispatch?.error || 'لم يُرسل');
      } catch (e: any) { failed.push(`${o.pharmacyName}: ${e.message}`); }
    }
    load();
    if (failed.length) alert(`تعذّر الإرسال عبر البوت:\n${failed.join('\n')}\n\nيمكنك إطفاء «عبر البوت» والإرسال من واتساب مباشرة.`);
  };

  const changeStatus = async (ids: number[], s: Status) => {
    try { await api('/status', { method: 'POST', body: JSON.stringify({ ids, status: s }) }); load(); } catch (e: any) { alert(e.message); }
  };

  const remove = async (o: Order) => {
    if (!window.confirm(`حذف طلبية ${o.pharmacyName} نهائياً؟`)) return;
    try { await api(`/${o.id}`, { method: 'DELETE' }); load(); } catch (e: any) { alert(e.message); }
  };

  const uploadImage = async (o: Order, kind: ImageKind, file: File) => {
    try {
      const fd = new FormData();
      fd.append('image', await compressImage(file), `${kind}.jpg`);
      await api(`/${o.id}/image/${kind}`, { method: 'POST', body: fd });
      load();
    } catch (e: any) { alert(e.message); }
  };

  const removeImage = async (o: Order, kind: ImageKind) => {
    if (!window.confirm(kind === 'invoice' ? 'حذف صورة ختم الصيدلية؟' : 'حذف صورة التجهيز (الفاتورة)؟')) return;
    try { await api(`/${o.id}/image/${kind}`, { method: 'DELETE' }); load(); } catch (e: any) { alert(e.message); }
  };

  const showDate = groupBy !== 'date';
  const showRep = isManager && groupBy !== 'rep';
  const showWh = groupBy !== 'warehouse';
  const colCount = 4 + (showDate ? 1 : 0) + (showRep ? 1 : 0) + (showWh ? 1 : 0);

  return (
    <div className="ro-page">
      {!focused && <>
      <div className="ro-bar">
        {canBotSend && (
          <label className="ro-via-bot" title="البوت يرسل الطلبية للمذخر ويستقبل ردّه (تجهيز/رفض/فاتورة) تلقائياً — المتابعة في صفحة «إرسال للمذاخر»">
            <input type="checkbox" checked={viaBot} onChange={e => toggleViaBot(e.target.checked)} /> إرسال عبر البوت
          </label>
        )}
        <select className="form-input ro-select" value={period} onChange={e => pickPeriod(e.target.value as Period)} aria-label="التاريخ">
          <option value="all">كل التواريخ</option>
          <option value="today">اليوم</option>
          <option value="yesterday">أمس</option>
          <option value="week">آخر 7 أيام</option>
          <option value="month">هذا الشهر</option>
          <option value="custom">تاريخ محدد…</option>
        </select>
        {period === 'custom' && (
          <span className="ro-dates">
            <input className="form-input" type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="من" />
            <span className="ro-muted">←</span>
            <input className="form-input" type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="إلى" />
          </span>
        )}
        <div className="ro-search">
          <Search size={14} className="ro-search__icon" />
          <input className="form-input" type="search" value={query} onChange={e => setQuery(e.target.value)}
            aria-label="بحث" />
          {query && <button className="ro-search__x" title="مسح" onClick={() => setQuery('')}><X size={13} /></button>}
        </div>
        <GroupMenu groupBy={groupBy} isManager={isManager} options={groupOptions} filter={groupFilter}
          onGroup={t => { setGroupBy(t); setGroupFilter(null); }}
          onPick={(t, opt) => { setGroupBy(t); setGroupFilter({ type: t, key: opt.key, title: opt.title }); }} />
        {groupFilter && (
          <button className="ro-chip is-active" onClick={() => setGroupFilter(null)} title="إزالة الفلتر">
            {GROUP_LABEL[groupFilter.type]}: {groupFilter.title} <X size={12} />
          </button>
        )}
        <span className="ro-spacer" />
        <button className="btn btn--secondary btn--sm" onClick={() => setShowWarehouses(true)} title="دليل المذاخر وأرقام الواتساب">
          <Warehouse size={14} /> <span className="ro-hide-sm">المذاخر</span>
        </button>
        <button className="btn btn--primary btn--sm" onClick={() => setEditing('new')}><Plus size={14} /> طلبية جديدة</button>
      </div>

      <div className="ro-chips ro-chips--status" role="group" aria-label="الحالة">
        {VIEWS.map(v => (
          <button key={v} className={`ro-chip ro-chip--${v} ${view === v ? 'is-active' : ''}`} onClick={() => setView(v)}>
            {VIEW_LABEL[v]} <b>{counts[v]}</b>
          </button>
        ))}
        {loading && <span className="ro-muted ro-small">جارٍ التحميل…</span>}
      </div>
      </>}

      {err && <div className="ro-note ro-note--warn">⚠️ {err}</div>}

      {focused && (
        <button className="ro-link ro-back" onClick={() => setOpenId(null)}><X size={13} /> رجوع لكل الطلبيات</button>
      )}

      {!focused && !loading && visible.length === 0 ? (
        <div className="ro-empty">
          <div className="ro-empty__title">{!orders.length ? 'لا طلبيات بعد' : terms.length ? `لا نتائج لـ «${query}»` : 'لا طلبيات بهذا العرض'}</div>
          {!orders.length && <button className="btn btn--primary btn--sm" onClick={() => setEditing('new')}><Plus size={14} /> اكتب أول طلبية</button>}
        </div>
      ) : (
        <div className="ro-table-wrap">
          <table className="ro-table">
            <thead className="ro-hide-sm">
              <tr>
                <th className="ro-col-no">#</th>
                {showDate && <th className="ro-hide-sm">التاريخ</th>}
                <th>الصيدلية</th>
                {showWh && <th className="ro-hide-sm">المذخر</th>}
                {showRep && <th className="ro-hide-sm">المندوب</th>}
                <th className="ro-col-state">الحالة</th>
                <th className="ro-col-actions" />
              </tr>
            </thead>
            <tbody>
              {(focused ? [{ key: 'focus', title: '', orders: [focused] }] : groups).map(g => {
                const fresh = g.orders.filter(o => stateOf(o) === 'new');
                const groupWh = groupBy === 'warehouse' && g.orders[0] ? currentWh(g.orders[0]) : null;
                return (
                  <Fragment key={g.key}>
                    {groupBy !== 'none' && !focused && (
                      <tr className="ro-group-row">
                        <td colSpan={colCount}>
                          <div className="ro-group-row__inner">
                            <strong>{g.title}</strong>
                            <span className="ro-spacer" />
                            {(groupWh?.phone || groupWh?.groupLink) && fresh.length > 1 && (
                              <button className="ro-link ro-link--wa" onClick={() => sendToWarehouse(fresh, groupWh)}><Send size={13} /> إرسال {fresh.length} جديدة للمذخر</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {g.orders.map(o => (
                      <OrderRow key={o.id} o={o} open={openId === o.id} colCount={colCount} terms={terms}
                        showDate={showDate} showRep={showRep} showWh={showWh}
                        onToggle={() => toggleOpen(o.id)}
                        onSend={wh => sendToWarehouse([o], wh)}
                        onShare={wh => shareOrders([o], wh)}
                        onStatus={s => changeStatus([o.id], s)}
                        onEdit={() => setEditing(o)}
                        onDelete={() => remove(o)}
                        onUpload={(k, f) => uploadImage(o, k, f)}
                        onRemoveImage={k => removeImage(o, k)}
                        onPreview={setPreview} />
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <OrderForm token={token} api={api} order={editing === 'new' ? null : editing} warehouses={warehouses}
          onWarehousesChanged={loadWarehouses}
          onClose={() => setEditing(null)}
          onSaved={(d) => { setEditing(null); if (d && from && (d < from || d > to)) pickPeriod('all'); else load(); }} />
      )}
      {showWarehouses && (
        <WarehousesModal api={api} warehouses={warehouses} onChanged={() => { loadWarehouses(); load(); }} onClose={() => setShowWarehouses(false)} />
      )}
      {shared.length > 0 && (
        <SharedImagePicker api={api} images={shared} onDone={() => { clearShared(); load(); }} onCancel={clearShared} />
      )}
      {notice && <div className="ro-notice" role="status" onClick={() => setNotice(null)}>{notice}</div>}

      {preview && (
        <div className="ro-modal" onClick={() => setPreview(null)}>
          <img className="ro-preview" src={`${API}${preview}`} alt="صورة الطلبية" />
        </div>
      )}
    </div>
  );
}

// ─── قائمة التقسيم: كل نوع بسهم يفتح أسماءه للفلترة على قيمة واحدة ─────────────

function GroupMenu({ groupBy, isManager, options, filter, onGroup, onPick }: {
  groupBy: GroupType | 'none'; isManager: boolean;
  options: Record<GroupType, { key: string; title: string; count: number }[]>;
  filter: { type: GroupType; key: string } | null;
  onGroup: (t: GroupType | 'none') => void;
  onPick: (t: GroupType, opt: { key: string; title: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<GroupType | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const types: GroupType[] = isManager ? ['date', 'warehouse', 'rep'] : ['date', 'warehouse'];
  return (
    <div className="ro-gm" ref={ref}>
      <button className="form-input ro-select ro-gm__btn" onClick={() => setOpen(v => !v)}>
        تقسيم: {groupBy === 'none' ? 'بلا' : GROUP_LABEL[groupBy]} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="ro-gm__pop">
          {types.map(t => (
            <div key={t} className="ro-gm__group">
              <div className={`ro-gm__row ${groupBy === t ? 'is-active' : ''}`}>
                <button className="ro-gm__label" onClick={() => { onGroup(t); setOpen(false); }}>حسب {GROUP_LABEL[t]}</button>
                <button className={`ro-gm__arrow ${expanded === t ? 'is-open' : ''}`} title={`اختيار ${GROUP_LABEL[t]} معيّن`} onClick={() => setExpanded(x => (x === t ? null : t))}>
                  <span className="ro-muted ro-small">{options[t].length}</span><ChevronDown size={14} />
                </button>
              </div>
              {expanded === t && (
                <div className="ro-gm__list">
                  {options[t].length === 0 && <div className="ro-muted ro-small">لا شيء</div>}
                  {options[t].map(opt => (
                    <button key={opt.key} className={`ro-gm__opt ${filter?.type === t && filter.key === opt.key ? 'is-active' : ''}`} onClick={() => { onPick(t, opt); setOpen(false); }}>
                      <span>{opt.title}</span><b>{opt.count}</b>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="ro-gm__row">
            <button className="ro-gm__label" onClick={() => { onGroup('none'); setOpen(false); }}>بلا تقسيم</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── قسم مطويّ: يُفتح بالضغط، أو بإبقاء الماوس فوقه hoverDelay ملّي ثانية ───────
// التأخير يمنع انفتاح الأقسام كلما مرّ الماوس فوقها عابراً. على اللمس لا hover،
// فالضغط وحده يفتح.

const canHover = () => typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches;

function Fold({ title, summary, hoverDelay = 0, children }: { title: string; summary?: React.ReactNode; hoverDelay?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const enter = () => { if (canHover()) timer.current = window.setTimeout(() => setHovered(true), hoverDelay); };
  const leave = () => { window.clearTimeout(timer.current); setHovered(false); };
  return (
    <div className={`ro-fold ${open || hovered ? 'is-open' : ''}`} onMouseEnter={enter} onMouseLeave={leave}>
      <button className="ro-fold__head" onClick={() => setOpen(v => !v)}>
        <span className="ro-fold__title">{title}</span>
        {summary && <span className="ro-fold__sum">{summary}</span>}
        <ChevronDown size={13} className="ro-fold__chev" />
      </button>
      <div className="ro-fold__body">{children}</div>
    </div>
  );
}

// ─── سطر طلبية + تفاصيلها ────────────────────────────────────────────────────

function OrderRow({ o, open, colCount, terms, showDate, showRep, showWh, onToggle, onSend, onShare, onStatus, onEdit, onDelete, onUpload, onRemoveImage, onPreview }: {
  o: Order; open: boolean; colCount: number; terms: string[]; showDate: boolean; showRep: boolean; showWh: boolean;
  onToggle: () => void; onSend: (wh: OrderWh) => void; onShare: (wh: OrderWh) => void; onStatus: (s: Status) => void; onEdit: () => void; onDelete: () => void;
  onUpload: (k: ImageKind, f: File) => void; onRemoveImage: (k: ImageKind) => void; onPreview: (src: string) => void;
}) {
  const state = stateOf(o);
  const total = o.lines.reduce((s, l) => s + l.quantity, 0);
  const hasPrepared = o.lines.some(l => l.preparedQty != null);
  const preparedTotal = o.lines.reduce((s, l) => s + (l.preparedQty ?? 0), 0);
  const hasPrice = o.lines.some(l => l.unitPrice != null);
  const value = o.lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.quantity, 0);
  const wh = currentWh(o);
  const backups = o.warehouses.length - 1;
  const [sendTo, setSendTo] = useState<number>(() => Math.max(0, o.warehouses.indexOf(nextWh(o))));
  useEffect(() => { setSendTo(Math.max(0, o.warehouses.indexOf(nextWh(o)))); }, [o]);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const canSendRow = state === 'new';
  const itemHits = terms.length ? o.lines.filter(l => terms.some(t => normSearch(`${l.itemName} ${l.companyName ?? ''}`).includes(t))) : [];
  const lastEvent = state === 'prepared' ? `تم التجهيز ${fmtTime(o.preparedAt)}` : o.sentAt ? `أُرسلت ${fmtTime(o.sentAt)}` : `كُتبت ${fmtTime(o.createdAt)}`;

  return (
    <>
      <tr className={`ro-row ro-row--${state} ${open ? 'is-open' : ''}`} onClick={onToggle}>
        <td className="ro-col-no">
          <span className="ro-chevron"><ChevronDown size={14} /></span>
          <span className="ro-muted">{o.id}</span>
        </td>
        {showDate && <td className="ro-hide-sm ro-nowrap">{fmtDay(o.orderDate)}</td>}
        <td>
          <div className="ro-strong">{o.pharmacyName}{o.areaName && <span className="ro-area"> / {o.areaName}</span>}</div>
          <div className="ro-sub">
            <span className="ro-show-sm">{wh.name}</span>
            {itemHits.length > 0 && <span className="ro-hit">🔎 {itemHits.map(l => `${l.itemName} ×${l.quantity}`).join('، ')}</span>}
          </div>
        </td>
        {showWh && <td className="ro-hide-sm">{wh.name}{backups > 0 && <span className="ro-more" title="مذاخر احتياط">+{backups}</span>}</td>}
        {showRep && <td className="ro-hide-sm ro-nowrap">{o.repName}</td>}
        <td><span className={`ro-badge ro-badge--${state}`}>{STATE_LABEL[state]}</span></td>
        <td className="ro-col-actions" onClick={stop}>
          {canSendRow && (
            <button className="ro-icon-btn ro-icon-btn--wa" title={o.warehouses[0]?.groupLink ? `إرسال لكروب ${o.warehouses[0].name}` : o.warehouses[0]?.phone ? `إرسال لواتساب ${o.warehouses[0].name}` : 'مشاركة الطلبية'} onClick={() => onSend(o.warehouses[0])}><Send size={14} /></button>
          )}
        </td>
      </tr>

      {open && (
        <tr className="ro-detail-row">
          <td colSpan={colCount}>
            <div className="ro-detail">
              <div className="ro-detail__main">
                <table className="ro-lines">
                  <thead>
                    <tr>
                      <th>#</th><th>الصنف</th><th>الشركة</th><th>الكمية</th><th>بونص</th>
                      {hasPrepared && <th>المجهّز</th>}
                      {hasPrice && <th className="ro-price">السعر</th>}
                      {hasPrice && <th className="ro-price">المجموع</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {o.lines.map((l, i) => (
                      <tr key={l.id ?? i} className={hasPrepared && (l.preparedQty ?? 0) !== l.quantity ? 'ro-diff' : ''}>
                        <td className="ro-muted">{i + 1}</td><td className="ro-strong">{l.itemName}</td><td className="ro-muted">{l.companyName ?? '—'}</td><td>{l.quantity}</td><td>{l.bonusQty || '—'}</td>
                        {hasPrepared && <td className="ro-strong">{l.preparedQty ?? 0}{l.preparedBonus ? ` + ${l.preparedBonus}` : ''}</td>}
                        {hasPrice && <td className="ro-price">{l.unitPrice != null ? fmtMoney(l.unitPrice) : '—'}</td>}
                        {hasPrice && <td className="ro-price">{l.unitPrice != null ? fmtMoney(l.unitPrice * l.quantity) : '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td /><td colSpan={2}>المجموع</td><td>{total}</td><td />
                      {hasPrepared && <td>{preparedTotal}</td>}
                      {hasPrice && <td />}
                      {hasPrice && <td className="ro-price">{fmtMoney(value)}</td>}
                    </tr>
                  </tfoot>
                </table>
                {o.notes && <div className="ro-notes"><div className="ro-slot__label">ملاحظات</div>{o.notes}</div>}
              </div>

              <div className="ro-detail__side">
                <Fold title="معلومات الزبون والحالة" summary={lastEvent} hoverDelay={2000}>
                  <dl className="ro-info">
                    {o.areaName && <><dt>المنطقة</dt><dd>{o.areaName}</dd></>}
                    <dt>المندوب</dt><dd>{o.repName}</dd>
                    <dt>التاريخ</dt><dd>{fmtDay(o.orderDate)}</dd>
                    {o.invoiceNumber && <><dt>رقم الفاتورة</dt><dd>{o.invoiceNumber}</dd></>}
                  </dl>
                  <ol className="ro-timeline">
                    <li className="is-done">كُتبت <span>{fmtTime(o.createdAt)}</span></li>
                    <li className={o.sentAt ? 'is-done' : ''}>{o.sentAt ? `أُرسلت إلى ${wh.name}${o.sentCount > 1 ? ` (${o.sentCount} مرات)` : ''}` : 'لم تُرسل للمذخر'} <span>{fmtTime(o.sentAt)}</span></li>
                    <li className={state === 'prepared' ? 'is-done' : state === 'cancelled' ? 'is-cancel' : ''}>
                      {state === 'prepared' ? `تم التجهيز${o.preparedBy ? ` — ${o.preparedBy}` : ''}` : state === 'cancelled' ? 'ملغاة' : 'لم تُجهَّز بعد'} <span>{fmtTime(o.preparedAt)}</span>
                    </li>
                  </ol>
                </Fold>

                {state !== 'cancelled' && state !== 'prepared' && (
                  <div className="ro-sendbox">
                    <div className="ro-whs">
                      {o.warehouses.map((w, i) => (
                        // بعد الإرسال الأول يختفي الزر الأخضر: إعادة الإرسال باسم المذخر مباشرة
                        <button key={`${w.id}-${i}`} className={`ro-wh ${sendTo === i ? 'is-active' : ''}`}
                          title={o.sentAt ? `إرسال إلى ${w.name}` : undefined}
                          onClick={() => (o.sentAt ? onSend(w) : setSendTo(i))}>
                          <span className="ro-wh__rank">{i === 0 ? 'الأساسي' : `احتياط ${i}`}</span>
                          <span className="ro-wh__name">{w.name}</span>
                          {o.lastSentWarehouseId != null && w.id === o.lastSentWarehouseId && <span className="ro-wh__sent">أُرسلت</span>}
                        </button>
                      ))}
                    </div>
                    <div className="ro-send-actions">
                      {!o.sentAt && (
                        <button className="btn btn--success btn--sm" onClick={() => onSend(o.warehouses[sendTo] ?? o.warehouses[0])}>
                          <Send size={14} /> إرسال إلى {(o.warehouses[sendTo] ?? o.warehouses[0])?.name}
                        </button>
                      )}
                      <button className="btn btn--secondary btn--sm" title="واتساب ← اختر الكروب أو المحادثة"
                        onClick={() => onShare(o.warehouses[sendTo] ?? o.warehouses[0])}>
                        <Share2 size={14} /> مشاركة لكروب
                      </button>
                    </div>
                  </div>
                )}

                <div className="ro-images">
                  {/* الختم يُرفق عند كتابة الطلبية (أو تعديلها) — هنا يُعرض مصغّراً فقط إن وُجد */}
                  {o.invoiceImage && (
                    <div className="ro-stamp">
                      <img src={`${API}${o.invoiceImage}`} alt="ختم الصيدلية" onClick={() => onPreview(o.invoiceImage!)} />
                      <span className="ro-slot__label">ختم الصيدلية</span>
                      {o.canEdit && <button className="ro-icon-btn" title="حذف صورة الختم" onClick={() => onRemoveImage('invoice')}><X size={12} /></button>}
                    </div>
                  )}
                  <ImageSlot label="صورة التجهيز (الفاتورة)" src={o.preparedImage} canRemove={o.canEdit} onPreview={onPreview} onUpload={f => onUpload('prepared', f)} onRemove={() => onRemoveImage('prepared')} />
                </div>
              </div>
            </div>
            <div className="ro-detail__actions">
              {state !== 'prepared' && state !== 'cancelled' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('prepared')}><Check size={14} /> تم التجهيز</button>}
              {o.status !== 'pending' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('pending')}><RotateCcw size={14} /> إرجاع</button>}
              {o.status === 'pending' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('cancelled')}><Ban size={14} /> إلغاء</button>}
              <span className="ro-spacer" />
              {o.canEdit && <button className="ro-icon-btn" title="تعديل" onClick={onEdit}><Pencil size={14} /></button>}
              {o.canEdit && <button className="ro-icon-btn ro-icon-btn--danger" title="حذف" onClick={onDelete}><Trash2 size={14} /></button>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── ربط صورة مُشارَكة من واتساب بطلبية ──────────────────────────────────────
// فاتورة المذخر (كروبات واتساب) = «صورة التجهيز»: تُقرأ أولاً بالذكاء الاصطناعي
// (/invoice/read) وتُطابَق بالطلبيات: أفضل مرشّح واثق يُختار تلقائياً، وجدول
// «المطلوب ↔ المجهّز» يُملأ من الفاتورة ويبقى قابلاً للتصحيح قبل الحفظ.
// صورة ختم الصيدلية تُرفع بلا قراءة.

interface ReadLine { lineId: number; itemName: string; quantity: number; bonusQty: number; invoiceItem: string | null; preparedQty: number; preparedBonus: number }
interface ReadCandidate { orderId: number; score: number; lines: ReadLine[]; extraItems: { item: string; quantity: number; bonus: number }[] }
interface ReadResult {
  token: string;
  invoice: { pharmacy: string | null; warehouse: string | null; dateText: string | null; invoiceNumber: string | null; items: { item: string; quantity: number; bonus: number }[] } | null;
  candidates: ReadCandidate[]; autoOrderId: number | null; readError?: string;
}

function SharedImagePicker({ api, images, onDone, onCancel }: {
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>;
  images: Blob[]; onDone: () => void; onCancel: () => void;
}) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [read, setRead] = useState<ReadResult | null>(null);
  const [reading, setReading] = useState(true);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<ImageKind>('prepared');
  const [picked, setPicked] = useState<number | null>(null);
  const [qty, setQty] = useState<Record<number, { p: string; b: string }>>({});
  const [saving, setSaving] = useState(false);
  const urls = useMemo(() => images.map(b => URL.createObjectURL(b)), [images]);
  useEffect(() => () => urls.forEach(u => URL.revokeObjectURL(u)), [urls]);

  // صورة واحدة لكل ربط: الأولى (واتساب يشارك عادةً صورة واحدة)
  const firstFile = useMemo(() => new File([images[0]], 'shared.jpg', { type: images[0].type || 'image/jpeg' }), [images]);

  useEffect(() => {
    api<{ orders: Order[] }>(`?from=${shiftDay(-30)}&to=${today()}`)
      .then(r => setOrders(r.orders.filter(o => o.status !== 'cancelled')))
      .catch(() => setOrders([]));
  }, [api]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fd = new FormData();
        fd.append('image', await compressImage(firstFile), 'invoice.jpg');
        const r = await api<ReadResult>('/invoice/read', { method: 'POST', body: fd });
        if (!alive) return;
        setRead(r);
        if (r.autoOrderId) setPicked(r.autoOrderId);
      } catch (e: any) {
        if (alive) setRead({ token: '', invoice: null, candidates: [], autoOrderId: null, readError: e.message });
      } finally { if (alive) setReading(false); }
    })();
    return () => { alive = false; };
  }, [api, firstFile]);

  const candidateById = useMemo(() => new Map((read?.candidates ?? []).map(c => [c.orderId, c])), [read]);
  const pickedCandidate = picked ? candidateById.get(picked) ?? null : null;
  const pickedOrder = picked ? orders?.find(o => o.id === picked) ?? null : null;

  // أسطر المقارنة للطلبية المختارة: من المطابقة إن وُجدت، وإلا من الطلبية نفسها بلا كميات مجهّزة
  const compareLines: ReadLine[] = useMemo(() => {
    if (pickedCandidate) return pickedCandidate.lines;
    if (!pickedOrder) return [];
    return pickedOrder.lines.map(l => ({ lineId: l.id!, itemName: l.itemName, quantity: l.quantity, bonusQty: l.bonusQty, invoiceItem: null, preparedQty: l.quantity, preparedBonus: l.bonusQty }));
  }, [pickedCandidate, pickedOrder]);

  useEffect(() => {
    setQty(Object.fromEntries(compareLines.map(l => [l.lineId, { p: String(l.preparedQty), b: l.preparedBonus ? String(l.preparedBonus) : '' }])));
  }, [compareLines]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const rows = (orders ?? []).filter(o => !t || `${o.id} ${o.pharmacyName} ${o.warehouseName} ${o.areaName ?? ''} ${o.repName}`.toLowerCase().includes(t));
    // الأعلى تطابقاً مع الفاتورة أولاً، ثم غير المجهّزة
    const score = (o: Order) => candidateById.get(o.id)?.score ?? -1;
    return rows.sort((a, b) => score(b) - score(a) || Number(stateOf(a) === 'prepared') - Number(stateOf(b) === 'prepared'));
  }, [orders, q, candidateById]);

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      if (kind === 'prepared' && read?.token) {
        await api(`/${picked}/apply-invoice`, {
          method: 'POST',
          body: JSON.stringify({
            token: read.token,
            invoiceNumber: read.invoice?.invoiceNumber ?? null,
            lines: compareLines.map(l => ({ lineId: l.lineId, preparedQty: Number(qty[l.lineId]?.p) || 0, preparedBonus: Number(qty[l.lineId]?.b) || 0 })),
          }),
        });
      } else {
        const fd = new FormData();
        fd.append('image', await compressImage(firstFile), `${kind}.jpg`);
        await api(`/${picked}/image/${kind}`, { method: 'POST', body: fd });
      }
      onDone();
    } catch (e: any) { alert(e.message); setSaving(false); }
  };

  const inv = read?.invoice;
  return (
    <div className="ro-modal">
      <div className="ro-dialog">
        <div className="ro-dialog__head">
          <strong>ربط الصورة بطلبية</strong>
          <button className="ro-icon-btn" onClick={onCancel}><X size={16} /></button>
        </div>
        <div className="ro-dialog__body">
          <div className="ro-share-top">
            <div className="ro-share-thumbs">{urls.slice(0, 1).map(u => <img key={u} src={u} alt="الصورة المُشارَكة" />)}</div>
            <div className="ro-share-read">
              <div className="ro-chips">
                <button className={`ro-chip ${kind === 'prepared' ? 'is-active' : ''}`} onClick={() => setKind('prepared')}>فاتورة التجهيز</button>
                <button className={`ro-chip ${kind === 'invoice' ? 'is-active' : ''}`} onClick={() => setKind('invoice')}>ختم الصيدلية</button>
              </div>
              {kind === 'prepared' && (reading ? (
                <div className="ro-muted ro-small">⏳ جارٍ قراءة الفاتورة والتعرّف على الطلبية… (قد تستغرق نصف دقيقة)</div>
              ) : inv ? (
                <dl className="ro-info">
                  {inv.pharmacy && <><dt>الصيدلية</dt><dd>{inv.pharmacy}</dd></>}
                  {inv.warehouse && <><dt>المذخر</dt><dd>{inv.warehouse}</dd></>}
                  {inv.dateText && <><dt>التاريخ</dt><dd>{inv.dateText}</dd></>}
                  {inv.invoiceNumber && <><dt>رقم الفاتورة</dt><dd>{inv.invoiceNumber}</dd></>}
                  <dt>الأصناف</dt><dd>{inv.items.length}</dd>
                </dl>
              ) : (
                <div className="ro-note ro-note--warn">تعذّرت قراءة الفاتورة{read?.readError ? ` — ${read.readError}` : ''}. اختر الطلبية يدوياً.</div>
              ))}
              {kind === 'prepared' && !reading && read?.autoOrderId && picked === read.autoOrderId && (
                <div className="ro-auto">✅ تم التعرّف تلقائياً على الطلبية #{read.autoOrderId} (تطابق {candidateById.get(read.autoOrderId)?.score}%)</div>
              )}
              {kind === 'prepared' && !reading && inv && !read?.autoOrderId && (
                <div className="ro-muted ro-small">لم يُحسم التطابق تلقائياً — اختر الطلبية من القائمة (الأقرب أولاً).</div>
              )}
            </div>
          </div>

          {kind === 'prepared' && picked && compareLines.length > 0 && (
            <div className="ro-compare">
              <div className="ro-slot__label">الكميات المجهّزة فعلاً (من الفاتورة — يمكن تصحيحها)</div>
              <table className="ro-lines">
                <thead><tr><th>الصنف</th><th>المطلوب</th><th>المجهّز</th><th>بونص مجهّز</th></tr></thead>
                <tbody>
                  {compareLines.map(l => {
                    const p = Number(qty[l.lineId]?.p) || 0;
                    const diff = p !== l.quantity;
                    return (
                      <tr key={l.lineId} className={diff ? 'ro-diff' : ''}>
                        <td>
                          <div className="ro-strong">{l.itemName}</div>
                          {l.invoiceItem ? <div className="ro-sub"><span>بالفاتورة: {l.invoiceItem}</span></div>
                            : pickedCandidate ? <div className="ro-sub"><span className="ro-warn-text">غير موجود بالفاتورة</span></div> : null}
                        </td>
                        <td>{l.quantity}{l.bonusQty ? ` + ${l.bonusQty}` : ''}</td>
                        <td><input className="form-input ro-qty" type="number" min={0} inputMode="numeric" value={qty[l.lineId]?.p ?? ''} onChange={e => setQty(s => ({ ...s, [l.lineId]: { ...s[l.lineId], p: e.target.value } }))} /></td>
                        <td><input className="form-input ro-qty" type="number" min={0} inputMode="numeric" value={qty[l.lineId]?.b ?? ''} onChange={e => setQty(s => ({ ...s, [l.lineId]: { ...s[l.lineId], b: e.target.value } }))} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {pickedCandidate && pickedCandidate.extraItems.length > 0 && (
                <div className="ro-muted ro-small">أصناف بالفاتورة غير موجودة بالطلبية: {pickedCandidate.extraItems.map(x => `${x.item} ×${x.quantity}`).join('، ')}</div>
              )}
            </div>
          )}

          <input className="form-input" placeholder="ابحث برقم الطلبية أو الصيدلية أو المذخر…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="ro-share-list">
            {orders === null && <div className="ro-muted">جارٍ التحميل…</div>}
            {orders !== null && list.length === 0 && <div className="ro-muted">لا طلبيات خلال آخر 30 يوماً.</div>}
            {list.map(o => {
              const st = stateOf(o);
              const sc = candidateById.get(o.id)?.score;
              return (
                <button key={o.id} className={`ro-share-item ro-row--${st} ${picked === o.id ? 'is-picked' : ''}`} onClick={() => setPicked(o.id)}>
                  <span className="ro-share-item__main">
                    <span className="ro-strong">{o.pharmacyName}</span>
                    <span className="ro-sub"><span>#{o.id}</span><span>{o.warehouseName}</span><span>{fmtDay(o.orderDate)}</span>{o.repName && <span>{o.repName}</span>}</span>
                  </span>
                  <span className="ro-share-item__end">
                    {kind === 'prepared' && sc != null && <span className={`ro-score ${sc >= 60 ? 'is-high' : ''}`}>{sc}%</span>}
                    <span className={`ro-badge ro-badge--${st}`}>{STATE_LABEL[st]}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="ro-dialog__foot">
          <button className="btn btn--primary" disabled={!picked || saving || (kind === 'prepared' && reading)} onClick={save}>{saving ? 'جارٍ الحفظ…' : 'حفظ في الطلبية'}</button>
          <button className="btn btn--secondary" onClick={onCancel}>إلغاء</button>
          {kind === 'prepared' && <span className="ro-muted ro-small">الطلبية تصير «مجهّزة» بعد الحفظ</span>}
        </div>
      </div>
    </div>
  );
}

function ImageSlot({ label, hint, src, canRemove, onPreview, onUpload, onRemove }: {
  label: string; hint?: string; src: string | null; canRemove: boolean;
  onPreview: (src: string) => void; onUpload: (f: File) => void; onRemove: () => void;
}) {
  return (
    <div className="ro-slot">
      <div className="ro-slot__label">{label}</div>
      {src ? (
        <div className="ro-slot__img">
          <img src={`${API}${src}`} alt={label} onClick={() => onPreview(src)} />
          {canRemove && <button className="ro-slot__x" title="حذف الصورة" onClick={onRemove}><X size={12} /></button>}
        </div>
      ) : (
        <label className="ro-slot__empty">
          <Camera size={18} />
          <span>إضافة صورة</span>
          {hint && <small>{hint}</small>}
          <input type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
        </label>
      )}
    </div>
  );
}

// ─── نموذج الطلبية ───────────────────────────────────────────────────────────

interface FormLine { key: number; text: string; itemId: number | null; companyName: string; quantity: string; bonusQty: string }
const newLine = (text = '', itemId: number | null = null, companyName = ''): FormLine => ({ key: Date.now() + Math.random(), text, itemId, companyName, quantity: '', bonusQty: '' });
const MAX_WAREHOUSES = 6; // الأساسي + 5 احتياط

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
    pharmacyName: order?.pharmacyName ?? '',
    areaName: order?.areaName ?? '',
    notes: order?.notes ?? '',
  });
  const [lines, setLines] = useState<FormLine[]>(() => order
    ? order.lines.map(l => ({ key: Math.random(), text: l.itemName, itemId: l.itemId, companyName: l.companyName ?? '', quantity: String(l.quantity), bonusQty: l.bonusQty ? String(l.bonusQty) : '' }))
    : []);
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [newWh, setNewWh] = useState<{ name: string; phone: string } | null>(null);
  // المذاخر بالترتيب: الأول أساسي، والبقية احتياط — إن لم يجهّز الأساسي تُرسل للتالي
  const [whIds, setWhIds] = useState<string[]>(() => {
    const ids = (order?.warehouses ?? []).map(w => String(w.id ?? '')).filter(Boolean);
    return ids.length ? ids : order?.warehouseId ? [String(order.warehouseId)] : [];
  });
  const [pickItems, setPickItems] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    fetch(`${API}/api/items`, { headers: h, cache: 'no-store' }).then(r => r.json()).then(j => setItems(Array.isArray(j?.data) ? j.data : [])).catch(() => {});
    fetch(`${API}/api/areas`, { headers: h }).then(r => r.json()).then(j => setAreas((j?.data ?? []).map((a: any) => a.name).filter(Boolean))).catch(() => {});
    api<{ pharmacies: { name: string; areaName: string | null }[] }>('/suggestions').then(r => setPharmacies(r.pharmacies)).catch(() => {});
  }, [token, api]);

  const setLine = (key: number, patch: Partial<FormLine>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const pickedIds = useMemo(() => new Set(lines.map(l => l.itemId).filter((x): x is number => x != null)), [lines]);
  // ايتمات مختارة دفعة واحدة من القائمة (+ اسم يدوي غير موجود بالكتالوج إن وُجد) ← أسطر بلا كميات بعد
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

  const addWarehouse = async () => {
    if (!newWh) return;
    try {
      const r = await api<{ warehouse: WarehouseRow }>('/warehouses', { method: 'POST', body: JSON.stringify(newWh) });
      onWarehousesChanged();
      const id = String(r.warehouse.id);
      setWhIds(ws => (ws.length < MAX_WAREHOUSES ? [...ws, id] : ws));
      setNewWh(null);
    } catch (e: any) { alert(e.message); }
  };
  const submit = async () => {
    setErr(null);
    const valid = lines.filter(l => l.text.trim() && Number(l.quantity) > 0);
    if (!whIds.length) return setErr('اختر المذخر (أو أضف مذخراً جديداً برقم واتسابه)');
    if (!head.pharmacyName.trim()) return setErr('اسم الصيدلية مطلوب');
    if (!valid.length) return setErr('أضف ايتماً واحداً على الأقل مع كميته');
    setSaving(true);
    try {
      const body = JSON.stringify({
        ...head,
        warehouseId: Number(whIds[0]),
        backupWarehouseIds: whIds.slice(1).map(Number),
        lines: valid.map(l => ({ itemId: l.itemId, itemName: l.text.trim(), companyName: l.companyName || null, quantity: Number(l.quantity), bonusQty: Number(l.bonusQty) || 0 })),
      });
      const r = await api<{ order: { id: number } }>(order ? `/${order.id}` : '', { method: order ? 'PUT' : 'POST', body });
      if (invoiceFile) {
        const fd = new FormData();
        fd.append('image', await compressImage(invoiceFile), 'invoice.jpg');
        await api(`/${r.order.id}/image/invoice`, { method: 'POST', body: fd });
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
            <WarehousePicker warehouses={warehouses} value={whIds} onChange={setWhIds} onNew={() => setNewWh({ name: '', phone: '' })} />
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
              <input className="form-input" placeholder="رقم واتساب المذخر 07… أو رابط كروبه" dir="ltr" value={newWh.phone} onChange={e => setNewWh({ ...newWh, phone: e.target.value })} />
              <button className="btn btn--primary btn--sm" onClick={addWarehouse}>حفظ المذخر</button>
              <button className="btn btn--secondary btn--sm" onClick={() => setNewWh(null)}>إلغاء</button>
            </div>
          )}

          <div className="ro-form-lines">
            {lines.length > 0 && <div className="ro-form-line ro-form-line--head"><span>الايتم</span><span>الشركة</span><span>الكمية</span><span>بونص</span><span /></div>}
            {lines.map(l => (
              <div key={l.key} className="ro-form-line">
                <div className="ro-line-item"><span className="ro-strong">{l.text}</span>{l.itemId && l.companyName && <span className="ro-show-sm ro-muted ro-small"> — {l.companyName}</span>}</div>
                {l.itemId
                  ? <div className="ro-line-co ro-muted">{l.companyName || '—'}</div>
                  : <input className="form-input" placeholder="الشركة" value={l.companyName} onChange={e => setLine(l.key, { companyName: e.target.value })} />}
                <input className="form-input" type="number" min={1} inputMode="numeric" placeholder="الكمية" value={l.quantity} onChange={e => setLine(l.key, { quantity: e.target.value })} />
                <input className="form-input" type="number" min={0} inputMode="numeric" placeholder="بونص" value={l.bonusQty} onChange={e => setLine(l.key, { bonusQty: e.target.value })} />
                <button className="ro-icon-btn" title="حذف السطر" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}><Trash2 size={14} /></button>
              </div>
            ))}
            <button className="btn btn--secondary btn--sm ro-self-start" onClick={() => setPickItems(true)}><Plus size={14} /> {lines.length ? 'ايتمات أخرى' : 'اختيار الايتمات'}</button>
          </div>
          {pickItems && <ItemPicker items={items} have={pickedIds} onAdd={addItems} onClose={() => setPickItems(false)} />}

          <label className="ro-field">ملاحظات
            <input className="form-input" value={head.notes} onChange={e => setHead(h => ({ ...h, notes: e.target.value }))} />
          </label>
          {!order?.invoiceImage && (
            <label className="ro-field">صورة ختم الصيدلية (اختياري)
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

// ─── اختيار المذاخر: حقل واحد، الترتيب بترتيب الاختيار (الأول أساسي) ─────────────

function WarehousePicker({ warehouses, value, onChange, onNew }: {
  warehouses: WarehouseRow[]; value: string[]; onChange: (v: string[]) => void; onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const nameOf = (id: string) => warehouses.find(w => String(w.id) === id)?.name ?? '…';
  const rankOf = (i: number) => (i === 0 ? 'الأساسي' : `احتياط ${i}`);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(x => x !== id) : value.length < MAX_WAREHOUSES ? [...value, id] : value);
  return (
    <div className="ro-field ro-msel" ref={ref}>
      <span>المذخر *</span>
      <button type="button" className="form-input ro-msel__btn" onClick={() => setOpen(v => !v)}>
        <span className="ro-msel__val">{value.length ? value.map(nameOf).join(' ← ') : 'اختر المذخر…'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="ro-gm__pop ro-msel__pop">
          {warehouses.map(w => {
            const id = String(w.id);
            const rank = value.indexOf(id);
            return (
              <button type="button" key={w.id} className={`ro-gm__opt ${rank >= 0 ? 'is-active' : ''}`} onClick={() => toggle(id)}>
                <span>{rank >= 0 ? '☑' : '☐'} {w.name}</span>{rank >= 0 && <b>{rankOf(rank)}</b>}
              </button>
            );
          })}
          <button type="button" className="ro-gm__opt" onClick={() => { setOpen(false); onNew(); }}>+ مذخر جديد…</button>
        </div>
      )}
      {value.length > 1 && (
        <div className="ro-msel__chips">
          {value.map((id, i) => (
            <span key={id} className="ro-msel__chip">
              <span className="ro-wh__rank">{rankOf(i)}</span> {nameOf(id)}
              {i > 0 && <button type="button" className="ro-msel__x" title="جعله الأساسي" onClick={() => onChange([id, ...value.filter(x => x !== id)])}>★</button>}
              <button type="button" className="ro-msel__x" title="إزالة" onClick={() => onChange(value.filter(x => x !== id))}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── اختيار الايتمات: قائمة بمربعات اختيار، عدة ايتمات دفعة واحدة ثم الكميات ────

function ItemPicker({ items, have, onAdd, onClose }: {
  items: CatalogItem[]; have: Set<number>;
  onAdd: (picked: CatalogItem[], freeText: string | null) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const terms = useMemo(() => normSearch(q).split(/\s+/).filter(Boolean), [q]);
  const list = useMemo(() => items.filter(i => !terms.length || terms.every(t => normSearch(itemLabel(i)).includes(t))).slice(0, 300), [items, terms]);
  const typed = q.trim();
  const exists = typed && items.some(i => normSearch(i.name) === normSearch(typed));
  const toggle = (id: number) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const picked = () => items.filter(i => sel.has(i.id));

  // زر الرجوع يغلق القائمة وحدها لا نموذج الطلبية: مستمع capture يسبق مستمع الصفحة
  useEffect(() => {
    const onBack = (e: Event) => { e.preventDefault(); onClose(); };
    window.addEventListener('before-navigate-back', onBack, true);
    return () => window.removeEventListener('before-navigate-back', onBack, true);
  }, [onClose]);

  return (
    <div className="ro-modal" onClick={onClose}>
      <div className="ro-dialog ro-dialog--narrow" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head">
          <strong>اختيار الايتمات</strong>
          <button className="ro-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ro-dialog__body">
          <input className="form-input" type="search" autoFocus value={q} onChange={e => setQ(e.target.value)} aria-label="بحث" />
          <div className="ro-ipick">
            {list.map(i => {
              const done = have.has(i.id);
              const on = sel.has(i.id);
              return (
                <label key={i.id} className={`ro-ipick__row ${on ? 'is-on' : ''} ${done ? 'is-done' : ''}`}>
                  <input type="checkbox" checked={on || done} disabled={done} onChange={() => toggle(i.id)} />
                  <span className="ro-strong">{i.name}</span>
                  {itemCompany(i) && <span className="ro-muted ro-small">{itemCompany(i)}</span>}
                </label>
              );
            })}
            {!list.length && <div className="ro-muted ro-ipick__empty">لا نتائج</div>}
          </div>
          {typed && !exists && (
            <button className="ro-link ro-self-start" onClick={() => onAdd(picked(), typed)}><Plus size={13} /> إضافة «{typed}» كايتم غير موجود بالقائمة</button>
          )}
        </div>
        <div className="ro-dialog__foot">
          <button className="btn btn--primary" disabled={!sel.size} onClick={() => onAdd(picked(), null)}>إضافة{sel.size ? ` ${sel.size}` : ''}</button>
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
  const [draft, setDraft] = useState<{ id: number | null; name: string; phone: string; groupLink: string; notes: string } | null>(null);

  const save = async () => {
    if (!draft) return;
    try {
      const body = JSON.stringify({ name: draft.name, phone: draft.phone, groupLink: draft.groupLink, notes: draft.notes });
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
          <div className="ro-muted ro-small">إن وُضع رابط كروب المذخر يُرسل زرّ الإرسال للكروب، وإلا لرقم الواتساب. الدليل مشترك بين حسابات المكتب.</div>
          {warehouses.length === 0 && <div className="ro-muted">لا مذاخر بعد.</div>}
          {warehouses.map(w => (
            <div key={w.id} className="ro-wh-row">
              <div>
                <strong>{w.name}</strong>
                {w.phone && <div className="ro-muted ro-small" dir="ltr">{w.phone}</div>}
                {w.groupLink && <div className="ro-muted ro-small">👥 كروب مربوط</div>}
                {w.notes && <div className="ro-muted ro-small">{w.notes}</div>}
              </div>
              {w.canEdit && (
                <div className="ro-row-actions">
                  <button className="ro-icon-btn" title="تعديل" onClick={() => setDraft({ id: w.id, name: w.name, phone: w.phone, groupLink: w.groupLink ?? '', notes: w.notes ?? '' })}><Pencil size={14} /></button>
                  <button className="ro-icon-btn ro-icon-btn--danger" title="حذف" onClick={() => remove(w)}><Trash2 size={14} /></button>
                </div>
              )}
            </div>
          ))}
          {draft ? (
            <div className="ro-newwh">
              <input className="form-input" placeholder="اسم المذخر" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
              <input className="form-input" placeholder="رقم واتساب 07…" inputMode="tel" dir="ltr" value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} />
              <input className="form-input" placeholder="رابط كروب المذخر https://chat.whatsapp.com/… (اختياري)" dir="ltr" value={draft.groupLink} onChange={e => setDraft({ ...draft, groupLink: e.target.value })} />
              <input className="form-input" placeholder="ملاحظة (اختياري)" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} />
              <button className="btn btn--primary btn--sm" onClick={save}>حفظ</button>
              <button className="btn btn--secondary btn--sm" onClick={() => setDraft(null)}>إلغاء</button>
            </div>
          ) : (
            <button className="btn btn--primary btn--sm ro-self-start" onClick={() => setDraft({ id: null, name: '', phone: '', groupLink: '', notes: '' })}><Plus size={14} /> إضافة مذخر</button>
          )}
        </div>
      </div>
    </div>
  );
}
