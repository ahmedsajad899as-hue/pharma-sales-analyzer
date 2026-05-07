import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { usePageBackHandler } from '../hooks/useBackHandler';

// ─── Types ────────────────────────────────────────────────────
interface SalesUpload {
  id: number;
  originalName: string;
  rowCount: number;
  uploadedAt: string;
  _count?: { rows: number };
  compUploads?: CompUpload[];
}

interface CompUpload {
  id: number;
  originalName: string;
  rowCount: number;
  uploadedAt: string;
}

interface SalesRow {
  id: number;
  uploadId: number;
  companyName: string | null;
  itemName: string | null;
  invoiceDate: string | null;
  invoiceNo: string | null;
  quantity: number | null;
  price: number | null;
  hasBonus: boolean;
  bonusQty: number | null;
  bonusValue: number | null;
  total: number | null;
  repName: string | null;
  pharmacyName: string | null;
  warehouse: string | null;
  isCompensated: boolean;
  compRowId: number | null;
  bonusDelivered: boolean;
  deliveredAt: string | null;
  deliveryNote: string | null;
  deliveredByUser?: { id: number; displayName?: string; username: string } | null;
}

type TabId = 'uploads' | 'rows' | 'delivery';

const ROLE_CAN_VIEW_DELIVERY = new Set([
  'admin', 'manager', 'company_manager', 'team_leader',
  'commercial_team_leader', 'commercial_supervisor', 'office_manager',
]);

// ─── Helpers ──────────────────────────────────────────────────
function fmtDate(str: string | null) {
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d.getTime())) return str;
  return d.toLocaleDateString('ar-IQ', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function fmtNum(n: number | null) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('ar-IQ');
}

const STATUS_COLORS = {
  withBonus:        { bg: '#dcfce7', color: '#15803d', label: 'لديه بونص' },
  compensated:      { bg: '#dbeafe', color: '#1d4ed8', label: 'معوَّض' },
  noBonus:          { bg: '#fef9c3', color: '#854d0e', label: 'بدون بونص' },
  delivered:        { bg: '#f0fdf4', color: '#166534', label: 'تم التسليم' },
  notDelivered:     { bg: '#fef2f2', color: '#991b1b', label: 'لم يُسلَّم' },
};

function BonusStatusBadge({ row }: { row: SalesRow }) {
  if (row.hasBonus) {
    const s = STATUS_COLORS.withBonus;
    return <span style={{ background: s.bg, color: s.color, borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>{s.label}</span>;
  }
  if (row.isCompensated) {
    const s = STATUS_COLORS.compensated;
    return <span style={{ background: s.bg, color: s.color, borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>{s.label}</span>;
  }
  const s = STATUS_COLORS.noBonus;
  return <span style={{ background: s.bg, color: s.color, borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>{s.label}</span>;
}

function DeliveryBadge({ row }: { row: SalesRow }) {
  if (row.bonusDelivered) {
    return <span style={{ background: '#dcfce7', color: '#15803d', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>✓ تم التسليم</span>;
  }
  return <span style={{ background: '#fef3c7', color: '#92400e', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>⏳ لم يُسلَّم</span>;
}

// ─── Main Page ────────────────────────────────────────────────
export default function BonusSalesPage() {
  usePageBackHandler('bonus-sales', []);
  const { token, user, hasFeature } = useAuth();
  const role = user?.role ?? 'user';
  const canManageDelivery = ROLE_CAN_VIEW_DELIVERY.has(role) || role === 'scientific_rep' || role === 'commercial_rep';
  const isManager = ROLE_CAN_VIEW_DELIVERY.has(role);

  const H = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [tab, setTab] = useState<TabId>('uploads');

  // ── Uploads state ──────────────────────────────────────────
  const [salesUploads, setSalesUploads] = useState<SalesUpload[]>([]);
  const [loadingUploads, setLoadingUploads] = useState(false);
  const [selectedUpload, setSelectedUpload] = useState<SalesUpload | null>(null);

  // ── Rows state ─────────────────────────────────────────────
  const [rows, setRows]         = useState<SalesRow[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const PAGE_SIZE = 50;
  const [loadingRows, setLoadingRows] = useState(false);

  // ── Filters ────────────────────────────────────────────────
  const [filterPharmacy,     setFilterPharmacy]     = useState('');
  const [filterRep,          setFilterRep]          = useState('');
  const [filterItem,         setFilterItem]         = useState('');
  const [filterHasBonus,     setFilterHasBonus]     = useState('');
  const [filterCompensated,  setFilterCompensated]  = useState('');
  const [filterDelivered,    setFilterDelivered]    = useState('');

  // ── Upload file UI ─────────────────────────────────────────
  const [uploadingSales, setUploadingSales] = useState(false);
  const [uploadingComp,  setUploadingComp]  = useState(false);
  const [uploadMsg,      setUploadMsg]      = useState('');
  const salesFileRef = useRef<HTMLInputElement>(null);
  const compFileRef  = useRef<HTMLInputElement>(null);

  // ── Delivery note modal ────────────────────────────────────
  const [deliveryModal, setDeliveryModal] = useState<{ row: SalesRow; note: string } | null>(null);
  const [markingDelivery, setMarkingDelivery] = useState(false);

  // ── Load uploads ───────────────────────────────────────────
  const loadUploads = useCallback(async () => {
    setLoadingUploads(true);
    try {
      const { data } = await axios.get('/api/bonus-sales/sales/uploads', { headers: H() });
      setSalesUploads(data.data ?? []);
    } catch (_) { /* ignore */ }
    finally { setLoadingUploads(false); }
  }, [H]);

  useEffect(() => { loadUploads(); }, [loadUploads]);

  // ── Load rows ──────────────────────────────────────────────
  const loadRows = useCallback(async (pg = 1) => {
    if (!selectedUpload) return;
    setLoadingRows(true);
    try {
      const params: Record<string, string> = {
        uploadId: String(selectedUpload.id),
        page: String(pg),
        pageSize: String(PAGE_SIZE),
      };
      if (filterPharmacy)    params.pharmacyName    = filterPharmacy;
      if (filterRep)         params.repName         = filterRep;
      if (filterItem)        params.itemName        = filterItem;
      if (filterHasBonus    !== '') params.hasBonus      = filterHasBonus;
      if (filterCompensated !== '') params.isCompensated = filterCompensated;
      if (filterDelivered   !== '') params.bonusDelivered = filterDelivered;

      const { data } = await axios.get('/api/bonus-sales/sales/rows', { headers: H(), params });
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setPage(pg);
    } catch (_) { /* ignore */ }
    finally { setLoadingRows(false); }
  }, [selectedUpload, filterPharmacy, filterRep, filterItem, filterHasBonus, filterCompensated, filterDelivered, H]);

  useEffect(() => {
    if (selectedUpload && tab === 'rows') loadRows(1);
    if (selectedUpload && tab === 'delivery') loadRows(1);
  }, [selectedUpload, tab, loadRows]);

  // ── Upload sales file ──────────────────────────────────────
  const handleUploadSales = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingSales(true);
    setUploadMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await axios.post('/api/bonus-sales/sales/upload', fd, {
        headers: { ...H(), 'Content-Type': 'multipart/form-data' },
      });
      setUploadMsg(`✅ تم رفع الملف — ${data.rowCount} سجل${data.warnings?.length ? ' | تحذيرات: ' + data.warnings.join(', ') : ''}`);
      await loadUploads();
    } catch (err: any) {
      setUploadMsg('❌ ' + (err.response?.data?.error ?? err.message));
    } finally {
      setUploadingSales(false);
      if (salesFileRef.current) salesFileRef.current.value = '';
    }
  };

  // ── Upload comp file ───────────────────────────────────────
  const handleUploadComp = async (e: React.ChangeEvent<HTMLInputElement>, salesUploadId: number) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingComp(true);
    setUploadMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('salesUploadId', String(salesUploadId));
      const { data } = await axios.post('/api/bonus-sales/comp/upload', fd, {
        headers: { ...H(), 'Content-Type': 'multipart/form-data' },
      });
      setUploadMsg(`✅ تم رفع ملف التعويضات — ${data.compRowCount} صف — تم مطابقة ${data.matchedCount} فاتورة`);
      await loadUploads();
      if (selectedUpload?.id === salesUploadId) loadRows(1);
    } catch (err: any) {
      setUploadMsg('❌ ' + (err.response?.data?.error ?? err.message));
    } finally {
      setUploadingComp(false);
      if (compFileRef.current) compFileRef.current.value = '';
    }
  };

  // ── Delete upload ──────────────────────────────────────────
  const handleDeleteUpload = async (id: number) => {
    if (!confirm('هل تريد حذف هذا الملف وجميع بياناته؟')) return;
    try {
      await axios.delete(`/api/bonus-sales/sales/uploads/${id}`, { headers: H() });
      if (selectedUpload?.id === id) setSelectedUpload(null);
      await loadUploads();
    } catch (err: any) {
      alert(err.response?.data?.error ?? err.message);
    }
  };

  // ── Mark delivered ─────────────────────────────────────────
  const openDeliveryModal = (row: SalesRow) => setDeliveryModal({ row, note: '' });

  const confirmDelivery = async () => {
    if (!deliveryModal) return;
    setMarkingDelivery(true);
    try {
      await axios.patch(`/api/bonus-sales/rows/${deliveryModal.row.id}/deliver`, { note: deliveryModal.note }, { headers: { ...H(), 'Content-Type': 'application/json' } });
      setDeliveryModal(null);
      loadRows(page);
    } catch (err: any) {
      alert(err.response?.data?.error ?? err.message);
    } finally {
      setMarkingDelivery(false);
    }
  };

  const unmarkDelivery = async (rowId: number) => {
    if (!confirm('إلغاء تأشير التسليم؟')) return;
    try {
      await axios.patch(`/api/bonus-sales/rows/${rowId}/undeliver`, {}, { headers: H() });
      loadRows(page);
    } catch (err: any) {
      alert(err.response?.data?.error ?? err.message);
    }
  };

  // ── KPIs from rows ─────────────────────────────────────────
  const withBonus      = rows.filter(r => r.hasBonus).length;
  const noBonus        = rows.filter(r => !r.hasBonus).length;
  const compensated    = rows.filter(r => !r.hasBonus && r.isCompensated).length;
  const delivered      = rows.filter(r => r.bonusDelivered).length;

  // ── Delivery tab rows (only compensated or with bonus, not yet delivered) ──
  const deliveryRows = rows.filter(r => (r.hasBonus || r.isCompensated));

  // ─────────────────────────────────────────────────────────────
  return (
    <div dir="rtl" style={{ padding: '16px 20px', fontFamily: 'Cairo, Tahoma, sans-serif', minHeight: '100vh', background: '#f8fafc' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#1e293b' }}>🎁 مبيعات البونص والتعويضات</h1>
        <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>
          رفع ملفات المبيعات ومقارنتها بملفات التعويضات — مع متابعة تسليم البونص للصيدليات
        </p>
      </div>

      {/* Upload message */}
      {uploadMsg && (
        <div style={{ background: uploadMsg.startsWith('✅') ? '#f0fdf4' : '#fef2f2', border: `1px solid ${uploadMsg.startsWith('✅') ? '#bbf7d0' : '#fecaca'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: uploadMsg.startsWith('✅') ? '#15803d' : '#991b1b' }}>
          {uploadMsg}
          <button onClick={() => setUploadMsg('')} style={{ background: 'none', border: 'none', cursor: 'pointer', marginRight: 8, fontSize: 14 }}>✕</button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e2e8f0', paddingBottom: 0 }}>
        {([
          { id: 'uploads',  label: '📁 الملفات'           },
          { id: 'rows',     label: '📋 بيانات المبيعات'   },
          { id: 'delivery', label: '🚚 تسليم البونص'      },
        ] as { id: TabId; label: string }[]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '9px 18px', border: 'none', borderRadius: '8px 8px 0 0',
              background: tab === t.id ? '#1a56db' : 'transparent',
              color: tab === t.id ? '#fff' : '#475569',
              fontWeight: 700, fontSize: 13, cursor: 'pointer',
              borderBottom: tab === t.id ? '2px solid #1a56db' : '2px solid transparent',
              marginBottom: -2,
            }}
          >{t.label}</button>
        ))}
      </div>

      {/* ── TAB: Uploads ──────────────────────────────────── */}
      {tab === 'uploads' && (
        <div>
          {/* Upload new sales file */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 20, marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#1e293b' }}>📤 رفع ملف المبيعات الأساسي</h3>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: '#64748b' }}>
              الملف يجب أن يحتوي على أعمدة: <strong>اسم الشركة — الايتم — التاريخ — الرقم — العدد — السعر — البونص — المجموع — المندوب — الصيدلية — المذخر</strong>
              <br />الأعمدة التي لا تحتوي على بونص (قيمة صفر أو فارغة) ستُعتبر بدون بونص وسيتم مقارنتها مع ملف التعويضات.
            </p>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#1a56db', color: '#fff', padding: '9px 20px', borderRadius: 8, cursor: uploadingSales ? 'not-allowed' : 'pointer', opacity: uploadingSales ? 0.6 : 1, fontWeight: 700, fontSize: 13 }}>
              {uploadingSales ? '⏳ جاري الرفع...' : '📂 اختر ملف Excel'}
              <input ref={salesFileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={handleUploadSales} disabled={uploadingSales} />
            </label>
          </div>

          {/* Sales uploads list */}
          {loadingUploads ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>جاري التحميل...</div>
          ) : salesUploads.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 14 }}>لا توجد ملفات مرفوعة بعد</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {salesUploads.map(upload => (
                <div key={upload.id} style={{ background: '#fff', border: `2px solid ${selectedUpload?.id === upload.id ? '#1a56db' : '#e2e8f0'}`, borderRadius: 12, padding: 16, transition: 'border-color 0.2s' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>📄 {upload.originalName}</div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
                        {upload.rowCount} سجل · رُفع {fmtDate(upload.uploadedAt)}
                      </div>
                      {/* Comp uploads attached */}
                      {upload.compUploads && upload.compUploads.length > 0 && (
                        <div style={{ marginTop: 6 }}>
                          {upload.compUploads.map(cu => (
                            <span key={cu.id} style={{ display: 'inline-block', background: '#dbeafe', color: '#1d4ed8', borderRadius: 6, padding: '2px 8px', fontSize: 11, marginLeft: 4, marginTop: 2 }}>
                              🔗 {cu.originalName} ({cu.rowCount} صف)
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => { setSelectedUpload(upload); setTab('rows'); loadRows(1); }}
                        style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontWeight: 600, color: '#334155' }}
                      >👁 عرض البيانات</button>

                      {/* Upload comp file for this sales upload */}
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: uploadingComp ? 'not-allowed' : 'pointer', color: '#15803d', fontWeight: 600 }}>
                        {uploadingComp ? '⏳...' : '📎 رفع ملف التعويضات'}
                        <input ref={compFileRef} type="file" accept=".xlsx,.xls,.csv" hidden
                          onChange={(e) => handleUploadComp(e, upload.id)}
                          disabled={uploadingComp}
                        />
                      </label>

                      <button
                        onClick={() => handleDeleteUpload(upload.id)}
                        style={{ background: '#fff0f0', border: '1px solid #fecaca', borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontWeight: 600, color: '#dc2626' }}
                      >🗑 حذف</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Sales Rows ────────────────────────────────── */}
      {tab === 'rows' && (
        <div>
          {/* Upload selector */}
          {salesUploads.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#475569', fontWeight: 600 }}>الملف:</span>
              <select
                value={selectedUpload?.id ?? ''}
                onChange={e => {
                  const u = salesUploads.find(x => x.id === Number(e.target.value));
                  setSelectedUpload(u ?? null);
                }}
                style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 12px', fontSize: 13, background: '#fff' }}
              >
                <option value="">— اختر ملف —</option>
                {salesUploads.map(u => <option key={u.id} value={u.id}>{u.originalName}</option>)}
              </select>
            </div>
          )}

          {!selectedUpload ? (
            <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8', fontSize: 14 }}>اختر ملفاً من التبويب الأول لعرض بياناته</div>
          ) : (
            <>
              {/* KPI cards */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                {[
                  { label: 'إجمالي السجلات', val: total,       color: '#1a56db', bg: '#eff6ff' },
                  { label: 'لديه بونص',       val: withBonus,  color: '#15803d', bg: '#f0fdf4' },
                  { label: 'بدون بونص',       val: noBonus,    color: '#b45309', bg: '#fefce8' },
                  { label: 'معوَّض',          val: compensated, color: '#6d28d9', bg: '#f5f3ff' },
                  { label: 'تم التسليم',      val: delivered,   color: '#0f766e', bg: '#f0fdfa' },
                ].map(k => (
                  <div key={k.label} style={{ background: k.bg, border: `1px solid ${k.color}22`, borderRadius: 10, padding: '10px 18px', minWidth: 110 }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: k.color }}>{k.val.toLocaleString('ar-IQ')}</div>
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{k.label}</div>
                  </div>
                ))}
              </div>

              {/* Filters */}
              <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 16px', marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 3 }}>الصيدلية</div>
                  <input value={filterPharmacy} onChange={e => setFilterPharmacy(e.target.value)}
                    placeholder="بحث..." style={{ border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 10px', fontSize: 12, width: 130 }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 3 }}>المندوب</div>
                  <input value={filterRep} onChange={e => setFilterRep(e.target.value)}
                    placeholder="بحث..." style={{ border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 10px', fontSize: 12, width: 130 }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 3 }}>الايتم</div>
                  <input value={filterItem} onChange={e => setFilterItem(e.target.value)}
                    placeholder="بحث..." style={{ border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 10px', fontSize: 12, width: 130 }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 3 }}>البونص</div>
                  <select value={filterHasBonus} onChange={e => setFilterHasBonus(e.target.value)}
                    style={{ border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 10px', fontSize: 12 }}>
                    <option value="">الكل</option>
                    <option value="true">لديه بونص</option>
                    <option value="false">بدون بونص</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 3 }}>التعويض</div>
                  <select value={filterCompensated} onChange={e => setFilterCompensated(e.target.value)}
                    style={{ border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 10px', fontSize: 12 }}>
                    <option value="">الكل</option>
                    <option value="true">معوَّض</option>
                    <option value="false">غير معوَّض</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 3 }}>التسليم</div>
                  <select value={filterDelivered} onChange={e => setFilterDelivered(e.target.value)}
                    style={{ border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 10px', fontSize: 12 }}>
                    <option value="">الكل</option>
                    <option value="true">تم التسليم</option>
                    <option value="false">لم يُسلَّم</option>
                  </select>
                </div>
                <button onClick={() => loadRows(1)} style={{ background: '#1a56db', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 18px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>🔍 بحث</button>
                <button onClick={() => { setFilterPharmacy(''); setFilterRep(''); setFilterItem(''); setFilterHasBonus(''); setFilterCompensated(''); setFilterDelivered(''); setTimeout(() => loadRows(1), 50); }}
                  style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: '#475569' }}>إعادة ضبط</button>
              </div>

              {/* Table */}
              {loadingRows ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>جاري التحميل...</div>
              ) : (
                <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                        {['الشركة','الايتم','الصيدلية','المذخر','المندوب','التاريخ','الرقم','العدد','السعر','المجموع','البونص','حالة البونص','التسليم','إجراء'].map(h => (
                          <th key={h} style={{ padding: '10px 10px', textAlign: 'right', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr><td colSpan={14} style={{ textAlign: 'center', padding: 30, color: '#94a3b8' }}>لا توجد سجلات</td></tr>
                      ) : rows.map((row, i) => (
                        <tr key={row.id} style={{ borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#fafbfc' }}>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{row.companyName ?? '—'}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.itemName ?? '—'}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.pharmacyName ?? '—'}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{row.warehouse ?? '—'}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{row.repName ?? '—'}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{fmtDate(row.invoiceDate)}</td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{row.invoiceNo ?? '—'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{fmtNum(row.quantity)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{fmtNum(row.price)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{fmtNum(row.total)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{row.hasBonus ? fmtNum(row.bonusQty) : '—'}</td>
                          <td style={{ padding: '8px 10px' }}><BonusStatusBadge row={row} /></td>
                          <td style={{ padding: '8px 10px' }}><DeliveryBadge row={row} /></td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                            {canManageDelivery && (row.hasBonus || row.isCompensated) && !row.bonusDelivered && (
                              <button onClick={() => openDeliveryModal(row)}
                                style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: '#15803d', fontWeight: 700 }}>
                                ✓ تسليم
                              </button>
                            )}
                            {canManageDelivery && row.bonusDelivered && (
                              <button onClick={() => unmarkDelivery(row.id)}
                                style={{ background: '#fff0f0', border: '1px solid #fecaca', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: '#dc2626' }}>
                                ✕ إلغاء
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pagination */}
              {total > PAGE_SIZE && (
                <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                  <button disabled={page === 1} onClick={() => loadRows(page - 1)}
                    style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', cursor: page === 1 ? 'not-allowed' : 'pointer', opacity: page === 1 ? 0.5 : 1 }}>◀ السابق</button>
                  <span style={{ padding: '6px 12px', fontSize: 13, color: '#64748b' }}>صفحة {page} / {Math.ceil(total / PAGE_SIZE)}</span>
                  <button disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => loadRows(page + 1)}
                    style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', cursor: page >= Math.ceil(total / PAGE_SIZE) ? 'not-allowed' : 'pointer', opacity: page >= Math.ceil(total / PAGE_SIZE) ? 0.5 : 1 }}>التالي ▶</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── TAB: Delivery ─────────────────────────────────── */}
      {tab === 'delivery' && (
        <div>
          {/* Upload selector */}
          {salesUploads.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#475569', fontWeight: 600 }}>الملف:</span>
              <select
                value={selectedUpload?.id ?? ''}
                onChange={e => {
                  const u = salesUploads.find(x => x.id === Number(e.target.value));
                  setSelectedUpload(u ?? null);
                }}
                style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 12px', fontSize: 13, background: '#fff' }}
              >
                <option value="">— اختر ملف —</option>
                {salesUploads.map(u => <option key={u.id} value={u.id}>{u.originalName}</option>)}
              </select>
            </div>
          )}

          {!selectedUpload ? (
            <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8', fontSize: 14 }}>اختر ملفاً لعرض حالة التسليم</div>
          ) : loadingRows ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>جاري التحميل...</div>
          ) : (
            <>
              {/* Summary */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                {[
                  { label: 'إجمالي فواتير البونص', val: deliveryRows.length, color: '#1a56db', bg: '#eff6ff' },
                  { label: 'تم تسليمها',            val: deliveryRows.filter(r => r.bonusDelivered).length, color: '#15803d', bg: '#f0fdf4' },
                  { label: 'لم تُسلَّم بعد',        val: deliveryRows.filter(r => !r.bonusDelivered).length, color: '#b45309', bg: '#fefce8' },
                ].map(k => (
                  <div key={k.label} style={{ background: k.bg, border: `1px solid ${k.color}22`, borderRadius: 10, padding: '10px 18px', minWidth: 110 }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: k.color }}>{k.val.toLocaleString('ar-IQ')}</div>
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{k.label}</div>
                  </div>
                ))}
              </div>

              <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                      {['الصيدلية','الايتم','المندوب','التاريخ','الرقم','كمية البونص','نوع البونص','حالة التسليم','تسلَّم بواسطة','تاريخ التسليم','ملاحظة','إجراء'].map(h => (
                        <th key={h} style={{ padding: '10px 10px', textAlign: 'right', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {deliveryRows.length === 0 ? (
                      <tr><td colSpan={12} style={{ textAlign: 'center', padding: 30, color: '#94a3b8' }}>لا توجد فواتير بونص في هذا الملف</td></tr>
                    ) : deliveryRows.map((row, i) => (
                      <tr key={row.id} style={{ borderBottom: '1px solid #f1f5f9', background: row.bonusDelivered ? '#f0fdf4' : (i % 2 === 0 ? '#fff' : '#fafbfc') }}>
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.pharmacyName ?? '—'}</td>
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.itemName ?? '—'}</td>
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{row.repName ?? '—'}</td>
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{fmtDate(row.invoiceDate)}</td>
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{row.invoiceNo ?? '—'}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{fmtNum(row.bonusQty)}</td>
                        <td style={{ padding: '8px 10px' }}><BonusStatusBadge row={row} /></td>
                        <td style={{ padding: '8px 10px' }}><DeliveryBadge row={row} /></td>
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                          {row.deliveredByUser ? (row.deliveredByUser.displayName ?? row.deliveredByUser.username) : '—'}
                        </td>
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{fmtDate(row.deliveredAt)}</td>
                        <td style={{ padding: '8px 10px', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.deliveryNote ?? '—'}</td>
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                          {canManageDelivery && !row.bonusDelivered && (
                            <button onClick={() => openDeliveryModal(row)}
                              style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '5px 12px', fontSize: 11, cursor: 'pointer', color: '#15803d', fontWeight: 700 }}>
                              ✓ تأشير التسليم
                            </button>
                          )}
                          {canManageDelivery && row.bonusDelivered && (
                            <button onClick={() => unmarkDelivery(row.id)}
                              style={{ background: '#fff0f0', border: '1px solid #fecaca', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', color: '#dc2626' }}>
                              ✕ إلغاء
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Delivery Modal ─────────────────────────────────── */}
      {deliveryModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDeliveryModal(null)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 400, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 800, color: '#1e293b' }}>✓ تأشير تسليم البونص</h3>
            <div style={{ background: '#f8fafc', borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 12, color: '#475569' }}>
              <div><strong>الصيدلية:</strong> {deliveryModal.row.pharmacyName}</div>
              <div><strong>الايتم:</strong> {deliveryModal.row.itemName}</div>
              <div><strong>رقم الفاتورة:</strong> {deliveryModal.row.invoiceNo}</div>
              <div><strong>كمية البونص:</strong> {fmtNum(deliveryModal.row.bonusQty)}</div>
            </div>
            <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 6, fontWeight: 600 }}>ملاحظة (اختيارية):</label>
            <textarea
              value={deliveryModal.note}
              onChange={e => setDeliveryModal(d => d ? { ...d, note: e.target.value } : d)}
              placeholder="أي ملاحظة عند التسليم..."
              rows={3}
              style={{ width: '100%', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeliveryModal(null)} style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 13, cursor: 'pointer', color: '#475569' }}>إلغاء</button>
              <button onClick={confirmDelivery} disabled={markingDelivery}
                style={{ background: '#15803d', border: 'none', borderRadius: 8, padding: '8px 24px', fontSize: 13, fontWeight: 700, cursor: markingDelivery ? 'not-allowed' : 'pointer', color: '#fff', opacity: markingDelivery ? 0.7 : 1 }}>
                {markingDelivery ? '⏳ جاري...' : '✓ تأكيد التسليم'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
