import { useState, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';
import VisitImportFilesPanel from './VisitImportFilesPanel';

/**
 * استيراد زيارات الأطباء والصيدليات بالجملة من ملف إكسل خارجي — بديل عن
 * تسجيلها واحدة واحدة من داخل التطبيق. تدفّق العمل: رفع → مطابقة أسماء
 * المندوبين (مرة واحدة لكل اسم مختلف، وليس لكل صف) → مراجعة/تصحيح الصفوف في
 * جدول (تبويب منفصل للأطباء وللصيدليات إن وُجد النوعان معاً) → حفظ.
 *
 * يدعم الخادم صيغتين للملف تُكتشَف تلقائياً: قالبنا البسيط (أطباء فقط)، أو
 * تصدير CRM خارجي يخلط أطباء وصيدليات في ملف واحد.
 */

const API = import.meta.env.VITE_API_URL || '';

interface RepOpt { id: number; name: string }
interface RepNameEntry { raw: string; key: string; status: string; rep: RepOpt | null; suggestions: { id: number; name: string; score: number }[] }
interface DoctorSuggestion { id: number; name: string; score: number; areaId?: number | null; areaName: string | null; specialty: string | null; pharmacyName: string | null }
interface DoctorNameEntry { raw: string; key: string; areaName?: string; specialty?: string; pharmacyName?: string; suggestions: DoctorSuggestion[] }
interface DoctorRow {
  _row: number;
  repName: string; repId: number | null;
  doctorName: string; doctorId: number | null; doctorKey?: string;
  // قيَم الملف قبل تبنّي هوية الطبيب المسجَّل في التطبيق — للاطلاع فقط (tooltip)
  rawDoctorName?: string; rawSpecialty?: string; rawAreaName?: string; rawPharmacyName?: string;
  specialty: string; areaName: string; areaId: number | null;
  pharmacyName: string;
  itemName: string; itemId: number | null;
  date: string; feedback: string; notes: string; isDoubleVisit: boolean;
  lat: number | null; lng: number | null;
}
interface PharmacyRow {
  _row: number;
  repName: string; repId: number | null;
  pharmacyName: string;
  areaName: string; areaId: number | null;
  itemName: string; itemId: number | null; // مستخرَجان من حقل note (يُحفظان كـ PharmacyVisitItem)
  date: string; notes: string; isDoubleVisit: boolean;
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

  const [docRows, setDocRows] = useState<DoctorRow[]>([]);
  const [pharmRows, setPharmRows] = useState<PharmacyRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [gridTab, setGridTab] = useState<'doctors' | 'pharmacies'>('doctors');
  const [reps, setReps] = useState<RepOpt[]>([]);
  const [pendingNames, setPendingNames] = useState<RepNameEntry[]>([]);
  const [unrelatedNames, setUnrelatedNames] = useState<{ raw: string; key: string }[]>([]);
  // اختيار المستخدم لكل اسم مندوب غير محسوم: معرّف المندوب، أو 'none'
  const [nameChoice, setNameChoice] = useState<Record<string, string>>({});
  const [nameApplied, setNameApplied] = useState(false);
  const [rememberChoices, setRememberChoices] = useState(true);

  // مطابقة أسماء الأطباء المشكوك بها (خطوة ثانية بعد حسم أسماء المندوبين)
  const [pendingDoctorNames, setPendingDoctorNames] = useState<DoctorNameEntry[]>([]);
  // اختيار المستخدم لكل اسم طبيب غير محسوم: معرّف الطبيب، أو 'new'
  const [doctorChoice, setDoctorChoice] = useState<Record<string, string>>({});
  const [doctorNamesApplied, setDoctorNamesApplied] = useState(false);
  const [rememberDoctorChoices, setRememberDoctorChoices] = useState(true);

  const totalRows = docRows.length + pharmRows.length;

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
      [''],
      ['ملاحظة: يقبل الاستيراد أيضاً ملفات تصدير من أنظمة CRM خارجية بترويسات مختلفة (task-to/client/client-category…) وتُكتشَف تلقائياً — يفصل حينها بين زيارات الأطباء وزيارات الصيدليات تلقائياً حسب نوع العميل في الملف.'],
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
    setDocRows([]); setPharmRows([]); setNameApplied(false); setDoctorNamesApplied(false);
    setNameChoice({}); setDoctorChoice({}); setFileName(file.name);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API}/api/doctors/visits/import-extract`, { method: 'POST', body: fd, headers: authH });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || j.message || 'فشل قراءة الملف');
      const data = j.data;
      const dRows: DoctorRow[] = data.doctorRows ?? [];
      const pRows: PharmacyRow[] = data.pharmacyRows ?? [];
      setDocRows(dRows);
      setPharmRows(pRows);
      setGridTab(dRows.length > 0 || pRows.length === 0 ? 'doctors' : 'pharmacies');
      setReps(data.repNames?.reps ?? []);
      setPendingNames(data.repNames?.pending ?? []);
      setUnrelatedNames(data.repNames?.unrelated ?? []);
      setPendingDoctorNames(data.doctorNames?.pending ?? []);
      if (dRows.length === 0 && pRows.length === 0) {
        setInfo('لم يُستخرج أي صف — تأكّد أن الملف يحتوي عمود اسم الطبيب (أو أنه بصيغة معروفة).');
      } else if (pRows.length > 0) {
        setInfo(`اكتُشف ملف يحتوي زيارات أطباء وصيدليات معاً — ${dRows.length} زيارة طبيب و${pRows.length} زيارة صيدلية.`);
      }
      // لا حاجة لمطابقة إضافية إن لم تكن هناك أسماء غير محسومة
      if ((data.repNames?.pending ?? []).length === 0 && (data.repNames?.unrelated ?? []).length === 0) {
        setNameApplied(true);
      }
      if ((data.doctorNames?.pending ?? []).length === 0) {
        setDoctorNamesApplied(true);
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

  const countForName = (key: string) =>
    docRows.filter(r => r.repName && normalizeLocal(r.repName) === key).length
    + pharmRows.filter(r => r.repName && normalizeLocal(r.repName) === key).length;

  /** يطبّق قرارات المطابقة على صفوف الأطباء والصيدليات معاً دفعة واحدة. */
  const applyNameMatching = () => {
    const choiceByKey = new Map<string, number | null>();
    for (const e of needsDecision) {
      const c = nameChoice[e.key];
      if (!c) continue;
      choiceByKey.set(e.key, c === 'none' ? null : Number(c));
    }
    const apply = <T extends { repName: string; repId: number | null }>(list: T[]): T[] => list.map(r => {
      if (r.repId) return r; // محسوم أصلاً (تطابق تام/رابط محفوظ)
      const key = r.repName ? normalizeLocal(r.repName) : '';
      if (!choiceByKey.has(key)) return r;
      return { ...r, repId: choiceByKey.get(key) ?? null };
    });
    setDocRows(apply);
    setPharmRows(apply);
    setNameApplied(true);
  };

  const doctorDecidedCount = pendingDoctorNames.filter(e => doctorChoice[e.key]).length;
  const countForDoctorName = (key: string) => docRows.filter(r => r.doctorKey === key).length;

  /**
   * يطبّق قرارات مطابقة أسماء الأطباء على صفوف الأطباء (لا صلة لها بالصيدليات).
   * عند اختيار طبيب موجود تُتبنّى هويته من التطبيق كاملةً (الاسم/الاختصاص/
   * المنطقة/الصيدلية) بدل قيَم الملف — المطابقة تربط الزيارة بالطبيب ولا تُعيد
   * تعريفه. قيَم الملف تبقى في حقول raw* للاطلاع فقط.
   */
  const applyDoctorMatching = () => {
    const choiceByKey = new Map<string, number | null>();
    const docByKey    = new Map<string, DoctorSuggestion>();
    for (const e of pendingDoctorNames) {
      const c = doctorChoice[e.key];
      if (!c) continue;
      choiceByKey.set(e.key, c === 'new' ? null : Number(c));
      if (c !== 'new') {
        const picked = e.suggestions.find(s => String(s.id) === String(c));
        if (picked) docByKey.set(e.key, picked);
      }
    }
    setDocRows(rs => rs.map(r => {
      if (!r.doctorKey || !choiceByKey.has(r.doctorKey)) return r;
      const doc = docByKey.get(r.doctorKey);
      return {
        ...r,
        doctorId: choiceByKey.get(r.doctorKey) ?? null,
        ...(doc ? {
          rawDoctorName:   r.rawDoctorName   ?? r.doctorName,
          rawSpecialty:    r.rawSpecialty    ?? r.specialty,
          rawAreaName:     r.rawAreaName     ?? r.areaName,
          rawPharmacyName: r.rawPharmacyName ?? r.pharmacyName,
          doctorName:   doc.name,
          specialty:    doc.specialty    ?? '',
          areaName:     doc.areaName     ?? '',
          areaId:       doc.areaId       ?? null,
          pharmacyName: doc.pharmacyName ?? '',
        } : {}),
      };
    }));
    setDoctorNamesApplied(true);
  };

  /**
   * خانة مقفلة لصف طابق طبيباً مسجَّلاً في التطبيق: تعرض قيمة التطبيق نفسها
   * (لا قيمة الملف)، وقيمة الملف تظهر في الـtooltip للمقارنة. تُعيد null لصف
   * غير مطابَق فتُعرض خانة إدخال عادية بدلاً منها.
   */
  const lockedCell = (doctorId: number | null, value: string, rawValue: string | undefined, minWidth: number) => {
    if (!doctorId) return null;
    const differs = !!rawValue && rawValue !== value;
    return (
      <div title={differs ? `في الملف: ${rawValue}` : 'من بيانات الطبيب في التطبيق'}
        style={{
          ...cellInp, minWidth, background: '#f8fafc', borderColor: '#e2e8f0',
          color: value ? '#334155' : '#94a3b8', cursor: 'default',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
        {value || '—'}
      </div>
    );
  };

  const setDocCell = (i: number, patch: Partial<DoctorRow>) => setDocRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeDocRow = (i: number) => setDocRows(rs => rs.filter((_, idx) => idx !== i));
  const setPharmCell = (i: number, patch: Partial<PharmacyRow>) => setPharmRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removePharmRow = (i: number) => setPharmRows(rs => rs.filter((_, idx) => idx !== i));

  const docReady = docRows.filter(r => r.repId).length;
  const pharmReady = pharmRows.filter(r => r.repId).length;
  const readyCount = docReady + pharmReady;
  const missingRepCount = totalRows - readyCount;

  const save = async () => {
    if (totalRows === 0) return;
    setSaving(true); setError('');
    try {
      const rememberRepLinks = rememberChoices
        ? needsDecision.filter(e => nameChoice[e.key]).map(e => ({
            fromName: e.raw,
            scientificRepId: nameChoice[e.key] === 'none' ? null : Number(nameChoice[e.key]),
          }))
        : [];
      const rememberDoctorLinks = rememberDoctorChoices
        ? pendingDoctorNames.filter(e => doctorChoice[e.key]).map(e => ({
            fromName: e.raw,
            areaName: e.areaName || null,
            doctorId: doctorChoice[e.key] === 'new' ? null : Number(doctorChoice[e.key]),
          }))
        : [];
      const res = await fetch(`${API}/api/doctors/visits/import-commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authH },
        body: JSON.stringify({ doctorRows: docRows, pharmacyRows: pharmRows, rememberRepLinks, rememberDoctorLinks, fileName }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || j.message || 'فشل الحفظ');
      const d = j.data;
      onSaved?.(`تمت إضافة ${d.imported} زيارة (${d.doctor?.imported ?? 0} طبيب، ${d.pharmacy?.imported ?? 0} صيدلية)`
        + `${d.skipped > 0 ? ` — تم تجاهل ${d.skipped} صف` : ''}.`
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
          ارفع ملف إكسل يحتوي زيارات الأطباء (وصيدليات إن وُجدت) — سيتم ملء زيارات كل مندوب
          حسب اسمه في الملف. راجع النتيجة وصحّحها قبل الحفظ النهائي.
        </p>

        {totalRows === 0 && (
          <>
            <VisitImportFilesPanel token={token} />
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
          </>
        )}

        {error && <div style={errBox}>⚠️ {error}</div>}
        {info && <div style={infoBox}>{info}</div>}

        {totalRows > 0 && !nameApplied && needsDecision.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#92400e', marginBottom: 8 }}>
              🔗 طابِق أسماء المندوبين أولاً ({decidedCount}/{needsDecision.length}) — يُطبَّق على كل صفوف كل اسم دفعة واحدة
            </div>
            <div style={{ maxHeight: '38vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {needsDecision.map(e => {
                const count = countForName(e.key);
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

        {totalRows > 0 && nameApplied && !doctorNamesApplied && pendingDoctorNames.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#92400e', marginBottom: 4 }}>
              🩺 تأكيد أسماء أطباء مشابهة ({doctorDecidedCount}/{pendingDoctorNames.length})
            </div>
            <p style={{ margin: '0 0 8px', fontSize: 11.5, color: '#78716c' }}>
              الاسم في الملف يشبه طبيباً (أو أكثر) مسجَّلاً مسبقاً — قارن المنطقة/الاختصاص/الصيدلية أدناه لتأكيد أنه نفس الشخص، أو اختر إنشاء طبيب جديد إن لم يكن كذلك.
            </p>
            <div style={{ maxHeight: '42vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {pendingDoctorNames.map(e => {
                const count = countForDoctorName(e.key);
                return (
                  <div key={e.key} style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0f172a' }}>{e.raw}</div>
                      <span style={{ fontSize: 10.5, color: '#94a3b8' }}>({count} صف)</span>
                    </div>
                    {(e.areaName || e.specialty || e.pharmacyName) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, fontSize: 11 }}>
                        {e.areaName && <span style={chipMuted}>📍 {e.areaName}</span>}
                        {e.specialty && <span style={chipMuted}>🩺 {e.specialty}</span>}
                        {e.pharmacyName && <span style={chipMuted}>🏪 {e.pharmacyName}</span>}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {e.suggestions.map(s => {
                        const selected = doctorChoice[e.key] === String(s.id);
                        return (
                          <label key={s.id} style={{ ...candidateRow, ...(selected ? candidateRowOn : {}) }}>
                            <input type="radio" name={`doc-${e.key}`} checked={selected}
                              onChange={() => setDoctorChoice(p => ({ ...p, [e.key]: String(s.id) }))} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a' }}>
                                {s.name} <span style={{ fontWeight: 600, color: '#6366f1' }}>(تشابه {Math.round(s.score * 100)}%)</span>
                              </div>
                              {(s.areaName || s.specialty || s.pharmacyName) && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 3, fontSize: 10.5, color: '#64748b' }}>
                                  {s.areaName && <span>📍 {s.areaName}</span>}
                                  {s.specialty && <span>🩺 {s.specialty}</span>}
                                  {s.pharmacyName && <span>🏪 {s.pharmacyName}</span>}
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                      <label style={{ ...candidateRow, ...(doctorChoice[e.key] === 'new' ? candidateRowOn : {}) }}>
                        <input type="radio" name={`doc-${e.key}`} checked={doctorChoice[e.key] === 'new'}
                          onChange={() => setDoctorChoice(p => ({ ...p, [e.key]: 'new' }))} />
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>🆕 ليس أياً منهم — أنشئ طبيباً جديداً بهذا الاسم</span>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#334155', cursor: 'pointer' }}>
                <input type="checkbox" checked={rememberDoctorChoices} onChange={e => setRememberDoctorChoices(e.target.checked)} />
                تذكّر هذه المطابقة لملفات لاحقة بنفس الاسم (حتى لو كُتب بصيغة مختلفة قليلاً)
              </label>
              <button onClick={applyDoctorMatching} disabled={doctorDecidedCount === 0} style={{ ...applyBtn, opacity: doctorDecidedCount === 0 ? 0.5 : 1, marginInlineStart: 'auto' }}>
                تطبيق المطابقة على الجدول ({doctorDecidedCount})
              </button>
            </div>
          </div>
        )}

        {totalRows > 0 && nameApplied && doctorNamesApplied && (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#166534' }}>✅ {readyCount} صف جاهز</span>
              {missingRepCount > 0 && (
                <span style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c' }}>⚠️ {missingRepCount} صف بلا مندوب — صحّحه أدناه أو سيُتجاهل</span>
              )}
              {pendingDoctorNames.length > 0 && (
                <button onClick={() => setDoctorNamesApplied(false)} style={bulkBtn}>🩺 إعادة مطابقة أسماء الأطباء</button>
              )}
              <button onClick={() => setNameApplied(false)} style={{ ...bulkBtn, marginInlineStart: 'auto' }}>🔗 إعادة مطابقة الأسماء</button>
            </div>

            {docRows.length > 0 && pharmRows.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                <button onClick={() => setGridTab('doctors')} style={gridTab === 'doctors' ? tabBtnOn : tabBtnOff}>
                  👨‍⚕️ زيارات الأطباء ({docRows.length})
                </button>
                <button onClick={() => setGridTab('pharmacies')} style={gridTab === 'pharmacies' ? tabBtnOn : tabBtnOff}>
                  🏪 زيارات الصيدليات ({pharmRows.length})
                </button>
              </div>
            )}

            {(gridTab === 'doctors' || pharmRows.length === 0) && docRows.length > 0 && (
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
                    {docRows.map((r, i) => (
                      <tr key={i} style={{ background: !r.repId ? '#fef2f2' : i % 2 ? '#fafbfc' : '#fff' }}>
                        <td style={td}>
                          <select value={r.repId ?? ''} onChange={e => setDocCell(i, { repId: e.target.value ? Number(e.target.value) : null })}
                            style={{ ...cellInp, minWidth: 130, borderColor: r.repId ? '#e2e8f0' : '#fca5a5' }}>
                            <option value="">{r.repName || '— اختر —'}</option>
                            {reps.map(rp => <option key={rp.id} value={rp.id}>{rp.name}</option>)}
                          </select>
                        </td>
                        <td style={td}>
                          {/* طبيب مطابَق لطبيب موجود: يُعرض اسمه كما هو في التطبيق ولا يُعدَّل هنا —
                              الزيارة تُضاف إليه فقط، واسمه في التطبيق يبقى دون تغيير. */}
                          {r.doctorId ? (
                            <div title={r.rawDoctorName && r.rawDoctorName !== r.doctorName ? `في الملف: ${r.rawDoctorName}` : 'مطابَق لطبيب موجود'}
                              style={{ ...cellInp, minWidth: 140, background: '#f0fdf4', borderColor: '#bbf7d0', display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}>
                              <span>🔗</span><span style={{ fontWeight: 600 }}>{r.doctorName}</span>
                            </div>
                          ) : (
                            <input value={r.doctorName} onChange={e => setDocCell(i, { doctorName: e.target.value })} style={{ ...cellInp, minWidth: 140 }} />
                          )}
                        </td>
                        {/* الاختصاص/المنطقة/الصيدلية لطبيب مطابَق تُعرض من بيانات التطبيق
                            الأصلية ولا تُعدَّل من الملف — الملف يضيف زيارة فقط. */}
                        <td style={td}>{lockedCell(r.doctorId, r.specialty, r.rawSpecialty, 90)
                          ?? <input value={r.specialty} onChange={e => setDocCell(i, { specialty: e.target.value })} style={{ ...cellInp, minWidth: 90 }} />}</td>
                        <td style={td}>{lockedCell(r.doctorId, r.areaName, r.rawAreaName, 90)
                          ?? <input value={r.areaName} onChange={e => setDocCell(i, { areaName: e.target.value, areaId: null })} style={{ ...cellInp, minWidth: 90 }} />}</td>
                        <td style={td}>{lockedCell(r.doctorId, r.pharmacyName, r.rawPharmacyName, 110)
                          ?? <input value={r.pharmacyName} onChange={e => setDocCell(i, { pharmacyName: e.target.value })} style={{ ...cellInp, minWidth: 110 }} />}</td>
                        <td style={td}><input value={r.itemName} onChange={e => setDocCell(i, { itemName: e.target.value, itemId: null })} style={{ ...cellInp, minWidth: 110 }} /></td>
                        <td style={td}><input type="date" value={r.date} onChange={e => setDocCell(i, { date: e.target.value })} style={{ ...cellInp, minWidth: 120 }} /></td>
                        <td style={td}>
                          <select value={r.feedback} onChange={e => setDocCell(i, { feedback: e.target.value })} style={{ ...cellInp, minWidth: 100 }}>
                            {FEEDBACK_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td style={td}><input value={r.notes} onChange={e => setDocCell(i, { notes: e.target.value })} style={{ ...cellInp, minWidth: 120 }} /></td>
                        <td style={{ ...td, textAlign: 'center' }}>
                          <button onClick={() => removeDocRow(i)} title="حذف الصف" style={delBtn}>×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {(gridTab === 'pharmacies' || docRows.length === 0) && pharmRows.length > 0 && (
              <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, maxHeight: '46vh', overflowY: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', position: 'sticky', top: 0, zIndex: 1 }}>
                      {['المندوب', 'الصيدلية', 'المنطقة', 'الايتم', 'التاريخ', 'الملاحظات', ''].map(h => (
                        <th key={h} style={th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pharmRows.map((r, i) => (
                      <tr key={i} style={{ background: !r.repId ? '#fef2f2' : i % 2 ? '#fafbfc' : '#fff' }}>
                        <td style={td}>
                          <select value={r.repId ?? ''} onChange={e => setPharmCell(i, { repId: e.target.value ? Number(e.target.value) : null })}
                            style={{ ...cellInp, minWidth: 130, borderColor: r.repId ? '#e2e8f0' : '#fca5a5' }}>
                            <option value="">{r.repName || '— اختر —'}</option>
                            {reps.map(rp => <option key={rp.id} value={rp.id}>{rp.name}</option>)}
                          </select>
                        </td>
                        <td style={td}><input value={r.pharmacyName} onChange={e => setPharmCell(i, { pharmacyName: e.target.value })} style={{ ...cellInp, minWidth: 160 }} /></td>
                        <td style={td}><input value={r.areaName} onChange={e => setPharmCell(i, { areaName: e.target.value, areaId: null })} style={{ ...cellInp, minWidth: 100 }} /></td>
                        <td style={td}><input value={r.itemName} onChange={e => setPharmCell(i, { itemName: e.target.value, itemId: null })} style={{ ...cellInp, minWidth: 110 }} /></td>
                        <td style={td}><input type="date" value={r.date} onChange={e => setPharmCell(i, { date: e.target.value })} style={{ ...cellInp, minWidth: 120 }} /></td>
                        <td style={td}><input value={r.notes} onChange={e => setPharmCell(i, { notes: e.target.value })} style={{ ...cellInp, minWidth: 160 }} /></td>
                        <td style={{ ...td, textAlign: 'center' }}>
                          <button onClick={() => removePharmRow(i)} title="حذف الصف" style={delBtn}>×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-start', marginTop: 16 }}>
          {totalRows > 0 && nameApplied && doctorNamesApplied && (
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
const chipMuted: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 20, padding: '2px 9px', color: '#475569', fontWeight: 500 };
const candidateRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 8, border: '1.5px solid #e2e8f0', background: '#fff', cursor: 'pointer' };
const candidateRowOn: React.CSSProperties = { borderColor: '#6366f1', background: '#eef2ff' };
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
const tabBtnBase: React.CSSProperties = { padding: '6px 14px', borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1.5px solid #e2e8f0' };
const tabBtnOn: React.CSSProperties = { ...tabBtnBase, background: '#eef2ff', color: '#4338ca', borderColor: '#6366f1' };
const tabBtnOff: React.CSSProperties = { ...tabBtnBase, background: '#f8fafc', color: '#64748b' };
