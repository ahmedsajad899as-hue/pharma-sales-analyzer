import { useState, useEffect, useCallback, useRef } from 'react';
import { usePageBackHandler } from '../hooks/useBackHandler';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';

// ─── Types ────────────────────────────────────────────────────
interface UploadRecord {
  id: number;
  originalName: string;
  rowCount: number;
  uploadedAt: string;
}

interface KPIs {
  totalRecords: number;
  totalMonth3: number;
  totalMonth4: number;
  totalSold: number;
  totalReinvoicing: number;
  growthPct: number | null;
  reinvoicingItems: number;
  zeroMovement: number;
  staleItems: number;
}

interface TeamRow {
  teamName: string;
  month3: number;
  month4: number;
  totalSold: number;
  reinvoicing: number;
  itemCount: number;
  growthPct: number | null;
}

interface DistributorRow {
  distributorName: string;
  teamName: string;
  month3: number;
  month4: number;
  totalSold: number;
  reinvoicing: number;
  itemCount: number;
  growthPct: number | null;
  sharePct: number;
}

interface ItemRow {
  itemName: string;
  month3: number;
  month4: number;
  totalSold: number;
  reinvoicing: number;
  distributorCount: number;
  growthPct: number | null;
  status: 'growing' | 'stable' | 'declining' | 'stopped' | 'new';
}

interface ReinvoicingRow {
  id: number;
  teamName: string | null;
  distributorName: string;
  itemName: string;
  month3Qty: number;
  month4Qty: number;
  saleDate: string | null;
  totalQtySold: number;
  reinvoicingCount: number;
}

type TabId = 'upload' | 'overview' | 'teams' | 'distributors' | 'items' | 'reinvoicing';

// ─── Helpers ──────────────────────────────────────────────────
function fmt(n: number) {
  return n.toLocaleString('ar-IQ');
}

function GrowthBadge({ val }: { val: number | null }) {
  if (val === null) return <span style={{ color: '#64748b', fontSize: 12 }}>جديد</span>;
  const color = val > 0 ? '#16a34a' : val < 0 ? '#dc2626' : '#64748b';
  const arrow = val > 0 ? '▲' : val < 0 ? '▼' : '─';
  return (
    <span style={{ color, fontWeight: 600, fontSize: 12, direction: 'ltr', display: 'inline-block' }}>
      {arrow} {Math.abs(val)}%
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    growing:   { label: 'نمو',      color: '#15803d', bg: '#dcfce7' },
    stable:    { label: 'ثابت',     color: '#92400e', bg: '#fef3c7' },
    declining: { label: 'تراجع',    color: '#b91c1c', bg: '#fee2e2' },
    stopped:   { label: 'توقف',     color: '#7c3aed', bg: '#ede9fe' },
    new:       { label: 'جديد',     color: '#0369a1', bg: '#e0f2fe' },
  };
  const s = map[status] || { label: status, color: '#64748b', bg: '#f1f5f9' };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
      color: s.color, background: s.bg,
    }}>
      {s.label}
    </span>
  );
}

function BarRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: '#1e293b' }}>{label}</span>
        <span style={{ fontSize: 12, color: '#64748b', direction: 'ltr' }}>{fmt(value)}</span>
      </div>
      <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 4, transition: 'width 0.4s' }} />
      </div>
    </div>
  );
}

function KPICard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div style={{
      background: '#fff', borderRadius: 12, padding: '16px 20px', border: '1px solid #e2e8f0',
      boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
    }}>
      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function DistributorSalesPage() {
  const { token, hasFeature } = useAuth();
  const [activeTab, setActiveTab] = useState<TabId>('upload');
  const [selectedUploadId, setSelectedUploadId] = useState<number | null>(null);

  // Back button: go to upload tab when on analysis tabs (only if this page is active)
  usePageBackHandler('distributor-sales', [
    [activeTab !== 'upload', () => setActiveTab('upload')],
  ]);

  // Upload state
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ type: 'success' | 'error'; text: string; warnings?: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Analysis state
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [distributors, setDistributors] = useState<DistributorRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [reinvoicing, setReinvoicing] = useState<ReinvoicingRow[]>([]);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);

  // Filters
  const [itemSearch, setItemSearch] = useState('');
  const [distSearch, setDistSearch] = useState('');
  const [itemSort, setItemSort] = useState<'totalSold' | 'growthPct' | 'reinvoicing'>('totalSold');

  const headers = { Authorization: `Bearer ${token}` };
  const qs = selectedUploadId ? `?uploadId=${selectedUploadId}` : '';

  // ── Fetch uploads list ──────────────────────────────────────
  const fetchUploads = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/distributor-sales/uploads', { headers });
      setUploads(data);
      if (!selectedUploadId && data.length > 0) setSelectedUploadId(data[0].id);
    } catch { /* silent */ }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchUploads(); }, [fetchUploads]);

  // ── Eagerly fetch distributors/teams/items when an upload is selected,
  //     so the AI Assistant has full context (names) to filter against. ──
  useEffect(() => {
    if (!selectedUploadId) return;
    const qs2 = `?uploadId=${selectedUploadId}`;
    const headers2 = { Authorization: `Bearer ${token}` };
    Promise.all([
      teams.length        ? Promise.resolve({ data: teams })        : axios.get(`/api/distributor-sales/analysis/teams${qs2}`,        { headers: headers2 }).then(r => { setTeams(r.data); return r; }).catch(() => ({ data: [] })),
      distributors.length ? Promise.resolve({ data: distributors }) : axios.get(`/api/distributor-sales/analysis/distributors${qs2}`, { headers: headers2 }).then(r => { setDistributors(r.data); return r; }).catch(() => ({ data: [] })),
      items.length        ? Promise.resolve({ data: items })        : axios.get(`/api/distributor-sales/analysis/items${qs2}`,        { headers: headers2 }).then(r => { setItems(r.data); return r; }).catch(() => ({ data: [] })),
    ]).catch(() => {});
  }, [selectedUploadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Expose distributor-sales context for the AI Assistant ───────
  useEffect(() => {
    if (!selectedUploadId) {
      delete (window as any).__distributorSalesDigest;
      return;
    }
    const distributorNames = [...new Set(distributors.map(d => d.distributorName).filter(Boolean))];
    const teamNames        = [...new Set([...teams.map(t => t.teamName), ...distributors.map(d => d.teamName)].filter(Boolean))];
    const itemNames        = [...new Set(items.map(i => i.itemName).filter(Boolean))];
    (window as any).__distributorSalesDigest = {
      uploadId: selectedUploadId,
      distributors: distributorNames,
      teams: teamNames,
      items: itemNames,
    };
    return () => { delete (window as any).__distributorSalesDigest; };
  }, [selectedUploadId, distributors, teams, items]);

  // ── Fetch analysis when tab or upload changes ───────────────
  useEffect(() => {
    if (activeTab === 'upload' || !selectedUploadId) return;
    setLoadingAnalysis(true);

    const endpoints: Record<TabId, string> = {
      overview:     `/api/distributor-sales/analysis${qs}`,
      teams:        `/api/distributor-sales/analysis/teams${qs}`,
      distributors: `/api/distributor-sales/analysis/distributors${qs}`,
      items:        `/api/distributor-sales/analysis/items${qs}`,
      reinvoicing:  `/api/distributor-sales/analysis/reinvoicing${qs}`,
      upload:       '',
    };

    const fetchers: Partial<Record<TabId, () => Promise<void>>> = {
      overview: async () => {
        const { data } = await axios.get(endpoints.overview, { headers });
        setKpis(data);
      },
      teams: async () => {
        const { data } = await axios.get(endpoints.teams, { headers });
        setTeams(data);
      },
      distributors: async () => {
        const { data } = await axios.get(endpoints.distributors, { headers });
        setDistributors(data);
      },
      items: async () => {
        const { data } = await axios.get(endpoints.items, { headers });
        setItems(data);
      },
      reinvoicing: async () => {
        const { data } = await axios.get(endpoints.reinvoicing, { headers });
        setReinvoicing(data);
      },
    };

    (fetchers[activeTab] ? fetchers[activeTab]!() : Promise.resolve())
      .catch(() => {})
      .finally(() => setLoadingAnalysis(false));
  }, [activeTab, selectedUploadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── File upload handler ─────────────────────────────────────
  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadMsg(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const { data } = await axios.post('/api/distributor-sales/upload', form, {
        headers: { ...headers, 'Content-Type': 'multipart/form-data' },
      });
      setUploadMsg({
        type: 'success',
        text: `تم رفع ${data.rowCount} سجل بنجاح.${data.warnings?.length ? ` (${data.warnings.length} تحذير)` : ''}`,
      });
      await fetchUploads();
      setSelectedUploadId(data.uploadId);
      setActiveTab('overview');
    } catch (err: any) {
      setUploadMsg({
        type: 'error',
        text: err.response?.data?.error || 'فشل الرفع',
        warnings: err.response?.data?.warnings || [],
      });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('حذف هذا الملف وكل بياناته؟')) return;
    try {
      await axios.delete(`/api/distributor-sales/uploads/${id}`, { headers });
      if (selectedUploadId === id) setSelectedUploadId(null);
      await fetchUploads();
    } catch { /* silent */ }
  };

  // ── Drag & drop ─────────────────────────────────────────────
  const [dragging, setDragging] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  };

  if (!hasFeature('distributor_sales')) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🔒</div>
        <div>هذه الميزة غير مفعّلة لحسابك.</div>
      </div>
    );
  }

  // ─── Tabs ───────────────────────────────────────────────────
  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'upload',       label: 'رفع ملف',         icon: '📤' },
    { id: 'overview',     label: 'نظرة عامة',        icon: '📊' },
    { id: 'teams',        label: 'حسب الفريق',       icon: '🏷️' },
    { id: 'distributors', label: 'حسب الموزع',       icon: '🏢' },
    { id: 'items',        label: 'المنتجات',          icon: '💊' },
    { id: 'reinvoicing',  label: 'اعادة الفوترة',    icon: '🔁' },
  ];

  return (
    <div style={{ padding: '16px 20px', maxWidth: 1100, margin: '0 auto', direction: 'rtl' }}>
      {/* ── Header ── */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', margin: 0 }}>
          📦 تحليل مبيعات الموزعين
        </h1>
        <p style={{ color: '#64748b', fontSize: 13, marginTop: 4, marginBottom: 0 }}>
          رفع وتحليل ملفات Excel بتنسيق امازون / فريق — شهر3 / شهر4 / اعادة الفوترة
        </p>
      </div>

      {/* ── Upload selector (shown when upload exists) ── */}
      {uploads.length > 0 && (
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>الملف المحلل:</span>
          <select
            value={selectedUploadId ?? ''}
            onChange={e => setSelectedUploadId(Number(e.target.value))}
            style={{
              padding: '4px 10px', borderRadius: 8, border: '1px solid #e2e8f0',
              fontSize: 13, color: '#1e293b', background: '#fff', cursor: 'pointer',
            }}
          >
            {uploads.map(u => (
              <option key={u.id} value={u.id}>
                {u.originalName} — {u.rowCount} سجل ({new Date(u.uploadedAt).toLocaleDateString('ar-IQ')})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid #e2e8f0', paddingBottom: 0, flexWrap: 'wrap' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '8px 14px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: activeTab === tab.id ? 700 : 400,
              color: activeTab === tab.id ? '#4f46e5' : '#64748b',
              borderBottom: activeTab === tab.id ? '2px solid #4f46e5' : '2px solid transparent',
              marginBottom: -2, transition: 'all 0.15s',
            }}
          >
            {tab.icon} {tab.label}
            {tab.id === 'reinvoicing' && reinvoicing.length > 0 && (
              <span style={{
                marginRight: 4, background: '#dc2626', color: '#fff',
                borderRadius: 999, fontSize: 10, padding: '1px 5px', fontWeight: 700,
              }}>{reinvoicing.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab: Upload ── */}
      {activeTab === 'upload' && (
        <div>
          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragging ? '#4f46e5' : '#cbd5e1'}`,
              borderRadius: 16, padding: '40px 20px', textAlign: 'center',
              cursor: 'pointer', background: dragging ? '#eef2ff' : '#f8fafc',
              transition: 'all 0.2s', marginBottom: 20,
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 10 }}>📤</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>
              اسحب ملف Excel هنا أو انقر للاختيار
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8' }}>يدعم: Excel (.xlsx / .xls) · CSV</div>
            <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4 }}>
              ⚠️ ملفات PDF غير مدعومة — حوّل الملف لـ Excel أولاً
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); }}
            />
          </div>

          {/* Upload status */}
          {uploading && (
            <div style={{ textAlign: 'center', color: '#4f46e5', marginBottom: 12 }}>
              ⏳ جاري المعالجة...
            </div>
          )}
          {uploadMsg && (
            <div style={{
              padding: '10px 16px', borderRadius: 10, marginBottom: 16,
              background: uploadMsg.type === 'success' ? '#dcfce7' : '#fee2e2',
              color: uploadMsg.type === 'success' ? '#15803d' : '#b91c1c',
              fontSize: 13, fontWeight: 500,
            }}>
              {uploadMsg.type === 'success' ? '✅ ' : '❌ '}{uploadMsg.text}
              {uploadMsg.warnings && uploadMsg.warnings.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingRight: 16, fontSize: 12, fontWeight: 400 }}>
                  {uploadMsg.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Previous uploads */}
          {uploads.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>
                الملفات السابقة ({uploads.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {uploads.map(u => (
                  <div key={u.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: selectedUploadId === u.id ? '#eef2ff' : '#fff',
                    border: `1px solid ${selectedUploadId === u.id ? '#a5b4fc' : '#e2e8f0'}`,
                    borderRadius: 10, padding: '10px 14px', cursor: 'pointer',
                  }}
                    onClick={() => { setSelectedUploadId(u.id); setActiveTab('overview'); }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{u.originalName}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                        {u.rowCount} سجل — {new Date(u.uploadedAt).toLocaleDateString('ar-IQ')}
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(u.id); }}
                      style={{
                        border: 'none', background: 'none', color: '#dc2626',
                        cursor: 'pointer', fontSize: 16, padding: 4,
                      }}
                      title="حذف"
                    >🗑️</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Loading spinner for analysis tabs ── */}
      {activeTab !== 'upload' && loadingAnalysis && (
        <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
          <div style={{
            width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#6366f1',
            borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto 12px',
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          جاري تحليل البيانات...
        </div>
      )}

      {/* No data message */}
      {activeTab !== 'upload' && !loadingAnalysis && !selectedUploadId && (
        <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>📂</div>
          <div>لا توجد بيانات. ارفع ملف أولاً من تبويب "رفع ملف".</div>
        </div>
      )}

      {/* ── Tab: Overview ── */}
      {activeTab === 'overview' && !loadingAnalysis && kpis && (
        <div>
          {/* KPI Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
            <KPICard label="إجمالي السجلات" value={fmt(kpis.totalRecords)} color="#1e293b" />
            <KPICard label="كمية شهر 3" value={fmt(kpis.totalMonth3)} color="#1d4ed8" />
            <KPICard label="كمية شهر 4" value={fmt(kpis.totalMonth4)} color="#0891b2" />
            <KPICard
              label="نمو م3 → م4"
              value={kpis.growthPct !== null ? `${kpis.growthPct > 0 ? '+' : ''}${kpis.growthPct}%` : 'N/A'}
              color={kpis.growthPct === null ? '#64748b' : kpis.growthPct >= 0 ? '#15803d' : '#dc2626'}
            />
            <KPICard label="إجمالي المبيعات" value={fmt(kpis.totalSold)} color="#7c3aed" />
            <KPICard label="اعادة الفوترة (عناصر)" value={String(kpis.reinvoicingItems)} sub={`إجمالي: ${fmt(kpis.totalReinvoicing)}`} color="#ea580c" />
            <KPICard label="توقفت (م3>0, م4=0)" value={String(kpis.zeroMovement)} color="#dc2626" />
            <KPICard label="راكدة (+90 يوم)" value={String(kpis.staleItems)} color="#92400e" />
          </div>

          {/* Top items bar chart */}
          {items.length > 0 ? (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '16px 20px', marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: '#1e293b' }}>
                🏆 أعلى 15 منتجاً (إجمالي المبيعات)
              </div>
              {items.slice(0, 15).map((item, i) => (
                <BarRow
                  key={item.itemName}
                  label={`${i + 1}. ${item.itemName}`}
                  value={item.totalSold}
                  max={items[0]?.totalSold || 1}
                  color={item.status === 'growing' ? '#16a34a' : item.status === 'declining' ? '#dc2626' : '#4f46e5'}
                />
              ))}
            </div>
          ) : (
            <button
              onClick={() => setActiveTab('items')}
              style={{
                background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
                padding: '10px 16px', cursor: 'pointer', fontSize: 13, color: '#4f46e5',
              }}
            >
              تحميل بيانات المنتجات للمخطط ←
            </button>
          )}

          {/* Team comparison */}
          {teams.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '16px 20px' }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: '#1e293b' }}>
                🏷️ مقارنة الفرق
              </div>
              {teams.map(t => (
                <BarRow
                  key={t.teamName}
                  label={`${t.teamName} (${t.itemCount} عنصر)`}
                  value={t.totalSold}
                  max={teams[0]?.totalSold || 1}
                  color="#6366f1"
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Teams ── */}
      {activeTab === 'teams' && !loadingAnalysis && teams.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {teams.map(t => (
            <div key={t.teamName} style={{
              background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
              padding: '14px 18px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{t.teamName}</div>
                <GrowthBadge val={t.growthPct} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
                {[
                  { label: 'شهر 3', val: fmt(t.month3), color: '#1d4ed8' },
                  { label: 'شهر 4', val: fmt(t.month4), color: '#0891b2' },
                  { label: 'إجمالي المبيعات', val: fmt(t.totalSold), color: '#7c3aed' },
                  { label: 'اعادة الفوترة', val: fmt(t.reinvoicing), color: '#ea580c' },
                  { label: 'عدد العناصر', val: String(t.itemCount), color: '#64748b' },
                ].map(c => (
                  <div key={c.label} style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 12px' }}>
                    <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>{c.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: c.color, marginTop: 2 }}>{c.val}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Tab: Distributors ── */}
      {activeTab === 'distributors' && !loadingAnalysis && (
        <div>
          <input
            type="text"
            placeholder="بحث باسم الموزع..."
            value={distSearch}
            onChange={e => setDistSearch(e.target.value)}
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e8f0',
              fontSize: 13, marginBottom: 12, boxSizing: 'border-box', direction: 'rtl',
            }}
          />
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f1f5f9', borderBottom: '2px solid #e2e8f0' }}>
                  {['الموزع', 'الفريق', 'شهر 3', 'شهر 4', 'نمو', 'إجمالي', 'الحصة %', 'اعادة فوترة', 'عناصر'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'right', color: '#374151', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {distributors
                  .filter(d => !distSearch || d.distributorName.toLowerCase().includes(distSearch.toLowerCase()))
                  .map((d, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 500 }}>{d.distributorName}</td>
                      <td style={{ padding: '8px 10px', color: '#64748b' }}>{d.teamName}</td>
                      <td style={{ padding: '8px 10px', direction: 'ltr' }}>{fmt(d.month3)}</td>
                      <td style={{ padding: '8px 10px', direction: 'ltr' }}>{fmt(d.month4)}</td>
                      <td style={{ padding: '8px 10px' }}><GrowthBadge val={d.growthPct} /></td>
                      <td style={{ padding: '8px 10px', fontWeight: 600, direction: 'ltr' }}>{fmt(d.totalSold)}</td>
                      <td style={{ padding: '8px 10px', direction: 'ltr' }}>{d.sharePct}%</td>
                      <td style={{ padding: '8px 10px', color: d.reinvoicing > 0 ? '#ea580c' : '#94a3b8', direction: 'ltr' }}>{fmt(d.reinvoicing)}</td>
                      <td style={{ padding: '8px 10px', color: '#64748b', direction: 'ltr' }}>{d.itemCount}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tab: Items ── */}
      {activeTab === 'items' && !loadingAnalysis && (
        <div>
          {/* Controls */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="بحث باسم المنتج..."
              value={itemSearch}
              onChange={e => setItemSearch(e.target.value)}
              style={{
                flex: 1, minWidth: 180, padding: '8px 12px', borderRadius: 8,
                border: '1px solid #e2e8f0', fontSize: 13, direction: 'rtl',
              }}
            />
            <select
              value={itemSort}
              onChange={e => setItemSort(e.target.value as typeof itemSort)}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }}
            >
              <option value="totalSold">ترتيب: إجمالي المبيعات</option>
              <option value="growthPct">ترتيب: نسبة النمو</option>
              <option value="reinvoicing">ترتيب: اعادة الفوترة</option>
            </select>
          </div>

          {/* Summary pills */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            {(['growing', 'stable', 'declining', 'stopped', 'new'] as const).map(s => {
              const count = items.filter(i => i.status === s).length;
              return count > 0 ? <StatusBadge key={s} status={s} /> : null;
            })}
            <span style={{ fontSize: 11, color: '#94a3b8', alignSelf: 'center' }}>
              {items.length} منتج
            </span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f1f5f9', borderBottom: '2px solid #e2e8f0' }}>
                  {['#', 'المنتج', 'شهر 3', 'شهر 4', 'نمو', 'إجمالي المبيعات', 'اعادة فوترة', 'موزعين', 'الحالة'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'right', color: '#374151', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...items]
                  .filter(i => !itemSearch || i.itemName.toLowerCase().includes(itemSearch.toLowerCase()))
                  .sort((a, b) => {
                    if (itemSort === 'totalSold') return b.totalSold - a.totalSold;
                    if (itemSort === 'growthPct') return (b.growthPct ?? -999) - (a.growthPct ?? -999);
                    return b.reinvoicing - a.reinvoicing;
                  })
                  .map((item, i) => {
                    const rowBg =
                      item.status === 'growing'  ? '#f0fdf4' :
                      item.status === 'stopped'  ? '#fdf2f8' :
                      item.status === 'declining' ? '#fff7f7' :
                      i % 2 === 0 ? '#fff' : '#fafafa';
                    return (
                      <tr key={item.itemName} style={{ borderBottom: '1px solid #f1f5f9', background: rowBg }}>
                        <td style={{ padding: '7px 10px', color: '#94a3b8', fontSize: 11 }}>{i + 1}</td>
                        <td style={{ padding: '7px 10px', fontWeight: 500, color: '#1e293b' }}>{item.itemName}</td>
                        <td style={{ padding: '7px 10px', direction: 'ltr' }}>{fmt(item.month3)}</td>
                        <td style={{ padding: '7px 10px', direction: 'ltr', fontWeight: 600 }}>{fmt(item.month4)}</td>
                        <td style={{ padding: '7px 10px' }}><GrowthBadge val={item.growthPct} /></td>
                        <td style={{ padding: '7px 10px', fontWeight: 600, direction: 'ltr' }}>{fmt(item.totalSold)}</td>
                        <td style={{ padding: '7px 10px', color: item.reinvoicing > 0 ? '#ea580c' : '#94a3b8', direction: 'ltr' }}>
                          {item.reinvoicing > 0 ? `⚠️ ${fmt(item.reinvoicing)}` : '—'}
                        </td>
                        <td style={{ padding: '7px 10px', color: '#64748b', direction: 'ltr' }}>{item.distributorCount}</td>
                        <td style={{ padding: '7px 10px' }}><StatusBadge status={item.status} /></td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tab: Reinvoicing ── */}
      {activeTab === 'reinvoicing' && !loadingAnalysis && (
        <div>
          {reinvoicing.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>✅</div>
              <div>لا توجد عناصر تحتاج اعادة فوترة في هذا الملف.</div>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 12, padding: '10px 14px', background: '#fff7ed', borderRadius: 10, border: '1px solid #fed7aa', fontSize: 13, color: '#92400e' }}>
                ⚠️ {reinvoicing.length} عنصر يحتاج اعادة فوترة — راجعها مع الموزعين
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#fef3c7', borderBottom: '2px solid #fde68a' }}>
                      {['الفريق', 'الموزع', 'المنتج', 'شهر 3', 'شهر 4', 'إجمالي المبيعات', 'تاريخ البيع', 'اعادة الفوترة'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'right', color: '#92400e', fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reinvoicing.map((r, i) => (
                      <tr key={r.id} style={{
                        borderBottom: '1px solid #fef3c7',
                        background: i % 2 === 0 ? '#fffbeb' : '#fff',
                      }}>
                        <td style={{ padding: '7px 10px', color: '#92400e', fontWeight: 500 }}>{r.teamName || '—'}</td>
                        <td style={{ padding: '7px 10px' }}>{r.distributorName}</td>
                        <td style={{ padding: '7px 10px', fontWeight: 600, color: '#1e293b' }}>{r.itemName}</td>
                        <td style={{ padding: '7px 10px', direction: 'ltr' }}>{fmt(r.month3Qty)}</td>
                        <td style={{ padding: '7px 10px', direction: 'ltr' }}>{fmt(r.month4Qty)}</td>
                        <td style={{ padding: '7px 10px', direction: 'ltr', fontWeight: 600 }}>{fmt(r.totalQtySold)}</td>
                        <td style={{ padding: '7px 10px', direction: 'ltr', color: '#64748b' }}>
                          {r.saleDate ? new Date(r.saleDate).toLocaleDateString('ar-IQ') : '—'}
                        </td>
                        <td style={{ padding: '7px 10px', direction: 'ltr', fontWeight: 700, color: '#ea580c' }}>
                          {fmt(r.reinvoicingCount)}
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

      {/* Empty state for analysis tabs with no data */}
      {activeTab !== 'upload' && !loadingAnalysis && selectedUploadId && (
        <>
          {activeTab === 'overview' && !kpis && (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد بيانات.</div>
          )}
          {activeTab === 'teams' && teams.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد بيانات.</div>
          )}
          {activeTab === 'distributors' && distributors.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد بيانات.</div>
          )}
          {activeTab === 'items' && items.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد بيانات.</div>
          )}
        </>
      )}
    </div>
  );
}
