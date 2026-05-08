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
  isAssigned?: boolean;
  _count?: { rows: number };
  compUploads?: CompUpload[];
}

interface CompUpload {
  id: number;
  originalName: string;
  rowCount: number;
  uploadedAt: string;
}

interface AssignmentRep {
  userId: number;
  name: string;
  areas: string[];
  type: 'medical' | 'scientific';
}

interface SalesRow {
  id: number;
  uploadId: number;
  companyName: string | null;
  itemName: string | null;
  invoiceDate: string | null;
  invoiceNo: string | null;
  quantity: number | null;
  hasBonus: boolean;
  bonusQty: number | null;
  bonusValue: number | null;
  repName: string | null;
  pharmacyName: string | null;
  areaName: string | null;
  warehouse: string | null;
  isCompensated: boolean;
  compRowId: number | null;
  bonusDelivered: boolean;
  deliveredAt: string | null;
  deliveryNote: string | null;
  deliveredByUser?: { id: number; displayName?: string; username: string } | null;
  assignments?: { userId: number; user: { id: number; displayName?: string; username: string } }[];
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
  if (d.getFullYear() < 2000) return '—'; // guard against epoch / placeholder dates
  return d.toLocaleDateString('ar-IQ', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function fmtNum(n: number | null) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('ar-IQ');
}

function CombinedStatus({ row, canManage, onDeliver, onUndeliver }: {
  row: SalesRow;
  canManage: boolean;
  onDeliver: (row: SalesRow) => void;
  onUndeliver: (id: number) => void;
}) {
  // Determine badge
  let badge: { bg: string; color: string; label: string };
  if (row.bonusDelivered) {
    badge = { bg: '#dbeafe', color: '#1e40af', label: '✓ تم التسليم' };
  } else if (row.hasBonus) {
    badge = { bg: '#dcfce7', color: '#15803d', label: 'لديه بونص' };
  } else if (row.isCompensated) {
    badge = { bg: '#dbeafe', color: '#1d4ed8', label: 'معوَّض' };
  } else {
    badge = { bg: '#fef9c3', color: '#854d0e', label: 'بدون بونص' };
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <span style={{ background: badge.bg, color: badge.color, borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>{badge.label}</span>
      {canManage && (row.hasBonus || row.isCompensated) && !row.bonusDelivered && (
        <button onClick={() => onDeliver(row)}
          style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 5, padding: '2px 8px', fontSize: 10, cursor: 'pointer', color: '#15803d', fontWeight: 700, whiteSpace: 'nowrap' }}>
          ✓ تسليم
        </button>
      )}
      {canManage && row.bonusDelivered && (
        <button onClick={() => onUndeliver(row.id)}
          style={{ background: '#fff0f0', border: '1px solid #fecaca', borderRadius: 5, padding: '2px 8px', fontSize: 10, cursor: 'pointer', color: '#dc2626', whiteSpace: 'nowrap' }}>
          ✕ إلغاء
        </button>
      )}
    </div>
  );
}

// Compact table cell style
const TC: React.CSSProperties = {
  padding: '6px 8px', borderBottom: '1px solid #f1f5f9', fontSize: 11,
  color: '#374151', whiteSpace: 'nowrap', textAlign: 'center',
};

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
  const [smartSearch,        setSmartSearch]        = useState('');
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

  // ── Assignment state ───────────────────────────────────────
  const [assignReps, setAssignReps]           = useState<AssignmentRep[]>([]);
  const [assignAreas, setAssignAreas]         = useState<string[]>([]);
  const [assignModal, setAssignModal]         = useState<
    | { mode: 'auto' }
    | { mode: 'area'; area: string; userId: number | '' }
    | { mode: 'bulk'; rowIds: number[]; userId: number | '' }
    | { mode: 'row'; rowId: number; userId: number | '' }
    | null
  >(null);
  const [assignLoading, setAssignLoading]     = useState(false);
  const [assignMsg, setAssignMsg]             = useState('');
  const [selectedRowIds, setSelectedRowIds]   = useState<Set<number>>(new Set());

  // ── My rows (rep view) ─────────────────────────────────────
  const [myRows, setMyRows]           = useState<SalesRow[]>([]);
  const [myTotal, setMyTotal]         = useState(0);
  const [myPage, setMyPage]           = useState(1);
  const [mySearch, setMySearch]       = useState('');
  const [myFilterDelivered, setMyFilterDelivered] = useState('');
  const [myLoading, setMyLoading]     = useState(false);

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
      if (smartSearch)       params.search         = smartSearch;
      if (filterHasBonus    !== '') params.hasBonus      = filterHasBonus;
      if (filterCompensated !== '') params.isCompensated = filterCompensated;
      if (filterDelivered   !== '') params.bonusDelivered = filterDelivered;

      const { data } = await axios.get('/api/bonus-sales/sales/rows', { headers: H(), params });
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setPage(pg);
    } catch (_) { /* ignore */ }
    finally { setLoadingRows(false); }
  }, [selectedUpload, smartSearch, filterHasBonus, filterCompensated, filterDelivered, H]);

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
      loadMyRows(myPage);
    } catch (err: any) {
      alert(err.response?.data?.error ?? err.message);
    }
  };

  // ── Load assignment meta (reps + areas) ────────────────────
  const loadAssignMeta = useCallback(async (uploadId: number) => {
    try {
      const { data } = await axios.get(`/api/bonus-sales/sales/uploads/${uploadId}/assign-meta`, { headers: H() });
      setAssignReps(data.reps ?? []);
      setAssignAreas(data.areas ?? []);
    } catch (_) {}
  }, [H]);

  // ── Auto-assign upload ─────────────────────────────────────
  const handleAutoAssign = async () => {
    if (!selectedUpload) return;
    setAssignLoading(true);
    try {
      const { data } = await axios.post(`/api/bonus-sales/sales/uploads/${selectedUpload.id}/auto-assign`, {}, { headers: H() });
      setAssignMsg(`✅ تم التوزيع — ${data.assigned} تعيين، ${data.unmatched} صف غير مطابق`);
      await loadUploads();
      loadRows(page);
    } catch (err: any) {
      setAssignMsg('❌ ' + (err.response?.data?.error ?? err.message));
    } finally { setAssignLoading(false); setAssignModal(null); }
  };

  // ── Assign area to rep ─────────────────────────────────────
  const handleAssignArea = async () => {
    if (assignModal?.mode !== 'area' || !selectedUpload || !assignModal.userId) return;
    setAssignLoading(true);
    try {
      const { data } = await axios.post(`/api/bonus-sales/sales/uploads/${selectedUpload.id}/assign-area`,
        { areaName: assignModal.area, userId: assignModal.userId }, { headers: H() });
      setAssignMsg(`✅ تم تعيين ${data.assigned} صف من منطقة "${assignModal.area}"`);
      await loadUploads(); loadRows(page);
    } catch (err: any) {
      setAssignMsg('❌ ' + (err.response?.data?.error ?? err.message));
    } finally { setAssignLoading(false); setAssignModal(null); }
  };

  // ── Assign bulk rows to rep ────────────────────────────────
  const handleAssignBulk = async () => {
    if (assignModal?.mode !== 'bulk' || !assignModal.userId) return;
    setAssignLoading(true);
    try {
      const { data } = await axios.post('/api/bonus-sales/rows/assign-bulk',
        { rowIds: assignModal.rowIds, userId: assignModal.userId }, { headers: H() });
      setAssignMsg(`✅ تم تعيين ${data.assigned} صف`);
      setSelectedRowIds(new Set()); loadRows(page);
    } catch (err: any) {
      setAssignMsg('❌ ' + (err.response?.data?.error ?? err.message));
    } finally { setAssignLoading(false); setAssignModal(null); }
  };

  // ── Assign single row to rep ───────────────────────────────
  const handleAssignRow = async () => {
    if (assignModal?.mode !== 'row' || !assignModal.userId) return;
    setAssignLoading(true);
    try {
      await axios.post('/api/bonus-sales/rows/assign-bulk',
        { rowIds: [assignModal.rowId], userId: assignModal.userId }, { headers: H() });
      setAssignMsg('✅ تم التعيين');
      loadRows(page);
    } catch (err: any) {
      setAssignMsg('❌ ' + (err.response?.data?.error ?? err.message));
    } finally { setAssignLoading(false); setAssignModal(null); }
  };

  // ── Remove single assignment ───────────────────────────────
  const handleUnassignRow = async (rowId: number, userId: number) => {
    if (!confirm('إلغاء تعيين هذا المندوب من الصف؟')) return;
    try {
      await axios.delete(`/api/bonus-sales/rows/${rowId}/assign`, {
        headers: H(), data: { userId },
      });
      loadRows(page);
    } catch (err: any) {
      alert(err.response?.data?.error ?? err.message);
    }
  };

  // ── Load my rows (rep view) ────────────────────────────────
  const loadMyRows = useCallback(async (pg = 1) => {
    setMyLoading(true);
    try {
      const params: Record<string, string> = { page: String(pg), pageSize: '50' };
      if (mySearch) params.search = mySearch;
      if (myFilterDelivered !== '') params.bonusDelivered = myFilterDelivered;
      const { data } = await axios.get('/api/bonus-sales/my-rows', { headers: H(), params });
      setMyRows(data.rows ?? []);
      setMyTotal(data.total ?? 0);
      setMyPage(pg);
    } catch (_) {}
    finally { setMyLoading(false); }
  }, [H, mySearch, myFilterDelivered]);

  const isRep = role === 'user' || role === 'scientific_rep';
  useEffect(() => { if (isRep) loadMyRows(1); }, [isRep, loadMyRows]);

  // ── KPIs from rows ─────────────────────────────────────────
  const withBonus      = rows.filter(r => r.hasBonus).length;
  const noBonus        = rows.filter(r => !r.hasBonus).length;
  const compensated    = rows.filter(r => !r.hasBonus && r.isCompensated).length;
  const delivered      = rows.filter(r => r.bonusDelivered).length;

  // ── Delivery tab rows (only compensated or with bonus, not yet delivered) ──
  const deliveryRows = rows.filter(r => (r.hasBonus || r.isCompensated));

  // ─────────────────────────────────────────────────────────────
  // Rep view: show simplified "My Bonus" page
  if (isRep) {
    const myDelivered  = myRows.filter(r => r.bonusDelivered).length;
    const myPending    = myRows.filter(r => !r.bonusDelivered).length;
    return (
      <div dir="rtl" style={{ padding: '16px 20px', fontFamily: 'Cairo, Tahoma, sans-serif', minHeight: '100vh', background: '#f8fafc' }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#1e293b' }}>🎁 بونصاتي</h1>
          <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>قائمة الصيدليات المعيَّنة لك لتسليم البونص</p>
        </div>

        {/* KPIs */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { label: 'إجمالي المعيَّن لي', val: myTotal,    color: '#1a56db', bg: '#eff6ff' },
            { label: 'تم التسليم',          val: myDelivered, color: '#15803d', bg: '#f0fdf4' },
            { label: 'معلَّق',              val: myPending,   color: '#b45309', bg: '#fefce8' },
          ].map(k => (
            <div key={k.label} style={{ background: k.bg, border: `1px solid ${k.color}22`, borderRadius: 10, padding: '10px 18px', minWidth: 110 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: k.color }}>{k.val.toLocaleString('ar-IQ')}</div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{k.label}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={mySearch} onChange={e => setMySearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadMyRows(1)}
            placeholder="🔍 بحث بالصيدلية أو الايتم أو المنطقة..."
            style={{ flex: 1, minWidth: 200, padding: '7px 12px', borderRadius: 6, border: '1.5px solid #e2e8f0', fontSize: 12, background: '#f8fafc' }} />
          <select value={myFilterDelivered} onChange={e => setMyFilterDelivered(e.target.value)}
            style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '7px 10px', fontSize: 12, background: '#fff' }}>
            <option value="">التسليم: الكل</option>
            <option value="false">لم يُسلَّم</option>
            <option value="true">تم التسليم</option>
          </select>
          <button onClick={() => loadMyRows(1)} style={{ background: '#1e40af', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>بحث</button>
        </div>

        {myLoading ? <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>جاري التحميل...</div> : (
          <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#1e40af', color: '#fff' }}>
                  {['الصيدلية','المنطقة','الايتم','كمية البونص','التاريخ','الحالة'].map(h => (
                    <th key={h} style={{ padding: '9px 10px', fontWeight: 700, textAlign: h === 'الايتم' ? 'right' : 'center', borderLeft: '1px solid rgba(255,255,255,.15)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {myRows.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد بونصات معيَّنة لك حتى الآن</td></tr>
                ) : myRows.map((row, i) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid #f1f5f9', background: row.bonusDelivered ? '#f0fdf4' : (i % 2 === 0 ? '#fff' : '#f9fafb') }}>
                    <td style={TC}>{row.pharmacyName ?? '—'}</td>
                    <td style={TC}>{row.areaName ?? '—'}</td>
                    <td style={{ ...TC, textAlign: 'right', minWidth: 150, fontWeight: 600, color: '#1e293b', whiteSpace: 'normal' }}>{row.itemName ?? '—'}</td>
                    <td style={{ ...TC, textAlign: 'center' }}>{fmtNum(row.bonusQty)}</td>
                    <td style={{ ...TC, whiteSpace: 'nowrap' }}>{fmtDate(row.invoiceDate)}</td>
                    <td style={{ ...TC, textAlign: 'center', minWidth: 110 }}>
                      <CombinedStatus row={row} canManage={true} onDeliver={openDeliveryModal} onUndeliver={unmarkDelivery} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {myTotal > 50 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
            <button disabled={myPage === 1} onClick={() => loadMyRows(myPage - 1)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', cursor: myPage === 1 ? 'not-allowed' : 'pointer', opacity: myPage === 1 ? 0.5 : 1 }}>◀ السابق</button>
            <span style={{ padding: '6px 12px', fontSize: 13, color: '#64748b' }}>صفحة {myPage} / {Math.ceil(myTotal / 50)}</span>
            <button disabled={myPage >= Math.ceil(myTotal / 50)} onClick={() => loadMyRows(myPage + 1)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', cursor: myPage >= Math.ceil(myTotal / 50) ? 'not-allowed' : 'pointer', opacity: myPage >= Math.ceil(myTotal / 50) ? 0.5 : 1 }}>التالي ▶</button>
          </div>
        )}

        {/* Delivery Modal */}
        {deliveryModal && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDeliveryModal(null)}>
            <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 400, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 800, color: '#1e293b' }}>✓ تأشير تسليم البونص</h3>
              <div style={{ background: '#f8fafc', borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 12, color: '#475569' }}>
                <div><strong>الصيدلية:</strong> {deliveryModal.row.pharmacyName}</div>
                <div><strong>الايتم:</strong> {deliveryModal.row.itemName}</div>
              </div>
              <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 6, fontWeight: 600 }}>ملاحظة (اختيارية):</label>
              <textarea value={deliveryModal.note} onChange={e => setDeliveryModal(d => d ? { ...d, note: e.target.value } : d)}
                rows={3} placeholder="أي ملاحظة عند التسليم..."
                style={{ width: '100%', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
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

      {/* Assignment message */}
      {assignMsg && (
        <div style={{ background: assignMsg.startsWith('✅') ? '#f0fdf4' : '#fef2f2', border: `1px solid ${assignMsg.startsWith('✅') ? '#bbf7d0' : '#fecaca'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: assignMsg.startsWith('✅') ? '#15803d' : '#991b1b' }}>
          {assignMsg}
          <button onClick={() => setAssignMsg('')} style={{ background: 'none', border: 'none', cursor: 'pointer', marginRight: 8, fontSize: 14 }}>✕</button>
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

                      {/* Assign to reps */}
                      {isManager && (
                        upload.isAssigned
                          ? <span style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 14px', fontSize: 12, color: '#15803d', fontWeight: 700 }}>✓ موزَّع</span>
                          : <button
                              onClick={async () => {
                                setSelectedUpload(upload);
                                await loadAssignMeta(upload.id);
                                setAssignModal({ mode: 'auto' });
                              }}
                              style={{ background: '#fef9c3', border: '1px solid #fbbf24', borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontWeight: 700, color: '#92400e' }}
                            >📋 توزيع على المندوبين</button>
                      )}

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

              {/* Smart search + filters */}
              <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 14px', marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  value={smartSearch}
                  onChange={e => setSmartSearch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && loadRows(1)}
                  placeholder="🔍  بحث بالصيدلية أو الايتم أو المنطقة أو المندوب أو المذخر..."
                  style={{ flex: 1, minWidth: 220, padding: '7px 12px', borderRadius: 6, border: '1.5px solid #e2e8f0', fontSize: 12, background: '#f8fafc' }}
                />
                {/* Icon toggle: Bonus */}
                {(() => {
                  const states: {v:string; icon:string; title:string; bg:string; border:string; color:string}[] = [
                    { v: '',      icon: '🎁', title: 'البونص: الكل',  bg: '#fff',    border: '#e2e8f0', color: '#64748b' },
                    { v: 'true',  icon: '🎁', title: 'لديه بونص',    bg: '#f0fdf4', border: '#16a34a', color: '#16a34a' },
                    { v: 'false', icon: '🎁', title: 'بدون بونص',    bg: '#fef2f2', border: '#dc2626', color: '#dc2626' },
                  ];
                  const cur = states.find(s => s.v === filterHasBonus) ?? states[0];
                  const next = states[(states.indexOf(cur) + 1) % states.length];
                  return (
                    <button onClick={() => setFilterHasBonus(next.v)} title={cur.title}
                      style={{ border: `1.5px solid ${cur.border}`, borderRadius: 6, padding: '5px 9px', fontSize: 15, background: cur.bg, cursor: 'pointer', lineHeight: 1, display: 'flex', alignItems: 'center', gap: 3, color: cur.color, fontWeight: 700, position: 'relative' }}>
                      {cur.icon}
                      {cur.v !== '' && <span style={{ fontSize: 9, fontWeight: 800, lineHeight: 1 }}>{cur.v === 'true' ? '✓' : '✗'}</span>}
                    </button>
                  );
                })()}
                {/* Icon toggle: Compensation */}
                {(() => {
                  const states: {v:string; icon:string; title:string; bg:string; border:string; color:string}[] = [
                    { v: '',      icon: '💰', title: 'التعويض: الكل', bg: '#fff',    border: '#e2e8f0', color: '#64748b' },
                    { v: 'true',  icon: '💰', title: 'معوَّض',         bg: '#f0fdf4', border: '#16a34a', color: '#16a34a' },
                    { v: 'false', icon: '💰', title: 'غير معوَّض',     bg: '#fef2f2', border: '#dc2626', color: '#dc2626' },
                  ];
                  const cur = states.find(s => s.v === filterCompensated) ?? states[0];
                  const next = states[(states.indexOf(cur) + 1) % states.length];
                  return (
                    <button onClick={() => setFilterCompensated(next.v)} title={cur.title}
                      style={{ border: `1.5px solid ${cur.border}`, borderRadius: 6, padding: '5px 9px', fontSize: 15, background: cur.bg, cursor: 'pointer', lineHeight: 1, display: 'flex', alignItems: 'center', gap: 3, color: cur.color, fontWeight: 700 }}>
                      {cur.icon}
                      {cur.v !== '' && <span style={{ fontSize: 9, fontWeight: 800, lineHeight: 1 }}>{cur.v === 'true' ? '✓' : '✗'}</span>}
                    </button>
                  );
                })()}
                {/* Icon toggle: Delivery */}
                {(() => {
                  const states: {v:string; icon:string; title:string; bg:string; border:string; color:string}[] = [
                    { v: '',      icon: '🚚', title: 'التسليم: الكل', bg: '#fff',    border: '#e2e8f0', color: '#64748b' },
                    { v: 'true',  icon: '🚚', title: 'تم التسليم',    bg: '#f0fdf4', border: '#16a34a', color: '#16a34a' },
                    { v: 'false', icon: '🚚', title: 'لم يُسلَّم',    bg: '#fef2f2', border: '#dc2626', color: '#dc2626' },
                  ];
                  const cur = states.find(s => s.v === filterDelivered) ?? states[0];
                  const next = states[(states.indexOf(cur) + 1) % states.length];
                  return (
                    <button onClick={() => setFilterDelivered(next.v)} title={cur.title}
                      style={{ border: `1.5px solid ${cur.border}`, borderRadius: 6, padding: '5px 9px', fontSize: 15, background: cur.bg, cursor: 'pointer', lineHeight: 1, display: 'flex', alignItems: 'center', gap: 3, color: cur.color, fontWeight: 700 }}>
                      {cur.icon}
                      {cur.v !== '' && <span style={{ fontSize: 9, fontWeight: 800, lineHeight: 1 }}>{cur.v === 'true' ? '✓' : '✗'}</span>}
                    </button>
                  );
                })()}
                <button onClick={() => loadRows(1)} style={{ background: '#1e40af', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>بحث</button>
                <button onClick={() => { setSmartSearch(''); setFilterHasBonus(''); setFilterCompensated(''); setFilterDelivered(''); setTimeout(() => loadRows(1), 50); }}
                  style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, padding: '7px 12px', fontSize: 12, cursor: 'pointer', color: '#475569' }}>إعادة ضبط</button>
              </div>

              {/* Assignment toolbar (manager only) */}
              {isManager && (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 14px', marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#92400e' }}>📋 التوزيع:</span>
                  <button onClick={async () => { if (selectedUpload) { await loadAssignMeta(selectedUpload.id); setAssignModal({ mode: 'auto' }); } }}
                    style={{ background: '#fef9c3', border: '1px solid #fbbf24', borderRadius: 6, padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer', color: '#92400e' }}>
                    🤖 توزيع تلقائي بالمناطق
                  </button>
                  <button onClick={async () => { if (selectedUpload) { await loadAssignMeta(selectedUpload.id); setAssignModal({ mode: 'area', area: assignAreas[0] ?? '', userId: '' }); } }}
                    style={{ background: '#e0f2fe', border: '1px solid #7dd3fc', borderRadius: 6, padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer', color: '#075985' }}>
                    🗺 تعيين منطقة لمندوب
                  </button>
                  {selectedRowIds.size > 0 && (
                    <button onClick={async () => { if (selectedUpload) { await loadAssignMeta(selectedUpload.id); setAssignModal({ mode: 'bulk', rowIds: [...selectedRowIds], userId: '' }); } }}
                      style={{ background: '#ede9fe', border: '1px solid #a78bfa', borderRadius: 6, padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer', color: '#5b21b6' }}>
                      ✅ تعيين {selectedRowIds.size} صف محدد
                    </button>
                  )}
                  {selectedRowIds.size > 0 && (
                    <button onClick={() => setSelectedRowIds(new Set())}
                      style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', color: '#64748b' }}>
                      إلغاء التحديد
                    </button>
                  )}
                </div>
              )}

              {loadingRows ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>جاري التحميل...</div>
              ) : (
              <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0', overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: '#1e40af', color: '#fff' }}>
                        {isManager && <th style={{ padding: '8px 8px', width: 30 }}>
                          <input type="checkbox" onChange={e => setSelectedRowIds(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())}
                            checked={rows.length > 0 && selectedRowIds.size === rows.length} />
                        </th>}
                        {['الشركة','الايتم','الصيدلية','المنطقة','المذخر','المندوب','التاريخ','الرقم','العدد','البونص','المُعيَّنون','الحالة'].map(h => (
                          <th key={h} style={{ padding: '8px 8px', fontWeight: 600, whiteSpace: 'nowrap', textAlign: h === 'الايتم' ? 'right' : 'center', borderLeft: '1px solid rgba(255,255,255,.15)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr><td colSpan={isManager ? 13 : 12} style={{ textAlign: 'center', padding: 30, color: '#94a3b8' }}>لا توجد سجلات</td></tr>
                      ) : rows.map((row, i) => (
                        <tr key={row.id} style={{ borderBottom: '1px solid #f1f5f9', background: selectedRowIds.has(row.id) ? '#eff6ff' : (i % 2 === 0 ? '#fff' : '#f9fafb') }}>
                          {isManager && <td style={TC}>
                            <input type="checkbox" checked={selectedRowIds.has(row.id)}
                              onChange={e => setSelectedRowIds(prev => { const s = new Set(prev); e.target.checked ? s.add(row.id) : s.delete(row.id); return s; })} />
                          </td>}
                          <td style={TC}>{row.companyName ?? '—'}</td>
                          <td style={{ ...TC, textAlign: 'right', minWidth: 160, whiteSpace: 'normal', wordBreak: 'break-word', fontWeight: 600, color: '#1e293b' }}>{row.itemName ?? '—'}</td>
                          <td style={TC}>{row.pharmacyName ?? '—'}</td>
                          <td style={TC}>{row.areaName ?? '—'}</td>
                          <td style={TC}>{row.warehouse ?? '—'}</td>
                          <td style={TC}>{row.repName ?? '—'}</td>
                          <td style={{ ...TC, whiteSpace: 'nowrap' }}>{fmtDate(row.invoiceDate)}</td>
                          <td style={TC}>{row.invoiceNo ?? '—'}</td>
                          <td style={{ ...TC, textAlign: 'center' }}>{fmtNum(row.quantity)}</td>
                          <td style={{ ...TC, textAlign: 'center' }}>{row.hasBonus ? fmtNum(row.bonusQty) : '—'}</td>
                          {/* Assigned reps column */}
                          <td style={{ ...TC, textAlign: 'center', minWidth: 110 }}>
                            {row.assignments && row.assignments.length > 0 ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
                                {row.assignments.map(a => (
                                  <div key={a.userId} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                                    <span style={{ background: '#dbeafe', color: '#1d4ed8', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>
                                      {a.user.displayName || a.user.username}
                                    </span>
                                    {isManager && <button onClick={() => handleUnassignRow(row.id, a.userId)}
                                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 10, padding: '0 2px', lineHeight: 1 }} title="إلغاء التعيين">✕</button>}
                                  </div>
                                ))}
                                {isManager && <button onClick={async () => { await loadAssignMeta(selectedUpload!.id); setAssignModal({ mode: 'row', rowId: row.id, userId: '' }); }}
                                  style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 3, padding: '1px 6px', fontSize: 9, cursor: 'pointer', color: '#15803d', marginTop: 2 }}>+ إضافة</button>}
                              </div>
                            ) : (
                              isManager
                                ? <button onClick={async () => { await loadAssignMeta(selectedUpload!.id); setAssignModal({ mode: 'row', rowId: row.id, userId: '' }); }}
                                    style={{ background: '#fef9c3', border: '1px solid #fbbf24', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer', color: '#92400e', fontWeight: 700 }}>تعيين</button>
                                : <span style={{ color: '#94a3b8', fontSize: 10 }}>—</span>
                            )}
                          </td>
                          <td style={{ ...TC, textAlign: 'center', minWidth: 110 }}>
                            <CombinedStatus row={row} canManage={canManageDelivery} onDeliver={openDeliveryModal} onUndeliver={unmarkDelivery} />
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

              <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#1e40af', color: '#fff' }}>
                      {['الصيدلية','المنطقة','الايتم','المندوب','التاريخ','الرقم','كمية البونص','الحالة','تسلَّم بواسطة','تاريخ التسليم','ملاحظة'].map(h => (
                        <th key={h} style={{ padding: '8px 8px', fontWeight: 600, whiteSpace: 'nowrap', textAlign: h === 'الايتم' ? 'right' : 'center', borderLeft: '1px solid rgba(255,255,255,.15)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {deliveryRows.length === 0 ? (
                      <tr><td colSpan={11} style={{ textAlign: 'center', padding: 30, color: '#94a3b8' }}>لا توجد فواتير بونص في هذا الملف</td></tr>
                    ) : deliveryRows.map((row, i) => (
                      <tr key={row.id} style={{ borderBottom: '1px solid #f1f5f9', background: row.bonusDelivered ? '#f0fdf4' : (i % 2 === 0 ? '#fff' : '#f9fafb') }}>
                        <td style={TC}>{row.pharmacyName ?? '—'}</td>
                        <td style={TC}>{row.areaName ?? '—'}</td>
                        <td style={{ ...TC, textAlign: 'right', minWidth: 160, whiteSpace: 'normal', wordBreak: 'break-word', fontWeight: 600, color: '#1e293b' }}>{row.itemName ?? '—'}</td>
                        <td style={TC}>{row.repName ?? '—'}</td>
                        <td style={{ ...TC, whiteSpace: 'nowrap' }}>{fmtDate(row.invoiceDate)}</td>
                        <td style={TC}>{row.invoiceNo ?? '—'}</td>
                        <td style={{ ...TC, textAlign: 'center' }}>{fmtNum(row.bonusQty)}</td>
                        <td style={{ ...TC, textAlign: 'center', minWidth: 110 }}>
                          <CombinedStatus row={row} canManage={canManageDelivery} onDeliver={openDeliveryModal} onUndeliver={unmarkDelivery} />
                        </td>
                        <td style={TC}>{row.deliveredByUser ? (row.deliveredByUser.displayName ?? row.deliveredByUser.username) : '—'}</td>
                        <td style={{ ...TC, whiteSpace: 'nowrap' }}>{fmtDate(row.deliveredAt)}</td>
                        <td style={{ ...TC, maxWidth: 100 }}>{row.deliveryNote ?? '—'}</td>
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

      {/* ── Assignment Modals ──────────────────────────────── */}
      {assignModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setAssignModal(null)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 440, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>

            {/* AUTO mode */}
            {assignModal.mode === 'auto' && (
              <>
                <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 800, color: '#1e293b' }}>🤖 توزيع تلقائي على المندوبين</h3>
                <p style={{ fontSize: 13, color: '#475569', margin: '0 0 16px' }}>
                  سيتم مطابقة مناطق الصفوف مع مناطق المندوبين تلقائياً وتعيين كل صف للمندوبين المختصين بتلك المنطقة.
                </p>
                <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 12, color: '#1d4ed8' }}>
                  <strong>عدد المندوبين المتاحين:</strong> {assignReps.length} &nbsp;|&nbsp; <strong>المناطق:</strong> {assignAreas.length}
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => setAssignModal(null)} style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 13, cursor: 'pointer', color: '#475569' }}>إلغاء</button>
                  <button onClick={handleAutoAssign} disabled={assignLoading}
                    style={{ background: '#1e40af', border: 'none', borderRadius: 8, padding: '8px 24px', fontSize: 13, fontWeight: 700, cursor: assignLoading ? 'not-allowed' : 'pointer', color: '#fff', opacity: assignLoading ? 0.7 : 1 }}>
                    {assignLoading ? '⏳ جاري...' : '🤖 بدء التوزيع التلقائي'}
                  </button>
                </div>
              </>
            )}

            {/* AREA mode */}
            {assignModal.mode === 'area' && (
              <>
                <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 800, color: '#1e293b' }}>🗺 تعيين منطقة لمندوب</h3>
                <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4, fontWeight: 600 }}>المنطقة:</label>
                <select value={assignModal.area}
                  onChange={e => setAssignModal({ mode: 'area', area: e.target.value, userId: assignModal.userId })}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, marginBottom: 12, background: '#fff' }}>
                  <option value="">-- اختر منطقة --</option>
                  {assignAreas.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4, fontWeight: 600 }}>المندوب:</label>
                <select value={assignModal.userId}
                  onChange={e => setAssignModal({ mode: 'area', area: assignModal.area, userId: Number(e.target.value) || '' })}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, marginBottom: 16, background: '#fff' }}>
                  <option value="">-- اختر مندوب --</option>
                  {assignReps.map(r => (
                    <option key={r.userId} value={r.userId}>{r.name} ({r.type === 'medical' ? 'طبي' : 'علمي'}) — {r.areas.slice(0,3).join('، ')}{r.areas.length > 3 ? '...' : ''}</option>
                  ))}
                </select>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => setAssignModal(null)} style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 13, cursor: 'pointer', color: '#475569' }}>إلغاء</button>
                  <button onClick={handleAssignArea} disabled={assignLoading || !assignModal.area || !assignModal.userId}
                    style={{ background: '#075985', border: 'none', borderRadius: 8, padding: '8px 24px', fontSize: 13, fontWeight: 700, cursor: (assignLoading || !assignModal.area || !assignModal.userId) ? 'not-allowed' : 'pointer', color: '#fff', opacity: (assignLoading || !assignModal.area || !assignModal.userId) ? 0.6 : 1 }}>
                    {assignLoading ? '⏳ جاري...' : '✅ تعيين المنطقة'}
                  </button>
                </div>
              </>
            )}

            {/* BULK mode */}
            {assignModal.mode === 'bulk' && (
              <>
                <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 800, color: '#1e293b' }}>✅ تعيين {assignModal.rowIds.length} صف لمندوب</h3>
                <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4, fontWeight: 600 }}>اختر المندوب:</label>
                <select value={assignModal.userId}
                  onChange={e => setAssignModal({ mode: 'bulk', rowIds: assignModal.rowIds, userId: Number(e.target.value) || '' })}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, marginBottom: 16, background: '#fff' }}>
                  <option value="">-- اختر مندوب --</option>
                  {assignReps.map(r => (
                    <option key={r.userId} value={r.userId}>{r.name} ({r.type === 'medical' ? 'طبي' : 'علمي'})</option>
                  ))}
                </select>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => setAssignModal(null)} style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 13, cursor: 'pointer', color: '#475569' }}>إلغاء</button>
                  <button onClick={handleAssignBulk} disabled={assignLoading || !assignModal.userId}
                    style={{ background: '#5b21b6', border: 'none', borderRadius: 8, padding: '8px 24px', fontSize: 13, fontWeight: 700, cursor: (assignLoading || !assignModal.userId) ? 'not-allowed' : 'pointer', color: '#fff', opacity: (assignLoading || !assignModal.userId) ? 0.6 : 1 }}>
                    {assignLoading ? '⏳ جاري...' : `✅ تعيين ${assignModal.rowIds.length} صف`}
                  </button>
                </div>
              </>
            )}

            {/* ROW mode */}
            {assignModal.mode === 'row' && (
              <>
                <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 800, color: '#1e293b' }}>👤 تعيين صف لمندوب</h3>
                <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4, fontWeight: 600 }}>اختر المندوب:</label>
                <select value={assignModal.userId}
                  onChange={e => setAssignModal({ mode: 'row', rowId: assignModal.rowId, userId: Number(e.target.value) || '' })}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, marginBottom: 16, background: '#fff' }}>
                  <option value="">-- اختر مندوب --</option>
                  {assignReps.map(r => (
                    <option key={r.userId} value={r.userId}>{r.name} ({r.type === 'medical' ? 'طبي' : 'علمي'})</option>
                  ))}
                </select>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => setAssignModal(null)} style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 13, cursor: 'pointer', color: '#475569' }}>إلغاء</button>
                  <button onClick={handleAssignRow} disabled={assignLoading || !assignModal.userId}
                    style={{ background: '#15803d', border: 'none', borderRadius: 8, padding: '8px 24px', fontSize: 13, fontWeight: 700, cursor: (assignLoading || !assignModal.userId) ? 'not-allowed' : 'pointer', color: '#fff', opacity: (assignLoading || !assignModal.userId) ? 0.6 : 1 }}>
                    {assignLoading ? '⏳ جاري...' : '✅ تعيين'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

