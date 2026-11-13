// ════════════════════════════════════════════════════════════════════════════
// RepOrdersPage — «طلبيات المذاخر».
// المندوب يكتب طلبيات اليوم (الصيدلية، المنطقة، المذخر، الأصناف والكميات، صورة
// ختم الصيدلية اختيارية) ويرسل الطلبية لرقم واتساب المذخر بضغطة (wa.me — يفتح محادثة
// المذخر والنص جاهز، والمندوب يضغط إرسال). المدير يرى طلبيات فريقه.
// • المصدر: /api/rep-orders (server/modules/rep-orders) — لا يدخل أي حسبة مبيعات.
// ════════════════════════════════════════════════════════════════════════════

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Send, Share2, Check, RotateCcw, Pencil, X, Warehouse, Ban, ChevronDown, Camera, Search, ClipboardList, LayoutList, Sparkles, Clock, CircleCheck, MapPin, CalendarDays, UserRound, Hash, CircleDot, Pill, ZoomIn, ZoomOut, Minus, ChevronLeft, ChevronRight, ClipboardPaste, Copy, Image as ImageIcon, FileSpreadsheet } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ItemPicker, itemCompany, normSearch, type CatalogItem } from '../components/OrderItemPicker';
import { compressImage, readDataUrl, loadImg } from '../lib/localImage';
import ViberImportPanel, { ViberFeedbackButtons, ViberInvoicesButton } from '../components/rep-orders/ViberImportPanel';
import './RepOrdersPage.css';

const API = import.meta.env.VITE_API_URL || '';
const SHARE_CACHE = 'ordine-share'; // نفس الاسم في public/sw.js

type Status = 'pending' | 'prepared' | 'cancelled';

interface OrderLine { id?: number; itemId: number | null; itemName: string; companyName: string | null; quantity: number; bonusQty: number; preparedQty?: number | null; preparedBonus?: number | null; unitPrice?: number | null }
interface OrderWh { id: number | null; name: string; phone: string | null; groupLink?: string | null; handle?: string | null }
type SendOutcome = 'sent' | 'prepared' | 'partial' | 'rejected';
interface SendLine { lineId: number; itemName: string; qty: number; bonus: number }
interface OrderSend { id: number; warehouseId: number | null; warehouseName: string; sentAt: string; outcome: SendOutcome; outcomeAt: string | null; image: string | null; whSeq?: number | null; lines: SendLine[] }
interface Order {
  id: number; orderDate: string; createdById: number; repName: string; assignedBy?: string | null;
  warehouseId: number | null; warehouseName: string; warehousePhone: string | null;
  warehouses: OrderWh[]; lastSentWarehouseId: number | null;
  pharmacyName: string; areaName: string | null; notes: string | null;
  status: Status; invoiceImage: string | null; preparedImage: string | null; invoiceNumber?: string | null; createdAt: string; sentAt: string | null; sentCount: number;
  preparedAt: string | null; preparedBy: string | null; lines: OrderLine[]; sends: OrderSend[]; canEdit: boolean;
  // «استيراد من الفايبر»: viber-paste | viber-shot، ومتى نُسخ الرد للفايبر
  source?: string | null; sourceText?: string | null; sourceSender?: string | null; feedbackCopiedAt?: string | null;
}
interface WarehouseRow {
  id: number; name: string; phone: string; groupLink: string | null; notes: string | null; canEdit: boolean;
  province?: string | null; provinceGuess?: string | null; handle?: string | null;
}


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

const remainingOf = (l: OrderLine) => Math.max(0, l.quantity - (l.preparedQty ?? 0));
/** جُهّز جزء منها ولم تكتمل */
const isPartial = (o: Order) => o.status !== 'prepared' && o.lines.some(l => (l.preparedQty ?? 0) > 0);

// نتيجة كل إرسال لمذخر — «بانتظار الرد» لآخر إرسال فقط، وما قبله بلا تسجيل = «بلا رد»
type SendMark = SendOutcome | 'noreply';
const SEND_LABEL: Record<SendMark, string> = { sent: 'بانتظار الرد', noreply: 'بلا رد', prepared: 'جهّز كامل', partial: 'جهّز جزئي', rejected: 'لم يجهّز' };
const markOf = (o: Order, s: OrderSend): SendMark => (s.outcome === 'sent' && s !== o.sends[o.sends.length - 1] ? 'noreply' : s.outcome);
/**
 * نتيجة مذخر للطلبية: «بانتظار الرد» إن كان آخر من أُرسلت له ولم يرد، وإلا آخر نتيجة
 * مسجّلة له (جهّز/جزئي/لم يجهّز) — إعادة إرسال المتبقي له بلا رد لا تمحو ما جهّزه.
 */
const whMarkOf = (o: Order, whId: number | null): SendMark | null => {
  const mine = o.sends.filter(s => s.warehouseId === whId);
  if (!mine.length) return null;
  const last = mine[mine.length - 1];
  if (last.outcome === 'sent' && last === o.sends[o.sends.length - 1]) return 'sent';
  const recorded = [...mine].reverse().find(s => s.outcome !== 'sent');
  return recorded ? recorded.outcome : markOf(o, last);
};

/**
 * ما جهّزه مذخر معيّن لهذه الطلبية (مجموع كل إرسالاته): الأصناف + كمياتها + قيمتها،
 * وفواتيره المرفوعة — تُعرض عند فتح المذخر داخل الطلبية.
 */
const whStatsOf = (o: Order, whId: number | null) => {
  const mine = o.sends.filter(s => s.warehouseId === whId);
  const got = new Map<number, { q: number; b: number }>();
  for (const s of mine) for (const x of s.lines) {
    const c = got.get(x.lineId) ?? { q: 0, b: 0 };
    c.q += x.qty; c.b += x.bonus; got.set(x.lineId, c);
  }
  const items = o.lines.filter(l => l.id != null && (got.get(l.id)?.q ?? 0) > 0).map(l => ({ l, ...got.get(l.id!)! }));
  // الناقص عنده = ما بقي من الصنف بعد ما جهّزته المذاخر الأخرى وما جهّزه هو
  const short = o.lines.map(l => {
    const mineQ = l.id != null ? got.get(l.id)?.q ?? 0 : 0;
    const others = (l.preparedQty ?? 0) - mineQ;
    return { l, n: Math.max(0, l.quantity - others - mineQ) };
  }).filter(x => x.n > 0);
  const value = items.reduce((s, it) => s + (it.l.unitPrice ?? 0) * it.q, 0);
  return { mine, items, short, value, images: mine.filter(s => s.image).map(s => s.image!) };
};

/** آخر إرسال لمذخر معيّن */
const lastSendTo = (o: Order, whId: number | null) => [...o.sends].reverse().find(s => s.warehouseId === whId) ?? null;

/** فاتورة المذخر قد تصل ملف PDF (من نظامه) لا صورة — تُعرض رابطاً يُفتح لا <img>. */
const isPdfPath = (p: string | null | undefined) => Boolean(p && /\.pdf$/i.test(p));

/** المذخر الحالي للطلبية: آخر مذخر أُرسلت له، وإلا الأساسي. */
const currentWh = (o: Order): OrderWh => o.warehouses.find(w => w.id != null && w.id === o.lastSentWarehouseId) ?? o.warehouses[0] ?? { id: o.warehouseId, name: o.warehouseName, phone: o.warehousePhone };

/** المذخر المقترح للإرسال التالي: الأول إن لم تُرسل، وإلا الاحتياط الذي يلي آخر مذخر أُرسلت له. */
const nextWh = (o: Order): OrderWh => {
  if (!o.sentAt || o.lastSentWarehouseId == null) return o.warehouses[0];
  const i = o.warehouses.findIndex(w => w.id === o.lastSentWarehouseId);
  return o.warehouses[i + 1] ?? o.warehouses[Math.max(0, i)];
};

/** رقم الطلبية عند مذخر: ترقيم مستقل لكل مذخر (whSeq) — وإلا id الطلبية */
const whSeqOf = (o: Order, whId: number | null) => o.sends.find(sd => sd.warehouseId === whId && sd.whSeq != null)?.whSeq ?? null;

// ما يصل المذخر: الصيدلية والمنطقة + المتبقي من الأصناف. بلا «طلبية رقم» (طلب صاحب المشروع)
// ولا مندوب/مذخر/تاريخ/ملاحظات/صورة ختم (صورة الختم مؤجّلة — تُعاد هنا إن طُلبت).
function orderText(o: Order): string {
  const out: string[] = [];
  out.push(`*الصيدلية: ${o.pharmacyName}*`);
  if (o.areaName) out.push(`المنطقة: ${o.areaName}`);
  out.push('──────────');
  o.lines.filter(l => remainingOf(l) > 0).forEach((l, i) => {
    const b = Math.max(0, l.bonusQty - (l.preparedBonus ?? 0));
    const bonus = b ? ` + بونص ${b}` : '';
    out.push(`${i + 1}) ${l.itemName}${l.companyName ? ` (${l.companyName})` : ''} — الكمية: ${remainingOf(l)}${bonus}`);
  });
  return out.join('\n');
}

/**
 * رابط معرّف المذخر: @يوزر (أو wa.me/يوزر) ← محادثته في واتساب بمعرّف الواتساب
 * (wa.me/<username>)، وt.me/يوزر ← تيليكرام، وأي رابط آخر يُفتح كما هو.
 * النص يُمرَّر في ?text= — إن تجاهله التطبيق فالطلبية منسوخة أيضاً. null = ليس معرّفاً صالحاً.
 */
const handleUrl = (raw?: string | null, text = ''): string | null => {
  const h = String(raw ?? '').trim();
  if (!h) return null;
  const q = text ? `?text=${encodeURIComponent(text)}` : '';
  const tg = h.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/@?([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i);
  if (tg) return `https://t.me/${tg[1]}${q}`;
  const wa = h.match(/^(?:https?:\/\/)?wa\.me\/@?([A-Za-z0-9._]*[A-Za-z][A-Za-z0-9._]*)\/?$/i) ?? h.match(/^@?([A-Za-z0-9._]*[A-Za-z][A-Za-z0-9._]*)$/);
  if (wa && wa[1].length >= 3 && wa[1].length <= 35) return `https://wa.me/${wa[1].toLowerCase()}${q}`;
  return /^https?:\/\/\S+$/i.test(h) ? h : null;
};

// قناة الإرسال اليدوي للمذخر: كروبه (واتساب/فايبر) إن حُفظ رابطه، وإلا رقمه، وإلا معرّفه، وإلا المشاركة
type Channel = 'wa-group' | 'viber-group' | 'wa-number' | 'wa-user' | 'tg' | 'link' | 'share';
const channelOf = (wh?: OrderWh | null): Channel => {
  if (wh?.groupLink) return /viber\.com/i.test(wh.groupLink) ? 'viber-group' : 'wa-group';
  if (toWaNumber(wh?.phone)) return 'wa-number';
  const url = handleUrl(wh?.handle);
  if (url) return url.startsWith('https://wa.me/') ? 'wa-user' : url.startsWith('https://t.me/') ? 'tg' : 'link';
  return 'share';
};
const CHANNEL_LABEL: Record<Channel, string> = { 'wa-group': 'كروب واتساب', 'viber-group': 'كروب فايبر', 'wa-number': 'واتساب', 'wa-user': 'واتساب (معرّف)', tg: 'تيليكرام', link: 'رابط المذخر', share: 'مشاركة' };
const IS_TOUCH = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

// أيقونة التطبيق فقط (واتساب/فايبر) بدل نص القناة — التفصيل في title
const HANDSET = 'M9.1 7.2c-.2-.5-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4s-1.2 1.1-1.2 2.7 1.2 3.2 1.4 3.4c.2.2 2.3 3.7 5.7 5 2.8 1.1 3.4.9 4 .8.6-.1 2-.8 2.2-1.6.3-.8.3-1.5.2-1.6-.1-.1-.3-.2-.6-.4l-2-1c-.3-.1-.5-.2-.7.1l-.9 1.2c-.2.2-.4.2-.7.1-.3-.1-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6l.5-.6c.2-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.2z';
function ChannelIcon({ ch, size = 16 }: { ch: Channel; size?: number }) {
  if (ch === 'share' || ch === 'link') return null;
  if (ch === 'tg') {
    return (
      <svg className="ro-ch-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={CHANNEL_LABEL[ch]}>
        <title>{CHANNEL_LABEL[ch]}</title>
        <circle cx="12" cy="12" r="10" fill="#229ED9" />
        <path fill="#fff" d="M6.2 11.6l9.9-3.8c.5-.2.9.1.7.8l-1.7 7.9c-.1.6-.5.7-1 .4l-2.6-1.9-1.3 1.2c-.1.1-.3.3-.6.3l.2-2.7 4.8-4.4c.2-.2 0-.3-.3-.1l-6 3.8-2.6-.8c-.6-.2-.6-.6.1-.9z" />
      </svg>
    );
  }
  const viber = ch === 'viber-group';
  return (
    <svg className="ro-ch-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={CHANNEL_LABEL[ch]}>
      <title>{CHANNEL_LABEL[ch]}</title>
      {viber
        ? <path fill="#7360F2" d="M12 2C6.5 2 3 4.6 3 10.2c0 3.2 1.1 5.4 3 6.7V21l3.2-2.6c.9.2 1.8.3 2.8.3 5.5 0 9-2.6 9-8.5S17.5 2 12 2z" />
        : <path fill="#25D366" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2z" />}
      <path fill="#fff" d={HANDSET} transform={viber ? 'translate(2.2 1.6) scale(.82)' : undefined} />
    </svg>
  );
}

/** نص رسالة المذخر: طلبية واحدة أو عدة طلبيات في رسالة واحدة. */
const ordersText = (list: Order[]) => (list.length === 1
  ? orderText(list[0])
  : [`*${list.length} طلبيات*`, ...list.map(o => `\n${orderText(o)}`)].join('\n'));

/** النص المرافق لصورة الطلبية (خارجها): اسم الصيدلية ومنطقتها — بلا «طلبية رقم». */
const ordersCaption = (list: Order[]) => list
  .map(o => [`الصيدلية: ${o.pharmacyName}`, ...(o.areaName ? [`المنطقة: ${o.areaName}`] : [])].join('\n'))
  .join('\n\n');

/**
 * صورة الطلبية (ميزة rep_orders_image_send): نفس محتوى orderText — رقمها عند المذخر +
 * الصيدلية والمنطقة + المتبقي من الأصناف — جدولاً على canvas. متزامنة كلها (toDataURL لا
 * toBlob) كي تبقى المشاركة داخل ضغطة المستخدم؛ Safari يرفض navigator.share بعد انتظار.
 */
function orderImageFile(list: Order[], nos: number[]): File | null {
  const W = 1000, PAD = 36, ROW_PAD = 14, LINE = 34;
  const F = (w: number, px: number) => `${w} ${px}px Tajawal, 'Segoe UI', Tahoma, sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  // الأعمدة من اليمين: # | الصنف | الكمية | البونص
  const R = W - PAD, numW = 64, qtyW = 130, bonW = 130;
  const nameR = R - numW, nameL = PAD + qtyW + bonW + 12, nameW = nameR - nameL;
  const wrap = (text: string, font: string, max: number) => {
    ctx.font = font;
    const out: string[] = [];
    let cur = '';
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const t = cur ? `${cur} ${w}` : w;
      if (cur && ctx.measureText(t).width > max) { out.push(cur); cur = w; } else cur = t;
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  };
  const blocks = list.map((o, i) => ({
    no: nos[i], o,
    rows: o.lines.filter(l => remainingOf(l) > 0).map(l => ({
      name: wrap(l.itemName, F(700, 27), nameW),
      company: l.companyName ? wrap(l.companyName, F(500, 21), nameW) : [],
      qty: remainingOf(l),
      bonus: Math.max(0, l.bonusQty - (l.preparedBonus ?? 0)),
    })),
  }));
  const rowH = (r: typeof blocks[number]['rows'][number]) => ROW_PAD * 2 + r.name.length * LINE + r.company.length * 26;
  const HEAD = 72, AREA = 54, THEAD = 50, GAP = 28;
  const infoH = (b: typeof blocks[number]) => (b.o.areaName ? AREA : 0);
  const H = PAD + blocks.reduce((s, b) => s + HEAD + infoH(b) + THEAD + b.rows.reduce((x, r) => x + rowH(r), 0) + GAP, 0) - GAP + PAD;
  c.width = W; c.height = H;
  ctx.direction = 'rtl';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  let y = PAD;
  for (const b of blocks) {
    // الترويسة: اسم الصيدلية (بلا «طلبية رقم» — طلب صاحب المشروع)
    ctx.fillStyle = '#0f766e'; ctx.fillRect(PAD, y, W - PAD * 2, HEAD);
    ctx.fillStyle = '#ffffff'; ctx.font = F(800, 32); ctx.textAlign = 'right';
    ctx.fillText(`الصيدلية: ${b.o.pharmacyName}`, R - 18, y + HEAD / 2, W - PAD * 2 - 190);
    ctx.font = F(600, 24); ctx.textAlign = 'left';
    ctx.fillText(`${b.rows.length} صنف`, PAD + 18, y + HEAD / 2);
    y += HEAD;
    // المنطقة
    ctx.textAlign = 'right';
    if (b.o.areaName) { ctx.fillStyle = '#334155'; ctx.font = F(700, 27); ctx.fillText(`المنطقة: ${b.o.areaName}`, R - 6, y + AREA / 2); }
    y += infoH(b);
    // رأس الجدول
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(PAD, y, W - PAD * 2, THEAD);
    ctx.fillStyle = '#334155'; ctx.font = F(700, 23); ctx.textAlign = 'center';
    ctx.fillText('#', R - numW / 2, y + THEAD / 2);
    ctx.fillText('الكمية', PAD + bonW + qtyW / 2, y + THEAD / 2);
    ctx.fillText('البونص', PAD + bonW / 2, y + THEAD / 2);
    ctx.textAlign = 'right'; ctx.fillText('الصنف', nameR - 8, y + THEAD / 2);
    y += THEAD;
    b.rows.forEach((r, i) => {
      const h = rowH(r);
      if (i % 2) { ctx.fillStyle = '#f8fafc'; ctx.fillRect(PAD, y, W - PAD * 2, h); }
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD, y + h); ctx.lineTo(W - PAD, y + h); ctx.stroke();
      const mid = y + h / 2;
      ctx.textAlign = 'center'; ctx.fillStyle = '#64748b'; ctx.font = F(600, 24);
      ctx.fillText(String(i + 1), R - numW / 2, mid);
      ctx.fillStyle = '#0f172a'; ctx.font = F(800, 32);
      ctx.fillText(String(r.qty), PAD + bonW + qtyW / 2, mid);
      ctx.fillStyle = r.bonus ? '#b45309' : '#cbd5e1'; ctx.font = F(700, 28);
      ctx.fillText(r.bonus ? String(r.bonus) : '—', PAD + bonW / 2, mid);
      ctx.textAlign = 'right';
      let ty = y + ROW_PAD + LINE / 2;
      ctx.fillStyle = '#0f172a'; ctx.font = F(700, 27);
      for (const t of r.name) { ctx.fillText(t, nameR - 8, ty); ty += LINE; }
      ctx.fillStyle = '#64748b'; ctx.font = F(500, 21);
      ty -= (LINE - 26) / 2;
      for (const t of r.company) { ctx.fillText(t, nameR - 8, ty); ty += 26; }
      y += h;
    });
    ctx.strokeStyle = '#cbd5e1'; ctx.strokeRect(PAD + 0.5, y - b.rows.reduce((x, r) => x + rowH(r), 0) - THEAD - infoH(b) - HEAD + 0.5, W - PAD * 2 - 1, HEAD + infoH(b) + THEAD + b.rows.reduce((x, r) => x + rowH(r), 0) - 1);
    y += GAP;
  }
  const bin = atob(c.toDataURL('image/png').split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], `order-${nos.join("-")}.png`, { type: 'image/png' });
}

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

/** رابط عرض لصورة محلية: blob: أولاً، وإن تعذّر عرضه (صور مُشارَكة ببعض متصفحات أندرويد) ← data: */
function useLocalImage(file: Blob | null): [string | null, () => void] {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const fallback = () => {
    if (!file || url?.startsWith('data:')) return;
    readDataUrl(file).then(setUrl).catch(() => {});
  };
  return [url, fallback];
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
  if (o.status === 'prepared' || (o.preparedImage && !o.sends.length)) return 'prepared';
  return o.sentAt ? 'following' : 'new';
};
const STATE_LABEL: Record<DisplayState, string> = { new: 'جديد', following: 'قيد المتابعة', prepared: 'تم التجهيز', cancelled: 'ملغاة' };
type View = 'all' | DisplayState;
const VIEWS: View[] = ['all', 'new', 'following', 'prepared', 'cancelled'];
const VIEW_LABEL: Record<View, string> = { all: 'الكل', ...STATE_LABEL };
const inView = (o: Order, v: View) => v === 'all' || stateOf(o) === v;
const VIEW_ICON: Record<View, typeof LayoutList> = { all: LayoutList, new: Sparkles, following: Clock, prepared: CircleCheck, cancelled: Ban };
const PERIOD_LABEL: Record<Period, string> = { all: 'كل التواريخ', today: 'اليوم', yesterday: 'أمس', week: 'آخر 7 أيام', month: 'هذا الشهر', custom: 'تاريخ محدد' };
const dayTitle = (iso: string) => (iso === today() ? 'اليوم' : iso === shiftDay(-1) ? 'أمس' : null);

// ─── تصدير Excel بحقول ملف ميركاتو نفسها: صف لكل ايتم، كل الطلبيات المحمّلة بكل حالاتها ───
const lineStatus = (o: Order, l: OrderLine) => {
  if (o.status === 'cancelled') return 'ملغاة';
  const done = l.preparedQty ?? 0;
  if (done >= l.quantity || (o.status === 'prepared' && !done)) return 'مجهّزة';
  if (done > 0) return `جزئية ${done}/${l.quantity}`;
  return o.sentAt ? 'بانتظار التجهيز' : 'لم تُرسل';
};
async function exportOrdersExcel(orders: Order[], warehouses: WarehouseRow[], fileTag: string) {
  const XLSX = await import('xlsx');
  const whProvince = new Map(warehouses.map(w => [w.id, w.province || w.provinceGuess || '']));
  const rows = orders.flatMap(o => {
    const wh = currentWh(o);
    return o.lines.map(l => ({
      'رقم طلبية المذخر': o.id,
      'أنشات بتاريخ': fmtDay(o.orderDate),
      'حالة طلبية المذخر': STATE_LABEL[stateOf(o)],
      'اسم الشركة': o.pharmacyName,
      'المنطقة': o.areaName ?? '',
      'المدينة': (wh.id != null ? whProvince.get(wh.id) : '') ?? '',
      'اسم المندوب': o.repName,
      'الصنف': l.companyName ?? '',
      'اسم المادة بالمكتب': l.itemName,
      'الكمية': l.quantity,
      'كمية البونص': l.bonusQty,
      'السعر': l.unitPrice ?? '',
      'المجموع الكلي': l.unitPrice != null ? l.unitPrice * l.quantity : '',
      'اسم المذخر': wh.name,
      'حالة المادة بطلبية المذخر': lineStatus(o, l),
    }));
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const keys = Object.keys(rows[0] ?? {});
  ws['!cols'] = keys.map(k => ({ wch: Math.min(40, Math.max(k.length + 2, ...rows.slice(0, 300).map(r => String((r as any)[k] ?? '').length + 1))) }));
  ws['!autofilter'] = { ref: ws['!ref'] ?? 'A1' };
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, 'الطلبيات');
  XLSX.writeFile(wb, `طلبيات-المذاخر-${fileTag}.xlsx`);
}

// عدّاد يصعد للرقم الجديد بنعومة
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    const start = fromRef.current, diff = value - start;
    if (!diff) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 450);
      const v = Math.round(start + diff * (1 - Math.pow(1 - k, 3)));
      setShown(v); fromRef.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown}</>;
}

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
const searchTextOf = (o: Order) => normSearch([
  o.id, `#${o.id}`, o.pharmacyName, o.areaName, o.repName, o.notes, o.invoiceNumber,
  ...o.warehouses.map(w => w.name), o.warehouseName,
  ...o.lines.flatMap(l => [l.itemName, l.companyName]),
].filter(Boolean).join(' '));

// تاريخ مختصر «شهر-يوم» (10-8) بلا وقت؛ السنة فقط إن لم تكن السنة الحالية
const shortOf = (y: number, m: number, d: number) => (y === new Date().getFullYear() ? `${m}-${d}` : `${y}-${m}-${d}`);
const fmtShortDay = (iso: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? shortOf(+m[1], +m[2], +m[3]) : '';
};
const fmtShort = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? fmtShortDay(iso) : shortOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

export default function RepOrdersPage() {
  const { token, hasFeature } = useAuth();
  // مسوّق المحافظة يكتب طلبياته فقط: الإرسال وإدارة دليل المذاخر لمديره (الخادم يفرض ذلك أيضاً)
  const [canDispatch, setCanDispatch] = useState(false);
  // «إرسال للمذاخر»: البوت يرسل الطلبية للمذخر ويستقبل ردّه بدل فتح wa.me
  const canBotSend = hasFeature('warehouse_dispatch') && canDispatch;
  // «إرسال الطلبية كصورة» (اشتراك لكل حساب) — بدونها يبقى الإرسال اليدوي نصاً
  const asImage = hasFeature('rep_orders_image_send');
  // «📥 استيراد من الفايبر» + أزرار الرد للفايبر (اشتراك لكل حساب)
  const viberImport = hasFeature('rep_orders_viber_import');
  const [showViber, setShowViber] = useState(false);
  // ما وصل بـ«مشاركة ← Ordine» ويُفتح مباشرة في لوحة الفايبر (نص رسالة، أو سكرين شوت)
  const [viberInit, setViberInit] = useState<{ text?: string; images?: File[] } | null>(null);
  const openViber = (init: { text?: string; images?: File[] } | null = null) => { setViberInit(init); setShowViber(true); };
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
  const [whNextSeq, setWhNextSeq] = useState<Record<number, number>>({});
  const [isManager, setIsManager] = useState(false);
  const [viewerId, setViewerId] = useState<number | null>(null);
  const [assignableReps, setAssignableReps] = useState<{ id: number; name: string }[]>([]);
  const [exporting, setExporting] = useState(false);
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [provinces, setProvinces] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // طلبية واحدة مفتوحة فقط، وتُخفى البقية حتى ينصبّ التركيز على صيدليتها
  const [openId, setOpenId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Order | 'new' | null>(null);
  const [showWarehouses, setShowWarehouses] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const loadWarehouses = useCallback(() => {
    if (!token) return;
    api<{ warehouses: WarehouseRow[]; provinces?: string[] }>('/warehouses').then(r => { setWarehouses(r.warehouses); setProvinces(r.provinces ?? []); }).catch(() => {});
  }, [token, api]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setErr(null);
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    try {
      const r = await api<{ orders: Order[]; viewer: { id: number; isManager: boolean; canDispatch: boolean }; assignableReps?: { id: number; name: string }[]; whNextSeq?: Record<number, number> }>(`?${q}`);
      setOrders(r.orders); setIsManager(r.viewer.isManager); setViewerId(r.viewer.id); setAssignableReps(r.assignableReps ?? []); setCanDispatch(r.viewer.canDispatch); setWhNextSeq(r.whNextSeq ?? {});
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [token, api, from, to]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadWarehouses(); }, [loadWarehouses]);

  // صور أو نص وصلت عبر «مشاركة ← Ordine» (sw.js خزّنها في كاش ordine-share):
  // الصور ← ربط بطلبية (أو «طلبيات فايبر» من نافذتها)، النص وحده ← لوحة استيراد الفايبر
  const [shared, setShared] = useState<Blob[]>([]);
  useEffect(() => {
    try { sessionStorage.removeItem('ro-share'); } catch { /* ignore */ }
    if (!('caches' in window)) return;
    (async () => {
      const cache = await caches.open(SHARE_CACHE);
      const keys = await cache.keys();
      const textKey = keys.find(k => new URL(k.url).pathname === '/shared-text');
      const imageKeys = keys.filter(k => k !== textKey);
      // نسخة في الذاكرة مستقلة عن الكاش (الكاش يُحذف بعد الربط أو بمشاركة جديدة)
      const blobs = await Promise.all(imageKeys.map(async k => {
        const b = await (await cache.match(k))!.blob();
        return new Blob([await b.arrayBuffer()], { type: b.type || 'image/jpeg' });
      }));
      if (blobs.length) { setShared(blobs); return; }
      if (!textKey) return;
      const text = (await (await cache.match(textKey))?.text()) ?? '';
      await caches.delete(SHARE_CACHE);
      if (!text.trim()) return;
      if (viberImport) openViber({ text });
      else setNotice('لإدخال طلبية من نص مُشارَك فعّل ميزة «استيراد طلبيات الفايبر» من المميزات');
    })().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (showViber)      { ce.preventDefault(); setShowViber(false); return; }
      if (editing)        { ce.preventDefault(); setEditing(null); return; }
      if (showWarehouses) { ce.preventDefault(); setShowWarehouses(false); return; }
      if (openId != null) { ce.preventDefault(); setOpenId(null); }
    };
    window.addEventListener('before-navigate-back', onBack);
    return () => window.removeEventListener('before-navigate-back', onBack);
  }, [preview, editing, showWarehouses, openId, showViber]);


  // ── الإرسال لواتساب المذخر ─────────────────────────────────────────────────
  // تُفتح النافذة قبل أي await كي لا يحجبها المتصفح كنافذة منبثقة.
  // الأولوية: كروب المذخر (رابط الدعوة يفتح الكروب والنص منسوخ — wa.me لا يصل للكروبات)
  // ← رقمه (wa.me والنص جاهز) ← قائمة المشاركة يختار منها المندوب أي محادثة/كروب.
  const [notice, setNotice] = useState<string | null>(null);
  // «إرسال كصورة» بالموبايل: بعد نسخ الصورة، زر يفتح كروب المذخر (الضغطة الثانية)
  const [openPrompt, setOpenPrompt] = useState<{ text: string; label: string; url: string; done: () => void } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  const markSent = (list: Order[], wh: OrderWh) =>
    api('/mark-sent', { method: 'POST', body: JSON.stringify({ ids: list.map(o => o.id), warehouseId: wh.id }) }).then(load).catch(() => {});

  // الإرسال على مرحلتين: الأولى متزامنة داخل ضغطة المستخدم (نسخ النص، وفتح نافذة فارغة
  // إن deferred) والثانية go() تكمل. هكذا «حفظ وإرسال للمذخر التالي» يحفظ التجهيز أولاً
  // ثم يرسل، دون أن يحجب المتصفح النافذة لأنها فُتحت قبل انتظار الحفظ.
  const beginSend = (list: Order[], wh: OrderWh, deferred = false): { go: () => void; cancel: () => void } => {
    const none = () => {};
    if (canBotSend && viaBot && wh?.id != null) return { go: () => { sendViaBot(list, wh); }, cancel: none };
    let next = wh.id != null ? whNextSeq[wh.id] ?? 1 : 1;
    const nos = list.map(o => (wh.id == null ? o.id : whSeqOf(o, wh.id) ?? next++));
    const text = ordersText(list);
    const ch = channelOf(wh);
    const opener = (url: string) => {
      const w = deferred ? window.open('about:blank', '_blank') : null;
      return { open: () => { if (w) w.location.href = url; else window.open(url, '_blank'); }, cancel: () => w?.close() };
    };
    // ميزة «إرسال الطلبية كصورة»: صورة حقيقية + نص قصير (رقمها والصيدلية) بدل النص الكامل
    const file = asImage ? orderImageFile(list, nos) : null;
    if (file) {
      const caption = ordersCaption(list);
      // بطاقة «نسخ الاسم والمنطقة» وتنبيه اللصق بعد الإرسال أُلغيا بطلب صاحب المشروع (2026-11-11)
      const canClipImage = !!navigator.clipboard?.write && typeof ClipboardItem !== 'undefined';
      // قائمة المشاركة بالصورة فقط حين لا وجهة للمذخر (لا كروب/رقم/معرّف) أو تعذّر نسخ الصورة —
      // وإلا يُفتح كروب المذخر نفسه والصورة منسوخة (طلب صاحب المشروع)
      if (IS_TOUCH && (ch === 'share' || !canClipImage) && navigator.canShare?.({ files: [file] })) {
        copyText(caption); // احتياط: بعض التطبيقات تُسقط النص المرافق للصورة
        const share = () => navigator.share({ files: [file], text: caption }).then(() => true, () => false);
        // «حفظ وإرسال للتالي»: المشاركة تُفتح الآن داخل الضغطة، والتعليم بعد الحفظ
        const early = deferred ? share() : null;
        return { go: () => { (early ?? share()).then(ok => { if (ok) markSent(list, wh); }); }, cancel: none };
      }
      // الصورة تُنسخ للحافظة ويُفتح كروب المذخر/محادثته ← لصق
      if (canClipImage) {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': file })])
          .catch(() => setNotice('تعذّر نسخ صورة الطلبية — أعد المحاولة.'));
        const url = ch === 'wa-group' ? wh.groupLink!
          : ch === 'viber-group' ? (IS_TOUCH ? wh.groupLink! : null) // فايبر الكمبيوتر لا يفتح روابط الكروبات
          // بلا نص مسبق في خانة الكتابة: رقم الطلبية والصيدلية مطبوعان أعلى الصورة نفسها، فتصل
          // معها رسالةً واحدة (واتساب لا يلصق صورة مع تعليق من الحافظة)
          : ch === 'wa-number' ? `https://wa.me/${toWaNumber(wh.phone)}`
          : ch === 'share' ? null : handleUrl(wh.handle);
        const where = ch === 'share' ? 'محادثة المذخر' : `${CHANNEL_LABEL[ch]} «${wh.name}»`;
        // الموبايل: فتح واتساب فوراً يُفقد الصفحة التركيز فقد يُلغي iOS النسخ قبل اكتماله —
        // فيُفتح الكروب بعد ~0.4 ثانية من الضغطة (المتصفح يُبقي المؤقّت القصير ضمن الضغطة فلا
        // يحجب الفتح). «حفظ وإرسال للتالي» (deferred) يمرّ بانتظار الحفظ فتضيع الضغطة ← زرّ فتح.
        if (IS_TOUCH && url) {
          const msg = `✓ نُسخت صورة الطلبية. في ${where} اضغط مطوّلاً على خانة الكتابة ← لصق ← إرسال.`;
          if (deferred) {
            return { go: () => setOpenPrompt({ text: msg, label: `فتح ${where}`, url, done: () => markSent(list, wh) }), cancel: none };
          }
          return {
            go: () => { setTimeout(() => window.open(url, '_blank'), 400); markSent(list, wh); },
            cancel: none,
          };
        }
        const o = url ? opener(url) : null;
        return {
          go: () => { o?.open(); if (!url) setNotice(`✓ نُسخت صورة الطلبية — افتح ${where} والصقها.`); markSent(list, wh); },
          cancel: o?.cancel ?? none,
        };
      }
    }
    if (ch === 'wa-group' || ch === 'viber-group') {
      copyText(text);
      // رابط دعوة فايبر على الكمبيوتر يعرض صفحة QR فقط (فايبر الكمبيوتر لا يفتح روابط الكروبات)
      // ← نكتفي بالنسخ والمندوب يفتح الكروب من فايبر بنفسه
      if (ch === 'viber-group' && !IS_TOUCH) {
        return { go: () => { setNotice(`✓ نُسخت الطلبية. افتح كروب «${wh.name}» في فايبر الكمبيوتر ← اضغط على خانة الكتابة ثم Ctrl+V ← إرسال.`); markSent(list, wh); }, cancel: none };
      }
      const o = opener(wh.groupLink!);
      // رابط الكروب لا يحمل نصاً (بخلاف wa.me) — اللصق خطوة لا مفرّ منها
      return {
        go: () => { o.open(); setNotice(`✓ نُسخت الطلبية. في ${CHANNEL_LABEL[ch]} «${wh.name}» ${IS_TOUCH ? 'اضغط مطوّلاً على خانة الكتابة ← لصق' : 'اضغط على خانة الكتابة ثم Ctrl+V'} ← إرسال.`); markSent(list, wh); },
        cancel: o.cancel,
      };
    }
    if (ch === 'wa-user' || ch === 'tg' || ch === 'link') {
      // رابط المعرّف (واتساب/تيليكرام) يملأ خانة الكتابة؛ النسخ احتياط إن لم يظهر النص
      copyText(text);
      const o = opener(handleUrl(wh.handle, ch === 'link' ? '' : text)!);
      return {
        go: () => { o.open(); setNotice(`✓ فُتحت محادثة «${wh.name}»${ch === 'link' ? '' : ` في ${CHANNEL_LABEL[ch]} والطلبية مكتوبة فيها`} — والطلبية منسوخة أيضاً للصق إن لم تظهر.`); markSent(list, wh); },
        cancel: o.cancel,
      };
    }
    const wa = toWaNumber(wh?.phone);
    if (!wa) return { go: () => shareOrders(list, wh), cancel: none };
    const o = opener(`https://wa.me/${wa}?text=${encodeURIComponent(text)}`);
    return { go: () => { o.open(); markSent(list, wh); }, cancel: o.cancel };
  };
  const sendToWarehouse = (list: Order[], wh: OrderWh) => beginSend(list, wh).go();

  // قائمة المشاركة في الموبايل (واتساب ← أي كروب أو محادثة والنص جاهز).
  // تُعلَّم مُرسلة فقط إن اختار المندوب وجهة؛ الإلغاء لا يغيّر شيئاً.
  const shareOrders = (list: Order[], wh: OrderWh) => {
    let next = wh.id != null ? whNextSeq[wh.id] ?? 1 : 1;
    const nos = list.map(o => (wh.id == null ? o.id : whSeqOf(o, wh.id) ?? next++));
    const text = ordersText(list);
    const file = asImage ? orderImageFile(list, nos) : null;
    if (file && navigator.canShare?.({ files: [file] })) {
      const caption = ordersCaption(list);
      copyText(caption);
      navigator.share({ files: [file], text: caption }).then(() => markSent(list, wh)).catch(() => {});
      return;
    }
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

  // الضغط على اسم المذخر ← كروبه أو محادثته لمتابعة الطلبية
  const openWarehouse = (wh: OrderWh) => {
    const ch = channelOf(wh);
    if (ch === 'viber-group' && !IS_TOUCH) { setNotice(`افتح كروب «${wh.name}» من فايبر — روابط كروبات فايبر تفتح بالموبايل فقط.`); return; }
    if (ch === 'wa-group' || ch === 'viber-group') { window.open(wh.groupLink!, '_blank'); return; }
    if (ch === 'wa-user' || ch === 'tg' || ch === 'link') { window.open(handleUrl(wh.handle)!, '_blank'); return; }
    const wa = toWaNumber(wh.phone);
    if (wa) window.open(`https://wa.me/${wa}`, '_blank');
  };

  // تسجيل التجهيز: يُفتح عند رفع فاتورة المذخر أو «تم التجهيز» — كمية كل صنف
  const [prepFor, setPrepFor] = useState<{ order: Order; file: File | null; whId?: number | null } | null>(null);

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
      <header className="ro-hero">
        <div className="ro-hero__title">
          <span className="ro-hero__icon"><ClipboardList size={22} /></span>
          <div>
            <h1>طلبيات المذاخر</h1>
            <p>{PERIOD_LABEL[period]}{period === 'custom' && from ? ` · ${from} ← ${to}` : ''} · {counts.all} طلبية{isManager ? ' · طلبيات الفريق' : ''}</p>
          </div>
        </div>
        <div className="ro-hero__actions">
          <button className="ro-hero__btn" onClick={() => setShowWarehouses(true)} title="دليل المذاخر وأرقام الواتساب">
            <Warehouse size={15} /> <span className="ro-hide-sm">المذاخر</span>
          </button>
          <button className="ro-hero__btn" disabled={exporting || !orders.length} title="تصدير كل الطلبيات المعروضة بكل حالاتها إلى Excel"
            onClick={async () => { setExporting(true); try { await exportOrdersExcel(orders, warehouses, period === 'custom' && from ? `${from}_${to}` : period === 'all' ? today() : `${PERIOD_LABEL[period]}-${today()}`); } catch (e: any) { alert(e.message); } finally { setExporting(false); } }}>
            <FileSpreadsheet size={15} /> <span className="ro-hide-sm">{exporting ? 'جارٍ التصدير…' : 'Excel'}</span>
          </button>
          {viberImport && (
            <button className="ro-hero__btn" onClick={() => setShowViber(true)} title="لصق رسائل كروب الفايبر أو سكرين شوت لها ← طلبيات جاهزة للإرسال">
              <ClipboardPaste size={15} /> <span>من الفايبر</span>
            </button>
          )}
          <button className="ro-hero__btn ro-hero__btn--primary" onClick={() => setEditing('new')}><Plus size={15} /> طلبية جديدة</button>
        </div>
      </header>

      <div className="ro-kpis" role="group" aria-label="الحالة">
        {VIEWS.map(v => {
          const Icon = VIEW_ICON[v];
          const pct = counts.all ? Math.round((counts[v] / counts.all) * 100) : 0;
          return (
            <button key={v} className={`ro-kpi ro-kpi--${v} ${view === v ? 'is-active' : ''}`} onClick={() => setView(v)} aria-pressed={view === v}>
              <span className="ro-kpi__icon"><Icon size={18} /></span>
              <span className="ro-kpi__body">
                <span className="ro-kpi__label">{VIEW_LABEL[v]}</span>
                <b className="ro-kpi__num"><CountUp value={counts[v]} /></b>
              </span>
              <span className="ro-kpi__pct">{v === 'all' ? '' : `${pct}%`}</span>
              <span className="ro-kpi__bar"><i style={{ width: `${v === 'all' ? (counts.all ? 100 : 0) : pct}%` }} /></span>
            </button>
          );
        })}
      </div>

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
        {/* كل فواتير طلبيات الفايبر التي لم تُرسل بعد ← نقرة واحدة ثم لصق في كروب الفايبر */}
        {viberImport && <ViberInvoicesButton orders={orders} token={token} onDone={load} />}
        {groupFilter && (
          <button className="ro-chip is-active" onClick={() => setGroupFilter(null)} title="إزالة الفلتر">
            {GROUP_LABEL[groupFilter.type]}: {groupFilter.title} <X size={12} />
          </button>
        )}
        <span className="ro-spacer" />
        {loading && <span className="ro-loading"><i /> جارٍ التحميل…</span>}
        <span className="ro-muted ro-small ro-hide-sm">{visible.length} معروضة</span>
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
            <thead className="ro-hide-sm" hidden={!!focused}>
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
              {(() => { let rowI = 0; return (focused ? [{ key: 'focus', title: '', orders: [focused] }] : groups).map(g => {
                const fresh = g.orders.filter(o => stateOf(o) === 'new');
                const groupWh = groupBy === 'warehouse' && g.orders[0] ? currentWh(g.orders[0]) : null;
                const GroupIcon = groupBy === 'warehouse' ? Warehouse : groupBy === 'rep' ? UserRound : CalendarDays;
                const friendly = groupBy === 'date' ? dayTitle(g.title) : null;
                return (
                  <Fragment key={g.key}>
                    {groupBy !== 'none' && !focused && (
                      <tr className="ro-group-row">
                        <td colSpan={colCount}>
                          <div className="ro-group-row__inner">
                            <span className="ro-group-row__icon"><GroupIcon size={14} /></span>
                            {friendly && <strong>{friendly}</strong>}
                            <span className={friendly ? 'ro-muted' : 'ro-strong'}>{groupBy === 'date' ? fmtShortDay(g.title) : g.title}</span>
                            <span className="ro-group-row__count">{g.orders.length} طلبية</span>
                            <span className="ro-spacer" />
                            {canDispatch && (groupWh?.phone || groupWh?.groupLink) && fresh.length > 1 && (
                              <button className="ro-link ro-link--wa" onClick={() => sendToWarehouse(fresh, groupWh)}><Send size={13} /> إرسال {fresh.length} جديدة للمذخر</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {g.orders.map(o => (
                      <OrderRow key={o.id} index={rowI++} o={o} open={openId === o.id} colCount={colCount} terms={terms} canDispatch={canDispatch}
                        showDate={showDate} showRep={showRep} showWh={showWh}
                        onToggle={() => toggleOpen(o.id)}
                        onSend={wh => sendToWarehouse([o], wh)}
                        onShare={wh => shareOrders([o], wh)}
                        onStatus={s => (s === 'prepared' ? setPrepFor({ order: o, file: null }) : changeStatus([o.id], s))}
                        onEdit={() => setEditing(o)}
                        onDelete={() => remove(o)}
                        onUpload={(k, f) => (k === 'prepared' ? setPrepFor({ order: o, file: f }) : uploadImage(o, k, f))}
                        onPrepare={(whId, f) => setPrepFor({ order: o, file: f, whId })}
                        onRemoveImage={k => removeImage(o, k)}
                        onPreview={setPreview}
                        onFeedbackCopied={viberImport ? load : undefined} />
                    ))}
                  </Fragment>
                );
              }); })()}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <OrderForm token={token} api={api} order={editing === 'new' ? null : editing} warehouses={warehouses} viaBot={canBotSend && viaBot} canAddWarehouse={canDispatch}
          reps={assignableReps} viewerId={viewerId}
          onWarehousesChanged={loadWarehouses}
          onClose={() => setEditing(null)}
          onSaved={(d) => { setEditing(null); if (d && from && (d < from || d > to)) pickPeriod('all'); else load(); }} />
      )}
      {showViber && (
        <ViberImportPanel api={api} token={token} warehouses={warehouses} reps={assignableReps} canSend={canBotSend}
          initialText={viberInit?.text} initialImages={viberInit?.images}
          onClose={() => { setShowViber(false); setViberInit(null); }} onChanged={load}
          onFinished={(summary) => { setShowViber(false); setViberInit(null); setNotice(`✅ ${summary}`); }} />
      )}
      {showWarehouses && (
        <WarehousesModal api={api} warehouses={warehouses} provinces={provinces} canManage={canDispatch} onOpen={openWarehouse} onChanged={() => { loadWarehouses(); load(); }} onClose={() => setShowWarehouses(false)} />
      )}
      {shared.length > 0 && (
        <SharedImagePicker api={api} images={shared} beginSend={canDispatch ? (o, wh) => beginSend([o], wh, true) : undefined}
          onViber={viberImport ? () => {
            const files = shared.map((b, i) => new File([b], `shot-${i}.jpg`, { type: b.type || 'image/jpeg' }));
            clearShared(); openViber({ images: files });
          } : undefined}
          onDone={() => { clearShared(); load(); }} onCancel={clearShared} />
      )}
      {prepFor && (
        <PrepareDialog api={api} order={prepFor.order} file={prepFor.file} initialWh={prepFor.whId}
          beginSend={canDispatch ? (o, wh) => beginSend([o], wh, true) : undefined}
          onClose={() => setPrepFor(null)} onSaved={() => { setPrepFor(null); load(); }} />
      )}
      {notice && <div className="ro-notice" role="status" onClick={() => setNotice(null)}>{notice}</div>}
      {openPrompt && (
        <div className="ro-openprompt" role="dialog">
          <div className="ro-openprompt__text">{openPrompt.text}</div>
          <div className="ro-openprompt__btns">
            <button className="ro-send-btn" onClick={() => { window.open(openPrompt.url, '_blank'); openPrompt.done(); setOpenPrompt(null); }}>
              <Send size={15} /> <span>{openPrompt.label}</span>
            </button>
            <button className="btn btn--secondary btn--sm" onClick={() => setOpenPrompt(null)}>إلغاء</button>
          </div>
        </div>
      )}
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

// ─── سطر طلبية + تفاصيلها ────────────────────────────────────────────────────

function OrderRow({ index, o, open, colCount, terms, canDispatch, showDate, showRep, showWh, onToggle, onSend, onShare, onStatus, onEdit, onDelete, onUpload, onPrepare, onRemoveImage, onPreview, onFeedbackCopied }: {
  index: number; o: Order; open: boolean; colCount: number; terms: string[]; canDispatch: boolean; showDate: boolean; showRep: boolean; showWh: boolean;
  onToggle: () => void; onSend: (wh: OrderWh) => void; onShare: (wh: OrderWh) => void; onStatus: (s: Status) => void; onEdit: () => void; onDelete: () => void;
  onUpload: (k: ImageKind, f: File) => void; onPrepare: (whId: number | null, f: File | null) => void; onRemoveImage: (k: ImageKind) => void; onPreview: (src: string) => void;
  onFeedbackCopied?: () => void; // موجود = ميزة «استيراد من الفايبر» مفعّلة
}) {
  const { token } = useAuth();
  const state = stateOf(o);
  const partial = isPartial(o);
  // اسم المذخر في قائمة الطلبيات نصّ فقط — لا يفتح كروبه/محادثته (طلب صاحب المشروع)
  const whLink = (w: OrderWh) => <span>{w.name}</span>;
  const total = o.lines.reduce((s, l) => s + l.quantity, 0);
  const totalBonus = o.lines.reduce((s, l) => s + (l.bonusQty || 0), 0);
  const hasPrepared = o.lines.some(l => l.preparedQty != null);
  const preparedTotal = o.lines.reduce((s, l) => s + (l.preparedQty ?? 0), 0);
  const preparedBonusTotal = o.lines.reduce((s, l) => s + (l.preparedBonus ?? 0), 0);
  const shortTotal = o.lines.reduce((s, l) => s + remainingOf(l), 0);
  const hasPrice = o.lines.some(l => l.unitPrice != null);
  // بعد تسجيل أي تجهيز تُحسب الفلوس على المجهّز فعلاً، لا على المطلوب
  const billQty = (l: OrderLine) => (hasPrepared ? Math.min(l.quantity, l.preparedQty ?? 0) : l.quantity);
  const requestedValue = o.lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.quantity, 0);
  const value = o.lines.reduce((s, l) => s + (l.unitPrice ?? 0) * billQty(l), 0);
  // مصدر كل صنف يُكتب تحته فقط إن شارك أكثر من مذخر في التجهيز
  const multiSource = new Set(o.sends.filter(sd => sd.lines.some(x => x.qty > 0)).map(sd => sd.warehouseId)).size > 1;
  const wh = currentWh(o);
  const backups = o.warehouses.length - 1;
  const active = state !== 'cancelled' && state !== 'prepared';
  // لوحة المذاخر تُفتح مغلقة كلها — المستخدم يفتح المذخر الذي يريده (طلب صاحب المشروع)
  const [sel, setSel] = useState<number>(-1);
  useEffect(() => { setSel(-1); }, [o.id]);

  // إدراج فاتورة من أسفل لوحة المذاخر: المذخر المفتوح إن وُجد وإلا الحالي — يُغيَّر في نافذة التجهيز
  const canAddInvoice = state !== 'cancelled';
  const prepWh = () => (sel >= 0 ? o.warehouses[sel]?.id : null) ?? currentWh(o).id;
  const addInvoice = (f: File) => onPrepare(prepWh(), f);
  const addInvoiceRef = useRef(addInvoice);
  addInvoiceRef.current = addInvoice;
  const pasteInvoice = async () => {
    try {
      for (const it of await navigator.clipboard.read()) {
        const type = it.types.find(t => t.startsWith('image/'));
        if (type) { const b = await it.getType(type); addInvoice(new File([b], `invoice.${type.split('/')[1] || 'png'}`, { type })); return; }
      }
      alert('لا توجد صورة منسوخة — انسخ صورة الفاتورة من واتساب (نسخ) ثم اضغط «لصق فاتورة».');
    } catch {
      alert('المتصفح لم يسمح بقراءة الحافظة — اضغط Ctrl+V والطلبية مفتوحة، أو استعمل «إدراج فاتورة».');
    }
  };
  // Ctrl+V بصورة منسوخة والطلبية مفتوحة ← نافذة التجهيز بالفاتورة (لا حين تكون نافذة أخرى مفتوحة)
  useEffect(() => {
    if (!open || !canAddInvoice) return;
    const onPaste = (e: ClipboardEvent) => {
      if (document.querySelector('.ro-modal')) return;
      const f = [...(e.clipboardData?.files ?? [])].find(x => x.type.startsWith('image/'));
      if (f) { e.preventDefault(); addInvoiceRef.current(f); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [open, canAddInvoice]);

  // أُرسلت لهذا المذخر ولم يرد بعد ← لا زر إرسال (المتابعة من كروبه، أو «مشاركة» لإعادة الإرسال)
  const lastSend = o.sends[o.sends.length - 1];
  const awaiting = (w: OrderWh) => (lastSend
    ? lastSend.outcome === 'sent' && lastSend.warehouseId === (w.id ?? null)
    : !!o.sentAt && (w.id ?? null) === (o.lastSentWarehouseId ?? o.warehouses[0]?.id ?? null));
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const canSendRow = canDispatch && state === 'new';
  const itemHits = terms.length ? o.lines.filter(l => terms.some(t => normSearch(`${l.itemName} ${l.companyName ?? ''}`).includes(t))) : [];

  return (
    <>
      <tr className={`ro-row ro-row--${state} ${open ? 'is-open' : ''}`} hidden={open} onClick={onToggle} style={{ '--i': Math.min(index, 14) } as React.CSSProperties}>
        <td className="ro-col-no">
          <span className="ro-chevron"><ChevronDown size={14} /></span>
          <span className="ro-id">{o.id}</span>
        </td>
        {showDate && <td className="ro-hide-sm ro-nowrap ro-date-td">{fmtShortDay(o.orderDate)}</td>}
        <td className="ro-main-td">
          <div className="ro-strong ro-ph-name">{o.pharmacyName}</div>
          <div className="ro-sub ro-meta-list">
            {o.areaName && <span className="ro-meta"><MapPin size={12} />{o.areaName}</span>}
            <span className="ro-meta ro-show-sm"><Warehouse size={12} />{whLink(wh)}{backups > 0 && <span className="ro-more">+{backups}</span>}</span>
            {showRep && <span className="ro-meta ro-show-sm"><UserRound size={12} />{o.repName}</span>}
            <span className="ro-meta ro-show-sm"><CalendarDays size={12} />{fmtShortDay(o.orderDate)}<span className="ro-id">{o.id}</span></span>
            {itemHits.length > 0 && <span className="ro-hit">🔎 {itemHits.map(l => `${l.itemName} ×${l.quantity}`).join('، ')}</span>}
          </div>
        </td>
        {showWh && <td className="ro-hide-sm"><span className="ro-wh-cell">{whLink(wh)}{backups > 0 && <span className="ro-more" title="مذاخر احتياط">+{backups}</span>}</span></td>}
        {showRep && <td className="ro-hide-sm ro-nowrap">{o.repName}</td>}
        <td className="ro-state-td"><span className="ro-status"><span className={`ro-badge ro-badge--${state}`}>{STATE_LABEL[state]}</span>{partial && <span className="ro-badge ro-badge--partial">جزئي</span>}</span></td>
        <td className="ro-col-actions" onClick={stop}>
          {canSendRow && (
            <button className={`ro-icon-btn ro-icon-btn--${channelOf(o.warehouses[0]) === 'viber-group' ? 'viber' : channelOf(o.warehouses[0]) === 'tg' ? 'tg' : 'wa'}`} title={`إرسال إلى ${o.warehouses[0]?.name ?? ''} — ${CHANNEL_LABEL[channelOf(o.warehouses[0])]}`} onClick={() => onSend(o.warehouses[0])}><Send size={14} /></button>
          )}
        </td>
      </tr>

      {open && (
        <tr className="ro-detail-row">
          <td colSpan={colCount}>
            <div className="ro-detail">
              <div className="ro-detail__main">
                <section className={`ro-card ro-card--order ro-card--${state}`}>
                  <div className="ro-card__head ro-card__head--order">
                    <div className="ro-card__title">
                      <span className="ro-card__ph">{o.pharmacyName}</span>
                      <span className="ro-card__no">#{o.id}</span>
                    </div>
                    <div className="ro-card__tools">
                      {canDispatch && <button className="ro-icon-btn" title="مشاركة الطلبية — واتساب أو فايبر أو غيره" onClick={() => onShare(o.warehouses[sel] ?? nextWh(o))}><Share2 size={14} /></button>}
                      {o.canEdit && <button className="ro-icon-btn" title="تعديل" onClick={onEdit}><Pencil size={14} /></button>}
                      {o.canEdit && <button className="ro-icon-btn ro-icon-btn--danger" title="حذف" onClick={onDelete}><Trash2 size={14} /></button>}
                      <button className="ro-icon-btn" title="إغلاق" onClick={onToggle}><X size={14} /></button>
                    </div>
                  </div>
                  <dl className="ro-kv">
                    <div><dt><CircleDot size={14} />الحالة</dt><dd>
                      <span className={`ro-badge ro-badge--${state}`}>{STATE_LABEL[state]}</span>
                      {partial && <span className="ro-badge ro-badge--partial">جزئي</span>}
                      {state === 'prepared' && o.preparedAt && <span className="ro-kv__when">{fmtShort(o.preparedAt)}{o.preparedBy ? ` · ${o.preparedBy}` : ''}</span>}
                    </dd></div>
                    {o.areaName && <div><dt><MapPin size={14} />المنطقة</dt><dd>{o.areaName}</dd></div>}
                    <div><dt><UserRound size={14} />المندوب</dt><dd>{o.repName}{o.assignedBy && <span className="ro-kv__when">حوّلها {o.assignedBy}</span>}</dd></div>
                    <div><dt><CalendarDays size={14} />تاريخ الطلب</dt><dd>{fmtShortDay(o.orderDate)}</dd></div>
                    <div><dt><Warehouse size={14} />المذخر</dt><dd>{o.warehouses.map(w => w.name).join(' ← ') || wh.name}</dd></div>
                    {o.invoiceNumber && <div><dt><Hash size={14} />رقم الفاتورة</dt><dd>{o.invoiceNumber}</dd></div>}
                  </dl>
                </section>

                <section className="ro-card">
                  <div className="ro-card__head"><Pill size={16} /><span>الأدوية</span><span className="ro-card__no">{o.lines.length}</span></div>
                  <div className="ro-meds-scroll">
                    <table className="ro-mt">
                      <thead>
                        <tr>
                          <th className="ro-mt__name">الصنف</th>
                          <th>الكمية</th>
                          <th>بونص</th>
                          {hasPrepared && <th>المجهّز</th>}
                          {hasPrepared && <th>الناقص</th>}
                          {hasPrice && <th>السعر</th>}
                          {hasPrice && <th>المجموع</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {o.lines.map((l, i) => {
                          const got = l.preparedQty ?? 0;
                          const short = remainingOf(l);
                          const st = got >= l.quantity ? 'full' : got > 0 ? 'part' : 'none';
                          const by = multiSource ? o.sends.flatMap(sd => sd.lines.filter(x => x.lineId === l.id && x.qty > 0).map(x => `${sd.warehouseName} ${x.qty}`)) : [];
                          const billed = billQty(l);
                          return (
                            <tr key={l.id ?? i} className={hasPrepared && short > 0 ? 'is-short' : ''}>
                              <td className="ro-mt__name">
                                <div className="ro-strong">{l.itemName}</div>
                                {l.companyName && <div className="ro-sub"><span>{l.companyName}</span></div>}
                                {by.length > 0 && <div className="ro-sub"><span>{by.join(' · ')}</span></div>}
                              </td>
                              <td className="ro-mt__qty">{l.quantity}</td>
                              <td className="ro-mt__bonus">{l.bonusQty || <span className="ro-muted">—</span>}</td>
                              {hasPrepared && <td><span className={`ro-prep ro-prep--${st}`}>{got}{l.preparedBonus ? <small className="ro-bonus">+{l.preparedBonus}</small> : null}</span></td>}
                              {hasPrepared && <td>{short > 0 ? <span className="ro-short">{short}</span> : <span className="ro-muted">—</span>}</td>}
                              {hasPrice && <td className="ro-mt__price">{l.unitPrice != null ? fmtMoney(l.unitPrice) : '—'}</td>}
                              {hasPrice && (
                                <td className="ro-mt__sum">
                                  {l.unitPrice != null ? fmtMoney(l.unitPrice * billed) : '—'}
                                  {l.unitPrice != null && billed < l.quantity && <div className="ro-was">{fmtMoney(l.unitPrice * l.quantity)}</div>}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td className="ro-mt__name">الإجمالي</td>
                          <td className="ro-mt__qty">{total}</td>
                          <td className="ro-mt__bonus">{totalBonus || '—'}</td>
                          {hasPrepared && <td>{preparedTotal}{preparedBonusTotal ? <small className="ro-bonus">+{preparedBonusTotal}</small> : null}</td>}
                          {hasPrepared && <td>{shortTotal || '—'}</td>}
                          {hasPrice && <td />}
                          {hasPrice && <td className="ro-mt__sum ro-mt__total">{fmtMoney(value)}</td>}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </section>
                {hasPrice && hasPrepared && value < requestedValue && (
                  <div className="ro-money">
                    <span>قيمة المطلوب <b>{fmtMoney(requestedValue)}</b></span>
                    <span className="ro-money__got">قيمة المجهّز <b>{fmtMoney(value)}</b></span>
                    <span className="ro-money__short">الناقص <b>{fmtMoney(requestedValue - value)}</b></span>
                  </div>
                )}
                {o.notes && <div className="ro-notes"><div className="ro-slot__label">ملاحظات</div>{o.notes}</div>}
              </div>

              <div className="ro-detail__side">

                {/* لوحة المذاخر: كل مذخر بنتيجته، والضغط عليه يفتح تفاصيله (الإرسال، الفاتورة،
                    ما جهّزه وقيمته) وأزرار الإرسال/رفع فاتورته */}
                <div className="ro-whp">
                  <div className="ro-slot__label">المذاخر</div>
                  {o.warehouses.map((w, i) => {
                    const m = whMarkOf(o, w.id);
                    const ws = whStatsOf(o, w.id);
                    const isSel = sel === i;
                    const ch = channelOf(w);
                    // طلبيات قديمة بلا سجل إرسال: الإرسال الوحيد المعروف للمذخر الحالي
                    const legacySent = !o.sends.length && o.sentAt && (w.id ?? null) === (wh.id ?? null) ? o.sentAt : null;
                    return (
                      <div key={`${w.id}-${i}`} className={`ro-whp__card ${isSel ? 'is-open' : ''} ${m ? `ro-wh--${m}` : ''}`}>
                        <button type="button" className="ro-whp__head" onClick={() => setSel(isSel ? -1 : i)} aria-expanded={isSel}>
                          <span className={`ro-whp__rank ${i === 0 ? 'is-main' : ''}`}>{i === 0 ? 'أساسي' : `احتياط ${i}`}</span>
                          <span className="ro-whp__name" title={w.name}>{m && <i className={`ro-dot ro-dot--${m}`} />}<span className="ro-whp__nm">{w.name}</span><ChannelIcon ch={ch} size={12} /></span>
                          <span className={`ro-sendmark ro-sendmark--${m ?? 'none'}`}>{m ? SEND_LABEL[m] : legacySent ? 'أُرسلت' : 'لم تُرسل'}</span>
                          <ChevronDown size={14} className="ro-whp__chev" />
                        </button>
                        {/* بلا سجل الإرسال ولا زر تجهيز داخل البطاقة (طلب صاحب المشروع) — الحالة في رأسها،
                            والتجهيز من صفّ الأزرار أسفل اللوحة */}
                        {isSel && (ws.items.length > 0 || ((m === 'partial' || m === 'rejected') && ws.short.length > 0) || (canDispatch && active && !awaiting(w))) && (
                          <div className="ro-whp__body">
                            {ws.items.length > 0 && (
                              <div className="ro-whp__items">
                                <div className="ro-slot__label">ما جهّزه</div>
                                {ws.items.map(it => (
                                  <div key={it.l.id} className="ro-whp__item">
                                    <span className="ro-whp__iname">{it.l.itemName}</span>
                                    <span className={`ro-prep ro-prep--${it.q >= it.l.quantity ? 'full' : 'part'}`}>{it.q}{it.b ? <small className="ro-bonus">+{it.b}</small> : null}</span>
                                    {hasPrice && <span className="ro-price">{it.l.unitPrice != null ? fmtMoney(it.l.unitPrice * it.q) : '—'}</span>}
                                  </div>
                                ))}
                                {hasPrice && <div className="ro-whp__total">قيمة ما جهّزه <b>{fmtMoney(ws.value)}</b></div>}
                              </div>
                            )}
                            {(m === 'partial' || m === 'rejected') && ws.short.length > 0 && (
                              <div className="ro-whp__short">ناقص عنده: {ws.short.map(x => `${x.l.itemName} ${x.n}`).join('، ')}</div>
                            )}

                            {canDispatch && active && (
                              <div className="ro-send-actions">
                                {!awaiting(w) && (
                                  <button className={`ro-send-btn ro-send-btn--${ch}`} onClick={() => onSend(w)}>
                                    <Send size={15} />
                                    <span>{partial ? 'إرسال المتبقي إلى' : 'إرسال إلى'} {w.name}</span>
                                    {ch !== 'share' && <span className="ro-send-btn__via"><ChannelIcon ch={ch} /></span>}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* فواتير التجهيز تحت لوحة المذاخر لا داخل بطاقاتها (طلب صاحب المشروع) — كل صورة باسم مذخرها.
                    الإدراج من هنا (ملف أو لصق صورة منسوخة من واتساب)، ونافذة التجهيز يُختار فيها المذخر */}
                {(canAddInvoice || o.sends.some(sd => sd.image)) && (
                  <div className="ro-invoices">
                    <div className="ro-slot__label">فواتير التجهيز</div>
                    {canAddInvoice && (
                      <div className="ro-invoices__add">
                        <label className="ro-alt-btn ro-file-btn">
                          <Camera size={14} /> إدراج فاتورة
                          <input type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) addInvoice(f); e.target.value = ''; }} />
                        </label>
                        <button type="button" className="ro-alt-btn" title="لصق صورة فاتورة منسوخة (من واتساب مثلاً) — أو Ctrl+V والطلبية مفتوحة" onClick={pasteInvoice}>
                          <ClipboardPaste size={14} /> لصق فاتورة
                        </button>
                        <button type="button" className="ro-alt-btn" onClick={() => onPrepare(prepWh(), null)}>
                          <Check size={14} /> {o.sends.some(sd => sd.outcome !== 'sent') ? 'تعديل التجهيز' : 'تسجيل التجهيز'}
                        </button>
                      </div>
                    )}
                    <div className="ro-invoices__list">
                      {o.sends.filter(sd => sd.image).map(sd => (
                        <figure key={sd.id} className="ro-invoices__item">
                          {isPdfPath(sd.image)
                            ? <a className="ro-whp__thumb" href={`${API}${sd.image}`} target="_blank" rel="noreferrer" title="فاتورة PDF — فتح"
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#b91c1c', background: '#fef2f2', textDecoration: 'none' }}>PDF</a>
                            : <img className="ro-whp__thumb" src={`${API}${sd.image}`} alt={`فاتورة ${sd.warehouseName}`} onClick={() => onPreview(sd.image!)} />}
                          <figcaption>
                            <span className="ro-invoices__wh">{o.warehouses.find(w => w.id === sd.warehouseId)?.name ?? sd.warehouseName}</span>
                            {sd.outcomeAt && <span className="ro-tl-date">{fmtShort(sd.outcomeAt)}</span>}
                          </figcaption>
                        </figure>
                      ))}
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
                  {/* فاتورة بلا مذخر مسجّل (طلبيات قديمة) — فواتير المذاخر تظهر داخل لوحة كل مذخر */}
                  {o.preparedImage && !o.sends.some(s => s.image === o.preparedImage) && (
                    <ImageSlot label="صورة التجهيز (الفاتورة)" src={o.preparedImage} canRemove={o.canEdit} onPreview={onPreview} onUpload={f => onUpload('prepared', f)} onRemove={() => onRemoveImage('prepared')} />
                  )}
                </div>
              </div>
            </div>
            <div className="ro-detail__actions">
              {onFeedbackCopied && o.source?.startsWith('viber') && <ViberFeedbackButtons order={o} token={token} onCopied={onFeedbackCopied} />}
              {o.status !== 'pending' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('pending')}><RotateCcw size={14} /> إرجاع</button>}
              {o.status === 'pending' && <button className="btn btn--secondary btn--sm" onClick={() => onStatus('cancelled')}><Ban size={14} /> إلغاء</button>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── تسجيل تجهيز مذخر: كمية كل صنف (كامل/ناقص/لم يُجهَّز) ────────────────────
// يُفتح عند رفع فاتورة المذخر أو «تسجيل التجهيز». المطلوب من المذخر = ما لم تجهّزه
// المذاخر السابقة؛ الناقص يبقى ويُرسل للمذخر التالي بزر «إرسال المتبقي».

// صورة قابلة للتكبير: قرص بإصبعين (التكبير حول منتصف الإصبعين ويتبعهما)، سحب بإصبع
// عند التكبير، نقرتان، عجلة الماوس حول المؤشر، وأزرار + / −. كل شيء transform على
// صندوق بحجم الصورة «المحتواة» داخل الإطار: النقطة تحت الإصبع تبقى تحته.
function ZoomImage({ src, onError, children }: { src: string; onError?: () => void; children?: React.ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const tr = useRef(t); tr.current = t;
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gest = useRef<{ s: number; x: number; y: number; mx: number; my: number; d: number } | null>(null);
  const lastTap = useRef(0);

  useEffect(() => {
    const f = frame.current; if (!f) return;
    const ro = new ResizeObserver(() => setBox({ w: f.clientWidth, h: f.clientHeight }));
    ro.observe(f);
    return () => ro.disconnect();
  }, []);
  // حجم الصورة عند التكبير 1 = «contain» داخل الإطار
  const fit = nat && box.w ? Math.min(box.w / nat.w, box.h / nat.h) : 0;
  const bw = nat ? nat.w * fit : 0, bh = nat ? nat.h * fit : 0;
  const clamp = (s: number, x: number, y: number) => {
    const w = bw * s, h = bh * s;
    return {
      s,
      x: w <= box.w ? (box.w - w) / 2 : Math.min(0, Math.max(box.w - w, x)),
      y: h <= box.h ? (box.h - h) / 2 : Math.min(0, Math.max(box.h - h, y)),
    };
  };
  useEffect(() => { setT(clamp(1, 0, 0)); }, [src, bw, bh, box.w, box.h]); // eslint-disable-line react-hooks/exhaustive-deps

  /** تكبير إلى ns حول نقطة (fx, fy) من الإطار */
  const zoomAt = (ns: number, fx: number, fy: number, base = tr.current) => {
    const s = Math.min(6, Math.max(1, ns));
    const px = (fx - base.x) / base.s, py = (fy - base.y) / base.s;
    setT(clamp(s, fx - px * s, fy - py * s));
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startGesture = () => {
    const pts = [...ptrs.current.values()];
    const m = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gest.current = m ? { ...tr.current, mx: m.x, my: m.y, d } : null;
  };
  const onDown = (e: React.PointerEvent) => {
    try { frame.current!.setPointerCapture(e.pointerId); } catch { /* مؤشر غير نشط */ }
    ptrs.current.set(e.pointerId, local(e));
    startGesture();
    if (ptrs.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) { const p = local(e); zoomAt(tr.current.s > 1 ? 1 : 2.5, p.x, p.y); lastTap.current = 0; }
      else lastTap.current = now;
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, local(e));
    const g = gest.current; if (!g) return;
    const pts = [...ptrs.current.values()];
    if (pts.length > 1 && g.d) {
      // النقطة التي كانت تحت منتصف الإصبعين عند البدء تبقى تحت منتصفهما الآن
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      const s = Math.min(6, Math.max(1, g.s * Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / g.d));
      const px = (g.mx - g.x) / g.s, py = (g.my - g.y) / g.s;
      setT(clamp(s, mx - px * s, my - py * s));
    } else if (pts.length === 1 && g.s > 1) {
      setT(clamp(g.s, g.x + pts[0].x - g.mx, g.y + pts[0].y - g.my));
    }
  };
  const onUp = (e: React.PointerEvent) => { ptrs.current.delete(e.pointerId); startGesture(); };

  // عجلة الماوس: تكبير حول المؤشر (مستمع غير passive كي لا تتمرّر النافذة)
  useEffect(() => {
    const f = frame.current; if (!f) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = f.getBoundingClientRect();
      zoomAt(tr.current.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
    };
    f.addEventListener('wheel', wheel, { passive: false });
    return () => f.removeEventListener('wheel', wheel);
  });

  return (
    <div className={`ro-pv ${t.s > 1 ? 'is-zoom' : ''}`}>
      <div ref={frame} className="ro-pv__frame" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <img src={src} alt="القائمة" onError={onError} draggable={false}
          onLoad={e => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={{ width: bw || undefined, height: bh || undefined, transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, visibility: bw ? 'visible' : 'hidden' }} />
      </div>
      <div className="ro-pv__bar">
        {children}
        <button className="ro-pv__btn" title="تصغير" disabled={t.s <= 1} onClick={() => zoomAt(t.s / 1.5, box.w / 2, box.h / 2)}><Minus size={15} /></button>
        <button className="ro-pv__zoom" title="إرجاع الحجم" onClick={() => setT(clamp(1, 0, 0))}>{Math.round(t.s * 100)}%</button>
        <button className="ro-pv__btn" title="تكبير" disabled={t.s >= 6} onClick={() => zoomAt(t.s * 1.5, box.w / 2, box.h / 2)}><ZoomIn size={15} /></button>
      </div>
    </div>
  );
}

/** فاتورة مُشارَكة قُرئت بالذكاء: صورتها مرفوعة مسبقاً (token) وكمياتها تملأ الجدول */
interface PrepAi { token: string; invoiceNumber: string | null; candidate: ReadCandidate | null; auto: boolean }

function PrepareDialog({ api, order, file, initialWh, ai, cancelLabel = 'إلغاء', beginSend, onClose, onSaved }: {
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>;
  order: Order; file: File | null; initialWh?: number | null;
  ai?: PrepAi | null; cancelLabel?: string;
  beginSend?: (o: Order, wh: OrderWh) => { go: () => void; cancel: () => void };
  onClose: () => void; onSaved: () => void;
}) {
  // المذخر الافتراضي: آخر مذخر أُرسلت له — ويمكن تغييره (فاتورة من مذخر آخر)
  const whChoices = order.warehouses.filter(w => w.id != null);
  const [whId, setWhId] = useState<number | null>(initialWh !== undefined ? initialWh : currentWh(order).id);
  const [saving, setSaving] = useState(false);
  const [url, fallbackToDataUrl] = useLocalImage(file);
  const invLine = useMemo(() => new Map((ai?.candidate?.lines ?? []).map(x => [x.lineId, x])), [ai]);

  // سجل هذا المذخر السابق (تصحيح) لا يُحسب ضمن «المجهّز سابقاً»
  const own = lastSendTo(order, whId);
  const rows = useMemo(() => order.lines.map(l => {
    let q = 0, b = 0;
    const from: string[] = [];
    for (const sd of order.sends) {
      if (sd === own) continue;
      for (const x of sd.lines) if (x.lineId === l.id) { q += x.qty; b += x.bonus; if (x.qty) from.push(`${sd.warehouseName} ${x.qty}`); }
    }
    return { l, need: Math.max(0, l.quantity - q), needBonus: Math.max(0, l.bonusQty - b), from };
  }), [order, own]);

  const initial = useCallback(() => Object.fromEntries(rows.map(r => {
    // فاتورة مقروءة: الكميات كما فيها، والصنف غير الموجود بها = 0
    if (ai?.candidate && r.need > 0) {
      const x = invLine.get(r.l.id!);
      return [r.l.id!, x?.invoiceItem ? { p: String(x.preparedQty), b: x.preparedBonus ? String(x.preparedBonus) : '' } : { p: '0', b: '' }];
    }
    const mine = own && own.outcome !== 'sent' ? own.lines.find(x => x.lineId === r.l.id) : null;
    return [r.l.id!, mine ? { p: String(mine.qty), b: mine.bonus ? String(mine.bonus) : '' } : { p: String(r.need), b: r.needBonus ? String(r.needBonus) : '' }];
  })), [rows, own, ai, invLine]);
  const [qty, setQty] = useState<Record<number, { p: string; b: string }>>(initial);
  useEffect(() => { setQty(initial()); }, [initial]);

  const open = rows.filter(r => r.need > 0);
  const got = (id: number) => Math.max(0, Math.floor(Number(qty[id]?.p) || 0));
  const outcome: SendOutcome = open.every(r => got(r.l.id!) === 0) ? 'rejected' : open.every(r => got(r.l.id!) >= r.need) ? 'prepared' : 'partial';
  const missing = open.filter(r => got(r.l.id!) < r.need);
  // صنف لم يُجهَّز (كمية 0) = بونصه 0 أيضاً
  const bonusOf = (id: number) => (got(id) === 0 ? 0 : Math.max(0, Math.floor(Number(qty[id]?.b) || 0)));
  // المذخر التالي بعد الذي جهّز (حسب ترتيب مذاخر الطلبية)
  const whIdx = order.warehouses.findIndex(w => w.id != null && w.id === whId);
  const nextOne = beginSend && whIdx >= 0 ? order.warehouses[whIdx + 1] ?? null : null;

  const save = async (sendNext = false) => {
    // الطلبية كما ستصير بعد الحفظ — نص الإرسال للتالي يحمل المتبقي فقط
    let send: { go: () => void; cancel: () => void } | null = null;
    if (sendNext && nextOne && beginSend) {
      const after: Order = { ...order, lines: rows.map(r => ({
        ...r.l,
        preparedQty: r.l.quantity - r.need + got(r.l.id!),
        preparedBonus: Math.max(0, r.l.bonusQty - r.needBonus) + bonusOf(r.l.id!),
      })) };
      send = beginSend(after, nextOne);
    }
    setSaving(true);
    try {
      const lines = rows.map(r => ({ lineId: r.l.id, qty: got(r.l.id!), bonus: bonusOf(r.l.id!) }));
      if (ai?.token) {
        // الصورة رُفعت مع القراءة — تُثبَّت بالـtoken بدل رفعها ثانية
        await api(`/${order.id}/apply-invoice`, { method: 'POST', body: JSON.stringify({ token: ai.token, invoiceNumber: ai.invoiceNumber, warehouseId: whId, lines }) });
      } else {
        const fd = new FormData();
        if (file) fd.append('image', await compressImage(file), 'prepared.jpg');
        if (whId != null) fd.append('warehouseId', String(whId));
        fd.append('lines', JSON.stringify(lines));
        await api(`/${order.id}/prepare`, { method: 'POST', body: fd });
      }
      onSaved();
      send?.go();
    } catch (e: any) { send?.cancel(); alert(e.message); setSaving(false); }
  };

  const whName = whChoices.find(w => w.id === whId)?.name ?? currentWh(order).name;
  // صور القوائم: المرفوعة الآن + فواتير هذا المذخر السابقة — تُفتح أعلى النافذة للمقارنة
  const images = [...(url ? [{ src: url, local: true }] : []), ...whStatsOf(order, whId).images.map(src => ({ src: `${API}${src}`, local: false }))];
  const [view, setView] = useState<number | null>(file ? 0 : null);
  const shown = view != null ? images[Math.min(view, images.length - 1)] : null;
  return (
    <div className="ro-modal" onClick={onClose}>
      <div className="ro-dialog ro-dialog--prep" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head">
          <strong>تجهيز {order.pharmacyName} — #{order.id}</strong>
          <button className="ro-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ro-dialog__body">
          {shown && (
            <ZoomImage src={shown.src} onError={shown.local ? fallbackToDataUrl : undefined}>
                <button className="ro-pv__btn" title="إغلاق الصورة" onClick={() => setView(null)}><X size={15} /></button>
                {images.length > 1 && <>
                  <button className="ro-pv__btn" title="السابقة" onClick={() => setView(v => ((v ?? 0) - 1 + images.length) % images.length)}><ChevronRight size={15} /></button>
                  <span className="ro-pv__count">{(view ?? 0) + 1}/{images.length}</span>
                  <button className="ro-pv__btn" title="التالية" onClick={() => setView(v => ((v ?? 0) + 1) % images.length)}><ChevronLeft size={15} /></button>
                </>}
            </ZoomImage>
          )}
          <div className="ro-prep-top">
            {images.length > 0 && (
              <div className="ro-prep-thumbs">
                {images.map((im, i) => (
                  <button key={im.src} className={`ro-prep-thumb ${view === i ? 'is-on' : ''}`} title="فتح الصورة أعلى النافذة" onClick={() => setView(i)}>
                    <img src={im.src} alt="" onError={im.local ? fallbackToDataUrl : undefined} />
                    <span><ImageIcon size={11} /> {view === i ? 'مفتوحة' : 'فتح'}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="ro-share-read">
              <div className="ro-slot__label">المذخر الذي جهّز</div>
              <div className="ro-chips">
                {whChoices.map(w => (
                  <button key={w.id} className={`ro-chip ${whId === w.id ? 'is-active' : ''}`} onClick={() => setWhId(w.id)}>
                    <ChannelIcon ch={channelOf(w)} size={14} />{w.name}
                  </button>
                ))}
              </div>
              {ai?.auto && <div className="ro-auto">✅ تم التعرّف عليها تلقائياً من الفاتورة (تطابق {ai.candidate?.score}%)</div>}
              {ai?.candidate && <div className="ro-muted ro-small">الكميات من الفاتورة — صحّح ما يلزم</div>}
            </div>
          </div>

          <table className="ro-lines ro-prep-table">
            <colgroup><col /><col className="ro-pc-need" /><col className="ro-pc-in" /><col className="ro-pc-in" /><col className="ro-pc-st" /></colgroup>
            <thead><tr><th>الصنف</th><th>المطلوب</th><th>المجهّز</th><th>بونص</th><th /></tr></thead>
            <tbody>
              {rows.map(({ l, need, needBonus, from }) => {
                const id = l.id!;
                if (need === 0) {
                  return (
                    <tr key={id} className="ro-prep-done">
                      <td><div className="ro-strong">{l.itemName}</div>{from.length > 0 && <div className="ro-sub"><span>{from.join(' · ')}</span></div>}</td>
                      <td colSpan={3} className="ro-muted">مُجهّز سابقاً</td>
                      <td><span className="ro-prep ro-prep--full">✓</span></td>
                    </tr>
                  );
                }
                const g = got(id);
                const st = g >= need ? 'full' : g > 0 ? 'part' : 'none';
                const inv = ai?.candidate ? invLine.get(id) : undefined;
                return (
                  <tr key={id} className={st !== 'full' ? 'ro-diff' : ''}>
                    <td>
                      <div className="ro-strong">{l.itemName}</div>
                      {from.length > 0 && <div className="ro-sub"><span>سابقاً: {from.join(' · ')}</span></div>}
                      {ai?.candidate && (inv?.invoiceItem
                        ? <div className="ro-sub"><span>بالفاتورة: {inv.invoiceItem}</span></div>
                        : <div className="ro-sub"><span className="ro-warn-text">غير موجود بالفاتورة</span></div>)}
                    </td>
                    <td>{need}</td>
                    <td><input className="form-input ro-qty" type="number" min={0} inputMode="numeric" value={qty[id]?.p ?? ''} onChange={e => setQty(s => ({ ...s, [id]: { ...s[id], p: e.target.value } }))} /></td>
                    <td><input className="form-input ro-qty" type="number" min={0} inputMode="numeric" value={g === 0 ? '' : qty[id]?.b ?? ''} placeholder={g === 0 ? '0' : ''} disabled={g === 0} onChange={e => setQty(s => ({ ...s, [id]: { ...s[id], b: e.target.value } }))} /></td>
                    <td>
                      <button className={`ro-prep ro-prep--${st} ro-prep-st`} title={st === 'full' ? 'كامل — اضغط: لم يُجهَّز' : st === 'part' ? `ناقص ${need - g} — اضغط: كامل` : 'لا شيء — اضغط: كامل'}
                        onClick={() => setQty(s => ({ ...s, [id]: st === 'full' ? { p: '0', b: '' } : { p: String(need), b: needBonus ? String(needBonus) : '' } }))}>
                        {st === 'full' ? '✓' : st === 'part' ? `-${need - g}` : '✕'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className={`ro-note ${outcome === 'prepared' ? '' : 'ro-note--warn'}`}>
            {outcome === 'prepared' && `${whName} جهّز كل المطلوب — الطلبية تصير «تم التجهيز».`}
            {outcome === 'partial' && `${whName} جهّز جزءاً — يبقى ${missing.length} صنف (${missing.map(r => `${r.l.itemName} ${r.need - got(r.l.id!)}`).join('، ')}) يُرسل للمذخر التالي.`}
            {outcome === 'rejected' && `${whName} لم يجهّز شيئاً — الطلبية كاملة تُرسل للمذخر التالي.`}
          </div>
          {ai?.candidate && ai.candidate.extraItems.length > 0 && (
            <div className="ro-muted ro-small">أصناف بالفاتورة غير موجودة بالطلبية: {ai.candidate.extraItems.map(x => `${x.item} ×${x.quantity}`).join('، ')}</div>
          )}
        </div>
        <div className="ro-dialog__foot">
          <button className="btn btn--primary" disabled={saving} onClick={() => save()}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
          {outcome !== 'prepared' && nextOne && (
            <button className={`ro-send-btn ro-send-btn--${channelOf(nextOne)} ro-send-next`} disabled={saving} onClick={() => save(true)}>
              <Send size={15} /><span>حفظ وإرسال المتبقي إلى {nextOne.name}</span>
            </button>
          )}
          <button className="btn btn--secondary" onClick={onClose}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ─── ربط صورة مُشارَكة من واتساب بطلبية ──────────────────────────────────────
// فاتورة المذخر (كروبات واتساب) = «صورة التجهيز»: تُقرأ أولاً بالذكاء الاصطناعي
// (/invoice/read) وتُطابَق بالطلبيات (أفضل مرشّح واثق يُحدَّد تلقائياً). اختيار
// الطلبية يفتح نافذة «تجهيز» نفسها التي تُفتح من داخل الطلبية: الصورة أعلاها،
// والمذخر الذي جهّز، وكمية كل صنف (من الفاتورة إن قُرئت) قابلة للتصحيح قبل الحفظ.
// صورة ختم الصيدلية تُرفع بلا قراءة.

interface ReadLine { lineId: number; itemName: string; quantity: number; bonusQty: number; invoiceItem: string | null; preparedQty: number; preparedBonus: number }
interface ReadCandidate { orderId: number; score: number; lines: ReadLine[]; extraItems: { item: string; quantity: number; bonus: number }[] }
interface ReadResult {
  token: string;
  invoice: { pharmacy: string | null; warehouse: string | null; dateText: string | null; invoiceNumber: string | null; items: { item: string; quantity: number; bonus: number }[] } | null;
  candidates: ReadCandidate[]; autoOrderId: number | null; readError?: string;
}

const whKeyOf = (o: Order) => { const w = currentWh(o); return String(w.id ?? w.name); };

function SharedImagePicker({ api, images, beginSend, onViber, onDone, onCancel }: {
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>;
  images: Blob[];
  beginSend?: (o: Order, wh: OrderWh) => { go: () => void; cancel: () => void };
  /** الصورة سكرين شوت طلبيات من كروب الفايبر ← لوحة الاستيراد بدل الربط بطلبية */
  onViber?: () => void;
  onDone: () => void; onCancel: () => void;
}) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [read, setRead] = useState<ReadResult | null>(null);
  const [reading, setReading] = useState(true);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<ImageKind>('prepared');
  const [picked, setPicked] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  // فاتورة التجهيز: الطلبية المختارة تُفتح في نافذة «تجهيز» (لقطة القراءة وقت الفتح)
  const [prep, setPrep] = useState<{ order: Order; ai: PrepAi | null } | null>(null);
  // ضغطة على طلبية أثناء القراءة ← تُفتح فور انتهائها بكميات الفاتورة
  const [waitOpen, setWaitOpen] = useState<number | null>(null);
  // قراءة الفاتورة بالذكاء — يمنحها السوبر أدمن للحساب (المميزات ← طلبيات المذاخر)، ومن
  // مُنحها يطفئها/يشغّلها بمفتاح يتذكّره الجهاز. بإطفائها تُرفق الصورة كصورة تجهيز بلا قراءة
  const { hasFeature } = useAuth();
  const canAi = hasFeature('rep_orders_ai_read');
  const [aiPref, setAiOn] = useState<boolean>(() => { try { return localStorage.getItem('ro-ai-read') !== '0'; } catch { return true; } });
  const aiOn = canAi && aiPref;
  const toggleAi = (v: boolean) => { setAiOn(v); try { localStorage.setItem('ro-ai-read', v ? '1' : '0'); } catch { /* ignore */ } };
  // الافتراضي: الطلبيات قيد المتابعة فقط (أُرسلت للمذخر ولم تُجهَّز) — الفاتورة لواحدة منها حتماً
  const [showAll, setShowAll] = useState(false);
  // المذخر الذي جاءت منه الفاتورة: المشاركة لا تكشف الكروب المصدر، فيختاره المندوب بضغطة
  const [whKey, setWhKey] = useState<string | null>(null);

  // صورة واحدة لكل ربط: الأولى (واتساب يشارك عادةً صورة واحدة)
  const firstFile = useMemo(() => new File([images[0]], 'shared.jpg', { type: images[0].type || 'image/jpeg' }), [images]);
  const [thumb, thumbFallback] = useLocalImage(firstFile);

  useEffect(() => {
    api<{ orders: Order[] }>(`?from=${shiftDay(-30)}&to=${today()}`)
      .then(r => setOrders(r.orders.filter(o => o.status !== 'cancelled')))
      .catch(() => setOrders([]));
  }, [api]);

  useEffect(() => {
    if (!aiOn) { setRead(null); setReading(false); return; }
    let alive = true;
    setReading(true);
    (async () => {
      try {
        const fd = new FormData();
        fd.append('image', await compressImage(firstFile), 'invoice.jpg');
        const r = await api<ReadResult>('/invoice/read', { method: 'POST', body: fd });
        if (!alive) return;
        setRead(r);
        if (r.autoOrderId) setPicked(p => p ?? r.autoOrderId);
      } catch (e: any) {
        if (alive) setRead({ token: '', invoice: null, candidates: [], autoOrderId: null, readError: e.message });
      } finally { if (alive) setReading(false); }
    })();
    return () => { alive = false; };
  }, [api, firstFile, aiOn]);

  const candidateById = useMemo(() => new Map((read?.candidates ?? []).map(c => [c.orderId, c])), [read]);

  // فاتورة التجهيز ← قيد المتابعة فقط؛ ختم الصيدلية ← كل ما لم يُجهَّز بعد
  const pool = useMemo(() => (orders ?? []).filter(o => showAll
    || (kind === 'prepared' ? stateOf(o) === 'following' : stateOf(o) === 'new' || stateOf(o) === 'following')), [orders, showAll, kind]);
  const whOptions = useMemo(() => {
    const m = new Map<string, { key: string; name: string; ch: Channel; count: number }>();
    for (const o of pool) {
      const k = whKeyOf(o);
      if (!m.has(k)) m.set(k, { key: k, name: currentWh(o).name, ch: channelOf(currentWh(o)), count: 0 });
      m.get(k)!.count++;
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar'));
  }, [pool]);
  // مذخر واحد فقط ← يُختار تلقائياً؛ واختيار لم يعد موجوداً يُلغى
  useEffect(() => {
    if (whOptions.length === 1) setWhKey(whOptions[0].key);
    else setWhKey(k => (k && whOptions.some(w => w.key === k) ? k : null));
  }, [whOptions]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const rows = pool.filter(o => (!whKey || whKeyOf(o) === whKey)
      && (!t || `${o.id} ${o.pharmacyName} ${o.warehouseName} ${o.areaName ?? ''} ${o.repName}`.toLowerCase().includes(t)));
    // الأعلى تطابقاً مع الفاتورة أولاً، ثم غير المجهّزة
    const score = (o: Order) => candidateById.get(o.id)?.score ?? -1;
    return rows.sort((a, b) => score(b) - score(a) || Number(stateOf(a) === 'prepared') - Number(stateOf(b) === 'prepared'));
  }, [pool, whKey, q, candidateById]);

  // بلا ذكاء: طلبية واحدة متبقية بعد اختيار المذخر ← تُحدَّد مباشرة
  useEffect(() => {
    if (!aiOn && list.length === 1) setPicked(list[0].id);
  }, [aiOn, list]);

  const openPrep = (o: Order) => {
    setPicked(o.id);
    // الصورة رُفعت مع القراءة (token) ← تُثبَّت دون رفع ثانٍ، والكميات تبدأ مما قُرئ منها
    setPrep({
      order: o,
      ai: aiOn && read?.token
        ? { token: read.token, invoiceNumber: read.invoice?.invoiceNumber ?? null, candidate: candidateById.get(o.id) ?? null, auto: read.autoOrderId === o.id }
        : null,
    });
  };
  const choose = (o: Order) => {
    if (kind !== 'prepared') { setPicked(o.id); return; }
    if (aiOn && reading) { setPicked(o.id); setWaitOpen(o.id); return; }
    openPrep(o);
  };
  useEffect(() => {
    if (waitOpen == null || reading) return;
    const o = kind === 'prepared' ? orders?.find(x => x.id === waitOpen) : undefined;
    setWaitOpen(null);
    if (o) openPrep(o);
  }, [waitOpen, reading, kind, orders]); // eslint-disable-line react-hooks/exhaustive-deps

  // زر الرجوع في الهاتف داخل نافذة التجهيز ← قائمة الطلبيات
  useEffect(() => {
    if (!prep) return;
    const onBack = (e: Event) => {
      const ce = e as CustomEvent<{ activePage?: string }>;
      if (ce.detail?.activePage !== 'rep-orders' || ce.defaultPrevented) return;
      ce.preventDefault(); setPrep(null);
    };
    window.addEventListener('before-navigate-back', onBack);
    return () => window.removeEventListener('before-navigate-back', onBack);
  }, [prep]);

  // ختم الصيدلية: يُرفق مباشرة بلا كميات
  const saveStamp = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('image', await compressImage(firstFile), 'invoice.jpg');
      await api(`/${picked}/image/invoice`, { method: 'POST', body: fd });
      onDone();
    } catch (e: any) { alert(e.message); setSaving(false); }
  };

  if (prep) {
    return (
      <PrepareDialog api={api} order={prep.order} file={firstFile} ai={prep.ai} cancelLabel="رجوع للطلبيات"
        beginSend={beginSend} onClose={() => setPrep(null)} onSaved={onDone} />
    );
  }

  const inv = read?.invoice;
  const pickedOrder = picked ? orders?.find(o => o.id === picked) ?? null : null;
  return (
    <div className="ro-modal">
      <div className="ro-dialog">
        <div className="ro-dialog__head">
          <strong>ربط الصورة بطلبية</strong>
          {onViber && (
            <button className="btn btn--secondary btn--sm ro-viber-shot" onClick={onViber} title="الصورة سكرين شوت طلبيات من كروب الفايبر ← تكوين طلبيات منها">
              <ClipboardPaste size={14} /> طلبيات فايبر
            </button>
          )}
          <button className="ro-icon-btn" onClick={onCancel}><X size={16} /></button>
        </div>
        <div className="ro-dialog__body">
          <div className="ro-share-top">
            <div className="ro-share-thumbs">{thumb && <img src={thumb} alt="الصورة المُشارَكة" onError={thumbFallback} />}</div>
            <div className="ro-share-read">
              <div className="ro-chips">
                <button className={`ro-chip ${kind === 'prepared' ? 'is-active' : ''}`} onClick={() => setKind('prepared')}>فاتورة التجهيز</button>
                <button className={`ro-chip ${kind === 'invoice' ? 'is-active' : ''}`} onClick={() => setKind('invoice')}>ختم الصيدلية</button>
              </div>
              {kind === 'prepared' && canAi && (
                <label className="ro-ai-toggle">
                  <input type="checkbox" checked={aiOn} onChange={e => toggleAi(e.target.checked)} />
                  <span className="ro-ai-toggle__track" />
                  <span>قراءة الفاتورة بالذكاء الاصطناعي</span>
                </label>
              )}
              {kind === 'prepared' && aiOn && (reading ? (
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
              {kind === 'prepared' && aiOn && !reading && read?.autoOrderId && picked === read.autoOrderId && (
                <div className="ro-auto">✅ تم التعرّف تلقائياً على الطلبية #{read.autoOrderId} (تطابق {candidateById.get(read.autoOrderId)?.score}%) — اضغطها لتأكيد الكميات</div>
              )}
              {kind === 'prepared' && aiOn && !reading && inv && !read?.autoOrderId && (
                <div className="ro-muted ro-small">لم يُحسم التطابق تلقائياً — اختر الطلبية من القائمة (الأقرب أولاً).</div>
              )}
            </div>
          </div>

          {whOptions.length > 1 && (
            <div className="ro-chips ro-share-whs">
              <button className={`ro-chip ${!whKey ? 'is-active' : ''}`} onClick={() => setWhKey(null)}>كل المذاخر <b>{pool.length}</b></button>
              {whOptions.map(w => (
                <button key={w.key} className={`ro-chip ${whKey === w.key ? 'is-active' : ''}`} onClick={() => setWhKey(w.key)}>
                  <ChannelIcon ch={w.ch} size={14} />{w.name} <b>{w.count}</b>
                </button>
              ))}
            </div>
          )}
          <input className="form-input" placeholder="ابحث برقم الطلبية أو الصيدلية أو المذخر…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="ro-share-list">
            {orders === null && <div className="ro-muted">جارٍ التحميل…</div>}
            {orders !== null && list.length === 0 && (
              <div className="ro-muted">{showAll ? 'لا طلبيات خلال آخر 30 يوماً.' : kind === 'prepared' ? 'لا طلبيات قيد المتابعة.' : 'لا طلبيات جديدة أو قيد المتابعة.'}</div>
            )}
            {list.map(o => {
              const st = stateOf(o);
              const sc = candidateById.get(o.id)?.score;
              return (
                <button key={o.id} className={`ro-share-item ro-row--${st} ${picked === o.id ? 'is-picked' : ''}`} onClick={() => choose(o)}>
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
          {orders !== null && (
            <button className="ro-link ro-self-start" onClick={() => setShowAll(v => !v)}>
              {showAll ? (kind === 'prepared' ? 'عرض قيد المتابعة فقط' : 'عرض غير المجهّزة فقط') : 'الطلبية غير موجودة؟ عرض كل الطلبيات'}
            </button>
          )}
        </div>
        <div className="ro-dialog__foot">
          {kind === 'prepared' ? (
            <button className="btn btn--primary" disabled={!pickedOrder || waitOpen != null} onClick={() => pickedOrder && choose(pickedOrder)}>
              {waitOpen != null ? '⏳ تُفتح بعد القراءة…' : 'تأكيد الكميات'}
            </button>
          ) : (
            <button className="btn btn--primary" disabled={!picked || saving} onClick={saveStamp}>{saving ? 'جارٍ الحفظ…' : 'حفظ في الطلبية'}</button>
          )}
          <button className="btn btn--secondary" onClick={onCancel}>إلغاء</button>
          {kind === 'prepared' && <span className="ro-muted ro-small">اختر الطلبية ← تظهر الصورة وتؤكّد الكميات المجهّزة</span>}
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
          {isPdfPath(src)
            ? <a href={`${API}${src}`} target="_blank" rel="noreferrer" title="فاتورة PDF — فتح"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', minHeight: 64, fontSize: 13, fontWeight: 800, color: '#b91c1c', background: '#fef2f2', borderRadius: 8, textDecoration: 'none' }}>📄 PDF</a>
            : <img src={`${API}${src}`} alt={label} onClick={() => onPreview(src)} />}
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

function OrderForm({ token, api, order, warehouses, viaBot, canAddWarehouse, reps, viewerId, onWarehousesChanged, onClose, onSaved }: {
  token: string | null; viaBot: boolean; canAddWarehouse: boolean;
  reps: { id: number; name: string }[]; viewerId: number | null;
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
  // المدير يكتبها باسم مندوب من فريقه ← تُحسب للمندوب. '' = باسمي
  const [repId, setRepId] = useState(() => (order && order.createdById !== viewerId ? String(order.createdById) : ''));
  const repOptions = useMemo(() => (order && repId && !reps.some(r => String(r.id) === repId)
    ? [{ id: order.createdById, name: order.repName }, ...reps] : reps), [reps, order, repId]);
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
  // Enter وزر «التالي» بكيبورد الهاتف للخانة التالية (كمية ← بونص ← كمية السطر التالي ← الملاحظات)،
  // وسهما أعلى/أسفل لنفس الخانة بالسطر المجاور بدل تغيير الرقم
  const notesRef = useRef<HTMLInputElement>(null);
  const onLinesKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLInputElement;
    if (el.tagName !== 'INPUT') return;
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (e.key !== 'Enter' && !(step && el.type === 'number')) return;
    e.preventDefault();
    const fields = Array.from(e.currentTarget.querySelectorAll<HTMLInputElement>(step ? `input[data-col="${el.dataset.col}"]` : 'input'));
    const target = fields[fields.indexOf(el) + (step || 1)] ?? (step < 0 ? null : notesRef.current);
    target?.focus();
    target?.select();
  };
  // مذخر الطلبية القديمة يبقى قابلاً للاختيار وإن خرج من دليل المسوّق (خارج محافظته)
  const pickable = useMemo(() => {
    const known = new Set(warehouses.map(w => w.id));
    const extra: WarehouseRow[] = (order?.warehouses ?? []).flatMap(w => (w.id != null && !known.has(w.id)
      ? [{ id: w.id, name: w.name, phone: w.phone ?? '', groupLink: w.groupLink ?? null, notes: null, canEdit: false }]
      : []));
    return extra.length ? [...warehouses, ...extra] : warehouses;
  }, [warehouses, order]);
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
    if (!whIds.length) return setErr(canAddWarehouse ? 'اختر المذخر (أو أضف مذخراً جديداً برقم واتسابه)' : 'اختر المذخر');
    if (!head.pharmacyName.trim()) return setErr('اسم الصيدلية مطلوب');
    if (!valid.length) return setErr('أضف ايتماً واحداً على الأقل مع كميته');
    setSaving(true);
    try {
      const body = JSON.stringify({
        ...head,
        warehouseId: Number(whIds[0]),
        ...(repId ? { repUserId: Number(repId) } : order && viewerId ? { repUserId: viewerId } : {}),
        backupWarehouseIds: whIds.slice(1).map(Number),
        // «إرسال عبر البوت» مطفأة ⇒ لا إرسال آلي حتى لو وضع الحساب «فوري»
        viaBot,
        lines: valid.map(l => ({ itemId: l.itemId, itemName: l.text.trim(), companyName: l.companyName || null, quantity: Number(l.quantity), bonusQty: Number(l.bonusQty) || 0 })),
      });
      const r = await api<{ order: { id: number }; dispatch: { status: string; warehouseName: string | null; error: string | null } | null }>(order ? `/${order.id}` : '', { method: order ? 'PUT' : 'POST', body });
      if (invoiceFile) {
        const fd = new FormData();
        fd.append('image', await compressImage(invoiceFile), 'invoice.jpg');
        await api(`/${r.order.id}/image/invoice`, { method: 'POST', body: fd });
      }
      // وضع «فوري»/«بعد الموافقة» لحساب الكاتب في «إرسال للمذاخر»
      const d = r.dispatch;
      if (d && !order) {
        if (d.status === 'sent') alert(`أُرسلت الطلبية تلقائياً عبر البوت إلى ${d.warehouseName}.`);
        else if (d.status === 'awaiting_approval') alert('الطلبية بانتظار موافقة المدير للإرسال عبر البوت.');
        else if (d.status === 'failed' || d.status === 'needs_warehouse') alert(`تعذّر الإرسال التلقائي عبر البوت: ${d.error || ''}
أرسلها يدوياً من الطلبية.`);
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
            <WarehousePicker warehouses={pickable} value={whIds} onChange={setWhIds} onNew={canAddWarehouse ? () => setNewWh({ name: '', phone: '' }) : undefined} />
            <label className="ro-field">الصيدلية *
              <input className="form-input" list="ro-pharmacies" value={head.pharmacyName} onChange={e => onPharmacy(e.target.value)} />
              <datalist id="ro-pharmacies">{pharmacies.map(p => <option key={p.name} value={p.name} />)}</datalist>
            </label>
            {repOptions.length > 0 && (
              <label className="ro-field">المندوب
                <select className="form-input" value={repId} onChange={e => setRepId(e.target.value)} title="تُحسب الطلبية للمندوب المختار في التقارير">
                  <option value="">باسمي</option>
                  {repOptions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
            )}
            <label className="ro-field">المنطقة
              <input className="form-input" list="ro-areas" value={head.areaName} onChange={e => setHead(h => ({ ...h, areaName: e.target.value }))} />
              <datalist id="ro-areas">{areas.map(a => <option key={a} value={a} />)}</datalist>
            </label>
          </div>

          {newWh && (
            <div className="ro-newwh">
              <input className="form-input" placeholder="اسم المذخر (مثال: الناقوس)" value={newWh.name} onChange={e => setNewWh({ ...newWh, name: e.target.value })} />
              <input className="form-input" placeholder="رقم واتساب 07… أو رابط كروب واتساب/فايبر" dir="ltr" value={newWh.phone} onChange={e => setNewWh({ ...newWh, phone: e.target.value })} />
              <button className="btn btn--primary btn--sm" onClick={addWarehouse}>حفظ المذخر</button>
              <button className="btn btn--secondary btn--sm" onClick={() => setNewWh(null)}>إلغاء</button>
            </div>
          )}

          <div className="ro-form-lines" onKeyDown={onLinesKey}>
            {lines.length > 0 && <div className="ro-form-line ro-form-line--head"><span>الايتم</span><span>الشركة</span><span>الكمية</span><span>بونص</span><span /></div>}
            {lines.map(l => (
              <div key={l.key} className="ro-form-line">
                <div className="ro-line-item"><span className="ro-strong">{l.text}</span>{l.itemId && l.companyName && <span className="ro-show-sm ro-muted ro-small"> — {l.companyName}</span>}</div>
                {l.itemId
                  ? <div className="ro-line-co ro-muted">{l.companyName || '—'}</div>
                  : <input className="form-input" enterKeyHint="next" placeholder="الشركة" value={l.companyName} onChange={e => setLine(l.key, { companyName: e.target.value })} />}
                <input className="form-input" type="number" min={1} inputMode="numeric" enterKeyHint="next" data-col="qty" placeholder="الكمية" value={l.quantity} onChange={e => setLine(l.key, { quantity: e.target.value })} />
                <input className="form-input" type="number" min={0} inputMode="numeric" enterKeyHint="next" data-col="bonus" placeholder="بونص" value={l.bonusQty} onChange={e => setLine(l.key, { bonusQty: e.target.value })} />
                <button className="ro-icon-btn" tabIndex={-1} title="حذف السطر" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}><Trash2 size={14} /></button>
              </div>
            ))}
            <button className="btn btn--secondary btn--sm ro-self-start" onClick={() => setPickItems(true)}><Plus size={14} /> {lines.length ? 'ايتمات أخرى' : 'اختيار الايتمات'}</button>
          </div>
          {pickItems && <ItemPicker items={items} have={pickedIds} onAdd={addItems} onClose={() => setPickItems(false)} />}

          <label className="ro-field">ملاحظات
            <input ref={notesRef} className="form-input" value={head.notes} onChange={e => setHead(h => ({ ...h, notes: e.target.value }))} />
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
  warehouses: WarehouseRow[]; value: string[]; onChange: (v: string[]) => void; onNew?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setQ(''); return; }
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const terms = useMemo(() => normSearch(q).split(/\s+/).filter(Boolean), [q]);
  const list = useMemo(() => warehouses.filter(w => {
    if (!terms.length) return true;
    const t = normSearch(`${w.name} ${w.province || w.provinceGuess || ''}`);
    return terms.every(x => t.includes(x));
  }), [warehouses, terms]);
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
          <div className="ro-msel__search">
            <input className="form-input" type="search" autoFocus placeholder="بحث عن مذخر…" aria-label="بحث عن مذخر" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {list.map(w => {
            const id = String(w.id);
            const rank = value.indexOf(id);
            return (
              <button type="button" key={w.id} className={`ro-gm__opt ${rank >= 0 ? 'is-active' : ''}`} onClick={() => toggle(id)}>
                <span>{rank >= 0 ? '☑' : '☐'} {w.name}</span>{rank >= 0 && <b>{rankOf(rank)}</b>}
              </button>
            );
          })}
          {!list.length && <div className="ro-muted ro-ipick__empty">{terms.length ? 'لا مذخر بهذا الاسم.' : onNew ? 'لا مذاخر بعد.' : 'لا مذاخر لمحافظتك بعد — اطلب من مديرك إضافتها.'}</div>}
          {onNew && <button type="button" className="ro-gm__opt" onClick={() => { setOpen(false); onNew(); }}>+ مذخر جديد…</button>}
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

// ─── دليل المذاخر (الاسم + رقم الواتساب) ──────────────────────────────────────

function WarehousesModal({ api, warehouses, provinces, canManage, onOpen, onChanged, onClose }: {
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>;
  warehouses: WarehouseRow[]; provinces: string[]; canManage: boolean; onOpen: (w: OrderWh) => void; onChanged: () => void; onClose: () => void;
}) {
  const NO_PROV = 'بدون محافظة';
  const provOf = (w: WarehouseRow) => w.province || w.provinceGuess || NO_PROV;
  const [q, setQ] = useState('');
  const [prov, setProv] = useState<string | null>(null);
  const terms = normSearch(q).split(/\s+/).filter(Boolean);
  const matched = terms.length
    ? warehouses.filter(w => { const t = normSearch(`${w.name} ${w.phone} ${w.handle ?? ''} ${provOf(w)} ${w.notes ?? ''}`); return terms.every(x => t.includes(x)); })
    : warehouses;
  // ترتيب المحافظات كما في جدولها، وما لم يُعرف بعدها، و«بدون محافظة» أخيراً
  const rank = (p: string) => (p === NO_PROV ? 1e6 : provinces.indexOf(p) < 0 ? 1e5 : provinces.indexOf(p));
  const counts = new Map<string, number>();
  for (const w of matched) counts.set(provOf(w), (counts.get(provOf(w)) ?? 0) + 1);
  const provKeys = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ar'));
  const groups = provKeys
    .filter(p => !prov || p === prov)
    .map(p => ({ p, rows: matched.filter(w => provOf(w) === p).sort((a, b) => a.name.localeCompare(b.name, 'ar')) }));
  const [draft, setDraft] = useState<{ id: number | null; name: string; province: string; phone: string; handle: string; groupLink: string; notes: string } | null>(null);

  const save = async () => {
    if (!draft) return;
    try {
      const body = JSON.stringify({ name: draft.name, province: draft.province, phone: draft.phone, handle: draft.handle, groupLink: draft.groupLink, notes: draft.notes });
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
      <div className="ro-dialog ro-dialog--narrow ro-whdir" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head">
          <strong>دليل المذاخر <span className="ro-muted ro-small">({warehouses.length})</span></strong>
          <button className="ro-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ro-whdir__top">
          <div className="ro-whdir__bar">
            <div className="ro-search">
              <Search size={14} className="ro-search__icon" />
              <input className="form-input" type="search" placeholder="ابحث عن مذخر أو محافظة…" value={q} onChange={e => setQ(e.target.value)} aria-label="بحث في المذاخر" />
              {q && <button className="ro-search__x" title="مسح" onClick={() => setQ('')}><X size={13} /></button>}
            </div>
            {canManage && !draft && (
              <button className="btn btn--primary btn--sm" onClick={() => setDraft({ id: null, name: '', province: prov && prov !== NO_PROV ? prov : '', phone: '', handle: '', groupLink: '', notes: '' })}><Plus size={14} /> إضافة مذخر</button>
            )}
          </div>
          {provKeys.length > 1 && (
            <div className="ro-whdir__chips">
              <button className={`ro-whdir__chip${!prov ? ' is-on' : ''}`} onClick={() => setProv(null)}>الكل <b>{matched.length}</b></button>
              {provKeys.map(p => (
                <button key={p} className={`ro-whdir__chip${prov === p ? ' is-on' : ''}`} onClick={() => setProv(prov === p ? null : p)}>{p} <b>{counts.get(p)}</b></button>
              ))}
            </div>
          )}
          {draft && (
            <div className="ro-newwh">
              <input className="form-input" placeholder="اسم المذخر" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
              <input className="form-input" placeholder="المحافظة" list="ro-wh-provinces" value={draft.province} onChange={e => setDraft({ ...draft, province: e.target.value })} />
              <datalist id="ro-wh-provinces">{provinces.map(p => <option key={p} value={p} />)}</datalist>
              <input className="form-input" placeholder="رقم واتساب 07…" inputMode="tel" dir="ltr" value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} />
              <input className="form-input" placeholder="معرّف واتساب بدل الرقم (@user)" dir="ltr" value={draft.handle} onChange={e => setDraft({ ...draft, handle: e.target.value })} />
              <input className="form-input" placeholder="رابط كروب واتساب أو فايبر (اختياري)" dir="ltr" value={draft.groupLink} onChange={e => setDraft({ ...draft, groupLink: e.target.value })} />
              <input className="form-input" placeholder="ملاحظة (اختياري)" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} />
              <button className="btn btn--primary btn--sm" onClick={save}>حفظ</button>
              <button className="btn btn--secondary btn--sm" onClick={() => setDraft(null)}>إلغاء</button>
            </div>
          )}
        </div>
        <div className="ro-dialog__body ro-whdir__list">
          {warehouses.length === 0 && <div className="ro-muted">لا مذاخر بعد.</div>}
          {warehouses.length > 0 && matched.length === 0 && <div className="ro-muted">لا مذخر بهذا الاسم.</div>}
          {groups.map(g => (
            <div key={g.p} className="ro-whdir__group">
              <div className="ro-whdir__ghead">{g.p} <span>{g.rows.length}</span></div>
              {g.rows.map(w => (
                <div key={w.id} className="ro-whdir__row">
                  <span className="ro-wh-dir__name ro-whdir__name">
                    {/* الاسم يفتح كروب المذخر أو محادثته */}
                    {!canManage || channelOf(w) === 'share' ? w.name : <button type="button" className="ro-whlink" title={`فتح ${CHANNEL_LABEL[channelOf(w)]}`} onClick={() => onOpen(w)}>{w.name}</button>}
                    {canManage && <ChannelIcon ch={channelOf(w)} size={13} />}
                  </span>
                  <span className="ro-whdir__contact">
                    {canManage && w.phone && <span dir="ltr">{w.phone}</span>}
                    {w.notes && <span className="ro-whdir__note" title={w.notes}>{w.notes}</span>}
                  </span>
                  {w.canEdit && (
                    <span className="ro-row-actions">
                      <button className="ro-icon-btn ro-icon-btn--sm" title="تعديل" onClick={() => setDraft({ id: w.id, name: w.name, province: w.province ?? w.provinceGuess ?? '', phone: w.phone, handle: w.handle ?? '', groupLink: w.groupLink ?? '', notes: w.notes ?? '' })}><Pencil size={12} /></button>
                      <button className="ro-icon-btn ro-icon-btn--sm ro-icon-btn--danger" title="حذف" onClick={() => remove(w)}><Trash2 size={12} /></button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
