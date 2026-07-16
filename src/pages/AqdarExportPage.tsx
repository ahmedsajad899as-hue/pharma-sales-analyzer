/**
 * AqdarExportPage — أقدر
 *
 * يستورد ملف Excel لـ«البلان الشهري» (رقم / اسم الطبيب / التخصص / الكلاس /
 * الصيدلية / المنطقة (زون) / الايتم) ويحوّله إلى ملف Excel بصيغة أقدر:
 * task-type (=8 دائماً) / rep-name (فارغ) / rep-id (من المستخدم) /
 * client-id (فارغ) / schedule (فارغ) / note (تجميع بقية الحقول بفاصل \).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { ClipboardEvent as ReactClipboardEvent } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';

interface SavedRep { id: string; name: string; }

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

// يزيل كل أحرف التنسيق غير المرئية (علامات اتجاه عربي/لاتيني كـ ALM وLRM وRLM، والمسافات
// غير القياسية كـ NBSP) التي يُدرجها Excel أحياناً داخل خلايا تخلط عربي/إنكليزي، ويُوحّد
// المسافات/الأسطر المتعددة إلى مسافة واحدة قبل مقارنة أسماء الأعمدة
const norm = (s: string) => String(s ?? '').replace(/[\p{Cf}\p{Zs}]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

function findColIdx(headers: string[], hints: string[]): number {
  for (const h of hints) { const i = headers.findIndex(k => norm(k) === norm(h)); if (i !== -1) return i; }
  for (const h of hints) { const i = headers.findIndex(k => norm(k).includes(norm(h))); if (i !== -1) return i; }
  return -1;
}

function buildNote(r: PlanRow): string {
  return [r.doctor, r.speciality, r.class, r.pharmacy, r.area, r.item].filter(Boolean).join(' \\ ');
}

// يحوّل مصفوفة صفوف خام (من ملف Excel أو من نص ملصوق بفواصل Tab) إلى صفوف PlanRow —
// يبحث عن صف الرأس تلقائياً بدل افتراض أنه الصف الأول، لأن بعض الملفات/اللصقات
// تحتوي عنوان أو صفاً فارغاً فوق رأس الجدول الفعلي
function parseRawRows(raw: any[][]): { rows: PlanRow[]; error?: string } {
  if (!raw.length) return { rows: [], error: 'لا توجد بيانات' };

  let headerRowIdx = -1;
  let doctorColIdx = -1;
  for (let i = 0; i < Math.min(10, raw.length); i++) {
    const rowStrings = raw[i].map(c => String(c ?? ''));
    const idx = findColIdx(rowStrings, COL_HINTS.doctor);
    if (idx !== -1) { headerRowIdx = i; doctorColIdx = idx; break; }
  }
  if (headerRowIdx === -1) return { rows: [], error: 'لم يتم العثور على عمود «اسم الطبيب»' };

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
  if (!parsed.length) return { rows: [], error: 'لم يتم العثور على أي صف يحتوي اسم طبيب' };
  return { rows: parsed };
}

export default function AqdarExportPage() {
  const { user } = useAuth();
  const savedRepsKey = `aqdar_saved_reps_${user?.id ?? 'guest'}`;

  const [repId, setRepId]       = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows]         = useState<PlanRow[]>([]);
  const [error, setError]       = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [pasteText, setPasteText]   = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // دفتر أسماء/آيديات المندوبين — محفوظ محلياً لكل مستخدم لتسهيل اختيار المندوب
  // بدل كتابة رقم الآيدي يدوياً في كل مرة
  const [savedReps, setSavedReps] = useState<SavedRep[]>(() => {
    try { return JSON.parse(localStorage.getItem(savedRepsKey) || '[]'); }
    catch { return []; }
  });
  const [showAddRep, setShowAddRep] = useState(false);
  const [newRepName, setNewRepName] = useState('');
  const [newRepId, setNewRepId]     = useState('');

  useEffect(() => {
    localStorage.setItem(savedRepsKey, JSON.stringify(savedReps));
  }, [savedReps, savedRepsKey]);

  const addSavedRep = () => {
    const name = newRepName.trim();
    const id   = newRepId.trim();
    if (!name || !id) return;
    setSavedReps(prev => [...prev.filter(r => r.id !== id), { id, name }]);
    setRepId(id);
    setNewRepName(''); setNewRepId(''); setShowAddRep(false);
  };

  const removeSavedRep = (id: string) => {
    setSavedReps(prev => prev.filter(r => r.id !== id));
  };

  const parseFile = useCallback((file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) { setError('يرجى رفع ملف Excel أو CSV فقط'); return; }
    setError('');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target!.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        // نقرأ الشيت كمصفوفة صفوف خام (بدون افتراض أن الصف الأول هو رأس الجدول)
        const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
        const { rows: parsed, error: err } = parseRawRows(raw);
        if (err) { setError(err); setRows([]); return; }
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

  // لصق خلايا منسوخة مباشرة من Excel (نص بفواصل Tab بين الأعمدة وسطر جديد بين الصفوف)
  const parsePastedText = useCallback((text: string) => {
    setError('');
    const raw: any[][] = text
      .split(/\r\n|\r|\n/)
      .filter(line => line.trim().length > 0)
      .map(line => line.split('\t'));
    const { rows: parsed, error: err } = parseRawRows(raw);
    if (err) { setError(err); setRows([]); return; }
    setRows(parsed);
    setFileName('📋 بيانات ملصوقة من الحافظة');
  }, []);

  const handlePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text.trim()) return;
    e.preventDefault();
    parsePastedText(text);
    setPasteText('');
  };

  // لصق ملف Excel كامل (منسوخ من واتساب، مستكشف الملفات، إلخ) بـ Ctrl+V في أي مكان
  // بالصفحة — يعمل بنفس منطق رفع/سحب الملف طالما الحافظة تحتوي ملفاً فعلياً وليس نصاً فقط
  useEffect(() => {
    const onWindowPaste = (e: ClipboardEvent) => {
      const file = e.clipboardData?.files?.[0];
      if (!file) return;
      e.preventDefault();
      parseFile(file);
    };
    window.addEventListener('paste', onWindowPaste);
    return () => window.removeEventListener('paste', onWindowPaste);
  }, [parseFile]);

  const csvCell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const exportFile = () => {
    if (!rows.length || !repId.trim()) return;
    const header = ['task-type', 'rep-name', 'rep-id', 'client-id', 'schedule', 'note'];
    const lines = [header, ...rows.map(r => [8, '', repId.trim(), '', '', buildNote(r)])]
      .map(row => row.map(csvCell).join(','));
    // BOM لضمان ظهور الأحرف العربية بشكل صحيح عند فتح الملف في Excel
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aqdar_${repId.trim()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clear = () => {
    setRows([]); setFileName(''); setError(''); setPasteText('');
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
          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>اختر المندوب</label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={savedReps.some(r => r.id === repId) ? repId : ''}
              onChange={e => setRepId(e.target.value)}
              style={{ flex: '1 1 260px', maxWidth: 320, padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, outline: 'none', background: '#fff', color: '#0f172a' }}
            >
              <option value="">— اختر من القائمة —</option>
              {savedReps.map(r => (
                <option key={r.id} value={r.id}>{r.name} — {r.id}</option>
              ))}
            </select>
            <button
              onClick={() => setShowAddRep(v => !v)}
              style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '9px 14px', fontSize: 12, cursor: 'pointer', color: '#1a56db', fontWeight: 700 }}
            >{showAddRep ? '× إلغاء' : '+ إضافة مندوب'}</button>
          </div>

          {showAddRep && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, padding: 12, background: '#f8fafc', borderRadius: 10 }}>
              <input
                type="text"
                value={newRepName}
                onChange={e => setNewRepName(e.target.value)}
                placeholder="اسم المندوب"
                style={{ flex: '1 1 160px', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }}
              />
              <input
                type="text"
                value={newRepId}
                onChange={e => setNewRepId(e.target.value)}
                placeholder="رقم/آيدي المندوب"
                style={{ flex: '1 1 140px', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }}
              />
              <button
                onClick={addSavedRep}
                disabled={!newRepName.trim() || !newRepId.trim()}
                style={{ background: newRepName.trim() && newRepId.trim() ? '#1a56db' : '#e2e8f0', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 12, cursor: newRepName.trim() && newRepId.trim() ? 'pointer' : 'not-allowed', color: '#fff', fontWeight: 700 }}
              >حفظ</button>
            </div>
          )}

          {savedReps.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
              {savedReps.map(r => (
                <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: r.id === repId ? '#eff6ff' : '#f1f5f9', border: `1px solid ${r.id === repId ? '#93c5fd' : '#e2e8f0'}`, borderRadius: 999, padding: '4px 10px', fontSize: 12, color: '#334155' }}>
                  {r.name} ({r.id})
                  <button onClick={() => removeSavedRep(r.id)} title="حذف" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                </span>
              ))}
            </div>
          )}

          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', margin: '14px 0 6px' }}>رقم/آيدي المندوب (Rep ID)</label>
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
          <div style={{ fontWeight: 600, fontSize: 14, color: '#1e293b', marginBottom: 4 }}>ارفع ملف البلان الشهري (اسحب أو اضغط أو الصق Ctrl+V)</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>رقم، اسم الطبيب، التخصص، الكلاس، الصيدلية، المنطقة (زون)، الايتم — xlsx • xls • csv</div>
          <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 2 }}>يمكنك نسخ الملف من واتساب أو أي مكان ولصقه هنا مباشرة (Ctrl+V)</div>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => { if (e.target.files?.[0]) parseFile(e.target.files[0]); e.target.value = ''; }} />
        </div>

        {/* أو: نسخ ولصق مباشر من Excel */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 12px' }}>
          <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
          <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>أو</span>
          <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <textarea
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            onPaste={handlePaste}
            placeholder="حدد وانسخ الأعمدة من ملف Excel (بما فيها صف العناوين) ثم اضغط هنا والصق (Ctrl+V)"
            rows={3}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db', fontSize: 12, outline: 'none', resize: 'vertical', boxSizing: 'border-box' as const, fontFamily: 'inherit', direction: 'rtl', background: '#fff' }}
          />
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
