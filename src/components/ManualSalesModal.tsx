import { useState, useRef, useEffect, useCallback } from 'react';

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
  imageIndex: number | null; // index into `images` this row was extracted from
  box: number[] | null;          // [ymin,xmin,ymax,xmax] 0-1000: this item's row in the image
  boxCustomer: number[] | null;  // pharmacy/area block in the image
  boxHeader: number[] | null;    // whole header block (warehouse + invoice# + date)
}

interface Props {
  token: string;
  files: FileOpt[];
  onClose: () => void;
  onSaved: (msg: string, fileId?: number) => void;
}

/** نتيجة فحص اسم واحد كما يُرجعها /api/sales/check-names. */
type NameCheck = {
  raw: string;
  status: 'exact' | 'ask' | 'new';
  canonical?: { id: number; name: string };
  suggestions: { id: number; name: string; sim: number }[];
};
type NameAsk = { items: NameCheck[]; companies: NameCheck[]; rows: any[] };

const emptyRow = (): Row => ({ warehouse: '', invoiceNumber: '', date: '', item: '', company: '', quantity: '', unitPrice: '', total: '', bonus: '', pharmacy: '', area: '', imageIndex: null, box: null, boxCustomer: null, boxHeader: null });
const num = (v: any) => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return isFinite(n) ? n : ''; };

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

export default function ManualSalesModal({ token, files, onClose, onSaved }: Props) {
  const authH = { Authorization: `Bearer ${token}` };

  const [repName, setRepName] = useState('');            // shared: chosen by the user
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [images, setImages] = useState<string[]>([]);    // object URLs of uploaded invoice photos
  const [preview, setPreview] = useState<string | null>(null);

  // Destination
  const [destMode, setDestMode]     = useState<'existing' | 'new'>(files.length ? 'existing' : 'new');
  const [destFileId, setDestFileId] = useState<number | ''>(files[0]?.id ?? '');
  const [newFileName, setNewFileName] = useState('');
  const [newCurrency, setNewCurrency] = useState<'IQD' | 'USD'>('IQD');

  const [reps, setReps]         = useState<Rep[]>([]);
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

  useEffect(() => {
    fetch(`${API}/api/representatives`, { headers: authH })
      .then(r => r.json())
      .then(j => { if (Array.isArray(j.data)) setReps(j.data.map((r: any) => ({ id: r.id, name: r.name }))); })
      .catch(() => {});
    return () => { imagesRef.current.forEach(u => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const destCurrency = destMode === 'existing'
    ? (files.find(f => f.id === destFileId)?.detectedCurrency || 'IQD')
    : newCurrency;

  // ── Row helpers ──
  const setCell = (i: number, key: keyof Row, val: string) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
  const addRow = () => setRows(rs => {
    const last = rs[rs.length - 1];
    // Carry over per-invoice header fields so entering several items of one invoice is fast
    const seed = last
      ? { ...emptyRow(), warehouse: last.warehouse, invoiceNumber: last.invoiceNumber, date: last.date, pharmacy: last.pharmacy, area: last.area }
      : emptyRow();
    return [...rs, seed];
  });
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

  // ── AI extraction from invoice images ──
  const onImages = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError(''); setInfo(''); setExtracting(true);
    const baseIndex = imagesRef.current.length;
    const newUrls = Array.from(fileList).map(f => URL.createObjectURL(f));
    setImages(prev => [...prev, ...newUrls]);
    try {
      const fd = new FormData();
      Array.from(fileList).forEach(f => fd.append('images', f));
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
      const mapped: Row[] = extracted.map(r => ({
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
        imageIndex:    typeof r._imageIndex === 'number' ? baseIndex + r._imageIndex : baseIndex,
        box:           Array.isArray(r._box) ? r._box : null,
        boxCustomer:   Array.isArray(r._boxCustomer) ? r._boxCustomer : null,
        boxHeader:     Array.isArray(r._boxHeader) ? r._boxHeader : null,
      }));
      // الصفوف الفارغة تُستبدل بالمستخرَج بدل أن تتراكم فوقه؛ وإن كان الجدول
      // كلّه فارغاً صار المستخرَج هو محتواه.
      setRows(rs => {
        const kept = rs.filter(rowHasData);
        return [...kept, ...mapped];
      });
      setInfo(`تم استخراج ${mapped.length} صف — راجعها وصحّحها قبل الحفظ.`
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
    const target = destMode === 'existing'
      ? { fileId: destFileId }
      : { newFileName: newFileName.trim(), sourceCurrency: newCurrency };
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/sales/manual`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: payloadRows, target, rememberItems }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'فشل الحفظ');
      const added = j.data?.addedCount ?? payloadRows.length;
      const remembered = j.data?.rememberedCount ?? 0;
      onSaved(`تمت إضافة ${added} عملية بيع${j.data?.merged ? ' ودمجها في الملف المحدد' : ' في ملف جديد'}.`
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
        warehouse:     r.warehouse.trim() || undefined,
        invoiceNumber: r.invoiceNumber.trim() || undefined,
        date:          r.date || undefined,
        item:          r.item.trim(),
        company:       r.company.trim() || undefined,
        quantity:      Number(r.quantity),
        totalValue:    r.total !== '' ? Number(r.total) : undefined,
        unitPrice:     r.unitPrice !== '' ? Number(r.unitPrice) : undefined,
        bonus:         r.bonus !== '' ? Number(r.bonus) : undefined,
        pharmacy:      r.pharmacy.trim() || undefined,
        area:          r.area.trim() || undefined,
      }));
    if (payloadRows.length === 0) { setError('أضف صفاً واحداً على الأقل باسم مادة وكمية أكبر من صفر.'); return; }
    if (!repName.trim()) { setError('اختر أو اكتب اسم المندوب المسؤول عن هذه المبيعات.'); return; }
    if (destMode === 'existing' && !destFileId) { setError('اختر ملفاً للدمج فيه.'); return; }
    if (destMode === 'new' && !newFileName.trim()) { setError('اكتب اسماً للملف الجديد.'); return; }

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

  const cols: { key: keyof Row; label: string; w: number; numeric?: boolean; wide?: boolean }[] = [
    { key: 'warehouse',     label: 'المذخر',       w: 120 },
    { key: 'invoiceNumber', label: 'رقم الفاتورة', w: 90 },
    { key: 'date',          label: 'التاريخ',      w: 120 },
    { key: 'item',          label: 'المادة*',      w: 220, wide: true },
    { key: 'company',       label: 'الشركة',       w: 100 },
    { key: 'quantity',      label: 'الكمية*',      w: 64,  numeric: true },
    { key: 'unitPrice',     label: 'سعر الوحدة',   w: 80,  numeric: true },
    { key: 'total',         label: 'السعر الكلي',  w: 90,  numeric: true },
    { key: 'bonus',         label: 'البونص',       w: 60,  numeric: true },
    { key: 'pharmacy',      label: 'الصيدلية',     w: 150 },
    { key: 'area',          label: 'المنطقة',      w: 120 },
  ];

  const askList = nameAsk
    ? [
        ...nameAsk.items.filter(e => e.status === 'ask').map(e => ({ e, kind: 'i' as const })),
        ...nameAsk.companies.filter(e => e.status === 'ask').map(e => ({ e, kind: 'c' as const })),
      ]
    : [];
  const allAnswered = askList.every(({ e, kind }) => choice[kind + '|' + e.raw]);

  return (
    <div style={overlay}>
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
        <div style={header}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1e293b' }}>➕ إضافة مبيعات من فاتورة / يدوياً</h3>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>

        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>
          للمبيعات التي تأتي من فواتير المذاخر ولا تظهر في ملفات Excel. ارفع صورة الفاتورة ليستخرجها الذكاء الاصطناعي، أو اكتب الصفوف يدوياً — كل فاتورة تحتفظ بتفاصيلها الخاصة. راجعها ثم احفظها.
        </p>

        {/* Image upload + rep */}
        <div style={topBar}>
          <div style={dropZone}>
            <input ref={imgInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
              onChange={e => onImages(e.target.files)} />
            <button onClick={() => imgInputRef.current?.click()} disabled={extracting} style={imgBtn}>
              {extracting ? '⏳ جاري التحليل…' : '📷 رفع صورة فاتورة (تحليل ذكي)'}
            </button>
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>يفهم نماذج مختلفة · عدة صور (كل فاتورة بتفاصيلها)</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155', cursor: 'pointer', marginTop: 4 }}
              title="عند التفعيل: تُستخرج فقط الايتمات المعيّنة لك، وباقي ايتمات الصورة تُهمَل ولا تُعرض. اسم الايتم يُوحَّد تلقائياً مع اسمه المعيّن.">
              <input type="checkbox" checked={onlyAssignedItems} onChange={e => setOnlyAssignedItems(e.target.checked)} />
              🎯 استخراج ايتماتي المعيّنة فقط
            </label>
          </div>
          <label style={lbl}>المندوب*
            <input list="rep-suggestions" value={repName} onChange={e => setRepName(e.target.value)}
              placeholder="اسم المندوب" style={inp} />
            <datalist id="rep-suggestions">{reps.map(r => <option key={r.id} value={r.name} />)}</datalist>
          </label>
        </div>

        {/* Uploaded invoice thumbnails */}
        {images.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {images.map((u, i) => (
              <button key={i} onClick={() => setPreview(u)} title={`عرض الفاتورة ${i + 1}`} style={thumb}>
                <img src={u} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }} />
                <span style={{ fontSize: 11, color: '#475569' }}>فاتورة {i + 1}</span>
              </button>
            ))}
          </div>
        )}

        {/* Smart-confirm control bar */}
        {confirm != null && activeStep && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: '8px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, position: 'sticky', top: 0, zIndex: 5 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: '#92400e' }}>🎯 تأكيد ذكي</span>
            <span style={{ fontSize: 12, color: '#78350f' }}>{confirm + 1}/{steps.length} — {stepLabel(activeStep)}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setConfirm(c => Math.max(0, (c ?? 0) - 1))} disabled={confirm === 0} style={navBtn}>◀ السابق</button>
            <button onClick={nextStep} disabled={confirm >= steps.length - 1} style={navBtnP}>التالي ▶</button>
            <button onClick={() => setConfirm(null)} style={navBtn}>إنهاء</button>
          </div>
        )}

        {/* Editable rows grid */}
        <div ref={gridRef} style={{ overflowX: 'auto', marginBottom: 12, border: '1px solid #e2e8f0', borderRadius: 10 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {cols.map(c => <th key={c.key} style={{ ...th, minWidth: c.w }}>{c.label}</th>)}
                <th style={{ ...th, minWidth: 44 }}>صورة</th>
                <th style={{ ...th, minWidth: 36 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  {cols.map(c => {
                    const on = cellActive(i, c.key);
                    const cs: React.CSSProperties = { ...cell, minWidth: c.w, ...(on ? { background: '#fffbeb', borderColor: '#f59e0b', fontWeight: 700 } : null) };
                    return (
                      <td key={c.key} data-hl={on ? '1' : undefined} style={{ ...td, ...(on ? { background: '#fef9c3', outline: '2px solid #f59e0b' } : null) }}>
                        {c.wide ? (
                          <textarea value={r[c.key] as string} onChange={e => setCell(i, c.key, e.target.value)}
                            rows={2} title={r[c.key] as string}
                            style={{ ...cs, resize: 'vertical', lineHeight: 1.35, whiteSpace: 'pre-wrap' }} />
                        ) : c.key === 'date' ? (
                          <input type="date" value={r.date} onChange={e => setCell(i, 'date', e.target.value)} style={cs} />
                        ) : c.numeric ? (
                          <input value={r[c.key] as string} inputMode="decimal"
                            onChange={e => (c.key === 'quantity' || c.key === 'unitPrice') ? onQtyPrice(i, c.key, e.target.value) : setCell(i, c.key, e.target.value)}
                            style={{ ...cs, textAlign: 'left' }} />
                        ) : (
                          <input value={r[c.key] as string} onChange={e => setCell(i, c.key, e.target.value)}
                            title={r[c.key] as string} style={cs} />
                        )}
                      </td>
                    );
                  })}
                  <td style={{ ...td, textAlign: 'center' }}>
                    {r.imageIndex != null && images[r.imageIndex]
                      ? <button onClick={() => setPreview(images[r.imageIndex!])} title="عرض صورة الفاتورة" style={imgLinkBtn}>🖼️</button>
                      : <span style={{ color: '#cbd5e1' }}>—</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <button onClick={() => removeRow(i)} style={delBtn} title="حذف الصف">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={addRow} style={addBtn}>＋ صف جديد</button>
          {steps.length > 0 && confirm == null && (
            <button onClick={startConfirm} style={confirmBtn} title="تكبير الصورة على كل حقل وإبراز خانته للتدقيق">
              🎯 تأكيد ذكي من الصورة
            </button>
          )}
        </div>

        {/* Destination */}
        <div style={{ marginTop: 16, padding: 14, background: '#f8fafc', borderRadius: 12, border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 10 }}>وجهة الحفظ</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={radio}>
              <input type="radio" checked={destMode === 'existing'} onChange={() => setDestMode('existing')} disabled={!files.length} />
              دمج في ملف موجود
            </label>
            <label style={radio}>
              <input type="radio" checked={destMode === 'new'} onChange={() => setDestMode('new')} />
              ملف جديد
            </label>
          </div>
          {destMode === 'existing' ? (
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={destFileId} onChange={e => setDestFileId(Number(e.target.value))} style={{ ...inp, minWidth: 280 }}>
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
              <span style={{ fontSize: 12, color: '#64748b' }}>العملة: <b>{destCurrency}</b> — أدخل القيم بهذه العملة</span>
            </div>
          ) : (
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input value={newFileName} onChange={e => setNewFileName(e.target.value)} placeholder="اسم الملف الجديد (مثل: فواتير مذاخر — آب)" style={{ ...inp, minWidth: 260 }} />
              <select value={newCurrency} onChange={e => setNewCurrency(e.target.value as 'IQD' | 'USD')} style={inp}>
                <option value="IQD">IQD</option>
                <option value="USD">USD</option>
              </select>
            </div>
          )}
        </div>

        {error && <div style={errBox}>{error}</div>}
        {info && <div style={infoBox}>{info}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-start', marginTop: 16 }}>
          <button onClick={onSave} disabled={saving || extracting || checking} style={saveBtn}>
            {checking ? '🔎 جاري فحص الأسماء…' : saving ? '⏳ جاري الحفظ…' : '💾 حفظ المبيعات'}
          </button>
          <button onClick={onClose} style={cancelBtn}>إلغاء</button>
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
 * حقول وصفية لا يكتبها المستخدم (مرجع الصورة وإحداثيات التأشير) — لا تُحتسب
 * بيانات. كانت قيمها null تمرّ عبر String() فتصير النص "null"، فيبدو الصف
 * الفارغ مملوءاً ويبقى فوق صفوف الفاتورة المستخرَجة بدل أن تحلّ مكانه.
 */
const META_KEYS = new Set(['imageIndex', 'box', 'boxCustomer', 'boxHeader']);
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
const panel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 22, width: '100%', maxWidth: 1120, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' };
const header: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 };
const xBtn: React.CSSProperties = { background: 'none', border: 'none', fontSize: 20, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 };
const topBar: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap', marginBottom: 12 };
const dropZone: React.CSSProperties = { flex: '1 1 320px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: 12, border: '2px dashed #c7d2fe', borderRadius: 12, background: '#eef2ff' };
const imgBtn: React.CSSProperties = { padding: '9px 18px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' };
const thumb: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 4px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' };
const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#475569', minWidth: 200, justifyContent: 'center' };
const inp: React.CSSProperties = { padding: '7px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, direction: 'rtl', outline: 'none', background: '#fafafa' };
const th: React.CSSProperties = { padding: '8px 6px', fontSize: 11, fontWeight: 700, color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '3px 4px', verticalAlign: 'top' };
const cell: React.CSSProperties = { width: '100%', padding: '6px 8px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, direction: 'rtl', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' };
const cellNum: React.CSSProperties = { ...cell, textAlign: 'left' };
const imgLinkBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1 };
const delBtn: React.CSSProperties = { background: 'none', border: '1px solid #fecaca', color: '#f87171', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 14, lineHeight: 1 };
const addBtn: React.CSSProperties = { padding: '7px 14px', background: '#f1f5f9', color: '#475569', border: '1px dashed #cbd5e1', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const confirmBtn: React.CSSProperties = { padding: '7px 14px', background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const navBtn: React.CSSProperties = { padding: '5px 12px', background: '#fff', color: '#78350f', border: '1px solid #fcd34d', borderRadius: 7, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const navBtnP: React.CSSProperties = { padding: '5px 14px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 12, cursor: 'pointer' };
const radio: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#334155', cursor: 'pointer' };
const errBox: React.CSSProperties = { marginTop: 12, padding: '9px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 };
const infoBox: React.CSSProperties = { marginTop: 12, padding: '9px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, color: '#166534', fontSize: 13 };
const saveBtn: React.CSSProperties = { padding: '10px 24px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const cancelBtn: React.CSSProperties = { padding: '10px 20px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: 'pointer' };
