import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Modal for adding sales that don't appear in the uploaded Excel files —
 * warehouse (مذخر) invoices. Two entry paths that share one editable review grid:
 *   1) upload invoice image(s) → AI extracts rows → review/correct
 *   2) type rows manually
 * On save the rows become Sale records (via POST /api/sales/manual), either merged
 * into an existing uploaded file or into a brand-new one.
 */

const API = '';

interface FileOpt { id: number; originalName: string; detectedCurrency?: string; }
interface Rep { id: number; name: string; }

interface Row {
  item: string;
  company: string;
  quantity: string;
  unitPrice: string;
  total: string;
  bonus: string;
  pharmacy: string;
  area: string;
}

interface Props {
  token: string;
  files: FileOpt[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}

const emptyRow = (): Row => ({ item: '', company: '', quantity: '', unitPrice: '', total: '', bonus: '', pharmacy: '', area: '' });
const num = (v: any) => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return isFinite(n) ? n : ''; };

export default function ManualSalesModal({ token, files, onClose, onSaved }: Props) {
  const authH = { Authorization: `Bearer ${token}` };

  // Batch-level (per-invoice) fields, applied to every row on save
  const [repName, setRepName]             = useState('');
  const [warehouse, setWarehouse]         = useState('');
  const [invoiceDate, setInvoiceDate]     = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');

  const [rows, setRows] = useState<Row[]>([emptyRow()]);

  // Destination
  const [destMode, setDestMode]     = useState<'existing' | 'new'>(files.length ? 'existing' : 'new');
  const [destFileId, setDestFileId] = useState<number | ''>(files[0]?.id ?? '');
  const [newFileName, setNewFileName] = useState('');
  const [newCurrency, setNewCurrency] = useState<'IQD' | 'USD'>('IQD');

  const [reps, setReps]         = useState<Rep[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [info, setInfo]         = useState('');
  const imgInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${API}/api/representatives`, { headers: authH })
      .then(r => r.json())
      .then(j => { if (Array.isArray(j.data)) setReps(j.data.map((r: any) => ({ id: r.id, name: r.name }))); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const destCurrency = destMode === 'existing'
    ? (files.find(f => f.id === destFileId)?.detectedCurrency || 'IQD')
    : newCurrency;

  // ── Row helpers ──
  const setCell = (i: number, key: keyof Row, val: string) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
  const addRow = () => setRows(rs => [...rs, emptyRow()]);
  const removeRow = (i: number) => setRows(rs => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));
  // Auto-fill total = qty × unitPrice when total is empty
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
    try {
      const fd = new FormData();
      Array.from(fileList).forEach(f => fd.append('images', f));
      const res = await fetch(`${API}/api/sales/extract-invoice`, { method: 'POST', body: fd, headers: authH });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'فشل تحليل الصورة');
      const extracted: any[] = j.data?.rows ?? [];
      if (extracted.length === 0) { setInfo('لم يتم استخراج أي صف من الصورة. جرّب صورة أوضح أو أدخل يدوياً.'); return; }
      // Fill batch fields from the first row if still empty
      const first = extracted[0] || {};
      if (!warehouse && first.warehouse) setWarehouse(String(first.warehouse));
      if (!invoiceNumber && first.invoiceNumber) setInvoiceNumber(String(first.invoiceNumber));
      if (!invoiceDate && first.date) { const d = normDate(first.date); if (d) setInvoiceDate(d); }
      const mapped: Row[] = extracted.map(r => ({
        item:      str(r.item),
        company:   str(r.company),
        quantity:  r.quantity != null ? String(num(r.quantity)) : '',
        unitPrice: r.unitPrice != null ? String(num(r.unitPrice)) : '',
        total:     r.total != null ? String(num(r.total)) : '',
        bonus:     r.bonus != null ? String(num(r.bonus)) : '',
        pharmacy:  str(r.pharmacy),
        area:      str(r.area),
      }));
      // Replace initial empty row, otherwise append
      setRows(rs => (rs.length === 1 && !rowHasData(rs[0]) ? mapped : [...rs, ...mapped]));
      setInfo(`تم استخراج ${mapped.length} صف — راجعها وصحّحها قبل الحفظ.`);
    } catch (e: any) {
      setError(e.message || 'تعذّر تحليل الصورة');
    } finally {
      setExtracting(false);
      if (imgInputRef.current) imgInputRef.current.value = '';
    }
  }, [warehouse, invoiceNumber, invoiceDate, token]);

  // ── Save ──
  const onSave = async () => {
    setError(''); setInfo('');
    const payloadRows = rows
      .filter(r => r.item.trim() && Number(r.quantity) > 0)
      .map(r => ({
        repName, warehouse, invoiceNumber,
        date:       invoiceDate || undefined,
        item:       r.item.trim(),
        company:    r.company.trim() || undefined,
        quantity:   Number(r.quantity),
        totalValue: r.total !== '' ? Number(r.total) : undefined,
        unitPrice:  r.unitPrice !== '' ? Number(r.unitPrice) : undefined,
        bonus:      r.bonus !== '' ? Number(r.bonus) : undefined,
        pharmacy:   r.pharmacy.trim() || undefined,
        area:       r.area.trim() || undefined,
      }));
    if (payloadRows.length === 0) { setError('أضف صفاً واحداً على الأقل باسم مادة وكمية أكبر من صفر.'); return; }
    if (!repName.trim()) { setError('اختر أو اكتب اسم المندوب المسؤول عن هذه المبيعات.'); return; }
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
        body: JSON.stringify({ rows: payloadRows, target }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'فشل الحفظ');
      const added = j.data?.addedCount ?? payloadRows.length;
      onSaved(`تمت إضافة ${added} عملية بيع${j.data?.merged ? ' ودمجها في الملف المحدد' : ' في ملف جديد'}.`);
    } catch (e: any) {
      setError(e.message || 'تعذّر الحفظ');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} dir="rtl" onClick={e => e.stopPropagation()}>
        <div style={header}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1e293b' }}>➕ إضافة مبيعات من فاتورة / يدوياً</h3>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>

        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>
          للمبيعات التي تأتي من فواتير المذاخر ولا تظهر في ملفات Excel. ارفع صورة الفاتورة ليستخرجها الذكاء الاصطناعي، أو اكتب الصفوف يدوياً — ثم راجعها واحفظها.
        </p>

        {/* Image upload */}
        <div style={dropZone}>
          <input ref={imgInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={e => onImages(e.target.files)} />
          <button onClick={() => imgInputRef.current?.click()} disabled={extracting} style={imgBtn}>
            {extracting ? '⏳ جاري تحليل الفاتورة…' : '📷 رفع صورة فاتورة (تحليل ذكي)'}
          </button>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>يفهم نماذج مذاخر مختلفة · يمكن رفع عدة صور</span>
        </div>

        {/* Batch-level fields */}
        <div style={batchGrid}>
          <label style={lbl}>المندوب*
            <input list="rep-suggestions" value={repName} onChange={e => setRepName(e.target.value)}
              placeholder="اسم المندوب" style={inp} />
            <datalist id="rep-suggestions">{reps.map(r => <option key={r.id} value={r.name} />)}</datalist>
          </label>
          <label style={lbl}>المذخر
            <input value={warehouse} onChange={e => setWarehouse(e.target.value)} placeholder="اسم المذخر" style={inp} />
          </label>
          <label style={lbl}>التاريخ
            <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} style={inp} />
          </label>
          <label style={lbl}>رقم الفاتورة
            <input value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} placeholder="—" style={inp} />
          </label>
        </div>

        {/* Editable rows grid */}
        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 780 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['المادة*', 'الشركة', 'الكمية*', 'سعر الوحدة', 'السعر الكلي', 'البونص', 'الصيدلية', 'المنطقة', ''].map(h => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={td}><input value={r.item} onChange={e => setCell(i, 'item', e.target.value)} style={cell} /></td>
                  <td style={td}><input value={r.company} onChange={e => setCell(i, 'company', e.target.value)} style={cell} /></td>
                  <td style={td}><input value={r.quantity} onChange={e => onQtyPrice(i, 'quantity', e.target.value)} style={cellNum} inputMode="decimal" /></td>
                  <td style={td}><input value={r.unitPrice} onChange={e => onQtyPrice(i, 'unitPrice', e.target.value)} style={cellNum} inputMode="decimal" /></td>
                  <td style={td}><input value={r.total} onChange={e => setCell(i, 'total', e.target.value)} style={cellNum} inputMode="decimal" /></td>
                  <td style={td}><input value={r.bonus} onChange={e => setCell(i, 'bonus', e.target.value)} style={cellNum} inputMode="decimal" /></td>
                  <td style={td}><input value={r.pharmacy} onChange={e => setCell(i, 'pharmacy', e.target.value)} style={cell} /></td>
                  <td style={td}><input value={r.area} onChange={e => setCell(i, 'area', e.target.value)} style={cell} /></td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <button onClick={() => removeRow(i)} style={delBtn} title="حذف الصف">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button onClick={addRow} style={addBtn}>＋ صف جديد</button>

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
              <select value={destFileId} onChange={e => setDestFileId(Number(e.target.value))} style={{ ...inp, minWidth: 240 }}>
                {files.map(f => <option key={f.id} value={f.id}>{f.originalName}</option>)}
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
          <button onClick={onSave} disabled={saving || extracting} style={saveBtn}>
            {saving ? '⏳ جاري الحفظ…' : '💾 حفظ المبيعات'}
          </button>
          <button onClick={onClose} style={cancelBtn}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

// ── small helpers ──
const str = (v: any) => (v == null ? '' : String(v)).trim();
const rowHasData = (r: Row) => Object.values(r).some(v => String(v).trim() !== '');
const normDate = (v: any): string => {
  const s = String(v ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return '';
};

// ── styles ──
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9999, padding: '24px 12px', overflowY: 'auto' };
const panel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 22, width: '100%', maxWidth: 920, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' };
const header: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 };
const xBtn: React.CSSProperties = { background: 'none', border: 'none', fontSize: 20, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 };
const dropZone: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: 14, border: '2px dashed #c7d2fe', borderRadius: 12, background: '#eef2ff', marginBottom: 14 };
const imgBtn: React.CSSProperties = { padding: '9px 18px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const batchGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 14 };
const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#475569' };
const inp: React.CSSProperties = { padding: '7px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, direction: 'rtl', outline: 'none', background: '#fafafa' };
const th: React.CSSProperties = { padding: '8px 6px', fontSize: 11, fontWeight: 700, color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '3px 4px' };
const cell: React.CSSProperties = { width: '100%', minWidth: 90, padding: '6px 8px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, direction: 'rtl', outline: 'none' };
const cellNum: React.CSSProperties = { ...cell, minWidth: 70, textAlign: 'left' };
const delBtn: React.CSSProperties = { background: 'none', border: '1px solid #fecaca', color: '#f87171', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 14, lineHeight: 1 };
const addBtn: React.CSSProperties = { padding: '7px 14px', background: '#f1f5f9', color: '#475569', border: '1px dashed #cbd5e1', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const radio: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#334155', cursor: 'pointer' };
const errBox: React.CSSProperties = { marginTop: 12, padding: '9px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 };
const infoBox: React.CSSProperties = { marginTop: 12, padding: '9px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, color: '#166534', fontSize: 13 };
const saveBtn: React.CSSProperties = { padding: '10px 24px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const cancelBtn: React.CSSProperties = { padding: '10px 20px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: 'pointer' };
