import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import AnalysisRenderer from '../components/AnalysisRenderer';
import { usePharmacyNetFiles, type UpFile } from '../hooks/usePharmacyNetFiles';

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
  planCoverage: { totalPlans: number; plansWithItem: number; coveragePct: number; totalEntries: number; entriesWithItem: number; entryItemPct: number };
  salesValue: number;
  salesQty: number;
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
  { id: 'overview', label: 'نظرة عامة',      icon: '📊' },
  { id: 'sales',    label: 'المبيع',          icon: '📈' },
  { id: 'visits',   label: 'الزيارات',         icon: '🩺' },
  { id: 'science',  label: 'المعلومات العلمية', icon: '💊' },
  { id: 'ai',       label: 'تحليل ذكي (AI)',   icon: '🤖' },
  { id: 'market',   label: 'أسعار السوق',      icon: '💰' },
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

export default function ItemAnalysisPage() {
  const { token, isManagerOrAdmin } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };
  const pn = usePharmacyNetFiles(token);
  const { fileIdsParam } = pn;
  const [filesPanelOpen, setFilesPanelOpen] = useState(false);

  const [items, setItems]               = useState<ItemLite[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemSearch, setItemSearch]     = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedId, setSelectedId]     = useState<number | null>(() => {
    const s = sessionStorage.getItem('item_insight_id');
    return s ? Number(s) : null;
  });
  const [days, setDays]                 = useState(180);

  const [data, setData]       = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const [subTab, setSubTab]   = useState<SubTab>(() => {
    const s = sessionStorage.getItem('item_insight_tab');
    return (s as SubTab) || 'overview';
  });

  // ── Persist selection in sessionStorage across refreshes ────────
  useEffect(() => {
    if (selectedId != null) sessionStorage.setItem('item_insight_id', String(selectedId));
    else sessionStorage.removeItem('item_insight_id');
  }, [selectedId]);
  useEffect(() => {
    sessionStorage.setItem('item_insight_tab', subTab);
  }, [subTab]);

  const [aiInsight, setAIInsight]   = useState<string | null>(null);
  const [aiLoading, setAILoading]   = useState(false);
  const [aiError, setAIError]       = useState<string | null>(null);
  const [aiCachedAt, setAICachedAt] = useState<string | null>(null);
  const [aiElapsed, setAIElapsed]   = useState(0);

  const [reps, setReps]             = useState<RepListEntry[]>([]);
  const [selectedRep, setSelectedRep] = useState<string>('');

  const [marketResult, setMarketResult]         = useState<MarketPricesResult | null>(null);
  const [marketPrices, setMarketPrices]         = useState<MarketPriceEntry[]>([]);
  const [marketLoading, setMarketLoading]       = useState(false);
  const [surveyAnalyzing, setSurveyAnalyzing]   = useState(false);
  const [surveyAnalyzeMsg, setSurveyAnalyzeMsg] = useState<string | null>(null);

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
      const qs = fileIdsParam ? `?fileIds=${fileIdsParam}` : '';
      fetch(`${API}/api/item-analysis/items${qs}`, { headers })
        .then(rr => rr.json()).then(rr => setItems(rr.items || [])).catch(() => {});
      loadAnalytics();
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

  const openInfoModal = () => {
    if (!data) return;
    setInfoForm({ scientificName: data.item.scientificName || '', dosage: data.item.dosage || '', form: data.item.form || '', price: data.item.price != null ? String(data.item.price) : '', companyName: data.item.company?.name || '' });
    setInfoError(null);
    setShowInfoModal(true);
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
        if (obj.generatedAt && Date.now() - new Date(obj.generatedAt).getTime() < 24 * 60 * 60 * 1000) {
          setAIInsight(obj.insight);
          setAICachedAt(obj.generatedAt);
        }
      }
    } catch {}
  }, [selectedId, fileIdsParam, days, selectedRep]);

  const requestAI = async () => {
    if (!selectedId) return;
    setAILoading(true); setAIError(null); setAIElapsed(0);
    const startTime = Date.now();
    const timer = setInterval(() => {
      setAIElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 240 * 1000);
    try {
      const r = await fetch(`${API}/api/item-analysis/${selectedId}/ai-insight`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: fileIdsParam || null, days, repName: selectedRep || null }),
        signal: controller.signal,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as any));
        throw new Error(j.error || j.message || `فشل التحليل الذكي (HTTP ${r.status})`);
      }
      const j = await r.json();
      setAIInsight(j.insight);
      setAICachedAt(j.generatedAt);
      try {
        const key = `${CACHE_PREFIX}${selectedId}:${fileIdsParam || 'all'}:${days}:${selectedRep || 'all'}`;
        localStorage.setItem(key, JSON.stringify({ insight: j.insight, generatedAt: j.generatedAt }));
      } catch {}
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setAIError('انتهت مهلة التحليل الذكي. الرجاء المحاولة مجدداً.');
      } else {
        setAIError(String(e.message || e));
      }
    } finally {
      clearInterval(timer);
      clearTimeout(abortTimer);
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
    const repSuffix = selectedRep ? `_${selectedRep.replace(/[^؀-ۿa-zA-Z0-9]+/g, '_')}` : '';
    a.href = url; a.download = `تحليل_${data.item.name.replace(/[^؀-ۿa-zA-Z0-9]+/g, '_')}${repSuffix}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return items.slice(0, 200);
    return items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.scientificName || '').toLowerCase().includes(q)
    ).slice(0, 200);
  }, [items, itemSearch]);

  const KPI_DEFS = data ? [
    { icon: '📈', label: 'كمية المبيع',        value: fmt(data.overview.salesQty),      bg: '#ecfdf5', color: '#059669' },
    { icon: '📉', label: 'كمية الإرجاع',        value: fmt(data.overview.returnsQty),    bg: '#fef2f2', color: '#dc2626' },
    { icon: '📦', label: 'صافي الكمية',         value: fmt(data.overview.netQty),        bg: '#eff6ff', color: '#1e40af' },
    { icon: '💰', label: 'صافي القيمة (د.ع)',   value: fmt(data.overview.netValue),      bg: '#ecfeff', color: '#0891b2' },
    { icon: '🌍', label: 'عدد المناطق',         value: fmt(data.overview.areasCount),    bg: '#fffbeb', color: '#d97706' },
    { icon: '👤', label: 'عدد المندوبين',       value: fmt(data.overview.repsCount),     bg: '#f5f3ff', color: '#7c3aed' },
    { icon: '🏪', label: 'الصيدليات المشترية',  value: fmt(data.overview.pharmaciesCount), bg: '#fdf2f8', color: '#db2777' },
    { icon: '🩺', label: 'زيارات الأطباء',       value: fmt(data.overview.totalDoctorVisits), bg: '#f0fdf4', color: '#16a34a' },
  ] : [];

  return (
    <div className="page" dir="rtl" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <div className="page-title">🔍 تحليل الإيتم</div>
          <div className="page-subtitle">تحليل ذكي شامل لأداء أي إيتم — المبيع، الزيارات، المنافسون، والتوصيات</div>
        </div>
      </div>

      <FilesPanel pn={pn} open={filesPanelOpen} setOpen={setFilesPanelOpen} />

      {/* ── Item selector + days filter ─────────────────── */}
      <div className="filter-card" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 260, position: 'relative' }}>
          <label className="form-label">اختر الإيتم</label>
          <div style={{ position: 'relative' }}>
            <input
              className="form-input"
              type="text"
              placeholder="ابحث بالاسم التجاري أو العلمي أو اضغط للاختيار..."
              value={itemSearch}
              onChange={e => setItemSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 180)}
              style={{ paddingLeft: 34 }}
            />
            {itemSearch ? (
              <span
                onMouseDown={e => { e.preventDefault(); setItemSearch(''); }}
                style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', fontSize: 16, color: 'var(--c-text-muted)', lineHeight: 1 }}
              >×</span>
            ) : (
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--c-text-muted)', pointerEvents: 'none' }}>▾</span>
            )}
          </div>
          {(searchFocused || itemSearch.trim()) && (
            <div style={{ position: 'absolute', zIndex: 999, width: '100%', maxHeight: 300, overflowY: 'auto', border: '1px solid var(--c-border)', borderRadius: 'var(--radius-md)', marginTop: 4, background: 'var(--c-surface)', boxShadow: 'var(--shadow-lg)' }}>
              {!itemSearch.trim() && (
                <div style={{ padding: '7px 12px', fontSize: 11, color: 'var(--c-text-muted)', borderBottom: '1px solid var(--c-border-light)', fontWeight: 600 }}>
                  🔍 كل الإيتمات ({items.length})
                </div>
              )}
              {itemsLoading && <div style={{ padding: 12, color: 'var(--c-text-muted)', fontSize: 12 }}>...جاري التحميل</div>}
              {!itemsLoading && filteredItems.length === 0 && <div style={{ padding: 12, color: 'var(--c-text-muted)', fontSize: 12 }}>لا توجد نتائج</div>}
              {filteredItems.map(i => (
                <div
                  key={i.id}
                  onMouseDown={() => { setSelectedId(i.id); setItemSearch(''); setSearchFocused(false); }}
                  style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--c-border-light)', background: selectedId === i.id ? 'var(--c-accent-light)' : 'transparent' }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: selectedId === i.id ? 'var(--c-accent)' : 'var(--c-text-primary)' }}>
                    {selectedId === i.id && <span style={{ marginLeft: 4 }}>✓</span>}
                    {i.name}
                  </div>
                  {i.scientificName && <div style={{ fontSize: 11, color: 'var(--c-text-secondary)' }}>{i.scientificName} {i.dosage ? `• ${i.dosage}` : ''} {i.form ? `• ${i.form}` : ''}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="form-group">
          <label className="form-label">الفترة (أيام)</label>
          <select className="form-input" value={days} onChange={e => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
            <option value={30}>آخر 30 يوم</option>
            <option value={60}>آخر 60 يوم</option>
            <option value={90}>آخر 90 يوم</option>
            <option value={180}>آخر 180 يوم</option>
            <option value={365}>آخر سنة</option>
          </select>
        </div>
        {selectedId && (
          <button className="btn btn--secondary" onClick={() => { setSelectedId(null); setData(null); setAIInsight(null); }}>
            إلغاء التحديد
          </button>
        )}
      </div>

      {/* ── Selected item summary ──────────────────────── */}
      {data && (
        <div className="card" style={{ borderRight: '4px solid var(--c-accent)', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {data.item.imageUrl && (
              <img src={data.item.imageUrl.startsWith('http') ? data.item.imageUrl : `${API}${data.item.imageUrl}`}
                alt={data.item.name}
                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--c-border)' }} />
            )}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-text-primary)' }}>{data.item.name}</div>
                <button className="btn btn--secondary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={openInfoModal}>✏️ تعديل</button>
              </div>
              {data.item.scientificName && <div style={{ fontSize: 13, color: 'var(--c-text-secondary)', marginTop: 2 }}>🧪 {data.item.scientificName}</div>}
              <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginTop: 4 }}>
                {data.item.dosage && <span>الجرعة: <b>{data.item.dosage}</b> • </span>}
                {data.item.form && <span>الشكل: <b>{data.item.form}</b> • </span>}
                {data.item.price != null && <span>السعر: <b>{fmt(data.item.price)}</b> • </span>}
                {data.item.company && <span>الشركة: <b>{data.item.company.name}</b></span>}
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--c-text-secondary)' }}>
              <div>أول مبيع: {fmtDate(data.overview.firstSaleDate)}</div>
              <div>آخر مبيع: {fmtDate(data.overview.lastSaleDate)}</div>
              <div>نافذة التحليل: <b>{data.windowDays} يوم</b></div>
            </div>
          </div>
        </div>
      )}

      {/* ── Loading / Empty / Error states ──────────────── */}
      {!selectedId && (
        <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--c-text-secondary)' }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔍</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text-primary)' }}>اختر إيتماً للبدء بالتحليل</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>سيتم جمع كل بيانات المبيع والإرجاع والزيارات والفيدباك لتحليل أداء الإيتم</div>
        </div>
      )}
      {loading && <div className="card" style={{ textAlign: 'center', color: 'var(--c-accent)' }}>⏳ جاري تحميل بيانات الإيتم...</div>}
      {error && <div className="alert alert--error" style={{ marginBottom: 16 }}>⚠️ {error}</div>}

      {/* ── KPI cards + sub-tabs ────────────────────────── */}
      {data && !loading && (
        <>
          <div className="stats-grid">
            {KPI_DEFS.map((k, i) => (
              <div key={i} className="stat-card" style={{ borderTop: `4px solid ${k.color}` }}>
                <div className="stat-card-icon" style={{ background: k.bg, color: k.color }}>{k.icon}</div>
                <div className="stat-card-body">
                  <div className="stat-card-value" style={{ color: k.color }}>{k.value}</div>
                  <div className="stat-card-label">{k.label}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="tabs">
            {SUB_TABS.map(t => (
              <button key={t.id} className={`tab ${subTab === t.id ? 'tab--active' : ''}`} onClick={() => setSubTab(t.id)}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {/* ── Subtab: Overview ───────────────────────── */}
          {subTab === 'overview' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
              <BreakdownCard title="🌍 المناطق (أعلى 10 بالقيمة)" rows={data.salesByArea.slice(0, 10)} />
              <BreakdownCard title="👤 المندوبون (أعلى 10 بالقيمة)" rows={data.salesByRep.slice(0, 10)} />
              <BreakdownCard title="🏪 الصيدليات (أعلى 10)" rows={data.topPharmacies.slice(0, 10)} />
              <CompetitorsCard competitors={data.competitors} />
            </div>
          )}

          {/* ── Subtab: Sales ──────────────────────────── */}
          {subTab === 'sales' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <MonthlyTrendCard rows={data.salesByMonth} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
                <BreakdownCard title="📍 كل المناطق" rows={data.salesByArea} maxRows={25} />
                <BreakdownCard title="🧑‍💼 كل المندوبين" rows={data.salesByRep} maxRows={25} />
                <BreakdownCard title="🏥 كل الصيدليات" rows={data.topPharmacies} maxRows={25} />
              </div>
            </div>
          )}

          {/* ── Subtab: Visits ─────────────────────────── */}
          {subTab === 'visits' && <VisitsPanel data={data} />}

          {/* ── Subtab: Science ────────────────────────── */}
          {subTab === 'science' && (
            <ScienceTab data={data} aiInsight={aiInsight} marketLoading={marketLoading} marketPrices={marketPrices} onEdit={openInfoModal} />
          )}

          {/* ── Subtab: AI insight ─────────────────────── */}
          {subTab === 'ai' && (
            <div className="card">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 16, padding: 10, background: 'var(--c-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border-light)' }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-text-primary)' }}>👤 نطاق التحليل:</label>
                <select className="form-input" value={selectedRep} onChange={e => setSelectedRep(e.target.value)} style={{ width: 'auto', minWidth: 220 }}>
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

              {selectedRep && data.repDiagnostic && <RepDiagnosticCard d={data.repDiagnostic} />}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
                <h3 style={{ margin: 0, color: 'var(--c-accent)' }}>
                  🤖 التحليل الذكي عبر Gemini
                  {selectedRep && <span style={{ fontSize: 12, color: '#7c3aed', marginRight: 8 }}>(للمندوب: {selectedRep})</span>}
                </h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  {aiInsight && <button className="btn btn--secondary" onClick={exportAIInsight}>⬇️ تصدير</button>}
                  <button className="btn btn--primary" onClick={requestAI} disabled={aiLoading}>
                    {aiLoading ? `⏳ جاري التحليل... ${aiElapsed > 0 ? `(${aiElapsed}ث)` : ''}` : aiInsight ? '🔄 إعادة التحليل' : '✨ احصل على تحليل ذكي'}
                  </button>
                </div>
              </div>

              {aiCachedAt && (
                <div style={{ fontSize: 11, color: 'var(--c-text-secondary)', marginBottom: 10 }}>
                  ⏱️ تم التوليد: {new Date(aiCachedAt).toLocaleString('ar-IQ')}
                </div>
              )}

              {marketResult && (
                <div className={marketPrices.length > 0 ? 'info-banner' : 'alert alert--error'} style={{ marginBottom: 10, background: marketPrices.length > 0 ? undefined : '#fffbeb', color: marketPrices.length > 0 ? undefined : '#92400e', borderColor: marketPrices.length > 0 ? undefined : '#fde68a' }}>
                  {marketPrices.length > 0 ? (
                    <p style={{ margin: 0 }}>🔬 <b>{marketPrices.filter(e => !e.isOwnProduct).length}</b> منافس من السيرفي سيُستخدم في التحليل التنافسي
                      {marketResult.matchMode === 'ai' && <span className="tag tag--navy" style={{ marginRight: 8 }}>تطابق ذكي</span>}
                    </p>
                  ) : (
                    <p style={{ margin: 0 }}>🔬 لا توجد بيانات منافسين في السيرفي — التحليل سيعتمد على البيانات الداخلية فقط. ارفع سيرفي أسعار للحصول على تحليل تنافسي حقيقي.</p>
                  )}
                </div>
              )}

              {aiError && <div className="alert alert--error" style={{ marginBottom: 10 }}>⚠️ {aiError}</div>}

              {!aiInsight && !aiLoading && !aiError && (
                <div style={{ padding: 28, background: 'var(--c-bg)', borderRadius: 'var(--radius-md)', textAlign: 'center', color: 'var(--c-text-secondary)' }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🤖</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text-primary)' }}>اضغط الزر أعلاه لتشغيل التحليل الذكي</div>
                  <div style={{ fontSize: 12, marginTop: 6 }}>يُصدر تقريراً متخصصاً في أداء المندوبين وتطوير المبيع يشمل:</div>
                  <ul style={{ textAlign: 'right', display: 'inline-block', fontSize: 12, marginTop: 8, lineHeight: 1.9 }}>
                    <li>📊 انتشار السوق ومرحلة دورة الحياة</li>
                    <li>🔍 تشخيص أسباب ضعف المبيع مع الدليل</li>
                    <li>👤 تشخيص خاص بالمندوب المحدد (إذا اخترته)</li>
                    <li>🎯 اقتراحات عملية مرقّمة للفريق</li>
                    <li>📅 خطة عمل 30 يوم تنفيذية</li>
                  </ul>
                  <div style={{ fontSize: 11, marginTop: 10, color: 'var(--c-text-muted)', fontStyle: 'italic' }}>
                    💊 الملف العلمي، الأطباء المستهدفون، وتحليل المنافسة موجودون في تبويب "المعلومات العلمية"
                  </div>
                </div>
              )}

              {aiLoading && (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--c-accent)' }}>
                  <div style={{ fontSize: 22 }}>⏳</div>
                  <div style={{ fontSize: 14, marginTop: 6 }}>جاري إنشاء التحليل... قد يستغرق حتى دقيقتين للتقارير الكبيرة</div>
                </div>
              )}

              {aiInsight && !aiLoading && (
                <div>
                  <div className="info-banner" style={{ marginBottom: 12 }}>
                    <p style={{ margin: 0 }}>💊 الملف العلمي، الأطباء المستهدفون، وتحليل المنافسة متوفّرون في تبويب <b>المعلومات العلمية</b></p>
                  </div>
                  <AnalysisRenderer text={aiInsight} skipSecNums={[1, 2, 3]} />
                </div>
              )}
            </div>
          )}

          {/* ── Market Prices Tab ─────────────────── */}
          {subTab === 'market' && (
            <MarketTab
              marketResult={marketResult} marketPrices={marketPrices} marketLoading={marketLoading}
              isManagerOrAdmin={!!isManagerOrAdmin} surveyAnalyzing={surveyAnalyzing} surveyAnalyzeMsg={surveyAnalyzeMsg}
              onAnalyze={async () => {
                setSurveyAnalyzing(true); setSurveyAnalyzeMsg(null);
                try {
                  setSurveyAnalyzeMsg('⏳ جاري تحليل السيرفيات... قد يستغرق حتى دقيقتين');
                  const res = await fetch(`${API}/api/item-analysis/survey/ai-analyze-all`, { method: 'POST', headers });
                  const txt = await res.text();
                  let j: any = {};
                  try { j = txt ? JSON.parse(txt) : {}; }
                  catch {
                    throw new Error(res.status === 504 || res.status === 502
                      ? 'انتهت مهلة الخادم أثناء التحليل — أعد المحاولة (سيُكمل ما تبقّى)'
                      : 'تعذّر قراءة رد الخادم — حاول مرة أخرى');
                  }
                  if (!res.ok) throw new Error(j.error || 'خطأ أثناء التحليل');
                  if (j.surveyCount === 0) {
                    setSurveyAnalyzeMsg('⚠️ لا توجد سيرفيات أسعار نشطة في النظام');
                    return;
                  }
                  setSurveyAnalyzeMsg(j.message || `تم تحليل ${j.done} من ${j.surveyCount} سيرفي`);
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
            />
          )}
        </>
      )}

      {/* ── Missing-info modal ──────────────────────────── */}
      {showInfoModal && data && (
        <div className="modal-overlay" onClick={() => setShowInfoModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{(data.item.scientificName || data.item.dosage || data.item.form) ? '✏️ تعديل بيانات الإيتم' : '📋 معلومات الإيتم ناقصة'}</h2>
              <button className="modal-close" onClick={() => setShowInfoModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', lineHeight: 1.7 }}>
                بيانات الإيتم تُستخدم في تحليل المنافسين وبحث السوق. تأكد من صحة الاسم العلمي والجرعة لـ <b>{data.item.name}</b>:
              </div>
              <div className="form-group">
                <label className="form-label">🧪 الاسم العلمي (Active ingredient)</label>
                <input className="form-input" type="text" placeholder="مثال: Paracetamol 500mg أو Amoxicillin + Clavulanic acid"
                  value={infoForm.scientificName} onChange={e => setInfoForm({ ...infoForm, scientificName: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">💊 الجرعة</label>
                <input className="form-input" type="text" placeholder="مثال: 500mg / 5ml / 250mg+125mg"
                  value={infoForm.dosage} onChange={e => setInfoForm({ ...infoForm, dosage: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">📦 الشكل الدوائي</label>
                <select className="form-input"
                  value={COMMON_FORMS.includes(infoForm.form) ? infoForm.form : (infoForm.form ? 'أخرى' : '')}
                  onChange={e => setInfoForm({ ...infoForm, form: e.target.value === 'أخرى' ? '' : e.target.value })}
                >
                  <option value="">— اختر —</option>
                  {COMMON_FORMS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                {(!COMMON_FORMS.includes(infoForm.form) || infoForm.form === '') && (
                  <input className="form-input" type="text" placeholder="أو اكتب الشكل الدوائي يدوياً..." style={{ marginTop: 6 }}
                    value={COMMON_FORMS.includes(infoForm.form) ? '' : infoForm.form}
                    onChange={e => setInfoForm({ ...infoForm, form: e.target.value })} />
                )}
              </div>
              <div className="input-row" style={{ gap: 12 }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">💰 السعر</label>
                  <input className="form-input" type="number" placeholder="مثال: 15000" min="0" step="any"
                    value={infoForm.price} onChange={e => setInfoForm({ ...infoForm, price: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">🏭 الشركة / المصنع</label>
                  <input className="form-input" type="text" placeholder="مثال: PharmaCo"
                    value={infoForm.companyName} onChange={e => setInfoForm({ ...infoForm, companyName: e.target.value })} />
                </div>
              </div>
              {infoError && <div className="alert alert--error">⚠️ {infoError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn btn--primary" onClick={saveItemInfo} disabled={infoSaving}>
                {infoSaving ? '⏳ جاري الحفظ...' : '💾 حفظ ومتابعة'}
              </button>
              <button className="btn btn--secondary" onClick={skipItemInfo} disabled={infoSaving}>تخطّي</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════ Files source panel ═══════════════════════════
function FilesPanel({ pn, open, setOpen }: { pn: ReturnType<typeof usePharmacyNetFiles>; open: boolean; setOpen: (v: boolean) => void }) {
  const {
    files, selFiles, filesLoading, toggleFile, selectAll, selectNone,
    uploading, uploadMsg, dragOver, setDragOver, showUpload, setShowUpload,
    requestUpload, uploadFile, handleDrop, uploadInputRef,
    pendingFile, setPendingFile, preCurrency, setPreCurrency, preRate, setPreRate,
    clearing, showClearConfirm, setShowClearConfirm, clearAllData,
    confirmDeleteFileId, setConfirmDeleteFileId, deletingFileId, deleteOneFile,
  } = pn;

  return (
    <div className="filter-card">
      {pendingFile && (
        <div className="modal-overlay">
          <div className="modal" style={{ textAlign: 'center', padding: '28px 32px' }}>
            <div style={{ fontSize: 22, marginBottom: 6 }}>💱</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--c-text-primary)', marginBottom: 4 }}>عملة الملف</div>
            <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginBottom: 18 }}>{pendingFile.name}</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 16 }}>
              {(['IQD', 'USD'] as const).map(c => (
                <button key={c} onClick={() => setPreCurrency(c)} className={`tab ${preCurrency === c ? 'tab--active' : ''}`}>
                  {c === 'IQD' ? 'د.ع دينار عراقي' : '$ دولار'}
                </button>
              ))}
            </div>
            {preCurrency === 'USD' && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 16 }}>
                <span style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>سعر الصرف (دولار → دينار):</span>
                <input className="form-input" type="number" min="1" value={preRate} onChange={e => setPreRate(e.target.value)} style={{ width: 90, textAlign: 'center' }} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn btn--primary" onClick={() => {
                const rate = parseFloat(preRate);
                uploadFile(pendingFile, preCurrency, isFinite(rate) && rate > 0 ? rate : 1470);
                setPendingFile(null);
              }}>✔ رفع الملف</button>
              <button className="btn btn--secondary" onClick={() => setPendingFile(null)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {showClearConfirm && (
        <div className="modal-overlay" onClick={() => !clearing && setShowClearConfirm(false)}>
          <div className="modal" style={{ textAlign: 'center', padding: '28px 32px' }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 26, marginBottom: 8 }}>🗑️</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--c-text-primary)', marginBottom: 6 }}>مسح كل البيانات</div>
            <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginBottom: 20 }}>سيتم حذف جميع الملفات ({files.length}) وبياناتها نهائياً. هل أنت متأكد؟</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn" style={{ background: 'var(--c-danger)', color: '#fff' }} onClick={clearAllData} disabled={clearing}>
                {clearing ? '⏳ جاري الحذف...' : '✔ نعم، احذف'}
              </button>
              <button className="btn btn--secondary" onClick={() => setShowClearConfirm(false)} disabled={clearing}>إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteFileId !== null && (() => {
        const cf = files.find((f: UpFile) => f.id === confirmDeleteFileId);
        return (
          <div className="modal-overlay" onClick={() => !deletingFileId && setConfirmDeleteFileId(null)}>
            <div className="modal" style={{ textAlign: 'center', padding: '24px 28px' }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>🗑️</div>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--c-text-primary)', marginBottom: 6 }}>حذف الملف</div>
              <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginBottom: 18, wordBreak: 'break-all' }}>{cf?.originalName}</div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button className="btn" style={{ background: 'var(--c-danger)', color: '#fff' }} onClick={() => deleteOneFile(confirmDeleteFileId)} disabled={!!deletingFileId}>
                  {deletingFileId ? '⏳ جاري الحذف...' : '✔ نعم، احذف'}
                </button>
                <button className="btn btn--secondary" onClick={() => setConfirmDeleteFileId(null)} disabled={!!deletingFileId}>إلغاء</button>
              </div>
            </div>
          </div>
        );
      })()}

      <button onClick={() => setOpen(!open)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none',
        cursor: 'pointer', padding: 0, fontFamily: 'inherit',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)' }}>📂 الملفات المصدر</span>
        <span className="tag tag--navy">{selFiles.size} / {files.length}</span>
        <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--c-text-muted)' }}>{open ? '▲ إخفاء' : '▼ عرض وإدارة الملفات'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--c-border-light)', paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <button className="btn btn--secondary" style={{ padding: '4px 12px', fontSize: 11 }} onClick={selectAll}>تحديد الكل</button>
            <button className="btn btn--secondary" style={{ padding: '4px 12px', fontSize: 11 }} onClick={selectNone}>إلغاء الكل</button>
            {files.length > 0 && (
              <button className="btn" style={{ padding: '4px 12px', fontSize: 11, background: 'var(--c-danger-bg)', color: 'var(--c-danger)' }} onClick={() => setShowClearConfirm(true)}>🗑 مسح كل البيانات</button>
            )}
          </div>

          {filesLoading ? <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>جاري التحميل...</span> : (
            <div className="tag-list">
              {files.map((f: UpFile) => (
                <span key={f.id} className={`tag ${selFiles.has(f.id) ? 'tag--navy' : 'tag--gray'}`} style={{ cursor: 'pointer', paddingLeft: 4 }}>
                  <span onClick={() => toggleFile(f.id)}>
                    {selFiles.has(f.id) ? '✓ ' : ''}{f.originalName} <span style={{ opacity: .6 }}>({f.rowCount})</span>
                  </span>
                  <span onClick={e => { e.stopPropagation(); setConfirmDeleteFileId(f.id); }} style={{ opacity: .6 }}>×</span>
                </span>
              ))}
              {files.length === 0 && <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>لا توجد ملفات</span>}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--c-border-light)', marginTop: 12, paddingTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn btn--secondary" style={{ padding: '4px 12px', fontSize: 11 }} onClick={() => setShowUpload(!showUpload)}>
                {showUpload ? '✕ إخفاء' : '⬆ رفع ملف جديد'}
              </button>
              {uploadMsg && <span style={{ fontSize: 12, color: uploadMsg.ok ? 'var(--c-success)' : 'var(--c-danger)' }}>{uploadMsg.text}</span>}
            </div>
            {showUpload && (
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
                onClick={() => !uploading && uploadInputRef.current?.click()}
                style={{ border: `2px dashed ${dragOver ? 'var(--c-accent)' : 'var(--c-border)'}`, borderRadius: 'var(--radius-md)', background: dragOver ? 'var(--c-accent-light)' : 'var(--c-bg)', padding: '18px 16px', textAlign: 'center', cursor: uploading ? 'default' : 'pointer', marginTop: 8 }}
              >
                <input ref={uploadInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) { requestUpload(f); e.target.value = ''; } }} />
                {uploading
                  ? <span style={{ color: 'var(--c-accent)', fontSize: 13, fontWeight: 600 }}>⏳ جاري الرفع...</span>
                  : <><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-accent)' }}>اسحب وأفلت أو اضغط للاختيار</div><div style={{ fontSize: 10, color: 'var(--c-text-muted)' }}>.xlsx / .xls / .csv</div></>
                }
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════ Small reusable section components ═══════════════════════════
function BreakdownCard({ title, rows, maxRows = 10 }: { title: string; rows: Breakdown[]; maxRows?: number }) {
  const maxVal = Math.max(1, ...rows.map(r => r.netValue));
  return (
    <div className="card">
      <div className="section-title" style={{ margin: '0 0 10px', fontSize: 14 }}>{title}</div>
      {rows.length === 0 && <div style={{ color: 'var(--c-text-muted)', fontSize: 12 }}>لا توجد بيانات</div>}
      {rows.length > 0 && (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="data-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>الاسم</th><th>كمية</th><th>إرجاع</th><th>صافي القيمة</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, maxRows).map((r, i) => {
                const pct = Math.max(2, (r.netValue / maxVal) * 100);
                return (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td>{fmt(r.salesQty)}</td>
                    <td style={{ color: r.returnsQty > 0 ? 'var(--c-danger)' : 'var(--c-text-muted)' }}>{fmt(r.returnsQty)}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, color: '#0891b2', minWidth: 60 }}>{fmt(r.netValue)}</span>
                        <div style={{ flex: 1, minWidth: 40, maxWidth: 60, height: 6, background: 'var(--c-border-light)', borderRadius: 999, overflow: 'hidden' }}>
                          <div className="pct-bar" style={{ width: `${pct}%`, height: '100%' }} />
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MonthlyTrendCard({ rows }: { rows: Breakdown[] }) {
  const maxVal = Math.max(1, ...rows.map(r => r.netValue));
  return (
    <div className="card">
      <div className="section-title" style={{ margin: '0 0 14px', fontSize: 14 }}>📅 التطور الشهري (صافي القيمة)</div>
      {rows.length === 0 && <div style={{ color: 'var(--c-text-muted)', fontSize: 12 }}>لا توجد بيانات</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 140, paddingBottom: 24, position: 'relative' }}>
        {rows.map((r, i) => {
          const h = Math.max(2, (r.netValue / maxVal) * 100);
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 28 }} title={`${r.name}: ${fmt(r.netValue)}`}>
              <div style={{ fontSize: 9, color: 'var(--c-text-secondary)', marginBottom: 2 }}>{fmt(r.netValue)}</div>
              <div style={{ width: '100%', height: `${h}%`, background: r.netValue >= 0 ? 'linear-gradient(180deg, #4078e8, var(--c-accent))' : '#fca5a5', borderRadius: '4px 4px 0 0' }} />
              <div style={{ fontSize: 10, color: 'var(--c-text-secondary)', marginTop: 4, transform: 'rotate(-30deg)', transformOrigin: 'top right', whiteSpace: 'nowrap' }}>{r.name}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompetitorsCard({ competitors }: { competitors: Analytics['competitors'] }) {
  return (
    <div className="card">
      <div className="section-title" style={{ margin: '0 0 10px', fontSize: 14 }}>🏆 مقارنة مع إيتمات الشركة (مرجعي)</div>
      {competitors.length === 0 && <div style={{ color: 'var(--c-text-muted)', fontSize: 12 }}>لا توجد بيانات شركة كافية</div>}
      {competitors.length > 0 && (
        <table className="data-table" style={{ fontSize: 12 }}>
          <thead><tr><th>الإيتم</th><th>الكمية</th><th>القيمة</th></tr></thead>
          <tbody>
            {competitors.map(c => (
              <tr key={c.itemId} style={{ background: c.isCurrent ? 'var(--c-warning-bg)' : undefined }}>
                <td style={{ fontWeight: c.isCurrent ? 700 : 600, color: c.isCurrent ? 'var(--c-warning)' : 'var(--c-text-primary)' }}>
                  {c.isCurrent && '⭐ '}{c.name}
                </td>
                <td>{fmt(c.qty)}</td>
                <td style={{ color: '#0891b2', fontWeight: 600 }}>{fmt(c.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="section-title" style={{ margin: '0 0 10px', fontSize: 14 }}>🩺 توزيع فيدباك الأطباء ({doctorVisits.total} زيارة)</div>
        {doctorVisits.total === 0 ? (
          <div style={{ color: 'var(--c-text-muted)', fontSize: 12 }}>لا توجد زيارات أطباء مسجلة لهذا الإيتم في الفترة المحددة</div>
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

      {doctorVisits.topDoctors.length > 0 && (
        <div className="card">
          <div className="section-title" style={{ margin: '0 0 10px', fontSize: 14 }}>👨‍⚕️ أكثر الأطباء زيارة</div>
          <table className="data-table" style={{ fontSize: 12 }}>
            <thead><tr><th>الاسم</th><th>التخصص</th><th>المنطقة</th><th>الزيارات</th><th>آخر زيارة</th></tr></thead>
            <tbody>
              {doctorVisits.topDoctors.slice(0, 10).map((d, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{d.name}</td>
                  <td>{d.specialty || '—'}</td>
                  <td>{d.area || '—'}</td>
                  <td style={{ fontWeight: 700 }}>{d.visits}</td>
                  <td style={{ color: 'var(--c-text-secondary)' }}>{d.lastVisit ? new Date(d.lastVisit).toLocaleDateString('ar-IQ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {doctorVisits.notesSamples.length > 0 && (
        <div className="card">
          <div className="section-title" style={{ margin: '0 0 10px', fontSize: 14 }}>📝 عينات من ملاحظات الزيارات</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {doctorVisits.notesSamples.map((n, i) => (
              <div key={i} style={{ padding: 8, background: 'var(--c-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border-light)', fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, color: 'var(--c-accent)' }}>👨‍⚕️ {n.doctor}</span>
                  <span style={{ fontSize: 10, color: 'var(--c-text-secondary)' }}>
                    {n.feedback && <span style={{ marginLeft: 6 }}>• {n.feedback}</span>}
                    {n.date && <span> • {new Date(n.date).toLocaleDateString('ar-IQ')}</span>}
                  </span>
                </div>
                <div style={{ color: 'var(--c-text-secondary)', lineHeight: 1.5 }}>{n.notes}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {pharmacyVisits.topPharmacies.length > 0 && (
        <div className="card">
          <div className="section-title" style={{ margin: '0 0 10px', fontSize: 14 }}>🏪 أكثر الصيدليات زيارة ({pharmacyVisits.total} زيارة إجمالاً)</div>
          <table className="data-table" style={{ fontSize: 12 }}>
            <thead><tr><th>الاسم</th><th>المنطقة</th><th>الزيارات</th><th>آخر زيارة</th></tr></thead>
            <tbody>
              {pharmacyVisits.topPharmacies.slice(0, 10).map((p, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td>{p.area || '—'}</td>
                  <td style={{ fontWeight: 700 }}>{p.visits}</td>
                  <td style={{ color: 'var(--c-text-secondary)' }}>{p.lastVisit ? new Date(p.lastVisit).toLocaleDateString('ar-IQ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════ Science tab ═══════════════════════════
function ScienceTab({ data, aiInsight, marketLoading, marketPrices, onEdit }: {
  data: Analytics; aiInsight: string | null; marketLoading: boolean; marketPrices: MarketPriceEntry[]; onEdit: () => void;
}) {
  const specs: Record<string, number> = {};
  (data.doctorVisits.topDoctors || []).forEach(d => {
    if (d.specialty) specs[d.specialty] = (specs[d.specialty] || 0) + d.visits;
  });
  const sortedSpecs = Object.entries(specs).sort((a, b) => b[1] - a[1]);

  let sec1Rows: { field: string; value: string }[] = [];
  let sciMsg: string | null = null;
  if (aiInsight) {
    const sec1Match = aiInsight.match(/##\s*💊\s*1\.[^\n]*([\s\S]*?)(?=\n##\s|$)/);
    const sec1Text = sec1Match ? sec1Match[1] : aiInsight;
    sec1Text.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('---') || trimmed.startsWith('>') || trimmed.startsWith('#')) return;
      const kvR = /\*\*([^*:\n]+):\*\*\s*([^|*\n]+)/g;
      let match;
      while ((match = kvR.exec(trimmed)) !== null) {
        const field = match[1].trim();
        const value = match[2].trim();
        if (field && value) sec1Rows.push({ field, value });
      }
    });
    const msgMatch = sec1Text.match(/>\s*(.+)/);
    sciMsg = msgMatch ? msgMatch[1].trim() : null;
  }

  const itemDosage = (data?.item?.dosage || '').toLowerCase();
  const dosageNums = itemDosage.match(/\d+(?:[.,]\d+)?/g) || [];
  const ownEntry = marketPrices.find(e => e.isOwnProduct);
  const allCompetitors = marketPrices.filter(e => !e.isOwnProduct);
  const sameDoseCompetitors = dosageNums.length > 0
    ? allCompetitors.filter(e => {
        const t = (e.brandName + ' ' + (e.packaging || '')).toLowerCase();
        return dosageNums.every(n => t.includes(n));
      })
    : allCompetitors;
  const ownPrice = ownEntry?.pricePharmacyToPatient ?? null;
  const extractQty = (pkg: string | null | undefined): number => {
    if (!pkg) return 1;
    const m = pkg.match(/\b(\d+)\b/);
    const n = m ? parseInt(m[1], 10) : 1;
    return n > 0 ? n : 1;
  };
  const ownQty = extractQty(ownEntry?.packaging);
  const ownPPU = ownPrice != null ? ownPrice / ownQty : null;

  return (
    <div className="card">
      {/* Drug identity header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, padding: '12px 16px', background: 'var(--c-accent-light)', borderRadius: 'var(--radius-md)', borderRight: '4px solid var(--c-accent)' }}>
        <div style={{ fontSize: 30 }}>💊</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--c-text-primary)' }}>{data.item.name}</div>
          {data.item.scientificName && <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginTop: 2, fontStyle: 'italic' }}>{data.item.scientificName}</div>}
        </div>
        {(data.item.dosage || data.item.form) && (
          <div style={{ textAlign: 'right' }}>
            {data.item.dosage && <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-accent)' }}>{data.item.dosage}</div>}
            {data.item.form && <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginTop: 2 }}>{data.item.form}</div>}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div className="section-title" style={{ margin: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>بيانات الإيتم</div>
        <button className="btn btn--secondary" style={{ padding: '4px 10px', fontSize: 11 }} onClick={onEdit}>✏️ تعديل</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: 16 }}>
        {[
          { en: 'Brand Name', ar: 'الاسم التجاري', val: data.item.name },
          { en: 'Generic / Active', ar: 'الاسم العلمي', val: data.item.scientificName || '—' },
          { en: 'Strength / Dosage', ar: 'الجرعة', val: data.item.dosage || '—' },
          { en: 'Dosage Form', ar: 'الشكل الدوائي', val: data.item.form || '—' },
          { en: 'Price', ar: 'السعر', val: data.item.price != null ? fmt(data.item.price) : '—' },
          { en: 'Manufacturer', ar: 'الشركة', val: data.item.company?.name || '—' },
        ].map(f => (
          <div key={f.en} style={{ background: 'var(--c-bg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border-light)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-accent)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {f.en} <span style={{ color: 'var(--c-text-muted)', fontWeight: 400 }}>({f.ar})</span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)', marginTop: 4 }}>{f.val}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="section-title" style={{ margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Scientific Message <span style={{ color: 'var(--c-text-muted)', fontWeight: 400, textTransform: 'none' }}>(الرسالة العلمية المسجّلة)</span>
        </div>
        <div style={{ padding: '10px 14px', background: 'var(--c-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border-light)', fontSize: 13, color: 'var(--c-text-secondary)', lineHeight: 1.75, borderRight: '3px solid var(--c-accent)' }}>
          {data.item.scientificMessage || <span style={{ color: 'var(--c-text-muted)', fontStyle: 'italic' }}>لا توجد رسالة علمية مسجّلة بعد. أضفها من صفحة الايتمات أو استخدم تبويب التحليل الذكي لتوليد ملف كامل.</span>}
        </div>
      </div>

      {sortedSpecs.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>الاختصاصات المستهدفة</div>
          <div className="tag-list">
            {sortedSpecs.map(([spec, cnt]) => (
              <span key={spec} className="tag tag--navy">🩺 {spec} <span style={{ opacity: .7, fontWeight: 400 }}>({cnt})</span></span>
            ))}
          </div>
        </div>
      )}

      {aiInsight ? (
        <div style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ margin: '0 0 8px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            الملف العلمي <span style={{ color: 'var(--c-text-muted)', fontWeight: 400, textTransform: 'none' }}>(مُولَّد بالذكاء الاصطناعي)</span>
          </div>
          {sec1Rows.length === 0 ? <AnalysisRenderer text={aiInsight} onlySecNum={1} /> : (
            <div className="table-wrapper" style={{ marginBottom: 0 }}>
              <table className="data-table">
                <tbody>
                  {sec1Rows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 700, color: 'var(--c-accent)', whiteSpace: 'nowrap', width: '30%', verticalAlign: 'top' }}>{r.field}</td>
                      <td>{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sciMsg && (
                <div style={{ padding: '10px 16px', background: 'var(--c-accent-light)', borderTop: '2px solid var(--c-accent)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 16 }}>💬</span>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-accent)', textTransform: 'uppercase', marginBottom: 3 }}>Scientific Message</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text-primary)', fontStyle: 'italic' }}>{sciMsg}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="info-banner" style={{ marginBottom: 16 }}>
          <p style={{ margin: 0 }}>⚡ افتح تبويب <b>تحليل ذكي (AI)</b> وشغّل التحليل لتظهر هنا معلومات الملف العلمي الكاملة.</p>
        </div>
      )}

      {aiInsight && (
        <div style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            الأطباء المستهدفون <span style={{ color: 'var(--c-text-muted)', fontWeight: 400, textTransform: 'none' }}>(مُولَّد بالذكاء الاصطناعي)</span>
          </div>
          <AnalysisRenderer text={aiInsight} onlySecNum={2} />
        </div>
      )}

      {/* Competitors comparison — same dosage */}
      <div style={{ marginBottom: 16 }}>
        {marketLoading ? (
          <div style={{ padding: '10px 14px', background: 'var(--c-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border-light)', fontSize: 12, color: 'var(--c-text-secondary)' }}>⏳ جاري تحميل بيانات المنافسين...</div>
        ) : marketPrices.length === 0 ? (
          <div style={{ padding: '10px 14px', background: 'var(--c-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border-light)', fontSize: 12, color: 'var(--c-text-muted)' }}>
            🏆 لا توجد بيانات منافسين — أضف أسعار هذا الدواء من تبويب <b>أسعار السوق</b>
          </div>
        ) : (
          <>
            <div className="section-title" style={{ margin: '0 0 10px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--c-danger)' }}>
              🏆 مقارنة المنافسين — نفس الجرعة <span style={{ color: 'var(--c-text-muted)', fontWeight: 400, textTransform: 'none' }}>({sameDoseCompetitors.length} منافس)</span>
            </div>

            {ownEntry && (
              <div style={{ marginBottom: 10, background: 'var(--c-success-bg)', border: '2px solid var(--c-success)', borderRadius: 'var(--radius-md)', padding: '10px 14px', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ minWidth: 140 }}>
                  <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--c-success)' }}>✅ {ownEntry.brandName}</div>
                  {ownEntry.company && <div style={{ fontSize: 11, color: 'var(--c-text-secondary)', marginTop: 1 }}>{ownEntry.company}</div>}
                  {ownEntry.packaging && <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{ownEntry.packaging}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    { label: 'مذخر←صيدلية', val: ownEntry.priceWholesalerToPharmacy, color: '#d97706' },
                    { label: 'صيدلية←مريض', val: ownEntry.pricePharmacyToPatient, color: 'var(--c-danger)' },
                  ].map(p => p.val != null && (
                    <div key={p.label} style={{ background: 'var(--c-surface)', borderRadius: 'var(--radius-sm)', padding: '5px 10px', border: `1.5px solid ${p.color}30`, textAlign: 'center' }}>
                      <div style={{ fontSize: 9, color: 'var(--c-text-muted)', fontWeight: 600 }}>{p.label}</div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: p.color }}>{Number(p.val).toFixed(3)}</div>
                    </div>
                  ))}
                  {ownPPU != null && (
                    <div style={{ background: 'var(--c-surface)', borderRadius: 'var(--radius-sm)', padding: '5px 10px', border: '1.5px solid #6366f130', textAlign: 'center' }}>
                      <div style={{ fontSize: 9, color: 'var(--c-text-muted)', fontWeight: 600 }}>سعر الوحدة ({ownQty} حبة)</div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: '#6366f1' }}>{ownPPU.toFixed(2)}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {sameDoseCompetitors.length > 0 ? (
              <div className="table-wrapper" style={{ marginBottom: 0 }}>
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>{['الاسم التجاري', 'الشركة', 'التعبئة', 'مذخر←صيدلية', 'صيدلية←مريض', 'سعر الوحدة', 'مقارنة بإيتمنا (للوحدة)'].map(h => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {sameDoseCompetitors.map((entry) => {
                      const cPrice = entry.pricePharmacyToPatient ?? null;
                      const cQty = extractQty(entry.packaging);
                      const cPPU = cPrice != null ? cPrice / cQty : null;
                      let cmpLabel = '—'; let cmpColor = 'var(--c-text-muted)';
                      if (ownPPU != null && cPPU != null) {
                        const diff = ((cPPU - ownPPU) / ownPPU * 100);
                        if (diff > 1) { cmpLabel = `أغلى بـ ${diff.toFixed(1)}% للوحدة ✅`; cmpColor = 'var(--c-success)'; }
                        else if (diff < -1) { cmpLabel = `أرخص بـ ${Math.abs(diff).toFixed(1)}% للوحدة ⚠️`; cmpColor = 'var(--c-danger)'; }
                        else { cmpLabel = 'نفس السعر تقريباً'; cmpColor = '#d97706'; }
                      }
                      return (
                        <tr key={entry.id}>
                          <td style={{ fontWeight: 700 }}>{entry.brandName}</td>
                          <td style={{ fontWeight: 600 }}>{entry.company || '—'}</td>
                          <td style={{ fontSize: 11 }}>{entry.packaging || '—'}</td>
                          <td style={{ color: '#d97706', fontWeight: 700 }}>{entry.priceWholesalerToPharmacy != null ? Number(entry.priceWholesalerToPharmacy).toFixed(3) : '—'}</td>
                          <td style={{ color: 'var(--c-danger)', fontWeight: 700 }}>{cPrice != null ? Number(cPrice).toFixed(3) : '—'}</td>
                          <td style={{ color: '#6366f1', fontWeight: 700 }}>{cPPU != null ? cPPU.toFixed(2) : '—'}</td>
                          <td style={{ fontSize: 11, fontWeight: 600, color: cmpColor }}>{cmpLabel}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: '10px 14px', background: 'var(--c-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border-light)', fontSize: 12, color: 'var(--c-text-muted)' }}>
                لا توجد منافسون بنفس الجرعة في السيرفي
              </div>
            )}
          </>
        )}
      </div>

      {aiInsight ? (
        <div>
          <div className="section-title" style={{ margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--c-danger)' }}>
            🏆 تحليل المنافسة التفصيلي <span style={{ color: 'var(--c-text-muted)', fontWeight: 400, textTransform: 'none' }}>(فئات علاجية — مُولَّد بالذكاء الاصطناعي)</span>
          </div>
          <AnalysisRenderer text={aiInsight} onlySecNum={3} />
        </div>
      ) : (
        <div className="info-banner" style={{ background: '#fff7ed', color: '#9a3412', borderColor: '#fed7aa' }}>
          <p style={{ margin: 0 }}>🏆 افتح تبويب <b>تحليل ذكي (AI)</b> وشغّل التحليل لتظهر هنا مقارنة المنافسين التفصيلية (Class Competitors).</p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════ Market prices tab ═══════════════════════════
function MarketTab({ marketResult, marketPrices, marketLoading, isManagerOrAdmin, surveyAnalyzing, surveyAnalyzeMsg, onAnalyze }: {
  marketResult: MarketPricesResult | null; marketPrices: MarketPriceEntry[]; marketLoading: boolean;
  isManagerOrAdmin: boolean; surveyAnalyzing: boolean; surveyAnalyzeMsg: string | null; onAnalyze: () => void;
}) {
  const COLS = ['الاسم التجاري', 'الاسم العلمي', 'الشكل', 'التعبئة', 'الشركة', 'مذخر←صيدلية', 'صيدلية←مريض', 'المصدر'];
  return (
    <div className="card">
      <div style={{ background: 'var(--c-primary)', borderRadius: 'var(--radius-md)', padding: '14px 18px', marginBottom: 16, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 2 }}>💰 أسعار السوق والمنافسون</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            بيانات مُستخرجة من سيرفيات أسعار الأدوية
            {marketResult?.matchMode === 'ai' && <span style={{ marginRight: 8, background: 'rgba(255,255,255,0.2)', borderRadius: 4, padding: '1px 6px', fontSize: 10 }}>🤖 بحث ذكي بالاسم العلمي</span>}
            {marketResult?.matchMode === 'fuzzy' && <span style={{ marginRight: 8, background: 'rgba(255,255,255,0.15)', borderRadius: 4, padding: '1px 6px', fontSize: 10 }}>🔍 بحث نصي ذكي</span>}
          </div>
          {marketResult?.searchedActive && (
            <div style={{ fontSize: 11, opacity: 0.8, marginTop: 3 }}>🧪 يتم البحث عن المنافسين بالمكوّن الفعّال: <strong>{marketResult.searchedActive}</strong></div>
          )}
        </div>
        {isManagerOrAdmin && (
          <button disabled={surveyAnalyzing || !marketResult?.surveyCount} onClick={onAnalyze} style={{
            padding: '7px 14px', borderRadius: 8, border: '1.5px solid rgba(255,255,255,0.5)',
            background: surveyAnalyzing ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.2)',
            color: '#fff', fontSize: 12, cursor: surveyAnalyzing ? 'not-allowed' : 'pointer', fontWeight: 700, whiteSpace: 'nowrap',
          }}>
            {surveyAnalyzing ? '⏳ جاري التحليل...' : '🤖 تحليل السيرفي بالذكاء الاصطناعي'}
          </button>
        )}
      </div>

      {surveyAnalyzeMsg && (
        <div className={surveyAnalyzeMsg.startsWith('⚠️') ? 'alert alert--error' : 'info-banner'} style={surveyAnalyzeMsg.startsWith('⚠️') ? { background: '#fffbeb', color: '#92400e', borderColor: '#fde68a', marginBottom: 12 } : { marginBottom: 12 }}>
          <p style={{ margin: 0 }}>{surveyAnalyzeMsg}</p>
        </div>
      )}

      {marketResult?.matchMode === 'ai' && marketPrices.length > 0 && (() => {
        const own = marketPrices.find(e => e.isOwnProduct);
        return own ? (
          <div className="info-banner" style={{ marginBottom: 12 }}>
            <p style={{ margin: 0 }}>
              🤖 <b>تطابق ذكي:</b> تم التعرف على <b>{own.brandName}</b> —
              {own.activeIngredient && <span> المادة الفعالة: <b>{own.activeIngredient}</b></span>}
              {own.drugClass && <span> • الصنف: <b>{own.drugClass}</b></span>}
              <span> • {marketPrices.length - 1} منافس</span>
            </p>
          </div>
        ) : null;
      })()}

      {marketLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--c-text-muted)', fontSize: 14 }}>⏳ جاري التحميل...</div>
      ) : marketPrices.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, background: 'var(--c-bg)', borderRadius: 'var(--radius-md)', border: '1.5px dashed var(--c-border)', color: 'var(--c-text-muted)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>💊</div>
          <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--c-text-primary)' }}>لا توجد بيانات أسعار حتى الآن</div>
          <div style={{ fontSize: 12, marginBottom: 12 }}>
            {marketResult?.surveyCount ? 'السيرفي موجود لكن الإيتم لم يُطابَق — جرّب تشغيل التحليل الذكي' : 'يمكن للمدير إضافة أسعار هذا الدواء من صفحة السيرفيات'}
          </div>
          {isManagerOrAdmin && marketResult?.matchMode === 'fuzzy' && (
            <div style={{ fontSize: 12, color: 'var(--c-accent)' }}>💡 شغّل <b>تحليل السيرفي بالذكاء الاصطناعي</b> أعلاه للحصول على تطابق أدق بناءً على المادة الفعالة</div>
          )}
        </div>
      ) : (
        <>
          {marketResult?.matchMode === 'ai' && (() => {
            const own = marketPrices.find(e => e.isOwnProduct);
            const competitors = marketPrices.filter(e => !e.isOwnProduct);
            return (
              <>
                {own && (
                  <div style={{ marginBottom: 16, background: 'var(--c-success-bg)', border: '2px solid var(--c-success)', borderRadius: 'var(--radius-md)', padding: '12px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-success)', textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.05em' }}>✅ منتجنا</div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--c-success)' }}>{own.brandName}</div>
                        {own.scientificName && <div style={{ fontSize: 11, color: 'var(--c-text-secondary)', marginTop: 1 }}>{own.scientificName}</div>}
                        {own.company && <div style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{own.company}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        {[
                          { label: 'مذخر←صيدلية', val: own.priceWholesalerToPharmacy, color: '#d97706' },
                          { label: 'صيدلية←مريض', val: own.pricePharmacyToPatient, color: 'var(--c-danger)' },
                        ].map(p => p.val != null && (
                          <div key={p.label} style={{ background: 'var(--c-surface)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', border: `1.5px solid ${p.color}20`, textAlign: 'center' }}>
                            <div style={{ fontSize: 9, color: 'var(--c-text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>{p.label}</div>
                            <div style={{ fontSize: 15, fontWeight: 800, color: p.color }}>{Number(p.val).toFixed(3)}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ marginRight: 'auto', fontSize: 10, color: 'var(--c-text-muted)' }}>{own.surveyName}</div>
                    </div>
                  </div>
                )}

                {competitors.length > 0 && (
                  <>
                    <div className="section-title" style={{ margin: '0 0 8px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      🏁 المنافسون ({competitors.length}) — نفس المادة الفعالة والجرعة
                    </div>
                    <div className="table-wrapper" style={{ marginBottom: 0 }}>
                      <table className="data-table" style={{ fontSize: 12 }}>
                        <thead><tr>{COLS.map(h => <th key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {competitors.map(entry => (
                            <tr key={entry.id}>
                              <td style={{ fontWeight: 700 }}>{entry.brandName}</td>
                              <td style={{ fontSize: 11 }}>{entry.scientificName || '—'}</td>
                              <td>{entry.dosageForm || '—'}</td>
                              <td>{entry.packaging || '—'}</td>
                              <td style={{ fontWeight: 600 }}>{entry.company || '—'}</td>
                              <td style={{ color: '#d97706', fontWeight: 700 }}>{entry.priceWholesalerToPharmacy != null ? Number(entry.priceWholesalerToPharmacy).toFixed(3) : '—'}</td>
                              <td style={{ color: 'var(--c-danger)', fontWeight: 700 }}>{entry.pricePharmacyToPatient != null ? Number(entry.pricePharmacyToPatient).toFixed(3) : '—'}</td>
                              <td style={{ fontSize: 10, color: 'var(--c-text-muted)' }}>{entry.surveyName}</td>
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

          {(marketResult?.matchMode === 'fuzzy' || !marketResult?.matchMode) && (
            <div className="table-wrapper" style={{ marginBottom: 0 }}>
              <table className="data-table" style={{ fontSize: 13 }}>
                <thead><tr>{COLS.map(h => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {marketPrices.map(entry => (
                    <tr key={entry.id}>
                      <td style={{ fontWeight: 700 }}>{entry.brandName}</td>
                      <td style={{ fontSize: 11 }}>{entry.scientificName || '—'}</td>
                      <td>{entry.dosageForm || '—'}</td>
                      <td>{entry.packaging || '—'}</td>
                      <td style={{ fontWeight: 600 }}>{entry.company || '—'}</td>
                      <td style={{ color: '#d97706', fontWeight: 700 }}>{entry.priceWholesalerToPharmacy != null ? Number(entry.priceWholesalerToPharmacy).toFixed(3) : '—'}</td>
                      <td style={{ color: 'var(--c-danger)', fontWeight: 700 }}>{entry.pricePharmacyToPatient != null ? Number(entry.pricePharmacyToPatient).toFixed(3) : '—'}</td>
                      <td style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{entry.surveyName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--c-text-muted)', textAlign: 'left' }}>
            {marketPrices.length} نتيجة — {marketResult?.matchMode === 'ai' ? 'تطابق ذكي' : 'تطابق نصي'}
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════ Rep diagnostic card ═══════════════════════════
function RepDiagnosticCard({ d }: { d: RepDiagnostic }) {
  type RuleStatus = 'ok' | 'warn' | 'bad';
  interface Rule {
    id: number; icon: string; title: string; desc: string;
    actual: string; status: RuleStatus; action: string | null;
  }

  const rules: Rule[] = [
    {
      id: 1, icon: '🩺', title: 'عدد الكولات الطبية',
      desc: `زيارات المندوب للأطباء على هذا الإيتم خلال الفترة المحددة. الحد الأدنى المقترح: 5 كولات.`,
      actual: `${d.callCount} كول`,
      status: d.callCount >= 5 ? 'ok' : d.callCount >= 3 ? 'warn' : 'bad',
      action: d.callCount < 5 ? 'زيادة الكولات على هذا الإيتم تحديداً للأطباء المستهدفين.' : null,
    },
    {
      id: 2, icon: '📅', title: 'إدراج الإيتم في البلان الشهري',
      desc: `هل هذا الإيتم مدرج في الخطط الشهرية للمندوب؟ الإيتم خارج البلان = لا أولوية رسمية للمندوب.`,
      actual: d.planCoverage.totalPlans === 0
        ? 'لا توجد خطط شهرية'
        : d.planCoverage.totalEntries === 0
          ? `${d.planCoverage.plansWithItem} من ${d.planCoverage.totalPlans} بلان — لا توجد إدخالات`
          : `${d.planCoverage.entriesWithItem} من ${d.planCoverage.totalEntries} طبيب في البلان يملك هذا الإيتم (${d.planCoverage.entryItemPct}%)`,
      status: d.planCoverage.totalPlans === 0 ? 'warn'
        : d.planCoverage.entryItemPct >= 60 ? 'ok'
        : d.planCoverage.entryItemPct > 0 ? 'warn' : 'bad',
      action: d.planCoverage.totalPlans > 0 && d.planCoverage.entriesWithItem === 0
        ? 'إدراج الإيتم كهدف لكل طبيب في البلان الشهري للمندوب.' : null,
    },
    {
      id: 3, icon: '🔁', title: 'متابعة الأطباء بزيارة ثانية',
      desc: `نسبة الأطباء الذين زاروا مرة واحدة فقط مقارنة بالمتابعين. الزيارة الواحدة لا تكفي لصنع القرار.`,
      actual: `${d.singleVisitDoctors} زيارة وحيدة / ${d.repeatedVisitDoctors} مكررة (متوسط: ${d.avgVisitsPerDoctor} زيارة/طبيب)`,
      status: d.doctorsVisited === 0 ? 'bad'
        : d.singleVisitDoctors <= d.repeatedVisitDoctors ? 'ok'
        : d.singleVisitDoctors <= d.repeatedVisitDoctors * 2 ? 'warn' : 'bad',
      action: d.singleVisitDoctors > d.repeatedVisitDoctors * 2
        ? 'جدولة زيارة ثانية لكل طبيب تمت زيارته مرة واحدة خلال أسبوعين.' : null,
    },
    {
      id: 4, icon: '💬', title: 'الفيدباك الإيجابي مقابل المبيع',
      desc: `فيدباك إيجابي (يكتب/مهتم/كومبتيتر) مع مبيع منخفض يعني مشكلة في الإغلاق أو توفر الإيتم في الصيدلية.`,
      actual: `إيجابي: ${d.positiveFeedback} | سلبي: ${d.negativeFeedback} | صافي المبيع: ${fmt(d.netValue)} د.ع`,
      status: d.positiveFeedback >= 3 && d.netValue < 50000 ? 'bad'
        : d.positiveFeedback >= 3 && d.netValue < 300000 ? 'warn' : 'ok',
      action: d.positiveFeedback >= 3 && d.netValue < 50000
        ? 'مراجعة توفر الإيتم في الصيدليات القريبة من الأطباء ذوي الفيدباك الإيجابي.' : null,
    },
    {
      id: 5, icon: '📦', title: 'العلاقة بين الكولات والمبيعات',
      desc: `مبيع بدون كولات = اعتماد على الصيدلي فقط. كولات بدون مبيع = ضعف تحويل أو مشكلة في رسالة الإيتم.`,
      actual: d.callCount === 0 && d.salesValue > 0
        ? `مبيع ${fmt(d.salesQty)} وحدة بدون أي كولات`
        : d.callCount > 0 && d.salesValue === 0
          ? `${d.callCount} كول بدون أي مبيعات لهذا الإيتم`
          : `كولات: ${d.callCount} | مبيع: ${fmt(d.salesQty)} وحدة`,
      status: d.salesValue > 0 && d.callCount === 0 ? 'bad'
        : d.salesValue > 0 && d.callCount < 3 ? 'warn'
        : d.salesValue === 0 && d.callCount > 0 ? 'warn'
        : 'ok',
      action: d.salesValue > 0 && d.callCount === 0
        ? 'تدريب المندوب على المحادثة العلمية مع الطبيب وربط المبيع بالكول المباشر.'
        : d.salesValue === 0 && d.callCount > 0
          ? 'مراجعة أسلوب الكول العلمي وتحسين رسالة الإيتم — يوجد زيارات لكن بدون تحويل إلى مبيع.'
          : null,
    },
    {
      id: 6, icon: '⚖️', title: 'التوازن بين زيارات الأطباء والصيدليات',
      desc: `نسبة كولات الأطباء ÷ زيارات الصيدليات. إذا كانت أقل من 0.3 فالمندوب يركز على الصيدليات أكثر من الأطباء.`,
      actual: d.pharmacyVisitsCount === 0
        ? `${d.callCount} كول طبي / لا توجد زيارات صيدليات`
        : `نسبة: ${d.doctorPharmacyRatio.toFixed(2)} (${d.callCount} طبيب / ${d.pharmacyVisitsCount} صيدلية)`,
      status: d.pharmacyVisitsCount === 0 && d.callCount === 0 ? 'ok'
        : d.pharmacyVisitsCount === 0 && d.callCount > 0 ? 'warn'
        : d.doctorPharmacyRatio >= 0.3 ? 'ok'
        : d.doctorPharmacyRatio >= 0.15 ? 'warn' : 'bad',
      action: d.pharmacyVisitsCount === 0 && d.callCount > 0
        ? 'لا توجد زيارات صيدليات — يُنصح بتوزيع الجهد بين الأطباء والصيدليات للحصول على مبيعات أفضل.'
        : d.pharmacyVisitsCount > 0 && d.doctorPharmacyRatio < 0.3
        ? 'إعادة توازن الجدول الأسبوعي: زيادة كولات الأطباء وتقليل التركيز على الصيدليات.' : null,
    },
    {
      id: 7, icon: '📊', title: 'زيارات بدون مبيع',
      desc: `عدد الأشهر التي فيها زيارات للأطباء لكن لا يوجد أي مبيع — دليل على ضعف الإغلاق أو مشكلة في الرسالة العلمية.`,
      actual: `${d.visitsNoSales} شهر زيارات بلا مبيع | ${d.salesNoVisits} شهر مبيع بلا زيارات`,
      status: d.visitsNoSales === 0 ? 'ok' : d.visitsNoSales === 1 ? 'warn' : 'bad',
      action: d.visitsNoSales >= 2
        ? 'مراجعة الرسالة العلمية المستخدمة وأسلوب الـ Closing مع الطبيب.' : null,
    },
  ];

  const badCount  = rules.filter(r => r.status === 'bad').length;
  const warnCount = rules.filter(r => r.status === 'warn').length;
  const okCount   = rules.filter(r => r.status === 'ok').length;
  const healthScore = Math.round((okCount * 100 + warnCount * 50) / rules.length);
  const healthColor = healthScore >= 70 ? 'var(--c-success)' : healthScore >= 40 ? '#d97706' : 'var(--c-danger)';
  const healthLabel = healthScore >= 70 ? 'أداء جيد' : healthScore >= 40 ? 'يحتاج تحسين' : 'يحتاج تدخل عاجل';

  const statusStyle = (s: RuleStatus) => ({
    ok:   { bg: 'var(--c-success-bg)', border: '#bbf7d0', dot: 'var(--c-success)', label: '✅ جيد' },
    warn: { bg: 'var(--c-warning-bg)', border: '#fde68a', dot: '#d97706', label: '⚠️ تحذير' },
    bad:  { bg: 'var(--c-danger-bg)', border: '#fecaca', dot: 'var(--c-danger)', label: '❌ مشكلة' },
  }[s]);

  const actions = rules.filter(r => r.action).map(r => ({ id: r.id, icon: r.icon, title: r.title, action: r.action! }));

  return (
    <div style={{ borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 16, border: '1px solid var(--c-border-light)', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ background: 'var(--c-primary)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ color: '#93c5fd', fontSize: 11, fontWeight: 600, marginBottom: 2 }}>مؤشرات تشخيص أداء المندوب على هذا الإيتم</div>
          <div style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>👤 {d.repName}</div>
          {d.repAreaIds.length > 0 && (
            <div style={{ color: '#a5b4fc', fontSize: 11, marginTop: 2 }}>🗺️ {d.repAreaIds.length} منطقة مخصصة • البيانات مفلترة بمناطقه</div>
          )}
        </div>
        <div style={{ textAlign: 'center', background: 'rgba(255,255,255,0.1)', borderRadius: 10, padding: '8px 16px' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: healthScore >= 70 ? '#6ee7b7' : healthScore >= 40 ? '#fde68a' : '#fca5a5' }}>{healthScore}%</div>
          <div style={{ fontSize: 11, color: '#e2e8f0', fontWeight: 600 }}>{healthLabel}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, justifyContent: 'center' }}>
            {okCount > 0   && <span style={{ background: 'var(--c-success)', color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{okCount} ✅</span>}
            {warnCount > 0 && <span style={{ background: '#d97706', color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{warnCount} ⚠️</span>}
            {badCount > 0  && <span style={{ background: 'var(--c-danger)', color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{badCount} ❌</span>}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 0, borderBottom: '1px solid var(--c-border-light)', background: 'var(--c-bg)' }}>
        {([
          { label: 'عدد الكولات', val: d.callCount, icon: '🩺', color: d.callCount >= 5 ? 'var(--c-success)' : 'var(--c-danger)' },
          { label: 'أطباء مزارون', val: d.doctorsVisited, icon: '👨‍⚕️', color: 'var(--c-accent)' },
          { label: 'زيارات صيدليات', val: d.pharmacyVisitsCount, icon: '🏪', color: '#0891b2' },
          { label: 'فيدباك إيجابي', val: d.positiveFeedback, icon: '👍', color: 'var(--c-success)' },
          { label: 'فيدباك سلبي', val: d.negativeFeedback, icon: '👎', color: d.negativeFeedback > 2 ? 'var(--c-danger)' : 'var(--c-text-secondary)' },
          { label: 'تغطية البلان', val: d.planCoverage.totalEntries > 0 ? `${d.planCoverage.entriesWithItem}/${d.planCoverage.totalEntries} (${d.planCoverage.entryItemPct}%)` : `${d.planCoverage.coveragePct}%`, icon: '📅', color: d.planCoverage.entryItemPct > 0 ? 'var(--c-success)' : 'var(--c-text-secondary)' },
          { label: 'صافي المبيع', val: `${fmt(d.netValue)}`, icon: '💰', color: d.netValue > 0 ? 'var(--c-success)' : 'var(--c-danger)' },
        ] as { label: string; val: string | number; icon: string; color: string }[]).map((m, i) => (
          <div key={i} style={{ padding: '10px 12px', borderLeft: '1px solid var(--c-border-light)', textAlign: 'center' }}>
            <div style={{ fontSize: 18 }}>{m.icon}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: m.color, lineHeight: 1.2 }}>{m.val}</div>
            <div style={{ fontSize: 10, color: 'var(--c-text-secondary)', marginTop: 2 }}>{m.label}</div>
          </div>
        ))}
      </div>

      <div style={{ background: 'var(--c-surface)' }}>
        <div style={{ padding: '10px 16px', background: 'var(--c-bg)', borderBottom: '1px solid var(--c-border-light)', fontSize: 12, fontWeight: 700, color: 'var(--c-accent)' }}>
          🔍 التشخيص التفصيلي — 7 قواعد تقييم
        </div>
        {rules.map((rule, idx) => {
          const st = statusStyle(rule.status);
          return (
            <div key={rule.id} style={{
              padding: '12px 16px', borderBottom: idx < rules.length - 1 ? '1px solid var(--c-border-light)' : 'none',
              background: rule.status === 'bad' ? '#fff8f8' : rule.status === 'warn' ? '#fffdf5' : 'var(--c-surface)',
              display: 'grid', gridTemplateColumns: '28px 1fr auto', gap: '8px 12px', alignItems: 'start',
            }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: st.bg, border: `1.5px solid ${st.border}`, fontSize: 13, fontWeight: 700, color: st.dot, flexShrink: 0 }}>{rule.id}</div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                  <span style={{ fontSize: 14 }}>{rule.icon}</span>
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--c-text-primary)' }}>{rule.title}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--c-text-secondary)', lineHeight: 1.6, marginBottom: 4 }}>{rule.desc}</div>
                <div style={{ display: 'inline-block', fontSize: 12, fontWeight: 700, color: st.dot, background: st.bg, border: `1px solid ${st.border}`, borderRadius: 5, padding: '2px 8px' }}>📊 {rule.actual}</div>
                {rule.action && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#0369a1', background: 'var(--c-accent-light)', borderRadius: 5, padding: '5px 10px', borderRight: '3px solid var(--c-accent)', lineHeight: 1.5 }}>
                    ➡️ <b>الإجراء المقترح:</b> {rule.action}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: st.dot, background: st.bg, border: `1px solid ${st.border}`, borderRadius: 6, padding: '3px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}>{st.label}</div>
            </div>
          );
        })}
      </div>

      {actions.length > 0 ? (
        <div style={{ background: 'var(--c-accent-light)', borderTop: '2px solid var(--c-accent)', padding: '12px 16px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-accent)', marginBottom: 10 }}>🎯 خطة العمل المقترحة ({actions.length} إجراء)</div>
          <ol style={{ margin: 0, padding: '0 20px', fontSize: 12, color: 'var(--c-text-primary)', lineHeight: 2 }}>
            {actions.map((a, i) => <li key={i}><b>{a.icon} {a.title}:</b> {a.action}</li>)}
          </ol>
        </div>
      ) : (
        <div style={{ background: 'var(--c-success-bg)', borderTop: '2px solid #bbf7d0', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 22 }}>🎉</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-success)' }}>أداء المندوب ممتاز على هذا الإيتم</div>
            <div style={{ fontSize: 11, color: 'var(--c-success)' }}>كل المؤشرات ضمن الحد الأدنى المقبول — استمر في المتابعة.</div>
          </div>
        </div>
      )}
    </div>
  );
}
