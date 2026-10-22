import { useEffect, useMemo, useState } from 'react';

const API = import.meta.env.VITE_API_URL || '';

// «مندوب فارمسي لاين» (server/lib/pharmacyRep.js): يدخل الصيدليات فقط. مبيعه =
// ميركاتو باسمه + صفوف ملف المكتب التي «معلومات الزبون» فيها إحدى تسمياته ∩
// مناطقه ∩ ايتماته. التيم ليدر الفارمسي = مجموع مندوبيه.

interface CustomerInfoValue { value: string; count: number; pharmacy: boolean }

export default function PharmacyRepKindModal({ rep, token, activeFileIds, onClose, onSaved }: {
  rep: { id: number; name: string; repKind?: string; customerInfoLabels?: string[] };
  token: string | null;
  activeFileIds: number[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind]       = useState<'scientific' | 'pharmacy'>(rep.repKind === 'pharmacy' ? 'pharmacy' : 'scientific');
  const [labels, setLabels]   = useState<string[]>(rep.customerInfoLabels ?? []);
  const [values, setValues]   = useState<CustomerInfoValue[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [custom, setCustom]   = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    if (!activeFileIds.length) return;
    fetch(`${API}/api/scientific-reps/customer-info-values?fileIds=${activeFileIds.join(',')}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(j => setValues(Array.isArray(j?.data) ? j.data : []))
      .catch(() => {});
  }, [token, activeFileIds]);

  const shown = useMemo(() => {
    const list = showAll ? values : values.filter(v => v.pharmacy);
    // تسميات محفوظة غير موجودة بالملفات النشطة تبقى ظاهرة لإلغائها.
    const extra = labels.filter(l => !list.some(v => v.value === l)).map(l => ({ value: l, count: 0, pharmacy: true }));
    return [...extra, ...list];
  }, [values, showAll, labels]);

  const toggle = (v: string) => setLabels(ls => ls.includes(v) ? ls.filter(x => x !== v) : [...ls, v]);

  const save = async () => {
    setSaving(true); setError('');
    try {
      const r = await fetch(`${API}/api/scientific-reps/${rep.id}/pharmacy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ repKind: kind, customerInfoLabels: labels }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.success === false) throw new Error(j?.error || 'فشل الحفظ');
      onSaved();
    } catch (e: any) {
      setError(e.message || 'فشل الحفظ');
    } finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} dir="rtl">
        <div className="modal-header">
          <h2>🏪 نوع المندوب — <span style={{ color: '#6366f1' }}>{rep.name}</span></h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {(['scientific', 'pharmacy'] as const).map(k => (
              <button key={k} type="button"
                className={`btn ${kind === k ? 'btn--primary' : 'btn--secondary'}`}
                style={{ flex: 1 }}
                onClick={() => setKind(k)}>
                {k === 'scientific' ? '🩺 مندوب علمي' : '🏪 فارمسي لاين'}
              </button>
            ))}
          </div>

          {kind === 'pharmacy' && (
            <>
              <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 10px', lineHeight: 1.7 }}>
                يُحتسب له: صفوف ميركاتو التي تحمل اسمه، وصفوف ملف المكتب التي قيمة «معلومات الزبون» فيها
                إحدى التسميات المختارة أدناه — ضمن مناطقه وايتماته المعيّنة. التيم ليدر الفارمسي يُحتسب له مجموع مندوبيه.
                بلا اختيار: كل قيمة فيها «فارم».
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong style={{ fontSize: 13 }}>📇 تسميات «معلومات الزبون» ({labels.length})</strong>
                <label style={{ fontSize: 12, color: '#64748b', display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> عرض كل القيم
                </label>
              </div>
              {!activeFileIds.length && (
                <div style={{ fontSize: 12, color: '#b45309', marginBottom: 6 }}>فعّل ملف مبيعات المكتب لعرض القيم المتاحة.</div>
              )}
              <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, padding: 6 }}>
                {shown.length === 0
                  ? <div style={{ fontSize: 12, color: '#94a3b8', padding: 8 }}>لا قيم فارماسي في الملفات النشطة.</div>
                  : shown.map(v => (
                    <label key={v.value} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', fontSize: 13, cursor: 'pointer' }}>
                      <input type="checkbox" checked={labels.includes(v.value)} onChange={() => toggle(v.value)} />
                      <span style={{ flex: 1 }}>{v.value}</span>
                      {v.count > 0 && <span style={{ fontSize: 11, color: '#94a3b8' }}>{v.count.toLocaleString()} صف</span>}
                    </label>
                  ))}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input className="form-input" style={{ flex: 1 }} value={custom} onChange={e => setCustom(e.target.value)}
                  placeholder="أو اكتب تسمية (مثل: فارمسي لاين)" />
                <button type="button" className="btn btn--secondary" disabled={!custom.trim()}
                  onClick={() => { const v = custom.trim(); if (v && !labels.includes(v)) setLabels([...labels, v]); setCustom(''); }}>
                  إضافة
                </button>
              </div>
            </>
          )}
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn--secondary" onClick={onClose}>إلغاء</button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? '...' : 'حفظ'}</button>
        </div>
      </div>
    </div>
  );
}
