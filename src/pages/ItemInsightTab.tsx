import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import AnalysisRenderer from '../components/AnalysisRenderer';

const API = import.meta.env.VITE_API_URL || '';

interface ItemLite { id: number; name: string; scientificName?: string | null; dosage?: string | null; form?: string | null; }

interface Breakdown {
  name: string;
  salesQty: number; salesValue: number;
  returnsQty: number; returnsValue: number;
  netQty: number; netValue: number;
  orders: number;
}

interface DoctorVisitTop {
  name: string; specialty: string; area: string; visits: number;
  feedbackSummary: Record<string, number>;
  lastVisit: string | null;
}

interface NoteSample { doctor?: string; pharmacy?: string; feedback?: string; date?: string | null; notes: string; }

interface RepDiagnostic {
  repName: string;
  repType: 'scientific' | 'medical';
  sciRepId: number | null;
  repAreaIds: number[];
  callCount: number;
  pharmacyVisitsCount: number;
  doctorsVisited: number;
  singleVisitDoctors: number;
  repeatedVisitDoctors: number;
  avgVisitsPerDoctor: number;
  positiveFeedback: number;
  negativeFeedback: number;
  feedbackCounts: Record<string, number>;
  salesNoVisits: number;
  visitsNoSales: number;
  doctorPharmacyRatio: number;
  planCoverage: { totalPlans: number; plansWithItem: number; coveragePct: number };
  salesValue: number;
  returnsValue: number;
  netValue: number;
  signals: string[];
}

interface RepListEntry {
  id: number;
  name: string;
  repType: 'scientific' | 'medical';
  salesValue: number;
  salesQty: number;
  visitsCount: number;
  pharmacyVisitsCount: number;
  areaIds: number[];
  areasCount: number;
  source: 'both' | 'visits' | 'area-sales';
}

interface Analytics {
  item: {
    id: number; name: string; scientificName?: string | null;
    dosage?: string | null; form?: string | null; price?: number | null;
    scientificMessage?: string | null; imageUrl?: string | null;
    company?: { id: number; name: string } | null;
  };
  windowDays: number;
  repName?: string | null;
  repDiagnostic?: RepDiagnostic | null;
  overview: {
    salesQty: number; salesValue: number;
    returnsQty: number; returnsValue: number;
    netQty: number; netValue: number;
    ordersCount: number; areasCount: number; repsCount: number;
    pharmaciesCount: number; doctorsVisitedCount: number;
    totalDoctorVisits: number; totalPharmacyVisits: number;
    firstSaleDate: string | null; lastSaleDate: string | null;
  };
  salesByArea: Breakdown[];
  salesByRep: Breakdown[];
  salesByMonth: Breakdown[];
  topPharmacies: Breakdown[];
  doctorVisits: {
    total: number;
    feedbackCounts: Record<string, number>;
    feedbackLabels: Record<string, string>;
    topDoctors: DoctorVisitTop[];
    topReps: { name: string; count: number }[];
    notesSamples: NoteSample[];
  };
  pharmacyVisits: {
    total: number;
    topPharmacies: { name: string; area: string; visits: number; lastVisit: string | null }[];
    notesSamples: NoteSample[];
  };
  competitors: { itemId: number; name: string; scientificName: string; qty: number; value: number; isCurrent: boolean }[];
}

interface Props { fileIdsParam: string; }

interface MarketPriceEntry {
  id: number;
  surveyId: number;
  surveyName: string;
  brandName: string;
  company?: string | null;
  scientificName?: string | null;
  dosageForm?: string | null;
  packaging?: string | null;
  priceOfficeToWholesaler?: number | null;
  priceWholesalerToPharmacy?: number | null;
  pricePharmacyToPatient?: number | null;
  notes?: string | null;
  isOwnProduct?: boolean;
  activeIngredient?: string | null;
  drugClass?: string | null;
  dosageAmountAI?: string | null;
  dosageUnitAI?: string | null;
  competitorGroup?: string | null;
}

interface MarketPricesResult {
  data: MarketPriceEntry[];
  surveyCount: number;
  matchMode: 'ai' | 'fuzzy' | 'none';
  surveysAnalyzed: number;
  searchedActive?: string | null;
}

type SubTab = 'overview' | 'sales' | 'visits' | 'science' | 'ai' | 'market';

const SUB_TABS: { id: SubTab; label: string; icon: string }[] = [
  { id: 'overview', label: 'نظرة عامة',     icon: '📊' },
  { id: 'sales',    label: 'المبيع',         icon: '📈' },
  { id: 'visits',   label: 'الزيارات',        icon: '🩺' },
  { id: 'science',  label: 'المعلومات العلمية', icon: '💊' },
  { id: 'ai',       label: 'تحليل ذكي (AI)',  icon: '🤖' },
  { id: 'market',   label: 'أسعار السوق',     icon: '💰' },
];

function fmt(n: number) { return Math.round(n || 0).toLocaleString('ar-IQ'); }
function fmtDate(d: string | null) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('ar-IQ', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { return d; }
}

const CACHE_PREFIX = 'item_ai_insight_v2:';
const SKIP_INFO_PREFIX = 'item_skip_info:';

const COMMON_FORMS = [
  'أقراص (Tablet)',
  'كبسولات (Capsule)',
  'شراب (Syrup)',
  'حقن (Injection)',
  'قطرة (Drops)',
  'مرهم (Ointment)',
  'كريم (Cream)',
  'تحاميل (Suppository)',
  'بخاخ (Spray)',
  'فيال (Vial)',
  'محلول (Solution)',
  'أخرى',
];

export default function ItemInsightTab({ fileIdsParam }: Props) {
  const { token, isManagerOrAdmin } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [items, setItems]               = useState<ItemLite[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemSearch, setItemSearch]     = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedId, setSelectedId]     = useState<number | null>(null);
  const [days, setDays]                 = useState(180);

  const [data, setData]       = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const [subTab, setSubTab]   = useState<SubTab>('overview');

  const [aiInsight, setAIInsight]   = useState<string | null>(null);
  const [aiLoading, setAILoading]   = useState(false);
  const [aiError, setAIError]       = useState<string | null>(null);
  const [aiCachedAt, setAICachedAt] = useState<string | null>(null);

  // Per-rep selector & list
  const [reps, setReps]             = useState<RepListEntry[]>([]);
  const [selectedRep, setSelectedRep] = useState<string>(''); // '' = general

  // Market prices
  const [marketResult, setMarketResult]         = useState<MarketPricesResult | null>(null);
  const [marketPrices, setMarketPrices]         = useState<MarketPriceEntry[]>([]);
  const [marketLoading, setMarketLoading]       = useState(false);
  const [surveyAnalyzing, setSurveyAnalyzing]   = useState(false);
  const [surveyAnalyzeMsg, setSurveyAnalyzeMsg] = useState<string | null>(null);

  // Missing-info modal
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [infoForm, setInfoForm] = useState({ scientificName: '', dosage: '', form: '', price: '', companyName: '' });
  const [infoSaving, setInfoSaving] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);

  // ── Load items list ───────────────────────────────────────
  useEffect(() => {
    setItemsLoading(true);
    const qs = fileIdsParam ? `?fileIds=${fileIdsParam}` : '';
    fetch(`${API}/api/item-analysis/items${qs}`, { headers })
      .then(r => r.json())
      .then(r => setItems(r.items || []))
      .catch(() => setItems([]))
      .finally(() => setItemsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdsParam, token]);

  // ── Load analytics when item or filter changes ───────────
  const loadAnalytics = useCallback(() => {
    if (!selectedId) { setData(null); return; }
    setLoading(true); setError(null);
    const qs = new URLSearchParams();
    if (fileIdsParam) qs.set('fileIds', fileIdsParam);
    qs.set('days', String(days));
    if (selectedRep) qs.set('repName', selectedRep);
    fetch(`${API}/api/item-analysis/${selectedId}?${qs.toString()}`, { headers })
      .then(async r => {
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'فشل تحميل البيانات'); }
        return r.json();
      })
      .then((d: Analytics) => {
        setData(d);
        // Auto-open missing-info modal once per item (unless previously skipped)
        const needs = !d.item.scientificName || !d.item.dosage || !d.item.form;
        const skipped = localStorage.getItem(`${SKIP_INFO_PREFIX}${d.item.id}`) === '1';
        if (needs && !skipped && !selectedRep) {
          setInfoForm({
            scientificName: d.item.scientificName     || '',
            dosage:         d.item.dosage             || '',
            form:           d.item.form               || '',
            price:          d.item.price != null ? String(d.item.price) : '',
            companyName:    d.item.company?.name       || '',
          });
          setInfoError(null);
          setShowInfoModal(true);
        }
      })
      .catch(e => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, fileIdsParam, days, selectedRep, token]);

  useEffect(() => { loadAnalytics(); }, [loadAnalytics]);

  // ── Reset rep & load reps list when item changes ─────────
  useEffect(() => {
    setSelectedRep('');
    setMarketPrices([]);
    if (!selectedId) { setReps([]); return; }
    const qs = new URLSearchParams();
    if (fileIdsParam) qs.set('fileIds', fileIdsParam);
    qs.set('days', String(days));
    fetch(`${API}/api/item-analysis/${selectedId}/reps?${qs.toString()}`, { headers })
      .then(r => r.json())
      .then(j => setReps(j.reps || []))
      .catch(() => setReps([]));
    // Fetch market prices
    setMarketLoading(true);
    fetch(`${API}/api/item-analysis/${selectedId}/market-prices`, { headers })
      .then(r => r.json())
      .then((j: MarketPricesResult) => { setMarketResult(j); setMarketPrices(j.data || []); })
      .catch(() => { setMarketResult(null); setMarketPrices([]); })
      .finally(() => setMarketLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, fileIdsParam, days, token]);

  // ── Save missing info ────────────────────────────────────
  const saveItemInfo = async () => {
    if (!selectedId) return;
    if (!infoForm.scientificName.trim() && !infoForm.dosage.trim() && !infoForm.form.trim()
        && !infoForm.price.trim() && !infoForm.companyName.trim()) {
      setInfoError('أدخل بياناً واحداً على الأقل');
      return;
    }
    setInfoSaving(true); setInfoError(null);
    try {
      const r = await fetch(`${API}/api/items/${selectedId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scientificName: infoForm.scientificName.trim() || undefined,
          dosage:         infoForm.dosage.trim()         || undefined,
          form:           infoForm.form.trim()           || undefined,
          price:          infoForm.price.trim() !== '' ? infoForm.price.trim() : undefined,
          companyName:    infoForm.companyName.trim()    || undefined,
        }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'فشل الحفظ'); }
      setShowInfoModal(false);
      // Refresh items list + analytics
      const qs = fileIdsParam ? `?fileIds=${fileIdsParam}` : '';
      fetch(`${API}/api/item-analysis/items${qs}`, { headers })
        .then(rr => rr.json()).then(rr => setItems(rr.items || [])).catch(() => {});
      loadAnalytics();
      // Refresh market prices (scientific name affects competitor matching)
      setMarketLoading(true);
      fetch(`${API}/api/item-analysis/${selectedId}/market-prices`, { headers })
        .then(r => r.json())
        .then((j: MarketPricesResult) => { setMarketResult(j); setMarketPrices(j.data || []); })
        .catch(() => { setMarketResult(null); setMarketPrices([]); })
        .finally(() => setMarketLoading(false));
    } catch (e: any) {
      setInfoError(String(e.message || e));
    } finally {
      setInfoSaving(false);
    }
  };

  const skipItemInfo = () => {
    if (selectedId) localStorage.setItem(`${SKIP_INFO_PREFIX}${selectedId}`, '1');
    setShowInfoModal(false);
  };

  // ── Load AI insight from cache when item/rep changes ─────
  useEffect(() => {
    setAIInsight(null); setAIError(null); setAICachedAt(null);
    if (!selectedId) return;
    try {
      const key = `${CACHE_PREFIX}${selectedId}:${fileIdsParam || 'all'}:${days}:${selectedRep || 'all'}`;
      const raw = localStorage.getItem(key);
      if (raw) {
        const obj = JSON.parse(raw);
        // Use cache only if <24h old
        if (obj.generatedAt && Date.now() - new Date(obj.generatedAt).getTime() < 24 * 60 * 60 * 1000) {
          setAIInsight(obj.insight);
          setAICachedAt(obj.generatedAt);
        }
      }
    } catch {}
  }, [selectedId, fileIdsParam, days, selectedRep]);

  const requestAI = async () => {
    if (!selectedId) return;
    setAILoading(true); setAIError(null);
    try {
      const r = await fetch(`${API}/api/item-analysis/${selectedId}/ai-insight`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: fileIdsParam || null, days, repName: selectedRep || null }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'فشل التحليل الذكي'); }
      const j = await r.json();
      setAIInsight(j.insight);
      setAICachedAt(j.generatedAt);
      try {
        const key = `${CACHE_PREFIX}${selectedId}:${fileIdsParam || 'all'}:${days}:${selectedRep || 'all'}`;
        localStorage.setItem(key, JSON.stringify({ insight: j.insight, generatedAt: j.generatedAt }));
      } catch {}
    } catch (e: any) {
      setAIError(String(e.message || e));
    } finally {
      setAILoading(false);
    }
  };

  const exportAIInsight = () => {
    if (!aiInsight || !data) return;
    const heading = selectedRep
      ? `# تحليل الإيتم: ${data.item.name} — المندوب: ${selectedRep}`
      : `# تحليل الإيتم: ${data.item.name}`;
    const blob = new Blob([`${heading}\n\n${aiInsight}`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const repSuffix = selectedRep ? `_${selectedRep.replace(/[^\u0600-\u06FFa-zA-Z0-9]+/g, '_')}` : '';
    a.href = url; a.download = `تحليل_${data.item.name.replace(/[^\u0600-\u06FFa-zA-Z0-9]+/g, '_')}${repSuffix}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Filtered items for selector ───────────────────────────
  const filteredItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return items.slice(0, 200);
    return items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.scientificName || '').toLowerCase().includes(q)
    ).slice(0, 200);
  }, [items, itemSearch]);

  // ── Styles ────────────────────────────────────────────────
  const cardStyle: React.CSSProperties = { background: '#fff', borderRadius: 10, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,.06)', border: '1px solid #e5e7eb' };
  const kpiStyle = (color: string): React.CSSProperties => ({ ...cardStyle, borderRight: `4px solid ${color}`, minWidth: 140 });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── Item selector + days filter ─────────────────── */}
      <div style={{ ...cardStyle, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 260, position: 'relative' }}>
          <label style={{ display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 600 }}>اختر الإيتم</label>
          <div style={{ position: 'relative' }}>
            <input
              type="text"
              placeholder="ابحث بالاسم التجاري أو العلمي أو اضغط للاختيار..."
              value={itemSearch}
              onChange={e => setItemSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 180)}
              style={{ width: '100%', padding: '8px 34px 8px 12px', borderRadius: 6, border: `1px solid ${searchFocused ? '#6366f1' : '#cbd5e1'}`, fontSize: 13, boxSizing: 'border-box', outline: 'none', transition: 'border-color 0.15s' }}
            />
            {itemSearch ? (
              <span
                onMouseDown={e => { e.preventDefault(); setItemSearch(''); }}
                style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', fontSize: 16, color: '#94a3b8', lineHeight: 1 }}
              >×</span>
            ) : (
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: '#94a3b8', pointerEvents: 'none' }}>▾</span>
            )}
          </div>
          {(searchFocused || itemSearch.trim()) && (
            <div style={{ position: 'absolute', zIndex: 999, width: '100%', maxHeight: 300, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, marginTop: 4, background: '#fff', boxShadow: '0 8px 24px rgba(0,0,0,.12)' }}>
              {!itemSearch.trim() && (
                <div style={{ padding: '7px 12px', fontSize: 11, color: '#94a3b8', borderBottom: '1px solid #f1f5f9', fontWeight: 600 }}>
                  🔍 كل الإيتمات ({items.length})
                </div>
              )}
              {itemsLoading && <div style={{ padding: 12, color: '#94a3b8', fontSize: 12 }}>...جاري التحميل</div>}
              {!itemsLoading && filteredItems.length === 0 && <div style={{ padding: 12, color: '#94a3b8', fontSize: 12 }}>لا توجد نتائج</div>}
              {filteredItems.map(i => (
                <div
                  key={i.id}
                  onMouseDown={() => { setSelectedId(i.id); setItemSearch(''); setSearchFocused(false); }}
                  style={{
                    padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f8fafc',
                    background: selectedId === i.id ? '#eff6ff' : '#fff',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = selectedId === i.id ? '#dbeafe' : '#f8fafc')}
                  onMouseLeave={e => (e.currentTarget.style.background = selectedId === i.id ? '#eff6ff' : '#fff')}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: selectedId === i.id ? '#1d4ed8' : '#1e293b' }}>
                    {selectedId === i.id && <span style={{ marginLeft: 4, color: '#6366f1' }}>✓</span>}
                    {i.name}
                  </div>
                  {i.scientificName && <div style={{ fontSize: 11, color: '#64748b' }}>{i.scientificName} {i.dosage ? `• ${i.dosage}` : ''} {i.form ? `• ${i.form}` : ''}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 600 }}>الفترة (أيام)</label>
          <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13 }}>
            <option value={30}>آخر 30 يوم</option>
            <option value={60}>آخر 60 يوم</option>
            <option value={90}>آخر 90 يوم</option>
            <option value={180}>آخر 180 يوم</option>
            <option value={365}>آخر سنة</option>
          </select>
        </div>
        {selectedId && (
          <button onClick={() => { setSelectedId(null); setData(null); setAIInsight(null); }}
            style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #ef4444', background: '#fff', color: '#ef4444', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
            إلغاء التحديد
          </button>
        )}
      </div>

      {/* ── Header (when item is selected) ──────────────── */}
      {data && (
        <div style={{ ...cardStyle, background: 'linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {data.item.imageUrl && (
              <img src={data.item.imageUrl.startsWith('http') ? data.item.imageUrl : `${API}${data.item.imageUrl}`}
                alt={data.item.name}
                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid #cbd5e1' }} />
            )}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#1e3a8a' }}>{data.item.name}</div>
                <button onClick={() => {
                  setInfoForm({ scientificName: data.item.scientificName || '', dosage: data.item.dosage || '', form: data.item.form || '', price: data.item.price != null ? String(data.item.price) : '', companyName: data.item.company?.name || '' });
                  setInfoError(null);
                  setShowInfoModal(true);
                }} style={{ padding: '3px 9px', borderRadius: 5, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#475569', fontSize: 11, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  ✏️ تعديل
                </button>
              </div>
              {data.item.scientificName && <div style={{ fontSize: 13, color: '#475569', marginTop: 2 }}>🧪 {data.item.scientificName}</div>}
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                {data.item.dosage && <span>الجرعة: <b>{data.item.dosage}</b> • </span>}
                {data.item.form && <span>الشكل: <b>{data.item.form}</b> • </span>}
                {data.item.price != null && <span>السعر: <b>{fmt(data.item.price)}</b> • </span>}
                {data.item.company && <span>الشركة: <b>{data.item.company.name}</b></span>}
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#64748b' }}>
              <div>أول مبيع: {fmtDate(data.overview.firstSaleDate)}</div>
              <div>آخر مبيع: {fmtDate(data.overview.lastSaleDate)}</div>
              <div>نافذة التحليل: <b>{data.windowDays} يوم</b></div>
            </div>
          </div>
        </div>
      )}

      {/* ── Loading / Empty / Error states ──────────────── */}
      {!selectedId && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: 40, color: '#64748b' }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔍</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>اختر إيتماً للبدء بالتحليل</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>سيتم جمع كل بيانات المبيع والإرجاع والزيارات والفيدباك لتحليل أداء الإيتم</div>
        </div>
      )}
      {loading && <div style={{ ...cardStyle, textAlign: 'center', color: '#6366f1' }}>⏳ جاري تحميل بيانات الإيتم...</div>}
      {error && <div style={{ ...cardStyle, color: '#dc2626', background: '#fef2f2' }}>⚠️ {error}</div>}

      {/* ── KPI cards + sub-tabs ────────────────────────── */}
      {data && !loading && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={kpiStyle('#10b981')}><div style={{ fontSize: 11, color: '#6b7280' }}>كمية المبيع</div><div style={{ fontSize: 20, fontWeight: 700, color: '#065f46' }}>{fmt(data.overview.salesQty)}</div></div>
            <div style={kpiStyle('#ef4444')}><div style={{ fontSize: 11, color: '#6b7280' }}>كمية الإرجاع</div><div style={{ fontSize: 20, fontWeight: 700, color: '#991b1b' }}>{fmt(data.overview.returnsQty)}</div></div>
            <div style={kpiStyle('#1e40af')}><div style={{ fontSize: 11, color: '#6b7280' }}>صافي الكمية</div><div style={{ fontSize: 20, fontWeight: 700, color: '#1e3a8a' }}>{fmt(data.overview.netQty)}</div></div>
            <div style={kpiStyle('#0891b2')}><div style={{ fontSize: 11, color: '#6b7280' }}>صافي القيمة (د.ع)</div><div style={{ fontSize: 20, fontWeight: 700, color: '#0e7490' }}>{fmt(data.overview.netValue)}</div></div>
            <div style={kpiStyle('#f59e0b')}><div style={{ fontSize: 11, color: '#6b7280' }}>عدد المناطق</div><div style={{ fontSize: 20, fontWeight: 700, color: '#92400e' }}>{fmt(data.overview.areasCount)}</div></div>
            <div style={kpiStyle('#7c3aed')}><div style={{ fontSize: 11, color: '#6b7280' }}>عدد المندوبين</div><div style={{ fontSize: 20, fontWeight: 700, color: '#5b21b6' }}>{fmt(data.overview.repsCount)}</div></div>
            <div style={kpiStyle('#db2777')}><div style={{ fontSize: 11, color: '#6b7280' }}>الصيدليات المشترية</div><div style={{ fontSize: 20, fontWeight: 700, color: '#9d174d' }}>{fmt(data.overview.pharmaciesCount)}</div></div>
            <div style={kpiStyle('#16a34a')}><div style={{ fontSize: 11, color: '#6b7280' }}>زيارات الأطباء</div><div style={{ fontSize: 20, fontWeight: 700, color: '#14532d' }}>{fmt(data.overview.totalDoctorVisits)}</div></div>
          </div>

          {/* Sub-tabs nav */}
          <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e2e8f0' }}>
            {SUB_TABS.map(t => (
              <button key={t.id} onClick={() => setSubTab(t.id)} style={{
                padding: '8px 14px', border: 'none', borderRadius: '6px 6px 0 0', cursor: 'pointer',
                background: subTab === t.id ? '#fff' : 'transparent',
                color: subTab === t.id ? '#1e40af' : '#6b7280',
                fontWeight: subTab === t.id ? 700 : 500, fontSize: 13,
                borderBottom: subTab === t.id ? '2px solid #1e40af' : '2px solid transparent', marginBottom: -2,
              }}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {/* ── Subtab: Overview ───────────────────────── */}
          {subTab === 'overview' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
              <BreakdownCard title="🌍 المناطق (أعلى 10 بالقيمة)" rows={data.salesByArea.slice(0, 10)} />
              <BreakdownCard title="👤 المندوبون (أعلى 10 بالقيمة)" rows={data.salesByRep.slice(0, 10)} />
              <BreakdownCard title="🏪 الصيدليات (أعلى 10)" rows={data.topPharmacies.slice(0, 10)} />
              <CompetitorsCard competitors={data.competitors} />
            </div>
          )}

          {/* ── Subtab: Sales ──────────────────────────── */}
          {subTab === 'sales' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <MonthlyTrendCard rows={data.salesByMonth} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
                <BreakdownCard title="📍 كل المناطق" rows={data.salesByArea} maxRows={25} />
                <BreakdownCard title="🧑‍💼 كل المندوبين" rows={data.salesByRep} maxRows={25} />
                <BreakdownCard title="🏥 كل الصيدليات" rows={data.topPharmacies} maxRows={25} />
              </div>
            </div>
          )}

          {/* ── Subtab: Visits ─────────────────────────── */}
          {subTab === 'visits' && (
            <VisitsPanel data={data} />
          )}

          {/* ── Subtab: Science ────────────────────────── */}
          {subTab === 'science' && (
            <div style={cardStyle}>
              {/* ── Drug identity header ── */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16,
                padding: '12px 16px', background: 'linear-gradient(135deg, #1e3a8a 0%, #1d4ed8 100%)',
                borderRadius: 10, color: '#fff',
              }}>
                <div style={{ fontSize: 32 }}>💊</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '0.03em' }}>{data.item.name}</div>
                  {data.item.scientificName && (
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2, fontStyle: 'italic' }}>
                      {data.item.scientificName}
                    </div>
                  )}
                </div>
                {(data.item.dosage || data.item.form) && (
                  <div style={{ textAlign: 'right' }}>
                    {data.item.dosage && <div style={{ fontSize: 14, fontWeight: 700 }}>{data.item.dosage}</div>}
                    {data.item.form && <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>{data.item.form}</div>}
                  </div>
                )}
              </div>

              {/* ── Key data grid ── */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  بيانات الإيتم
                </div>
                <button onClick={() => {
                  setInfoForm({ scientificName: data.item.scientificName || '', dosage: data.item.dosage || '', form: data.item.form || '', price: data.item.price != null ? String(data.item.price) : '', companyName: data.item.company?.name || '' });
                  setInfoError(null);
                  setShowInfoModal(true);
                }} style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#475569', fontSize: 11, cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                  ✏️ تعديل
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: 14 }}>
                {[
                  { en: 'Brand Name', ar: 'الاسم التجاري', val: data.item.name },
                  { en: 'Generic / Active', ar: 'الاسم العلمي', val: data.item.scientificName || '—' },
                  { en: 'Strength / Dosage', ar: 'الجرعة', val: data.item.dosage || '—' },
                  { en: 'Dosage Form', ar: 'الشكل الدوائي', val: data.item.form || '—' },
                  { en: 'Price', ar: 'السعر', val: data.item.price != null ? fmt(data.item.price) : '—' },
                  { en: 'Manufacturer', ar: 'الشركة', val: data.item.company?.name || '—' },
                ].map(f => (
                  <div key={f.en} style={{
                    background: '#f8fafc', padding: '10px 12px', borderRadius: 8,
                    border: '1px solid #e2e8f0',
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {f.en} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({f.ar})</span>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginTop: 4 }}>{f.val}</div>
                  </div>
                ))}
              </div>

              {/* ── Scientific message ── */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                  Scientific Message <span style={{ color: '#94a3b8', fontWeight: 400 }}>(الرسالة العلمية المسجّلة)</span>
                </div>
                <div style={{
                  padding: '10px 14px', background: '#f8fafc', borderRadius: 8,
                  border: '1px solid #e2e8f0', fontSize: 13, color: '#334155', lineHeight: 1.75,
                  borderRight: '3px solid #1d4ed8',
                }}>
                  {data.item.scientificMessage ||
                    <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>
                      No scientific message registered. Add it from Items page or use the AI tab to auto-generate full drug profile.
                    </span>
                  }
                </div>
              </div>

              {/* ── Target Specialties (الاختصاصات المستهدفة) ── */}
              {(() => {
                const specs: Record<string, number> = {};
                (data.doctorVisits.topDoctors || []).forEach(d => {
                  if (d.specialty) specs[d.specialty] = (specs[d.specialty] || 0) + d.visits;
                });
                const sorted = Object.entries(specs).sort((a, b) => b[1] - a[1]);
                return sorted.length > 0 ? (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                      الاختصاصات المستهدفة
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {sorted.map(([spec, cnt]) => (
                        <div key={spec} style={{
                          padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                          background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8',
                          display: 'flex', alignItems: 'center', gap: 5,
                        }}>
                          <span>🩺</span>
                          <span>{spec}</span>
                          <span style={{ fontSize: 10, opacity: 0.7, fontWeight: 400 }}>({cnt})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null;
              })()}

              {/* ── AI Drug Profile (section 1 from AI) ── */}
              {aiInsight ? (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                    الملف العلمي <span style={{ color: '#94a3b8', fontWeight: 400, textTransform: 'none' }}>(مُولَّد بالذكاء الاصطناعي)</span>
                  </div>
                  <AnalysisRenderer text={aiInsight} onlySecNum={1} />
                </div>
              ) : (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '9px 14px', background: '#eff6ff', borderRadius: 8,
                  border: '1px solid #bfdbfe', fontSize: 12, color: '#1d4ed8',
                }}>
                  <span style={{ fontSize: 16 }}>⚡</span>
                  <span>افتح تبويب <b>تحليل ذكي (AI)</b> وشغّل التحليل لتظهر هنا معلومات الملف العلمي الكاملة.</span>
                </div>
              )}

              {/* ── Target Prescribers (section 2 from AI) ── */}
              {aiInsight && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                    الأطباء المستهدفون <span style={{ color: '#94a3b8', fontWeight: 400, textTransform: 'none' }}>(مُولَّد بالذكاء الاصطناعي)</span>
                  </div>
                  <AnalysisRenderer text={aiInsight} onlySecNum={2} />
                </div>
              )}

              {/* ── Class Competitors & Scientific Comparison (section 3 from AI) ── */}
              {aiInsight ? (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                    🏆 تحليل المنافسة <span style={{ color: '#94a3b8', fontWeight: 400, textTransform: 'none' }}>(Class Competitors — مُولَّد بالذكاء الاصطناعي)</span>
                  </div>
                  <AnalysisRenderer text={aiInsight} onlySecNum={3} />
                </div>
              ) : (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '9px 14px', background: '#fff7ed', borderRadius: 8,
                  border: '1px solid #fed7aa', fontSize: 12, color: '#c2410c',
                }}>
                  <span style={{ fontSize: 16 }}>🏆</span>
                  <span>قسم <b>تحليل المنافسة (Class Competitors)</b> سيظهر هنا بعد تشغيل التحليل الذكي.</span>
                </div>
              )}
            </div>
          )}

          {/* ── Subtab: AI insight ─────────────────────── */}
          {subTab === 'ai' && (
            <div style={cardStyle}>
              {/* Rep selector */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14, padding: 10, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>👤 نطاق التحليل:</label>
                <select
                  value={selectedRep}
                  onChange={e => setSelectedRep(e.target.value)}
                  style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, minWidth: 220 }}
                >
                  <option value="">تحليل عام (جميع المندوبين)</option>
                  {reps.map(r => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                      {r.visitsCount > 0 ? ` — 🩺 ${r.visitsCount} كول` : ''}
                      {r.pharmacyVisitsCount > 0 ? ` • 🏪 ${r.pharmacyVisitsCount}` : ''}
                      {r.salesValue > 0 ? ' — 💰 مبيع في مناطقه' : ''}
                      {r.areasCount > 0 ? ` • ${r.areasCount} منطقة` : ''}
                    </option>
                  ))}
                </select>
                {selectedRep && (
                  <span style={{ fontSize: 11, color: '#7c3aed', fontWeight: 600 }}>
                    🎯 مبيع مفلتر بمناطق المندوب • كولات مفلترة باسمه
                  </span>
                )}
              </div>

              {/* Per-rep diagnostic card (when rep selected & data has diagnostic) */}
              {selectedRep && data.repDiagnostic && (
                <RepDiagnosticCard d={data.repDiagnostic} />
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                <h3 style={{ margin: 0, color: '#1e40af' }}>
                  🤖 التحليل الذكي عبر Gemini
                  {selectedRep && <span style={{ fontSize: 12, color: '#7c3aed', marginRight: 8 }}>(للمندوب: {selectedRep})</span>}
                </h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  {aiInsight && (
                    <button onClick={exportAIInsight} style={{
                      padding: '7px 14px', borderRadius: 6, border: '1px solid #6366f1',
                      background: '#fff', color: '#6366f1', fontSize: 12, cursor: 'pointer', fontWeight: 600
                    }}>⬇️ تصدير</button>
                  )}
                  <button
                    onClick={requestAI}
                    disabled={aiLoading}
                    style={{
                      padding: '7px 16px', borderRadius: 6, border: 'none',
                      background: aiLoading ? '#94a3b8' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                      color: '#fff', fontSize: 13, cursor: aiLoading ? 'not-allowed' : 'pointer', fontWeight: 700,
                    }}>
                    {aiLoading ? '⏳ جاري التحليل...' : aiInsight ? '🔄 إعادة التحليل' : '✨ احصل على تحليل ذكي'}
                  </button>
                </div>
              </div>

              {aiCachedAt && (
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
                  ⏱️ تم التوليد: {new Date(aiCachedAt).toLocaleString('ar-IQ')}
                </div>
              )}

              {/* Survey competitors info banner */}
              {marketResult && (
                <div style={{
                  padding: '8px 12px', borderRadius: 8, marginBottom: 10,
                  background: marketPrices.length > 0 ? '#f0fdf4' : '#fffbeb',
                  border: `1px solid ${marketPrices.length > 0 ? '#bbf7d0' : '#fde68a'}`,
                  fontSize: 12, color: marketPrices.length > 0 ? '#065f46' : '#92400e',
                  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                }}>
                  <span>🔬</span>
                  {marketPrices.length > 0 ? (
                    <>
                      <span><b>{marketPrices.filter(e => !e.isOwnProduct).length}</b> منافس من السيرفي سيُستخدم في التحليل التنافسي</span>
                      {marketResult.matchMode === 'ai' && <span style={{ background: '#dcfce7', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>تطابق ذكي</span>}
                    </>
                  ) : (
                    <span>لا توجد بيانات منافسين في السيرفي — التحليل سيعتمد على البيانات الداخلية فقط. ارفع سيرفي أسعار للحصول على تحليل تنافسي حقيقي.</span>
                  )}
                </div>
              )}

              {aiError && (
                <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#dc2626', fontSize: 13 }}>
                  ⚠️ {aiError}
                </div>
              )}

              {!aiInsight && !aiLoading && !aiError && (
                <div style={{ padding: 24, background: '#f8fafc', borderRadius: 8, textAlign: 'center', color: '#64748b' }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🤖</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>اضغط الزر أعلاه لتشغيل التحليل الذكي</div>
                  <div style={{ fontSize: 12, marginTop: 6 }}>سيقارن النظام منتجك بالمنافسين الفعليين من السيرفي ويُصدر تقريراً يشمل:</div>
                  <ul style={{ textAlign: 'right', display: 'inline-block', fontSize: 12, marginTop: 8, color: '#475569', lineHeight: 1.9 }}>
                    <li>🏆 جدول مقارنة الأسعار مع المنافسين</li>
                    <li>💪 نقاط القوة لمنتجك مقابل كل منافس</li>
                    <li>🎯 تموضع المنتج في السوق</li>
                    <li>🔍 تشخيص أسباب أداء المبيع</li>
                    <li>🩺 5-7 اقتراحات عملية للمندوب</li>
                    <li>📅 خطة عمل 30 يوم تنفيذية</li>
                  </ul>
                  <div style={{ fontSize: 11, marginTop: 10, color: '#94a3b8', fontStyle: 'italic' }}>
                    💊 الملف العلمي والأطباء المستهدفون يظهرون في تبويب "المعلومات العلمية"
                  </div>
                </div>
              )}

              {aiLoading && (
                <div style={{ padding: 24, textAlign: 'center', color: '#6366f1' }}>
                  <div style={{ fontSize: 22 }}>⏳</div>
                  <div style={{ fontSize: 14, marginTop: 6 }}>جاري إنشاء التحليل... قد يستغرق 10-20 ثانية</div>
                </div>
              )}

              {aiInsight && !aiLoading && (
                <div style={{ background: '#fff' }}>
                  {/* Note: sections 1 (Drug Profile) and 2 (Target Prescribers) are shown only in the Science tab to avoid duplication */}
                  <div style={{
                    padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe',
                    borderRadius: 8, fontSize: 11, color: '#1d4ed8', marginBottom: 12,
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    <span>💊</span>
                    <span>الملف العلمي والأطباء المستهدفون متوفّرون في تبويب <b>المعلومات العلمية</b></span>
                  </div>
                  <AnalysisRenderer text={aiInsight} skipSecNums={[1, 2]} />
                </div>
              )}
            </div>
          )}

          {/* ── Market Prices Tab ─────────────────── */}
          {subTab === 'market' && (
            <div style={{ padding: '4px 0' }}>
              {/* Header */}
              <div style={{
                background: 'linear-gradient(135deg, #065f46, #059669)',
                borderRadius: 12, padding: '14px 18px', marginBottom: 14, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10,
              }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 2 }}>💰 أسعار السوق والمنافسون</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    بيانات مُستخرجة من سيرفيات أسعار الأدوية
                    {marketResult?.matchMode === 'ai' && <span style={{ marginRight: 8, background: 'rgba(255,255,255,0.2)', borderRadius: 4, padding: '1px 6px', fontSize: 10 }}>🤖 بحث ذكي بالاسم العلمي</span>}
                    {marketResult?.matchMode === 'fuzzy' && <span style={{ marginRight: 8, background: 'rgba(255,255,255,0.15)', borderRadius: 4, padding: '1px 6px', fontSize: 10 }}>🔍 بحث نصي ذكي</span>}
                  </div>
                  {marketResult?.searchedActive && (
                    <div style={{ fontSize: 11, opacity: 0.8, marginTop: 3 }}>
                      🧪 يتم البحث عن المنافسين بالمكوّن الفعّال: <strong>{marketResult.searchedActive}</strong>
                    </div>
                  )}
                </div>
                {isManagerOrAdmin && (
                  <button
                    disabled={surveyAnalyzing || !marketResult?.surveyCount}
                    onClick={async () => {
                      setSurveyAnalyzing(true); setSurveyAnalyzeMsg(null);
                      try {
                        setSurveyAnalyzeMsg('⏳ جاري تحليل السيرفيات...');
                        const res = await fetch(`${API}/api/item-analysis/survey/ai-analyze-all`, { method: 'POST', headers });
                        const j = await res.json();
                        if (!res.ok) throw new Error(j.error || 'خطأ');
                        if (j.surveyCount === 0) {
                          setSurveyAnalyzeMsg('⚠️ لا توجد سيرفيات أسعار نشطة في النظام');
                          return;
                        }
                        setSurveyAnalyzeMsg(`✅ تم تحليل ${j.done} من ${j.surveyCount} سيرفي`);
                        // Reload market prices
                        setMarketLoading(true);
                        const mr = await fetch(`${API}/api/item-analysis/${selectedId}/market-prices`, { headers });
                        const mj: MarketPricesResult = await mr.json();
                        setMarketResult(mj); setMarketPrices(mj.data || []);
                      } catch (err: any) {
                        setSurveyAnalyzeMsg(`⚠️ ${err?.message || 'حدث خطأ أثناء التحليل'}`);
                      } finally {
                        setSurveyAnalyzing(false); setMarketLoading(false);
                      }
                    }}
                    style={{
                      padding: '7px 14px', borderRadius: 8, border: '1.5px solid rgba(255,255,255,0.5)',
                      background: surveyAnalyzing ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.2)',
                      color: '#fff', fontSize: 12, cursor: surveyAnalyzing ? 'not-allowed' : 'pointer', fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {surveyAnalyzing ? '⏳ جاري التحليل...' : '🤖 تحليل السيرفي بالذكاء الاصطناعي'}
                  </button>
                )}
              </div>

              {surveyAnalyzeMsg && (
                <div style={{ padding: '8px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 12, color: '#065f46', marginBottom: 12 }}>
                  {surveyAnalyzeMsg}
                </div>
              )}

              {/* AI match info banner */}
              {marketResult?.matchMode === 'ai' && marketPrices.length > 0 && (() => {
                const own = marketPrices.find(e => e.isOwnProduct);
                return own ? (
                  <div style={{ padding: '8px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 12, color: '#1d4ed8', marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span>🤖 <b>تطابق ذكي:</b> تم التعرف على</span>
                    <span style={{ fontWeight: 700 }}>{own.brandName}</span>
                    <span>—</span>
                    {own.activeIngredient && <span>المادة الفعالة: <b>{own.activeIngredient}</b></span>}
                    {own.drugClass && <span>• الصنف: <b>{own.drugClass}</b></span>}
                    <span>• {marketPrices.length - 1} منافس</span>
                  </div>
                ) : null;
              })()}

              {marketLoading ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 14 }}>⏳ جاري التحميل...</div>
              ) : marketPrices.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, background: '#f8fafc', borderRadius: 12, border: '1.5px dashed #cbd5e1', color: '#94a3b8' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>💊</div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>لا توجد بيانات أسعار حتى الآن</div>
                  <div style={{ fontSize: 12, marginBottom: 12 }}>
                    {marketResult?.surveyCount
                      ? 'السيرفي موجود لكن الإيتم لم يُطابَق — جرّب تشغيل التحليل الذكي'
                      : 'يمكن للمدير إضافة أسعار هذا الدواء من صفحة السيرفيات'}
                  </div>
                  {isManagerOrAdmin && marketResult?.matchMode === 'fuzzy' && (
                    <div style={{ fontSize: 12, color: '#6366f1' }}>
                      💡 شغّل <b>تحليل السيرفي بالذكاء الاصطناعي</b> أعلاه للحصول على تطابق أدق بناءً على المادة الفعالة
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Own product card */}
                  {marketResult?.matchMode === 'ai' && (() => {
                    const own = marketPrices.find(e => e.isOwnProduct);
                    const competitors = marketPrices.filter(e => !e.isOwnProduct);
                    return (
                      <>
                        {own && (
                          <div style={{ marginBottom: 14, background: '#f0fdf4', border: '2px solid #059669', borderRadius: 10, padding: '12px 16px' }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#059669', textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.05em' }}>✅ منتجنا</div>
                            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                              <div>
                                <div style={{ fontWeight: 800, fontSize: 15, color: '#065f46' }}>{own.brandName}</div>
                                {own.scientificName && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>{own.scientificName}</div>}
                                {own.company && <div style={{ fontSize: 12, color: '#6b7280' }}>{own.company}</div>}
                              </div>
                              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                {[
                                  { label: 'مكتب←مذخر', val: own.priceOfficeToWholesaler, color: '#059669' },
                                  { label: 'مذخر←صيدلية', val: own.priceWholesalerToPharmacy, color: '#d97706' },
                                  { label: 'صيدلية←مريض', val: own.pricePharmacyToPatient, color: '#dc2626' },
                                ].map(p => p.val != null && (
                                  <div key={p.label} style={{ background: '#fff', borderRadius: 8, padding: '6px 12px', border: `1.5px solid ${p.color}20`, textAlign: 'center' }}>
                                    <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>{p.label}</div>
                                    <div style={{ fontSize: 15, fontWeight: 800, color: p.color }}>{Number(p.val).toFixed(3)}</div>
                                  </div>
                                ))}
                              </div>
                              <div style={{ marginRight: 'auto', fontSize: 10, color: '#94a3b8' }}>{own.surveyName}</div>
                            </div>
                          </div>
                        )}

                        {/* Competitors table */}
                        {competitors.length > 0 && (
                          <>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                              🏁 المنافسون ({competitors.length}) — نفس المادة الفعالة والجرعة
                            </div>
                            <div style={{ overflowX: 'auto', borderRadius: 10, boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead>
                                  <tr style={{ background: '#f8fafc' }}>
                                    {['الاسم التجاري','الاسم العلمي','الشكل','التعبئة','الشركة','مكتب←مذخر','مذخر←صيدلية','صيدلية←مريض','المصدر'].map(h => (
                                      <th key={h} style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, fontSize: 11, color: '#475569', borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap' }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {competitors.map((entry, i) => (
                                    <tr key={entry.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa', borderBottom: '1px solid #f1f5f9' }}>
                                      <td style={{ padding: '8px 10px', fontWeight: 700, color: '#1e293b' }}>{entry.brandName}</td>
                                      <td style={{ padding: '8px 10px', color: '#6b7280', fontSize: 11 }}>{entry.scientificName || '—'}</td>
                                      <td style={{ padding: '8px 10px', color: '#64748b' }}>{entry.dosageForm || '—'}</td>
                                      <td style={{ padding: '8px 10px', color: '#64748b' }}>{entry.packaging || '—'}</td>
                                      <td style={{ padding: '8px 10px', color: '#475569', fontWeight: 600 }}>{entry.company || '—'}</td>
                                      <td style={{ padding: '8px 10px', color: '#059669', fontWeight: 700 }}>{entry.priceOfficeToWholesaler != null ? Number(entry.priceOfficeToWholesaler).toFixed(3) : '—'}</td>
                                      <td style={{ padding: '8px 10px', color: '#d97706', fontWeight: 700 }}>{entry.priceWholesalerToPharmacy != null ? Number(entry.priceWholesalerToPharmacy).toFixed(3) : '—'}</td>
                                      <td style={{ padding: '8px 10px', color: '#dc2626', fontWeight: 700 }}>{entry.pricePharmacyToPatient != null ? Number(entry.pricePharmacyToPatient).toFixed(3) : '—'}</td>
                                      <td style={{ padding: '8px 10px', fontSize: 10, color: '#94a3b8' }}>{entry.surveyName}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </>
                        )}
                      </>
                    );
                  })()}

                  {/* Fuzzy match fallback — simple table */}
                  {(marketResult?.matchMode === 'fuzzy' || !marketResult?.matchMode) && (
                    <div style={{ overflowX: 'auto', borderRadius: 10, boxShadow: '0 1px 8px rgba(0,0,0,0.07)' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ background: '#f0fdf4' }}>
                            {['الاسم التجاري','الاسم العلمي','الشكل','التعبئة','الشركة','مكتب←مذخر','مذخر←صيدلية','صيدلية←مريض','المصدر'].map(h => (
                              <th key={h} style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 700, fontSize: 11, color: '#065f46', borderBottom: '2px solid #bbf7d0', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {marketPrices.map((entry, i) => (
                            <tr key={entry.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa', borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '9px 10px', fontWeight: 700, color: '#1e293b' }}>{entry.brandName}</td>
                              <td style={{ padding: '9px 10px', color: '#6b7280', fontSize: 11 }}>{entry.scientificName || '—'}</td>
                              <td style={{ padding: '9px 10px', color: '#64748b' }}>{entry.dosageForm || '—'}</td>
                              <td style={{ padding: '9px 10px', color: '#64748b' }}>{entry.packaging || '—'}</td>
                              <td style={{ padding: '9px 10px', color: '#475569', fontWeight: 600 }}>{entry.company || '—'}</td>
                              <td style={{ padding: '9px 10px', color: '#059669', fontWeight: 700 }}>{entry.priceOfficeToWholesaler != null ? Number(entry.priceOfficeToWholesaler).toFixed(3) : '—'}</td>
                              <td style={{ padding: '9px 10px', color: '#d97706', fontWeight: 700 }}>{entry.priceWholesalerToPharmacy != null ? Number(entry.priceWholesalerToPharmacy).toFixed(3) : '—'}</td>
                              <td style={{ padding: '9px 10px', color: '#dc2626', fontWeight: 700 }}>{entry.pricePharmacyToPatient != null ? Number(entry.pricePharmacyToPatient).toFixed(3) : '—'}</td>
                              <td style={{ padding: '9px 10px', fontSize: 11, color: '#94a3b8' }}>{entry.surveyName}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div style={{ marginTop: 10, fontSize: 11, color: '#94a3b8', textAlign: 'left' }}>
                    {marketPrices.length} نتيجة — {marketResult?.matchMode === 'ai' ? 'تطابق ذكي' : 'تطابق نصي'}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Missing-info modal ──────────────────────────── */}
      {showInfoModal && data && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }} onClick={() => setShowInfoModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#fff', borderRadius: 12, padding: 22, maxWidth: 520, width: '100%',
            boxShadow: '0 20px 50px rgba(0,0,0,.3)',
          }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#1e3a8a', marginBottom: 6 }}>
              {(data.item.scientificName || data.item.dosage || data.item.form) ? '✏️ تعديل بيانات الإيتم' : '📋 معلومات الإيتم ناقصة'}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14, lineHeight: 1.7 }}>
              بيانات الإيتم تُستخدم في تحليل المنافسين وبحث السوق. تأكد من صحة الاسم العلمي والجرعة لـ <b>{data.item.name}</b>:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>🧪 الاسم العلمي (Active ingredient)</label>
                <input
                  type="text" placeholder="مثال: Paracetamol 500mg أو Amoxicillin + Clavulanic acid"
                  value={infoForm.scientificName}
                  onChange={e => setInfoForm({ ...infoForm, scientificName: e.target.value })}
                  style={{ width: '100%', padding: 9, borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, marginTop: 4 }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>💊 الجرعة</label>
                <input
                  type="text" placeholder="مثال: 500mg / 5ml / 250mg+125mg"
                  value={infoForm.dosage}
                  onChange={e => setInfoForm({ ...infoForm, dosage: e.target.value })}
                  style={{ width: '100%', padding: 9, borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, marginTop: 4 }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>📦 الشكل الدوائي</label>
                <select
                  value={COMMON_FORMS.includes(infoForm.form) ? infoForm.form : (infoForm.form ? 'أخرى' : '')}
                  onChange={e => setInfoForm({ ...infoForm, form: e.target.value === 'أخرى' ? '' : e.target.value })}
                  style={{ width: '100%', padding: 9, borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, marginTop: 4 }}
                >
                  <option value="">— اختر —</option>
                  {COMMON_FORMS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                {(!COMMON_FORMS.includes(infoForm.form) || infoForm.form === '') && (
                  <input
                    type="text" placeholder="أو اكتب الشكل الدوائي يدوياً..."
                    value={COMMON_FORMS.includes(infoForm.form) ? '' : infoForm.form}
                    onChange={e => setInfoForm({ ...infoForm, form: e.target.value })}
                    style={{ width: '100%', padding: 9, borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, marginTop: 6 }}
                  />
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>💰 السعر</label>
                  <input
                    type="number" placeholder="مثال: 15000" min="0" step="any"
                    value={infoForm.price}
                    onChange={e => setInfoForm({ ...infoForm, price: e.target.value })}
                    style={{ width: '100%', padding: 9, borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, marginTop: 4, boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>🏭 الشركة / المصنع</label>
                  <input
                    type="text" placeholder="مثال: PharmaCo"
                    value={infoForm.companyName}
                    onChange={e => setInfoForm({ ...infoForm, companyName: e.target.value })}
                    style={{ width: '100%', padding: 9, borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, marginTop: 4, boxSizing: 'border-box' }}
                  />
                </div>
              </div>
            </div>
            {infoError && (
              <div style={{ marginTop: 10, padding: 8, background: '#fef2f2', color: '#dc2626', borderRadius: 6, fontSize: 12 }}>
                ⚠️ {infoError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={skipItemInfo} disabled={infoSaving} style={{
                padding: '9px 16px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff',
                color: '#475569', fontSize: 13, cursor: 'pointer', fontWeight: 600,
              }}>تخطّي</button>
              <button onClick={saveItemInfo} disabled={infoSaving} style={{
                padding: '9px 16px', borderRadius: 6, border: 'none',
                background: infoSaving ? '#94a3b8' : 'linear-gradient(135deg, #1e40af, #6366f1)',
                color: '#fff', fontSize: 13, cursor: infoSaving ? 'not-allowed' : 'pointer', fontWeight: 700,
              }}>
                {infoSaving ? '⏳ جاري الحفظ...' : '💾 حفظ ومتابعة'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helper components ─────────────────────────────────────
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#f8fafc', padding: 10, borderRadius: 6, border: '1px solid #e2e8f0' }}>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b' }}>{value}</div>
    </div>
  );
}

function BreakdownCard({ title, rows, maxRows = 10 }: { title: string; rows: Breakdown[]; maxRows?: number }) {
  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
      <h4 style={{ margin: '0 0 10px 0', fontSize: 13, color: '#1e40af' }}>{title}</h4>
      {rows.length === 0 && <div style={{ color: '#94a3b8', fontSize: 12 }}>لا توجد بيانات</div>}
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f1f5f9', textAlign: 'right' }}>
              <th style={{ padding: '6px 8px' }}>الاسم</th>
              <th style={{ padding: '6px 8px' }}>كمية</th>
              <th style={{ padding: '6px 8px' }}>إرجاع</th>
              <th style={{ padding: '6px 8px' }}>صافي القيمة</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, maxRows).map((r, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '6px 8px', fontWeight: 600, color: '#1e293b' }}>{r.name}</td>
                <td style={{ padding: '6px 8px' }}>{fmt(r.salesQty)}</td>
                <td style={{ padding: '6px 8px', color: r.returnsQty > 0 ? '#dc2626' : '#94a3b8' }}>{fmt(r.returnsQty)}</td>
                <td style={{ padding: '6px 8px', fontWeight: 600, color: '#0e7490' }}>{fmt(r.netValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MonthlyTrendCard({ rows }: { rows: Breakdown[] }) {
  const maxVal = Math.max(1, ...rows.map(r => r.netValue));
  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
      <h4 style={{ margin: '0 0 12px 0', fontSize: 13, color: '#1e40af' }}>📅 التطور الشهري (صافي القيمة)</h4>
      {rows.length === 0 && <div style={{ color: '#94a3b8', fontSize: 12 }}>لا توجد بيانات</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 140, paddingBottom: 24, position: 'relative' }}>
        {rows.map((r, i) => {
          const h = Math.max(2, (r.netValue / maxVal) * 100);
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 28 }} title={`${r.name}: ${fmt(r.netValue)}`}>
              <div style={{ fontSize: 9, color: '#475569', marginBottom: 2 }}>{fmt(r.netValue)}</div>
              <div style={{
                width: '100%', height: `${h}%`,
                background: r.netValue >= 0 ? 'linear-gradient(180deg, #3b82f6, #1e40af)' : '#fca5a5',
                borderRadius: '4px 4px 0 0',
              }} />
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 4, transform: 'rotate(-30deg)', transformOrigin: 'top right', whiteSpace: 'nowrap' }}>{r.name}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompetitorsCard({ competitors }: { competitors: Analytics['competitors'] }) {
  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
      <h4 style={{ margin: '0 0 10px 0', fontSize: 13, color: '#1e40af' }}>🏆 مقارنة مع إيتمات الشركة (مرجعي)</h4>
      {competitors.length === 0 && <div style={{ color: '#94a3b8', fontSize: 12 }}>لا توجد بيانات شركة كافية</div>}
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f1f5f9', textAlign: 'right' }}>
            <th style={{ padding: '6px 8px' }}>الإيتم</th>
            <th style={{ padding: '6px 8px' }}>الكمية</th>
            <th style={{ padding: '6px 8px' }}>القيمة</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map(c => (
            <tr key={c.itemId} style={{ borderBottom: '1px solid #f1f5f9', background: c.isCurrent ? '#fef3c7' : 'transparent' }}>
              <td style={{ padding: '6px 8px', fontWeight: c.isCurrent ? 700 : 600, color: c.isCurrent ? '#92400e' : '#1e293b' }}>
                {c.isCurrent && '⭐ '}{c.name}
              </td>
              <td style={{ padding: '6px 8px' }}>{fmt(c.qty)}</td>
              <td style={{ padding: '6px 8px', color: '#0e7490', fontWeight: 600 }}>{fmt(c.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VisitsPanel({ data }: { data: Analytics }) {
  const { doctorVisits, pharmacyVisits } = data;
  const totalFb = Object.values(doctorVisits.feedbackCounts).reduce((s, v) => s + v, 0) || 1;
  const fbColors: Record<string, string> = {
    writing: '#10b981', stocked: '#0891b2', interested: '#3b82f6',
    not_interested: '#ef4444', unavailable: '#94a3b8', pending: '#f59e0b',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Feedback breakdown */}
      <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
        <h4 style={{ margin: '0 0 10px 0', fontSize: 13, color: '#1e40af' }}>🩺 توزيع فيدباك الأطباء ({doctorVisits.total} زيارة)</h4>
        {doctorVisits.total === 0 ? (
          <div style={{ color: '#94a3b8', fontSize: 12 }}>لا توجد زيارات أطباء مسجلة لهذا الإيتم في الفترة المحددة</div>
        ) : (
          <>
            <div style={{ display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden', marginBottom: 10 }}>
              {Object.entries(doctorVisits.feedbackCounts).map(([fb, count]) => {
                const pct = (count / totalFb) * 100;
                return <div key={fb} style={{ width: `${pct}%`, background: fbColors[fb] || '#cbd5e1' }} title={`${doctorVisits.feedbackLabels[fb] || fb}: ${count}`} />;
              })}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {Object.entries(doctorVisits.feedbackCounts).map(([fb, count]) => (
                <div key={fb} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 10, height: 10, background: fbColors[fb] || '#cbd5e1', borderRadius: 2, display: 'inline-block' }} />
                  <span>{doctorVisits.feedbackLabels[fb] || fb}: <b>{count}</b> ({Math.round((count / totalFb) * 100)}%)</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Top doctors */}
      {doctorVisits.topDoctors.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
          <h4 style={{ margin: '0 0 10px 0', fontSize: 13, color: '#1e40af' }}>👨‍⚕️ أكثر الأطباء زيارة</h4>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f1f5f9', textAlign: 'right' }}>
                <th style={{ padding: '6px 8px' }}>الاسم</th>
                <th style={{ padding: '6px 8px' }}>التخصص</th>
                <th style={{ padding: '6px 8px' }}>المنطقة</th>
                <th style={{ padding: '6px 8px' }}>الزيارات</th>
                <th style={{ padding: '6px 8px' }}>آخر زيارة</th>
              </tr>
            </thead>
            <tbody>
              {doctorVisits.topDoctors.slice(0, 10).map((d, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{d.name}</td>
                  <td style={{ padding: '6px 8px' }}>{d.specialty || '—'}</td>
                  <td style={{ padding: '6px 8px' }}>{d.area || '—'}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 700 }}>{d.visits}</td>
                  <td style={{ padding: '6px 8px', color: '#64748b' }}>{d.lastVisit ? new Date(d.lastVisit).toLocaleDateString('ar-IQ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Notes samples */}
      {doctorVisits.notesSamples.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
          <h4 style={{ margin: '0 0 10px 0', fontSize: 13, color: '#1e40af' }}>📝 عينات من ملاحظات الزيارات</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {doctorVisits.notesSamples.map((n, i) => (
              <div key={i} style={{ padding: 8, background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, color: '#1e40af' }}>👨‍⚕️ {n.doctor}</span>
                  <span style={{ fontSize: 10, color: '#64748b' }}>
                    {n.feedback && <span style={{ marginLeft: 6 }}>• {n.feedback}</span>}
                    {n.date && <span> • {new Date(n.date).toLocaleDateString('ar-IQ')}</span>}
                  </span>
                </div>
                <div style={{ color: '#475569', lineHeight: 1.5 }}>{n.notes}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pharmacy visits */}
      {pharmacyVisits.topPharmacies.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
          <h4 style={{ margin: '0 0 10px 0', fontSize: 13, color: '#1e40af' }}>🏪 أكثر الصيدليات زيارة ({pharmacyVisits.total} زيارة إجمالاً)</h4>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f1f5f9', textAlign: 'right' }}>
                <th style={{ padding: '6px 8px' }}>الاسم</th>
                <th style={{ padding: '6px 8px' }}>المنطقة</th>
                <th style={{ padding: '6px 8px' }}>الزيارات</th>
                <th style={{ padding: '6px 8px' }}>آخر زيارة</th>
              </tr>
            </thead>
            <tbody>
              {pharmacyVisits.topPharmacies.slice(0, 10).map((p, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{p.name}</td>
                  <td style={{ padding: '6px 8px' }}>{p.area || '—'}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 700 }}>{p.visits}</td>
                  <td style={{ padding: '6px 8px', color: '#64748b' }}>{p.lastVisit ? new Date(p.lastVisit).toLocaleDateString('ar-IQ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RepDiagnosticCard({ d }: { d: RepDiagnostic }) {
  const tile = (label: string, value: string | number, color: string, sub?: string): JSX.Element => (
    <div style={{
      background: '#fff', borderRadius: 8, padding: 10, border: '1px solid #e5e7eb',
      borderRight: `4px solid ${color}`, minWidth: 130,
    }}>
      <div style={{ fontSize: 10, color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{sub}</div>}
    </div>
  );
  return (
    <div style={{
      background: 'linear-gradient(135deg, #fef3c7 0%, #fee2e2 100%)',
      borderRadius: 10, padding: 14, marginBottom: 14, border: '1px solid #fde68a',
    }}>
      <h4 style={{ margin: '0 0 12px 0', color: '#92400e', fontSize: 14 }}>
        🎯 مؤشرات التشخيص — المندوب العلمي: {d.repName}
        {d.repAreaIds && d.repAreaIds.length > 0 && (
          <span style={{ fontSize: 11, color: '#7c3aed', marginRight: 8, fontWeight: 400 }}>
            ({d.repAreaIds.length} منطقة مخصصة • المبيع مفلتر بها)
          </span>
        )}
      </h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {tile('عدد الكولات', d.callCount, '#1e40af')}
        {tile('زيارات صيدليات', d.pharmacyVisitsCount, '#0891b2')}
        {tile('أطباء مزارون', d.doctorsVisited, '#7c3aed')}
        {tile('زيارة وحيدة', d.singleVisitDoctors, '#ef4444', 'ضعف متابعة')}
        {tile('زيارة مكررة', d.repeatedVisitDoctors, '#10b981', 'متابعة جيدة')}
        {tile('متوسط زيارات/طبيب', d.avgVisitsPerDoctor, '#0e7490')}
        {tile('فيدباك إيجابي', d.positiveFeedback, '#10b981')}
        {tile('فيدباك سلبي', d.negativeFeedback, '#dc2626')}
        {tile('تغطية البلان', `${d.planCoverage.coveragePct}%`, d.planCoverage.coveragePct > 0 ? '#10b981' : '#dc2626', `${d.planCoverage.plansWithItem}/${d.planCoverage.totalPlans} بلان`)}
        {tile('نسبة أطباء/صيدليات', d.doctorPharmacyRatio, d.doctorPharmacyRatio < 0.3 ? '#dc2626' : '#1e40af')}
        {tile('صافي المبيع', Math.round(d.netValue).toLocaleString('ar-IQ'), d.netValue > 0 ? '#065f46' : '#991b1b')}
      </div>
      {d.signals.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 8, padding: 10, border: '1px solid #fde68a' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>
            ⚠️ إشارات تشخيصية مكتشفة تلقائياً:
          </div>
          <ul style={{ margin: 0, paddingRight: 20, fontSize: 12, color: '#7c2d12', lineHeight: 1.8 }}>
            {d.signals.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
      {d.signals.length === 0 && (
        <div style={{ fontSize: 12, color: '#065f46', background: '#fff', padding: 8, borderRadius: 6 }}>
          ✅ لا توجد إشارات سلبية تلقائية — الأداء ضمن المعدل.
        </div>
      )}
    </div>
  );
}
