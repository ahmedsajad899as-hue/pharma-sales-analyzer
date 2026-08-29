import { useState, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';

/**
 * استيراد زيارات الأطباء بالجملة من ملف إكسل خارجي — بديل عن تسجيلها واحدة
 * واحدة من داخل التطبيق. تدفّق العمل: رفع → مطابقة أسماء المندوبين (مرة واحدة
 * لكل اسم مختلف، وليس لكل صف) → مراجعة/تصحيح الصفوف في جدول → حفظ.
 */

const API = import.meta.env.VITE_API_URL || '';

interface RepOpt { id: number; name: string }
interface RepNameEntry { raw: string; key: string; status: string; rep: RepOpt | null; suggestions: { id: number; name: string; score: number }[] }
interface Row {
  _row: number;
  repName: string; repId: number | null;
  doctorName: string; doctorId: number | null;
  specialty: string; areaName: string; areaId: number | null;
  pharmacyName: string;
  itemName: string; itemId: number | null;
  date: string; feedback: string; notes: string;
  lat: number | null; lng: number | null;
}

const FEEDBACK_OPTS: { value: string; label: string }[] = [
  { value: 'pending',        label: '⏳ لم تُحدَّد' },
  { value: 'writing',        label: '✍️ كتابة' },
  { value: 'stocked',        label: '📦 متوفر/مخزَّن' },
  { value: 'interested',     label: '👍 مهتم' },
  { value: 'not_interested', label: '👎 غير مهتم' },
  { value: 'unavailable',    label: '🚫 غير متوفر' },
];

export default function DoctorVisitsImportModal({ token, onClose, onSaved }: {
  token: string;
  onClose: () => void;
  onSaved?: (msg: string) => void;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const [rows, setRows] = useState<Row[]>([]);
  const [reps, setReps] = useState<RepOpt[]>([]);
  const [pendingNames, setPendingNames] = useState<RepNameEntry[]>([]);
  const [unrelatedNames, setUnrelatedNames] = useState<{ raw: string; key: string }[]>([]);
  const [resolvedCount, setResolvedCount] = useState(0);
  // اختيار المستخدم لكل اسم مندوب غير محسوم: معرّف المندوب، أو 'none'
  const [nameChoice, setNameChoice] = useState<Record<string, string>>({});
  const [nameApplied, setNameApplied] = useState(false);
  const [rememberChoices, setRememberChoices] = useState(true);

  /** يبني ملف إكسل نموذجي بالأعمدة والصيغة المتوقّعة + صفوف مثال + ورقة تعليمات. */
  const downloadTemplate = () => {
    const headers = [
      'اسم المندوب', 'اسم الطبيب', 'الاختصاص', 'المنطقة', 'اسم الصيدلية',
      'اسم الايتم', 'التاريخ', 'الفيدباك', 'الملاحظات', 'الموقع',
    ];
    const examples = [
      ['أحمد محمد علي', 'د. سارة أحمد',  'باطنية', 'الكرادة',  'صيدلية النور',   'AMOKLAVIN BID 457MG', '2026-08-20', 'مهتم',  'طلب عينات', '33.3152,44.3661'],
      ['أحمد محمد علي', 'د. علي حسين',   'أطفال',  'المنصور',  'صيدلية الشفاء',  'DEVIT 3',              '2026-08-21', 'كتابة', '',          ''],
      ['حسين قحطان',    'د. مريم كاظم',  'نسائية', 'الحارثية', 'صيدلية الحياة',  'PANTACTIVE 20MG',      '21/08/2026', 'متوفر', 'زيارة ثانية', ''],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...examples]);
    ws['!cols'] = headers.map(() => ({ wch: 22 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'زيارات الأطباء');

    const legend = [
      ['ملاحظات حول تعبئة الملف'],
      [''],
      ['اسم المندوب: اسم المندوب العلمي كما هو مسجَّل في التطبيق (أو مقارب له — إن لم يتطابق تماماً سيُطلب تأكيده مرة واحدة عند الرفع)'],
      ['اسم الطبيب: حقل مطلوب — أي صف بلا اسم طبيب يُتجاهل تلقائياً'],
      ['التاريخ: بصيغة YYYY-MM-DD (مثل 2026-08-20) أو DD/MM/YYYY (مثل 20/08/2026)'],
      ['الفيدباك: مهتم / غير مهتم / كتابة / متوفر (أو مخزّن) / غير متوفر — أي نص آخر أو خانة فارغة تُعامَل كـ"لم تُحدَّد"'],
      ['الموقع: اختياري — يُكتب كخلية واحدة بصيغة "خط العرض,خط الطول" كما في المثال، أو استبدل هذا العمود بعمودين منفصلين بعنوان "خط العرض" و"خط الطول"'],
      ['يمكن حذف صفوف المثال أعلاه قبل تعبئة بياناتك الفعلية.'],
    ];
    const wsLegend = XLSX.utils.aoa_to_sheet(legend);
    wsLegend['!cols'] = [{ wch: 95 }];
    XLSX.utils.book_append_sheet(wb, wsLegend, 'تعليمات');

    XLSX.writeFile(wb, 'نموذج_استيراد_زيارات_الأطباء.xlsx');
  };

  const onFile = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setError(''); setInfo(''); setExtracting(true);
    setRows([]); setNameApplied(false);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API}/api/doctors/visits/import-extract`, { method: 'POST', body: fd, headers: authH });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || j.message || 'فشل قراءة الملف');
      const data = j.data;
      setRows(data.rows ?? []);
      setReps(data.repNames?.reps ?? []);
      setPendingNames(data.repNames?.pending ?? []);
      setUnrelatedNames(data.repNames?.unrelated ?? []);
      setResolvedCount((data.repNames?.resolved ?? []).length);
      if ((data.rows ?? []).length === 0) setInfo('لم يُستخرج أي صف — تأكّد أن الملف يحتوي عمود اسم الطبيب.');
      // لا حاجة لمطابقة إضافية إن لم تكن هناك أسماء غير محسومة
      if ((data.repNames?.pending ?? []).length === 0 && (data.repNames?.unrelated ?? []).length === 0) {
        setNameApplied(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّرت قراءة الملف');
    } finally {
      setExtracting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const needsDecision = useMemo(() => [...pendingNames, ...unrelatedNames.map(u => ({ ...u, status: 'none', rep: null, suggestions: [] as any[] }))], [pendingNames, unrelatedNames]);
  const decidedCount = needsDecision.filter(e => nameChoice[e.key]).length;

  /** يطبّق قرارات المطابقة على كل صفوف الجدول دفعة واحدة. */
  const applyNameMatching = () => {
    const repById = new Map(reps.map(r => [String(r.id), r]));
    const choiceByKey = new Map<string, number | null>();
    for (const e of needsDecision) {
      const c = nameChoice[e.key];
      if (!c) continue;
      choiceByKey.set(e.key, c === 'none' ? null : Number(c));
    }
    setRows(rs => rs.map(r => {
      if (r.repId) return r; // محسوم أصلاً (تطابق تام/رابط محفوظ)
      const key = r.repName ? normalizeLocal(r.repName) : '';
      if (!choiceByKey.has(key)) return r;
      const id = choiceByKey.get(key);
      return { ...r, repId: id ?? null };
    }));
    void repById;
    setNameApplied(true);
  };

  const setCell = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows(rs => rs.filter((_, idx) => idx !== i));

  const readyCount = rows.filter(r => r.repId).length;
  const missingRepCount = rows.length - readyCount;

  const save = async () => {
    if (rows.length === 0) return;
    setSaving(true); setError('');
    try {
      const rememberRepLinks = rememberChoices
        ? needsDecision.filter(e => nameChoice[e.key]).map(e => ({
            fromName: e.raw,
            scientificRepId: nameChoice[e.key] === 'none' ? null : Number(nameChoice[e.key]),
          }))
        : [];
      const res = await fetch(`${API}/api/doctors/visits/import-commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authH },
        body: JSON.stringify({ rows, rememberRepLinks }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || j.message || 'فشل الحفظ');
      const d = j.data;
      onSaved?.(`تمت إضافة ${d.imported} زيارة${d.skipped > 0 ? ` — تم تجاهل ${d.skipped} صف` : ''}.`
        + (d.errors?.length ? `\n${d.errors.slice(0, 5).join('\n')}` : ''));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل الحفظ');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} dir="rtl" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#1e293b' }}>📥 استيراد زيارات من إكسل</h3>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#64748b', lineHeight: 1.7 }}>
          ارفع ملف إكسل يحتوي زيارات الأطباء (عمود لكل من: اسم المندوب، اسم الطبيب، الاختصاص،
          المنطقة، اسم الصيدلية، اسم الايتم، التاريخ، الفيدباك، الملاحظات، والموقع إن وُجد) —
          سيتم ملء زيارات كل مندوب حسب اسمه في الملف. راجع النتيجة وصحّحها قبل الحفظ النهائي.
        </p>

        {rows.length === 0 && (
          <div style={dropZone}>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
              onChange={e => onFile(e.target.files)} />
            <button onClick={() => fileInputRef.current?.click()} disabled={extracting} style={imgBtn}>
              {extracting ? '⏳ جاري القراءة…' : '📄 اختر ملف إكسل'}
            </button>
            <button onClick={downloadTemplate} title="تنزيل ملف إكسل بالأعمدة الصحيحة وصفوف مثال وورقة تعليمات"
              style={templateBtn}>
              ⬇️ تحميل نموذج الملف
            </button>
          </div>
        )}

        {error && <div style={errBox}>⚠️ {error}</div>}
        {info && <div style={infoBox}>{info}</div>}

        {rows.length > 0 && !nameApplied && needsDecision.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#92400e', marginBottom: 8 }}>
              🔗 طابِق أسماء المندوبين أولاً ({decidedCount}/{needsDecision.length}) — يُطبَّق على كل صفوف كل اسم دفعة واحدة
            </div>
            <div style={{ maxHeight: '38vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {needsDecision.map(e => {
                const count = rows.filter(r => r.repName && normalizeLocal(r.repName) === e.key).length;
                return (
                  <div key={e.key} style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0f172a' }}>{e.raw}</div>
                      <span style={{ fontSize: 10.5, color: '#94a3b8' }}>({count} صف)</span>
                    </div>
                    <select
                      value={nameChoice[e.key] ?? ''}
                      onChange={ev => setNameChoice(p => ({ ...p, [e.key]: ev.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 12.5, fontFamily: 'inherit' }}>
                      <option value="">— اختر —</option>
                      {e.suggestions.map(s => (
                        <option key={s.id} value={s.id}>{s.name} (تشابه {Math.round(s.score * 100)}%)</option>
                      ))}
                      {reps.filter(r => !e.suggestions.some(s => s.id === r.id)).map(r => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                      <option value="none">🚫 ليس مندوباً — تجاهل صفوفه</option>
                    </select>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#334155', cursor: 'pointer' }}>
                <input type="checkbox" checked={rememberChoices} onChange={e => setRememberChoices(e.target.checked)} />
                تذكّر هذه المطابقة لملفات لاحقة (ميركاتو والاستيراد القادم)
              </label>
              <button onClick={applyNameMatching} disabled={decidedCount === 0} style={{ ...applyBtn, opacity: decidedCount === 0 ? 0.5 : 1, marginInlineStart: 'auto' }}>
                تطبيق المطابقة على الجدول ({decidedCount})
              </button>
            </div>
          </div>
        )}

        {rows.length > 0 && nameApplied && (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#166534' }}>✅ {readyCount} صف جاهز</span>
              {missingRepCount > 0 && (
                <span style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c' }}>⚠️ {missingRepCount} صف بلا مندوب — صحّحه في الجدول أدناه أو سيُتجاهل</span>
              )}
              <button onClick={() => setNameApplied(false)} style={{ ...bulkBtn, marginInlineStart: 'auto' }}>🔗 إعادة مطابقة الأسماء</button>
            </div>

            <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, maxHeight: '46vh', overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', position: 'sticky', top: 0, zIndex: 1 }}>
                    {['المندوب', 'الطبيب', 'الاختصاص', 'المنطقة', 'الصيدلية', 'الايتم', 'التاريخ', 'الفيدباك', 'الملاحظات', ''].map(h => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ background: !r.repId ? '#fef2f2' : i % 2 ? '#fafbfc' : '#fff' }}>
                      <td style={td}>
                        <select value={r.repId ?? ''} onChange={e => setCell(i, { repId: e.target.value ? Number(e.target.value) : null })}
                          style={{ ...cellInp, minWidth: 130, borderColor: r.repId ? '#e2e8f0' : '#fca5a5' }}>
                          <option value="">{r.repName || '— اختر —'}</option>
                          {reps.map(rp => <option key={rp.id} value={rp.id}>{rp.name}</option>)}
                        </select>
                      </td>
                      <td style={td}><input value={r.doctorName} onChange={e => setCell(i, { doctorName: e.target.value })} style={{ ...cellInp, minWidth: 140 }} /></td>
                      <td style={td}><input value={r.specialty} onChange={e => setCell(i, { specialty: e.target.value })} style={{ ...cellInp, minWidth: 90 }} /></td>
                      <td style={td}><input value={r.areaName} onChange={e => setCell(i, { areaName: e.target.value, areaId: null })} style={{ ...cellInp, minWidth: 90 }} /></td>
                      <td style={td}><input value={r.pharmacyName} onChange={e => setCell(i, { pharmacyName: e.target.value })} style={{ ...cellInp, minWidth: 110 }} /></td>
                      <td style={td}><input value={r.itemName} onChange={e => setCell(i, { itemName: e.target.value, itemId: null })} style={{ ...cellInp, minWidth: 110 }} /></td>
                      <td style={td}><input type="date" value={r.date} onChange={e => setCell(i, { date: e.target.value })} style={{ ...cellInp, minWidth: 120 }} /></td>
                      <td style={td}>
                        <select value={r.feedback} onChange={e => setCell(i, { feedback: e.target.value })} style={{ ...cellInp, minWidth: 100 }}>
                          {FEEDBACK_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                      <td style={td}><input value={r.notes} onChange={e => setCell(i, { notes: e.target.value })} style={{ ...cellInp, minWidth: 120 }} /></td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <button onClick={() => removeRow(i)} title="حذف الصف" style={delBtn}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-start', marginTop: 16 }}>
          {rows.length > 0 && nameApplied && (
            <button onClick={save} disabled={saving || readyCount === 0} style={{ ...saveBtn, opacity: saving || readyCount === 0 ? 0.6 : 1 }}>
              {saving ? '⏳ جاري الحفظ…' : `💾 حفظ ${readyCount} زيارة`}
            </button>
          )}
          <button onClick={onClose} style={cancelBtn}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

/** تطبيع محلي مطابق لِـ normalizeRepName في الخادم — لتجميع صفوف نفس اسم المندوب. */
function normalizeLocal(s: string): string {
  return s.trim()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ـ/g, '')
    .replace(/[ً-ٟ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── styles ──
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9999, padding: '24px 12px', overflowY: 'auto' };
const panel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 20, width: '100%', maxWidth: 1080, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' };
const xBtn: React.CSSProperties = { background: 'none', border: 'none', fontSize: 19, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 };
const dropZone: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center', padding: 22, border: '2px dashed #c7d2fe', borderRadius: 12, background: '#eef2ff' };
const imgBtn: React.CSSProperties = { padding: '9px 18px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const templateBtn: React.CSSProperties = { padding: '9px 18px', background: '#fff', color: '#4338ca', border: '1.5px solid #c7d2fe', borderRadius: 10, fontWeight: 700, fontSize: 13.5, cursor: 'pointer' };
const card: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, background: '#f8fafc' };
const th: React.CSSProperties = { padding: '7px 6px', fontSize: 11, fontWeight: 700, color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '2px solid #e2e8f0' };
const td: React.CSSProperties = { padding: '3px 4px', borderBottom: '1px solid #f1f5f9' };
const cellInp: React.CSSProperties = { width: '100%', padding: '5px 7px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12, direction: 'rtl', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' };
const delBtn: React.CSSProperties = { background: 'none', border: '1px solid #fecaca', color: '#f87171', borderRadius: 6, padding: '1px 8px', cursor: 'pointer', fontSize: 13, lineHeight: 1.4 };
const bulkBtn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, padding: '5px 11px', fontSize: 11.5, fontWeight: 700, color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const applyBtn: React.CSSProperties = { border: 'none', background: '#4f46e5', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 12.5, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' };
const errBox: React.CSSProperties = { marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12.5, whiteSpace: 'pre-line' };
const infoBox: React.CSSProperties = { marginTop: 10, padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, color: '#1d4ed8', fontSize: 12.5 };
const cancelBtn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 10, padding: '9px 16px', fontSize: 13, fontWeight: 700, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' };
const saveBtn: React.CSSProperties = { padding: '10px 22px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer' };
