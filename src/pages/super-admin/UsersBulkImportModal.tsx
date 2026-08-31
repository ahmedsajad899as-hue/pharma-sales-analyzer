import { useState } from 'react';
import * as XLSX from 'xlsx';

interface Office { id: number; name: string; }

const ROLES: { value: string; label: string }[] = [
  { value: 'office_manager',          label: 'مدير مكتب' },
  { value: 'office_hr',               label: 'HR مكتب' },
  { value: 'office_employee',         label: 'موظف مكتب' },
  { value: 'company_manager',         label: 'مدير شركة' },
  { value: 'supervisor',              label: 'مشرف' },
  { value: 'product_manager',         label: 'مدير منتج' },
  { value: 'team_leader',             label: 'قائد فريق' },
  { value: 'scientific_rep',          label: 'مندوب علمي' },
  { value: 'commercial_supervisor',   label: 'مشرف تجاري' },
  { value: 'commercial_team_leader',  label: 'قائد فريق تجاري' },
  { value: 'commercial_rep',          label: 'مندوب تجاري' },
  { value: 'admin',                   label: 'مدير (admin)' },
  { value: 'manager',                 label: 'مدير (manager)' },
];

interface PreviewRow {
  rowIndex: number; username: string; password: string; displayName: string; phone: string;
  role: string; companyId: number | null; companyName: string;
  itemIds: number[]; itemNames: string[];
  provinceId: number | null; provinceName: string;
  areaIds: number[]; areaNames: string[];
  errors: string[]; warnings: string[];
}
interface CommitResult { created: { rowIndex: number; username: string; userId: number }[]; failed: { rowIndex: number; username: string; error: string }[]; }

const TEMPLATE_HEADERS = [
  'اسم المستخدم', 'كلمة المرور', 'الاسم الظاهر', 'رقم الهاتف', 'الدور',
  'الشركة', 'الايتمات', 'المحافظة', 'المنطقة',
];

export default function UsersBulkImportModal({ offices, token, onClose, onImported }: {
  offices: Office[]; token: string | null; onClose: () => void; onImported: () => void;
}) {
  const H = () => ({ Authorization: `Bearer ${token}` });
  const [officeId, setOfficeId] = useState<string>(offices[0]?.id ? String(offices[0].id) : '');
  const [exporting, setExporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [fileName, setFileName] = useState('');

  const officeName = offices.find(o => String(o.id) === officeId)?.name ?? '';

  const downloadTemplate = async () => {
    if (!officeId) { setError('اختر المكتب أولاً'); return; }
    setError(''); setExporting(true);
    try {
      const [companiesRes, provincesRes, areasRes] = await Promise.all([
        fetch(`/api/sa/companies?officeId=${officeId}`, { headers: H() }).then(r => r.json()),
        fetch('/api/sa/provinces', { headers: H() }).then(r => r.json()),
        fetch('/api/sa/areas', { headers: H() }).then(r => r.json()),
      ]);
      const companies: { id: number; name: string }[] = companiesRes.success ? companiesRes.data : [];
      const provinces: { id: number; name: string }[] = provincesRes.success ? provincesRes.data : [];
      const areasList: { id: number; name: string; provinceId?: number | null }[] = areasRes.success ? areasRes.data : [];

      let itemsByCompany: { id: number; name: string; companyId: number; companyName: string }[] = [];
      if (companies.length) {
        const ids = companies.map(c => c.id).join(',');
        // companyIds override — لا يعتمد على معرّف مستخدم حقيقي (انظر getUserCompanyItems)
        const itemsRes = await fetch(`/api/sa/users/0/company-items?companyIds=${ids}`, { headers: H() }).then(r => r.json());
        if (itemsRes.success) itemsByCompany = itemsRes.data;
      }

      const provinceNameById = new Map(provinces.map(p => [p.id, p.name]));

      const wb = XLSX.utils.book_new();

      // ── ورقة البيانات (تُملأ من قِبل المستخدم) ──────────────────────────
      const exampleCompany = companies[0]?.name ?? '';
      const exampleItems = itemsByCompany.filter(i => i.companyName === exampleCompany).slice(0, 2).map(i => i.name).join('، ');
      const exampleArea = areasList[0]?.name ?? '';
      const exampleProvince = exampleArea ? (provinceNameById.get(areasList[0]?.provinceId ?? -1) ?? '') : '';
      const example = [
        'ahmed_rep', 'Passw0rd!', 'أحمد محمد', '07701234567', 'مندوب علمي',
        exampleCompany, exampleItems, exampleProvince, exampleArea,
      ];
      const wsData = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, example]);
      wsData['!cols'] = TEMPLATE_HEADERS.map(() => ({ wch: 22 }));
      XLSX.utils.book_append_sheet(wb, wsData, 'المستخدمون');

      // ── أوراق مرجعية: انسخ الأسماء منها بالضبط إلى ورقة المستخدمين ──────
      const wsCompanies = XLSX.utils.aoa_to_sheet([['اسم الشركة'], ...companies.map(c => [c.name])]);
      wsCompanies['!cols'] = [{ wch: 30 }];
      XLSX.utils.book_append_sheet(wb, wsCompanies, 'الشركات');

      const wsItems = XLSX.utils.aoa_to_sheet([
        ['اسم الايتم', 'الشركة'],
        ...itemsByCompany.map(i => [i.name, i.companyName]),
      ]);
      wsItems['!cols'] = [{ wch: 28 }, { wch: 24 }];
      XLSX.utils.book_append_sheet(wb, wsItems, 'الايتمات');

      const wsAreas = XLSX.utils.aoa_to_sheet([
        ['اسم المنطقة', 'المحافظة'],
        ...areasList.map(a => [a.name, a.provinceId ? (provinceNameById.get(a.provinceId) ?? '') : '']),
      ]);
      wsAreas['!cols'] = [{ wch: 26 }, { wch: 20 }];
      XLSX.utils.book_append_sheet(wb, wsAreas, 'المناطق');

      const wsProvinces = XLSX.utils.aoa_to_sheet([['اسم المحافظة'], ...provinces.map(p => [p.name])]);
      wsProvinces['!cols'] = [{ wch: 22 }];
      XLSX.utils.book_append_sheet(wb, wsProvinces, 'المحافظات');

      const wsRoles = XLSX.utils.aoa_to_sheet([['القيمة', 'التسمية'], ...ROLES.map(r => [r.value, r.label])]);
      wsRoles['!cols'] = [{ wch: 22 }, { wch: 22 }];
      XLSX.utils.book_append_sheet(wb, wsRoles, 'الأدوار');

      const legend = [
        ['ملاحظات حول تعبئة الملف'],
        [''],
        ['اسم المستخدم وكلمة المرور: حقلان مطلوبان لكل صف — بدونهما يُرفض الصف'],
        ['الدور: انسخ إحدى القيم من ورقة "الأدوار" (العمود الأول أو الثاني) — إن تُرك فارغاً يُستخدم "مندوب علمي"'],
        ['الشركة: اسم دقيق من ورقة "الشركات" — اختياري، لكن بدونه لا يمكن ربط ايتمات'],
        ['الايتمات: أسماء من ورقة "الايتمات" مفصولة بفاصلة (،) — اختياري، إن تُرك فارغاً يعمل المستخدم على كل ايتمات شركته'],
        ['المحافظة والمنطقة: أسماء من ورقتي "المحافظات" و"المناطق" — يمكن كتابة أكثر من منطقة مفصولة بفاصلة (،)'],
        ['يمكن حذف صف المثال قبل تعبئة بياناتك الفعلية.'],
        ['بعد التعبئة: ارجع لهذه الشاشة واستخدم "استيراد من إكسل" لرفع الملف ومراجعته قبل إنشاء الحسابات فعلياً.'],
      ];
      const wsLegend = XLSX.utils.aoa_to_sheet(legend);
      wsLegend['!cols'] = [{ wch: 95 }];
      XLSX.utils.book_append_sheet(wb, wsLegend, 'تعليمات');

      XLSX.writeFile(wb, `نموذج_مستخدمين_${officeName || officeId}.xlsx`);
    } catch (e: any) {
      setError(e.message ?? 'فشل تجهيز النموذج');
    } finally {
      setExporting(false);
    }
  };

  const onFile = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    if (!officeId) { setError('اختر المكتب أولاً'); return; }
    setError(''); setUploading(true); setRows(null); setResult(null); setFileName(file.name);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('officeId', officeId);
      const res = await fetch('/api/sa/users/import/preview', { method: 'POST', body: fd, headers: H() });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || 'فشل قراءة الملف');
      setRows(j.data.rows);
    } catch (e: any) {
      setError(e.message ?? 'فشل قراءة الملف');
    } finally {
      setUploading(false);
    }
  };

  const validRows = (rows ?? []).filter(r => r.errors.length === 0);

  const commit = async () => {
    if (!validRows.length) return;
    setCommitting(true); setError('');
    try {
      const res = await fetch('/api/sa/users/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...H() },
        body: JSON.stringify({ officeId: Number(officeId), rows: validRows }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || 'فشل الاستيراد');
      setResult(j.data);
      onImported();
    } catch (e: any) {
      setError(e.message ?? 'فشل الاستيراد');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 26, width: '100%', maxWidth: 920, maxHeight: '90vh', overflowY: 'auto', direction: 'rtl' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#0f172a' }}>📥 استيراد مستخدمين من إكسل</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#64748b' }}>✕</button>
        </div>

        {error && <div style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 14 }}>{error}</div>}

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>المكتب</label>
          <select value={officeId} onChange={e => { setOfficeId(e.target.value); setRows(null); setResult(null); }}
            style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 }}>
            <option value="">اختر المكتب...</option>
            {offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
          <button onClick={downloadTemplate} disabled={!officeId || exporting}
            style={{ background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 14, fontWeight: 600, cursor: officeId ? 'pointer' : 'not-allowed', opacity: officeId ? 1 : 0.6 }}>
            {exporting ? '⏳ جاري التجهيز...' : '⬇️ تنزيل نموذج إكسل'}
          </button>
          <label style={{ background: '#111827', color: '#fff', borderRadius: 8, padding: '9px 18px', fontSize: 14, fontWeight: 600, cursor: officeId ? 'pointer' : 'not-allowed', opacity: officeId ? 1 : 0.6, display: 'inline-block' }}>
            📤 {uploading ? 'جاري القراءة...' : 'رفع ملف إكسل'}
            <input type="file" accept=".xlsx,.xls" disabled={!officeId || uploading} onChange={e => onFile(e.target.files)} style={{ display: 'none' }} />
          </label>
          {fileName && <span style={{ alignSelf: 'center', fontSize: 12, color: '#64748b' }}>📄 {fileName}</span>}
        </div>

        {rows && !result && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, fontSize: 12.5, fontWeight: 700 }}>
              <span style={{ padding: '4px 10px', borderRadius: 12, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>✓ صالح للاستيراد: {validRows.length}</span>
              {rows.length - validRows.length > 0 &&
                <span style={{ padding: '4px 10px', borderRadius: 12, background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>✕ به مشاكل: {rows.length - validRows.length}</span>}
            </div>
            <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, marginBottom: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['#', 'المستخدم', 'الدور', 'الشركة', 'الايتمات', 'المحافظة', 'المنطقة', 'ملاحظات'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.rowIndex} style={{ background: r.errors.length ? '#fef2f2' : 'transparent' }}>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #f1f5f9' }}>{r.rowIndex}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #f1f5f9', fontWeight: 600 }}>{r.username || '—'}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #f1f5f9' }}>{ROLES.find(x => x.value === r.role)?.label ?? r.role}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #f1f5f9' }}>{r.companyName || '—'}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #f1f5f9' }}>{r.itemNames.length ? `${r.itemNames.length} ايتم` : '—'}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #f1f5f9' }}>{r.provinceName || '—'}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #f1f5f9' }}>{r.areaNames.length ? r.areaNames.join('، ') : '—'}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #f1f5f9', maxWidth: 260 }}>
                        {r.errors.map((e, i) => <div key={`e${i}`} style={{ color: '#dc2626' }}>⛔ {e}</div>)}
                        {r.warnings.map((w, i) => <div key={`w${i}`} style={{ color: '#b45309' }}>⚠ {w}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={commit} disabled={!validRows.length || committing}
              style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: validRows.length ? 'pointer' : 'not-allowed', opacity: validRows.length ? 1 : 0.6 }}>
              {committing ? '⏳ جاري الإنشاء...' : `✅ إنشاء ${validRows.length} حساب`}
            </button>
          </>
        )}

        {result && (
          <div>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 13.5, color: '#15803d', fontWeight: 700, marginBottom: 10 }}>
              ✅ تم إنشاء {result.created.length} حساب بنجاح
            </div>
            {result.failed.length > 0 && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
                <div style={{ fontWeight: 700, color: '#dc2626', marginBottom: 6 }}>فشل {result.failed.length} صف:</div>
                {result.failed.map(f => (
                  <div key={f.rowIndex} style={{ color: '#991b1b' }}>صف {f.rowIndex} ({f.username || '—'}): {f.error}</div>
                ))}
              </div>
            )}
            <button onClick={onClose} style={{ marginTop: 14, background: '#111827', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>إغلاق</button>
          </div>
        )}
      </div>
    </div>
  );
}
