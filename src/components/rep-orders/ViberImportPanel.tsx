// ════════════════════════════════════════════════════════════════════════════
// ViberImportPanel — «📥 استيراد من الفايبر» في صفحة طلبيات المذاخر (ميزة اشتراك
// rep_orders_viber_import).
//
// الفايبر لا يسمح لبوت بقراءة كروب ولا بتحديد عدة رسائل ونسخها معاً، فالإدخال:
//   • كل Ctrl+V لرسالة منسوخة = بطاقة طلبية فوراً (النسخ واحدة واحدة يصير سريعاً)
//   • «مشاركة ← Ordine» على رسالة بالموبايل (sw.js يحفظ النص ← initialText)
//   • أو سكرين شوت (Win+Shift+S ثم Ctrl+V، أو اختيار/سحب/مشاركة الصور) — 3-4 طلبيات بصورة
// الخادم (server/modules/rep-orders/rep-orders.import.js) يُعيد مسوّدات لا يحفظ شيئاً؛
// الحفظ هنا بـ POST /api/rep-orders العادي، والإرسال بمسار «إرسال عبر البوت» نفسه.
//
// والرجوع للفايبر: ViberInvoicesButton (كل الفواتير بنقرة) و ViberFeedbackButtons (فاتورة واحدة).
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ClipboardPaste, Image as ImageIcon, Trash2, Plus, Check, Send, Pencil, Users, Images, LayoutGrid, MessageSquareText } from 'lucide-react';
import { compressImage } from '../../lib/localImage';
import { normSearch } from '../OrderItemPicker';
// أصناف ro-modal/ro-dialog — اللوحة تُفتح أيضاً من صفحة رفع الملفات (مراجعة طلبيات البوت)
import '../../pages/RepOrdersPage.css';
import './ViberImportPanel.css';

const API = import.meta.env.VITE_API_URL || '';

interface DraftLine {
  itemId: number | null; itemName: string; writtenAs: string; quantity: number; bonusQty: number; matched: boolean;
  suggestions: { id: number; name: string }[]; companyName?: string | null; unitPrice?: number | null;
  editing?: boolean; // الواجهة: الصنف المطابَق فُتح للبحث عن غيره
  // ذاكرة التصحيحات: الصنف كما ربطه الخادم، ورقم السطر في القراءة الأصلية (السطر المضاف بلا رقم)،
  // وmemory = رُبط بقاعدة توحيد (تصحيح سابق)
  origItemId?: number | null; origIdx?: number; memory?: boolean;
}
interface MentionedWh { id: number | null; name: string; ready?: boolean }
/** طلبية بوت معلَّقة (صفحة رفع الملفات) — نفس شكل PendingOrderDetail في ManualSalesModal. */
export interface BotOrder {
  id: number; source: string; kind: string; rows: any[];
  repName?: string | null; sourceText?: string | null; senderName?: string | null;
  imageCount?: number; createdAt?: string;
  /** اسم كروب الواتساب/التلكرام الذي وصلت منه */
  chatTitle?: string | null;
}
/** خيار في خانة المندوب لطلبية البوت: مندوبو المحافظة مع شركة كل واحد؛ star = مرشّح (صاحب الصنف × المنطقة). */
interface RepOpt { id: number; name: string; company?: string | null; star?: boolean }
interface ServerRepOpt { name: string; company?: string | null; star?: boolean }
interface Draft {
  // المذاخر كما كُتبت في الرسالة، والمذخر المحفوظ في اللكوديشن (نص حرّ لا اختيار من الدليل)
  writtenWarehouses?: string[]; whText?: string;
  // طلبية بوت: رقمها ومصدرها وحساب الكروب، وتاريخ الفاتورة ورقمها من صفوفها
  bot?: { orderId: number; source: string; repAccount: string | null; createdAt?: string; chat?: string | null };
  // طلبية البوت: مندوبو محافظة الطلبية فقط (null = المحافظة غير معروفة ⇒ الفريق كله)
  repOptions?: RepOpt[] | null;
  date?: string; invoiceNumber?: string;
  // تكرار مع ملف اللكوديشن/ميركاتو (فُحص عند ظهور البطاقة): مستواه ووصف المحفوظ سابقاً
  dupChecked?: boolean; liqDup?: { level: string; text: string; match?: DupMatch } | null;
  key: string; source: string; sourceText: string; sender: string | null; mentions: string[]; readBy: string;
  pharmacyName: string; areaName: string; warehouseId: number | null; warehouseName: string; backupWarehouseIds: number[];
  mentionedWarehouses: MentionedWh[];
  notes: string; lines: DraftLine[]; repUserId: number | null; repName: string | null; repWhy: 'area' | 'leader' | 'sender' | 'learned' | 'guess' | 'bot' | 'botLeader' | 'memory' | null; repNote?: string | null;
  repCandidates: { id: number; name: string }[]; sourceHash: string | null;
  // ذاكرة التصحيحات (طلبية البوت): ما قرأه المحلّل (raw) وما عُرض (shown، بعد دروس سابقة)،
  // فالفرق عند الحفظ يصير درساً. learned = الخانات التي ملأتها الذاكرة (شارة 🧠).
  orig?: {
    pharmacy: string; area: string; warehouse: string;
    shown: { pharmacy: string; area: string; warehouse: string };
    repUserId: number | null;
    lines: { itemName: string; itemId: number | null; quantity: number; bonusQty: number }[];
  };
  learned?: { pharmacy?: boolean; area?: boolean; warehouse?: boolean; rep?: boolean };
  duplicateOf: { id: number; pharmacyName: string; createdAt: string; status: string } | null; dupInBatch: boolean; warnings: string[];
  // الواجهة فقط — manual: بطاقة «كتابة يدوية» بلا رسالة (نفس الحقول والحفظ)
  manual?: boolean;
  include: boolean; state?: 'saving' | 'done' | 'warn' | 'error'; result?: string;
}
interface Wh { id: number; name: string }
interface Rep { id: number; name: string }
interface CatItem { id: number; name: string; price?: number | null; warehousePrice?: number | null; company?: { name: string } | null; scientificCompany?: { name: string } | null }

/**
 * وجهة الطلبيات المقروءة (زر أعلى اللوحة):
 *   liq — «لكوديشن»: تُحفَظ مبيعاً في ملف اللكوديشن المشترك للمكتب (POST /api/sales/manual
 *         بـ target.condition) باسم المندوب العلمي، فتُحسب له مع مبيعاته. الافتراضي دائماً.
 *   wh  — «مذاخر»: طلبية مذخر في «طلبيات المذاخر» (المسار القديم) ثم الإرسال للمذخر.
 */
type Mode = 'liq' | 'wh';

/** قائمة خانة المندوب: auto = العلميون + المسوقون مع الاختيار بالمنطقة؛ mkt = المسوقون فقط (يدوي)؛ sci = العلميون فقط. */
type RepKind = 'auto' | 'mkt' | 'sci';
/** الطلبية المحفوظة المطابِقة كما يصفها /api/sales/check-duplicates (describeMatch). */
type DupMatch = {
  inBatch?: boolean; date?: string; savedAt?: string; pharmacy?: string; area?: string; warehouse?: string;
  rep?: string; source?: string; fileName?: string; mercato?: boolean; invoiceNumber?: string;
  items?: { name: string; qty: number; bonus?: number }[];
};

/** شريط أفقي مختصر بتفاصيل الطلبية المحفوظة المكررة — تحت تنبيه التكرار. */
function DupMatchStrip({ m }: { m: DupMatch }) {
  const savedAt = m.savedAt ? String(m.savedAt).slice(0, 16).replace('T', ' ') : '';
  const fields: [string, string | undefined][] = [
    ['التاريخ', m.date], ['الصيدلية', m.pharmacy], ['المنطقة', m.area], ['المذخر', m.warehouse],
    ['المندوب', m.rep], ['المصدر', m.source], ['رقم', m.invoiceNumber],
    ['الملف', m.mercato ? m.fileName : undefined], ['حُفظت', savedAt],
  ];
  return (
    <div className="vi-dupx" title="الطلبية المحفوظة سابقاً">
      <span className="vi-dupx__tag">المحفوظة:</span>
      {fields.filter(([, v]) => v).map(([k, v]) => (
        <span key={k} className="vi-dupx__f"><i>{k}</i>{v}</span>
      ))}
      {m.items?.map((it, i) => (
        <span key={`it${i}`} className="vi-dupx__it">
          <b dir="auto">{it.name || '—'}</b> × {it.qty}{it.bonus ? ` + ${it.bonus}` : ''}
        </span>
      ))}
    </div>
  );
}

const REP_KIND_KEY = 'vi-rep-kind';
const REP_KIND_NEXT: Record<RepKind, RepKind> = { auto: 'mkt', mkt: 'sci', sci: 'auto' };
const REP_KIND_LABEL: Record<RepKind, string> = { auto: 'تلقائي', mkt: 'مسوقين', sci: 'علميين' };

/** اسم مندوب للمطابقة: بلا «/ المنطقة ph»، وبلا همزات وتاء مربوطة ومسافات. */
const repKey = (s: string) => String(s ?? '').split('/')[0].replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, '').toLowerCase();
const numOf = (v: unknown) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

/** صفوف طلبية بوت ← بطاقة لكل (صيدلية × رقم فاتورة): الصورة قد تحمل أكثر من فاتورة. */
function botDrafts(o: BotOrder): Draft[] {
  const groups = new Map<string, any[]>();
  for (const r of (o.rows || []).filter(Boolean)) {
    const k = `${repKey(r.pharmacy || '')}|${String(r.invoiceNumber ?? '').trim()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.values()].map((rs, gi) => {
    const first = rs[0] || {};
    const written = [...new Set(rs.map(r => String(r.warehouse ?? '').trim()).filter(Boolean))];
    // ما قرأه المحلّل قبل أي درس سابق (الخادم يحفظه في _learned حين يطبّق درساً)
    const L = (first._learned && typeof first._learned === 'object') ? first._learned : {};
    const rawOf = (f: 'pharmacy' | 'area') => String(L[f] != null ? L[f] : (first[f] ?? '')).trim();
    const lines: DraftLine[] = rs.map((r, li) => {
      const q = numOf(r.quantity);
      const unit = r.unitPrice != null && r.unitPrice !== '' ? numOf(r.unitPrice) : (numOf(r.total) && q ? numOf(r.total) / q : null);
      return {
        // writtenAs = ما كتبه المندوب (قبل توحيده مع الكتالوج) — تغيير صنفه يُحفَظ قاعدةً
        // (rememberItems)، حتى الصنف المربوط آلياً خطأً: الخادم يحفظ ما قُرئ في _readItem.
        itemId: r._itemId ?? null, itemName: String(r.item ?? ''),
        writtenAs: String(r._readItem ?? (r._itemId ? '' : (r.item ?? ''))),
        quantity: q, bonusQty: numOf(r.bonus), matched: Boolean(r._itemId), suggestions: [],
        companyName: r.company || null, unitPrice: unit,
        origItemId: r._itemId ?? null, origIdx: li, memory: Boolean(r._itemId) && r._itemMatch?.confidence === 'alias',
      };
    });
    return {
      key: `b${o.id}-${gi}`, source: o.source, sourceText: o.sourceText || '', sender: o.senderName || null,
      mentions: [], readBy: 'parser',
      pharmacyName: String(first.pharmacy ?? ''), areaName: String(first.area ?? ''),
      warehouseId: null, warehouseName: written[0] ?? '', backupWarehouseIds: [], mentionedWarehouses: [],
      writtenWarehouses: written, whText: written[0] ?? '',
      notes: [...new Set(rs.map(r => String(r.notes ?? '').trim()).filter(Boolean))].join(' — '),
      lines,
      orig: {
        pharmacy: rawOf('pharmacy'), area: rawOf('area'),
        warehouse: String(L.warehouse != null ? L.warehouse : (written[0] ?? '')).trim(),
        shown: { pharmacy: String(first.pharmacy ?? ''), area: String(first.area ?? ''), warehouse: written[0] ?? '' },
        repUserId: null,
        lines: lines.map(l => ({ itemName: l.itemName, itemId: l.itemId, quantity: l.quantity, bonusQty: l.bonusQty })),
      },
      learned: { pharmacy: L.pharmacy != null, area: L.area != null, warehouse: L.warehouse != null, rep: first._repPick === 'memory' },
      repUserId: null, repName: String(first.scientificRep ?? '') || null, repWhy: null, repNote: null,
      repCandidates: [], sourceHash: null, duplicateOf: null, dupInBatch: false, warnings: [], include: true,
      date: first.date ? String(first.date) : undefined, invoiceNumber: first.invoiceNumber ? String(first.invoiceNumber) : undefined,
      bot: { orderId: o.id, source: o.source, repAccount: o.repName ?? null, createdAt: o.createdAt, chat: o.chatTitle ?? null },
      // مرشّحو الخادم للبطاقة (أسماء) — تُطابَق بأعضاء الفريق بعد تحميله. قائمة المحافظة:
      // مرشّحو كل أصناف البطاقة أولاً، ثم بقية مندوبي المحافظة.
      ...({
        _cands: (first._repCandidates || []).map((c: any) => c?.name).filter(Boolean), _repPick: first._repPick ?? null, _repNote: first._repNote ?? null,
        _opts: rs.some(r => Array.isArray(r._repOptions))
          ? [...rs.flatMap(r => (r._repOptions || []).filter((x: any) => x?.star)), ...rs.flatMap(r => r._repOptions || [])] as ServerRepOpt[]
          : null,
      } as any),
    } as Draft;
  });
}

/** قائمة الخادم (أسماء) ← خيارات بمعرّفات الفريق، بلا تكرار؛ المرشّح في أي صنف يبقى ★. */
function toRepOpts(list: ServerRepOpt[], byName: (name: string) => Rep): RepOpt[] {
  const out: RepOpt[] = [];
  for (const o of list) {
    if (!o?.name) continue;
    const r = byName(o.name);
    const hit = out.find(x => x.id === r.id);
    if (hit) { hit.star = hit.star || Boolean(o.star); hit.company = hit.company || o.company || null; continue; }
    out.push({ id: r.id, name: r.name, company: o.company || null, star: Boolean(o.star) });
  }
  return out;
}

const REP_WHY: Record<string, string> = { bot: '', memory: '🧠 من تصحيح سابق', botLeader: 'تيم ليدر — لم يُحسم مندوب علمي للصنف', leader: 'تيم ليدر المنطقة (لا مندوب علمي لها)', area: 'صاحب المنطقة', sender: 'من اسم المرسل', learned: 'اخترته سابقاً لنفس المرسل', guess: 'صاحب المنطقة' };
const dayStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const IS_TOUCH = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
const fmtPrice = (n?: number | null) => (n != null && Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-US') : null);
const catCompany = (i: CatItem) => i.scientificCompany?.name ?? i.company?.name ?? null;
const catPrice = (i: CatItem) => i.warehousePrice ?? i.price ?? null;

/** المذخر الذي تذهب له الطلبية = المختار؛ الاحتياط = باقي المذكورة الفعّالة بترتيب الرسالة. */
function choosePrimary(d: Draft, m: MentionedWh): Partial<Draft> {
  const active = new Set([...(d.warehouseId ? [d.warehouseId] : []), ...d.backupWarehouseIds]);
  const backups = d.mentionedWarehouses
    .filter(x => x.id && x.id !== m.id && active.has(x.id))
    .map(x => x.id as number);
  return { warehouseId: m.id, warehouseName: m.name, backupWarehouseIds: backups };
}

// ─── البحث الذكي في الكتالوج ─────────────────────────────────────────────────
const sKey = (s: unknown) => normSearch(s).replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();

/** شارة 🧠: القيمة ملأتها ذاكرة التصحيحات وما زالت كما عُرضت. */
function memBadge(on: boolean | undefined, now: string, shown?: string, raw?: string) {
  if (!on || sKey(now) !== sKey(shown ?? '')) return null;
  return <span className="vi-mem" title={`🧠 من تصحيح سابق${raw ? ` — قُرئت «${raw}»` : ''}. غيّرها إن كانت خطأ فيتعلّم التصحيح الجديد`}>🧠</span>;
}

/** «pantactive 40» يطابق «PANTACTIVE 40MG TAB»؛ وكلمة ناقصة/خاطئة تُطابَق ببداية العلامة. */
export function searchCatalog(items: CatItem[], q: string, limit = 8): CatItem[] {
  const tq = sKey(q);
  if (tq.length < 2) return [];
  const toks = tq.split(' ').filter(Boolean);
  const out: [number, CatItem][] = [];
  for (const it of items) {
    const n = sKey(it.name);
    const tight = n.replace(/ /g, '');
    let score = 0;
    if (toks.every(t => n.includes(t) || tight.includes(t))) {
      score = 2 + (n.startsWith(toks[0]) ? 2 : 0) + (n === tq ? 5 : 0);
    } else {
      const b = toks[0].slice(0, 4);
      const rest = toks.slice(1).filter(t => /\d/.test(t));
      if (b.length >= 3 && n.split(' ')[0].startsWith(b) && rest.every(t => n.includes(t))) score = 1;
    }
    if (score) out.push([score, it]);
  }
  return out.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length).slice(0, limit).map(x => x[1]);
}

/**
 * قائمة الاقتراحات فوق كل شيء (portal بموضع ثابت): البطاقة overflow:hidden وجسم اللوحة
 * يتمرّر، فالقائمة المطلقة داخلها كانت تُقصّ أسفل البطاقة. تنقلب للأعلى إن لم يكفِ ما تحت الخانة.
 */
function SuggestList({ anchor, children }: { anchor: React.RefObject<HTMLElement>; children: React.ReactNode }) {
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  useEffect(() => {
    const place = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
      const up = below < 200 && above > below;
      const maxHeight = Math.max(120, Math.min(280, up ? above : below));
      const width = Math.max(r.width, 240);
      // RTL: حافة الخانة اليمنى هي البداية
      const right = Math.max(4, window.innerWidth - r.right);
      setPos({ position: 'fixed', right, width: Math.min(width, window.innerWidth - right - 4), maxHeight,
        ...(up ? { bottom: window.innerHeight - r.top + 3 } : { top: r.bottom + 3 }) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [anchor]);
  if (!pos) return null;
  return createPortal(<div className="vi-isearch__list is-floating" dir="rtl" style={pos}>{children}</div>, document.body);
}

function ItemSearch({ catalog, value, autoFocus, onText, onPick }: {
  catalog: CatItem[]; value: string; autoFocus?: boolean;
  onText: (v: string) => void; onPick: (it: CatItem) => void;
}) {
  const [open, setOpen] = useState(Boolean(autoFocus));
  const box = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchCatalog(catalog, value), [catalog, value]);
  return (
    <div className="vi-isearch" ref={box}>
      <input className="form-input vi-line__input" value={value} autoFocus={autoFocus} placeholder="اكتب اسم الصنف…"
        onChange={e => { onText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && results.length > 0 && (
        <SuggestList anchor={box}>
          {results.map(it => (
            <button key={it.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onPick(it); setOpen(false); }}>
              <b>{it.name}</b>
              <small>{[catCompany(it), fmtPrice(catPrice(it))].filter(Boolean).join(' · ')}</small>
            </button>
          ))}
        </SuggestList>
      )}
    </div>
  );
}

/** منطقة من النظام: الاسم، وإن كان مدموجاً فالمنطقة التي دُمج تحتها، وهل لها مندوب في الفريق. */
interface AreaOpt { name: string; canon: string | null; covered: boolean }

/**
 * خانة المنطقة باقتراحات من أسماء مناطق النظام (والأسماء المدموجة). الفارغة تعرض مناطق
 * الفريق أولاً. الاختيار أو تعديل الاسم يُعيد اختيار المندوب من الخادم (onCommit).
 */
function AreaSearch({ areas, value, disabled, onText, onCommit }: {
  areas: (AreaOpt & { k: string })[]; value: string; disabled?: boolean;
  onText: (v: string) => void; onCommit: (area: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const typedAt = useRef<string | null>(null); // القيمة عند التركيز — يُعاد الاختيار فقط إن تغيّرت
  const results = useMemo(() => {
    const k = sKey(value);
    if (!k) return areas.filter(a => a.covered).slice(0, 8);
    const toks = k.split(' ');
    const hit = areas.filter(a => toks.every(t => a.k.includes(t) || a.k.replace(/ /g, '').includes(t)));
    return hit.sort((a, b) => Number(b.covered) - Number(a.covered) || Number(b.k.startsWith(toks[0])) - Number(a.k.startsWith(toks[0]))).slice(0, 8);
  }, [areas, value]);
  const pick = (a: AreaOpt) => { const name = a.canon || a.name; onText(name); typedAt.current = name; setOpen(false); onCommit(name); };
  const box = useRef<HTMLDivElement>(null);
  return (
    <div className="vi-isearch" ref={box}>
      <input className="form-input" value={value} disabled={disabled} placeholder="المنطقة"
        onChange={e => { onText(e.target.value); setOpen(true); }}
        onFocus={() => { typedAt.current = value; setOpen(true); }}
        onBlur={() => setTimeout(() => {
          setOpen(false);
          if (typedAt.current !== null && typedAt.current !== value) onCommit(value);
          typedAt.current = null;
        }, 150)} />
      {open && results.length > 0 && (
        <SuggestList anchor={box}>
          {results.map(a => (
            <button key={a.k} type="button" onMouseDown={e => e.preventDefault()} onClick={() => pick(a)}>
              <b>{a.name}</b>
              {(a.canon || a.covered) && <small>{[a.canon ? `مدموجة تحت ${a.canon}` : '', a.covered ? 'لها مندوب بفريقك' : ''].filter(Boolean).join(' · ')}</small>}
            </button>
          ))}
        </SuggestList>
      )}
    </div>
  );
}

/** خانة بحث بالكتابة في دليل المذاخر (بدل القائمة المنسدلة الطويلة). */
function WarehouseSearch({ warehouses, placeholder, onPick }: { warehouses: Wh[]; placeholder: string; onPick: (w: Wh) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const k = sKey(q);
    const list = k ? warehouses.filter(w => { const n = sKey(w.name); return k.split(' ').every(t => n.includes(t) || n.replace(/ /g, '').includes(t)); }) : warehouses;
    return list.slice(0, 30);
  }, [warehouses, q]);
  const box = useRef<HTMLDivElement>(null);
  return (
    <div className="vi-isearch" ref={box}>
      <input className="form-input vi-wh-add" value={q} placeholder={placeholder}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && results.length > 0 && (
        <SuggestList anchor={box}>
          {results.map(w => (
            <button key={w.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onPick(w); setQ(''); setOpen(false); }}>
              <b>{w.name}</b>
            </button>
          ))}
        </SuggestList>
      )}
    </div>
  );
}

export default function ViberImportPanel({ api, token, warehouses, reps, canSend, initialText, initialImages, allowImages = true, modes: modesProp, onClose, onChanged, onFinished, botOrders, onBotSaved, onBotCancel, onLegacy }: {
  /** الوجهات المسموحة من «المميزات» (rep_orders_viber_liq / _wh) — واحدة فقط ⇒ كل الطلبيات لها بلا اختيار */
  modes?: readonly Mode[];
  /** مراجعة طلبيات البوت (صفحة رفع الملفات): نفس البطاقات، تُحفظ في اللكوديشن فقط */
  botOrders?: BotOrder[] | null;
  /** حُفظت طلبيات البوت: أرقامها (تُزال من الطابور)، وملف اللكوديشن، والخلاصة */
  onBotSaved?: (orderIds: number[], fileId: number | undefined, summary: string, done: boolean) => void;
  /** فتح نفس الطلبيات بجدول المراجعة القديم (للفواتير المعقّدة) */
  onLegacy?: () => void;
  /** حذف طلبيات بوت من الطابور نهائياً (زر 🗑 على آخر بطاقة للطلبية) — يرمي خطأً إن رُفض */
  onBotCancel?: (orderIds: number[]) => Promise<void>;
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>;
  token: string | null;
  warehouses: Wh[];
  reps: Rep[];
  canSend: boolean;
  /** نصّ وصل بـ«مشاركة ← Ordine» — يُقرأ فور الفتح */
  initialText?: string | null;
  /** سكرين شوت وصل بالمشاركة */
  initialImages?: File[] | null;
  /** ميزة «قراءة صور الطلبيات» (rep_orders_viber_images) — مطفأة = لصق النص فقط */
  allowImages?: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** انتهى الإنشاء بلا أخطاء ← تُغلق اللوحة وتُعرض الخلاصة في الصفحة */
  onFinished?: (summary: string) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [team, setTeam] = useState<Rep[]>([]);
  // مسوقو الفريق (اختيار يدوي فقط) وزر نوع قائمة المندوبين: تلقائي ← مسوقين ← علميين،
  // يُحفظ في المتصفح ويبقى حتى يغيّره المستخدم
  const [marketers, setMarketers] = useState<Rep[]>([]);
  const [repKind, setRepKindState] = useState<RepKind>(() => {
    try { const v = localStorage.getItem(REP_KIND_KEY); return v === 'mkt' || v === 'sci' ? v : 'auto'; } catch { return 'auto'; }
  });
  const repKindRef = useRef(repKind);
  // فريق بلا مسوقين ⇒ الزر مخفي والاختيار المحفوظ لا يسري
  repKindRef.current = marketers.length ? repKind : 'auto';
  const [catalog, setCatalog] = useState<CatItem[]>([]);
  const [reading, setReading] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // مثبّت على اللكوديشن عند كل فتح (طلب صاحب المشروع) — لا يُتذكَّر آخر اختيار
  // (وإن أُطفئت خانة اللكوديشن من «المميزات» فالمذاخر). مراجعة البوت لكوديشن دائماً.
  const modes: readonly Mode[] = botOrders?.length || !modesProp?.length ? ['liq', 'wh'] : modesProp;
  const [mode, setMode] = useState<Mode>(modes.includes('liq') ? 'liq' : 'wh');
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLTextAreaElement>(null);

  // كتالوج الايتمات (الاسم + الشركة + السعر) للبحث الذكي في الأصناف
  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/items`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then(r => r.json()).then(j => setCatalog(Array.isArray(j?.data) ? j.data : [])).catch(() => {});
  }, [token]);

  // أسماء مناطق النظام لاقتراحات خانة المنطقة — مرة واحدة عند فتح اللوحة
  const [areaOpts, setAreaOpts] = useState<(AreaOpt & { k: string })[]>([]);
  const isBot = Boolean(botOrders?.length);
  // صور طلبيات البوت المصوّرة: رقم الطلبية ← روابط blob
  const [botImages, setBotImages] = useState<Record<number, string[]>>({});
  const [zoom, setZoom] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      let teamList: Rep[] = [];
      try {
        const r = await api<{ areas: AreaOpt[]; team?: Rep[]; marketers?: Rep[] }>('/import/areas');
        if (!alive) return;
        setAreaOpts((r.areas ?? []).map(a => ({ ...a, k: sKey(a.name) })));
        setMarketers(r.marketers ?? []);
        teamList = r.team ?? [];
        if (teamList.length) setTeam(prev => [...prev, ...teamList.filter(x => !prev.some(p => p.id === x.id))]);
      } catch { /* الاقتراحات ليست شرطاً */ }
      if (!alive || !botOrders?.length) return;
      // طلبيات البوت ← بطاقات. المندوب المكتوب في الطلبية يُطابَق باسم عضو في الفريق؛ اسم
      // خارج الفريق يبقى خياراً باسمه؛ وبلا اسم يُختار صاحب المنطقة من الخادم.
      const extra: Rep[] = [];
      const optOf = (name: string): Rep => {
        const hit = teamList.find(u => repKey(u.name) === repKey(name))
          ?? teamList.find(u => repKey(u.name).startsWith(repKey(name)) || repKey(name).startsWith(repKey(u.name)));
        if (hit) return hit;
        const ex = extra.find(u => repKey(u.name) === repKey(name));
        if (ex) return ex;
        const made = { id: -(extra.length + 1), name: name.split('/')[0].trim() };
        extra.push(made);
        return made;
      };
      const built = botOrders.flatMap(botDrafts).map(d => {
        const cands = ((d as any)._cands as string[]).map(optOf);
        const picked = d.repName ? optOf(d.repName) : null;
        // التيم ليدر احتياطاً (لا مندوب واحد معيَّن له الصنف) ⇒ يُقال ذلك وسببه بدل «من الطلبية».
        const leaderPick = (d as any)._repPick === 'leader';
        const opts = (d as any)._opts as ServerRepOpt[] | null;
        return { ...d, repCandidates: cands, repOptions: opts ? toRepOpts(opts, optOf) : null, repUserId: picked?.id ?? null, repName: picked?.name ?? null,
          repWhy: picked ? (d.learned?.rep ? 'memory' as const : leaderPick ? 'botLeader' as const : 'bot' as const) : null, repNote: leaderPick ? ((d as any)._repNote ?? null) : d.repNote,
          orig: d.orig ? { ...d.orig, repUserId: picked?.id ?? null } : d.orig };
      });
      if (extra.length) setTeam(prev => [...prev, ...extra.filter(x => !prev.some(p => p.id === x.id))]);
      setDrafts(built);
      for (const d of built) if (!d.repUserId && d.areaName) resolveRep(d.key, d.areaName, d);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!botOrders?.length || !token) return;
    const urls: string[] = [];
    (async () => {
      for (const o of botOrders) {
        const n = o.imageCount ?? 0;
        const got: string[] = [];
        for (let i = 0; i < n; i++) {
          try {
            const res = await fetch(`${API}/api/orders/pending/${o.id}/image/${i}`, { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) continue;
            const blob = await res.blob();
            if (blob.type === 'application/pdf') continue;
            const u = URL.createObjectURL(blob);
            urls.push(u); got.push(u);
          } catch { /* صورة مفقودة لا تُسقط المراجعة */ }
        }
        if (got.length) setBotImages(m => ({ ...m, [o.id]: got }));
      }
    })();
    return () => { urls.forEach(u => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draftsRef = useRef<Draft[]>([]);
  draftsRef.current = drafts;
  /** المنطقة تغيّرت ⇒ نفس قاعدة الخادم: صاحب المنطقة (وتحسمه الايتمات إن تعدّد). */
  const resolveRep = async (key: string, area: string, base?: Draft) => {
    const d = base ?? draftsRef.current.find(x => x.key === key);
    if (!d) return;
    const mkt = repKindRef.current === 'mkt' && !d.bot;
    try {
      const r = await api<{ area: string; rep: Rep | null; repWhy: Draft['repWhy']; repCandidates: Rep[]; repNote: string | null }>('/import/rep-for-area', {
        method: 'POST',
        // «مسوقين»: صاحب المنطقة من مسوقي الفريق بدل العلميين
        body: JSON.stringify({ area, itemIds: d.lines.map(l => l.itemId).filter(Boolean), sender: d.sender, kind: mkt ? 'mkt' : undefined }),
      });
      // تبدّل الزر أثناء الطلب ⇒ النتيجة لنوع قديم، تُهمل
      if ((repKindRef.current === 'mkt') !== mkt) return;
      if (r.rep && !mkt) setTeam(prev => (prev.some(p => p.id === r.rep!.id) ? prev : [...prev, r.rep!]));
      setDrafts(ds => ds.map(x => (x.key !== key ? x : {
        ...x,
        areaName: r.area || area,
        repCandidates: r.repCandidates ?? [],
        repNote: r.repNote,
        // مندوب جديد للمنطقة ⇒ يُختار؛ لا أحد ⇒ يُمسح المختار تلقائياً للمنطقة القديمة، ويبقى ما اختاره المستخدم بيده
        ...(r.rep ? { repUserId: r.rep.id, repName: r.rep.name, repWhy: r.repWhy }
          : x.repWhy ? { repUserId: null, repName: null, repWhy: null } : {}),
      })));
    } catch { /* يبقى الاختيار اليدوي */ }
  };

  const resolveRepRef = useRef(resolveRep);
  resolveRepRef.current = resolveRep;

  // اسم من الخادم ← عضو الفريق (نفس مطابقة فتح طلبيات البوت)؛ اسم خارج الفريق يصير خياراً باسمه
  const teamRef = useRef<Rep[]>([]);
  teamRef.current = team;
  const extraSeq = useRef(0);
  const repFromName = (name: string): Rep => {
    const list = teamRef.current;
    const hit = list.find(u => repKey(u.name) === repKey(name))
      ?? list.find(u => repKey(u.name).startsWith(repKey(name)) || repKey(name).startsWith(repKey(u.name)));
    if (hit) return hit;
    const made = { id: -(100000 + ++extraSeq.current), name: name.split('/')[0].trim() };
    teamRef.current = [...list, made];
    setTeam(prev => (prev.some(p => repKey(p.name) === repKey(made.name)) ? prev : [...prev, made]));
    return made;
  };

  /**
   * طلبية بوت: المنطقة تغيّرت ⇒ تخمين الخادم نفسه (/api/orders/refresh-row) — المندوب
   * وقائمة مندوبي المحافظة الجديدة بشركاتهم. تعذّر ⇒ قاعدة المنطقة العامة.
   */
  const refreshBotRep = async (key: string, area: string) => {
    const d = draftsRef.current.find(x => x.key === key);
    if (!d || !token) return;
    const line = d.lines.find(l => l.itemId) ?? d.lines[0];
    try {
      const res = await fetch(`${API}/api/orders/refresh-row`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ changed: 'area', row: {
          item: line?.itemName ?? '', company: line?.companyName ?? null, quantity: line?.quantity ?? null,
          pharmacy: d.pharmacyName, area, invoiceNumber: d.invoiceNumber ?? null,
        } }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error('refresh');
      const r = j.data as { scientificRep: string | null; repCandidates: { name: string }[]; repOptions: ServerRepOpt[] | null; repPick: string | null; repNote: string | null };
      const opts = r.repOptions ? toRepOpts(r.repOptions, repFromName) : null;
      const cands = (r.repCandidates ?? []).map(c => repFromName(c.name));
      const picked = r.scientificRep ? repFromName(r.scientificRep) : null;
      const leader = r.repPick === 'leader';
      setDrafts(ds => ds.map(x => (x.key !== key ? x : {
        ...x, areaName: area, repOptions: opts, repCandidates: cands,
        ...(picked ? { repUserId: picked.id, repName: picked.name, repWhy: leader ? 'botLeader' as const : 'area' as const, repNote: leader ? r.repNote : null }
          : x.repWhy ? { repUserId: null, repName: null, repWhy: null, repNote: r.repNote } : {}),
      })));
    } catch { resolveRep(key, area); }
  };

  // المندوبون = علميّو فريق صاحب الحساب كما أعادهم الخادم (بلا مسوقين)؛ قائمة الصفحة احتياط فقط
  const repOptions = team.length ? team : reps;
  const allReps = [...repOptions, ...marketers.filter(m => !repOptions.some(r => r.id === m.id))];
  const mktIds = new Set(marketers.map(m => m.id));
  /** المندوب المختار ليس من القائمة الظاهرة للنوع ⇒ يُمسح (لا يُحفظ باسم مخفي). */
  const outOfKind = (id: number | null, kind: RepKind) => id != null && (kind === 'mkt' ? !mktIds.has(id) : kind === 'sci' ? mktIds.has(id) : false);
  const cycleRepKind = () => {
    const next = REP_KIND_NEXT[repKind];
    setRepKindState(next);
    try { localStorage.setItem(REP_KIND_KEY, next); } catch { /* يبقى للجلسة */ }
    const open = (d: Draft) => !(d.state === 'done' || d.state === 'warn' || d.state === 'saving' || d.bot);
    const clear = new Set(draftsRef.current.filter(d => open(d) && outOfKind(d.repUserId, next)).map(d => d.key));
    // صاحب المنطقة يُختار من جديد بالنوع الجديد لما بقي بلا مندوب (مسوق أو علمي)
    const reResolve = draftsRef.current.filter(d => open(d) && d.areaName.trim() && (clear.has(d.key) || !d.repUserId));
    if (clear.size) setDrafts(ds => ds.map(d => (clear.has(d.key) ? { ...d, repUserId: null, repName: null, repWhy: null } : d)));
    repKindRef.current = next;
    reResolve.forEach(d => resolveRep(d.key, d.areaName, { ...d, repUserId: null }));
  };

  const addDrafts = useCallback((incoming: Draft[], t: Rep[]) => {
    if (t?.length) setTeam(prev => [...prev, ...t.filter(x => !prev.some(p => p.id === x.id))]);
    setDrafts(prev => {
      const hashes = new Set(prev.map(d => d.sourceHash).filter(Boolean));
      const next = incoming.map(d => {
        const dupInBatch = d.dupInBatch || Boolean(d.sourceHash && hashes.has(d.sourceHash));
        if (d.sourceHash) hashes.add(d.sourceHash);
        // «مسوقين»: الخادم اختار علمياً عند القراءة ⇒ يُمسح، ثم يُختار المسوق صاحب المنطقة (أدناه)
        const noRep = repKindRef.current === 'mkt' ? { repUserId: null, repName: null, repWhy: null } : {};
        return {
          ...d, ...noRep, mentionedWarehouses: d.mentionedWarehouses ?? [], dupInBatch, include: !dupInBatch && !d.duplicateOf,
          whText: d.whText ?? d.writtenWarehouses?.[0] ?? d.warehouseName ?? '',
        };
      });
      return [...prev, ...next];
    });
    // «مسوقين»: المسوق صاحب منطقة كل طلبية جديدة
    if (repKindRef.current === 'mkt') {
      for (const d of incoming) if (d.areaName?.trim()) resolveRepRef.current(d.key, d.areaName, { ...d, repUserId: null });
    }
  }, []);

  const readText = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setReading(n => n + 1); setErr(null);
    try {
      const r = await api<{ drafts: Draft[]; team: Rep[] }>('/import/text', { method: 'POST', body: JSON.stringify({ blocks: [text] }) });
      if (!r.drafts.length) setErr('لم تُقرأ طلبية من النص');
      addDrafts(r.drafts, r.team);
    } catch (e: any) { setErr(e.message); } finally { setReading(n => n - 1); }
  }, [api, addDrafts]);

  const readImages = useCallback(async (files: File[]) => {
    const imgs = files.filter(f => /^image\//.test(f.type)).slice(0, 8);
    if (!imgs.length) return;
    if (!allowImages) { setErr('قراءة صور الطلبيات مطفأة لحسابك — انسخ نص الرسالة والصقه'); return; }
    setReading(n => n + 1); setErr(null);
    try {
      const fd = new FormData();
      // الحروف الصغيرة في السكرين شوت تحتاج دقة أعلى من صور الفواتير المضغوطة
      for (const [i, f] of imgs.entries()) fd.append('images', await compressImage(f, 2200, 0.85), `shot-${i}.jpg`);
      const r = await api<{ drafts: Draft[]; team: Rep[] }>('/import/screenshot', { method: 'POST', body: fd });
      if (!r.drafts.length) setErr('لم تُقرأ طلبيات من الصورة — تأكّد أن الرسائل ظاهرة وواضحة');
      addDrafts(r.drafts, r.team);
    } catch (e: any) { setErr(e.message); } finally { setReading(n => n - 1); }
  }, [api, addDrafts, allowImages]);

  /** «كتابة يدوية»: بطاقة فارغة بنفس حقول اللصق — المنطقة تختار المندوب، والحفظ بنفس المسار. */
  const manualSeq = useRef(0);
  const addManual = () => {
    setErr(null);
    const key = `m${Date.now()}-${++manualSeq.current}`;
    setDrafts(ds => [{
      key, source: 'manual', sourceText: '', sender: null, mentions: [], readBy: 'manual', manual: true,
      pharmacyName: '', areaName: '', warehouseId: null, warehouseName: '', backupWarehouseIds: [], mentionedWarehouses: [],
      writtenWarehouses: [], whText: '', notes: '',
      lines: [{ itemId: null, itemName: '', writtenAs: '', quantity: 0, bonusQty: 0, matched: false, suggestions: [] }],
      repUserId: null, repName: null, repWhy: null, repNote: null, repCandidates: [], sourceHash: null,
      duplicateOf: null, dupInBatch: false, warnings: [], include: true,
    }, ...ds]);
  };

  // ما وصل بالمشاركة يُقرأ مرة واحدة عند الفتح
  const initDone = useRef(false);
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;
    if (initialText) readText(initialText);
    if (initialImages?.length) readImages(initialImages);
  }, [initialText, initialImages, readText, readImages]);

  // Ctrl+V في أي مكان من اللوحة (عدا حقول التعديل) = لصقة جديدة: صورة أو نص
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      const isCapture = t === captureRef.current;
      if (!isCapture && t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!files.length && !text.trim()) return;
      e.preventDefault();
      // الصور مطفأة والحافظة فيها نص أيضاً ← يُقرأ النص
      if (files.length && (allowImages || !text.trim())) readImages(files);
      else readText(text);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [readImages, readText, allowImages]);

  // زر «لصق» للموبايل: يقرأ الحافظة مباشرةً (صورة أو نص) بلا ضغط مطوّل
  const pasteFromClipboard = async () => {
    setErr(null);
    try {
      if (allowImages && navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        const files: File[] = [];
        for (const it of items) {
          const type = it.types.find(t => t.startsWith('image/'));
          if (type) files.push(new File([await it.getType(type)], 'clip.png', { type }));
        }
        if (files.length) { readImages(files); return; }
      }
      const text = await navigator.clipboard.readText();
      if (text.trim()) readText(text);
      else setErr('الحافظة فارغة — انسخ رسالة الطلبية من الفايبر أولاً');
    } catch {
      setErr('المتصفح منع قراءة الحافظة — اضغط مطوّلاً على خانة «الصق هنا» واختر لصق');
      captureRef.current?.focus();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const patch = (key: string, p: Partial<Draft>) => setDrafts(ds => ds.map(d => (d.key === key ? { ...d, ...p } : d)));
  const patchLine = (key: string, i: number, p: Partial<DraftLine>) =>
    setDrafts(ds => ds.map(d => (d.key === key ? { ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) } : d)));
  const pickItem = (key: string, i: number, it: CatItem) =>
    patchLine(key, i, { itemId: it.id, itemName: it.name, matched: true, companyName: catCompany(it), unitPrice: catPrice(it), editing: false });

  const problemOf = (d: Draft): string | null => {
    if (!d.pharmacyName.trim()) return 'اسم الصيدلية مطلوب';
    // اللكوديشن: المبيع يُحسب للمندوب العلمي، فهو الشرط؛ المذخر اختياري
    // (طلبية البوت بلا مندوب تبقى مقبولة كما كانت بالجدول القديم ← شيت «بلا مندوب»)
    if (mode === 'liq' && !d.bot && !d.repUserId) return repKindRef.current === 'mkt' ? 'اختر المسوق — المبيع يُحسب له' : 'اختر المندوب العلمي — المبيع يُحسب له';
    if (mode === 'wh' && !d.warehouseId && !d.warehouseName.trim()) return 'اختر المذخر';
    if (!d.lines.some(l => l.itemName.trim() && l.quantity > 0)) return 'لا أصناف بكمية';
    const noQty = d.lines.find(l => l.itemName.trim() && !(l.quantity > 0));
    if (noQty) return `أكمل كمية «${noQty.itemName}» أو احذف السطر`;
    return null;
  };

  const sendBot = async (orderId: number, warehouseId: number) => {
    const res = await fetch(`${API}/api/warehouse-dispatch/rep-order/${orderId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ warehouseId }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.success === false) throw new Error(d.error || d.message || 'تعذّر الإرسال');
    if (d.dispatch?.status && d.dispatch.status !== 'sent') throw new Error(d.dispatch?.error || 'لم يُرسل');
  };

  /** صفوف ملف اللكوديشن لطلبية واحدة — بنفس شكل صفوف مراجعة طلبيات البوت (ManualSalesModal). */
  const liqRows = (d: Draft) => {
    const rep = allReps.find(r => r.id === d.repUserId)?.name ?? d.repName ?? '';
    if (d.bot) {
      // طلبية بوت: نفس صفوف الجدول القديم (ManualSalesModal) — مصدرها ورقم BOT-<id> وتاريخ فاتورتها
      return d.lines.filter(l => l.itemName.trim() && l.quantity > 0).map(l => ({
        repName: d.bot!.repAccount || rep, scientificRep: rep || undefined,
        pendingOrderId: d.bot!.orderId,
        source: `${d.bot!.source}-order`,
        invoiceNumber: d.invoiceNumber || `BOT-${d.bot!.orderId}`,
        date: d.date || undefined,
        item: l.itemName.trim(), itemId: l.itemId ?? undefined, company: l.companyName || undefined,
        quantity: l.quantity, bonus: l.bonusQty || undefined, unitPrice: l.unitPrice ?? undefined,
        pharmacy: d.pharmacyName.trim(), area: d.areaName.trim() || undefined,
        warehouse: (d.whText ?? '').trim() || undefined, notes: d.notes.trim() || undefined,
      }));
    }
    // رقم تركيبي يجمع أسطر الطلبية في طلبية واحدة (عدّ الطلبيات). بادئة BOT- عمداً:
    // matchHelpers.realInvoice يعدّها غير حقيقية فلا تُطابَق برقم فاتورة ميركاتو.
    // ولأنها من بصمة الرسالة، إعادة لصق الرسالة نفسها تُسقطها بصمةُ الملف (saleFingerprint).
    const inv = `BOT-VB${String(d.sourceHash || d.key).replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
    return d.lines.filter(l => l.itemName.trim() && l.quantity > 0).map(l => ({
      repName: rep, scientificRep: rep,
      source: 'viber-order', // ضمن CONDITION_SOURCES — يظهر في عرض الملف كأي طلبية فايبر
      invoiceNumber: inv,
      date: dayStr(new Date()),
      item: l.itemName.trim(),
      itemId: l.itemId ?? undefined,
      company: l.companyName || undefined,
      quantity: l.quantity,
      bonus: l.bonusQty || undefined,
      unitPrice: l.unitPrice ?? undefined,
      pharmacy: d.pharmacyName.trim(),
      area: d.areaName.trim() || undefined,
      // المذخر كما كُتب في الرسالة (لا اسم الدليل) — طلب صاحب المشروع 2026-11-18
      warehouse: (d.whText ?? '').trim() || undefined,
      notes: d.notes.trim() || undefined,
    }));
  };

  const authJson = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const salesPost = async <T,>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${API}/api/sales/${path}`, { method: 'POST', headers: authJson, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(j.message || j.error || 'تعذّر الحفظ');
    return j.data as T;
  };

  type DupGroup = { group: string; level: string; reasons?: string[]; match?: DupMatch };
  const dupBody = (list: Draft[]) => ({
    rows: list.flatMap(d => (liqRows(d) as any[]).map(r => ({ ...r, group: d.key }))),
    target: { condition: true, sourceCurrency: 'IQD' },
    // اسم المذخر مكتوب بأشكال: المختلف لا يُسقط الاشتباه بل يجعله «ربما»
    looseWarehouse: true,
    ...(isBot ? {
      pendingOrderIds: [...new Set(list.map(d => d.bot?.orderId).filter(Boolean))],
      receivedAt: list.map(d => d.bot?.createdAt).filter(Boolean).sort()[0],
    } : {}),
  });
  const dupText = (g: DupGroup) => {
    const m = g.match || {};
    const where = m.inBatch ? 'في نفس الدفعة' : m.mercato ? `في ميركاتو «${m.fileName ?? ''}»` : 'في اللكوديشن';
    return `${where}: ${[m.date || (m.savedAt ? String(m.savedAt).slice(0, 10) : ''), m.pharmacy, m.warehouse, m.source].filter(Boolean).join(' · ')}${g.reasons?.length ? ` — ${g.reasons.join('، ')}` : ''}`;
  };

  // فحص التكرار فور ظهور البطاقات في وضع اللكوديشن (لا عند الحفظ فقط) — المكررة بثقة تُلغى من التحديد
  useEffect(() => {
    if (mode !== 'liq') return;
    // اليدوية تُفحص عند الحفظ فقط — أثناء الكتابة بياناتها ناقصة
    const todo = drafts.filter(d => !d.manual && !d.dupChecked && !d.state && d.lines.some(l => l.itemName.trim() && l.quantity > 0));
    if (!todo.length) return;
    const keys = new Set(todo.map(d => d.key));
    setDrafts(ds => ds.map(d => (keys.has(d.key) ? { ...d, dupChecked: true } : d)));
    salesPost<{ groups: DupGroup[] }>('check-duplicates', dupBody(todo)).then(r => {
      const hits = (r?.groups ?? []).filter(g => !g.match?.inBatch);
      if (!hits.length) return;
      setDrafts(ds => ds.map(d => {
        const g = hits.find(h => h.group === d.key);
        if (!g) return d;
        return { ...d, liqDup: { level: g.level, text: dupText(g), match: g.match }, include: g.level !== 'possible' ? false : d.include };
      }));
    }).catch(() => { /* الفحص تنبيه فقط */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, mode]);

  /**
   * ذاكرة التصحيحات لطلبية بوت: كل خانة غيّرها المراجِع عمّا عُرض ← درس (من أول تصحيح)،
   * وتغيير الأسطر/الكميات ← «رسالة صحّحها المراجعون» لإصلاح المحلّل نفسه.
   */
  const learningOf = (batch: Draft[]) => {
    const corrections: any[] = [];
    const reasons = new Set<string>();
    const parsed: any[] = [], saved: any[] = [];
    for (const d of batch) {
      const o = d.orig;
      if (!d.bot || !o) continue;
      const ph = d.pharmacyName.trim(), ar = d.areaName.trim(), wh = (d.whText ?? '').trim();
      if (o.pharmacy && ph && sKey(ph) !== sKey(o.shown.pharmacy)) corrections.push({ field: 'pharmacy', from: o.pharmacy, to: ph });
      if (sKey(ar) !== sKey(o.shown.area)) {
        if (o.area) corrections.push({ field: 'area', from: o.area, to: ar });
        else if (ph && ar) corrections.push({ field: 'pharmacyArea', from: ph, to: ar });
      }
      if (o.warehouse && wh && sKey(wh) !== sKey(o.shown.warehouse)) corrections.push({ field: 'warehouse', from: o.warehouse, to: wh });
      const kept = d.lines.filter(l => l.itemName.trim() && l.quantity > 0);
      // المندوب اختاره المراجِع بيده (repWhy يُمسح عند الاختيار) ← درس لكل صنف في هذه المنطقة
      if (d.repUserId && d.repUserId > 0 && d.repWhy == null && d.repUserId !== o.repUserId) {
        const name = allReps.find(r => r.id === d.repUserId)?.name ?? d.repName ?? '';
        if (name) for (const l of kept) if (l.itemId) corrections.push({ field: 'rep', area: ar, itemId: l.itemId, itemName: l.itemName, to: name, toId: d.repUserId });
      }
      if (kept.some(l => l.origIdx == null)) reasons.add('سطر مضاف');
      const keptIdx = new Set(kept.map(l => l.origIdx).filter(x => x != null));
      if (o.lines.some((ol, i) => ol.itemName.trim() && !keptIdx.has(i))) reasons.add('سطر محذوف');
      for (const l of kept) {
        const ol = l.origIdx != null ? o.lines[l.origIdx] : null;
        if (!ol) continue;
        if (ol.quantity !== l.quantity) reasons.add('كمية');
        if (ol.bonusQty !== l.bonusQty) reasons.add('بونص');
      }
      if (!o.shown.pharmacy.trim() && ph) reasons.add('صيدلية لم تُقرأ');
      parsed.push({ pharmacy: o.shown.pharmacy, area: o.shown.area, warehouse: o.shown.warehouse, lines: o.lines.map(l => ({ item: l.itemName, qty: l.quantity, bonus: l.bonusQty })) });
      saved.push({ pharmacy: ph, area: ar, warehouse: wh, lines: kept.map(l => ({ item: l.itemName, qty: l.quantity, bonus: l.bonusQty, ...(l.origIdx == null ? { added: true } : {}) })) });
    }
    const d0 = batch.find(d => d.bot);
    const caseInfo = reasons.size && d0 ? {
      pendingId: d0.bot!.orderId, source: d0.bot!.source, chatTitle: d0.bot!.chat ?? null, senderName: d0.sender,
      sourceText: d0.sourceText, reasons: [...reasons], parsed, saved,
    } : null;
    return corrections.length || caseInfo ? { corrections, case: caseInfo } : null;
  };

  /** «لكوديشن»: فحص التكرار مع الملف وميركاتو (تنبيه فقط كمراجعة البوت) ثم حفظ كل طلبية وحدها. */
  const createLiq = async (todo: Draft[]) => {
    const target = { condition: true, sourceCurrency: 'IQD' };
    try {
      const dup = await salesPost<{ groups: DupGroup[] }>('check-duplicates', dupBody(todo));
      // «ربما» تُعرض أيضاً (كانت تُهمَل فمرّ تكرار «زينة الحارثية» بلا تنبيه)
      const hits = dup?.groups ?? [];
      if (hits.length) {
        const lines = hits.map(g => `• ${todo.find(d => d.key === g.group)?.pharmacyName ?? ''} — ${g.level === 'possible' ? 'ربما مكررة' : 'مكررة'} ${dupText(g)}`);
        const ok = window.confirm(
          `⚠️ ${hits.length} طلبية تشبه مبيعاً محفوظاً سابقاً — حفظها مرة ثانية يضاعف المبيع:\n${lines.join('\n')}\n\n`
          + 'موافق = احفظ رغم ذلك\nإلغاء = ارجع (ألغِ تحديد المكررة)');
        if (!ok) {
          for (const g of hits) patch(g.group, { state: 'error', result: 'محفوظة سابقاً — ألغِ تحديدها أو احفظ رغم التكرار', liqDup: { level: g.level, text: dupText(g), match: g.match } });
          return;
        }
      }
    } catch { /* تعذّر الفحص لا يمنع الحفظ */ }

    setBusy(true);
    let ok = 0, failed = 0, lines = 0;
    // طلبية البوت تُحفظ كلها (كل بطاقاتها) بطلب واحد: الخادم يحجزها ثم يستهلكها بعد الحفظ،
    // فطلب ثانٍ لنفس الطلبية يُرفض. لصقة الفايبر: كل بطاقة وحدها.
    const batches: Draft[][] = [];
    const byOrder = new Map<number, Draft[]>();
    for (const d of todo) {
      if (!d.bot) { batches.push([d]); continue; }
      if (!byOrder.has(d.bot.orderId)) { byOrder.set(d.bot.orderId, []); batches.push(byOrder.get(d.bot.orderId)!); }
      byOrder.get(d.bot.orderId)!.push(d);
    }
    const savedOrders: number[] = [];
    let fileId: number | undefined;
    for (const batch of batches) {
      for (const d of batch) patch(d.key, { state: 'saving', result: undefined });
      const orderId = batch[0].bot?.orderId;
      // «اموكلافين شراب» اختار له المراجِع صنفاً ⇒ قاعدة توحيد، فتُربط الطلبية القادمة بنفس
      // الكتابة تلقائياً (نفس rememberItems في جدول المراجعة القديم).
      const rememberItems = batch.filter(d => d.bot).flatMap(d => d.lines
        .filter(l => l.itemId && l.quantity > 0 && l.writtenAs.trim() && sKey(l.writtenAs) !== sKey(l.itemName) && l.itemId !== l.origItemId)
        .map(l => ({ from: l.writtenAs.trim(), toItemId: l.itemId as number })));
      try {
        const r = await salesPost<{ addedCount?: number; skippedCount?: number; uploadedFile?: { id: number } }>('manual', {
          rows: batch.flatMap(d => liqRows(d) as any[]), target, ...(orderId ? { pendingOrderIds: [orderId] } : {}),
          ...(rememberItems.length ? { rememberItems } : {}),
        });
        const added = r?.addedCount ?? 0, skipped = r?.skippedCount ?? 0;
        fileId = fileId ?? r?.uploadedFile?.id;
        // ذاكرة التصحيحات: ما غيّره المراجِع يُتعلَّم للطلبيات القادمة (لا يُفشل الحفظ)
        const learn = learningOf(batch);
        if (learn) fetch(`${API}/api/orders/learn`, { method: 'POST', headers: authJson, body: JSON.stringify(learn) }).catch(() => {});
        if (orderId) savedOrders.push(orderId);
        if (!added && skipped) {
          for (const d of batch) patch(d.key, { state: 'warn', result: `موجودة أصلاً في اللكوديشن — لم يُضف شيء (${skipped} سطر)` });
        } else {
          ok += batch.length; lines += added;
          for (const d of batch) {
            const rep = allReps.find(x => x.id === d.repUserId)?.name ?? '';
            patch(d.key, { state: 'done', result: `أُضيفت للكوديشن${rep ? ` باسم ${rep}` : ' (بلا مندوب)'}${batch.length === 1 ? ` — ${added} صنف` : ''}${skipped ? ` (أُسقط ${skipped} مكرر)` : ''}` });
          }
        }
      } catch (e: any) { failed += batch.length; for (const d of batch) patch(d.key, { state: 'error', result: e.message }); }
    }
    setBusy(false);
    // التقارير تخزّن نتائجها في المتصفح — هذا يرميها فيظهر المبيع الجديد
    if (ok) window.dispatchEvent(new CustomEvent('report-data-changed'));
    const summary = `أُضيفت ${ok} طلبية (${lines} صنف) لملف اللكوديشن`;
    // فشل بعضها ⇒ تبقى اللوحة مفتوحة لتصحيحها (done=false) والمحفوظ يُزال من الطابور
    if (isBot) { if (savedOrders.length || !failed) onBotSaved?.(savedOrders, fileId, summary, !failed); }
    else if (!failed && onFinished) onFinished(summary);
  };

  const create = async (send: boolean) => {
    const todo = drafts.filter(d => d.include && d.state !== 'done' && d.state !== 'warn');
    if (!todo.length) return;
    const bad = todo.map(d => [d, problemOf(d)] as const).filter(([, p]) => p);
    if (bad.length) {
      for (const [d, p] of bad) patch(d.key, { state: 'error', result: p! });
      return;
    }
    if (mode === 'liq') { await createLiq(todo); return; }
    setBusy(true);
    let ok = 0, notSent = 0, failed = 0;
    for (const d of todo) {
      patch(d.key, { state: 'saving', result: undefined });
      try {
        const r = await api<{ order: { id: number } }>('', {
          method: 'POST',
          body: JSON.stringify({
            orderDate: dayStr(new Date()),
            warehouseId: d.warehouseId, warehouseName: d.warehouseName,
            backupWarehouseIds: d.backupWarehouseIds,
            pharmacyName: d.pharmacyName.trim(), areaName: d.areaName.trim(), notes: d.notes.trim(),
            lines: d.lines.filter(l => l.itemName.trim() && l.quantity > 0)
              .map(l => ({ itemId: l.itemId, itemName: l.itemName.trim(), quantity: l.quantity, bonusQty: l.bonusQty })),
            repUserId: d.repUserId ?? undefined,
            viaBot: false, // الإرسال أدناه صراحةً لكل طلبية (لا يعتمد على وضع الحساب)
            source: d.source, sourceText: d.sourceText, sourceSender: d.sender, sourceHash: d.sourceHash,
          }),
        });
        const id = r.order.id;
        if (send && d.warehouseId) {
          try { await sendBot(id, d.warehouseId); ok++; patch(d.key, { state: 'done', result: `#${id} أُرسلت لكروب ${d.warehouseName}` }); }
          catch (e: any) { notSent++; patch(d.key, { state: 'warn', result: `#${id} أُنشئت — لم تُرسل: ${e.message}` }); }
        } else if (send) {
          notSent++; patch(d.key, { state: 'warn', result: `#${id} أُنشئت — المذخر غير مسجّل، أرسلها يدوياً` });
        } else {
          ok++; patch(d.key, { state: 'done', result: `#${id} أُنشئت` });
        }
      } catch (e: any) { failed++; patch(d.key, { state: 'error', result: e.message }); }
    }
    setBusy(false);
    onChanged();
    // بلا أخطاء ← تُغلق اللوحة (طلب صاحب المشروع)؛ فشل إنشاء ← تبقى مفتوحة ليُصحَّح
    if (!failed && onFinished) {
      const parts = [send ? `أُرسلت ${ok} طلبية للمذاخر` : `أُنشئت ${ok} طلبية`];
      if (notSent) parts.push(`${notSent} أُنشئت ولم تُرسل — أرسلها من القائمة`);
      onFinished(parts.join(' · '));
    }
  };

  /**
   * 🗑 على بطاقة: لصقة الفايبر تُزال من الشاشة فقط. طلبية البوت كانت تُزال من الشاشة
   * فقط أيضاً فتبقى في الطابور، وآخر بطاقة تترك اللوحة على «تجهيز الطلبيات…» للأبد
   * (2026-11-24). الآن: آخر بطاقة للطلبية ⇒ تُحذف الطلبية من الطابور، وآخر بطاقة في
   * اللوحة ⇒ تُغلق اللوحة.
   */
  const removeDraft = async (d: Draft) => {
    const lastOfOrder = d.bot && !drafts.some(x => x.key !== d.key && x.bot?.orderId === d.bot!.orderId);
    if (lastOfOrder && onBotCancel) {
      if (!window.confirm('حذف هذه الطلبية نهائياً من طلبيات البوت؟ لن تُحفظ في اللكوديشن.')) return;
      setBusy(true);
      try { await onBotCancel([d.bot!.orderId]); }
      catch (e: any) { patch(d.key, { state: 'error', result: e?.message || 'تعذّر حذف الطلبية' }); return; }
      finally { setBusy(false); }
    }
    const rest = drafts.filter(x => x.key !== d.key);
    setDrafts(rest);
    if (isBot && !rest.length) onClose();
  };

  const pending = drafts.filter(d => d.include && d.state !== 'done' && d.state !== 'warn');
  const finished = drafts.filter(d => d.state === 'done' || d.state === 'warn');
  const compactDrop = IS_TOUCH || drafts.length > 0;
  const whName = (id: number) => warehouses.find(w => w.id === id)?.name ?? `#${id}`;

  return (
    <div className="ro-modal vi-modal" onClick={() => !busy && onClose()}>
      <div className="ro-dialog vi-dialog" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head vi-head">
          <strong>{isBot ? `📋 مراجعة طلبيات البوت (${botOrders!.length})` : '📥 طلبيات الفايبر / واتساب'}</strong>
          {reading > 0 && <span className="vi-reading"><i /> جارٍ القراءة{reading > 1 ? ` (${reading})` : ''}</span>}
          <span className="ro-spacer" />
          {isBot && onLegacy && <button className="vi-btn vi-btn--ghost" disabled={busy} onClick={onLegacy} title="نفس الطلبيات بجدول المراجعة القديم">الجدول</button>}
          {!isBot && <div className="vi-mode" role="radiogroup" aria-label="وجهة الطلبيات">
            {([['liq', 'لكوديشن'], ['wh', 'مذاخر']] as const).filter(([m]) => modes.includes(m)).map(([m, t]) => (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'is-on' : ''} disabled={busy}
                title={m === 'liq' ? 'تُحفظ مبيعاً في ملف اللكوديشن وتُحسب للمندوب' : 'تُنشأ طلبية مذخر في «طلبيات المذاخر» للإرسال'}
                onClick={() => {
                  setMode(m);
                  // أخطاء التحقق تخص الوضع السابق (المذخر/المندوب) — تُعاد عند الحفظ
                  setDrafts(ds => ds.map(d => (d.state === 'error' ? { ...d, state: undefined, result: undefined } : d)));
                }}>{t}</button>
            ))}
          </div>}
          <button className="ro-icon-btn" disabled={busy} onClick={onClose}><X size={15} /></button>
        </div>

        <div className="ro-dialog__body vi-body">
          {!isBot && <div className={`vi-drop ${compactDrop ? 'is-compact' : ''} ${dragOver ? 'is-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); if (allowImages) readImages([...e.dataTransfer.files]); }}>
            {!compactDrop && (
              <>
                <div className="vi-drop__title">انسخ رسالة من الفايبر ثم <kbd>Ctrl</kbd>+<kbd>V</kbd> هنا — كل لصقة تصير طلبية</div>
                {allowImages && <div className="vi-drop__sub">أو سكرين شوت لعدة طلبيات: <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> ثم <kbd>Ctrl</kbd>+<kbd>V</kbd> · أو اسحب الصور هنا</div>}
              </>
            )}
            <div className="vi-drop__row">
              <textarea ref={captureRef} className="form-input vi-capture" rows={1} placeholder="الصق هنا…" value="" onChange={() => {}} />
              <button className="vi-btn" onClick={pasteFromClipboard} title="لصق من الحافظة"><ClipboardPaste size={14} /> لصق</button>
              <button className="vi-btn" onClick={addManual} title="إدخال طلبية بالكتابة بنفس الحقول"><Pencil size={14} /> كتابة يدوية</button>
              {allowImages && <>
                <button className="vi-btn" onClick={() => fileRef.current?.click()} title="سكرين شوت"><ImageIcon size={14} /> صور</button>
                <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => { readImages([...(e.target.files ?? [])]); e.target.value = ''; }} />
              </>}
            </div>
          </div>}
          {isBot && !drafts.length && <div className="vi-reading"><i /> تجهيز الطلبيات…</div>}

          {err && <div className="vi-err">⚠️ {err}</div>}

          {drafts.map((d, di) => {
            const locked = d.state === 'done' || d.state === 'warn' || d.state === 'saving';
            const extraWh = warehouses.filter(w => !d.mentionedWarehouses.some(m => m.id === w.id));
            const candIds = new Set(d.repCandidates.map(c => c.id));
            const repList = [...repOptions.filter(r => candIds.has(r.id)), ...repOptions.filter(r => !candIds.has(r.id))];
            // طلبية البوت: مندوبو محافظتها فقط (★ صاحب الصنف والمنطقة أولاً) مع الشركة؛ المختار
            // من خارجها (اسم المرسل/اختيار سابق) يبقى ظاهراً كي لا يُمسح
            const provOpts: RepOpt[] | null = d.bot && d.repOptions?.length
              ? [
                  ...(d.repUserId != null && !d.repOptions.some(o => o.id === d.repUserId)
                    ? [{ id: d.repUserId, name: d.repName || repOptions.find(r => r.id === d.repUserId)?.name || '—', company: null, star: false }]
                    : []),
                  ...[...d.repOptions.filter(o => o.star || candIds.has(o.id)), ...d.repOptions.filter(o => !(o.star || candIds.has(o.id)))],
                ]
              : null;
            // زر النوع: لصق/كتابة فقط (لا مراجعة البوت) وحين يكون للفريق مسوقون
            const kindOn = !d.bot && marketers.length > 0;
            const kind: RepKind = kindOn ? repKind : 'auto';
            const repHint = [d.repWhy ? REP_WHY[d.repWhy] : d.repUserId ? '' : (d.repNote ?? ''), d.repWhy === 'botLeader' ? (d.repNote ?? '') : '', d.sender ?? ''].filter(Boolean).join(' · ');
            return (
              <div key={d.key} className={`vi-card ${!d.include ? 'is-off' : ''} ${d.state ? `is-${d.state}` : ''}`}>
                <div className="vi-card__head">
                  <label className="vi-include" title="تضمين في الإنشاء">
                    <input type="checkbox" checked={d.include} disabled={locked} onChange={e => patch(d.key, { include: e.target.checked })} />
                    <b>طلبية {di + 1}</b>
                  </label>
                  {d.duplicateOf && <span className="vi-badge vi-badge--dup">⚠️ مكررة مع #{d.duplicateOf.id}</span>}
                  {d.dupInBatch && !d.duplicateOf && <span className="vi-badge vi-badge--dup">⚠️ مكررة في الدفعة</span>}
                  {d.readBy === 'ai' && <span className="vi-badge">🤖 قُرئت بالذكاء — راجعها</span>}
                  {d.manual && <span className="vi-badge">✍️ يدوية</span>}
                  {mode === 'liq' && d.liqDup && (
                    <span className="vi-badge vi-badge--dup" title={d.liqDup.text}>⚠️ {d.liqDup.level === 'possible' ? 'ربما مكررة' : 'مكررة'} باللكوديشن</span>
                  )}
                  <span className="ro-spacer" />
                  {!locked && <button className="vi-x" title={d.bot ? 'حذف الطلبية من الطابور' : 'حذف'} disabled={busy} onClick={() => removeDraft(d)}><Trash2 size={14} /></button>}
                </div>

                <div className="vi-card__body">
                  {/* نص الرسالة الأصلي ظاهر دائماً للمقارنة (البطاقة اليدوية بلا رسالة) */}
                  {/* الرسالة كاملة دائماً بلا طيّ، والرأس = المرسل فقط + اسم الكروب كاملاً (طلب صاحب المشروع 2026-11-24) */}
                  {!d.manual && <div className="vi-src">
                    <div className="vi-src__head"><MessageSquareText size={12} /> {d.sender || 'الرسالة'}
                      {d.bot?.chat && <span className="vi-src__chat" title={`الكروب: ${d.bot.chat}`}>{d.bot.chat}</span>}
                    </div>
                    {d.bot && (botImages[d.bot.orderId]?.length ?? 0) > 0 && (
                      <div className="vi-thumbs">
                        {botImages[d.bot.orderId].map((u, i) => (
                          <img key={i} src={u} alt="صورة الطلبية" onClick={e => { e.stopPropagation(); setZoom(u); }} />
                        ))}
                      </div>
                    )}
                    {d.sourceText ? <pre dir="auto">{d.sourceText}</pre> : !d.bot ? null : <pre className="vi-src__none">صورة بلا نص</pre>}
                  </div>}

                  <div className="vi-form">
                    <div className="vi-fields">
                      <label className="vi-f vi-f--ph"><span>الصيدلية</span>
                        <span className="vi-memwrap">
                          <input className="form-input" value={d.pharmacyName} disabled={locked} placeholder="اسم الصيدلية *" autoFocus={d.manual && !d.pharmacyName} onChange={e => patch(d.key, { pharmacyName: e.target.value })} />
                          {memBadge(d.learned?.pharmacy, d.pharmacyName, d.orig?.shown.pharmacy, d.orig?.pharmacy)}
                        </span>
                      </label>
                      <label className="vi-f"><span>المنطقة</span>
                        <span className="vi-memwrap">
                          <AreaSearch areas={areaOpts} value={d.areaName} disabled={locked}
                            onText={v => patch(d.key, { areaName: v })} onCommit={a => (d.bot ? refreshBotRep(d.key, a) : resolveRep(d.key, a))} />
                          {memBadge(d.learned?.area, d.areaName, d.orig?.shown.area, d.orig?.area)}
                        </span>
                      </label>
                      {/* div لا label: الضغط على عنوان الحقل كان سيضغط زر النوع */}
                      <div className="vi-f"><span className="vi-f__h">{kindOn ? (kind === 'mkt' ? 'المسوق' : 'المندوب') : 'المندوب العلمي'}
                        {kindOn && (
                          <button type="button" className={`vi-kind is-${kind}`} disabled={locked} onClick={cycleRepKind}
                            title={`القائمة الآن: ${REP_KIND_LABEL[kind]} — اضغط للتبديل (تلقائي ← مسوقين ← علميين). يبقى اختيارك محفوظاً`}>
                            {REP_KIND_LABEL[kind]}
                          </button>
                        )}
                      </span>
                        <select className="form-input" value={d.repUserId ?? ''} disabled={locked}
                          onChange={e => patch(d.key, { repUserId: e.target.value ? Number(e.target.value) : null, repWhy: null })}>
                          <option value="">{kind === 'mkt' ? '— اختر المسوق —' : '— المندوب العلمي —'}</option>
                          {kind !== 'mkt' && provOpts && provOpts.map(r => (
                            <option key={r.id} value={r.id}>{r.star || candIds.has(r.id) ? '★ ' : ''}{r.name}{r.company ? ` — ${r.company}` : ''}</option>
                          ))}
                          {kind !== 'mkt' && !provOpts && repList.map(r => <option key={r.id} value={r.id}>{candIds.has(r.id) ? '★ ' : ''}{r.name}</option>)}
                          {kind === 'mkt' && [...marketers.filter(r => candIds.has(r.id)), ...marketers.filter(r => !candIds.has(r.id))]
                            .map(r => <option key={r.id} value={r.id}>{candIds.has(r.id) ? '★ ' : ''}{r.name}</option>)}
                          {kind === 'auto' && kindOn && (
                            <optgroup label="مسوقين">
                              {marketers.filter(m => !repList.some(r => r.id === m.id)).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </optgroup>
                          )}
                        </select>
                        {repHint && <small className="vi-hint">{repHint}</small>}
                      </div>
                    </div>

                    {/* اللكوديشن: المذخر نصّاً كما كُتب في الرسالة (الاختيار من الدليل في وضع «مذاخر» فقط) */}
                    {mode === 'liq' && (
                      <div className="vi-sec">
                        <div className="vi-sec__h">المذخر <small>كما في الرسالة</small></div>
                        <span className="vi-memwrap">
                          <input className="form-input" value={d.whText ?? ''} disabled={locked} placeholder="اسم المذخر (اختياري)"
                            onChange={e => patch(d.key, { whText: e.target.value })} />
                          {memBadge(d.learned?.warehouse, d.whText ?? '', d.orig?.shown.warehouse, d.orig?.warehouse)}
                        </span>
                        {(d.writtenWarehouses?.length ?? 0) > 1 && (
                          <div className="vi-chips">
                            {d.writtenWarehouses!.map(w => (
                              <button key={w} type="button" disabled={locked} className={`vi-chip ${w === d.whText ? 'is-on' : ''}`} onClick={() => patch(d.key, { whText: w })}>{w}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* المذاخر: كل ما ذُكر في الرسالة بترتيبه — الضغط يختار من تذهب له الطلبية */}
                    {mode === 'wh' && <div className="vi-sec">
                      <div className="vi-sec__h">المذخر</div>
                      <div className="vi-whlist">
                        {d.mentionedWarehouses.map((m, i) => {
                          const isPrimary = m.id ? m.id === d.warehouseId : !d.warehouseId && m.name === d.warehouseName;
                          const isBackup = !isPrimary && m.id != null && d.backupWarehouseIds.includes(m.id);
                          return (
                            <div key={`${m.id ?? m.name}-${i}`} className={`vi-whrow ${isPrimary ? 'is-primary' : isBackup ? 'is-backup' : 'is-off'}`}>
                              <button className="vi-whrow__pick" disabled={locked} onClick={() => patch(d.key, choosePrimary(d, m))}>
                                <span className="vi-radio">{isPrimary && <Check size={11} />}</span>
                                <span className="vi-whrow__name">{m.name}</span>
                                {!m.id && <small className="vi-tag vi-tag--warn">غير مسجّل</small>}
                                {m.id && m.ready === false && <small className="vi-tag">يدوي</small>}
                              </button>
                              <span className="vi-whrow__state">{isPrimary ? 'تذهب له' : isBackup ? 'احتياط' : 'مستبعد'}</span>
                              {!locked && mode === 'wh' && isBackup && (
                                <button className="vi-x" title="استبعاد من الاحتياط"
                                  onClick={() => patch(d.key, { backupWarehouseIds: d.backupWarehouseIds.filter(x => x !== m.id) })}><X size={12} /></button>
                              )}
                              {!locked && mode === 'wh' && !isPrimary && !isBackup && m.id != null && (
                                <button className="vi-x" title="إرجاع كاحتياط"
                                  onClick={() => patch(d.key, { backupWarehouseIds: d.mentionedWarehouses.filter(x => x.id && (x.id === m.id || d.backupWarehouseIds.includes(x.id)) && x.id !== d.warehouseId).map(x => x.id as number) })}><Plus size={12} /></button>
                              )}
                            </div>
                          );
                        })}
                        {!locked && extraWh.length > 0 && (
                          <WarehouseSearch warehouses={extraWh} placeholder={d.mentionedWarehouses.length ? '+ مذخر آخر — اكتب الاسم' : 'اكتب اسم المذخر'}
                            onPick={w => {
                              const m: MentionedWh = { id: w.id, name: w.name };
                              const next = { ...d, mentionedWarehouses: [...d.mentionedWarehouses, m] };
                              patch(d.key, { mentionedWarehouses: next.mentionedWarehouses, ...choosePrimary(next, m) });
                            }} />
                        )}
                        {mode === 'wh' && d.backupWarehouseIds.some(id => !d.mentionedWarehouses.some(m => m.id === id)) && (
                          <div className="vi-hint">احتياط أيضاً: {d.backupWarehouseIds.filter(id => !d.mentionedWarehouses.some(m => m.id === id)).map(whName).join('، ')}</div>
                        )}
                      </div>
                    </div>}

                    {/* الأصناف */}
                    <div className="vi-sec">
                      <div className="vi-sec__h">
                        الأصناف
                        <span className="ro-spacer" />
                        {!locked && (
                          <button className="vi-btn vi-btn--ghost" onClick={() => patch(d.key, { lines: [...d.lines, { itemId: null, itemName: '', writtenAs: '', quantity: 0, bonusQty: 0, matched: false, suggestions: [], editing: true }] })}>
                            <Plus size={13} /> صنف
                          </button>
                        )}
                      </div>
                      <div className="vi-lines">
                        <div className="vi-line vi-line--head"><span>الصنف</span><span>الكمية</span><span /><span>بونص</span><span /></div>
                        {d.lines.map((l, i) => {
                          const meta = [l.companyName, fmtPrice(l.unitPrice)].filter(Boolean).join(' · ');

                          return (
                            <div key={i} className={`vi-line ${l.itemId && !l.editing ? 'is-matched' : 'is-free'}`}>
                              {l.itemId && !l.editing ? (
                                <div className="vi-line__item">
                                  <button className="vi-line__name" disabled={locked} title="تغيير الصنف" onClick={() => patchLine(d.key, i, { editing: true })}>
                                    <Check size={12} /> {l.itemName}
                                    {l.memory && l.itemId === l.origItemId && <span className="vi-mem-inline" title={`🧠 من تصحيح سابق — كُتب «${l.writtenAs}»`}>🧠</span>}
                                  </button>
                                  {meta && <small className="vi-line__meta">{meta}</small>}
                                  {!locked && <button className="vi-x vi-line__edit" title="تغيير الصنف" onClick={() => patchLine(d.key, i, { editing: true })}><Pencil size={11} /></button>}
                                </div>
                              ) : locked ? (
                                <span className="vi-line__name is-free">{l.itemName}</span>
                              ) : (
                                <ItemSearch catalog={catalog} value={l.itemName} autoFocus={l.editing}
                                  onText={v => patchLine(d.key, i, { itemName: v, itemId: null, matched: false, companyName: null, unitPrice: null })}
                                  onPick={it => pickItem(d.key, i, it)} />
                              )}
                              <input className="form-input vi-num" type="number" min={1} inputMode="numeric" disabled={locked} value={l.quantity || ''} placeholder="0"
                                onChange={e => patchLine(d.key, i, { quantity: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                              <span className="vi-plus">+</span>
                              <input className="form-input vi-num" type="number" min={0} inputMode="numeric" disabled={locked} value={l.bonusQty || ''} placeholder="0"
                                onChange={e => patchLine(d.key, i, { bonusQty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                              {!locked
                                ? <button className="vi-x" tabIndex={-1} title="حذف السطر" onClick={() => patch(d.key, { lines: d.lines.filter((_, j) => j !== i) })}><X size={12} /></button>
                                : <span />}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <label className="vi-f"><span>{mode === 'liq' ? 'ملاحظات' : 'ملاحظات للمذخر'}</span>
                      <span className="vi-clearable">
                        <input className="form-input" value={d.notes} disabled={locked} placeholder="ملاحظات" onChange={e => patch(d.key, { notes: e.target.value })} />
                        {!locked && d.notes && (
                          <button type="button" className="vi-x vi-clearable__x" title="مسح الملاحظات"
                            onClick={e => { e.preventDefault(); patch(d.key, { notes: '' }); }}><X size={14} /></button>
                        )}
                      </span>
                    </label>

                    {mode === 'liq' && d.liqDup && !locked && (
                      <div className="vi-warn vi-warn--dup">⚠️ {d.liqDup.level === 'possible' ? 'ربما محفوظة سابقاً' : 'محفوظة سابقاً'} {d.liqDup.text}{d.liqDup.level !== 'possible' ? ' — أُلغي تحديدها؛ حدّدها إن كانت طلبية جديدة' : ''}</div>
                    )}
                    {mode === 'liq' && d.liqDup?.match && !d.liqDup.match.inBatch && !locked && <DupMatchStrip m={d.liqDup.match} />}
                    {d.warnings.length > 0 && !locked && <div className="vi-warn">⚠️ {d.warnings.join(' · ')}</div>}
                    {d.result && (
                      <div className={`vi-result vi-result--${d.state}`}>
                        {d.state === 'error' ? `⚠️ ${d.result}` : d.state === 'done' ? `✅ ${d.result}` : d.state === 'warn' ? `🟡 ${d.result}` : d.result}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {zoom && createPortal(
          <div className="vi-zoom" onClick={() => setZoom(null)}><img src={zoom} alt="" /></div>, document.body)}

        <div className="ro-dialog__foot vi-foot">
          {mode === 'liq' && (
            <button className="vi-btn vi-btn--primary" disabled={busy || !pending.length} onClick={() => create(false)}>
              <Check size={14} /> {busy ? 'جارٍ…' : `حفظ في اللكوديشن${pending.length ? ` (${pending.length})` : ''}`}
            </button>
          )}
          {mode === 'wh' && canSend && (
            <button className="vi-btn vi-btn--primary" disabled={busy || !pending.length} onClick={() => create(true)}>
              <Send size={14} /> {busy ? 'جارٍ…' : `إنشاء وإرسال${pending.length ? ` (${pending.length})` : ''}`}
            </button>
          )}
          {mode === 'wh' && (
            <button className={`vi-btn ${canSend ? '' : 'vi-btn--primary'}`} disabled={busy || !pending.length} onClick={() => create(false)}>
              {canSend ? 'إنشاء فقط' : `إنشاء${pending.length ? ` (${pending.length})` : ''}`}
            </button>
          )}
          {finished.length > 0 && !busy && (
            <button className="vi-btn vi-btn--ghost" onClick={() => setDrafts(ds => ds.filter(d => d.state !== 'done' && d.state !== 'warn'))}>مسح المنجزة ({finished.length})</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── الرجوع للفايبر: صور الفواتير ────────────────────────────────────────────
// (زر «نسخ الرد» النصّي أُلغي بطلب صاحب المشروع 2026-11-13 — الفاتورة نفسها هي الرد)

interface FbSend { outcome: 'sent' | 'prepared' | 'partial' | 'rejected'; outcomeAt: string | null; image: string | null }
export interface FbOrder {
  id: number; pharmacyName: string; areaName: string | null; status: 'pending' | 'prepared' | 'cancelled';
  preparedImage: string | null; preparedAt: string | null;
  sends: FbSend[]; source?: string | null; feedbackCopiedAt?: string | null;
  repName?: string; createdById?: number;
}

/** صورة الفاتورة الأحدث: صورة التجهيز، وإلا آخر صورة رد من مذخر (PDF لا يُنسخ). */
const invoiceImageOf = (o: FbOrder) =>
  [o.preparedImage, ...[...o.sends].reverse().map(s => s.image)].find(p => p && !/\.pdf$/i.test(p)) || null;

/** آخر تغيّر في نتيجة الطلبية (رد مذخر، تجهيز) — للمقارنة مع وقت إرسال الفاتورة. */
const lastOutcomeAt = (o: FbOrder) => {
  const ts = [o.preparedAt, ...o.sends.filter(s => s.outcome !== 'sent').map(s => s.outcomeAt)].filter(Boolean).map(t => new Date(t!).getTime());
  return ts.length ? Math.max(...ts) : 0;
};

/** طلبية من الفايبر لها فاتورة لم تُرسل للفايبر بعد (أو جاءت فاتورة أحدث بعد الإرسال). */
export const needsViberReply = (o: FbOrder) => {
  if (!o.source?.startsWith('viber') || !invoiceImageOf(o)) return false;
  return !o.feedbackCopiedAt || new Date(o.feedbackCopiedAt).getTime() < lastOutcomeAt(o);
};

const markCopied = (token: string | null, ids: number[]) => Promise.all(ids.map(id =>
  fetch(`${API}/api/rep-orders/${id}/feedback-copied`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => null)));

const loadBlob = async (url: string) => {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error('تعذّر تحميل صورة الفاتورة');
  return res.blob();
};

const label = (o: FbOrder) => `#${o.id} — ${o.pharmacyName}${o.areaName ? ` (${o.areaName})` : ''}`;

/**
 * فواتير عدة طلبيات في صورة واحدة: عمودان، وفوق كل فاتورة شريط باسم الصيدلية ورقم
 * الطلبية، وعنوان اختياري أعلى الصورة (اسم المندوب). الارتفاع محدود لحدّ الـcanvas.
 */
async function mergeInvoices(items: { label: string; bmp: ImageBitmap }[], title?: string): Promise<Blob> {
  const cols = items.length > 1 ? 2 : 1;
  const tileW = cols === 1 ? 1100 : 900;
  const gap = 16, bar = 44, head = title ? 64 : 0;
  const tiles = items.map(it => ({ ...it, h: Math.round(it.bmp.height * (tileW / it.bmp.width)) }));
  const rows: (typeof tiles)[] = [];
  for (let i = 0; i < tiles.length; i += cols) rows.push(tiles.slice(i, i + cols));
  const rowH = rows.map(r => Math.max(...r.map(t => t.h)) + bar);
  const rawW = cols * tileW + (cols + 1) * gap;
  const rawH = rowH.reduce((a, b) => a + b + gap, gap + head);
  const scale = rawH > 16000 ? 16000 / rawH : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(rawW * scale); c.height = Math.round(rawH * scale);
  const g = c.getContext('2d')!;
  g.scale(scale, scale);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, rawW, rawH);
  g.textAlign = 'right'; g.direction = 'rtl';
  if (title) {
    g.fillStyle = '#7360f2'; g.fillRect(0, 0, rawW, head);
    g.fillStyle = '#ffffff'; g.font = 'bold 32px Tajawal, "Segoe UI", sans-serif';
    g.fillText(title, rawW - gap - 6, 43, rawW - gap * 2);
  }
  let y = gap + head;
  rows.forEach((r, ri) => {
    r.forEach((t, ci) => {
      // RTL: الأولى يميناً
      const x = cols === 1 ? gap : (ci === 0 ? gap * 2 + tileW : gap);
      g.fillStyle = '#1e293b'; g.fillRect(x, y, tileW, bar);
      g.fillStyle = '#ffffff'; g.font = 'bold 24px Tajawal, "Segoe UI", sans-serif';
      g.fillText(t.label, x + tileW - 14, y + 31, tileW - 28);
      g.drawImage(t.bmp, x, y + bar, tileW, t.h);
    });
    y += rowH[ri] + gap;
  });
  return new Promise((ok, bad) => c.toBlob(b => (b ? ok(b) : bad(new Error('تعذّر تكوين الصورة'))), 'image/png'));
}

/** فاتورة طلبية واحدة للفايبر — زر تفاصيل الطلبية. */
async function sendInvoices(list: FbOrder[], token: string | null): Promise<string | null> {
  const ids = list.map(o => o.id);
  if (IS_TOUCH && typeof navigator.share === 'function') {
    const files = (await Promise.all(list.map(async o => {
      try {
        const b = await loadBlob(`${API}${invoiceImageOf(o)}`);
        return new File([b], `${o.id}-${o.pharmacyName}.${b.type === 'image/png' ? 'png' : 'jpg'}`, { type: b.type || 'image/jpeg' });
      } catch { return null; }
    }))).filter(Boolean) as File[];
    if (files.length && navigator.canShare?.({ files })) {
      try { await navigator.share({ files }); }
      catch (e: any) { if (e?.name === 'AbortError') return null; throw e; }
      await markCopied(token, ids);
      return `أُرسلت ${files.length} فاتورة`;
    }
  }
  const merged = (async () => {
    const items = (await Promise.all(list.map(async o => {
      try { return { label: label(o), bmp: await createImageBitmap(await loadBlob(`${API}${invoiceImageOf(o)}`)) }; } catch { return null; }
    }))).filter(Boolean) as { label: string; bmp: ImageBitmap }[];
    if (!items.length) throw new Error('تعذّر تحميل الفواتير');
    return mergeInvoices(items);
  })();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': merged })]);
  await markCopied(token, ids);
  return 'نُسخت الفاتورة — Ctrl+V في كروب الفايبر';
}

// ─── «فواتير الفايبر»: نافذة وسط الشاشة بثلاثة خيارات، والضغط على أيّها يرسل فوراً ───
//   all      — صورة واحدة تجمع كل الفواتير
//   rep      — صورة لكل مندوب تجمع فواتير طلبياته (بعنوان اسمه)
//   separate — كل فاتورة صورة مستقلة (الموبايل فقط: الحافظة لا تحمل أكثر من صورة)
// الأشكال الثلاثة تُجهَّز مسبقاً عند فتح النافذة: مشاركة الموبايل تشترط أن تأتي بعد
// الضغطة مباشرة، وتنزيل الفواتير وتجميعها قد يتجاوز تلك المهلة.

type InvMode = 'all' | 'rep' | 'separate';
interface InvPack { key: string; title: string; ids: number[]; file: File }
type InvPacks = Record<InvMode, InvPack[]>;

async function buildAllPacks(list: FbOrder[]): Promise<InvPacks> {
  const loaded = (await Promise.all(list.map(async o => {
    try {
      const blob = await loadBlob(`${API}${invoiceImageOf(o)}`);
      return { o, blob, bmp: await createImageBitmap(blob) };
    } catch { return null; }
  }))).filter(Boolean) as { o: FbOrder; blob: Blob; bmp: ImageBitmap }[];
  if (!loaded.length) throw new Error('تعذّر تحميل الفواتير');
  const stamp = new Date().toISOString().slice(0, 10);
  const asFile = (b: Blob, name: string) => new File([b], name, { type: b.type || 'image/png' });

  const separate = loaded.map(({ o, blob }) => ({
    key: `o${o.id}`, title: label(o), ids: [o.id],
    file: asFile(blob, `${o.id}-${o.pharmacyName}.${blob.type === 'image/png' ? 'png' : 'jpg'}`),
  }));
  const allBlob = await mergeInvoices(loaded.map(x => ({ label: label(x.o), bmp: x.bmp })));
  const all = [{ key: 'all', title: `كل الفواتير (${loaded.length})`, ids: loaded.map(x => x.o.id), file: asFile(allBlob, `فواتير-${stamp}.png`) }];

  const byRep = new Map<string, typeof loaded>();
  for (const x of loaded) {
    const k = String(x.o.createdById ?? x.o.repName ?? '—');
    if (!byRep.has(k)) byRep.set(k, []);
    byRep.get(k)!.push(x);
  }
  const rep: InvPack[] = [];
  for (const [k, xs] of byRep) {
    const name = xs[0].o.repName || '—';
    const blob = await mergeInvoices(xs.map(x => ({ label: label(x.o), bmp: x.bmp })), `${name} — ${xs.length} فاتورة`);
    rep.push({ key: `r${k}`, title: name, ids: xs.map(x => x.o.id), file: asFile(blob, `فواتير-${name}-${stamp}.png`) });
  }
  rep.sort((a, b) => a.title.localeCompare(b.title, 'ar'));
  return { all, rep, separate };
}

export function ViberInvoicesButton({ orders, token, onDone }: { orders: FbOrder[]; token: string | null; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<InvPacks | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [repList, setRepList] = useState(false); // الكمبيوتر: نسخ مندوب مندوب
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const list = orders.filter(needsViberReply);
  const listKey = list.map(o => `${o.id}:${invoiceImageOf(o)}`).join(',');
  const canShare = IS_TOUCH && typeof navigator.share === 'function';

  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 6000); return () => clearTimeout(t); }, [msg]);

  useEffect(() => {
    if (!open || !list.length) return;
    let alive = true;
    setPacks(null); setSent(new Set()); setRepList(false); setPreparing(true);
    buildAllPacks(list)
      .then(p => { if (alive) setPacks(p); })
      .catch(e => { if (alive) { setMsg(e.message); setOpen(false); } })
      .finally(() => { if (alive) setPreparing(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!list.length && !msg) return null;

  const finish = async (ps: InvPack[]) => {
    await markCopied(token, ps.flatMap(p => p.ids));
    setSent(s => new Set([...s, ...ps.map(p => p.key)]));
    onDone?.();
  };

  /** الموبايل: مشاركة الصور الجاهزة. الكمبيوتر: نسخ صورة واحدة للحافظة. */
  const deliver = async (ps: InvPack[], closeAfter = true) => {
    try {
      if (canShare) {
        const files = ps.map(p => p.file);
        if (!navigator.canShare?.({ files })) throw new Error('المشاركة غير مدعومة لهذه الصور');
        try { await navigator.share({ files }); }
        catch (e: any) { if (e?.name === 'AbortError') return; throw e; }
        await finish(ps);
        setMsg(ps.length > 1 ? `أُرسلت ${ps.length} صور` : 'أُرسلت');
      } else {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': ps[0].file })]);
        await finish([ps[0]]);
        setMsg(`نُسخت «${ps[0].title}» — Ctrl+V في كروب الفايبر`);
      }
      if (closeAfter) setOpen(false);
    } catch (e: any) { setMsg(e?.message || 'تعذّر النسخ في هذا المتصفح'); }
  };

  const pick = (mode: InvMode) => {
    if (!packs) return;
    const ps = packs[mode];
    // الكمبيوتر: الحافظة تحمل صورة واحدة ← أكثر من مندوب يُنسخ واحداً واحداً من قائمة
    if (!canShare && ps.length > 1) { setRepList(true); return; }
    deliver(ps);
  };

  const repCount = packs?.rep.length ?? new Set(list.map(o => o.createdById ?? o.repName)).size;
  const options: { mode: InvMode; icon: typeof Images; title: string; sub: string }[] = [
    { mode: 'all', icon: LayoutGrid, title: 'صورة واحدة للكل', sub: `${list.length} فاتورة في صورة واحدة` },
    { mode: 'rep', icon: Users, title: 'صورة لكل مندوب', sub: `${repCount} ${repCount === 1 ? 'مندوب' : 'مندوبين'} — كل صورة بعنوان اسمه` },
    ...(canShare ? [{ mode: 'separate' as InvMode, icon: Images, title: 'كل فاتورة منفصلة', sub: `${list.length} صورة` }] : []),
  ];

  const modal = open && createPortal(
    <div className="vi-inv-overlay" onClick={() => setOpen(false)}>
      <div className="vi-inv-modal" role="dialog" onClick={e => e.stopPropagation()}>
        <div className="vi-inv-modal__head">
          <strong>{repList ? 'نسخ صورة كل مندوب' : 'إرسال فواتير الفايبر'}</strong>
          <span className="vi-badge">{list.length}</span>
          <span className="ro-spacer" />
          <button className="vi-x" onClick={() => setOpen(false)}><X size={16} /></button>
        </div>
        {preparing && <div className="vi-reading vi-inv-prep"><i /> تجهيز الصور…</div>}
        {!repList ? (
          <div className="vi-inv-options">
            {options.map(o => {
              const Icon = o.icon;
              return (
                <button key={o.mode} className="vi-inv-opt" disabled={!packs} onClick={() => pick(o.mode)}>
                  <span className="vi-inv-opt__icon"><Icon size={22} /></span>
                  <span className="vi-inv-opt__text"><b>{o.title}</b><small>{o.sub}</small></span>
                  <span className="vi-inv-opt__go">{canShare ? <Send size={16} /> : 'نسخ'}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="vi-inv-list">
            <div className="vi-hint">الحافظة تحمل صورة واحدة — انسخ والصق كل مندوب على حدة</div>
            {packs?.rep.map(p => (
              <div key={p.key} className={`vi-inv-row ${sent.has(p.key) ? 'is-sent' : ''}`}>
                <span className="vi-inv-row__name">{p.title}<small> · {p.ids.length} فاتورة</small></span>
                <button className="vi-btn" disabled={sent.has(p.key)} onClick={() => deliver([p], false)}>{sent.has(p.key) ? '✓ نُسخت' : 'نسخ'}</button>
              </div>
            ))}
            <button className="vi-btn vi-btn--ghost" onClick={() => setRepList(false)}>رجوع</button>
          </div>
        )}
        {msg && <div className="vi-fb__msg vi-inv-msg">{msg}</div>}
      </div>
    </div>,
    document.body,
  );

  return (
    <span className="vi-fb">
      {list.length > 0 && (
        <button className="ro-chip vi-inv-all" onClick={() => setOpen(true)} title="كل فواتير طلبيات الفايبر التي لم تُرسل للفايبر بعد">
          <ImageIcon size={13} /> فواتير الفايبر <b>{list.length}</b>
        </button>
      )}
      {msg && !open && <span className="vi-fb__msg">{msg}</span>}
      {modal}
    </span>
  );
}

/** في تفاصيل الطلبية: فاتورة هذه الطلبية وحدها. */
export function ViberFeedbackButtons({ order, token, onCopied }: { order: FbOrder; token: string | null; onCopied?: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);
  if (!invoiceImageOf(order)) return null;

  const run = async () => {
    try {
      const m = await sendInvoices([order], token);
      if (m) { setMsg(m); onCopied?.(); }
    } catch { setMsg('تعذّر نسخ الصورة في هذا المتصفح'); }
  };

  return (
    <span className="vi-fb">
      <button className="btn btn--secondary btn--sm" onClick={run} title="فاتورة المذخر لهذه الطلبية للفايبر">
        <ImageIcon size={14} /> {IS_TOUCH ? 'مشاركة الفاتورة' : 'نسخ الفاتورة'}
      </button>
      {order.feedbackCopiedAt && !needsViberReply(order) && <span className="vi-fb__done">✓ أُرسلت للفايبر</span>}
      {msg && <span className="vi-fb__msg">{msg}</span>}
    </span>
  );
}
