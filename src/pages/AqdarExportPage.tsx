/**
 * AqdarExportPage — أقدر
 *
 * يستورد ملف Excel لـ«البلان الشهري» (رقم / اسم الطبيب / التخصص / الكلاس /
 * الصيدلية / المنطقة (زون) / الايتم) ويحوّله إلى ملف Excel بصيغة أقدر:
 * task-type (=8 دائماً) / rep-name (فارغ) / rep-id (من المستخدم) /
 * client-id (فارغ) / schedule (فارغ) / note (تجميع بقية الحقول بفاصل \).
 */

import { useState, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';

interface PlanRow {
  doctor: string;
  speciality: string;
  class: string;
  pharmacy: string;
  area: string;
  item: string;
}

const COL_HINTS: Record<keyof PlanRow, string[]> = {
  doctor:     ['doctor name', 'doctor', 'اسم الطبيب', 'الطبيب', 'طبيب'],
  speciality: ['speciality', 'specialty', 'التخصص', 'الاختصاص', 'اختصاص'],
  class:      ['class', 'كلاس', 'الكلاس', 'تصنيف الطبيب', 'تصنيف'],
  pharmacy:   ['pharmacy', 'الصيدلية', 'صيدلية', 'الصيدليه'],
  area:       ['area (zone)', 'area', 'zone', 'المنطقة (زون)', 'المنطقة', 'الزون', 'المنطقه'],
  item:       ['item', 'الايتم', 'ايتم', 'items'],
};

// يزيل المسافات غير القياسية (NBSP، أحرف عرض صفري) ويُوحّد المسافات/الأسطر المتعددة إلى مسافة واحدة
const INVISIBLE_CHARS_RE = new RegExp('[' + [160, 8203, 8204, 8205, 65279].map(c => String.fromCharCode(c)).join('') + ']', 'g');
const norm = (s: string) => String(s ?? '').replace(INVISIBLE_CHARS_RE, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

function findColIdx(headers: string[], hints: string[]): number {
  for (const h of hints) { const i = headers.findIndex(k => norm(k) === norm(h)); if (i !== -1) return i; }
  for (const h of hints) { const i = headers.findIndex(k => norm(k).includes(norm(h))); if (i !== -1) return i; }
  return -1;
}

function buildNote(r: PlanRow): string {
  return [r.doctor, r.speciality, r.class, r.pharmacy, r.area, r.item].filter(Boolean).join(' \\ ');
}

export default function AqdarExportPage() {
  const [repId, setRepId]       = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows]         = useState<PlanRow[]>([]);
  const [error, setError]       = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parseFile = useCallback((file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) { setError('يرجى رفع ملف Excel أو CSV فقط'); return; }
    setError('');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target!.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        // نقرأ الشيت كمصفوفة صفوف خام (بدون افتراض أن الصف الأول هو رأس الجدول)
        // لأن بعض الملفات تحتوي عنوان/صف فارغ فوق رأس الجدول الفعلي
        const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
        if (!raw.length) { setError('الملف فارغ'); setRows([]); return; }

        // نبحث عن أول صف من أول 10 صفوف يحتوي عموداً يطابق «اسم الطبيب» لاعتباره صف الرأس
        let headerRowIdx = -1;
        let doctorColIdx = -1;
        for (let i = 0; i < Math.min(10, raw.length); i++) {
          const rowStrings = raw[i].map(c => String(c ?? ''));
          const idx = findColIdx(rowStrings, COL_HINTS.doctor);
          if (idx !== -1) { headerRowIdx = i; doctorColIdx = idx; break; }
        }
        if (headerRowIdx === -1) { setError('لم يتم العثور على عمود «اسم الطبيب» في الملف'); setRows([]); return; }

        const headers = raw[headerRowIdx].map(c => String(c ?? ''));
        const colIdx: Partial<Record<keyof PlanRow, number>> = { doctor: doctorColIdx };
        (Object.keys(COL_HINTS) as (keyof PlanRow)[]).forEach(k => {
          if (k === 'doctor') return;
          const i = findColIdx(headers, COL_HINTS[k]);
          if (i !== -1) colIdx[k] = i;
        });

        const dataRows = raw.slice(headerRowIdx + 1);
        const parsed: PlanRow[] = dataRows
          .map(r => ({
            doctor:     String(r[colIdx.doctor!] ?? '').trim(),
            speciality: colIdx.speciality !== undefined ? String(r[colIdx.speciality] ?? '').trim() : '',
            class:      colIdx.class      !== undefined ? String(r[colIdx.class] ?? '').trim()      : '',
            pharmacy:   colIdx.pharmacy   !== undefined ? String(r[colIdx.pharmacy] ?? '').trim()   : '',
            area:       colIdx.area       !== undefined ? String(r[colIdx.area] ?? '').trim()       : '',
            item:       colIdx.item       !== undefined ? String(r[colIdx.item] ?? '').trim()       : '',
          }))
          .filter(r => r.doctor);
        if (!parsed.length) { setError('لم يتم العثور على أي صف يحتوي اسم طبيب'); setRows([]); return; }
        setRows(parsed);
        setFileName(file.name);
      } catch {
        setError('تعذّرت قراءة الملف — تأكد أنه ملف Excel صالح');
        setRows([]);
      }
    };
    reader.onerror = () => setError('فشل قراءة الملف');
    reader.readAsArrayBuffer(file);
  }, []);

  const exportFile = () => {
    if (!rows.length || !repId.trim()) return;
    const out = rows.map(r => ({
      'task-type': 8,
      'rep-name':  '',
      'rep-id':    repId.trim(),
      'client-id': '',
      'schedule':  '',
      'note':      buildNote(r),
    }));
    const ws = XLSX.utils.json_to_sheet(out);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'اقدر');
    XLSX.writeFile(wb, `aqdar_${repId.trim()}.xlsx`);
  };

  const clear = () => {
    setRows([]); setFileName(''); setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const canExport = rows.length > 0 && repId.trim().length > 0;

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', direction: 'rtl' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <span style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>📤 أقدر — تحويل البلان الشهري</span>
      </div>

      <div style={{ padding: 20, maxWidth: 900, margin: '0 auto' }}>
        {/* رقم المندوب */}
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 18, marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>رقم/آيدي المندوب (Rep ID)</label>
          <input
            type="text"
            value={repId}
            onChange={e => setRepId(e.target.value)}
            placeholder="مثال: 12344"
            style={{ width: '100%', maxWidth: 260, padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, outline: 'none', boxSizing: 'border-box' as const }}
          />
        </div>

        {/* رفع الملف */}
        <div
          onDragEnter={() => setDragActive(true)} onDragLeave={() => setDragActive(false)}
          onDragOver={e => { e.preventDefault(); setDragActive(true); }}
          onDrop={e => { e.preventDefault(); setDragActive(false); const f = e.dataTransfer.files[0]; if (f) parseFile(f); }}
          onClick={() => fileInputRef.current?.click()}
          style={{ border: `2px dashed ${dragActive ? '#1a56db' : '#cbd5e1'}`, borderRadius: 14, padding: '28px 24px', textAlign: 'center', cursor: 'pointer', background: dragActive ? '#eff6ff' : '#fff', marginBottom: 16, transition: 'all .2s' }}
        >
          <div style={{ fontSize: 32, marginBottom: 6 }}>📥</div>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#1e293b', marginBottom: 4 }}>ارفع ملف البلان الشهري (اسحب أو اضغط)</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>رقم، اسم الطبيب، التخصص، الكلاس، الصيدلية، المنطقة (زون)، الايتم — xlsx • xls • csv</div>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => { if (e.target.files?.[0]) parseFile(e.target.files[0]); e.target.value = ''; }} />
        </div>

        {error && <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 13 }}>{error}</div>}

        {rows.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
              <div style={{ fontSize: 13, color: '#0f172a' }}>
                📄 <strong>{fileName}</strong> — {rows.length.toLocaleString('ar-IQ')} صف صالح
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={clear} style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 14px', fontSize: 12, cursor: 'pointer', color: '#475569', fontWeight: 600 }}>مسح</button>
                <button
                  onClick={exportFile}
                  disabled={!canExport}
                  title={!repId.trim() ? 'أدخل رقم المندوب أولاً' : undefined}
                  style={{ background: canExport ? '#1a56db' : '#f1f5f9', border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 13, cursor: canExport ? 'pointer' : 'not-allowed', color: canExport ? '#fff' : '#94a3b8', fontWeight: 700 }}
                >⬇️ تصدير ملف أقدر</button>
              </div>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ maxHeight: 480, overflow: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                      {['الطبيب', 'التخصص', 'الكلاس', 'الصيدلية', 'المنطقة', 'الايتم', 'note (سيُصدَّر)'].map(h => (
                        <th key={h} style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', padding: '8px 10px', fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', textAlign: 'center' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 300).map((r, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                        <td style={{ border: '1px solid #e2e8f0', padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.doctor}</td>
                        <td style={{ border: '1px solid #e2e8f0', padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.speciality}</td>
                        <td style={{ border: '1px solid #e2e8f0', padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.class}</td>
                        <td style={{ border: '1px solid #e2e8f0', padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.pharmacy}</td>
                        <td style={{ border: '1px solid #e2e8f0', padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.area}</td>
                        <td style={{ border: '1px solid #e2e8f0', padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.item}</td>
                        <td style={{ border: '1px solid #e2e8f0', padding: '6px 10px', color: '#64748b' }}>{buildNote(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 300 && <div style={{ padding: '10px 16px', fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>تعرض أول 300 صف — التصدير يشمل كل الصفوف ({rows.length.toLocaleString('ar-IQ')})</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
