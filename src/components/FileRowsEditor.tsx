import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface Row {
  id: number;
  repName: string; areaName: string; itemName: string; customerName: string;
  quantity: number; totalValue: number; saleDate: string; recordType: string;
  isManual?: boolean;
  extra: Record<string, any>;
}
interface Col { key: string; label: string; kind: 'core' | 'extra' }

type Edit = { id: number; field: string; value: any };

/**
 * محرّر صفوف الملف المرفوع.
 *
 * التقارير والتصدير تُبنى على صفوف المبيعات لا على ملف الإكسل نفسه، فالتعديل
 * هنا يُطبَّق على تلك الصفوف مباشرةً — أي ينعكس فوراً في كل مكان بلا مزامنة.
 * التعديلات تُجمَّع محلياً ولا تُرسل إلا عند «حفظ»، كي لا يُرسَل طلب لكل خلية.
 */
export default function FileRowsEditor({ fileId, fileName, onClose, onSaved }: {
  fileId: number; fileName: string; onClose: () => void; onSaved?: () => void;
}) {
  const { token } = useAuth();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');
  const [rows, setRows]         = useState<Row[]>([]);
  // ترتيب الأعمدة يأتي من السيرفر مطابقاً لترتيب الملف الأصلي
  const [columns, setColumns] = useState<Col[]>([]);
  // الترتيب الأبجدي: ضغطة على الترويسة ترتّب، وضغطة ثانية تُرجع ترتيب الملف
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [edited, setEdited]     = useState(false);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [search, setSearch]     = useState('');

  // فلترة الأعمدة (مثل AutoFilter بالإكسل) — القيم المستبعدة محفوظة على
  // السيرفر (FileColumnFilter) وتُخفي صفوفها من كل التحليل والتقارير عبر
  // Sale.isHidden، لا من هذا المحرّر فقط.
  const [columnFilters, setColumnFilters] = useState<Map<string, Set<string>>>(new Map());
  const [filterMenuCol, setFilterMenuCol] = useState<string | null>(null);
  const [filterDraft, setFilterDraft]     = useState<Set<string>>(new Set()); // القيم المضمَّنة (غير المستبعدة) أثناء التحرير
  const [filterSearch, setFilterSearch]   = useState('');
  const [filterSaving, setFilterSaving]   = useState(false);

  // تغييرات معلّقة
  const [pending, setPending]       = useState<Map<string, Edit>>(new Map());
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [deletedCols, setDeletedCols] = useState<Set<string>>(new Set());
  const [newRows, setNewRows]       = useState<any[]>([]);
  const [editingCell, setEditingCell] = useState<string | null>(null);
  // تحديد مستطيل من الخلايا لمعرفة مجموعها (مثل الإكسل)
  const [selStart, setSelStart]     = useState<{ r: number; c: number } | null>(null);
  const [selEnd, setSelEnd]         = useState<{ r: number; c: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const dragMovedRef = useRef(false);
  const gridRef       = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(0); // 1 = للأسفل، -1 = للأعلى، 0 = ثابت
  const inputRef = useRef<HTMLInputElement | null>(null);

  /**
   * تمرير افتراضي (virtualization) للصفوف.
   *
   * الملفات تصل لآلاف الصفوف، وكانت كل الصفوف تُقحَم في الـDOM دفعة واحدة —
   * فأي تفاعل (سحب تحديد، فتح قائمة فلتر، حتى مجرد إعادة رسم بسبب تغيير حالة)
   * كان يعيد رسم الجدول كله. هنا نرسم فقط الصفوف الظاهرة + هامش صغير، ونعوّض
   * الباقي بصفّي حشو (spacer) للحفاظ على ارتفاع شريط التمرير الصحيح.
   */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [rowH, setRowH] = useState(27);
  const firstRowRef = useRef<HTMLTableRowElement | null>(null);

  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const update = () => setViewportH(el.clientHeight || 600);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const h = firstRowRef.current?.getBoundingClientRect().height;
    if (h && Math.abs(h - rowH) > 0.5) setRowH(h);
  });

  const load = () => {
    setLoading(true); setErr('');
    fetch(`${API}/api/files/${fileId}/rows`, { headers: H() })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'تعذّر تحميل الصفوف');
        setRows(j.data.rows || []);
        setColumns(j.data.columns || []);
        setEdited(!!j.data.edited);
        setSnapshotAt(j.data.snapshotAt ?? null);
        const cf = new Map<string, Set<string>>();
        for (const f of j.data.columnFilters || []) {
          if (Array.isArray(f.excludedValues) && f.excludedValues.length) cf.set(f.columnKey, new Set(f.excludedValues));
        }
        setColumnFilters(cf);
      })
      .catch(e => setErr(e instanceof Error ? e.message : 'خطأ'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [fileId]);

  const dirty = pending.size > 0 || deletedIds.size > 0 || deletedCols.size > 0 || newRows.length > 0;

  const cellKey = (id: number, field: string) => `${id}|${field}`;

  const getValue = (row: Row, field: string) => {
    const p = pending.get(cellKey(row.id, field));
    if (p) return p.value;
    if (field in row) return (row as any)[field];
    return row.extra?.[field] ?? '';
  };

  /**
   * تسجيل تعديل خلية.
   *
   * الإغلاق (blur) يستدعي هذه الدالة حتى لو فتح المستخدم الخلية ثم خرج منها
   * بلا كتابة — فكانت الخلية تُلوَّن كمعدَّلة لمجرّد النقر عليها. لذا نقارن
   * بالنص الأصلي المعروض: إن تطابق نحذف التعديل بدل تسجيله، فيبقى التلوين
   * (وحالة «توجد تغييرات») حكراً على ما تغيّر فعلاً — ويشمل ذلك إرجاع القيمة
   * يدوياً إلى ما كانت عليه.
   */
  const setValue = (id: number, field: string, value: any) => {
    const row = rows.find(r => r.id === id);
    setPending(prev => {
      const next = new Map(prev);
      const key = cellKey(id, field);
      if (row && String(value ?? '').trim() === origDisp(row, field)) next.delete(key);
      else next.set(key, { id, field, value });
      return next;
    });
  };

  const visibleCols = useMemo(() => columns.filter(c => !deletedCols.has(c.key)), [columns, deletedCols]);

  /**
   * تنظيف ضجيج الفاصلة العشرية الناتج عن تحويل العملة:
   * 121140.0000000001 ← 121140 و 71579.99999999999 ← 71580.
   * التقريب لخانتين ثم إسقاط الأصفار الزائدة.
   */
  const fmtVal = (v: any): string => {
    if (v === null || v === undefined || String(v).trim() === '') return '';
    const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/,/g, ''));
    if (!Number.isFinite(n)) return String(v);
    return String(Number(n.toFixed(2)));
  };

  const numOf = (v: any): number => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  /**
   * إشارة الإرجاع.
   *
   * قاعدة البيانات تخزّن الكمية والقيمة موجبةً دائماً والإشارة تعيش في
   * recordType (نفس اصطلاح محلّل الرفع). لكن المحرّر يعرضها بالسالب كي
   * يصير تحديد مبيع + إرجاع معاً = مبيع ناقص إرجاع مباشرةً، بلا حساب يدوي.
   */
  const SIGNED_FIELDS = new Set(['quantity', 'totalValue']);
  const isReturnType = (rt: any) => String(rt ?? '').trim().toLowerCase() === 'return';
  /** القيمة الرقمية بإشارتها الصحيحة — تُستخدم في الفرز والمجاميع والتحديد. */
  const signedOf = (raw: any, recType: any, field: string): number => {
    const n = numOf(raw);
    return (SIGNED_FIELDS.has(field) && isReturnType(recType)) ? -Math.abs(n) : n;
  };
  /** نص الخلية انطلاقاً من قيمة خام ونوع سجل — الإرجاع بالسالب. */
  const dispOf = (v: any, recType: any, field: string): string => {
    if (!SIGNED_FIELDS.has(field) || !isReturnType(recType)) return fmtVal(v);
    if (v === null || v === undefined || String(v).trim() === '') return '';
    const n = Number(String(v).trim().replace(/,/g, ''));
    return Number.isFinite(n) ? fmtVal(-Math.abs(n)) : fmtVal(v);
  };
  /** قيمة الخلية كما تُعرض الآن — تشمل التعديلات المعلّقة. */
  const dispVal = (row: Row, field: string) =>
    dispOf(getValue(row, field), getValue(row, 'recordType'), field);
  /** القيمة الخام كما وصلت من الخادم، بتجاهل أي تعديل معلّق. */
  const rawOf = (row: Row, field: string) =>
    (field in row ? (row as any)[field] : (row.extra?.[field] ?? ''));
  /** نص الخلية قبل أي تعديل — مرجع المقارنة لمعرفة هل تغيّرت فعلاً. */
  const origDisp = (row: Row, field: string) =>
    dispOf(rawOf(row, field), rawOf(row, 'recordType'), field);
  /** نفس المنطق لصف جديد لم يُحفظ بعد. */
  const newRowSigned = (nr: any, field: string) => signedOf(nr[field], nr.recordType, field);

  /** هل يُخفي أي فلتر عمود فعّال هذا الصف؟ */
  const hiddenByColumnFilter = (row: Row) => {
    for (const [col, excluded] of columnFilters) {
      if (excluded.has(dispVal(row, col))) return true;
    }
    return false;
  };

  const beforeColumnFilter = useMemo(() => {
    const q = search.trim().toLowerCase();
    const live = rows.filter(r => !deletedIds.has(r.id));
    if (!q) return live;
    return live.filter(r =>
      [r.repName, r.areaName, r.itemName, r.customerName, String(r.quantity), String(r.totalValue), r.saleDate]
        .some(v => String(v ?? '').toLowerCase().includes(q)),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, deletedIds, search]);

  const filtered = useMemo(() => {
    if (columnFilters.size === 0) return beforeColumnFilter;
    return beforeColumnFilter.filter(r => !hiddenByColumnFilter(r));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beforeColumnFilter, columnFilters, pending]);

  const hiddenByFilterCount = beforeColumnFilter.length - filtered.length;

  const sortedRows = useMemo(() => {
    if (!sortCol) return filtered; // بلا فرز = ترتيب الملف كما رُفع
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = getValue(a, sortCol);
      const bv = getValue(b, sortCol);
      const an = signedOf(av, getValue(a, 'recordType'), sortCol);
      const bn = signedOf(bv, getValue(b, 'recordType'), sortCol);
      const bothNumeric = av !== '' && bv !== ''
        && Number.isFinite(Number(String(av).replace(/,/g, '')))
        && Number.isFinite(Number(String(bv).replace(/,/g, '')));
      // الأعمدة الرقمية تُرتَّب رقمياً — الترتيب النصي يضع 100 قبل 9
      if (bothNumeric) return an - bn;
      return String(av ?? '').localeCompare(String(bv ?? ''), 'ar');
    });
    return arr;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortCol, pending]);

  /**
   * المجاميع الحيّة: تُحسب من الصفوف الظاهرة فعلاً بعد الحذف والإضافة
   * والتعديلات المعلّقة — فليست رقماً جامداً من وقت التحميل.
   */
  const liveTotals = useMemo(() => {
    const numericCols = visibleCols.filter(c => c.key === 'totalValue' || c.key === 'quantity');
    const out: Record<string, number> = {};
    for (const c of numericCols) out[c.key] = 0;
    for (const row of sortedRows) {
      const rt = getValue(row, 'recordType');
      for (const c of numericCols) out[c.key] += signedOf(getValue(row, c.key), rt, c.key);
    }
    for (const nr of newRows) {
      for (const c of numericCols) out[c.key] += newRowSigned(nr, c.key);
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedRows, newRows, visibleCols, pending]);

  // مجموع الخلايا المحدَّدة — القيم غير الرقمية تُتجاهل
  const selection = useMemo(() => {
    if (!selStart || !selEnd) return null;
    const r1 = Math.min(selStart.r, selEnd.r), r2 = Math.max(selStart.r, selEnd.r);
    const c1 = Math.min(selStart.c, selEnd.c), c2 = Math.max(selStart.c, selEnd.c);
    let sum = 0, numeric = 0, cells = 0;
    for (let r = r1; r <= r2; r++) {
      const row = sortedRows[r];
      if (!row) continue;
      for (let c = c1; c <= c2; c++) {
        const col = visibleCols[c];
        if (!col) continue;
        cells++;
        const raw = getValue(row, col.key);
        const n = Number(String(raw ?? '').replace(/,/g, ''));
        if (String(raw ?? '').trim() !== '' && Number.isFinite(n)) {
          sum += signedOf(raw, getValue(row, 'recordType'), col.key);
          numeric++;
        }
      }
    }
    return { sum, numeric, cells };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selStart, selEnd, sortedRows, visibleCols, pending]);

  /**
   * التمرير التلقائي أثناء السحب.
   *
   * عند سحب التحديد نحو حافة الجدول (العليا أو السفلى) نمرّر المحتوى
   * ونمدّد التحديد صفاً صفاً، فيستمر التحديد إلى ما بعد الشاشة الواحدة.
   * المستمعان على window لا على الحاوية: أثناء السحب قد يخرج المؤشر من
   * الجدول تماماً، ولو اعتمدنا على أحداث الحاوية لتجمّد التمرير هناك.
   */
  useEffect(() => {
    if (!isSelecting) { autoScrollRef.current = 0; return; }
    const EDGE = 48;   // عرض الشريط الحسّاس عند كل حافة
    const STEP = 26;   // بكسلات لكل نبضة

    const onMove = (e: MouseEvent) => {
      const el = gridRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      autoScrollRef.current =
        e.clientY > box.bottom - EDGE ?  1 :
        e.clientY < box.top    + EDGE ? -1 : 0;
    };
    const onUp = () => setIsSelecting(false);

    const timer = window.setInterval(() => {
      const dir = autoScrollRef.current;
      const el  = gridRef.current;
      if (!dir || !el) return;
      const before = el.scrollTop;
      el.scrollTop = before + dir * STEP;
      if (el.scrollTop === before) return; // بلغنا الحافة — لا تمدّد بلا تمرير
      dragMovedRef.current = true;         // هذا سحب لا نقرة
      setSelEnd(prev => (prev
        ? { ...prev, r: Math.max(0, Math.min(sortedRows.length - 1, prev.r + dir)) }
        : prev));
    }, 60);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.clearInterval(timer);
      autoScrollRef.current = 0;
    };
  }, [isSelecting, sortedRows.length]);
  const inSel = (r: number, c: number) => {
    if (!selStart || !selEnd) return false;
    return r >= Math.min(selStart.r, selEnd.r) && r <= Math.max(selStart.r, selEnd.r)
        && c >= Math.min(selStart.c, selEnd.c) && c <= Math.max(selStart.c, selEnd.c);
  };
  const save = async () => {
    if (!dirty) return;
    setSaving(true); setErr('');
    try {
      const body = {
        updates: [...pending.values()],
        deletedRowIds: [...deletedIds],
        deletedColumns: [...deletedCols],
        newRows,
      };
      const r = await fetch(`${API}/api/files/${fileId}/rows`, {
        method: 'PUT', headers: H(), body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || 'فشل الحفظ');
      const s = j.summary || {};
      const msg = `✅ تم الحفظ\n\n• خلايا معدّلة: ${s.updated ?? 0}\n• صفوف محذوفة: ${s.deleted ?? 0}\n• صفوف مضافة: ${s.added ?? 0}\n• أعمدة محذوفة: ${s.columnsRemoved ?? 0}`
        + (s.errors?.length ? `\n\n⚠️ ${s.errors.slice(0, 5).join('\n')}` : '');
      alert(msg);
      setPending(new Map()); setDeletedIds(new Set()); setDeletedCols(new Set()); setNewRows([]);
      load();
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'فشل الحفظ');
    }
    setSaving(false);
  };

  const restore = async () => {
    if (!confirm('سيُرجَع الملف إلى حالته وقت الرفع، وتُلغى كل التعديلات التي أُجريت عليه. متابعة؟')) return;
    setSaving(true); setErr('');
    try {
      const r = await fetch(`${API}/api/files/${fileId}/restore`, { method: 'POST', headers: H() });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || 'فشل الاسترجاع');
      alert(`✅ تم إرجاع الملف كما رُفع (${j.restored} صف)`);
      setPending(new Map()); setDeletedIds(new Set()); setDeletedCols(new Set()); setNewRows([]);
      load();
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'فشل الاسترجاع');
    }
    setSaving(false);
  };

  /** القيم المميّزة لعمود مع عدد صفوفها — لقائمة الفلتر (كل صفوف الملف بصرف النظر عن البحث). */
  const distinctValuesFor = (col: string): { value: string; count: number }[] => {
    const live = rows.filter(r => !deletedIds.has(r.id));
    const counts = new Map<string, number>();
    for (const row of live) {
      const v = dispVal(row, col);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value, 'ar'));
  };

  const openFilterMenu = (col: string) => {
    const excluded = columnFilters.get(col) ?? new Set<string>();
    const included = new Set(distinctValuesFor(col).map(d => d.value).filter(v => !excluded.has(v)));
    setFilterDraft(included);
    setFilterSearch('');
    setFilterMenuCol(col);
  };

  /**
   * قائمة القيم المميّزة للعمود المفتوح فلترته — مُحسَّبة مرّة واحدة فقط عند
   * فتح القائمة أو تغيّر الصفوف، لا في كل إعادة رسم. كانت تُحسَب مباشرةً في
   * الـJSX فتُعاد من الصفر (مسح كل الصفوف + فرز عربي) مع كل ضغطة حرف في
   * بحث القائمة أو كل تأشير/إلغاء صندوق اختيار.
   */
  const filterMenuValues = useMemo(
    () => (filterMenuCol ? distinctValuesFor(filterMenuCol) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterMenuCol, rows, deletedIds],
  );

  /** يحفظ الفلتر على السيرفر — يُعيد حساب Sale.isHidden فوراً فينعكس على كل تحليل وتقرير. */
  const applyColumnFilter = async (col: string, included: Set<string>) => {
    const all = distinctValuesFor(col).map(d => d.value);
    const excludedValues = all.filter(v => !included.has(v));
    setFilterSaving(true);
    try {
      const r = await fetch(`${API}/api/files/${fileId}/column-filters/${encodeURIComponent(col)}`, {
        method: 'PUT', headers: H(), body: JSON.stringify({ excludedValues }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || 'فشل حفظ الفلتر');
      setColumnFilters(prev => {
        const next = new Map(prev);
        if (excludedValues.length) next.set(col, new Set(excludedValues));
        else next.delete(col);
        return next;
      });
      setFilterMenuCol(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'فشل حفظ الفلتر');
    }
    setFilterSaving(false);
  };

  const clearAllFilters = async () => {
    if (!confirm('إلغاء كل فلاتر الأعمدة على هذا الملف؟ ستعود كل الصفوف للظهور في التحليل والتقارير.')) return;
    setFilterSaving(true);
    try {
      const r = await fetch(`${API}/api/files/${fileId}/column-filters`, { method: 'DELETE', headers: H() });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || 'فشل إلغاء الفلاتر');
      setColumnFilters(new Map());
    } catch (e) {
      alert(e instanceof Error ? e.message : 'فشل إلغاء الفلاتر');
    }
    setFilterSaving(false);
  };

  const addRow = () => {
    const blank: any = {
      _tmp: `new-${Date.now()}-${newRows.length}`,
      repName: '', areaName: '', itemName: '', customerName: '',
      quantity: 0, totalValue: 0,
      saleDate: new Date().toISOString().slice(0, 10),
      recordType: 'sale',
      extra: Object.fromEntries(visibleCols.filter(c => c.kind === 'extra').map(c => [c.key, ''])),
    };
    setNewRows(prev => [...prev, blank]);
  };

  const setNewVal = (tmp: string, field: string, value: any) => {
    setNewRows(prev => prev.map(r => {
      if (r._tmp !== tmp) return r;
      if (field in r) return { ...r, [field]: value };
      return { ...r, extra: { ...r.extra, [field]: value } };
    }));
  };

  const TH: React.CSSProperties = {
    padding: '6px 8px', borderBottom: '2px solid #cbd5e1', borderInlineEnd: '1px solid #e2e8f0',
    background: '#f1f5f9', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2,
  };
  const TD: React.CSSProperties = {
    padding: '3px 6px', borderBottom: '1px solid #f1f5f9', borderInlineEnd: '1px solid #f1f5f9',
    fontSize: 12, whiteSpace: 'nowrap', cursor: 'text',
  };

  // نطاق الصفوف الظاهرة فعلياً (+ هامش) — الباقي يُعوَّض بصفّي حشو أسفل/أعلى
  const ROW_OVERSCAN = 10;
  const winStart = Math.max(0, Math.floor(scrollTop / rowH) - ROW_OVERSCAN);
  const winCount = Math.ceil(viewportH / rowH) + ROW_OVERSCAN * 2;
  const winEnd   = Math.min(sortedRows.length, winStart + winCount);
  const windowRows = sortedRows.slice(winStart, winEnd);
  const topPad    = winStart * rowH;
  const bottomPad = (sortedRows.length - winEnd) * rowH;
  const colSpanAll = visibleCols.length + 2;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 4000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12,
    }}>
      <div onClick={e => { e.stopPropagation(); if (filterMenuCol) setFilterMenuCol(null); }} style={{
        background: '#fff', borderRadius: 14, width: 'min(1400px, 98vw)', height: '92vh',
        display: 'flex', flexDirection: 'column', direction: 'rtl', overflow: 'hidden',
        boxShadow: '0 24px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15, color: '#0f172a' }}>📝 تعديل الملف — {fileName}</strong>
          <span style={{ fontSize: 11, color: '#64748b' }}>
            {filtered.length} صف{deletedIds.size > 0 ? ` · ${deletedIds.size} محذوف` : ''}{newRows.length > 0 ? ` · ${newRows.length} جديد` : ''}
          </span>
          {columnFilters.size > 0 && (
            <span title="الصفوف المخفية بالفلتر مستبعدة من كل التحليل والتقارير أيضاً، لا من هذا العرض فقط"
              style={{ fontSize: 10, fontWeight: 700, color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 20, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              🔽 {hiddenByFilterCount} صف مخفي بالفلتر ({columnFilters.size} عمود مفلتَر)
              <button onClick={clearAllFilters} disabled={filterSaving}
                style={{ border: 'none', background: 'none', color: '#7c3aed', cursor: 'pointer', fontWeight: 800, padding: 0, textDecoration: 'underline' }}>
                مسح الكل
              </button>
            </span>
          )}
          {edited && (
            <span title={snapshotAt ? `نسخة أصلية محفوظة بتاريخ ${new Date(snapshotAt).toLocaleString('ar-IQ')}` : ''}
              style={{ fontSize: 10, fontWeight: 700, color: '#b45309', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 20, padding: '2px 8px' }}>
              مُعدَّل — نسخة أصلية محفوظة
            </span>
          )}
          {rows.some(r => r.isManual) && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#15803d', background: '#dcfce7', border: '1px solid #86efac', borderRadius: 20, padding: '2px 8px' }}>
              📷 الصفوف الخضراء أُضيفت من تحليل صور الفواتير
            </span>
          )}
          <button onClick={onClose} style={{ marginInlineStart: 'auto', background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#64748b' }}>✕</button>
        </div>

        <div style={{ padding: '8px 16px', borderBottom: '1px solid #eef2f7', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: '#f8fafc' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 بحث في الصفوف..."
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 12, minWidth: 200 }} />
          <button onClick={addRow} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #7c3aed', background: '#fff', color: '#7c3aed', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            ＋ صف جديد
          </button>
          <button onClick={save} disabled={!dirty || saving}
            style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: dirty ? '#059669' : '#cbd5e1', color: '#fff', fontSize: 12, fontWeight: 800, cursor: dirty && !saving ? 'pointer' : 'not-allowed' }}>
            {saving ? '⏳ جاري الحفظ...' : dirty ? '💾 حفظ التعديلات' : '💾 لا تغييرات'}
          </button>
          {edited && (
            <button onClick={restore} disabled={saving}
              title="يُرجع الملف إلى حالته وقت الرفع ويلغي كل التعديلات"
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #dc2626', background: '#fff', color: '#dc2626', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              ↩️ استرجاع كما رُفع
            </button>
          )}
          <span style={{ fontSize: 11, color: '#94a3b8', marginInlineStart: 'auto' }}>
            انقر على خلية لتعديلها · اسحب لتحديد عدة خلايا (يتابع التمرير عند الحافة) · الإرجاع يظهر بالسالب فيُطرح من المبيع
          </span>
        </div>

        {err && <div style={{ padding: '8px 16px', background: '#fef2f2', color: '#b91c1c', fontSize: 12 }}>⚠️ {err}</div>}

        <div ref={gridRef} style={{ flex: 1, overflow: 'auto' }}
          onMouseUp={() => setIsSelecting(false)}
          onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>⏳ جاري تحميل الصفوف...</div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...TH, width: 34 }} />
                  <th style={{ ...TH, width: 46 }}>#</th>
                  {visibleCols.map(c => (
                    <th key={c.key} style={{ ...TH, position: 'sticky' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, position: 'relative' }}>
                        <button
                          onClick={() => setSortCol(prev => (prev === c.key ? null : c.key))}
                          title={sortCol === c.key ? 'إلغاء الترتيب — رجوع لترتيب الملف' : 'ترتيب حسب هذا العمود'}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 800, color: sortCol === c.key ? '#4f46e5' : '#0f172a', padding: 0, fontFamily: 'inherit' }}
                        >
                          {c.label}{sortCol === c.key ? ' ▲' : ''}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); filterMenuCol === c.key ? setFilterMenuCol(null) : openFilterMenu(c.key); }}
                          title="فلترة قيم هذا العمود — يستثني القيم غير المحدَّدة من كل التحليل والتقارير"
                          style={{
                            border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, padding: 0,
                            color: columnFilters.has(c.key) ? '#7c3aed' : '#94a3b8',
                          }}
                        >🔽</button>
                        {c.kind === 'extra' && (
                          <button
                            onClick={() => { if (confirm('حذف عمود «' + c.label + '» من كل صفوف الملف؟')) setDeletedCols(p => new Set(p).add(c.key)); }}
                            title="حذف هذا العمود من كل الصفوف"
                            style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 11, padding: 0 }}
                          >✕</button>
                        )}
                        {filterMenuCol === c.key && (
                          <div onClick={e => e.stopPropagation()} style={{
                            position: 'absolute', top: '100%', insetInlineStart: 0, marginTop: 6, zIndex: 10,
                            background: '#fff', border: '1px solid #cbd5e1', borderRadius: 10, boxShadow: '0 12px 30px rgba(0,0,0,0.18)',
                            width: 220, maxHeight: 320, display: 'flex', flexDirection: 'column', fontWeight: 400, textAlign: 'right',
                          }}>
                            <div style={{ padding: 8, borderBottom: '1px solid #eef2f7' }}>
                              <input value={filterSearch} onChange={e => setFilterSearch(e.target.value)} placeholder="🔍 بحث بالقيمة..."
                                style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 11, direction: 'rtl', boxSizing: 'border-box' }} />
                              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                <button onClick={() => setFilterDraft(new Set(filterMenuValues.map(d => d.value)))}
                                  style={{ border: 'none', background: 'none', color: '#4f46e5', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: 0 }}>تحديد الكل</button>
                                <button onClick={() => setFilterDraft(new Set())}
                                  style={{ border: 'none', background: 'none', color: '#64748b', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: 0 }}>إلغاء التحديد</button>
                              </div>
                            </div>
                            <div style={{ overflowY: 'auto', padding: 6, flex: 1 }}>
                              {filterMenuValues
                                .filter(d => !filterSearch.trim() || d.value.toLowerCase().includes(filterSearch.trim().toLowerCase()))
                                .map(d => (
                                  <label key={d.value || '∅'} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', fontSize: 11, fontWeight: 400, cursor: 'pointer' }}>
                                    <input type="checkbox" checked={filterDraft.has(d.value)}
                                      onChange={e => setFilterDraft(prev => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(d.value); else next.delete(d.value);
                                        return next;
                                      })} />
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{d.value || '(فارغة)'}</span>
                                    <span style={{ color: '#94a3b8' }}>{d.count}</span>
                                  </label>
                                ))}
                            </div>
                            <div style={{ padding: 8, borderTop: '1px solid #eef2f7', display: 'flex', gap: 6 }}>
                              <button onClick={() => applyColumnFilter(c.key, filterDraft)} disabled={filterSaving}
                                style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: 'none', background: '#4f46e5', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                {filterSaving ? '⏳' : 'تطبيق'}
                              </button>
                              <button onClick={() => setFilterMenuCol(null)}
                                style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#334155', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                إلغاء
                              </button>
                            </div>
                          </div>
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {newRows.map((nr, i) => (
                  <tr key={nr._tmp} style={{ background: '#f5f3ff' }}>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <button onClick={() => setNewRows(p => p.filter(x => x._tmp !== nr._tmp))}
                        title="إزالة الصف الجديد" style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer' }}>✕</button>
                    </td>
                    <td style={{ ...TD, color: '#7c3aed', fontWeight: 700 }}>جديد {i + 1}</td>
                    {visibleCols.map(c => (
                      <td key={c.key} style={TD}>
                        <input
                          value={(c.kind === 'core' ? nr[c.key] : nr.extra?.[c.key]) ?? ''}
                          onChange={e => setNewVal(nr._tmp, c.key, e.target.value)}
                          style={{ width: '100%', minWidth: 90, border: '1px solid #ddd6fe', borderRadius: 4, padding: '2px 4px', fontSize: 12, direction: 'rtl' }} />
                      </td>
                    ))}
                  </tr>
                ))}
                {topPad > 0 && (
                  <tr aria-hidden style={{ height: topPad }}><td colSpan={colSpanAll} style={{ padding: 0, border: 'none' }} /></tr>
                )}
                {windowRows.map((row, i) => {
                  const idx = winStart + i;
                  return (
                  <tr key={row.id} ref={i === 0 ? firstRowRef : undefined} style={{ background: row.isManual ? '#dcfce7' : (idx % 2 ? '#fafbfc' : '#fff') }}>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <button onClick={() => setDeletedIds(p => new Set(p).add(row.id))}
                        title="حذف هذا الصف" style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer' }}>✕</button>
                    </td>
                    <td style={{ ...TD, color: row.isManual ? '#15803d' : '#94a3b8' }} title={row.isManual ? 'أُضيف من تحليل صورة فاتورة' : undefined}>
                      {idx + 1}{row.isManual ? ' 📷' : ''}
                    </td>
                    {visibleCols.map(({ key: field }, ci) => {
                      const k = cellKey(row.id, field);
                      const changed = pending.has(k);
                      const selected = inSel(idx, ci);
                      const negative = SIGNED_FIELDS.has(field) && isReturnType(getValue(row, 'recordType'));
                      return (
                        <td key={field}
                          onMouseDown={() => {
                            // بداية تحديد محتمل — نميّز النقرة عن السحب في mouseUp
                            dragMovedRef.current = false;
                            setIsSelecting(true);
                            setSelStart({ r: idx, c: ci });
                            setSelEnd({ r: idx, c: ci });
                          }}
                          onMouseEnter={() => {
                            if (!isSelecting) return;
                            dragMovedRef.current = true;
                            setSelEnd({ r: idx, c: ci });
                          }}
                          onMouseUp={() => {
                            setIsSelecting(false);
                            // نقرة بلا سحب = تعديل الخلية، والسحب = تحديد فقط
                            if (!dragMovedRef.current) {
                              setSelStart(null); setSelEnd(null);
                              setEditingCell(k);
                              requestAnimationFrame(() => inputRef.current?.focus());
                            }
                          }}
                          style={{ ...TD, userSelect: 'none', cursor: 'cell',
                            background: changed ? '#ecfdf5' : selected ? '#dbeafe' : undefined,
                            outline: selected ? '1px solid #93c5fd' : undefined,
                            color: negative ? '#dc2626' : undefined,
                            fontWeight: changed || negative ? 700 : 400 }}>
                          {editingCell === k ? (
                            <input ref={inputRef} defaultValue={dispVal(row, field)}
                              onBlur={e => { setValue(row.id, field, e.target.value); setEditingCell(null); }}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { setValue(row.id, field, (e.target as HTMLInputElement).value); setEditingCell(null); }
                                if (e.key === 'Escape') setEditingCell(null);
                              }}
                              style={{ width: '100%', minWidth: 90, border: '1px solid #6366f1', borderRadius: 4, padding: '2px 4px', fontSize: 12, direction: 'rtl' }} />
                          ) : (
                            dispVal(row, field)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  );
                })}
                {bottomPad > 0 && (
                  <tr aria-hidden style={{ height: bottomPad }}><td colSpan={colSpanAll} style={{ padding: 0, border: 'none' }} /></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* ── شريط المجاميع — يتغيّر مع كل حذف/إضافة/تعديل ── */}
        <div style={{
          borderTop: '2px solid #e2e8f0', background: '#f8fafc', padding: '8px 16px',
          display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 12,
        }}>
          <span style={{ fontWeight: 800, color: '#0f172a' }}>
            📊 الصفوف: <span style={{ color: '#2563eb' }}>{sortedRows.length + newRows.length}</span>
          </span>

          {liveTotals.totalValue !== undefined && (
            <span style={{ fontWeight: 800, color: '#0f172a' }}>
              الصافي (مبيع − إرجاع):{' '}
              <span style={{ color: liveTotals.totalValue < 0 ? '#dc2626' : '#059669', fontSize: 14 }}>
                {Number(liveTotals.totalValue.toFixed(2)).toLocaleString('en-US')}
              </span>
            </span>
          )}

          {liveTotals.quantity !== undefined && (
            <span style={{ fontWeight: 700, color: '#475569' }}>
              صافي الكمية:{' '}
              <span style={{ color: liveTotals.quantity < 0 ? '#dc2626' : '#7c3aed' }}>
                {Number(liveTotals.quantity.toFixed(2)).toLocaleString('en-US')}
              </span>
            </span>
          )}

          {selection && selection.cells > 1 && (
            <span style={{
              marginInlineStart: 'auto', background: '#dbeafe', border: '1px solid #93c5fd',
              borderRadius: 8, padding: '4px 12px', fontWeight: 800, color: '#1e40af',
            }}>
              🖱️ المحدَّد: {selection.cells} خلية · {selection.numeric} رقمية · المجموع{' '}
              <span style={{ fontSize: 14, color: selection.sum < 0 ? '#b91c1c' : undefined }}>
                {Number(selection.sum.toFixed(2)).toLocaleString('en-US')}
              </span>
              <button onClick={() => { setSelStart(null); setSelEnd(null); }}
                title="إلغاء التحديد"
                style={{ marginInlineStart: 8, border: 'none', background: 'none', color: '#1e40af', cursor: 'pointer', fontWeight: 800 }}>✕</button>
            </span>
          )}

          {(!selection || selection.cells <= 1) && (
            <span style={{ marginInlineStart: 'auto', color: '#94a3b8', fontSize: 11 }}>
              اسحب بالماوس فوق الخلايا لمعرفة مجموعها
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
