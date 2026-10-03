import { useEffect, useRef, useState } from 'react';
import SmartSuggestInput from './SmartSuggestInput';

/**
 * Modal for company_manager / team_leader: download a personal Excel template
 * (their companies/items/team-rep names), fill in pharmacy sales that went
 * through a warehouse (مذخر) but never made it into the Mercato file, then
 * re-upload it here. Saved rows become Sale records tagged sourceSystem:
 * 'mercato' (POST /api/sales/manual with target.sourceSystem) so every
 * Mercato-based report/KPI counts them automatically — see
 * scientific-reps.service.js's office/mercato split.
 */

const API = '';

interface Props {
  token: string;
  onClose: () => void;
  onSaved: (msg: string, fileId?: number) => void;
}

interface GapRow {
  date: string; pharmacy: string; area: string; repName: string; company: string;
  item: string; quantity: string; unitPrice: string; totalValue: string;
  warehouse: string; invoiceNumber: string; notes: string;
}

type NameCheck = {
  raw: string; status: 'exact' | 'ask' | 'new';
  canonical?: { id: number; name: string };
  suggestions: { id: number; name: string; sim: number }[];
};

const num = (v: any) => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return isFinite(n) ? n : ''; };
const emptyRow = (): GapRow => ({ date: '', pharmacy: '', area: '', repName: '', company: '', item: '', quantity: '', unitPrice: '', totalValue: '', warehouse: '', invoiceNumber: '', notes: '' });

interface Scope { reps: string[]; items: string[]; companies: string[]; warehouses: string[]; }

export default function WarehouseGapImportModal({ token, onClose, onSaved }: Props) {
  const authH = { Authorization: `Bearer ${token}` };
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<GapRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [newFileName, setNewFileName] = useState(`مبيعات مذاخر ناقصة من ميركاتو ${new Date().toLocaleDateString('en-GB')}`);
  const [currency, setCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [nameAsk, setNameAsk] = useState<{ items: NameCheck[]; companies: NameCheck[] } | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  // نطاق المستخدم (شركاته/ايتماته/فريقه/مذاخره) لتغذية الاقتراحات الذكية في
  // جدول المراجعة — نفس البيانات المبنيّة منها نموذج الإكسل، بصيغة JSON.
  const [scope, setScope] = useState<Scope>({ reps: [], items: [], companies: [], warehouses: [] });

  useEffect(() => {
    fetch(`${API}/api/sales/warehouse-gap-scope`, { headers: authH })
      .then(r => r.json())
      .then(j => { if (j?.data) setScope(j.data); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addManualRow = () => setRows(rs => [...rs, emptyRow()]);

  const downloadTemplate = async () => {
    setError(''); setDownloading(true);
    try {
      const res = await fetch(`${API}/api/sales/warehouse-gap-template`, { headers: authH });
      if (!res.ok) throw new Error('تعذّر تنزيل النموذج');
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const m = disposition.match(/filename="?([^"]+)"?/);
      const filename = m ? decodeURIComponent(m[1]) : 'نموذج مبيعات مذاخر.xlsx';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message || 'تعذّر تنزيل النموذج');
    } finally {
      setDownloading(false);
    }
  };

  const onFile = async (f: File | null) => {
    if (!f) return;
    setError(''); setWarnings([]); setParsing(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch(`${API}/api/sales/warehouse-gap-parse`, { method: 'POST', body: fd, headers: authH });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'فشل قراءة الملف');
      const parsed: any[] = j.data?.rows ?? [];
      setWarnings(j.data?.warnings ?? []);
      setRows(parsed.map(r => ({
        date: String(r.date ?? '').slice(0, 10), pharmacy: String(r.pharmacy ?? ''), area: String(r.area ?? ''),
        repName: String(r.repName ?? ''), company: String(r.company ?? ''), item: String(r.item ?? ''),
        quantity: r.quantity != null ? String(num(r.quantity)) : '',
        unitPrice: r.unitPrice != null ? String(num(r.unitPrice)) : '',
        totalValue: r.totalValue != null ? String(num(r.totalValue)) : '',
        warehouse: String(r.warehouse ?? ''), invoiceNumber: String(r.invoiceNumber ?? ''), notes: String(r.notes ?? ''),
      })));
      if (parsed.length === 0) setError('لم يتم العثور على أي صف صالح في الملف.');
    } catch (e: any) {
      setError(e.message || 'تعذّر قراءة الملف');
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const setCell = (i: number, key: keyof GapRow, val: string) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
  const removeRow = (i: number) => setRows(rs => rs.filter((_, idx) => idx !== i));

  const buildPayload = () => rows
    .filter(r => r.item.trim() && r.repName.trim() && Number(r.quantity) > 0)
    .map(r => ({
      repName: r.repName.trim(),
      item: r.item.trim(),
      company: r.company.trim() || undefined,
      quantity: Number(r.quantity),
      totalValue: r.totalValue !== '' ? Number(r.totalValue) : undefined,
      unitPrice: r.unitPrice !== '' ? Number(r.unitPrice) : undefined,
      pharmacy: r.pharmacy.trim() || undefined,
      warehouse: r.warehouse.trim() || undefined,
      area: r.area.trim() || undefined,
      date: r.date || undefined,
      invoiceNumber: r.invoiceNumber.trim() || undefined,
      notes: r.notes.trim() || undefined,
      source: 'warehouse-gap-template',
    }));

  const doSave = async (payloadRows: any[]) => {
    if (!newFileName.trim()) { setError('اكتب اسماً للملف.'); return; }
    setSaving(true); setError('');
    try {
      const res = await fetch(`${API}/api/sales/manual`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: payloadRows,
          target: { newFileName: newFileName.trim(), sourceCurrency: currency, sourceSystem: 'mercato' },
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'فشل الحفظ');
      const added = j.data?.addedCount ?? payloadRows.length;
      onSaved(`تمت إضافة ${added} عملية بيع ضمن ميركاتو.`, j.data?.uploadedFile?.id);
    } catch (e: any) {
      setError(e.message || 'تعذّر الحفظ');
    } finally {
      setSaving(false);
      setNameAsk(null);
    }
  };

  const applyUnification = (payloadRows: any[], items: NameCheck[], companies: NameCheck[], picks: Record<string, string>) => {
    const build = (list: NameCheck[], prefix: string) => {
      const map = new Map<string, string>();
      for (const e of list) {
        if (e.status === 'exact' && e.canonical) { map.set(e.raw, e.canonical.name); continue; }
        if (e.status !== 'ask') continue;
        const pick = picks[prefix + e.raw];
        if (!pick || pick === 'new') continue;
        const s = e.suggestions.find(x => String(x.id) === pick);
        if (s) map.set(e.raw, s.name);
      }
      return map;
    };
    const itemMap = build(items, 'i|');
    const compMap = build(companies, 'c|');
    return payloadRows.map(r => ({ ...r, item: itemMap.get(r.item) ?? r.item, company: r.company ? (compMap.get(r.company) ?? r.company) : r.company }));
  };

  const onSave = async () => {
    setError('');
    const payloadRows = buildPayload();
    if (payloadRows.length === 0) { setError('لا توجد صفوف صالحة — كل صف يحتاج مندوباً ومادة وكمية أكبر من صفر.'); return; }
    if (!newFileName.trim()) { setError('اكتب اسماً للملف.'); return; }

    setChecking(true);
    let check: { items: NameCheck[]; companies: NameCheck[] } | null = null;
    try {
      const res = await fetch(`${API}/api/sales/check-names`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: payloadRows.map(r => ({ item: r.item, company: r.company })) }),
      });
      if (res.ok) check = (await res.json()).data ?? null;
    } catch { /* فحص الأسماء رفاهية — نكمل بلا توحيد لو تعذّر */ }
    setChecking(false);

    const asks = check ? [...check.items, ...check.companies].filter(e => e.status === 'ask') : [];
    if (asks.length > 0) { setChoice({}); setNameAsk(check); return; }

    const unified = check ? applyUnification(payloadRows, check.items, check.companies, {}) : payloadRows;
    await doSave(unified);
  };

  const confirmNames = async () => {
    if (!nameAsk) return;
    const unified = applyUnification(buildPayload(), nameAsk.items, nameAsk.companies, choice);
    await doSave(unified);
  };

  const askList = nameAsk
    ? [...nameAsk.items.filter(e => e.status === 'ask').map(e => ({ e, kind: 'i' as const })),
       ...nameAsk.companies.filter(e => e.status === 'ask').map(e => ({ e, kind: 'c' as const }))]
    : [];
  const allAnswered = askList.every(({ e, kind }) => choice[kind + '|' + e.raw]);

  const cols: { key: keyof GapRow; label: string; w: number; numeric?: boolean }[] = [
    { key: 'date', label: 'التاريخ', w: 110 },
    { key: 'pharmacy', label: 'الصيدلية', w: 150 },
    { key: 'area', label: 'المنطقة', w: 110 },
    { key: 'repName', label: 'المندوب*', w: 140 },
    { key: 'company', label: 'الشركة', w: 120 },
    { key: 'item', label: 'الايتم*', w: 180 },
    { key: 'quantity', label: 'الكمية*', w: 64, numeric: true },
    { key: 'unitPrice', label: 'سعر الوحدة (اختياري)', w: 100, numeric: true },
    { key: 'totalValue', label: 'الإجمالي (اختياري)', w: 100, numeric: true },
    { key: 'warehouse', label: 'المذخر', w: 110 },
    { key: 'invoiceNumber', label: 'رقم الفاتورة', w: 90 },
    { key: 'notes', label: 'ملاحظات', w: 140 },
  ];

  return (
    <div style={overlay}>
      {nameAsk && (
        <div style={askOverlay} dir="rtl">
          <div style={askPanel}>
            <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 800, color: '#1e293b' }}>⚠️ أسماء متشابهة — تأكيد قبل الإضافة</h3>
            <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#64748b', lineHeight: 1.7 }}>
              وجدنا أسماء قريبة مما هو مسجَّل عندك. أكّد لكل اسم: هل هو نفس الموجود أم اسم جديد؟
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <button style={bulkBtn} onClick={() => setChoice(Object.fromEntries(askList.map(({ e, kind }) => [kind + '|' + e.raw, String(e.suggestions[0]?.id ?? 'new')])))}>✅ الكل: نفس المقترح الأول</button>
              <button style={bulkBtn} onClick={() => setChoice(Object.fromEntries(askList.map(({ e, kind }) => [kind + '|' + e.raw, 'new'])))}>🆕 الكل: أسماء جديدة</button>
            </div>
            <div style={{ maxHeight: '48vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {askList.map(({ e, kind }) => {
                const key = kind + '|' + e.raw;
                return (
                  <div key={key} style={askCard}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{kind === 'i' ? '💊 مادة' : '🏭 شركة'} في ملفك:</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>{e.raw}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {e.suggestions.map(s => (
                        <label key={s.id} style={{ ...askOpt, ...(choice[key] === String(s.id) ? askOptOn : null) }}>
                          <input type="radio" name={key} checked={choice[key] === String(s.id)} onChange={() => setChoice(p => ({ ...p, [key]: String(s.id) }))} />
                          <span>نعم، هو نفسه: <b>{s.name}</b></span>
                          <span style={{ marginInlineStart: 'auto', fontSize: 11, color: '#94a3b8' }}>تشابه {Math.round(s.sim * 100)}%</span>
                        </label>
                      ))}
                      <label style={{ ...askOpt, ...(choice[key] === 'new' ? askOptNew : null) }}>
                        <input type="radio" name={key} checked={choice[key] === 'new'} onChange={() => setChoice(p => ({ ...p, [key]: 'new' }))} />
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
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1e293b' }}>📑 مبيعات مذاخر ناقصة من ميركاتو</h3>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>

        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b', lineHeight: 1.7 }}>
          مبيعات صيدليات تمّت فعلاً عبر أحد المذاخر لكنها لم توثَّق ضمن ملف ميركاتو. حمّل نموذج الإكسل الخاص بك
          (مبني على شركاتك وايتماتك وأسماء فريقك). في الملف: المندوب والشركة والايتم قوائم منسدلة جاهزة للاختيار،
          اليوم يُختار برقم فقط (1-31، الشهر مكتوب بعنوان العمود)، المذخر قائمة اقتراحية يمكن تجاوزها بالكتابة،
          والقيمة الإجمالية تُحسب وتتحدّث تلقائياً داخل الملف بمجرد إدخال الكمية والسعر. اترك السعر فارغاً إن لم
          تعرفه — يُستكمل تلقائياً من سعر المذخر المسجَّل لكل ايتم. ستُحتسب هذه المبيعات تلقائياً ضمن ميركاتو في كل
          التقارير.
        </p>

        <div style={topBar}>
          <button onClick={downloadTemplate} disabled={downloading} style={downloadBtn}>
            {downloading ? '⏳ جاري التنزيل…' : '⬇️ تنزيل نموذج الإكسل الخاص بي'}
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => onFile(e.target.files?.[0] ?? null)} />
          <button onClick={() => fileRef.current?.click()} disabled={parsing} style={uploadBtn}>
            {parsing ? '⏳ جاري القراءة…' : '📤 رفع الملف المعبّأ'}
          </button>
          <button onClick={addManualRow} style={addBtn}>✍️ إضافة صف يدوياً هنا</button>
        </div>

        {warnings.length > 0 && (
          <div style={warnBox}>
            {warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div style={{ overflowX: 'auto', margin: '12px 0', border: '1px solid #e2e8f0', borderRadius: 10 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {cols.map(c => <th key={c.key} style={{ ...th, minWidth: c.w }}>{c.label}</th>)}
                    <th style={{ ...th, minWidth: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      {cols.map(c => (
                        <td key={c.key} style={td}>
                          {c.key === 'date' ? (
                            <input type="date" value={r.date} onChange={e => setCell(i, 'date', e.target.value)} style={cell} />
                          ) : c.key === 'repName' ? (
                            <SmartSuggestInput value={r.repName} onChange={v => setCell(i, 'repName', v)} options={scope.reps} />
                          ) : c.key === 'company' ? (
                            <SmartSuggestInput value={r.company} onChange={v => setCell(i, 'company', v)} options={scope.companies} />
                          ) : c.key === 'item' ? (
                            <SmartSuggestInput value={r.item} onChange={v => setCell(i, 'item', v)} options={scope.items} />
                          ) : c.key === 'warehouse' ? (
                            <SmartSuggestInput value={r.warehouse} onChange={v => setCell(i, 'warehouse', v)} options={scope.warehouses} />
                          ) : c.numeric ? (
                            <input value={r[c.key]} inputMode="decimal" onChange={e => setCell(i, c.key, e.target.value)} style={{ ...cell, textAlign: 'left' }} />
                          ) : (
                            <input value={r[c.key]} onChange={e => setCell(i, c.key, e.target.value)} style={cell} />
                          )}
                        </td>
                      ))}
                      <td style={{ ...td, textAlign: 'center' }}>
                        <button onClick={() => removeRow(i)} style={delBtn} title="حذف الصف">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ padding: 14, background: '#f8fafc', borderRadius: 12, border: '1px solid #e2e8f0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>سيُنشأ ملف جديد مُعلَّم كميركاتو:</span>
              <input value={newFileName} onChange={e => setNewFileName(e.target.value)} style={{ ...cell, minWidth: 260, background: '#fff' }} />
              <select value={currency} onChange={e => setCurrency(e.target.value as 'IQD' | 'USD')} style={{ ...cell, background: '#fff' }}>
                <option value="IQD">IQD</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </>
        )}

        {error && <div style={errBox}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-start', marginTop: 16 }}>
          <button onClick={onSave} disabled={rows.length === 0 || saving || parsing || checking} style={saveBtn}>
            {checking ? '🔎 جاري فحص الأسماء…' : saving ? '⏳ جاري الحفظ…' : '💾 حفظ ضمن ميركاتو'}
          </button>
          <button onClick={onClose} style={cancelBtn}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

// ── styles ──
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9999, padding: '24px 12px', overflowY: 'auto' };
const panel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 22, width: '100%', maxWidth: 1180, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' };
const header: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 };
const xBtn: React.CSSProperties = { background: 'none', border: 'none', fontSize: 20, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 };
const topBar: React.CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap' };
const downloadBtn: React.CSSProperties = { padding: '9px 18px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const uploadBtn: React.CSSProperties = { padding: '9px 18px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const addBtn: React.CSSProperties = { padding: '9px 18px', background: '#f1f5f9', color: '#334155', border: '1px dashed #cbd5e1', borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const th: React.CSSProperties = { padding: '8px 6px', fontSize: 11, fontWeight: 700, color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '3px 4px', verticalAlign: 'top' };
const cell: React.CSSProperties = { width: '100%', padding: '6px 8px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, direction: 'rtl', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' };
const delBtn: React.CSSProperties = { background: 'none', border: '1px solid #fecaca', color: '#f87171', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 14, lineHeight: 1 };
const warnBox: React.CSSProperties = { marginTop: 10, padding: '9px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, color: '#92400e', fontSize: 12.5, lineHeight: 1.8 };
const errBox: React.CSSProperties = { marginTop: 12, padding: '9px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 };
const saveBtn: React.CSSProperties = { padding: '10px 24px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const cancelBtn: React.CSSProperties = { padding: '10px 20px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const askOverlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10050, padding: 16 };
const askPanel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 20, width: '100%', maxWidth: 620, boxShadow: '0 20px 60px rgba(0,0,0,0.35)' };
const askCard: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 12, padding: 12, background: '#f8fafc' };
const askOpt: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 10px', cursor: 'pointer' };
const askOptOn: React.CSSProperties = { borderColor: '#6366f1', background: '#eef2ff', fontWeight: 700 };
const askOptNew: React.CSSProperties = { borderColor: '#f59e0b', background: '#fffbeb', fontWeight: 700 };
const bulkBtn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const askCancel: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 10, padding: '9px 16px', fontSize: 13, fontWeight: 700, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' };
const askOk: React.CSSProperties = { border: 'none', background: '#4f46e5', color: '#fff', borderRadius: 10, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' };
