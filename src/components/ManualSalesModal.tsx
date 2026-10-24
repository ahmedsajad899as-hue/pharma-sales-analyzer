import { useState, useRef, useEffect, useLayoutEffect, useCallback, Fragment } from 'react';
import { AutoText, ComboCell, normQ, gCell, type ComboOpt } from './ComboCell';
import { shrinkImage } from '../lib/shrinkImage';

/**
 * Modal for adding sales that don't appear in the uploaded Excel files —
 * warehouse (مذخر) invoices. Two entry paths that share one editable review grid:
 *   1) upload invoice image(s) → AI extracts rows → review/correct
 *   2) type rows manually
 * Per-invoice header fields (warehouse / invoice number / date / pharmacy / area)
 * live PER ROW so multi-image uploads keep each invoice's own details. Only the
 * rep is shared. On save the rows become Sale records (POST /api/sales/manual),
 * merged into an existing uploaded file or a brand-new one.
 */

const API = '';

interface FileOpt { id: number; originalName: string; detectedCurrency?: string; rowCount?: number; uploadedAt?: string; }
interface Rep { id: number; name: string; }

interface Row {
  warehouse: string;
  invoiceNumber: string;
  date: string;        // YYYY-MM-DD
  item: string;
  company: string;
  quantity: string;
  unitPrice: string;
  total: string;
  bonus: string;
  pharmacy: string;
  area: string;
  /** المندوب العلمي صاحب الطلبية — يُخمَّن بالخادم من (شركة الصنف + منطقة
   *  الصيدلية + تعيين الصنف)، ويبقى قابلاً للتعديل هنا. */
  scientificRep: string;
  repCandidates: { id: number; name: string }[];
  /** صيدليات السيرفي القريبة من الاسم المقروء حين لم يُحسم التطابق تلقائياً. */
  pharmacyCandidates: { name: string; area: string | null }[];
  imageIndex: number | null; // index into `images` this row was extracted from
  /** طلبية البوت التي جاء منها الصف (مراجعة مجمَّعة: عدة طلبيات في جدول واحد). */
  orderId: number | null;
  box: number[] | null;          // [ymin,xmin,ymax,xmax] 0-1000: this item's row in the image
  boxCustomer: number[] | null;  // pharmacy/area block in the image
  boxHeader: number[] | null;    // whole header block (warehouse + invoice# + date)
}

/** طلبية وصلت عبر بوت (PendingBotOrder) استُخرجت بالخادم وتنتظر مراجعة هنا. */
export interface PendingOrderDetail {
  id: number;
  source: string;            // telegram | viber | whatsapp
  kind: string;              // text | photo
  rows: any[];               // بنفس شكل مخرجات extractInvoiceRows
  repName?: string | null;
  repId?: number | null;
  sourceText?: string | null;
  senderName?: string | null;
  chatTitle?: string | null;
  imageCount?: number;
  createdAt?: string;
  /** طلبية حُوِّلت لمدير الشركة صاحب الايتم من حساب الكروب — تُحفَظ في ملف كوديشنه. */
  originUserId?: number | null;
  originName?: string | null;
}

interface Props {
  token: string;
  files: FileOpt[];
  onClose: () => void;
  onSaved: (msg: string, fileId?: number) => void;
  /** طلبية بوت جاهزة — تُعبَّأ فور الفتح بلا رفع/استخراج جديد. إغلاق المودال
   *  العادي لا يحذفها (تبقى معلَّقة في الطابور ويظهر شريطها مرة أخرى). */
  initialOrder?: PendingOrderDetail | null;
  /** مراجعة مجمَّعة: عدة طلبيات بوت في جدول واحد، كل طلبية مجموعة برقمها وتُعرض
   *  رسالتها الأصلية أعلى الجدول عند النقر على رقمها. يتقدّم على initialOrder. */
  initialOrders?: PendingOrderDetail[] | null;
  /** «إلغاء هذه الطلبية نهائياً» — يظهر فقط مع initialOrder(s)؛ الأب يتولّى الحذف
   *  بالخادم وإخفاء الشريط (لكل الطلبيات المعروضة). */
  onCancelPending?: () => void;
}

/** نتيجة فحص اسم واحد كما يُرجعها /api/sales/check-names. */
type NameCheck = {
  raw: string;
  status: 'exact' | 'ask' | 'new';
  canonical?: { id: number; name: string };
  suggestions: { id: number; name: string; sim: number }[];
};
type NameAsk = { items: NameCheck[]; companies: NameCheck[]; rows: any[] };

/** نتيجة /api/sales/check-duplicates — فاتورة/صنف محفوظ سابقاً (راجع server/lib/manualDuplicateCheck.js). */
type DupLevel = 'duplicate' | 'partial' | 'possible';
type DupGroup = {
  group: string; level: DupLevel; reasons: string[]; matchedCount: number; itemCount: number;
  match: { inBatch: boolean; group?: string; fileName?: string; invoiceNumber?: string; date?: string; savedAt?: string;
    pharmacy?: string; area?: string; warehouse?: string; source?: string; itemCount?: number;
    /** المطابِق في إكسل ميركاتو — طلبية جهّزها ميركاتو ثم صُوّرت فاتورتها */
    mercato?: boolean; rep?: string };
};
type DupRow = { index: number; level: 'duplicate' | 'possible'; group: string; sameQty: boolean; existingQty: number; existingItem: string | null; mercato?: boolean };
type DupResult = { sig: string; groups: DupGroup[]; rows: DupRow[] };

/** مفتاح فاتورة الصف لفحص التكرار: صورة = فاتورة؛ اليدوي يُفصل برقم الفاتورة والصيدلية. */
const dupGroupKey = (r: Row) =>
  r.orderId != null ? `ord${r.orderId}|${r.imageIndex ?? ''}`
  : r.imageIndex != null ? `img${r.imageIndex}` : `manual|${r.invoiceNumber.trim()}|${r.pharmacy.trim()}`;

/** مفتاح تطابق صف مستخرَج — لكشف إعادة استخراج نفس الطلبية (نصّاً ثم صورةً). */
const rowKey = (r: Row) =>
  [r.item, r.quantity, r.pharmacy].map(v => String(v ?? '').trim().toLowerCase()).join('|');

const emptyRow = (): Row => ({ warehouse: '', invoiceNumber: '', date: '', item: '', company: '', quantity: '', unitPrice: '', total: '', bonus: '', pharmacy: '', area: '', scientificRep: '', repCandidates: [], pharmacyCandidates: [], imageIndex: null, orderId: null, box: null, boxCustomer: null, boxHeader: null });
const num = (v: any) => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return isFinite(n) ? n : ''; };

/**
 * عرض الأسعار بفاصل آلاف نقطة («7631» → «7.631») — طلب صاحب المشروع، وهو عرف
 * كتابة الأسعار بالعراق.
 *
 * **عرضٌ فقط**: الحالة (state) تبقى أرقاماً خاماً دائماً، والفاصل يظهر في قيمة
 * الحقل حين لا يكون مُركَّزاً عليه فقط. بهذا لا يلمس الحفظ ولا الحسابات أي نص
 * منسَّق — `Number('7.631')` كان سيساوي 7.631 لا 7631، وهو خطأ صامت يُفسد قيمة
 * المبيعة كلها.
 */
const fmtThousands = (v: string) => {
  const s = String(v ?? '').trim();
  if (s === '' || !/^\d+(\.\d+)?$/.test(s)) return s; // فارغ أو غير رقمي → كما هو
  const [int, frac] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return frac ? `${grouped},${frac}` : grouped;
};

// Floating, DRAGGABLE, non-modal invoice preview — small/medium so the user can
// keep it beside the grid and compare the photo against the extracted rows.
function DraggableImage({ src, focusBox, dockX, onClose }: { src: string; focusBox?: number[] | null; dockX?: number | null; onClose: () => void }) {
  const [pos, setPos] = useState({ x: 20, y: 64 }); // window position (dragged by header)
  useEffect(() => { if (typeof dockX === 'number') setPos(p => ({ ...p, x: dockX })); }, [dockX]);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1); zoomRef.current = zoom;
  const winDragRef = useRef<{ dx: number; dy: number } | null>(null); // dragging the whole window
  const panRef = useRef<{ sx: number; sy: number; sl: number; st: number; moved: boolean } | null>(null); // panning the image
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const boxRef = useRef<number[] | null>(null);

  // Zoom while keeping the point under the cursor fixed (zoom-to-cursor).
  const applyZoom = (clientX: number, clientY: number, newZoom: number) => {
    const cont = scrollRef.current; if (!cont) return;
    const rect = cont.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const contentX = cont.scrollLeft + px, contentY = cont.scrollTop + py;
    const ratio = newZoom / zoomRef.current;
    zoomRef.current = newZoom; // update now so rapid successive events read the right base
    setZoom(newZoom);
    requestAnimationFrame(() => { cont.scrollLeft = contentX * ratio - px; cont.scrollTop = contentY * ratio - py; });
  };
  const zoomBtn = (factor: number) => {
    const cont = scrollRef.current; if (!cont) return;
    const r = cont.getBoundingClientRect();
    applyZoom(r.left + r.width / 2, r.top + r.height / 2, Math.min(6, Math.max(1, +(zoomRef.current * factor).toFixed(2))));
  };

  // One set of window listeners drives BOTH window-drag (header) and image-pan (inside image).
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (winDragRef.current) {
        setPos({ x: e.clientX - winDragRef.current.dx, y: Math.max(0, e.clientY - winDragRef.current.dy) });
      } else if (panRef.current) {
        const cont = scrollRef.current; if (!cont) return;
        const dx = e.clientX - panRef.current.sx, dy = e.clientY - panRef.current.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) panRef.current.moved = true;
        cont.scrollLeft = panRef.current.sl - dx;
        cont.scrollTop = panRef.current.st - dy;
      }
    };
    const up = (e: MouseEvent) => {
      if (panRef.current && !panRef.current.moved) applyZoom(e.clientX, e.clientY, Math.min(6, +(zoomRef.current * 1.5).toFixed(2))); // click = zoom in at point
      winDragRef.current = null; panRef.current = null; document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto zoom + scroll to a focused box (0-1000 coords), re-run on image load
  // (naturalWidth is 0 before load). The user can then pan/zoom to fine-tune.
  const focusOnBox = (box: number[]) => {
    const cont = scrollRef.current, img = imgRef.current;
    if (!cont || !img || !img.naturalWidth) return;
    const [ymin, xmin, ymax, xmax] = box.map(v => Math.max(0, Math.min(1000, Number(v) || 0)));
    const fracW = Math.max(0.05, (xmax - xmin) / 1000), fracH = Math.max(0.05, (ymax - ymin) / 1000);
    const Cw = cont.clientWidth, Ch = cont.clientHeight;
    const imgH1 = Cw * (img.naturalHeight / img.naturalWidth);
    const z = Math.min(6, Math.max(2, Math.min(0.9 / fracW, (0.9 * Ch) / (fracH * imgH1))));
    zoomRef.current = z; setZoom(z);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const imgW = z * Cw, imgH = imgW * (img.naturalHeight / img.naturalWidth);
      cont.scrollLeft = Math.max(0, ((xmin + xmax) / 2 / 1000) * imgW - Cw / 2);
      cont.scrollTop = Math.max(0, ((ymin + ymax) / 2 / 1000) * imgH - Ch / 2);
    }));
  };
  useEffect(() => {
    boxRef.current = (focusBox && focusBox.length === 4) ? focusBox : null;
    if (boxRef.current) focusOnBox(boxRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBox]);

  const startWinDrag = (e: React.MouseEvent) => {
    winDragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    document.body.style.userSelect = 'none';
  };
  const startPan = (e: React.MouseEvent) => {
    const cont = scrollRef.current; if (!cont) return;
    panRef.current = { sx: e.clientX, sy: e.clientY, sl: cont.scrollLeft, st: cont.scrollTop, moved: false };
    document.body.style.userSelect = 'none';
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    applyZoom(e.clientX, e.clientY, Math.min(6, Math.max(1, +(zoomRef.current * (e.deltaY < 0 ? 1.2 : 0.83)).toFixed(3))));
  };

  const PAD = 1.3;
  const hl = (focusBox && focusBox.length === 4)
    ? { l: Math.max(0, Math.min(focusBox[1], focusBox[3]) / 10 - PAD), t: Math.max(0, Math.min(focusBox[0], focusBox[2]) / 10 - PAD),
        w: Math.min(100, Math.abs(focusBox[3] - focusBox[1]) / 10 + 2 * PAD), h: Math.min(100, Math.abs(focusBox[2] - focusBox[0]) / 10 + 2 * PAD) }
    : null;
  return (
    <div style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 10001, width: 460, maxWidth: '96vw',
      background: '#fff', borderRadius: 10, boxShadow: '0 14px 48px rgba(0,0,0,0.5)', border: '1px solid #cbd5e1', overflow: 'hidden' }}>
      <div onMouseDown={startWinDrag}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: '#1e293b', color: '#fff', cursor: 'move', fontSize: 11.5, fontWeight: 600, userSelect: 'none' }}>
        <span>📄 داخل الصورة: انقر للتقريب · اسحب للتحريك · عجلة الماوس للتكبير/التصغير — واسحب هذا الشريط لنقل النافذة</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }} onMouseDown={e => e.stopPropagation()}>
          <button onClick={() => zoomBtn(0.8)} title="تصغير" style={hdrBtn}>−</button>
          <button onClick={() => { zoomRef.current = 1; setZoom(1); requestAnimationFrame(() => { const c = scrollRef.current; if (c) { c.scrollLeft = 0; c.scrollTop = 0; } }); }} title="إعادة ضبط" style={{ ...hdrBtn, width: 'auto', padding: '0 7px', fontSize: 10 }}>1:1</button>
          <button onClick={() => zoomBtn(1.25)} title="تكبير" style={hdrBtn}>＋</button>
          <button onClick={onClose} title="إغلاق" style={hdrBtn}>✕</button>
        </span>
      </div>
      <div ref={scrollRef} dir="ltr" onWheel={onWheel} onMouseDown={startPan}
        style={{ maxHeight: '70vh', minHeight: 240, overflow: 'auto', background: '#0f172a', resize: 'both', cursor: 'grab' }}>
        <div style={{ position: 'relative', width: `${zoom * 100}%` }}>
          <img ref={imgRef} src={src} alt="فاتورة" draggable={false}
            onLoad={() => { if (boxRef.current) focusOnBox(boxRef.current); }}
            style={{ width: '100%', display: 'block' }} />
          {hl && (
            <div style={{ position: 'absolute', left: `${hl.l}%`, top: `${hl.t}%`, width: `${hl.w}%`, height: `${hl.h}%`,
              outline: '3px solid #f59e0b', outlineOffset: '3px', background: 'transparent', pointerEvents: 'none' }} />
          )}
        </div>
      </div>
    </div>
  );
}
const hdrBtn: React.CSSProperties = { background: 'rgba(255,255,255,0.18)', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13, lineHeight: 1, width: 22, height: 22, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' };

export default function ManualSalesModal({ token, files, onClose, onSaved, initialOrder: singleOrder, initialOrders, onCancelPending }: Props) {
  const authH = { Authorization: `Bearer ${token}` };
  // كل الطلبيات المعروضة (واحدة أو أكثر). initialOrder = الأولى — لما يخصّ الجلسة كلها.
  const orderList: PendingOrderDetail[] = initialOrders?.length ? initialOrders : singleOrder ? [singleOrder] : [];
  const initialOrder: PendingOrderDetail | null = orderList[0] ?? null;
  const orderKey = orderList.map(o => o.id).join(',');
  const orderById = new Map(orderList.map(o => [o.id, o]));
  // الطلبية التي تُعرض رسالتها الأصلية أعلى الجدول (تتبدّل بالنقر على رقمها).
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null);
  const srcPanelRef = useRef<HTMLDivElement>(null);
  // أقدم وقت وصول — بديل التاريخ في فحص التكرار.
  const earliestOrderAt = orderList.map(o => o.createdAt).filter(Boolean).sort()[0];
  // كل الطلبيات المعروضة محوَّلة من نفس حساب الكروب؟ ← اسمه لنص وجهة الحفظ.
  const originNames = [...new Set(orderList.map(o => o.originName).filter(Boolean))] as string[];

  // طلبية بوت قيد المراجعة — يُغيّر نصوص الواجهة ويُظهر زر الإلغاء النهائي، ولا
  // تُحفَظ المبيعات إلا بنفس مسار الإدخال اليدوي. مسوّدة localStorage لا لزوم لها
  // هنا: الطلبية محفوظة في الخادم أصلاً وهذا أقوى من مسوّدة متصفح.
  const [fromPendingOrder, setFromPendingOrder] = useState(false);
  const backdropDownRef = useRef(false); // الضغط بدأ على الخلفية (لا داخل الإطار)
  const appliedOrderIdRef = useRef<string | null>(null);
  // الخانة الرقمية قيد التحرير — تُعرض خاماً أثناء الكتابة ومنسَّقة بعد الخروج.
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [repName, setRepName] = useState('');            // shared: chosen by the user
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [images, setImages] = useState<string[]>([]);    // object URLs of uploaded invoice photos
  const [preview, setPreview] = useState<string | null>(null);

  // Destination
  // طلبيات البوت تذهب افتراضياً إلى «ملف الكوديشن» (حاوية تراكمية مرتبطة بميركاتو).
  const [destMode, setDestMode]     = useState<'condition' | 'existing' | 'new'>(initialOrder ? 'condition' : files.length ? 'existing' : 'new');
  const [destFileId, setDestFileId] = useState<number | ''>(files[0]?.id ?? '');
  const [newFileName, setNewFileName] = useState('');
  const [newCurrency, setNewCurrency] = useState<'IQD' | 'USD'>('IQD');

  const [reps, setReps]         = useState<Rep[]>([]);
  // كل المندوبين العلميين في المكتب — خيارات خانة «المندوب العلمي» بعد مسح المقترح.
  const [sciReps, setSciReps]   = useState<{ id: number; name: string }[]>([]);
  // اقتراحات خانات المادة/الشركة/المنطقة (كتالوج المكتب) — الكتابة الحرّة مسموحة.
  const [suggest, setSuggest] = useState<{ items: { name: string; company: string | null; price: number | null }[]; companies: string[]; areas: string[] }>({ items: [], companies: [], areas: [] });
  // صفوف يُعاد تخمينها الآن (بعد تغيير مادة/منطقة) — تُعرض باهتة حتى يصل الردّ.
  const [refreshing, setRefreshing] = useState<Set<number>>(new Set());
  const [onlyAssignedItems, setOnlyAssignedItems] = useState(false); // فلترة الاستخراج على ايتمات المستخدم المعيّنة فقط
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [checking, setChecking] = useState(false);
  const [nameAsk, setNameAsk]   = useState<NameAsk | null>(null);
  const [choice, setChoice]     = useState<Record<string, string>>({});
  const [error, setError]       = useState('');
  const [info, setInfo]         = useState('');
  const imgInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<string[]>([]);
  imagesRef.current = images;

  // ── فحص التكرار مقابل المحفوظ سابقاً ──────────────────────────────────────
  // بعد كل تحليل/تعديل (بتأخير قصير) يُسأل الخادم: أيّ هذه الفواتير وأصنافها
  // موجود أصلاً في ملف الكوديشن أو ملف الوجهة؟ النتيجة تُعرض فقط حين تطابق
  // الجدول الحالي (sig) — تعديل صف يُبطلها حتى يصل الفحص الجديد.
  const [dup, setDup] = useState<DupResult | null>(null);
  const [dupChecking, setDupChecking] = useState(false);
  const dupPayload = rows.map(r => ({
    group: dupGroupKey(r), invoiceNumber: r.invoiceNumber.trim(), date: r.date, pharmacy: r.pharmacy.trim(),
    area: r.area.trim(), warehouse: r.warehouse.trim(), item: r.item.trim(), company: r.company.trim(), quantity: Number(r.quantity) || 0,
  }));
  const dupTarget = destMode === 'existing' && destFileId ? { fileId: destFileId } : destMode === 'condition' ? { condition: true } : {};
  const dupSig = JSON.stringify([dupTarget, dupPayload]);
  const dupSigRef = useRef(dupSig);
  dupSigRef.current = dupSig;
  const hasCheckable = dupPayload.some(r => r.item && r.quantity > 0);

  const runDupCheck = async (sig: string): Promise<DupResult | null> => {
    setDupChecking(true);
    try {
      const res = await fetch(`${API}/api/sales/check-duplicates`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: dupPayload, target: dupTarget, receivedAt: earliestOrderAt, pendingOrderIds: orderList.map(o => o.id) }),
      });
      if (!res.ok) return null;
      const d = (await res.json()).data;
      const result: DupResult = { sig, groups: d?.groups ?? [], rows: d?.rows ?? [] };
      if (dupSigRef.current === sig) setDup(result); // ردّ متأخر لجدول تغيّر لا يُعرض
      return result;
    } catch {
      return null; // الفحص تنبيه لا شرط — تعذّره لا يمنع الحفظ
    } finally {
      if (dupSigRef.current === sig) setDupChecking(false);
    }
  };
  useEffect(() => {
    if (!hasCheckable) { setDup(null); return; }
    if (dup?.sig === dupSig) return;
    const t = setTimeout(() => { runDupCheck(dupSig); }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dupSig]);
  const dupNow = dup && dup.sig === dupSig ? dup : null;
  const dupRowByIdx = new Map((dupNow?.rows ?? []).map(r => [r.index, r]));
  const dupDupRows = (dupNow?.rows ?? []).filter(r => r.level === 'duplicate');
  const dupMercatoRows = dupDupRows.filter(r => r.mercato).length;
  /** يحذف من الجدول الصفوف المحفوظة سابقاً (كلها، أو صفوف فاتورة واحدة). */
  const dropDuplicateRows = (group?: string) => {
    const drop = new Set(dupDupRows.filter(r => !group || r.group === group).map(r => r.index));
    if (!drop.size) return;
    setRows(rs => { const kept = rs.filter((_, i) => !drop.has(i)); return kept.length ? kept : [emptyRow()]; });
    setInfo(`🧹 استُبعد ${drop.size} صف محفوظ سابقاً — لن يُحفظ مرة ثانية.`);
  };

  useEffect(() => {
    fetch(`${API}/api/representatives`, { headers: authH })
      .then(r => r.json())
      .then(j => { if (Array.isArray(j.data)) setReps(j.data.map((r: any) => ({ id: r.id, name: r.name }))); })
      .catch(() => {});
    fetch(`${API}/api/orders/scientific-reps`, { headers: authH })
      .then(r => r.json())
      .then(j => { if (Array.isArray(j.data)) setSciReps(j.data); })
      .catch(() => {});
    fetch(`${API}/api/orders/catalog-suggest`, { headers: authH })
      .then(r => r.json())
      .then(j => { if (j?.data?.items) setSuggest(j.data); })
      .catch(() => {});
    return () => { imagesRef.current.forEach(u => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const destCurrency = destMode === 'existing'
    ? (files.find(f => f.id === destFileId)?.detectedCurrency || 'IQD')
    : newCurrency; // الكوديشن والملف الجديد: العملة المختارة

  // ── Row helpers ──
  const setCell = (i: number, key: keyof Row, val: string) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
  const addRow = () => setRows(rs => {
    const last = rs[rs.length - 1];
    // Carry over per-invoice header fields so entering several items of one invoice is fast
    const seed = last
      ? { ...emptyRow(), orderId: last.orderId, warehouse: last.warehouse, invoiceNumber: last.invoiceNumber, date: last.date, pharmacy: last.pharmacy, area: last.area, scientificRep: last.scientificRep, repCandidates: last.repCandidates, pharmacyCandidates: last.pharmacyCandidates }
      : emptyRow();
    return [...rs, seed];
  });
  /**
   * يفرّغ بيانات الصف فقط — الصف يبقى في مكانه ومرتبطاً بطلبيته وصورتها. خانات
   * الفاتورة المدموجة (المذخر/رقم الفاتورة/التاريخ) تُبقى: هي مشتركة بين أصناف
   * الفاتورة، وتفريغها من صفّها الأول كان سيمسحها لكل أصنافها.
   */
  const clearRow = (i: number) => setRows(rs => rs.map((r, idx) => (idx === i
    ? { ...emptyRow(), orderId: r.orderId, imageIndex: r.imageIndex, box: r.box, boxCustomer: r.boxCustomer, boxHeader: r.boxHeader,
        warehouse: r.warehouse, invoiceNumber: r.invoiceNumber, date: r.date }
    : r)));
  const removeRow = (i: number) => setRows(rs => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : [emptyRow()]));
  const onQtyPrice = (i: number, key: 'quantity' | 'unitPrice', val: string) => {
    setRows(rs => rs.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, [key]: val };
      const q = Number(next.quantity), p = Number(next.unitPrice);
      if (!next.total && isFinite(q) && isFinite(p) && q && p) next.total = String(q * p);
      return next;
    }));
  };

  /**
   * يحوّل مخرجات الاستخراج (صورة أو نصّ طلبية) إلى صفوف الشبكة ويضيفها.
   * مشتركة بين رفع صورة جديدة هنا وتحميل طلبية بوت جاهزة من الخادم — نفس عقد
   * الصف في الحالتين، فلا تفريع ولا تحويل ثانٍ.
   */
  const applyExtractedRows = useCallback((extracted: any[], baseIndex: number, mode: 'append' | 'replace' = 'append'): { mapped: Row[]; skipped: number } => {
    const mapped: Row[] = mapExtracted(extracted, baseIndex, baseIndex, null);
    if (mode === 'replace') {
      setRows(mapped.length ? mapped : [emptyRow()]);
      return { mapped, skipped: 0 };
    }

    // الصفوف الفارغة تُستبدل بالمستخرَج بدل أن تتراكم فوقه؛ وإن كان الجدول
    // كلّه فارغاً صار المستخرَج هو محتواه.
    //
    // ويُتجاهَل أي صف مطابق لصف موجود (نفس المادة والكمية والصيدلية): الحالة
    // الواقعية أن تصل الطلبية نصّاً من البوت ثم يرفع المراجِع صورتها نفسها
    // للتأكد — فتُضاف الأصناف مرتين بلا أن ينتبه. إضافة فاتورة مختلفة فعلاً لا
    // تتأثر لأن صفوفها تختلف في الكمية أو الصيدلية أو المادة.
    let skipped = 0;
    setRows(rs => {
      const kept = rs.filter(rowHasData);
      const seen = new Set(kept.map(rowKey));
      const fresh: Row[] = [];
      for (const m of mapped) {
        const k = rowKey(m);
        if (seen.has(k)) { skipped++; continue; }
        seen.add(k);
        fresh.push(m);
      }
      return [...kept, ...fresh];
    });
    return { mapped, skipped };
  }, []);

  // ── طلبيات بوت جاهزة: تعبئة فورية بلا رفع ولا نداء ذكاء ──
  // عدة طلبيات = جدول واحد: صفوف كل طلبية مجموعة برقمها، وصورها تُرقَّم متتالية
  // (صور الطلبية الثانية تبدأ بعد صور الأولى) بنفس ترتيب تحميلها أدناه.
  useEffect(() => {
    if (!orderList.length) return;
    // حارس التطبيق مرة واحدة لكل مجموعة طلبيات: أي إعادة تشغيل للتأثير (تغيّر
    // مرجع الكائن، إعادة تركيب) كانت ستُضيف الصفوف ثانيةً فتظهر مكرّرة.
    if (appliedOrderIdRef.current === orderKey) return;
    appliedOrderIdRef.current = orderKey;
    setFromPendingOrder(true);
    let base = 0;
    const all: Row[] = [];
    for (const o of orderList) {
      const n = o.imageCount ?? 0;
      all.push(...mapExtracted(o.rows || [], base, n > 0 ? base : null, o.id));
      base += n;
    }
    // الاستبدال لا الإضافة: صفوف الطلبيات هي محتوى الشبكة كلّه عند فتحها.
    setRows(all.length ? all : [emptyRow()]);
    setActiveOrderId(orderList[0].id);
    const rn = orderList.find(o => o.repName)?.repName;
    if (rn) setRepName(rn);
    // ملف الهدف: شهر واحد في ملف واحد بدل عشرات ملفات بصفّين.
    if (!files.length) {
      const d = new Date(orderList[0].createdAt || Date.now());
      setNewFileName(`طلبيات البوت — ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  // ── صور الطلبية: تأثير **مستقل** عمداً ───────────────────────────────────
  // كان التحميل داخل تأثير التعبئة أعلاه، فأعاد شغلُه تشغيلَ دالة تنظيف تُلغي
  // النتيجة (`cancelled = true`) بينما يمنع حارسُ «طبّق مرة واحدة» إعادةَ
  // المحاولة — فتصل الصورة من الخادم (مُثبَت في سجل nginx: 200 و77KB) ثم
  // تُرمى قبل العرض، وتبقى خانة الصورة «—» بلا أي خطأ ظاهر.
  //
  // هنا: حارس خاص بالصور بحسب رقم الطلبية، **وبلا دالة تنظيف تُلغي** — التحميل
  // الجاري يُكمَل دائماً. وإعادة التشغيل لنفس الطلبية لا تفعل شيئاً.
  const imagesLoadedForRef = useRef<string | null>(null);
  useEffect(() => {
    const total = orderList.reduce((n, o) => n + (o.imageCount ?? 0), 0);
    if (!orderKey || total <= 0) return;
    if (imagesLoadedForRef.current === orderKey) return;
    imagesLoadedForRef.current = orderKey;
    (async () => {
      // خانات ثابتة بعدد الصور: صورة مفقودة تبقى خانة فارغة كي لا تنزاح أرقام
      // صور الطلبيات التالية عن صفوفها.
      const slots: string[] = new Array(total).fill('');
      let base = 0, ok = 0;
      for (const o of orderList) {
        const count = o.imageCount ?? 0;
        for (let i = 0; i < count; i++) {
          try {
            const res = await fetch(`${API}/api/orders/pending/${o.id}/image/${i}`, { headers: authH });
            if (!res.ok) continue;
            slots[base + i] = URL.createObjectURL(await res.blob());
            ok++;
          } catch { /* صورة مفقودة لا تُسقط المراجعة */ }
        }
        base += count;
      }
      if (ok) setImages(prev => [...prev, ...slots]);
      // فشل صامت كان هو المشكلة أصلاً — الآن يُقال للمستخدم.
      if (ok < total) setInfo('تعذّر تحميل بعض صور الطلبيات. أعد فتحها، وإن تكرّر فأبلغ الأدمن.');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  // ── AI extraction from invoice images ──
  const onImages = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError(''); setInfo(''); setExtracting(true);
    const baseIndex = imagesRef.current.length;
    const newUrls = Array.from(fileList).map(f => URL.createObjectURL(f));
    setImages(prev => [...prev, ...newUrls]);
    try {
      const fd = new FormData();
      for (const f of await Promise.all(Array.from(fileList).map(shrinkImage))) fd.append('images', f);
      if (onlyAssignedItems) fd.append('onlyAssignedItems', 'true');
      const res = await fetch(`${API}/api/sales/extract-invoice`, { method: 'POST', body: fd, headers: authH });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'فشل تحليل الصورة');
      const extracted: any[] = j.data?.rows ?? [];
      const droppedCount: number = j.data?.droppedCount ?? 0;
      if (extracted.length === 0) {
        setInfo(droppedCount > 0
          ? `لم يُستخرج أي ايتم معيّن لك من هذه الصورة (تم تجاهل ${droppedCount} ايتم غير معيّن). جرّب تعطيل «ايتماتي فقط» إن أردت رؤيتها.`
          : 'لم يتم استخراج أي صف من الصورة. جرّب صورة أوضح أو أدخل يدوياً.');
        return;
      }
      const { mapped, skipped } = applyExtractedRows(extracted, baseIndex);
      setInfo(`تم استخراج ${mapped.length} صف — راجعها وصحّحها قبل الحفظ.`
        + (skipped > 0 ? ` (تم تجاهل ${skipped} صف مكرّر موجود أصلاً في الجدول)` : '')
        + (droppedCount > 0 ? ` (تم تجاهل ${droppedCount} ايتم غير معيّن لك)` : ''));
    } catch (e: any) {
      setError(e.message || 'تعذّر تحليل الصورة');
    } finally {
      setExtracting(false);
      if (imgInputRef.current) imgInputRef.current.value = '';
    }
  }, [token, onlyAssignedItems]);

  // ── Save ──
  /**
   * الحفظ الفعلي. يُستدعى مباشرةً حين لا يوجد اسم ملتبس، أو بعد أن يبتّ
   * المستخدم في نافذة التأكيد.
   */
  const doSave = async (payloadRows: any[], rememberItems: { from: string; toItemId: number }[]) => {
    if (destMode === 'existing' && !destFileId) { setError('اختر ملفاً للدمج فيه.'); return; }
    if (destMode === 'new' && !newFileName.trim()) { setError('اكتب اسماً للملف الجديد.'); return; }
    const target = destMode === 'condition'
      ? { condition: true, sourceCurrency: newCurrency }
      : destMode === 'existing'
      ? { fileId: destFileId }
      : { newFileName: newFileName.trim(), sourceCurrency: newCurrency };
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/sales/manual`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: payloadRows, target, rememberItems, pendingOrderIds: orderList.map(o => o.id) }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'فشل الحفظ');
      const added = j.data?.addedCount ?? payloadRows.length;
      const remembered = j.data?.rememberedCount ?? 0;
      const skipped = j.data?.skippedCount ?? 0;
      onSaved(`تمت إضافة ${added} عملية بيع${destMode === 'condition' ? ' إلى ملف الكوديشن' : j.data?.merged ? ' ودمجها في الملف المحدد' : ' في ملف جديد'}${skipped ? ` (أُسقط ${skipped} مكرر)` : ''}.`
        + (remembered > 0 ? ` وحُفظ ${remembered} ربط اسم فلن يُسأل عنه مرة أخرى.` : ''),
        j.data?.uploadedFile?.id);
    } catch (e: any) {
      setError(e.message || 'تعذّر الحفظ');
    } finally {
      setSaving(false);
      setNameAsk(null);
    }
  };

  const onSave = async () => {
    setError(''); setInfo('');
    const payloadRows = rows
      .filter(r => r.item.trim() && Number(r.quantity) > 0)
      .map(r => ({
        repName,
        // أثر المصدر في rawData.source، ورقم تركيبي حين لا رقم فاتورة كي تتشارك
        // صفوف الطلبية مفتاحاً واحداً في عدّ الطلبيات (server/lib/orderKey.js).
        // الطلبية صاحبة الصف — الخادم يحفظ صفوف الطلبية المحوَّلة في ملف كوديشن
        // حساب الكروب الأصلي ويُنهي كل الطلبيات المعروضة بعد الحفظ.
        pendingOrderId: r.orderId ?? undefined,
        source:        r.orderId != null ? `${orderById.get(r.orderId)?.source ?? 'telegram'}-order`
          : initialOrder ? `${initialOrder.source}-order` : undefined,
        warehouse:     r.warehouse.trim() || undefined,
        invoiceNumber: r.invoiceNumber.trim()
          || (r.orderId != null ? `BOT-${r.orderId}` : initialOrder ? `BOT-${initialOrder.id}` : undefined),
        date:          r.date || undefined,
        item:          r.item.trim(),
        company:       r.company.trim() || undefined,
        quantity:      Number(r.quantity),
        totalValue:    r.total !== '' ? Number(r.total) : undefined,
        unitPrice:     r.unitPrice !== '' ? Number(r.unitPrice) : undefined,
        bonus:         r.bonus !== '' ? Number(r.bonus) : undefined,
        pharmacy:      r.pharmacy.trim() || undefined,
        area:          r.area.trim() || undefined,
        scientificRep: r.scientificRep.trim() || undefined,
      }));
    if (payloadRows.length === 0) { setError('أضف صفاً واحداً على الأقل باسم مادة وكمية أكبر من صفر.'); return; }
    if (!repName.trim()) { setError('اختر أو اكتب اسم المندوب المسؤول عن هذه المبيعات.'); return; }
    if (destMode === 'existing' && !destFileId) { setError('اختر ملفاً للدمج فيه.'); return; }
    if (destMode === 'new' && !newFileName.trim()) { setError('اكتب اسماً للملف الجديد.'); return; }

    // ── فحص التكرار قبل الحفظ: نتيجة حديثة لهذا الجدول بالضبط، وإلا يُفحص الآن ──
    const dupRes = dupNow ?? await runDupCheck(dupSig);
    const stillDup = (dupRes?.rows ?? []).filter(r => r.level === 'duplicate');
    if (stillDup.length > 0) {
      const invs = new Set(stillDup.map(r => r.group)).size;
      const ok = window.confirm(
        `⚠️ ${stillDup.length} صف (في ${invs} فاتورة) محفوظ سابقاً${stillDup.some(r => r.mercato) ? ' (منها محسوب أصلاً في مبيع ميركاتو)' : ' في الملف'} — حفظه مرة ثانية يضاعف المبيع.\n\n`
        + 'موافق = احفظ كل الصفوف رغم ذلك\nإلغاء = ارجع للجدول (يمكنك «استبعاد المكرر»)');
      if (!ok) return;
    }

    // ── فحص الأسماء قبل الحفظ ──
    // التطابق التام يُوحَّد صامتاً؛ المتشابه غير القاطع يُعرَض للتأكيد؛ وتعذُّر
    // الفحص لا يمنع الحفظ (نمضي بالأسماء كما كُتبت) كي لا يضيع عمل المستخدم.
    setChecking(true);
    let check: { items: NameCheck[]; companies: NameCheck[] } | null = null;
    try {
      const res = await fetch(`${API}/api/sales/check-names`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: payloadRows.map(r => ({ item: r.item, company: r.company })) }),
      });
      if (res.ok) check = (await res.json()).data ?? null;
    } catch { /* الفحص رفاهية — نكمل بلا توحيد */ }
    setChecking(false);

    const asks = check
      ? [...check.items, ...check.companies].filter(e => e.status === 'ask')
      : [];
    if (asks.length > 0) {
      setChoice({});
      setNameAsk({ items: check!.items, companies: check!.companies, rows: payloadRows });
      return; // ننتظر قرار المستخدم
    }

    // لا التباس — وحّد ما تطابق تماماً ثم احفظ
    const unified = check ? applyUnification(payloadRows, check.items, check.companies, {}).rows : payloadRows;
    await doSave(unified, []);
  };

  /**
   * يطبّق قرارات التوحيد على الصفوف.
   *   exact → يُعتمد الاسم القانوني بلا سؤال
   *   ask   → يُعتمد ما اختاره المستخدم؛ و«اسم جديد» يُبقي ما كتبه كما هو
   * ويجمع روابط الايتمات المؤكَّدة كي يحفظها الخادم فلا يُسأل عنها ثانيةً.
   */
  const applyUnification = (
    payloadRows: any[], items: NameCheck[], companies: NameCheck[], picks: Record<string, string>,
  ) => {
    const remember: { from: string; toItemId: number }[] = [];
    const build = (list: NameCheck[], prefix: string, track: boolean) => {
      const map = new Map<string, string>();
      for (const e of list) {
        if (e.status === 'exact' && e.canonical) { map.set(e.raw, e.canonical.name); continue; }
        if (e.status !== 'ask') continue;
        const pick = picks[prefix + e.raw];
        if (!pick || pick === 'new') continue;   // اسم جديد → يبقى كما كُتب
        const s = e.suggestions.find(x => String(x.id) === pick);
        if (!s) continue;
        map.set(e.raw, s.name);
        if (track) remember.push({ from: e.raw, toItemId: s.id });
      }
      return map;
    };
    const itemMap = build(items, 'i|', true);
    const compMap = build(companies, 'c|', false);
    const out = payloadRows.map(r => ({
      ...r,
      item:    itemMap.get(r.item) ?? r.item,
      company: r.company ? (compMap.get(r.company) ?? r.company) : r.company,
    }));
    return { rows: out, remember, itemMap, compMap };
  };

  /** تأكيد نافذة الأسماء: يوحّد، يعكس الأسماء في الجدول، ثم يحفظ. */
  const confirmNames = async () => {
    if (!nameAsk) return;
    const { rows: finalRows, remember, itemMap, compMap } = applyUnification(
      nameAsk.rows, nameAsk.items, nameAsk.companies, choice,
    );
    // يرى المستخدم الأسماء الموحَّدة في الجدول لا أسماءه الأصلية
    setRows(rs => rs.map(r => ({
      ...r,
      item:    itemMap.get(r.item.trim()) ?? r.item,
      company: compMap.get(r.company.trim()) ?? r.company,
    })));
    await doSave(finalRows, remember);
  };

  // ── Smart-confirm mode: walk each field, auto-zoom the image to it, and
  // highlight the matching cell in the grid so the two are seen together. ──
  const [confirm, setConfirm] = useState<number | null>(null);
  type Step = { kind: 'header' | 'customer' | 'row'; row: number; imageIndex: number | null; box: number[] | null };
  const steps: Step[] = [];
  {
    const seen = new Set<number>();
    rows.forEach((r, i) => {
      const imgKey = r.imageIndex ?? -1;
      // header (warehouse+invoice#+date, one wide block) and customer are per-invoice
      if (!seen.has(imgKey)) {
        seen.add(imgKey);
        if (r.boxHeader)   steps.push({ kind: 'header',   row: i, imageIndex: r.imageIndex, box: r.boxHeader });
        if (r.boxCustomer) steps.push({ kind: 'customer', row: i, imageIndex: r.imageIndex, box: r.boxCustomer });
      }
      if (r.box) steps.push({ kind: 'row', row: i, imageIndex: r.imageIndex, box: r.box });
    });
  }
  const activeStep = confirm != null ? steps[confirm] : null;
  const cellActive = (rowIdx: number, key: keyof Row): boolean => {
    if (!activeStep || activeStep.row !== rowIdx) return false;
    if (activeStep.kind === 'header') return key === 'warehouse' || key === 'invoiceNumber' || key === 'date';
    if (activeStep.kind === 'customer') return key === 'pharmacy' || key === 'area';
    return (['item', 'quantity', 'unitPrice', 'total', 'bonus'] as (keyof Row)[]).includes(key);
  };
  const nextStep = () => setConfirm(c => (c == null ? c : Math.min(steps.length - 1, c + 1)));
  // Scroll the highlighted extracted cell into view on each step so it's visible
  // beside the zoomed image (the grid scrolls horizontally and can hide columns).
  const gridRef = useRef<HTMLDivElement>(null);
  const [dockX, setDockX] = useState(20); // preview window x, docked opposite the active cell
  useEffect(() => {
    if (confirm == null) return;
    requestAnimationFrame(() => {
      const el = gridRef.current?.querySelector('[data-hl="1"]') as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', inline: 'center' }); // instant so we can measure position
      requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const winW = 460;
        // Cell on the left half → dock window to the RIGHT (and vice-versa) so they never overlap
        setDockX((r.left + r.width / 2) < window.innerWidth / 2 ? Math.max(20, window.innerWidth - winW - 20) : 20);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm]);
  useEffect(() => {
    if (confirm == null) return;
    const st = steps[confirm];
    if (st && st.imageIndex != null && images[st.imageIndex]) setPreview(images[st.imageIndex]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm]);
  const startConfirm = () => {
    if (!steps.length) return;
    setConfirm(0);
    const st = steps[0];
    if (st.imageIndex != null && images[st.imageIndex]) setPreview(images[st.imageIndex]);
  };
  const stepLabel = (st: Step | null): string => {
    if (!st) return '';
    const inv = st.imageIndex != null ? ` · فاتورة ${st.imageIndex + 1}` : '';
    if (st.kind === 'header') return `المذخر ورقم الفاتورة والتاريخ${inv}`;
    if (st.kind === 'customer') return `الصيدلية والمنطقة${inv}`;
    return `الصنف: ${rows[st.row]?.item || '—'}${inv}`;
  };

  // أعمدة الصفوف. حقول ترويسة الفاتورة (المذخر/رقم الفاتورة/التاريخ) انتقلت إلى
  // شريط رأس كل فاتورة أدناه — هي واحدة لكل أصنافها، وتكرارها في كل صف هو ما كان
  // يدفع الجدول لتمرير أفقي. العرض بالنسبة المئوية (table-layout: fixed) والنصوص
  // تلتفّ، فيظهر كل شيء بشاشة واحدة والأسماء كاملة.
  const cols: { key: keyof Row; label: string; pct: number; numeric?: boolean }[] = [
    { key: 'item',          label: 'المادة *',        pct: 13 },
    { key: 'company',       label: 'الشركة',          pct: 5.5 },
    { key: 'quantity',      label: 'الكمية *',        pct: 4, numeric: true },
    { key: 'unitPrice',     label: 'سعر الوحدة',      pct: 5, numeric: true },
    { key: 'total',         label: 'السعر الكلي',     pct: 6, numeric: true },
    { key: 'bonus',         label: 'البونص',          pct: 4, numeric: true },
    { key: 'pharmacy',      label: 'الصيدلية',        pct: 11 },
    { key: 'area',          label: 'المنطقة',         pct: 7.5 },
    { key: 'scientificRep', label: 'المندوب العلمي',  pct: 18 },
  ];
  // خانات الفاتورة في أول السطر، مدموجة عمودياً على أصناف الفاتورة نفسها.
  const INV_COLS = [
    { key: 'inv',           label: 'ف',             pct: 3.5 },
    { key: 'warehouse',     label: 'المذخر',        pct: 7.5 },
    { key: 'invoiceNumber', label: 'رقم الفاتورة',  pct: 5 },
    { key: 'date',          label: 'التاريخ',       pct: 7 },
  ];
  // المجموع = 100% بالضبط — تجاوزه (كان 101%) يدفع عمود الحذف خارج الإطار.
  const ACTIONS_PCT = 3;

  // خيارات خانة المندوب العلمي لكل صف: مرشّحو الصف (★) أولاً ثم بقية مندوبي المكتب.
  const repOptionsFor = (r: Row): ComboOpt[] => {
    const seen = new Set<string>();
    const out: ComboOpt[] = [];
    for (const c of r.repCandidates || []) if (!seen.has(c.name)) { seen.add(c.name); out.push({ value: c.name, star: true }); }
    for (const s of sciReps) if (!seen.has(s.name)) { seen.add(s.name); out.push({ value: s.name }); }
    return out;
  };

  /**
   * تغيير المادة أو المنطقة في صفّ ⇒ الخادم يعيد ربط المادة (الشركة والسعر) ويعيد
   * تخمين المندوب العلمي (المنطقة × الشركة × الصنف) — «المنصور» ← «الكاظمية» يبدّل
   * المندوب تلقائياً. ردّ متأخر لصفّ تغيّر بعده يُهمَل.
   */
  const refreshRow = async (i: number, changed: 'item' | 'area', value: string) => {
    const base = rows[i];
    if (!base) return;
    const r = { ...base, [changed]: value };
    setRefreshing(s => new Set(s).add(i));
    try {
      const res = await fetch(`${API}/api/orders/refresh-row`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ changed, row: {
          item: r.item, company: r.company, quantity: Number(r.quantity) || null,
          unitPrice: r.unitPrice !== '' ? Number(r.unitPrice) : null,
          pharmacy: r.pharmacy, area: r.area, invoiceNumber: r.invoiceNumber,
        } }),
      });
      const d = (await res.json())?.data;
      if (!res.ok || !d) return;
      setRows(rs => rs.map((x, idx) => {
        if (idx !== i || x.item !== r.item || x.area !== r.area) return x; // تغيّر الصف بعد الطلب
        const next = { ...x, scientificRep: d.scientificRep || '', repCandidates: d.repCandidates || [] };
        if (changed === 'item') {
          if (d.item) next.item = d.item;
          if (d.company) next.company = d.company;
          if (d.unitPrice != null) {
            next.unitPrice = String(d.unitPrice);
            const q = Number(next.quantity);
            next.total = q ? String(q * Number(d.unitPrice)) : next.total;
          }
        }
        return next;
      }));
      if (d.scientificRep && d.scientificRep !== base.scientificRep) {
        setInfo(`✨ المندوب العلمي صار «${d.scientificRep}» بعد تغيير ${changed === 'item' ? 'المادة' : 'المنطقة'}.`);
      } else if (!d.scientificRep && (d.repCandidates || []).length) {
        setInfo(`لم يُحسم مندوب واحد لهذه ${changed === 'item' ? 'المادة' : 'المنطقة'} — اختر من ${d.repCandidates.length} مرشّحين ★.`);
      }
    } catch { /* التخمين تحسين — فشله لا يمسّ ما كتبه المراجِع */ }
    finally {
      setRefreshing(s => { const n = new Set(s); n.delete(i); return n; });
    }
  };

  /**
   * اختيار مندوب لصفٍّ يعبّئ تلقائياً الصفوف الفارغة المشابهة (نفس المنطقة ونفس
   * الشركة) — المندوب يتحدّد عملياً بالمنطقة × الشركة، فلا داعي لاختياره عشر مرات.
   * لا يمسّ صفاً فيه مندوب، ولا صفاً لا يكون الاسم بين مرشّحيه حين له مرشّحون.
   */
  const pickRep = (i: number, name: string) => {
    const src = rows[i];
    if (!src || !name.trim()) return;
    const ak = normQ(src.area), ck = normQ(src.company);
    const targets = new Set(rows.map((x, idx) => idx).filter(idx => {
      const x = rows[idx];
      if (idx === i || x.scientificRep.trim() || !ak || normQ(x.area) !== ak || normQ(x.company) !== ck) return false;
      return !x.repCandidates?.length || x.repCandidates.some(c => c.name === name);
    }));
    targets.add(i);
    setRows(rs => rs.map((x, idx) => (targets.has(idx) ? { ...x, scientificRep: name } : x)));
    if (targets.size > 1) setInfo(`✨ عُبّئ «${name}» تلقائياً في ${targets.size - 1} صف مشابه (نفس المنطقة والشركة).`);
  };

  // مجموعات الفواتير: صفوف متتالية من نفس الصورة = فاتورة واحدة بشريط رأس واحد.
  // في المراجعة المجمَّعة: صفوف الطلبية الواحدة (ونفس الصورة) مجموعة واحدة.
  type Group = { key: string; imageIndex: number | null; orderId: number | null; idxs: number[] };
  const groups: Group[] = [];
  rows.forEach((r, i) => {
    const k = r.orderId != null ? `ord${r.orderId}|${r.imageIndex ?? ''}` : r.imageIndex == null ? 'manual' : `img${r.imageIndex}`;
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.idxs.push(i);
    else groups.push({ key: k, imageIndex: r.imageIndex, orderId: r.orderId, idxs: [i] });
  });
  /** النقر على رقم طلبية: رسالتها الأصلية أعلى الجدول، وصورتها إن وُجدت. */
  const showOrder = (orderId: number, imageIndex: number | null) => {
    setActiveOrderId(orderId);
    if (imageIndex != null && images[imageIndex]) setPreview(images[imageIndex]);
    srcPanelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const activeOrder = (activeOrderId != null ? orderById.get(activeOrderId) : null) ?? initialOrder;
  // التفاصيل تظهر عند تمرير الماوس فقط (title) — بلا شرح مرئي في الجدول.
  const dupTitle = (i: number): string => {
    const dr = dupRowByIdx.get(i);
    const dg = dupNow?.groups.find(x => x.group === dr?.group);
    if (!dr || !dg) return '';
    const m = dg.match;
    const where = m.inBatch ? 'نفس فاتورة أخرى في هذا الجدول'
      : m.mercato
        ? `محسوبة أصلاً في مبيع ميركاتو «${m.fileName}»: ${[m.invoiceNumber && `طلبية ${m.invoiceNumber}`, m.pharmacy, m.date, m.warehouse, m.rep].filter(Boolean).join(' · ')}`
        : `محفوظة في «${m.fileName}»: ${[m.invoiceNumber && `فاتورة ${m.invoiceNumber}`, m.pharmacy, m.date].filter(Boolean).join(' · ')}`;
    return `${dr.level === 'duplicate' ? 'مكرر' : 'ربما مكرر'} — ${where}${dr.sameQty ? '' : ` (الكمية المحفوظة ${dr.existingQty})`}`;
  };
  const setGroupField = (idxs: number[], key: 'warehouse' | 'invoiceNumber' | 'date', val: string) => {
    const set = new Set(idxs);
    setRows(rs => rs.map((r, idx) => (set.has(idx) ? { ...r, [key]: val } : r)));
  };
  const rowValue = (r: Row) => {
    if (r.total !== '' && isFinite(Number(r.total))) return Number(r.total);
    const q = Number(r.quantity), p = Number(r.unitPrice);
    return isFinite(q) && isFinite(p) ? q * p : 0;
  };
  const rowState = (r: Row): 'bad' | 'warn' | 'ok' | 'empty' => {
    if (!rowHasData(r)) return 'empty';
    if (!r.item.trim() || !(Number(r.quantity) > 0)) return 'bad';
    if (!r.scientificRep.trim()) return 'warn';
    return 'ok';
  };
  const dataRows = rows.filter(rowHasData);
  const missingRep = rows.map((r, i) => ({ r, i })).filter(({ r }) => rowState(r) === 'warn');
  const badRows = rows.filter(r => rowState(r) === 'bad').length;
  const grandTotal = dataRows.reduce((s, r) => s + rowValue(r), 0);
  const focusRow = (i: number, key: keyof Row = 'scientificRep') => {
    const el = gridRef.current?.querySelector(`[data-cell="${i}:${key}"] textarea, [data-cell="${i}:${key}"] input`) as HTMLElement | null;
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => el.focus(), 250); }
  };
  const scrollToGroup = (imageIndex: number) => {
    const key = groups.find(g => g.imageIndex === imageIndex)?.key ?? `img${imageIndex}`;
    const el = gridRef.current?.querySelector(`[data-group="${key}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const askList = nameAsk
    ? [
        ...nameAsk.items.filter(e => e.status === 'ask').map(e => ({ e, kind: 'i' as const })),
        ...nameAsk.companies.filter(e => e.status === 'ask').map(e => ({ e, kind: 'c' as const })),
      ]
    : [];
  const allAnswered = askList.every(({ e, kind }) => choice[kind + '|' + e.raw]);

  return (
    // الضغط على الخلفية خارج الإطار يغلق النافذة. يُشترط أن يبدأ الضغط **وينتهي**
    // على الخلفية نفسها: سحبُ تحديد نصّ من داخل خانة وإفلاته خارج الإطار يُطلق
    // click على الخلفية، ولا يجوز أن يغلق النافذة ويضيع التعديل.
    <div style={overlay}
      onMouseDown={e => { backdropDownRef.current = e.target === e.currentTarget; }}
      onClick={e => {
        if (e.target !== e.currentTarget || !backdropDownRef.current) return;
        backdropDownRef.current = false;
        // إدخال يدوي بلا طلبية: الصفوف المكتوبة غير محفوظة في أي مكان — نسأل أولاً.
        if (!fromPendingOrder && rows.some(rowHasData) && !window.confirm('إغلاق النافذة؟ الصفوف المكتوبة لم تُحفظ بعد.')) return;
        onClose();
      }}>
      {nameAsk && (
        <div style={askOverlay} dir="rtl">
          <div style={askPanel}>
            <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 800, color: '#1e293b' }}>
              ⚠️ أسماء متشابهة — تأكيد قبل الإضافة
            </h3>
            <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#64748b', lineHeight: 1.7 }}>
              وجدنا أسماء قريبة مما هو مسجَّل عندك ولم نجزم أنها نفسها. أكّد لكل اسم:
              هل هو نفس الموجود (فيُوحَّد معه) أم اسم جديد يُضاف كما هو؟ ما تؤكّده
              للمواد يُحفظ فلا نسألك عنه مرة أخرى.
            </p>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <button style={bulkBtn} onClick={() => setChoice(Object.fromEntries(
                askList.map(({ e, kind }) => [kind + '|' + e.raw, String(e.suggestions[0]?.id ?? 'new')])))}>
                ✅ الكل: نفس المقترح الأول
              </button>
              <button style={bulkBtn} onClick={() => setChoice(Object.fromEntries(
                askList.map(({ e, kind }) => [kind + '|' + e.raw, 'new'])))}>
                🆕 الكل: أسماء جديدة
              </button>
            </div>

            <div style={{ maxHeight: '52vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {askList.map(({ e, kind }) => {
                const key = kind + '|' + e.raw;
                return (
                  <div key={key} style={askCard}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
                      {kind === 'i' ? '💊 مادة' : '🏭 شركة'} في فاتورتك:
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>{e.raw}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {e.suggestions.map(s => (
                        <label key={s.id} style={{ ...askOpt, ...(choice[key] === String(s.id) ? askOptOn : null) }}>
                          <input type="radio" name={key} checked={choice[key] === String(s.id)}
                            onChange={() => setChoice(p => ({ ...p, [key]: String(s.id) }))} />
                          <span>نعم، هو نفسه: <b>{s.name}</b></span>
                          <span style={{ marginInlineStart: 'auto', fontSize: 11, color: '#94a3b8' }}>
                            تشابه {Math.round(s.sim * 100)}%
                          </span>
                        </label>
                      ))}
                      <label style={{ ...askOpt, ...(choice[key] === 'new' ? askOptNew : null) }}>
                        <input type="radio" name={key} checked={choice[key] === 'new'}
                          onChange={() => setChoice(p => ({ ...p, [key]: 'new' }))} />
                        <span>لا، اسم مختلف — أضِفه كما هو</span>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={() => setNameAsk(null)} disabled={saving} style={askCancel}>رجوع للتعديل</button>
              <button onClick={confirmNames} disabled={!allAnswered || saving} style={{ ...askOk, opacity: allAnswered && !saving ? 1 : 0.5 }}>
                {saving ? '⏳ جاري الحفظ…' : `تأكيد وحفظ (${askList.length})`}
              </button>
            </div>
          </div>
        </div>
      )}
      <div style={panel} dir="rtl">
        <style>{GRID_CSS}</style>
        <div style={header}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#0f172a' }}>
              {fromPendingOrder
                ? (orderList.length > 1 ? `مراجعة ${orderList.length} طلبيات` : `مراجعة الطلبية #${initialOrder?.id ?? ''}`)
                : 'إضافة مبيعات'}
            </h3>
            {fromPendingOrder && orderList.length === 1 && initialOrder && (
              <div style={subLine}>
                {[initialOrder.senderName, initialOrder.chatTitle, initialOrder.originName ? `محوّلة من ${initialOrder.originName}` : null]
                  .filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
          <button onClick={onClose} style={xBtn} title="إغلاق">✕</button>
        </div>

        {/* شريط الأدوات: المندوب + رفع صورة */}
        <div style={topBar}>
          <label style={lbl}>
            <span>المندوب</span>
            {/* طلبية بوت ⇒ منسدلة لا حقل حرّ. findOrCreateRep في الخادم يُنشئ
                مندوباً جديداً صامتاً عند أي فرق حرف، فينشقّ تاريخ المندوب على
                صفّين في كل تقرير. الاختيار من القائمة يضمن اسماً قائماً حرفياً. */}
            {fromPendingOrder ? (
              <select value={repName} onChange={e => setRepName(e.target.value)} style={{ ...inp, minWidth: 180 }}>
                <option value="">— اختر —</option>
                {reps.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                {repName && !reps.some(r => r.name === repName) && (
                  <option value={repName}>{repName}</option>
                )}
              </select>
            ) : (
              <>
                <input list="rep-suggestions" value={repName} onChange={e => setRepName(e.target.value)}
                  placeholder="اسم المندوب" style={{ ...inp, minWidth: 180 }} />
                <datalist id="rep-suggestions">{reps.map(r => <option key={r.id} value={r.name} />)}</datalist>
              </>
            )}
          </label>
          <span style={{ flex: 1 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', cursor: 'pointer' }}
            title="تُستخرج من الصورة الايتمات المعيّنة لك فقط">
            <input type="checkbox" checked={onlyAssignedItems} onChange={e => setOnlyAssignedItems(e.target.checked)} />
            ايتماتي فقط
          </label>
          <input ref={imgInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={e => onImages(e.target.files)} />
          <button onClick={() => imgInputRef.current?.click()} disabled={extracting} style={imgBtn}
            title="تحليل صورة فاتورة بالذكاء الاصطناعي — يمكن اختيار عدة صور">
            {extracting ? 'جاري التحليل…' : 'رفع صورة فاتورة'}
          </button>
        </div>

        {/* نصّ الطلبية كما وصل — مرجع المراجِع ليقابل الصفوف المستخرَجة بالأصل. */}
        {fromPendingOrder && activeOrder && (
          <div ref={srcPanelRef} style={srcPanel}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: '#64748b' }}>
                الرسالة الأصلية{orderList.length > 1 ? ` — #${activeOrder.id}` : ''}
              </span>
              {orderList.length > 1 && activeOrder.senderName && (
                <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
                  {[activeOrder.senderName, activeOrder.originName ? `محوّلة من ${activeOrder.originName}` : null].filter(Boolean).join(' · ')}
                </span>
              )}
              {orderList.length > 1 && (
                <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginInlineStart: 'auto' }}>
                  {orderList.map(o => (
                    <button key={o.id} onClick={() => showOrder(o.id, null)}
                      title={(o.sourceText || '').slice(0, 200)}
                      style={{ ...ordTab, ...(o.id === activeOrder.id ? ordTabOn : null) }}>
                      #{o.id}
                    </button>
                  ))}
                </span>
              )}
            </div>
            {activeOrder.sourceText
              ? <div style={srcText}>{activeOrder.sourceText}</div>
              : <div style={{ fontSize: 12.5, color: '#64748b' }}>طلبية صورة — انقر رقمها في الجدول لعرض الصورة.</div>}
          </div>
        )}

        {/* Uploaded invoice thumbnails */}
        {images.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {images.map((u, i) => {
              if (!u) return null; // صورة طلبية تعذّر تحميلها — خانتها محجوزة
              const n = rows.filter(r => r.imageIndex === i && rowHasData(r)).length;
              return (
                <button key={i} onClick={() => { setPreview(u); scrollToGroup(i); }} title={`عرض الفاتورة ${i + 1} والانتقال لأصنافها`} style={thumb}>
                  <img src={u} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }} />
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.3 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: '#1e293b' }}>فاتورة {i + 1}</span>
                    <span style={{ fontSize: 10.5, color: n ? '#64748b' : '#b91c1c' }}>{n ? `${n} صنف` : 'بلا أصناف'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Smart-confirm control bar */}
        {confirm != null && activeStep && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: '8px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, position: 'sticky', top: 0, zIndex: 5 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a' }}>التدقيق من الصورة</span>
            <span style={{ fontSize: 12, color: '#475569' }}>{confirm + 1}/{steps.length} — {stepLabel(activeStep)}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setConfirm(c => Math.max(0, (c ?? 0) - 1))} disabled={confirm === 0} style={navBtn}>◀ السابق</button>
            <button onClick={nextStep} disabled={confirm >= steps.length - 1} style={navBtnP}>التالي ▶</button>
            <button onClick={() => setConfirm(null)} style={navBtn}>إنهاء</button>
          </div>
        )}

        {/* Editable rows grid */}
        {/* شريط الحالة — ملخّص حيّ وقابل للنقر: يأخذك لأول صف ينقصه مندوب */}
        {dataRows.length > 0 && (
          <div style={statusBar}>
            <span>{groups.filter(g => g.idxs.some(i => rowHasData(rows[i]))).length} فاتورة</span>
            <span style={dot}>·</span>
            <span>{dataRows.length} صنف</span>
            <span style={dot}>·</span>
            <span style={{ fontWeight: 700, color: '#0f172a' }}>{fmtThousands(String(Math.round(grandTotal)))} {destCurrency}</span>
            <span style={{ flex: 1 }} />
            {missingRep.length > 0 && (
              <button onClick={() => focusRow(missingRep[0].i)} style={{ ...chip, ...chipWarn, cursor: 'pointer', textDecoration: 'underline' }} title="انتقل لأول صف بلا مندوب علمي">
                {missingRep.length} بلا مندوب علمي
              </button>
            )}
            {badRows > 0 && <span style={{ ...chip, ...chipBad }}>{badRows} صف ينقصه مادة أو كمية</span>}
          </div>
        )}
        {/* ملخّص التكرار — الفواتير/الأصناف المحفوظة سابقاً في الملف */}
        {dupDupRows.length > 0 && (
          <div style={{ marginBottom: 6, fontSize: 12, color: '#b91c1c', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>{dupDupRows.length} صف محفوظ سابقاً (مظلّل){dupMercatoRows > 0 && ` — منها ${dupMercatoRows} محسوب أصلاً في مبيع ميركاتو 🏬`}</span>
            <button onClick={() => dropDuplicateRows()} style={dupBtn}>استبعادها</button>
          </div>
        )}

        <div ref={gridRef} style={{ overflowX: 'auto', marginBottom: 12, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5, width: '100%', minWidth: 1100, tableLayout: 'fixed' }}>
            <colgroup>
              {INV_COLS.map(c => <col key={c.key} style={{ width: `${c.pct}%` }} />)}
              {cols.map(c => <col key={c.key} style={{ width: `${c.pct}%` }} />)}
              <col style={{ width: `${ACTIONS_PCT}%` }} />
            </colgroup>
            <thead>
              <tr>
                {INV_COLS.map(c => <th key={c.key} style={{ ...gTh, textAlign: c.key === 'inv' ? 'center' : 'right' }}>{c.label}</th>)}
                {cols.map(c => <th key={c.key} style={{ ...gTh, textAlign: c.numeric ? 'center' : 'right' }}>{c.label}</th>)}
                <th style={gTh}></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, gi) => g.idxs.map((i, k) => {
                const r = rows[i];
                const first = rows[g.idxs[0]];
                const span = g.idxs.length;
                const bad = rowState(r) === 'bad';
                // فاصل واضح بين فاتورة وأخرى: خط أعرض فوق أول صف من كل فاتورة.
                const sep: React.CSSProperties = k === 0 && gi > 0 ? { borderTop: '2px solid #94a3b8' } : {};
                const hdrOn = (key: keyof Row) => cellActive(g.idxs[0], key);
                // خانات الفاتورة (رقم/مذخر/رقم الفاتورة/تاريخ) تُدمَج عمودياً على أصنافها
                // (rowSpan) — كل صنف سطر أفقي واحد، ومعلومات الفاتورة لا تتكرّر.
                const invCell = (key: 'warehouse' | 'invoiceNumber') => (
                  <td key={key} rowSpan={span} data-hl={hdrOn(key) ? '1' : undefined}
                    style={{ ...gTd, ...gInvTd, ...sep, ...(hdrOn(key) ? { background: '#fef9c3' } : null) }}>
                    <AutoText value={first[key]} onChange={v => setGroupField(g.idxs, key, v)} placeholder="—"
                      style={{ ...(key === 'invoiceNumber' ? { direction: 'ltr', textAlign: 'right' } : null), ...(hdrOn(key) ? hlInp : null) }} />
                  </td>
                );
                const dr = dupRowByIdx.get(i);
                const rowBg = dr?.level === 'duplicate' ? '#fef2f2' : dr?.level === 'possible' ? '#fffbeb' : '#fff';
                return (
                <Fragment key={i}>
                <tr className={`msm-row${dr ? (dr.level === 'duplicate' ? ' msm-dup' : ' msm-dup-maybe') : ''}`}
                  data-group={k === 0 ? g.key : undefined} style={{ background: rowBg }}
                  title={dr ? dupTitle(i) : undefined}>
                  {k === 0 && (
                    <td rowSpan={span} style={{ ...gTd, ...gInvTd, ...sep, textAlign: 'center' }}>
                      {g.orderId != null ? (
                        <button onClick={() => showOrder(g.orderId!, g.imageIndex)}
                          style={{ ...invMini, ...(activeOrder?.id === g.orderId && orderList.length > 1 ? { background: '#1e293b', color: '#fff', borderColor: '#1e293b' } : null) }}
                          title="عرض الرسالة الأصلية لهذه الطلبية أعلى الجدول">
                          #{g.orderId}
                        </button>
                      ) : g.imageIndex != null ? (
                        <button onClick={() => images[g.imageIndex!] && setPreview(images[g.imageIndex!])} style={invMini} title="عرض صورة الفاتورة">
                          {g.imageIndex + 1}
                        </button>
                      ) : <span style={{ color: '#94a3b8', fontSize: 11 }}>يدوي</span>}
                    </td>
                  )}
                  {k === 0 && invCell('warehouse')}
                  {k === 0 && invCell('invoiceNumber')}
                  {k === 0 && (
                    <td rowSpan={span} data-hl={hdrOn('date') ? '1' : undefined}
                      style={{ ...gTd, ...gInvTd, ...sep, ...(hdrOn('date') ? { background: '#fef9c3' } : null) }}>
                      <input type="date" value={first.date} onChange={e => setGroupField(g.idxs, 'date', e.target.value)}
                        style={{ ...gCell, padding: '6px 4px', ...(hdrOn('date') ? hlInp : null) }} />
                    </td>
                  )}
                  {cols.map((c, ci) => {
                    const on = cellActive(i, c.key);
                    const cs: React.CSSProperties = on ? hlInp : {};
                    return (
                      <td key={c.key} data-hl={on ? '1' : undefined} data-cell={`${i}:${c.key}`}
                        style={{ ...gTd, ...sep, ...(ci === 0 && bad ? { boxShadow: 'inset -2px 0 0 #dc2626' } : null), ...(on ? { background: '#fef9c3' } : null) }}>
                        {c.numeric ? (
                          <input
                            value={(() => {
                              const v = r[c.key] as string;
                              const money = c.key === 'unitPrice' || c.key === 'total';
                              return money && editingCell !== `${i}:${c.key}` ? fmtThousands(v) : v;
                            })()}
                            inputMode="decimal"
                            onFocus={() => setEditingCell(`${i}:${c.key}`)}
                            onBlur={() => setEditingCell(cur => (cur === `${i}:${c.key}` ? null : cur))}
                            onChange={e => {
                              // تُسقَط فواصل الآلاف من أي لصق — الحالة أرقام خام دائماً.
                              const val = e.target.value.replace(/\./g, '').replace(/,/g, '.');
                              if (c.key === 'quantity' || c.key === 'unitPrice') onQtyPrice(i, c.key, val);
                              else setCell(i, c.key, val);
                            }}
                            style={{ ...gCell, ...cs, textAlign: 'center', direction: 'ltr', fontVariantNumeric: 'tabular-nums' }} />
                        ) : c.key === 'pharmacy' ? (
                          <ComboCell
                            value={r.pharmacy}
                            onChange={v => {
                              // اختيار صيدلية من السيرفي يجلب منطقتها معها.
                              const hit = r.pharmacyCandidates?.find(p => p.name === v);
                              setRows(rs => rs.map((x, idx) => (idx === i
                                ? { ...x, pharmacy: v, ...(hit?.area ? { area: hit.area } : null) }
                                : x)));
                              // منطقة جديدة من الصيدلية المختارة ⇒ مندوبها.
                              if (hit?.area && hit.area !== r.area) setTimeout(() => refreshRow(i, 'area', hit.area!), 0);
                            }}
                            options={(r.pharmacyCandidates || []).map(p => ({ value: p.name, hint: p.area || undefined, star: true }))}
                            title={r.pharmacyCandidates?.length
                              ? `صيدليات قريبة في السيرفي: ${r.pharmacyCandidates.map(p => p.area ? `${p.name} (${p.area})` : p.name).join(' ، ')}`
                              : r.pharmacy}
                            style={cs}
                          />
                        ) : c.key === 'item' ? (
                          <ComboCell
                            value={r.item}
                            onChange={v => setCell(i, 'item', v)}
                            onCommit={v => refreshRow(i, 'item', v)}
                            options={suggest.items.map(it => ({ value: it.name, hint: it.company || undefined }))}
                            title={r.item}
                            style={{ ...cs, fontWeight: 600 }}
                          />
                        ) : c.key === 'company' ? (
                          <ComboCell
                            value={r.company}
                            onChange={v => setCell(i, 'company', v)}
                            options={suggest.companies.map(v => ({ value: v }))}
                            title={r.company}
                            style={{ ...cs, direction: 'ltr', textAlign: 'right' }}
                          />
                        ) : c.key === 'area' ? (
                          <ComboCell
                            value={r.area}
                            onChange={v => setCell(i, 'area', v)}
                            onCommit={v => refreshRow(i, 'area', v)}
                            options={suggest.areas.map(v => ({ value: v }))}
                            title={r.area}
                            style={cs}
                          />
                        ) : c.key === 'scientificRep' ? (
                          <ComboCell
                            value={r.scientificRep}
                            onChange={v => setCell(i, 'scientificRep', v)}
                            onPick={v => pickRep(i, v)}
                            options={repOptionsFor(r)}
                            placeholder={refreshing.has(i) ? '⏳ جاري التخمين…' : r.repCandidates?.length ? `اختر من ${r.repCandidates.length} مرشّحين ▾` : 'اختر مندوباً ▾'}
                            title={r.repCandidates?.length
                              ? `مرشّحون: ${r.repCandidates.map(c => c.name).join(' ، ')}`
                              : 'لم يُعرَف مندوب من المنطقة والشركة — اختر من القائمة'}
                            style={{ ...cs, ...(r.scientificRep.trim() ? null : candTone), ...(refreshing.has(i) ? { opacity: 0.4 } : null) }}
                          />
                        ) : (
                          <>
                            <AutoText value={r[c.key] as string} onChange={v => setCell(i, c.key, v)}
                              title={r[c.key] as string}
                              style={cs} />
                          </>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ ...gTd, ...sep, textAlign: 'center' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <button onClick={() => clearRow(i)} style={clearBtn} title="تفريغ خانات الصف (يبقى الصف فارغاً)">⌫</button>
                      <button onClick={() => removeRow(i)} style={delBtn} title="حذف الصف">×</button>
                    </div>
                  </td>
                </tr>
                </Fragment>
                );
              }))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={addRow} style={addBtn}>+ صف</button>
          {steps.length > 0 && confirm == null && (
            <button onClick={startConfirm} style={confirmBtn} title="تكبير الصورة على كل حقل وإبراز خانته للتدقيق">
              تدقيق من الصورة
            </button>
          )}
        </div>

        {/* Destination */}
        <div style={destBar}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>الحفظ في</span>
          <label style={radio}>
            <input type="radio" checked={destMode === 'condition'} onChange={() => setDestMode('condition')} />
            ملف الكوديشن{originNames.length ? ` (${originNames.join('، ')})` : ''}
          </label>
          <label style={radio}>
            <input type="radio" checked={destMode === 'existing'} onChange={() => setDestMode('existing')} disabled={!files.length} />
            ملف موجود
          </label>
          <label style={radio}>
            <input type="radio" checked={destMode === 'new'} onChange={() => setDestMode('new')} />
            ملف جديد
          </label>
          <span style={{ flex: 1 }} />
          {destMode === 'existing' ? (
            <>
              <select value={destFileId} onChange={e => setDestFileId(Number(e.target.value))} style={{ ...inp, minWidth: 260 }}>
                {files.map(f => (
                  <option key={f.id} value={f.id}>
                    {f.originalName}
                    {/* ملفات بنفس الاسم كثيرة هنا (نفس الإكسل يُرفع أكثر من مرة) — بلا
                       هذا التمييز لا سبيل لمعرفة أي ملف هو المقصود فعلاً */}
                    {f.rowCount != null ? ` — ${f.rowCount} صف` : ''}
                    {f.uploadedAt ? ` — ${new Date(f.uploadedAt).toLocaleDateString('ar-IQ')}` : ''}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: '#64748b' }}>{destCurrency}</span>
            </>
          ) : (
            <>
              {destMode === 'new' && (
                <input value={newFileName} onChange={e => setNewFileName(e.target.value)} placeholder="اسم الملف" style={{ ...inp, minWidth: 220 }} />
              )}
              <select value={newCurrency} onChange={e => setNewCurrency(e.target.value as 'IQD' | 'USD')} style={inp} title="العملة">
                <option value="IQD">IQD</option>
                <option value="USD">USD</option>
              </select>
            </>
          )}
        </div>

        {error && <div style={errBox}>{error}</div>}
        {info && <div style={infoBox}>{info}</div>}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
          <button onClick={onSave} disabled={saving || extracting || checking} style={saveBtn}>
            {checking ? 'جاري فحص الأسماء…' : saving ? 'جاري الحفظ…' : 'حفظ'}
          </button>
          <button onClick={onClose} style={cancelBtn} title={fromPendingOrder ? 'تبقى معلَّقة للمراجعة لاحقاً' : undefined}>
            {fromPendingOrder ? 'إغلاق' : 'إلغاء'}
          </button>
          {/* window.confirm لا confirm: الاسم محجوب في هذا الملف بحالة مؤشّر
              خطوة التأكيد الذكي (const [confirm, setConfirm] أعلاه). */}
          {fromPendingOrder && onCancelPending && (
            <button
              onClick={() => { if (window.confirm(orderList.length > 1 ? `إلغاء الطلبيات المعروضة (${orderList.length}) نهائياً بلا حفظ أي شيء منها؟` : 'إلغاء هذه الطلبية نهائياً بلا حفظ أي شيء منها؟')) onCancelPending(); }}
              style={dangerLink}
            >
              {orderList.length > 1 ? `حذف الطلبيات (${orderList.length})` : 'حذف الطلبية'}
            </button>
          )}
        </div>
      </div>

      {/* Draggable, non-modal preview so image + extracted rows are visible together */}
      {preview && <DraggableImage src={preview} focusBox={activeStep?.box ?? null}
        dockX={confirm != null ? dockX : undefined}
        onClose={() => { setPreview(null); setConfirm(null); }} />}
    </div>
  );
}

// ── small helpers ──
const str = (v: any) => (v == null ? '' : String(v)).trim();
/**
 * مخرجات الاستخراج (صورة أو نصّ طلبية) ← صفوف الشبكة. مشتركة بين رفع صورة هنا
 * وتحميل طلبيات بوت جاهزة — نفس عقد الصف في الحالتين.
 * @param baseIndex  إزاحة أرقام الصور (صور هذه الدفعة تبدأ بعدها)
 * @param fallbackImage  رقم الصورة لصف بلا _imageIndex (null لطلبية نصّية)
 * @param orderId  طلبية البوت صاحبة الصفوف (null لغير الطلبيات)
 */
function mapExtracted(extracted: any[], baseIndex: number, fallbackImage: number | null, orderId: number | null): Row[] {
  return extracted.map(r => ({
    warehouse:     str(r.warehouse),
    invoiceNumber: str(r.invoiceNumber),
    date:          normDate(r.date),
    item:          str(r.item),
    company:       str(r.company),
    quantity:      r.quantity != null ? String(num(r.quantity)) : '',
    unitPrice:     r.unitPrice != null ? String(num(r.unitPrice)) : '',
    total:         r.total != null ? String(num(r.total)) : '',
    bonus:         r.bonus != null ? String(num(r.bonus)) : '',
    pharmacy:      str(r.pharmacy),
    area:          str(r.area),
    scientificRep: str(r.scientificRep),
    repCandidates: Array.isArray(r._repCandidates) ? r._repCandidates : [],
    pharmacyCandidates: Array.isArray(r._pharmacyCandidates) ? r._pharmacyCandidates : [],
    imageIndex:    typeof r._imageIndex === 'number' ? baseIndex + r._imageIndex : fallbackImage,
    orderId,
    box:           Array.isArray(r._box) ? r._box : null,
    boxCustomer:   Array.isArray(r._boxCustomer) ? r._boxCustomer : null,
    boxHeader:     Array.isArray(r._boxHeader) ? r._boxHeader : null,
  }));
}
/**
 * حقول وصفية لا يكتبها المستخدم (مرجع الصورة وإحداثيات التأشير) — لا تُحتسب
 * بيانات. كانت قيمها null تمرّ عبر String() فتصير النص "null"، فيبدو الصف
 * الفارغ مملوءاً ويبقى فوق صفوف الفاتورة المستخرَجة بدل أن تحلّ مكانه.
 */
const META_KEYS = new Set(['imageIndex', 'orderId', 'box', 'boxCustomer', 'boxHeader']);
const rowHasData = (r: Row) =>
  Object.entries(r).some(([k, v]) => !META_KEYS.has(k) && v != null && String(v).trim() !== '');
const normDate = (v: any): string => {
  const s = String(v ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return '';
};

// ── styles ──
const askOverlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10050, padding: 16 };
const askPanel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 20, width: '100%', maxWidth: 620, boxShadow: '0 20px 60px rgba(0,0,0,0.35)' };
const askCard: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 12, padding: 12, background: '#f8fafc' };
const askOpt: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 10px', cursor: 'pointer' };
const askOptOn: React.CSSProperties = { borderColor: '#6366f1', background: '#eef2ff', fontWeight: 700 };
const askOptNew: React.CSSProperties = { borderColor: '#f59e0b', background: '#fffbeb', fontWeight: 700 };
const bulkBtn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const askCancel: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 10, padding: '9px 16px', fontSize: 13, fontWeight: 700, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' };
const askOk: React.CSSProperties = { border: 'none', background: '#4f46e5', color: '#fff', borderRadius: 10, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9999, padding: '24px 12px', overflowY: 'auto' };
const panel: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, width: '100%', maxWidth: 1560, boxShadow: '0 16px 48px rgba(15,23,42,0.25)' };
const header: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid #e2e8f0' };
const xBtn: React.CSSProperties = { background: 'none', border: 'none', fontSize: 20, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 };
const topBar: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 };
const imgBtn: React.CSSProperties = { padding: '7px 14px', background: '#fff', color: '#1e293b', border: '1px solid #cbd5e1', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' };
const thumb: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px 3px 3px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' };
const lbl: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: '#475569' };
const inp: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, direction: 'rtl', outline: 'none', background: '#fff', fontFamily: 'inherit' };
// ── شبكة المراجعة ──
const gTh: React.CSSProperties = { padding: '9px 8px', fontSize: 11.5, fontWeight: 700, color: '#475569', background: '#f8fafc', borderBottom: '1px solid #cbd5e1', position: 'sticky', top: 0, zIndex: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const gTd: React.CSSProperties = { padding: '2px 4px', verticalAlign: 'middle', borderBottom: '1px solid #f1f5f9' };
// الخانة بلا إطار ظاهر حتى المرور/التركيز (CSS .msm-cell) — مظهر جدول رسمي لا نموذج.
const hlInp: React.CSSProperties = { background: '#fffbeb', borderColor: '#f59e0b', fontWeight: 700 };
const candTone: React.CSSProperties = { borderBottom: '1px dashed #cbd5e1' };
const gInvTd: React.CSSProperties = { background: '#fafbfc', borderInlineStart: '1px solid #f1f5f9' };
const invMini: React.CSSProperties = { background: 'none', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 5, padding: '2px 6px', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1.2 };
const statusBar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6, fontSize: 12.5, color: '#475569' };
const chip: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#334155', background: 'none', border: 'none', padding: '2px 4px', fontFamily: 'inherit' };
const chipWarn: React.CSSProperties = { color: '#b45309' };
const chipBad: React.CSSProperties = { color: '#b91c1c' };
// ── تنبيه التكرار ──
const dupBar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#991b1b', fontSize: 12.5 };
const dupBtn: React.CSSProperties = { border: '1px solid #fca5a5', background: '#fff', color: '#b91c1c', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const dupBanner: React.CSSProperties = { padding: '7px 10px', background: '#fee2e2', color: '#7f1d1d', fontSize: 12.5, borderBottom: '1px solid #fecaca' };
const dupBannerSoft: React.CSSProperties = { background: '#fef3c7', color: '#78350f', borderBottom: '1px solid #fde68a' };
const dupTag: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: '#b91c1c', padding: '0 7px 3px', lineHeight: 1.3 };
const GRID_CSS = `
.msm-row:hover > td { background: #f8fafc !important; }
.msm-row.msm-dup > td { background: #fef2f2 !important; }
.msm-row.msm-dup-maybe > td { background: #fffbeb !important; }
.msm-row textarea:hover, .msm-row input:hover { border-color: #cbd5e1 !important; }
.msm-row textarea:focus, .msm-row input:focus { border-color: #94a3b8 !important; border-style: solid !important; background: #fff !important; box-shadow: none; }
.msm-row textarea::placeholder { color: #94a3b8; font-weight: 500; }
`;
const clearBtn: React.CSSProperties = { background: 'none', border: '1px solid #cbd5e1', color: '#64748b', borderRadius: 6, padding: '2px 7px', cursor: 'pointer', fontSize: 12, lineHeight: 1.1 };
const delBtn: React.CSSProperties = { background: 'none', border: '1px solid #fecaca', color: '#f87171', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 14, lineHeight: 1 };
const addBtn: React.CSSProperties = { padding: '6px 12px', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 6, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' };
const confirmBtn: React.CSSProperties = { padding: '6px 12px', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 6, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' };
const navBtn: React.CSSProperties = { padding: '5px 12px', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const navBtnP: React.CSSProperties = { padding: '5px 14px', background: '#1e293b', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const radio: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: '#334155', cursor: 'pointer' };
const errBox: React.CSSProperties = { marginTop: 10, padding: '7px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#b91c1c', fontSize: 12.5 };
const infoBox: React.CSSProperties = { marginTop: 10, padding: '7px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, color: '#334155', fontSize: 12.5 };
const srcPanel: React.CSSProperties = { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 12px', marginBottom: 12 };
const srcText: React.CSSProperties = { whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.65, color: '#1e293b', maxHeight: 140, overflowY: 'auto' };
const saveBtn: React.CSSProperties = { padding: '8px 26px', background: '#1e293b', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13.5, cursor: 'pointer', fontFamily: 'inherit' };
const cancelBtn: React.CSSProperties = { padding: '8px 18px', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 6, fontWeight: 600, fontSize: 13.5, cursor: 'pointer', fontFamily: 'inherit' };
// أزرار التبديل بين رسائل الطلبيات في المراجعة المجمَّعة.
const ordTab: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', color: '#334155', borderRadius: 5, padding: '2px 8px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
const ordTabOn: React.CSSProperties = { background: '#1e293b', borderColor: '#1e293b', color: '#fff' };
const subLine: React.CSSProperties = { fontSize: 12, color: '#64748b', marginTop: 3 };
const dot: React.CSSProperties = { color: '#cbd5e1' };
const destBar: React.CSSProperties = { marginTop: 14, padding: '10px 12px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' };
const dangerLink: React.CSSProperties = { marginInlineStart: 'auto', background: 'none', border: 'none', color: '#b91c1c', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' };
