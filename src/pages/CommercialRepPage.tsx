import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import * as XLSX from 'xlsx';

// ── Types ──────────────────────────────────────────────────────
interface Invoice {
  id: number;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  maxCollectionDate: string | null;
  deferredDays: number | null;
  paymentType: 'cash' | 'deferred';
  pharmacyName: string;
  areaName: string | null;
  status: 'pending' | 'partial' | 'collected';
  totalAmount: number;
  collectedAmount: number;
  returnedAmount: number;
  notes: string | null;
  assignedRep?: { id: number; username: string; displayName: string | null };
  items: InvItem[];
  collections: CollectionRecord[];
}
interface InvItem {
  id: number;
  brandName: string;
  scientificName: string | null;
  dosage: string | null;
  form: string | null;
  unitPrice: number;
  quantity: number;
  bonusQty: number;
  totalPrice: number;
}
interface CollectionRecord {
  id: number;
  amount: number;
  discount: number;
  finalAmount: number;
  returnedAmount?: number;
  returnedItemsJson?: string | null;
  isFullCollection: boolean;
  notes: string | null;
  receiptNumber: string;
  collectedAt: string;
  collectedBy?: { username: string; displayName: string | null };
}
interface StatsData {
  counts: { total: number; pending: number; partial: number; collected: number; overdue: number };
  amounts: { total: number; collected: number; remaining: number };
  recentCollections: any[];
  repsSummary: RepSummary[];
}
interface RepSummary {
  id: number; name: string;
  total: number; pending: number; partial: number; collected: number;
  totalAmount: number; collectedAmount: number;
}
interface Pharmacy {
  id: number; name: string; ownerName: string | null; phone: string | null;
  address: string | null; areaName: string | null; isActive: boolean;
}
interface CommercialRep {
  id: number; username: string; displayName: string | null; role: string;
}
interface Notif {
  id: number; type: string; title: string; body: string;
  isRead: boolean; data: string | null; createdAt: string;
}

type TabId = 'home' | 'invoices' | 'visits' | 'team' | 'upload' | 'pharmacies' | 'notifs';

// ── Helpers ────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('ar-IQ');
const fmtDate = (d: string | null) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ar-IQ', { year: 'numeric', month: 'numeric', day: 'numeric' });
};
const daysDiff = (d: string | null) => {
  if (!d) return null;
  return Math.ceil((new Date(d).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
};

// ── STATUS META ────────────────────────────────────────────────
const STATUS_META = {
  pending:   { label: 'معلق',    bg: '#EBE8F5', color: '#7B6F9C', icon: '⏳' },
  partial:   { label: 'جزئي',    bg: '#FFF8E7', color: '#B45309', icon: '🔄' },
  collected: { label: 'مكتمل',   bg: '#E8F5E9', color: '#2E7D32', icon: '✅' },
  overdue:   { label: 'متأخر',   bg: '#FCEAEA', color: '#8B1C1C', icon: '⚠️' },
};

const getInvStatus = (inv: Invoice) => {
  if (inv.status === 'collected') return 'collected';
  if (inv.maxCollectionDate && new Date(inv.maxCollectionDate) < new Date()) return 'overdue';
  return inv.status;
};

// ── RECEIPT COMPONENT ─────────────────────────────────────────
function ReceiptPrint({ inv, record }: { inv: Invoice; record: CollectionRecord }) {
  return (
    <div className="comm-receipt-print" style={{ display: 'none' }}>
      <div className="comm-receipt-content" id="comm-receipt">
        <div style={{ textAlign: 'center', borderBottom: '2px solid #000', paddingBottom: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>وصل استحصال</div>
          <div style={{ fontSize: 12, color: '#666' }}>رقم الوصل: {record.receiptNumber}</div>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 8 }}>
          <tbody>
            <tr><td style={{ fontWeight: 700, width: 130 }}>الصيدلية:</td><td>{inv.pharmacyName}</td></tr>
            <tr><td style={{ fontWeight: 700 }}>رقم الفاتورة:</td><td>{inv.invoiceNumber}</td></tr>
            <tr><td style={{ fontWeight: 700 }}>تاريخ الاستحصال:</td><td>{fmtDate(record.collectedAt)}</td></tr>
            <tr><td style={{ fontWeight: 700 }}>المبلغ المستحصل:</td><td style={{ color: '#15803d', fontWeight: 900 }}>{fmt(record.finalAmount)} د.ع</td></tr>
            {record.discount > 0 && <tr><td style={{ fontWeight: 700 }}>الحسم:</td><td>{fmt(record.discount)} د.ع</td></tr>}
            <tr><td style={{ fontWeight: 700 }}>نوع الاستحصال:</td><td>{record.isFullCollection ? 'استحصال كامل ✅' : 'استحصال جزئي 🔄'}</td></tr>
            {record.notes && <tr><td style={{ fontWeight: 700 }}>ملاحظات:</td><td>{record.notes}</td></tr>}
          </tbody>
        </table>
        <div style={{ borderTop: '1px dashed #000', paddingTop: 8, fontSize: 11, color: '#666', textAlign: 'center' }}>
          باقي المبلغ: {fmt(Math.max(0, inv.totalAmount - inv.collectedAmount - record.finalAmount))} د.ع
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
export default function CommercialRepPage() {
  const { token, user: authUser } = useAuth();
  const role = authUser?.role ?? '';

  const isRep       = role === 'commercial_rep';
  const isLead      = role === 'commercial_team_leader' || role === 'commercial_supervisor';
  const isMgr       = ['admin', 'manager', 'office_manager', 'company_manager'].includes(role);
  const canUpload   = isMgr;
  const canCollect  = isRep || isMgr;

  const H = useCallback(
    () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    [token],
  );

  // ── Feature flags (easy to toggle) ────────────────────────────
  const ENABLE_REP_UPLOAD = true; // ← اجعله false لإخفاء رفع الفواتير من المندوبين

  // ── Tabs ─────────────────────────────────────────────────────
  const tabs: { id: TabId; label: string; icon: string }[] = isRep
    ? [
        { id: 'home',     label: 'الاستحصال',  icon: '🏠' },
        { id: 'invoices', label: 'فواتيري',    icon: '📄' },
      ]
    : isLead
    ? [
        { id: 'team',     label: 'لوحة الفريق',  icon: '📊' },
        { id: 'invoices', label: 'فواتير الفريق', icon: '📋' },
        { id: 'notifs',   label: 'النشاط',       icon: '🔔' },
      ]
    : [
        { id: 'home',       label: 'لوحة المتابعة',  icon: '📊' },
        { id: 'invoices',   label: 'كل الفواتير',   icon: '📋' },
        { id: 'upload',     label: 'رفع فواتير',    icon: '📤' },
        { id: 'pharmacies', label: 'الصيدليات',     icon: '🏥' },
        { id: 'notifs',     label: 'الإشعارات',     icon: '🔔' },
      ];

  const defaultTab = tabs[0].id;
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const key = `comm-tab-${authUser?.id ?? 'x'}`;
    const saved = localStorage.getItem(key) as TabId | null;
    return saved && tabs.some(t => t.id === saved) ? saved : defaultTab;
  });

  // ── State ─────────────────────────────────────────────────────
  const [stats, setStats]                   = useState<StatsData | null>(null);
  const [invoices, setInvoices]             = useState<Invoice[]>([]);
  const [totalInvoices, setTotalInvoices]   = useState(0);
  const [pharmacies, setPharmacies]         = useState<Pharmacy[]>([]);
  const [reps, setReps]                     = useState<CommercialRep[]>([]);
  const [notifs, setNotifs]                 = useState<Notif[]>([]);
  const [unreadCount, setUnreadCount]       = useState(0);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [toast, setToast]                   = useState<string | null>(null);

  // ── Filters ───────────────────────────────────────────────────
  const [filterStatus, setFilterStatus]     = useState('open');
  const [filterPharmacy, setFilterPharmacy] = useState('');
  const [filterRep, setFilterRep]           = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo]     = useState('');

  // Refs always hold the latest filter values — used by fetchInvoices to avoid stale closures
  const filterStatusRef   = useRef('open');
  const filterPharmacyRef = useRef('');
  const filterRepRef      = useRef('');
  const filterDateFromRef = useRef('');
  const filterDateToRef   = useRef('');
  // Keep refs in sync on every render
  filterStatusRef.current   = filterStatus;
  filterPharmacyRef.current = filterPharmacy;
  filterRepRef.current      = filterRep;
  filterDateFromRef.current = filterDateFrom;
  filterDateToRef.current   = filterDateTo;
  const [selectedInv, setSelectedInv]       = useState<Invoice | null>(null);
  const [invLoading, setInvLoading]         = useState(false);

  // ── Collect modal ─────────────────────────────────────────────
  const [collectModal, setCollectModal]     = useState(false);
  const [collectAmt, setCollectAmt]         = useState('');
  const [collectDiscount, setCollectDiscount] = useState('0');
  const [collectFull, setCollectFull]       = useState(false);
  const [collectNotes, setCollectNotes]     = useState('');
  const [collectGps, setCollectGps]         = useState<{ lat: number; lng: number } | null>(null);
  const [collectGpsLoading, setCollectGpsLoading] = useState(false);
  const [collectSaving, setCollectSaving]   = useState(false);
  const [lastReceipt, setLastReceipt]       = useState<CollectionRecord | null>(null);
  const [voiceListening, setVoiceListening] = useState(false);
  const [pharmVoiceOverlay, setPharmVoiceOverlay] = useState(false);
  const pharmRecognitionRef = useRef<any>(null);
  const fabHoldTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fabLongFiredRef     = useRef(false);

  // ── Return goods state ────────────────────────────────────────
  const [withReturn, setWithReturn]         = useState(false);
  const [returnQtys, setReturnQtys]         = useState<Record<number, number>>({});  // itemId -> qty

  // ── Search suggestions ─────────────────────────────────────
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [pharmNames, setPharmNames]           = useState<string[]>([]);
  const pharmacySuggestions = filterPharmacy.trim().length > 0
    ? pharmNames.filter(n => n.toLowerCase().includes(filterPharmacy.toLowerCase())).slice(0, 8)
    : [];

  // ── Save active tab to sessionStorage on change ─────────────
  useEffect(() => {
    localStorage.setItem(`comm-tab-${authUser?.id ?? 'x'}`, activeTab);
  }, [activeTab, authUser?.id]);

  // ── Pick-pharmacy modal (إنشاء استحصال) ──────────────────────
  const [pickModal, setPickModal]           = useState(false);
  const [pickQuery, setPickQuery]           = useState('');
  const [pickPharmName, setPickPharmName]   = useState<string | null>(null);
  const [pickPharmInvs, setPickPharmInvs]   = useState<Invoice[]>([]);
  const [pickPharmLoading, setPickPharmLoading] = useState(false);

  // ── View mode (list / grouped by area→pharmacy) ───────────────
  const [viewMode, setViewMode]             = useState<'list' | 'grouped'>('grouped');
  const [expandedAreas, setExpandedAreas]   = useState<Set<string>>(() => new Set());
  const [expandedPharmacies, setExpandedPharmacies] = useState<Set<string>>(() => new Set());

  // ── Create invoice modal ──────────────────────────────────────
  const [createModal, setCreateModal]       = useState(false);
  const [newInv, setNewInv]                 = useState({
    invoiceNumber: '', invoiceDate: '', dueDate: '', maxCollectionDate: '',
    deferredDays: '', paymentType: 'deferred', pharmacyName: '', areaName: '',
    assignedRepId: '', totalAmount: '', notes: '',
  });
  const [newInvItems, setNewInvItems]       = useState<Partial<InvItem>[]>([
    { brandName: '', unitPrice: 0, quantity: 1, bonusQty: 0, totalPrice: 0 },
  ]);
  const [createSaving, setCreateSaving]     = useState(false);

  // ── Pharmacy modal ────────────────────────────────────────────
  const [pharmaModal, setPharmaModal]       = useState(false);
  const [newPharma, setNewPharma]           = useState({ name: '', ownerName: '', phone: '', address: '', areaName: '' });
  const [pharmaSaving, setPharmaSaving]     = useState(false);
  const [showRecentColl, setShowRecentColl] = useState(false);

  // ── Pharmacy search debounce ───────────────────────────────────
  const pharmDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── AbortController for fetchInvoices – cancels prev in-flight request ──
  const fetchAbortRef = useRef<AbortController | null>(null);

  // ── Upload (Excel) ────────────────────────────────────────────
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploadLoading, setUploadLoading]   = useState(false);
  const [uploadResult, setUploadResult]     = useState<any>(null);

  // ── Import method sub-tabs ─────────────────────────────────────
  type ImportTab = 'excel' | 'api' | 'erp';
  const [importTab, setImportTab]           = useState<ImportTab>('excel');

  // ── API key ────────────────────────────────────────────────────
  const [apiKey, setApiKey]                 = useState<string | null>(null);
  const [apiKeyLoading, setApiKeyLoading]   = useState(false);
  const [apiKeyVisible, setApiKeyVisible]   = useState(false);

  // ── Fetch from ERP ─────────────────────────────────────────────
  const [erpUrl, setErpUrl]                 = useState('');
  const [erpMethod, setErpMethod]           = useState<'GET'|'POST'>('GET');
  const [erpHeaders, setErpHeaders]         = useState('');
  const [erpBody, setErpBody]               = useState('');
  const [erpLoading, setErpLoading]         = useState(false);
  const [erpResult, setErpResult]           = useState<any>(null);

  // ──────────────────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  // ── GPS capture ───────────────────────────────────────────────
  const captureGps = () => {
    if (!navigator.geolocation) { showToast('GPS غير متاح'); return; }
    setCollectGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        setCollectGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setCollectGpsLoading(false);
        showToast('✅ تم تسجيل الموقع');
      },
      () => { setCollectGpsLoading(false); showToast('⚠️ تعذر الحصول على الموقع'); },
      { timeout: 10000 },
    );
  };

  // ── Fetch stats ───────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch('/api/commercial/stats', { headers: H() });
      if (!r.ok) return;
      setStats(await r.json());
    } catch {}
  }, [H]);

  // ── Fetch invoices — reads from refs, never stale ────────────
  const fetchInvoices = useCallback(async (overridePharmacy?: string, overrideStatus?: string) => {
    // Cancel any previous in-flight request
    if (fetchAbortRef.current) fetchAbortRef.current.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      const st    = overrideStatus   !== undefined ? overrideStatus   : filterStatusRef.current;
      const pName = overridePharmacy !== undefined ? overridePharmacy : filterPharmacyRef.current;
      if (st)                        params.set('status',       st);
      if (pName)                     params.set('pharmacyName', pName);
      if (filterRepRef.current)      params.set('repId',        filterRepRef.current);
      if (filterDateFromRef.current) params.set('dateFrom',     filterDateFromRef.current);
      if (filterDateToRef.current)   params.set('dateTo',       filterDateToRef.current);
      params.set('take', '500');
      const r = await fetch(`/api/commercial/invoices?${params}`, { headers: H(), signal: controller.signal });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'فشل التحميل');
      setInvoices(d.data);
      setTotalInvoices(d.total);
    } catch (e: any) {
      if ((e as any)?.name === 'AbortError') return; // request was superseded — ignore
      setError(e.message);
    }
    finally { setLoading(false); }
  }, [H]);

  // ── Fetch pharmacy names that have pending/partial invoices only ──
  const fetchPharmNames = useCallback(async () => {
    try {
      const r = await fetch('/api/commercial/invoices?take=2000', { headers: H() });
      if (!r.ok) return;
      const d = await r.json();
      const areaMap: Record<string, string> = {};
      (d.data as Invoice[]).forEach((i: Invoice) => {
        if (i.areaName && !areaMap[i.pharmacyName]) areaMap[i.pharmacyName] = i.areaName;
      });
      const names = [...new Set<string>((d.data as Invoice[]).map((i: Invoice) => i.pharmacyName))].sort();
      setPharmNames(names);
      setPharmAreaMap(areaMap);
    } catch {}
  }, [H]);

  // ── Fetch pharmacies ──────────────────────────────────────────
  const fetchPharmacies = useCallback(async () => {
    try {
      const r = await fetch('/api/commercial/pharmacies', { headers: H() });
      if (r.ok) setPharmacies(await r.json());
    } catch {}
  }, [H]);

  // ── Fetch reps (for manager) ──────────────────────────────────
  const fetchReps = useCallback(async () => {
    if (!isMgr && !isLead) return;
    try {
      const r = await fetch('/api/commercial/reps', { headers: H() });
      if (r.ok) setReps(await r.json());
    } catch {}
  }, [H, isMgr, isLead]);

  // ── Fetch notifications ───────────────────────────────────────
  const fetchNotifs = useCallback(async () => {
    try {
      const r = await fetch('/api/commercial/notifications', { headers: H() });
      if (!r.ok) return;
      const d = await r.json();
      setNotifs(d.data);
      setUnreadCount(d.unreadCount);
    } catch {}
  }, [H]);

  // ── Fetch selected invoice detail ─────────────────────────────
  const fetchInvoiceDetail = useCallback(async (id: number) => {
    setInvLoading(true);
    try {
      const r = await fetch(`/api/commercial/invoices/${id}`, { headers: H() });
      if (!r.ok) return;
      const d: Invoice = await r.json();
      setSelectedInv(d);
    } catch {}
    finally { setInvLoading(false); }
  }, [H]);

  // ── Initial load ──────────────────────────────────────────────
  useEffect(() => {
    fetchStats();
    fetchNotifs();
    fetchInvoices();
    fetchPharmNames();
    fetchPharmacies();
    if (isMgr || isLead) { fetchReps(); }
  }, [fetchStats, fetchNotifs, fetchReps, fetchPharmacies, isMgr, isLead]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail as TabId;
      setActiveTab(tab);
    };
    window.addEventListener('comm-set-tab', handler);
    return () => window.removeEventListener('comm-set-tab', handler);
  }, []);

  useEffect(() => {
    if (activeTab === 'invoices' || activeTab === 'team') {
      fetchInvoices();
      // Collapse all areas when switching to invoices tab
      setExpandedAreas(new Set());
      setExpandedPharmacies(new Set());
    }
    if (activeTab === 'pharmacies') fetchPharmacies();
    if (activeTab === 'notifs') fetchNotifs();
  }, [activeTab, fetchInvoices, fetchPharmacies, fetchNotifs]);

  // Auto-refetch invoices when any filter changes (debounced 300ms)
  const filtersDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (activeTab !== 'invoices' && activeTab !== 'team') return;
    if (filtersDebounceRef.current) clearTimeout(filtersDebounceRef.current);
    filtersDebounceRef.current = setTimeout(() => { fetchInvoices(); }, 300);
    return () => { if (filtersDebounceRef.current) clearTimeout(filtersDebounceRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus, filterPharmacy, filterRep, filterDateFrom, filterDateTo, activeTab]);

  // Poll notifications every 30 seconds
  useEffect(() => {
    const id = setInterval(fetchNotifs, 30000);
    return () => clearInterval(id);
  }, [fetchNotifs]);

  // ── Smart back navigation ─────────────────────────────────────
  // Push a history entry each time a layer opens so popstate unwinds them
  useEffect(() => {
    if (collectModal) { history.pushState({ layer: 'collectModal' }, ''); }
  }, [collectModal]);
  useEffect(() => {
    if (selectedInv) { history.pushState({ layer: 'drawer' }, ''); }
  }, [selectedInv]);
  useEffect(() => {
    if (expandedPharmacies.size > 0) { history.pushState({ layer: 'pharmacy' }, ''); }
  }, [expandedPharmacies.size]);
  useEffect(() => {
    if (expandedAreas.size > 0) { history.pushState({ layer: 'area' }, ''); }
  }, [expandedAreas.size]);

  useEffect(() => {
    const handleBack = (_e: PopStateEvent) => {
      if (collectModal)               { setCollectModal(false); return; }
      if (selectedInv)                { setSelectedInv(null); return; }
      if (expandedPharmacies.size > 0){ setExpandedPharmacies(new Set()); return; }
      if (expandedAreas.size > 0)     { setExpandedAreas(new Set()); return; }
    };
    window.addEventListener('popstate', handleBack);
    return () => window.removeEventListener('popstate', handleBack);
  }, [collectModal, selectedInv, expandedPharmacies, expandedAreas]);

  // ── Collect submit ────────────────────────────────────────────
  const submitCollect = async () => {
    if (!selectedInv) return;
    const amount = parseFloat(collectAmt);
    if (!amount || amount <= 0) { showToast('يرجى إدخال مبلغ صحيح'); return; }
    setCollectSaving(true);
    try {
      const returnedItems = withReturn
        ? Object.entries(returnQtys)
            .filter(([, qty]) => qty > 0)
            .map(([itemId, returnQty]) => ({ itemId: parseInt(itemId), returnQty }))
        : [];
      const r = await fetch(`/api/commercial/invoices/${selectedInv.id}/collect`, {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({
          amount,
          discount: parseFloat(collectDiscount) || 0,
          isFullCollection: collectFull,
          notes: collectNotes || null,
          latitude:  collectGps?.lat,
          longitude: collectGps?.lng,
          returnedItems,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'فشل الاستحصال');
      setLastReceipt(d.record);
      setCollectModal(false);
      setWithReturn(false);
      setReturnQtys({});
      showToast(`✅ تم الاستحصال — وصل: ${d.receiptNumber}`);
      // Refresh invoice detail + list
      fetchInvoiceDetail(selectedInv.id);
      fetchInvoices();
      fetchStats();
    } catch (e: any) { showToast(`❌ ${e.message}`); }
    finally { setCollectSaving(false); }
  };

  // ── Voice helpers ────────────────────────────────────────────────
  const startVoiceInput = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { showToast('❌ المتصفح لا يدعم الإدخال الصوتي'); return; }
    const recognition = new SR();
    recognition.lang = 'ar-IQ';
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;
    setVoiceListening(true);
    recognition.onresult = (e: any) => {
      let found = false;
      for (let i = 0; i < e.results[0].length; i++) {
        const t: string = e.results[0][i].transcript;
        const norm = t
          .replace(/[٠-٩]/g, (d: string) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
          .replace(/[,،\s]/g, '');
        const match = norm.match(/\d+/);
        if (match) {
          const v = parseInt(match[0], 10);
          setCollectAmt(String(v));
          found = true;
          break;
        }
      }
      if (!found) showToast('🎙️ لم يُتعرف على رقم، حاول مجدداً');
      setVoiceListening(false);
    };
    recognition.onerror = () => { showToast('❌ خطأ في التعرف الصوتي'); setVoiceListening(false); };
    recognition.onend   = () => setVoiceListening(false);
    recognition.start();
  };

  // Voice: listen for pharmacy name, match against pending pharmacies, open their invoices
  const startVoicePickPharmacy = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { showToast('❌ المتصفح لا يدعم الإدخال الصوتي'); return; }
    const recognition = new SR();
    recognition.lang = 'ar-IQ';
    recognition.interimResults = false;
    recognition.maxAlternatives = 5;
    pharmRecognitionRef.current = recognition;
    setVoiceListening(true);
    setPharmVoiceOverlay(true);
    recognition.onresult = async (e: any) => {
      setVoiceListening(false);
      setPharmVoiceOverlay(false);
      // Collect all transcript alternatives
      const transcripts: string[] = [];
      for (let i = 0; i < e.results[0].length; i++) {
        transcripts.push((e.results[0][i].transcript as string).trim());
      }
      const spoken = transcripts[0] ?? '';
      // Fuzzy match against known pending pharmacy names
      const normalize = (s: string) => s.replace(/ٱ/g, 'ا').replace(/ة/g, 'ه').replace(/ي/g, 'ى').toLowerCase().trim();
      const normSpoken = normalize(spoken);
      let bestMatch: string | null = null;
      let bestScore = 0;
      for (const name of pharmNames) {
        const normName = normalize(name);
        if (normName.includes(normSpoken) || normSpoken.includes(normName)) {
          const score = Math.min(normSpoken.length, normName.length) / Math.max(normSpoken.length, normName.length);
          if (score > bestScore) { bestScore = score; bestMatch = name; }
        }
      }
      if (!bestMatch || bestScore < 0.3) {
        showToast(`🎙️ جاري البحث عن: “${spoken}”`);
        // Open modal with the spoken text pre-filled
        setPickQuery(spoken);
        setPickPharmName(null);
        setPickPharmInvs([]);
        setPickModal(true);
        return;
      }
      // Found a match — load its invoices directly
      showToast(`🏥 تم التعرف: ${bestMatch}`);
      setPickQuery(bestMatch);
      setPickPharmName(bestMatch);
      setPickPharmInvs([]);
      setPickPharmLoading(true);
      setPickModal(true);
      try {
        const params = new URLSearchParams({ pharmacyName: bestMatch, take: '100' });
        const r = await fetch(`/api/commercial/invoices?${params}`, { headers: H() });
        const d = await r.json();
        const open = ((d.data ?? []) as Invoice[]).filter(i => i.status !== 'collected');
        open.sort((a, b) => new Date(a.dueDate ?? a.invoiceDate).getTime() - new Date(b.dueDate ?? b.invoiceDate).getTime());
        setPickPharmInvs(open);
      } catch {}
      finally { setPickPharmLoading(false); }
    };
    recognition.onerror = () => { showToast('❌ خطأ في التعرف الصوتي'); setVoiceListening(false); setPharmVoiceOverlay(false); };
    recognition.onend   = () => { setVoiceListening(false); setPharmVoiceOverlay(false); };
    recognition.start();
  };

  const stopPharmVoice = () => {
    try { pharmRecognitionRef.current?.stop(); } catch {}
    setVoiceListening(false);
    setPharmVoiceOverlay(false);
  };

  // ── Create invoice submit ──────────────────────────────────────
  const submitCreateInvoice = async () => {
    if (!newInv.invoiceNumber || !newInv.pharmacyName || !newInv.assignedRepId) {
      showToast('يرجى تعبئة الحقول المطلوبة: رقم الفاتورة، الصيدلية، المندوب');
      return;
    }
    setCreateSaving(true);
    try {
      const total = newInvItems.reduce((s, it) => s + (it.totalPrice ?? 0), 0);
      const r = await fetch('/api/commercial/invoices', {
        method: 'POST', headers: H(),
        body: JSON.stringify({
          ...newInv,
          totalAmount: total || parseFloat(newInv.totalAmount) || 0,
          items: newInvItems.map(it => ({
            ...it,
            totalPrice: it.totalPrice ?? (it.unitPrice ?? 0) * (it.quantity ?? 1),
          })),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'فشل الإنشاء');
      setCreateModal(false);
      setNewInv({ invoiceNumber: '', invoiceDate: '', dueDate: '', maxCollectionDate: '',
        deferredDays: '', paymentType: 'deferred', pharmacyName: '', areaName: '',
        assignedRepId: '', totalAmount: '', notes: '' });
      setNewInvItems([{ brandName: '', unitPrice: 0, quantity: 1, bonusQty: 0, totalPrice: 0 }]);
      showToast('✅ تم إنشاء الفاتورة');
      fetchInvoices(); fetchStats();
    } catch (e: any) { showToast(`❌ ${e.message}`); }
    finally { setCreateSaving(false); }
  };

  // ── Upload Excel ──────────────────────────────────────────────
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !token) return;
    setUploadLoading(true); setUploadResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch('/api/commercial/invoices/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'فشل الاستيراد');
      setUploadResult(d);
      showToast(`✅ تم استيراد ${d.imported} فاتورة من أصل ${d.total}`);
      fetchStats(); fetchInvoices();
    } catch (e: any) { showToast(`❌ ${e.message}`); }
    finally { setUploadLoading(false); if (uploadRef.current) uploadRef.current.value = ''; }
  };

  // ── Create pharmacy ───────────────────────────────────────────
  const submitCreatePharmacy = async () => {
    if (!newPharma.name) { showToast('يرجى إدخال اسم الصيدلية'); return; }
    setPharmaSaving(true);
    try {
      const r = await fetch('/api/commercial/pharmacies', {
        method: 'POST', headers: H(), body: JSON.stringify(newPharma),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'فشل الإنشاء');
      setPharmaModal(false);
      setNewPharma({ name: '', ownerName: '', phone: '', address: '', areaName: '' });
      showToast('✅ تم إضافة الصيدلية');
      fetchPharmacies();
    } catch (e: any) { showToast(`❌ ${e.message}`); }
    finally { setPharmaSaving(false); }
  };

  // ── Mark notification read ────────────────────────────────────
  const markRead = async (id: number) => {
    await fetch(`/api/commercial/notifications/${id}/read`, { method: 'PATCH', headers: H() });
    setNotifs(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  };
  const markAllRead = async () => {
    await fetch('/api/commercial/notifications/all/read', { method: 'PATCH', headers: H() });
    setNotifs(prev => prev.map(n => ({ ...n, isRead: true })));
    setUnreadCount(0);
  };

  // ── Print receipt ─────────────────────────────────────────────
  const printReceipt = (inv: Invoice, rec: CollectionRecord) => {
    const w = window.open('', '_blank', 'width=400,height=640');
    if (!w) return;
    const recReturned = rec.returnedAmount ?? 0;
    const invReturned = inv.returnedAmount ?? 0;
    const invEffective = inv.totalAmount - invReturned;
    const invRemaining = Math.max(0, invEffective - inv.collectedAmount);
    // Parse returned items for this record if available
    let returnedItemsRows = '';
    if (recReturned > 0 && rec.returnedItemsJson) {
      try {
        const items: any[] = JSON.parse(rec.returnedItemsJson);
        returnedItemsRows = items.map(it =>
          `<tr><td style="padding-right:16px;color:#555">${it.name ?? it.brandName ?? ''}</td><td style="text-align:center">${it.returnQty}</td><td style="text-align:left;direction:ltr;color:#7c3aed">${fmt(it.returnValue ?? 0)}</td></tr>`
        ).join('');
      } catch {}
    }
    w.document.write(`<!DOCTYPE html><html dir="rtl"><head>
      <meta charset="UTF-8">
      <title>وصل استحصال</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; direction: rtl; padding: 20px; font-size: 13px; }
        h2 { text-align: center; margin-bottom: 4px; }
        .sub { text-align: center; color: #666; font-size: 11px; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; }
        td { padding: 4px 6px; border-bottom: 1px solid #eee; }
        td:first-child { font-weight: 700; color: #555; width: 130px; }
        .total { font-size: 20px; font-weight: 900; color: #15803d; text-align: center; padding: 12px 0; border-top: 2px solid #000; border-bottom: 2px solid #000; margin: 12px 0; }
        .return-box { background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px; padding: 8px 10px; margin: 10px 0; }
        .return-title { font-weight: 700; color: #7c3aed; font-size: 12px; margin-bottom: 6px; }
        .return-table { width:100%; border-collapse:collapse; font-size:12px; }
        .return-table th { background:#ede9fe; color:#5b21b6; padding:4px 6px; font-weight:700; }
        .return-table td { padding:4px 6px; border-bottom:1px solid #f3e8ff; }
        .return-total { text-align:left; direction:ltr; font-weight:800; color:#7c3aed; font-size:13px; padding:4px 6px; border-top: 1.5px solid #e9d5ff; }
        .footer { text-align: center; color: #999; font-size: 10px; margin-top: 16px; }
        @media print { body { padding: 8px; } }
      </style>
    </head><body>
      <h2>💰 وصل استحصال</h2>
      <div class="sub">رقم الوصل: ${rec.receiptNumber}</div>
      <table>
        <tr><td>الصيدلية</td><td>${inv.pharmacyName}</td></tr>
        <tr><td>رقم الفاتورة</td><td>${inv.invoiceNumber}</td></tr>
        <tr><td>تاريخ الاستحصال</td><td>${fmtDate(rec.collectedAt)}</td></tr>
        <tr><td>طريقة الاستحصال</td><td>${rec.isFullCollection ? 'كامل ✅' : 'جزئي 🔄'}</td></tr>
        ${rec.discount > 0 ? `<tr><td>المبلغ</td><td>${fmt(rec.amount)} د.ع</td></tr><tr><td>الحسم</td><td>${fmt(rec.discount)} د.ع</td></tr>` : ''}
        ${rec.notes ? `<tr><td>ملاحظات</td><td>${rec.notes}</td></tr>` : ''}
      </table>
      ${recReturned > 0 ? `
      <div class="return-box">
        <div class="return-title">🔄 استرجاع بضاعة في هذا الاستحصال: -${fmt(recReturned)} د.ع</div>
        ${returnedItemsRows ? `
        <table class="return-table">
          <thead><tr><th>الصنف</th><th>الكمية</th><th>القيمة</th></tr></thead>
          <tbody>${returnedItemsRows}</tbody>
          <tfoot><tr><td colspan="2" class="return-total" style="text-align:right;font-weight:700">الإجمالي</td><td class="return-total">-${fmt(recReturned)}</td></tr></tfoot>
        </table>` : ''}
      </div>` : ''}
      <div class="total">${fmt(rec.finalAmount)} د.ع</div>
      <table style="margin-top:4px;font-size:12px">
        <tr><td style="color:#64748b">إجمالي الفاتورة</td><td style="text-align:left;direction:ltr">${fmt(inv.totalAmount)} د.ع</td></tr>
        ${invReturned > 0 ? `<tr><td style="color:#7c3aed">استرجاع بضاعة (كلي)</td><td style="text-align:left;direction:ltr;color:#7c3aed">-${fmt(invReturned)} د.ع</td></tr>
        <tr><td style="color:#475569">صافي المستحق</td><td style="text-align:left;direction:ltr;font-weight:700">${fmt(invEffective)} د.ع</td></tr>` : ''}
        <tr><td style="color:#b91c1c;font-weight:700">باقي المبلغ</td><td style="text-align:left;direction:ltr;color:#b91c1c;font-weight:800">${fmt(invRemaining)} د.ع</td></tr>
      </table>
      <div class="footer">تم الطباعة بواسطة نظام إدارة المبيعات</div>
    </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  // ── Excel export ──────────────────────────────────────────────
  const exportExcel = () => {
    const rows = invoices.map(inv => ({
      'رقم الفاتورة':      inv.invoiceNumber,
      'الصيدلية':          inv.pharmacyName,
      'المنطقة':           inv.areaName ?? '',
      'تاريخ الفاتورة':    fmtDate(inv.invoiceDate),
      'آخر موعد':          fmtDate(inv.maxCollectionDate),
      'نوع الدفع':         inv.paymentType === 'deferred' ? 'آجل' : 'نقد',
      'الحالة':            STATUS_META[inv.status as keyof typeof STATUS_META]?.label ?? inv.status,
      'إجمالي الفاتورة':   inv.totalAmount,
      'المستحصل':          inv.collectedAmount,
      'المتبقي':           inv.totalAmount - inv.collectedAmount,
      'المندوب':           inv.assignedRep?.displayName ?? inv.assignedRep?.username ?? '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'الفواتير');
    XLSX.writeFile(wb, `فواتير-تجارية-${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  // ────────────────────────────────────────────────────────────────────────
  // ── RENDER HELPERS ────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────

  const StatusBadge = ({ status }: { status: string }) => {
    const meta = STATUS_META[status as keyof typeof STATUS_META] ?? STATUS_META.pending;
    return (
      <span style={{
        background: meta.bg, color: meta.color,
        padding: '2px 10px', borderRadius: 20, fontWeight: 700, fontSize: 12,
      }}>
        {meta.icon} {meta.label}
      </span>
    );
  };

  const DaysBadge = ({ maxDate }: { maxDate: string | null }) => {
    const d = daysDiff(maxDate);
    if (d === null) return null;
    const bg = d > 7 ? '#dcfce7' : d > 0 ? '#fef3c7' : '#fee2e2';
    const color = d > 7 ? '#15803d' : d > 0 ? '#b45309' : '#b91c1c';
    return (
      <span style={{ background: bg, color, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
        {d > 0 ? `${d} يوم` : d === 0 ? 'اليوم' : `متأخر ${Math.abs(d)} يوم`}
      </span>
    );
  };

  // Full timeline countdown bar shown inside each card
  const CountdownBar = ({ inv }: { inv: Invoice }) => {
    if (!inv.maxCollectionDate || !inv.invoiceDate) return null;
    const start = new Date(inv.invoiceDate).getTime();
    const end   = new Date(inv.maxCollectionDate).getTime();
    const now   = Date.now();
    const total = end - start;
    if (total <= 0) return null;
    const pct     = Math.min(100, Math.max(0, ((now - start) / total) * 100));
    const daysLeft = Math.ceil((end - now) / 86400000);
    const barColor = daysLeft < 0 ? '#ef4444' : pct > 80 ? '#f59e0b' : '#10b981';
    const labelColor = daysLeft < 0 ? '#b91c1c' : pct > 80 ? '#b45309' : '#15803d';
    return (
      <div className="comm-countdown-wrap">
        <div className="comm-countdown-track">
          <div className="comm-countdown-fill" style={{ width: `${pct}%`, background: barColor }} />
          <div className="comm-countdown-marker" style={{ left: `${pct}%`, background: barColor }} />
        </div>
        <div className="comm-countdown-labels">
          <span>{fmtDate(inv.invoiceDate)}</span>
          <span style={{ color: labelColor, fontWeight: 700 }}>
            {daysLeft > 0 ? `⏳ ${daysLeft} يوم متبقي` : daysLeft === 0 ? '⚡ اليوم آخر موعد' : `🔴 متأخر ${Math.abs(daysLeft)} يوم`}
          </span>
          <span>{fmtDate(inv.maxCollectionDate)}</span>
        </div>
      </div>
    );
  };

  // ── STATS CARDS ────────────────────────────────────────────────
  const renderStats = () => {
    if (!stats) return <div className="comm-loading">جاري تحميل الإحصائيات...</div>;
    const { counts, amounts } = stats;
    const pct = amounts.total > 0 ? Math.round((amounts.collected / amounts.total) * 100) : 0;

    const goToInvoices = (status: string) => {
      setFilterStatus(status);
      setActiveTab('invoices');
    };

    const kpis: { label: string; val: number; icon: string; accent: string; filter: string }[] = [
      { label: 'إجمالي الفواتير', val: counts.total,     icon: '📋', accent: '#8B1C1C', filter: '' },
      { label: 'معلقة',           val: counts.pending,   icon: '🕒', accent: '#B45309', filter: 'pending' },
      { label: 'جزئي مسدد',       val: counts.partial,   icon: '🔄', accent: '#B45309', filter: 'partial' },
      { label: 'مكتملة',          val: counts.collected, icon: '✅', accent: '#2E7D32', filter: 'collected' },
      ...(counts.overdue > 0
        ? [{ label: 'متأخرة', val: counts.overdue, icon: '⚠️', accent: '#8B1C1C', filter: 'overdue' }]
        : []),
    ];

    return (
      <div>
        <div className="comm-kpi-grid">
          {kpis.map(k => (
            <div
              key={k.filter}
              className="comm-kpi-card"
              style={{ borderTop: `3px solid ${k.accent}` }}
              onClick={() => goToInvoices(k.filter)}
            >
              <div className="comm-kpi-icon">{k.icon}</div>
              <div className="comm-kpi-val" style={{ color: k.accent }}>{k.val}</div>
              <div className="comm-kpi-lbl">{k.label}</div>
            </div>
          ))}
        </div>

        <div className="comm-money-card">
          <div className="comm-money-header">
            <span className="comm-money-title">💰 ملخص المبالغ</span>
            <span className="comm-money-pct">{pct}% منجز</span>
          </div>
          <div className="comm-money-row">
            <div className="comm-money-item comm-money-total">
              <div className="comm-money-amt">{fmt(amounts.total)}</div>
              <div className="comm-money-sublbl">إجمالي الفواتير (د.ع)</div>
            </div>
            <div className="comm-money-item comm-money-collected">
              <div className="comm-money-amt">{fmt(amounts.collected)}</div>
              <div className="comm-money-sublbl">تم تحصيله (د.ع)</div>
            </div>
            <div className="comm-money-item comm-money-remaining">
              <div className="comm-money-amt">{fmt(amounts.remaining)}</div>
              <div className="comm-money-sublbl">المتبقي (د.ع)</div>
            </div>
          </div>
          <div className="comm-money-bar-wrap">
            <div className="comm-money-bar-track">
              <div className="comm-money-bar-fill" style={{ width: `${pct}%` }} />
              <div className="comm-money-bar-glow" style={{ left: `${pct}%` }} />
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── INVOICE CARD ───────────────────────────────────────────────
  const InvoiceCard = ({ inv, compact = false }: { inv: Invoice; compact?: boolean }) => {
    const st           = getInvStatus(inv);
    const returned     = inv.returnedAmount ?? 0;
    const effective    = inv.totalAmount - returned;
    const remaining    = effective - inv.collectedAmount;
    const pct          = effective > 0 ? Math.round((inv.collectedAmount / effective) * 100) : 0;
    const barColor     = st === 'collected' ? '#16a34a' : st === 'partial' ? '#f59e0b' : st === 'overdue' ? '#ef4444' : '#3b82f6';
    const daysLeft     = daysDiff(inv.maxCollectionDate);

    // Days since invoice was created
    const daysSince = inv.invoiceDate
      ? Math.floor((Date.now() - new Date(inv.invoiceDate).getTime()) / 86400000)
      : null;

    return (
      <div
        className={`comm-inv-card comm-inv-${st} ${compact ? 'comm-inv-compact' : ''}`}
        onClick={() => fetchInvoiceDetail(inv.id)}
      >
        {/* Header */}
        <div className="comm-inv-header">
          <div className="comm-inv-header-left">
            {!compact && <div className="comm-inv-title">🏥 {inv.pharmacyName}</div>}
            <div className="comm-inv-sub">#{inv.invoiceNumber} · {fmtDate(inv.invoiceDate)}</div>
            {!compact && inv.areaName && <div className="comm-inv-area">📍 {inv.areaName}</div>}
            {!compact && inv.assignedRep && !isRep && (
              <div className="comm-inv-rep">👤 {inv.assignedRep.displayName ?? inv.assignedRep.username}</div>
            )}
          </div>
          <div className="comm-inv-header-right">
            <StatusBadge status={st} />
            {/* Age badge */}
            {daysSince !== null && (
              <span style={{
                background: daysSince > 60 ? '#fee2e2' : daysSince > 30 ? '#fef3c7' : '#f0fdf4',
                color:      daysSince > 60 ? '#b91c1c' : daysSince > 30 ? '#b45309' : '#15803d',
                padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700,
              }}>
                🗓 منذ {daysSince} يوم
              </span>
            )}
            {daysLeft !== null && daysLeft <= 7 && (
              <DaysBadge maxDate={inv.maxCollectionDate} />
            )}
          </div>
        </div>

        {/* Countdown bar */}
        {!compact && <CountdownBar inv={inv} />}
        <div className="comm-inv-amounts">
          <div className="comm-inv-amt-item">
            <span className="comm-inv-amt-label">إجمالي</span>
            <span className="comm-inv-amt-val">{fmt(inv.totalAmount)}</span>
          </div>
          {returned > 0 && (
            <div className="comm-inv-amt-item">
              <span className="comm-inv-amt-label" style={{ color: '#7c3aed' }}>استرجاع</span>
              <span className="comm-inv-amt-val" style={{ color: '#7c3aed' }}>-{fmt(returned)}</span>
            </div>
          )}
          <div className="comm-inv-amt-item">
            <span className="comm-inv-amt-label" style={{ color: '#15803d' }}>مستحصل</span>
            <span className="comm-inv-amt-val" style={{ color: '#15803d' }}>{fmt(inv.collectedAmount)}</span>
          </div>
          <div className="comm-inv-amt-item">
            <span className="comm-inv-amt-label" style={{ color: remaining > 0 ? '#b91c1c' : '#15803d' }}>متبقي</span>
            <span className="comm-inv-amt-val" style={{ color: remaining > 0 ? '#b91c1c' : '#15803d', fontWeight: 800 }}>{fmt(remaining)}</span>
          </div>
        </div>

        {/* Collection progress bar — hidden in compact */}
        {!compact && (
          <div className="comm-inv-progress">
            <div className="comm-inv-progress-track">
              <div className="comm-inv-progress-fill" style={{ width: `${pct}%`, background: barColor }} />
            </div>
            <span className="comm-inv-progress-pct" style={{ color: barColor }}>{pct}%</span>
          </div>
        )}

        {/* Compact countdown bar */}
        {compact && <CountdownBar inv={inv} />}

        {/* Items list — shown in both modes */}
        {inv.items.length > 0 && (
          <div className="comm-inv-items-row">
            {inv.items.map((it) => (
              <div key={it.id} className="comm-inv-item-pill">
                <span className="comm-inv-item-name">{it.brandName}</span>
                <span className="comm-inv-item-qty">×{it.quantity}</span>
                {it.bonusQty > 0 && (
                  <span className="comm-inv-item-bonus">+{it.bonusQty}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── INVOICE DETAIL DRAWER ──────────────────────────────────────
  const renderInvoiceDetail = () => {
    if (invLoading) return (
      <div className="comm-drawer-overlay" onClick={() => setSelectedInv(null)}>
        <div className="comm-drawer" onClick={e => e.stopPropagation()}>
          <div className="comm-loading">جاري التحميل...</div>
        </div>
      </div>
    );
    if (!selectedInv) return null;
    const inv = selectedInv;
    const st = getInvStatus(inv);
    const returned  = inv.returnedAmount ?? 0;
    const effective = inv.totalAmount - returned;
    const remaining = effective - inv.collectedAmount;
    return (
      <div className="comm-drawer-overlay" onClick={() => setSelectedInv(null)}>
        <div className="comm-drawer" onClick={e => e.stopPropagation()}>
          <div className="comm-drawer-header">
            <button className="comm-close-btn" onClick={() => setSelectedInv(null)}>✕</button>
            <div>
              <div className="comm-drawer-title">{inv.pharmacyName}</div>
              <div style={{ fontSize: 12, color: '#64748b' }}>#{inv.invoiceNumber}</div>
            </div>
            <StatusBadge status={st} />
          </div>

          <div className="comm-drawer-body">
            {/* Details */}
            <div className="comm-detail-grid">
              <div className="comm-detail-row"><span>تاريخ الفاتورة</span><span>{fmtDate(inv.invoiceDate)}</span></div>
              <div className="comm-detail-row"><span>نوع الدفع</span><span>{inv.paymentType === 'deferred' ? 'آجل' : 'نقد'}</span></div>
              {inv.deferredDays && <div className="comm-detail-row"><span>أيام التأجيل</span><span>{inv.deferredDays}</span></div>}
              {inv.dueDate && <div className="comm-detail-row"><span>تاريخ الاستحقاق</span><span>{fmtDate(inv.dueDate)}</span></div>}
              {inv.maxCollectionDate && <div className="comm-detail-row"><span>آخر موعد</span><span style={{ fontWeight: 700 }}>{fmtDate(inv.maxCollectionDate)} <DaysBadge maxDate={inv.maxCollectionDate} /></span></div>}
              {inv.areaName && <div className="comm-detail-row"><span>المنطقة</span><span>{inv.areaName}</span></div>}
              {inv.assignedRep && <div className="comm-detail-row"><span>المندوب</span><span>{inv.assignedRep.displayName ?? inv.assignedRep.username}</span></div>}
              {inv.notes && <div className="comm-detail-row"><span>ملاحظات</span><span>{inv.notes}</span></div>}
            </div>

            {/* Amount summary */}
            <div className="comm-amount-box">
              <div className="comm-amount-row">
                <span>إجمالي الفاتورة</span>
                <strong>{fmt(inv.totalAmount)} د.ع</strong>
              </div>
              {returned > 0 && (
                <div className="comm-amount-row" style={{ color: '#7c3aed' }}>
                  <span>🔄 استرجاع بضاعة</span>
                  <strong style={{ color: '#7c3aed' }}>-{fmt(returned)} د.ع</strong>
                </div>
              )}
              {returned > 0 && (
                <div className="comm-amount-row" style={{ borderBottom: '1.5px dashed #e2e8f0', paddingBottom: 6, marginBottom: 4 }}>
                  <span style={{ color: '#64748b', fontSize: 12 }}>صافي المستحق</span>
                  <strong style={{ color: '#1e293b' }}>{fmt(effective)} د.ع</strong>
                </div>
              )}
              <div className="comm-amount-row comm-green">
                <span>المستحصل</span>
                <strong>{fmt(inv.collectedAmount)} د.ع</strong>
              </div>
              <div className={`comm-amount-row ${remaining > 0 ? 'comm-red' : 'comm-green'}`}>
                <span>المتبقي</span>
                <strong>{fmt(remaining)} د.ع</strong>
              </div>
            </div>

            {/* Items */}
            {inv.items.length > 0 && (
              <div className="comm-section">
                <div className="comm-section-title">📦 أصناف الفاتورة</div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="comm-table">
                    <thead>
                      <tr>
                        <th>الصنف</th><th>الكمية</th><th>البونص</th><th>السعر</th><th>المجموع</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inv.items.map(it => (
                        <tr key={it.id}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{it.brandName}</div>
                            {it.scientificName && <div style={{ fontSize: 11, color: '#64748b' }}>{it.scientificName}</div>}
                            {(it.dosage || it.form) && <div style={{ fontSize: 11, color: '#94a3b8' }}>{[it.dosage, it.form].filter(Boolean).join(' · ')}</div>}
                          </td>
                          <td style={{ textAlign: 'center' }}>{it.quantity}</td>
                          <td style={{ textAlign: 'center', color: '#15803d' }}>{it.bonusQty || '—'}</td>
                          <td style={{ textAlign: 'left', direction: 'ltr' }}>{fmt(it.unitPrice)}</td>
                          <td style={{ textAlign: 'left', direction: 'ltr', fontWeight: 700 }}>{fmt(it.totalPrice)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Collection history */}
            {inv.collections.length > 0 && (
              <div className="comm-section">
                <div className="comm-section-title">💰 سجل الاستحصالات</div>
                {inv.collections.map(rec => (
                  <div key={rec.id} className="comm-coll-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700, color: '#15803d' }}>{fmt(rec.finalAmount)} د.ع</div>
                        <div style={{ fontSize: 11, color: '#64748b' }}>{fmtDate(rec.collectedAt)} · {rec.receiptNumber}</div>
                        {rec.collectedBy && <div style={{ fontSize: 11, color: '#64748b' }}>👤 {rec.collectedBy.displayName ?? rec.collectedBy.username}</div>}
                        {rec.discount > 0 && <div style={{ fontSize: 11, color: '#b45309' }}>حسم: {fmt(rec.discount)} د.ع</div>}
                        {rec.notes && <div style={{ fontSize: 11, color: '#475569' }}>{rec.notes}</div>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                        {rec.isFullCollection
                          ? <span style={{ background: '#dcfce7', color: '#15803d', padding: '1px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>✅ كامل</span>
                          : <span style={{ background: '#fef3c7', color: '#b45309', padding: '1px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>🔄 جزئي</span>
                        }
                        <button className="comm-btn-ghost" style={{ fontSize: 11 }} onClick={() => printReceipt(inv, rec)}>🖨️ طباعة</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Collect button */}
            {canCollect && inv.status !== 'collected' && (
              <button
                className="comm-btn-primary"
                style={{ width: '100%', marginTop: 12 }}
                onClick={() => {
                  setCollectAmt('');
                  setCollectDiscount('0');
                  setCollectFull(false);
                  setCollectNotes('');
                  setCollectGps(null);
                  setCollectModal(true);
                }}
              >
                💰 تسجيل استحصال
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ── PICK-PHARMACY MODAL ────────────────────────────────────────
  const renderPickModal = () => {
    if (!pickModal) return null;
    const allNames = [...new Set([...pharmNames, ...pharmacies.map(p => p.name)])].sort();
    const areaByName: Record<string, string> = { ...pharmAreaMap };
    pharmacies.forEach(p => { if (p.areaName) areaByName[p.name] = p.areaName; });
    const q = pickQuery.trim().toLowerCase();
    const suggestions = q.length === 0 ? [] : allNames
      .filter(n => n.toLowerCase().includes(q))
      .sort((a, b) => {
        const ai = a.toLowerCase().indexOf(q), bi = b.toLowerCase().indexOf(q);
        if (ai !== bi) return ai - bi;
        return a.length - b.length;
      })
      .slice(0, 8);

    const selectPharm = async (name: string) => {
      setPickPharmName(name);
      setPickPharmInvs([]);
      setPickPharmLoading(true);
      try {
        const params = new URLSearchParams({ pharmacyName: name, take: '100' });
        const r = await fetch(`/api/commercial/invoices?${params}`, { headers: H() });
        const d = await r.json();
        const open = ((d.data ?? []) as Invoice[]).filter(i => i.status !== 'collected');
        open.sort((a, b) => new Date(a.dueDate ?? a.invoiceDate).getTime() - new Date(b.dueDate ?? b.invoiceDate).getTime());
        setPickPharmInvs(open);
      } catch {}
      finally { setPickPharmLoading(false); }
    };

    const highlightMatch = (name: string) => {
      if (!q) return <span>{name}</span>;
      const idx = name.toLowerCase().indexOf(q);
      if (idx === -1) return <span>{name}</span>;
      return <span>{name.slice(0, idx)}<mark style={{ background: '#fef08a', borderRadius: 3, padding: '0 1px' }}>{name.slice(idx, idx + q.length)}</mark>{name.slice(idx + q.length)}</span>;
    };

    return (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          padding: '60px 16px 80px',
        }}
        onClick={() => { setPickModal(false); setPickPharmName(null); setPickPharmInvs([]); }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background: '#fff', borderRadius: 20, width: '100%', maxWidth: 420,
            boxShadow: '0 24px 60px rgba(0,0,0,0.25)', overflow: 'hidden',
            display: 'flex', flexDirection: 'column', maxHeight: '85vh',
          }}
        >
          {/* ── Header ── */}
          {!pickPharmName ? (
            <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid #f1f5f9' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#1e293b' }}>💊 اختر الصيدلية</div>
                <button
                  onClick={() => { setPickModal(false); setPickPharmName(null); setPickPharmInvs([]); }}
                  style={{ background: '#f1f5f9', border: 'none', borderRadius: 50, width: 32, height: 32, cursor: 'pointer', fontSize: 16, color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >✕</button>
              </div>
              {/* Search box */}
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 16, color: '#94a3b8' }}>🔍</span>
                <input
                  autoFocus
                  value={pickQuery}
                  onChange={e => setPickQuery(e.target.value)}
                  placeholder="ابدأ بكتابة اسم الصيدلية..."
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    padding: '11px 40px 11px 14px',
                    borderRadius: 12, border: '2px solid #e2e8f0',
                    fontSize: 14, outline: 'none', direction: 'rtl',
                    background: '#f8fafc', transition: 'border-color 0.2s',
                  }}
                  onFocus={e => (e.target.style.borderColor = '#6366f1')}
                  onBlur={e => (e.target.style.borderColor = '#e2e8f0')}
                />
                {pickQuery && (
                  <button
                    onClick={() => setPickQuery('')}
                    style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#94a3b8' }}
                  >✕</button>
                )}
              </div>
            </div>
          ) : (
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => { setPickPharmName(null); setPickPharmInvs([]); setPickQuery(''); }}
                style={{ background: '#f1f5f9', border: 'none', borderRadius: 50, width: 32, height: 32, cursor: 'pointer', fontSize: 16, color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              >←</button>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 15, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>🏥 {pickPharmName}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>اختر الفاتورة للاستحصال</div>
              </div>
            </div>
          )}

          {/* ── Body ── */}
          <div style={{ overflowY: 'auto', flex: 1, padding: '8px 16px 16px' }}>

            {/* Step 1: suggestions */}
            {!pickPharmName && (<>
              {q.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px 0 24px', color: '#94a3b8' }}>
                  <div style={{ fontSize: 36, marginBottom: 8 }}>🏪</div>
                  <div style={{ fontSize: 13 }}>ابدأ بكتابة اسم الصيدلية للبحث</div>
                  <div style={{ fontSize: 11, marginTop: 4, color: '#cbd5e1' }}>{allNames.length} صيدلية متاحة</div>
                </div>
              )}
              {q.length > 0 && suggestions.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px 0', color: '#94a3b8' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🔎</div>
                  <div style={{ fontSize: 13 }}>لا توجد نتائج لـ "{pickQuery}"</div>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: q ? 8 : 0 }}>
                {suggestions.map((name, idx) => (
                  <button
                    key={name}
                    onClick={() => selectPharm(name)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '12px 14px', borderRadius: 12,
                      border: '1.5px solid #e2e8f0', background: idx === 0 ? '#f0f9ff' : '#fafafa',
                      cursor: 'pointer', textAlign: 'right', width: '100%',
                      transition: 'all 0.15s',
                      borderColor: idx === 0 ? '#bae6fd' : '#e2e8f0',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#eff6ff'; e.currentTarget.style.borderColor = '#a5b4fc'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = idx === 0 ? '#f0f9ff' : '#fafafa'; e.currentTarget.style.borderColor = idx === 0 ? '#bae6fd' : '#e2e8f0'; }}
                  >
                    <span style={{ fontSize: 22, flexShrink: 0 }}>🏥</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b' }}>{highlightMatch(name)}</div>
                      {areaByName[name] && (
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>📍 {areaByName[name]}</div>
                      )}
                    </div>
                    {idx === 0 && <span style={{ fontSize: 10, background: '#0ea5e9', color: '#fff', borderRadius: 20, padding: '2px 8px', flexShrink: 0 }}>الأقرب</span>}
                    <span style={{ color: '#cbd5e1', fontSize: 16, flexShrink: 0 }}>‹</span>
                  </button>
                ))}
              </div>
            </>)}

            {/* Step 2: invoices list */}
            {pickPharmName && (<>
              {pickPharmLoading && (
                <div style={{ textAlign: 'center', padding: '32px 0', color: '#94a3b8' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>⏳</div>
                  <div style={{ fontSize: 13 }}>جاري تحميل الفواتير...</div>
                </div>
              )}
              {!pickPharmLoading && pickPharmInvs.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px 0', color: '#16a34a' }}>
                  <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>لا توجد فواتير مستحقة</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>جميع مستحقات هذه الصيدلية مسددة</div>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                {!pickPharmLoading && pickPharmInvs.map((inv, idx) => {
                  const refDate = inv.dueDate ?? inv.invoiceDate;
                  const days = Math.floor((Date.now() - new Date(refDate).getTime()) / 86_400_000);
                  const remaining = inv.totalAmount - inv.collectedAmount - (inv.returnedAmount ?? 0);
                  const daysColor = days > 30 ? '#dc2626' : days > 14 ? '#d97706' : days > 0 ? '#0369a1' : '#16a34a';
                  const urgency = days > 30 ? { bg: '#fff1f2', border: '#fecdd3' } : days > 14 ? { bg: '#fffbeb', border: '#fde68a' } : { bg: '#f0f9ff', border: '#bae6fd' };
                  return (
                    <button
                      key={inv.id}
                      onClick={() => {
                        setPickModal(false); setPickPharmName(null); setPickPharmInvs([]);
                        fetchInvoiceDetail(inv.id);
                        setCollectModal(true); setCollectAmt(''); setCollectDiscount('0');
                        setCollectFull(false); setCollectNotes(''); setCollectGps(null);
                        setWithReturn(false); setReturnQtys({});
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '14px', borderRadius: 14,
                        border: `1.5px solid ${urgency.border}`, background: urgency.bg,
                        cursor: 'pointer', textAlign: 'right', width: '100%',
                        transition: 'transform 0.12s, box-shadow 0.12s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.01)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)'; }}
                      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
                    >
                      {/* rank badge */}
                      <div style={{ width: 32, height: 32, borderRadius: 10, background: daysColor, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, flexShrink: 0 }}>
                        {idx + 1}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>#{inv.invoiceNumber}</div>
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                          {inv.dueDate ? `📅 استحقاق: ${inv.dueDate}` : `📄 فاتورة: ${inv.invoiceDate}`}
                        </div>
                      </div>
                      <div style={{ textAlign: 'left', flexShrink: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: 14, color: '#dc2626', direction: 'ltr' }}>{remaining.toLocaleString()}<span style={{ fontSize: 10, fontWeight: 500 }}> د.ع</span></div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: daysColor, background: `${daysColor}18`, borderRadius: 20, padding: '2px 8px', marginTop: 3, textAlign: 'center' }}>
                          {days > 0 ? `${days} يوم` : days === 0 ? 'اليوم' : `${Math.abs(days)}ي متبقي`}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>)}
          </div>
        </div>
      </div>
    );
  };

  // ── COLLECT MODAL ──────────────────────────────────────────────
  const renderCollectModal = () => {
    if (!collectModal) return null;

    // Show spinner while invoice detail is loading
    if (!selectedInv) {
      return (
        <div className="comm-modal-overlay" onClick={() => setCollectModal(false)}>
          <div className="comm-modal" onClick={e => e.stopPropagation()}>
            <div className="comm-modal-header">
              <button className="comm-close-btn" onClick={() => setCollectModal(false)}>✕</button>
              <h3>💰 تسجيل استحصال</h3>
            </div>
            <div className="comm-modal-body" style={{ textAlign: 'center', padding: '48px 0', color: '#64748b', fontSize: 15 }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
              جاري تحميل بيانات الفاتورة...
            </div>
          </div>
        </div>
      );
    }
    const returned    = selectedInv.returnedAmount ?? 0;
    const effective   = selectedInv.totalAmount - returned;
    // New return being entered right now
    const nowReturned = withReturn
      ? Object.entries(returnQtys).reduce((sum, [itemId, qty]) => {
          const item = selectedInv.items.find(it => it.id === parseInt(itemId));
          return sum + (item ? qty * item.unitPrice : 0);
        }, 0)
      : 0;
    const afterReturn = Math.max(0, effective - nowReturned);
    const remaining   = afterReturn - selectedInv.collectedAmount;

    return (
      <div className="comm-modal-overlay" onClick={() => setCollectModal(false)}>
        <div className="comm-modal" onClick={e => e.stopPropagation()}>
          <div className="comm-modal-header">
            <button className="comm-close-btn" onClick={() => setCollectModal(false)}>✕</button>
            <h3>💰 تسجيل استحصال</h3>
          </div>
          <div className="comm-modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            {/* Summary */}
            <div className="comm-collect-summary">
              <div className="comm-collect-summary-row">
                <span>🏥 {selectedInv.pharmacyName}</span>
                <span className="comm-collect-summary-inv">#{selectedInv.invoiceNumber}</span>
              </div>
              <div className="comm-collect-summary-row comm-collect-summary-amounts">
                <div><span>إجمالي</span><strong>{fmt(selectedInv.totalAmount)}</strong></div>
                {returned > 0 && <div style={{ color: '#7c3aed' }}><span>استرجاع سابق</span><strong>-{fmt(returned)}</strong></div>}
                <div style={{ color: '#b91c1c' }}><span>المتبقي المستحق</span><strong>{fmt(remaining)}</strong></div>
              </div>
              {nowReturned > 0 && (
                <div className="comm-collect-return-preview">
                  <span>🔄 قيمة الاسترجاع الآن</span>
                  <strong style={{ color: '#7c3aed' }}>-{fmt(nowReturned)} د.ع</strong>
                  <span>← المطلوب بعده</span>
                  <strong style={{ color: '#b91c1c' }}>{fmt(afterReturn - selectedInv.collectedAmount)} د.ع</strong>
                </div>
              )}
            </div>

            {/* Return toggle */}
            {selectedInv.items.length > 0 && (
              <label className="comm-return-toggle">
                <input
                  type="checkbox"
                  checked={withReturn}
                  onChange={e => {
                    setWithReturn(e.target.checked);
                    if (!e.target.checked) setReturnQtys({});
                  }}
                />
                <span>🔄 يوجد استرجاع بضاعة</span>
              </label>
            )}

            {/* Return items table */}
            {withReturn && selectedInv.items.length > 0 && (
              <div className="comm-return-table-wrap">
                <div className="comm-return-table-title">أدخل الكميات المُسترجَعة:</div>
                <table className="comm-return-table">
                  <thead>
                    <tr><th>الصنف</th><th>الكمية الكلية</th><th>كمية الاسترجاع</th><th>القيمة</th></tr>
                  </thead>
                  <tbody>
                    {selectedInv.items.map(item => {
                      const rq = returnQtys[item.id] ?? 0;
                      const rv = rq * item.unitPrice;
                      return (
                        <tr key={item.id}>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{item.brandName}</div>
                            {item.dosage && <div style={{ fontSize: 11, color: '#64748b' }}>{item.dosage}</div>}
                          </td>
                          <td style={{ textAlign: 'center', color: '#475569' }}>{item.quantity}</td>
                          <td>
                            <input
                              type="number"
                              className="comm-input comm-return-qty-input"
                              min={0} max={item.quantity}
                              value={rq || ''}
                              placeholder="0"
                              onChange={e => {
                                const v = Math.min(item.quantity, Math.max(0, parseInt(e.target.value) || 0));
                                setReturnQtys(prev => ({ ...prev, [item.id]: v }));
                              }}
                            />
                          </td>
                          <td style={{ textAlign: 'left', direction: 'ltr', color: rv > 0 ? '#7c3aed' : '#94a3b8', fontWeight: rv > 0 ? 700 : 400 }}>
                            {rv > 0 ? `-${fmt(rv)}` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {nowReturned > 0 && (
                    <tfoot>
                      <tr>
                        <td colSpan={3} style={{ textAlign: 'right', fontWeight: 700, fontSize: 13 }}>إجمالي الاسترجاع</td>
                        <td style={{ textAlign: 'left', direction: 'ltr', fontWeight: 800, color: '#7c3aed' }}>-{fmt(nowReturned)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}

            {/* Amount to collect */}
            <label className="comm-label" style={{ marginTop: 12 }}>المبلغ المستحصل (د.ع) *</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="comm-input"
                type="number"
                value={collectAmt}
                placeholder={`الحد الأقصى: ${fmt(remaining)}`}
                style={{ flex: 1 }}
                onChange={e => {
                  setCollectAmt(e.target.value);
                  const v = parseFloat(e.target.value);
                  if (v >= remaining) setCollectFull(true);
                  else setCollectFull(false);
                }}
              />
              <button
                type="button"
                onClick={startVoiceInput}
                disabled={voiceListening}
                title="إدخال صوتي"
                style={{
                  padding: '9px 13px',
                  borderRadius: 8,
                  border: voiceListening ? '2px solid #ef4444' : '1px solid #cbd5e1',
                  background: voiceListening ? '#fee2e2' : '#f0fdf4',
                  cursor: voiceListening ? 'not-allowed' : 'pointer',
                  fontSize: 20,
                  flexShrink: 0,
                  transition: 'all 0.2s',
                  boxShadow: voiceListening ? '0 0 0 3px rgba(239,68,68,0.2)' : '0 1px 3px rgba(0,0,0,0.08)',
                }}
              >
                {voiceListening ? '🔴' : '🎙️'}
              </button>
            </div>

            <label className="comm-label">الحسم (اختياري)</label>
            <input
              className="comm-input"
              type="number"
              value={collectDiscount}
              onChange={e => setCollectDiscount(e.target.value)}
            />

            <label className="comm-checkbox-row">
              <input
                type="checkbox"
                checked={collectFull}
                onChange={e => {
                  setCollectFull(e.target.checked);
                  if (e.target.checked) setCollectAmt(String(Math.max(0, remaining)));
                }}
              />
              استحصال كامل للمبلغ المتبقي
            </label>

            <label className="comm-label">ملاحظات</label>
            <textarea
              className="comm-input"
              rows={2}
              value={collectNotes}
              onChange={e => setCollectNotes(e.target.value)}
              placeholder="ملاحظات اختيارية..."
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <button className="comm-btn-gps" onClick={captureGps} disabled={collectGpsLoading}>
                {collectGpsLoading ? '⏳' : collectGps ? '✅ GPS' : '📍 تسجيل الموقع'}
              </button>
              {collectGps && (
                <span style={{ fontSize: 11, color: '#15803d' }}>
                  {collectGps.lat.toFixed(5)}, {collectGps.lng.toFixed(5)}
                </span>
              )}
            </div>
          </div>
          <div className="comm-modal-footer">
            <button className="comm-btn-secondary" onClick={() => setCollectModal(false)}>إلغاء</button>
            <button className="comm-btn-primary" onClick={submitCollect} disabled={collectSaving}>
              {collectSaving ? '⏳ جاري الحفظ...' : '✅ تأكيد الاستحصال'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ── CREATE INVOICE MODAL ───────────────────────────────────────
  const renderCreateModal = () => {
    if (!createModal) return null;
    return (
      <div className="comm-modal-overlay" onClick={() => setCreateModal(false)}>
        <div className="comm-modal comm-modal-lg" onClick={e => e.stopPropagation()}>
          <div className="comm-modal-header">
            <button className="comm-close-btn" onClick={() => setCreateModal(false)}>✕</button>
            <h3>📄 إنشاء فاتورة جديدة</h3>
          </div>
          <div className="comm-modal-body" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
            <div className="comm-form-grid">
              <div>
                <label className="comm-label">رقم الفاتورة *</label>
                <input className="comm-input" value={newInv.invoiceNumber} onChange={e => setNewInv(p => ({ ...p, invoiceNumber: e.target.value }))} />
              </div>
              <div>
                <label className="comm-label">المندوب *</label>
                <select className="comm-input" value={newInv.assignedRepId} onChange={e => setNewInv(p => ({ ...p, assignedRepId: e.target.value }))}>
                  <option value="">-- اختر مندوب --</option>
                  {reps.filter(r => r.role === 'commercial_rep').map(r => (
                    <option key={r.id} value={r.id}>{r.displayName ?? r.username}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="comm-label">الصيدلية *</label>
                <input className="comm-input" list="pharma-list" value={newInv.pharmacyName} onChange={e => setNewInv(p => ({ ...p, pharmacyName: e.target.value }))} />
                <datalist id="pharma-list">{pharmacies.map(p => <option key={p.id} value={p.name} />)}</datalist>
              </div>
              <div>
                <label className="comm-label">المنطقة</label>
                <input className="comm-input" value={newInv.areaName} onChange={e => setNewInv(p => ({ ...p, areaName: e.target.value }))} />
              </div>
              <div>
                <label className="comm-label">تاريخ الفاتورة</label>
                <input className="comm-input" type="date" value={newInv.invoiceDate} onChange={e => setNewInv(p => ({ ...p, invoiceDate: e.target.value }))} />
              </div>
              <div>
                <label className="comm-label">نوع الدفع</label>
                <select className="comm-input" value={newInv.paymentType} onChange={e => setNewInv(p => ({ ...p, paymentType: e.target.value }))}>
                  <option value="deferred">آجل</option>
                  <option value="cash">نقد</option>
                </select>
              </div>
              <div>
                <label className="comm-label">أيام التأجيل</label>
                <input className="comm-input" type="number" value={newInv.deferredDays} onChange={e => setNewInv(p => ({ ...p, deferredDays: e.target.value }))} />
              </div>
              <div>
                <label className="comm-label">آخر موعد للاستحصال</label>
                <input className="comm-input" type="date" value={newInv.maxCollectionDate} onChange={e => setNewInv(p => ({ ...p, maxCollectionDate: e.target.value }))} />
              </div>
            </div>

            {/* Items */}
            <div className="comm-section-title" style={{ marginTop: 16 }}>📦 أصناف الفاتورة</div>
            {newInvItems.map((it, idx) => (
              <div key={idx} className="comm-item-row">
                <input className="comm-input" placeholder="اسم الصنف *" value={it.brandName ?? ''} onChange={e => setNewInvItems(prev => prev.map((x, i) => i === idx ? { ...x, brandName: e.target.value } : x))} style={{ flex: 2 }} />
                <input className="comm-input" placeholder="كمية" type="number" value={it.quantity ?? 1} onChange={e => setNewInvItems(prev => prev.map((x, i) => i === idx ? { ...x, quantity: parseInt(e.target.value) || 1, totalPrice: (x.unitPrice ?? 0) * (parseInt(e.target.value) || 1) } : x))} style={{ flex: 1 }} />
                <input className="comm-input" placeholder="بونص" type="number" value={it.bonusQty ?? 0} onChange={e => setNewInvItems(prev => prev.map((x, i) => i === idx ? { ...x, bonusQty: parseInt(e.target.value) || 0 } : x))} style={{ flex: 1 }} />
                <input className="comm-input" placeholder="سعر الوحدة" type="number" value={it.unitPrice ?? 0} onChange={e => setNewInvItems(prev => prev.map((x, i) => i === idx ? { ...x, unitPrice: parseFloat(e.target.value) || 0, totalPrice: (parseFloat(e.target.value) || 0) * (x.quantity ?? 1) } : x))} style={{ flex: 1 }} />
                <span style={{ padding: '0 4px', fontWeight: 700, color: '#15803d', minWidth: 80, textAlign: 'left' }}>{fmt((it.unitPrice ?? 0) * (it.quantity ?? 1))}</span>
                {newInvItems.length > 1 && (
                  <button onClick={() => setNewInvItems(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 16 }}>✕</button>
                )}
              </div>
            ))}
            <button className="comm-btn-ghost" onClick={() => setNewInvItems(prev => [...prev, { brandName: '', unitPrice: 0, quantity: 1, bonusQty: 0, totalPrice: 0 }])}>
              + إضافة صنف
            </button>

            <div style={{ marginTop: 12 }}>
              <label className="comm-label">ملاحظات</label>
              <textarea className="comm-input" rows={2} value={newInv.notes} onChange={e => setNewInv(p => ({ ...p, notes: e.target.value }))} />
            </div>

            <div style={{ background: '#f0fdf4', borderRadius: 8, padding: 10, marginTop: 8, fontWeight: 700, color: '#15803d' }}>
              الإجمالي: {fmt(newInvItems.reduce((s, it) => s + ((it.unitPrice ?? 0) * (it.quantity ?? 1)), 0))} د.ع
            </div>
          </div>
          <div className="comm-modal-footer">
            <button className="comm-btn-secondary" onClick={() => setCreateModal(false)}>إلغاء</button>
            <button className="comm-btn-primary" onClick={submitCreateInvoice} disabled={createSaving}>
              {createSaving ? '⏳ جاري الحفظ...' : '✅ إنشاء الفاتورة'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ── TABS RENDER ────────────────────────────────────────────────
  const renderTabContent = () => {
    switch (activeTab) {

      // ── HOME / DASHBOARD ──────────────────────────────────────
      case 'home': return (
        <div>

          {renderStats()}

          {/* Recent collections */}
          {stats && stats.recentCollections.length > 0 && (
            <div className="comm-card" style={{ marginTop: 16 }}>
              <div
                className="comm-card-title"
                onClick={() => setShowRecentColl(p => !p)}
                style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>🕐 آخر الاستحصالات (7 أيام)</span>
                <span style={{ fontSize: 14, color: '#64748b', transition: 'transform 0.2s', display: 'inline-block', transform: showRecentColl ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▾</span>
              </div>
              {showRecentColl && stats.recentCollections.map((c: any, i: number) => (
                <div key={i} className={`comm-recent-row ${c.isFullCollection ? 'full' : 'partial'}`}
                  style={{ cursor: c.invoice?.id ? 'pointer' : undefined }}
                  onClick={() => { if (c.invoice?.id) fetchInvoiceDetail(c.invoice.id); }}
                >
                  <div className={`comm-recent-badge ${c.isFullCollection ? 'full' : 'partial'}`}>
                    {c.isFullCollection ? '✅ كامل' : '🔄 جزئي'}
                  </div>
                  <div className="comm-recent-info">
                    <div className="comm-recent-pharma">{c.invoice?.pharmacyName ?? '—'}</div>
                    <div className="comm-recent-sub">#{c.invoice?.invoiceNumber} · {fmtDate(c.collectedAt)}</div>
                    {c.collectedBy && (
                      <div className="comm-recent-by">👤 {c.collectedBy.displayName ?? c.collectedBy.username}</div>
                    )}
                  </div>
                  <div className={`comm-recent-amt ${c.isFullCollection ? 'full' : 'partial'}`}>
                    {fmt(c.finalAmount)}<span> د.ع</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Reps summary for managers */}
          {(isMgr || isLead) && stats && stats.repsSummary.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="comm-card-title" style={{ paddingRight: 4, marginBottom: 10 }}>👥 ملخص المندوبين</div>
              <div className="comm-rep-cards">
                {stats.repsSummary.map((r: RepSummary) => {
                  const repPct = r.totalAmount > 0 ? Math.round(r.collectedAmount / r.totalAmount * 100) : 0;
                  const repColor = repPct >= 100 ? '#22c55e' : repPct >= 60 ? '#f59e0b' : '#ef4444';
                  return (
                    <div key={r.id} className="comm-rep-card">
                      <div className="comm-rep-avatar">{(r.name[0] ?? '?').toUpperCase()}</div>
                      <div className="comm-rep-info">
                        <div className="comm-rep-name">{r.name}</div>
                        <div className="comm-rep-meta">
                          <span style={{ color: '#3b82f6' }}>{r.pending} معلق</span>
                          <span style={{ color: '#f59e0b' }}>{r.partial} جزئي</span>
                          <span style={{ color: '#22c55e' }}>{r.collected} مكتمل</span>
                        </div>
                        <div className="comm-rep-bar-wrap">
                          <div className="comm-rep-bar-track">
                            <div className="comm-rep-bar-fill" style={{ width: `${repPct}%`, background: repColor }} />
                          </div>
                          <span className="comm-rep-pct" style={{ color: repColor }}>{repPct}%</span>
                        </div>
                      </div>
                      <div className="comm-rep-amount">
                        <div style={{ color: repColor, fontWeight: 800, fontSize: 14, direction: 'ltr' }}>{fmt(r.collectedAmount)}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8', direction: 'ltr' }}>من {fmt(r.totalAmount)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      );

      // ── INVOICES ───────────────────────────────────────────────
      case 'invoices':
      case 'team': {
        // ─ Grouped view builder ─────────────────────────────────
        const renderGroupedView = () => {
          const areaMap = new Map<string, Map<string, Invoice[]>>();
          for (const inv of invoices) {
            const area = inv.areaName || 'بدون منطقة';
            if (!areaMap.has(area)) areaMap.set(area, new Map());
            const pharmaMap = areaMap.get(area)!;
            if (!pharmaMap.has(inv.pharmacyName)) pharmaMap.set(inv.pharmacyName, []);
            pharmaMap.get(inv.pharmacyName)!.push(inv);
          }
          // When searching by pharmacy name, auto-expand all areas and pharmacies
          const isSearching = filterPharmacy.trim().length > 0;
          return (
            <div className="comm-grouped-view comm-theme-cordine">
              {[...areaMap.entries()].map(([area, pharmaMap], areaIdx) => {
                let areaTotal = 0, areaCollected = 0, areaReturned = 0;
                for (const invs of pharmaMap.values())
                  for (const inv of invs) {
                    areaTotal += inv.totalAmount;
                    areaCollected += inv.collectedAmount;
                    areaReturned += inv.returnedAmount ?? 0;
                  }
                const areaEffective = areaTotal - areaReturned;
                const areaRemaining = areaEffective - areaCollected;
                const areaPct = areaEffective > 0 ? Math.round((areaCollected / areaEffective) * 100) : 0;
                const areaOpen = isSearching || expandedAreas.has(area);
                const anyOpen = !isSearching && expandedAreas.size > 0;
                const totalInvCount = [...pharmaMap.values()].reduce((s, a) => s + a.length, 0);
                const toggleArea = () => {
                  if (isSearching) return; // don't collapse while searching
                  setExpandedAreas(prev => {
                    const next = new Set(prev);
                    if (next.has(area)) {
                      next.delete(area);
                      // also collapse all pharmacies in this area
                      setExpandedPharmacies(pp => {
                        const npp = new Set(pp);
                        [...pharmaMap.keys()].forEach(pn => npp.delete(`${area}::${pn}`));
                        return npp;
                      });
                    } else {
                      next.clear();
                      next.add(area);
                      // collapse pharmacies of any previously open area
                      setExpandedPharmacies(new Set());
                    }
                    return next;
                  });
                };
                // hide this section if another area is open (only when not searching)
                if (anyOpen && !areaOpen) return null;
                return (
                  <div key={area} className="comm-area-section" data-idx={areaIdx % 5}>
                    <div className={`comm-area-header ${areaOpen ? 'open' : ''}`} onClick={toggleArea}>
                      <div className="comm-area-header-main">
                        <div className="comm-area-chevron">{areaOpen ? '▾' : '▸'}</div>
                        <div className="comm-area-header-info">
                          <span className="comm-area-name">📍 {area}</span>
                          <div className="comm-area-chips-row">
                            <span className="comm-area-chip">{totalInvCount} فاتورة</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    {areaOpen && (
                      <div className="comm-area-body">
                        {[...pharmaMap.entries()].map(([pharmaName, invs]) => {
                          const pharmaKey  = `${area}::${pharmaName}`;
                          const pharmaOpen = isSearching || expandedPharmacies.has(pharmaKey);
                          // any pharmacy in this area is open? (only when not searching)
                          const anyPharmaOpen = !isSearching && [...pharmaMap.keys()].some(pn => expandedPharmacies.has(`${area}::${pn}`));
                          if (anyPharmaOpen && !pharmaOpen) return null;
                          const pTotal  = invs.reduce((s, i) => s + i.totalAmount, 0);
                          const pColl   = invs.reduce((s, i) => s + i.collectedAmount, 0);
                          const pRet    = invs.reduce((s, i) => s + (i.returnedAmount ?? 0), 0);
                          const pEff    = pTotal - pRet;
                          const pRem    = pEff - pColl;
                          const pPct    = pEff > 0 ? Math.round((pColl / pEff) * 100) : 0;
                          const allDone = invs.every(i => i.status === 'collected');
                          const hasOver = invs.some(i => getInvStatus(i) === 'overdue');
                          const barColor = allDone ? '#22c55e' : hasOver ? '#ef4444' : '#6366f1';
                          const initials = pharmaName.trim().slice(0, 2).toUpperCase();
                          return (
                            <div key={pharmaName} className="comm-pharma-section">
                              <div
                                className={`comm-pharma-row ${allDone ? 'done' : hasOver ? 'overdue' : ''}`}
                                onClick={() => {
                                  if (isSearching) return; // don't collapse while searching
                                  setExpandedPharmacies(prev => {
                                    const next = new Set(prev);
                                    if (next.has(pharmaKey)) { next.delete(pharmaKey); }
                                    else { // close all pharmacies in same area first
                                      [...pharmaMap.keys()].forEach(pn => next.delete(`${area}::${pn}`));
                                      next.add(pharmaKey);
                                    }
                                    return next;
                                  });
                                }}
                              >
                                <div className="comm-pharma-avatar">{initials}</div>
                                <div className="comm-pharma-row-left">
                                  <div>
                                    <div className="comm-pharma-name">{pharmaName}</div>
                                    <div className="comm-pharma-meta">
                                      <span>{invs.length} فاتورة</span>
                                      {allDone && <span className="comm-pharma-tag done">✅ مكتمل</span>}
                                      {!allDone && hasOver && <span className="comm-pharma-tag overdue">⚠️ متأخر</span>}
                                    </div>
                                  </div>
                                </div>
                                <div className="comm-pharma-row-right">
                                  <div className="comm-pharma-amounts">
                                    <div className="comm-pharma-amt">
                                      <span className="lbl">إجمالي</span>
                                      <span className="val">{fmt(pTotal)}</span>
                                    </div>
                                    {pRet > 0 && (
                                      <div className="comm-pharma-amt" style={{ color: '#7c3aed' }}>
                                        <span className="lbl">استرجاع</span>
                                        <span className="val">-{fmt(pRet)}</span>
                                      </div>
                                    )}
                                    <div className="comm-pharma-amt">
                                      <span className="lbl" style={{ color: '#15803d' }}>مستحصل</span>
                                      <span className="val" style={{ color: '#15803d' }}>{fmt(pColl)}</span>
                                    </div>
                                    <div className="comm-pharma-amt">
                                      <span className="lbl" style={{ color: pRem > 0 ? '#b91c1c' : '#15803d' }}>متبقي</span>
                                      <span className="val" style={{ color: pRem > 0 ? '#b91c1c' : '#15803d', fontWeight: 900 }}>{fmt(pRem)}</span>
                                    </div>
                                  </div>
                                </div>
                                <span className="comm-pharma-chevron">{pharmaOpen ? '▾' : '▸'}</span>
                              </div>
                              {pharmaOpen && (
                                <div className="comm-pharma-invoices">
                                  {invs.map(inv => <InvoiceCard key={inv.id} inv={inv} compact />)}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        };

        const STATUS_TABS = [
          { value: 'open',      label: 'غير مسدد', icon: '⏳' },
          { value: '',          label: 'الكل',     icon: '📋' },
          { value: 'pending',   label: 'معلق',     icon: '🕐' },
          { value: 'partial',   label: 'جزئي',     icon: '🔄' },
          { value: 'collected', label: 'مكتمل',    icon: '✅' },
        ];

        return (
        <div>
          {/* Status filter icon tabs */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '10px 0 4px' }}>
            {STATUS_TABS.map(tab => {
              const active = filterStatus === tab.value;
              return (
                <button
                  key={tab.value}
                  onClick={() => {
                    setFilterStatus(tab.value);
                    setFilterPharmacy('');
                    setShowSuggestions(false);
                    // Collapse all areas so user picks an area to drill into
                    setExpandedAreas(new Set());
                    setExpandedPharmacies(new Set());
                    // Update refs immediately before calling fetch
                    filterStatusRef.current   = tab.value;
                    filterPharmacyRef.current = '';
                    fetchInvoices('', tab.value);
                  }}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: 3, padding: '6px 12px', borderRadius: 12,
                    border: active ? '2px solid #6366f1' : '1.5px solid #e2e8f0',
                    background: active ? '#eef2ff' : '#fff',
                    color: active ? '#4338ca' : '#64748b',
                    fontWeight: active ? 700 : 500,
                    fontSize: 11, cursor: 'pointer',
                    boxShadow: active ? '0 2px 8px rgba(99,102,241,0.18)' : '0 1px 3px rgba(0,0,0,0.06)',
                    transition: 'all 0.15s',
                    minWidth: 52,
                  }}
                >
                  <span style={{ fontSize: 18, lineHeight: 1 }}>{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Filters */}
          <div className="comm-filters">
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                className="comm-input"
                placeholder="🔍 بحث بالصيدلية..."
                value={filterPharmacy}
                onChange={e => { setFilterPharmacy(e.target.value); setShowSuggestions(true); if (viewMode !== 'grouped') setViewMode('grouped'); }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              />
              {showSuggestions && pharmacySuggestions.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 100,
                  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: 4, overflow: 'hidden'
                }}>
                  {pharmacySuggestions.map(name => (
                    <div
                      key={name}
                      style={{ padding: '9px 14px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f1f5f9' }}
                      onMouseDown={() => { setFilterPharmacy(name); setShowSuggestions(false); setViewMode('grouped'); }}
                    >{name}</div>
                  ))}
                </div>
              )}
            </div>
            {(isMgr || isLead) && (
              <select className="comm-input" value={filterRep} onChange={e => setFilterRep(e.target.value)}>
                <option value="">كل المندوبين</option>
                {reps.filter(r => r.role === 'commercial_rep').map(r => (
                  <option key={r.id} value={r.id}>{r.displayName ?? r.username}</option>
                ))}
              </select>
            )}
            <input className="comm-input" type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} />
            <input className="comm-input" type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} />
          </div>

          {/* Action bar */}
          <div className="comm-action-bar">
            {canUpload && (
              <button className="comm-btn-primary" onClick={() => setCreateModal(true)}>➕ فاتورة جديدة</button>
            )}
            <span style={{ marginRight: 'auto', fontSize: 13, color: '#64748b', alignSelf: 'center' }}>
              {totalInvoices} فاتورة
            </span>
            {/* View mode toggle */}
            <div className="comm-view-toggle">
              <button
                className={`comm-view-btn ${viewMode === 'grouped' ? 'active' : ''}`}
                onClick={() => setViewMode('grouped')}
                title="عرض مجمّع"
              >⊞ مناطق</button>
              <button
                className={`comm-view-btn ${viewMode === 'list' ? 'active' : ''}`}
                onClick={() => setViewMode('list')}
                title="قائمة"
              >☰ قائمة</button>
            </div>
          </div>

          {/* Content */}
          {loading && invoices.length === 0 ? (
            <div className="comm-loading">جاري التحميل...</div>
          ) : error ? (
            <div className="comm-error">{error}</div>
          ) : !loading && invoices.length === 0 ? (
            <div className="comm-empty">لا توجد فواتير بهذه المعايير</div>
          ) : (
            <div style={{ opacity: loading ? 0.45 : 1, transition: 'opacity 0.18s', pointerEvents: loading ? 'none' : 'auto' }}>
              {viewMode === 'grouped' ? renderGroupedView() : (
                <div className="comm-inv-grid">
                  {[...invoices]
                    .sort((a, b) => new Date(a.invoiceDate).getTime() - new Date(b.invoiceDate).getTime())
                    .map(inv => <InvoiceCard key={inv.id} inv={inv} />)}
                </div>
              )}
            </div>
          )}
        </div>
        );
      }

      // ── UPLOAD / IMPORT ─────────────────────────────────────────
      case 'upload': {
        // ─ API key helpers ─────────────────────────────────────
        const loadApiKey = async () => {
          setApiKeyLoading(true);
          try {
            const r = await fetch('/api/commercial/api-key', { headers: H() });
            if (r.ok) { const d = await r.json(); setApiKey(d.apiKey ?? null); }
          } finally { setApiKeyLoading(false); }
        };
        const regenerateApiKey = async () => {
          if (!window.confirm('سيتم إنشاء مفتاح جديد وسيتوقف المفتاح القديم عن العمل فوراً. متأكد؟')) return;
          setApiKeyLoading(true);
          try {
            const r = await fetch('/api/commercial/api-key/generate', { method: 'POST', headers: H() });
            if (r.ok) { const d = await r.json(); setApiKey(d.apiKey); showToast('✅ تم إنشاء مفتاح جديد'); }
          } finally { setApiKeyLoading(false); }
        };

        // ─ Fetch from ERP ───────────────────────────────────────
        const handleFetchFromErp = async (dryRun = false) => {
          if (!erpUrl) { showToast('أدخل رابط الـ API الخارجي'); return; }
          setErpLoading(true); setErpResult(null);
          try {
            let extraHeaders: Record<string,string> = {};
            if (erpHeaders.trim()) {
              try { extraHeaders = JSON.parse(erpHeaders); } catch { showToast('الترويسات يجب أن تكون JSON صالحاً'); setErpLoading(false); return; }
            }
            let body: any = undefined;
            if (erpMethod === 'POST' && erpBody.trim()) {
              try { body = JSON.parse(erpBody); } catch { showToast('Body يجب أن يكون JSON صالحاً'); setErpLoading(false); return; }
            }
            const r = await fetch('/api/commercial/fetch-from-url', {
              method: 'POST',
              headers: { ...H(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: erpUrl, method: erpMethod, headers: extraHeaders, body, dryRun }),
            });
            const d = await r.json();
            if (!r.ok) { showToast(`⚠️ ${d.error ?? 'خطأ'}`); setErpResult(d); }
            else { setErpResult(d); if (!dryRun) { showToast(`✅ تم استيراد ${d.imported} فاتورة`); } }
          } catch (err: any) { showToast(`خطأ: ${err.message}`); }
          finally { setErpLoading(false); }
        };

        const apiEndpoint = `${window.location.origin}/api/commercial/invoices/webhook`;

        return (
          <div>
            {/* ─ Import method selector — managers only see all tabs ─ */}
            <div className="comm-import-tabs">
              <button className={`comm-import-tab ${importTab==='excel'?'active':''}`} onClick={() => setImportTab('excel')}>
                📊 ملف Excel
              </button>
              {isMgr && (
                <button className={`comm-import-tab ${importTab==='api'?'active':''}`} onClick={() => { setImportTab('api'); if (!apiKey) loadApiKey(); }}>
                  🔗 API مباشر
                </button>
              )}
              {isMgr && (
                <button className={`comm-import-tab ${importTab==='erp'?'active':''}`} onClick={() => setImportTab('erp')}>
                  🌐 نظام خارجي
                </button>
              )}
            </div>

            {/* ─────── TAB 1: Excel ─────── */}
            {importTab === 'excel' && (
              <div>
                <div className="comm-card">
                  <div className="comm-card-title">📤 رفع فواتيري من ملف Excel</div>
                  <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
                    {isRep
                      ? 'سيتم تسجيل جميع الفواتير في الملف باسمك تلقائياً — لا حاجة لعمود "اسم المندوب".'
                      : 'يجب أن يحتوي الملف على الأعمدة: رقم الفاتورة، الصيدلية، المندوب، الصنف، الكمية، السعر.'}
                  </p>
                  <div className="comm-upload-zone" onClick={() => uploadRef.current?.click()}>
                    <input ref={uploadRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleUpload} />
                    {uploadLoading ? (
                      <div className="comm-loading">⏳ جاري معالجة الملف...</div>
                    ) : (
                      <>
                        <div style={{ fontSize: 48, marginBottom: 8 }}>📊</div>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>اضغط هنا لاختيار ملف Excel</div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>أو اسحب وأفلت الملف هنا</div>
                        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>xlsx / xls / csv</div>
                      </>
                    )}
                  </div>
                  {uploadResult && (
                    <div className="comm-upload-result">
                      <div className="comm-upload-result-row comm-green"><span>✅ تم استيرادها</span><strong>{uploadResult.imported}</strong></div>
                      <div className="comm-upload-result-row"><span>📋 إجمالي في الملف</span><strong>{uploadResult.total}</strong></div>
                      {uploadResult.unmatched?.length > 0 && (
                        <div className="comm-upload-result-row comm-red"><span>⚠️ مندوبون غير موجودون</span><strong>{uploadResult.unmatched.join('، ')}</strong></div>
                      )}
                      {uploadResult.errors?.length > 0 && (
                        <div className="comm-upload-result-row comm-yellow">
                          <span>🔶 أخطاء ({uploadResult.errors.length})</span>
                          <div>{uploadResult.errors.slice(0,5).map((e: any) => <div key={e.invoiceNumber}>{e.invoiceNumber}: {e.error}</div>)}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="comm-card" style={{ marginTop: 12 }}>
                  <div className="comm-card-title">📋 قالب Excel</div>
                  <p style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>حمّل القالب لمعرفة أعمدة الاستيراد المطلوبة.</p>
                  <button className="comm-btn-ghost" onClick={() => {
                    const ws = XLSX.utils.aoa_to_sheet([
                      ['رقم الفاتورة','تاريخ الفاتورة','اسم الصيدلية','المنطقة','اسم المندوب','نوع الدفع','أيام التأجيل','آخر موعد','اسم الصنف التجاري','الاسم العلمي','الجرعة','الشكل الدوائي','الكمية','البونص','السعر','المجموع'],
                      ['INV-001','2025-01-15','صيدلية النور','الكرخ','أحمد محمد','آجل','60','2025-03-15','Panadol','Paracetamol','500mg','Tab','100','10','5000','500000'],
                    ]);
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, 'قالب');
                    XLSX.writeFile(wb, 'قالب-فواتير-تجارية.xlsx');
                  }}>⬇️ تحميل القالب</button>
                </div>
              </div>
            )}

            {/* ─────── TAB 2: API key / Webhook ─────── */}
            {importTab === 'api' && (
              <div>
                <div className="comm-card">
                  <div className="comm-card-title">🔑 مفتاح API الخاص بك</div>
                  <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
                    أعطِ هذا المفتاح لنظام الـ ERP الخاص بك حتى يتمكن من إرسال الفواتير مباشرةً بدون تسجيل دخول.
                  </p>
                  {apiKeyLoading ? (
                    <div className="comm-loading" style={{ padding: 24 }}>⏳ جاري التحميل...</div>
                  ) : apiKey ? (
                    <div>
                      <div className="comm-api-key-box">
                        <span className="comm-api-key-value" style={{ fontFamily: 'monospace', letterSpacing: 1 }}>
                          {apiKeyVisible ? apiKey : apiKey.slice(0,10) + '•'.repeat(30)}
                        </span>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button className="comm-btn-ghost" style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setApiKeyVisible(v => !v)}>
                            {apiKeyVisible ? '🙈 إخفاء' : '👁 إظهار'}
                          </button>
                          <button className="comm-btn-ghost" style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => { navigator.clipboard.writeText(apiKey); showToast('✅ تم النسخ'); }}>
                            📋 نسخ
                          </button>
                        </div>
                      </div>
                      <button className="comm-btn-ghost" style={{ marginTop: 10, fontSize: 12, color: '#ef4444' }} onClick={regenerateApiKey}>
                        🔄 إنشاء مفتاح جديد (سيُلغي القديم)
                      </button>
                    </div>
                  ) : (
                    <div>
                      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>لا يوجد مفتاح API حتى الآن.</p>
                      <button className="comm-btn-primary" onClick={regenerateApiKey} disabled={apiKeyLoading}>
                        ✨ إنشاء مفتاح API
                      </button>
                    </div>
                  )}
                </div>

                <div className="comm-card" style={{ marginTop: 12 }}>
                  <div className="comm-card-title">📡 نقطة الـ Webhook</div>
                  <div className="comm-api-info-block">
                    <div className="comm-api-info-row">
                      <span className="comm-api-badge comm-badge-post">POST</span>
                      <code className="comm-api-code">{apiEndpoint}</code>
                      <button className="comm-btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => { navigator.clipboard.writeText(apiEndpoint); showToast('✅ تم نسخ الرابط'); }}>📋</button>
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
                      أرسل header: <code style={{ background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>X-Api-Key: {'<'}مفتاحك{'>'}</code>
                    </div>
                  </div>
                </div>

                <div className="comm-card" style={{ marginTop: 12 }}>
                  <div className="comm-card-title">📄 صيغة البيانات المطلوبة (JSON)</div>
                  <pre className="comm-json-schema">{`{
  "invoices": [
    {
      "invoiceNumber": "INV-001",
      "pharmacyName":  "صيدلية النور",
      "repName":       "أحمد محمد",
      "invoiceDate":   "2025-01-15",
      "paymentType":   "deferred",
      "deferredDays":  60,
      "maxCollectionDate": "2025-03-15",
      "areaName":      "الكرخ",
      "notes":         "ملاحظة اختيارية",
      "items": [
        {
          "brandName":  "Panadol",
          "quantity":   100,
          "bonusQty":   10,
          "unitPrice":  5000,
          "totalPrice": 500000
        }
      ]
    }
  ]
}`}</pre>
                </div>
              </div>
            )}

            {/* ─────── TAB 3: Fetch from ERP ─────── */}
            {importTab === 'erp' && (
              <div>
                <div className="comm-card">
                  <div className="comm-card-title">🌐 استيراد من نظام خارجي (ERP / API)</div>
                  <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
                    أدخل رابط الـ API الخارجي وسيقوم النظام بالسحب والاستيراد تلقائياً.
                  </p>

                  <label className="comm-label">رابط API الخارجي *</label>
                  <input className="comm-input" value={erpUrl} onChange={e => setErpUrl(e.target.value)}
                    placeholder="https://erp.example.com/api/invoices" dir="ltr" />

                  <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                    <div style={{ flex: 1 }}>
                      <label className="comm-label">طريقة الطلب</label>
                      <select className="comm-input" value={erpMethod} onChange={e => setErpMethod(e.target.value as 'GET'|'POST')}>
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                      </select>
                    </div>
                  </div>

                  <label className="comm-label" style={{ marginTop: 10 }}>ترويسات مخصصة Headers (JSON — اختياري)</label>
                  <textarea className="comm-input comm-textarea" value={erpHeaders} onChange={e => setErpHeaders(e.target.value)}
                    dir="ltr" rows={3} placeholder={`{\n  "Authorization": "Bearer token123",\n  "X-Tenant-Id": "my-company"\n}`} />

                  {erpMethod === 'POST' && (
                    <>
                      <label className="comm-label" style={{ marginTop: 10 }}>Body (JSON — اختياري)</label>
                      <textarea className="comm-input comm-textarea" value={erpBody} onChange={e => setErpBody(e.target.value)}
                        dir="ltr" rows={3} placeholder={`{\n  "from": "2025-01-01",\n  "to": "2025-01-31"\n}`} />
                    </>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                    <button className="comm-btn-ghost" onClick={() => handleFetchFromErp(true)} disabled={erpLoading}>
                      🔍 معاينة (بدون استيراد)
                    </button>
                    <button className="comm-btn-primary" onClick={() => handleFetchFromErp(false)} disabled={erpLoading}>
                      {erpLoading ? '⏳ جاري الاستيراد...' : '⬇️ استيراد الآن'}
                    </button>
                  </div>

                  {erpResult && (
                    <div className="comm-upload-result" style={{ marginTop: 16 }}>
                      {erpResult.error ? (
                        <div className="comm-upload-result-row comm-red"><span>⚠️ خطأ</span><strong>{erpResult.error}</strong></div>
                      ) : erpResult.preview ? (
                        <>
                          <div className="comm-upload-result-row comm-green"><span>🔍 عدد الفواتير المكتشفة</span><strong>{erpResult.total}</strong></div>
                          <div style={{ fontSize: 12, color: '#475569', marginTop: 8 }}>عينة من البيانات (أول 5 فواتير):</div>
                          <pre className="comm-json-schema" style={{ maxHeight: 200, overflow: 'auto', marginTop: 6, fontSize: 11 }}>
                            {JSON.stringify(erpResult.preview, null, 2)}
                          </pre>
                        </>
                      ) : (
                        <>
                          <div className="comm-upload-result-row comm-green"><span>✅ تم استيرادها</span><strong>{erpResult.imported}</strong></div>
                          <div className="comm-upload-result-row"><span>📋 إجمالي</span><strong>{erpResult.total}</strong></div>
                          {erpResult.unmatched?.length > 0 && (
                            <div className="comm-upload-result-row comm-red"><span>⚠️ مندوبون غير موجودون</span><strong>{erpResult.unmatched.join('، ')}</strong></div>
                          )}
                          {erpResult.errors?.length > 0 && (
                            <div className="comm-upload-result-row comm-yellow">
                              <span>🔶 أخطاء ({erpResult.errors.length})</span>
                              <div>{erpResult.errors.slice(0,5).map((e: any, i: number) => <div key={i}>{e.invoiceNumber}: {e.error}</div>)}</div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="comm-card" style={{ marginTop: 12 }}>
                  <div className="comm-card-title">ℹ️ صيغ البيانات المدعومة</div>
                  <ul style={{ fontSize: 13, color: '#475569', lineHeight: 2, paddingRight: 18 }}>
                    <li>JSON: <code style={{ background:'#f1f5f9',padding:'1px 6px',borderRadius:4 }}>{`{ "invoices": [...] }`}</code></li>
                    <li>JSON: <code style={{ background:'#f1f5f9',padding:'1px 6px',borderRadius:4 }}>{`{ "data": [...] }`}</code></li>
                    <li>JSON: مصفوفة مباشرة <code style={{ background:'#f1f5f9',padding:'1px 6px',borderRadius:4 }}>{`[{...}, {...}]`}</code></li>
                    <li>Excel: ملف .xlsx يُرجعه الـ API (نفس أعمدة القالب)</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        );
      }

      // ── PHARMACIES ───────────────────────────────────────────────
      case 'pharmacies': return (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>🏥 دليل الصيدليات ({pharmacies.length})</div>
            {canUpload && (
              <button className="comm-btn-primary" onClick={() => setPharmaModal(true)}>➕ صيدلية جديدة</button>
            )}
          </div>
          {pharmacies.length === 0 ? (
            <div className="comm-empty">لا توجد صيدليات مسجلة</div>
          ) : (
            <div className="comm-pharma-grid">
              {pharmacies.map(p => (
                <div key={p.id} className="comm-pharma-card">
                  <div style={{ fontWeight: 700, fontSize: 14 }}>🏥 {p.name}</div>
                  {p.ownerName && <div style={{ fontSize: 12, color: '#475569' }}>👤 {p.ownerName}</div>}
                  {p.phone && <div style={{ fontSize: 12, color: '#475569' }}>📞 {p.phone}</div>}
                  {p.areaName && <div style={{ fontSize: 12, color: '#64748b' }}>📍 {p.areaName}</div>}
                  {!p.isActive && <span style={{ fontSize: 11, background: '#fee2e2', color: '#b91c1c', borderRadius: 12, padding: '1px 8px' }}>غير نشط</span>}
                </div>
              ))}
            </div>
          )}
          {/* Add pharmacy modal */}
          {pharmaModal && (
            <div className="comm-modal-overlay" onClick={() => setPharmaModal(false)}>
              <div className="comm-modal" onClick={e => e.stopPropagation()}>
                <div className="comm-modal-header">
                  <button className="comm-close-btn" onClick={() => setPharmaModal(false)}>✕</button>
                  <h3>🏥 إضافة صيدلية</h3>
                </div>
                <div className="comm-modal-body">
                  <label className="comm-label">اسم الصيدلية *</label>
                  <input className="comm-input" value={newPharma.name} onChange={e => setNewPharma(p => ({ ...p, name: e.target.value }))} />
                  <label className="comm-label">صاحب الصيدلية</label>
                  <input className="comm-input" value={newPharma.ownerName} onChange={e => setNewPharma(p => ({ ...p, ownerName: e.target.value }))} />
                  <label className="comm-label">رقم الهاتف</label>
                  <input className="comm-input" value={newPharma.phone} onChange={e => setNewPharma(p => ({ ...p, phone: e.target.value }))} />
                  <label className="comm-label">المنطقة</label>
                  <input className="comm-input" value={newPharma.areaName} onChange={e => setNewPharma(p => ({ ...p, areaName: e.target.value }))} />
                  <label className="comm-label">العنوان</label>
                  <input className="comm-input" value={newPharma.address} onChange={e => setNewPharma(p => ({ ...p, address: e.target.value }))} />
                </div>
                <div className="comm-modal-footer">
                  <button className="comm-btn-secondary" onClick={() => setPharmaModal(false)}>إلغاء</button>
                  <button className="comm-btn-primary" onClick={submitCreatePharmacy} disabled={pharmaSaving}>
                    {pharmaSaving ? '⏳' : '✅ إضافة'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      );

      // ── NOTIFICATIONS ──────────────────────────────────────────
      case 'notifs': return (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>🔔 الإشعارات</div>
            {unreadCount > 0 && (
              <button className="comm-btn-ghost" onClick={markAllRead}>✓ قراءة الكل</button>
            )}
          </div>
          {notifs.length === 0 ? (
            <div className="comm-empty">لا توجد إشعارات</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {notifs.map(n => (
                <div
                  key={n.id}
                  className={`comm-notif-row ${n.isRead ? '' : 'comm-notif-unread'}`}
                  onClick={() => { if (!n.isRead) markRead(n.id); }}
                  style={{ cursor: n.isRead ? 'default' : 'pointer' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{n.title}</div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{n.body}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{fmtDate(n.createdAt)}</div>
                    </div>
                    {!n.isRead && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', flexShrink: 0, marginTop: 4 }} />}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );

      // ── VISITS ─────────────────────────────────────────────────
      case 'visits': return (
        <div className="comm-card">
          <div className="comm-card-title">🏥 الزيارات الميدانية</div>
          <div className="comm-empty">قريباً — سيتم إضافة سجل الزيارات الميدانية</div>
        </div>
      );

      default: return null;
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  // ── MAIN RENDER ──────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────
  return (
    <div className="comm-shell" dir="rtl">
      {/* Toast */}
      {toast && (
        <div className="comm-toast">{toast}</div>
      )}

      {/* Page header */}
      <div className="comm-page-header">
        <div>
          <h1 className="comm-page-title">💰 القسم التجاري</h1>
          <div className="comm-page-sub">
            {isRep ? ''
             : isLead ? 'لوحة متابعة الفريق التجاري'
             : 'إدارة الفواتير والاستحصالات التجارية'}
          </div>
        </div>
      </div>

      {/* Tabs — hidden for rep, shown for others */}
      {!isRep && (
        <div className="comm-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`comm-tab ${activeTab === tab.id ? 'comm-tab--active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon} {tab.label}
              {tab.id === 'notifs' && unreadCount > 0 && (
                <span className="comm-tab-badge">{unreadCount}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="comm-content" style={isRep ? { paddingBottom: 76 } : undefined}>
        {renderTabContent()}
      </div>

      {/* Bottom nav for rep */}
      {isRep && (
        <nav style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          height: 62, background: '#fff',
          borderTop: '1px solid #e2e8f0',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.08)',
          zIndex: 200, display: 'flex', alignItems: 'stretch',
        }}>
          {tabs.map(tab => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 2,
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '6px 2px', position: 'relative',
                  color: active ? '#8B1C1C' : '#64748b',
                  borderTop: active ? '2.5px solid #8B1C1C' : '2.5px solid transparent',
                  transition: 'color 0.15s',
                }}
              >
                <span style={{ fontSize: 20, lineHeight: 1 }}>{tab.icon}</span>
                <span style={{ fontSize: 9.5, fontWeight: active ? 700 : 600, whiteSpace: 'nowrap' }}>{tab.label}</span>
                {tab.id === 'notifs' && unreadCount > 0 && (
                  <span style={{ position: 'absolute', top: 4, right: '25%', background: '#8B1C1C', color: '#fff', fontSize: 9, fontWeight: 800, borderRadius: 10, padding: '1px 4px', minWidth: 14, textAlign: 'center' }}>{unreadCount}</span>
                )}
              </button>
            );
          })}
        </nav>
      )}

      {/* Modals */}
      {renderPickModal()}
      {renderInvoiceDetail()}
      {renderCollectModal()}
      {renderCreateModal()}

      {/* Pharmacy voice recording overlay */}
      {pharmVoiceOverlay && (
        <div
          dir="rtl"
          onClick={stopPharmVoice}
          style={{
            position: 'fixed', inset: 0, zIndex: 99999,
            background: 'rgba(15, 10, 40, 0.72)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div onClick={e => e.stopPropagation()} style={{
            background: '#fff', borderRadius: 24, padding: '40px 48px',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 20, boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
            minWidth: 280, textAlign: 'center',
          }}>
            {/* Animated mic */}
            <div style={{ position: 'relative', width: 80, height: 80 }}>
              <div style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                background: 'rgba(239,68,68,0.18)',
                animation: 'commRecRipple 1.4s ease-out infinite',
              }} />
              <div style={{
                position: 'absolute', inset: 8, borderRadius: '50%',
                background: 'rgba(239,68,68,0.25)',
                animation: 'commRecRipple 1.4s ease-out 0.3s infinite',
              }} />
              <div style={{
                position: 'absolute', inset: 16, borderRadius: '50%',
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 26, boxShadow: '0 4px 16px rgba(239,68,68,0.5)',
              }}>🎙️</div>
            </div>

            <div>
              <div style={{ fontWeight: 700, fontSize: 18, color: '#1e293b' }}>جاري البحث الصوتي...</div>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 6 }}>قل اسم الصيدلية، ثم اضغط إنهاء عند الانتهاء</div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: '#ef4444', display: 'inline-block',
                animation: 'commRecPulse 1s ease-in-out infinite',
              }} />
              <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600 }}>تسجيل نشط</span>
            </div>

            <button
              onClick={stopPharmVoice}
              style={{
                marginTop: 4, padding: '12px 36px', borderRadius: 12,
                border: 'none',
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(239,68,68,0.4)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              ⏹ إنهاء التسجيل
            </button>
          </div>
        </div>
      )}

      {/* ── Floating Action Button: tap = pick-pharmacy / hold 600ms = voice ── */}
      {(isRep || canCollect) && !pickModal && !collectModal && !selectedInv && (
        <div className="fab-ring">
          <button
            onMouseDown={() => {
              fabLongFiredRef.current = false;
              fabHoldTimerRef.current = setTimeout(() => {
                fabLongFiredRef.current = true;
                startVoicePickPharmacy();
              }, 600);
            }}
            onTouchStart={e => {
              e.preventDefault();
              fabLongFiredRef.current = false;
              fabHoldTimerRef.current = setTimeout(() => {
                fabLongFiredRef.current = true;
                startVoicePickPharmacy();
              }, 600);
            }}
            onMouseUp={() => {
              if (fabHoldTimerRef.current) { clearTimeout(fabHoldTimerRef.current); fabHoldTimerRef.current = null; }
              if (!fabLongFiredRef.current) { setPickQuery(''); setPickModal(true); setPickPharmName(null); setPickPharmInvs([]); }
            }}
            onMouseLeave={() => { if (fabHoldTimerRef.current) { clearTimeout(fabHoldTimerRef.current); fabHoldTimerRef.current = null; } }}
            onTouchEnd={e => {
              e.preventDefault();
              if (fabHoldTimerRef.current) { clearTimeout(fabHoldTimerRef.current); fabHoldTimerRef.current = null; }
              if (!fabLongFiredRef.current) { try { navigator.vibrate?.(40); } catch {} setPickQuery(''); setPickModal(true); setPickPharmName(null); setPickPharmInvs([]); }
            }}
            title="اضغط: إنشاء استحصال | اضغط مطوّل: بحث صوتي"
            style={{
              width: 56, height: 56, borderRadius: '50%',
              background: 'linear-gradient(135deg, #8B1A1A, #6b1414)',
              color: '#fff', border: 'none', fontSize: 28, fontWeight: 700,
              cursor: 'pointer', boxShadow: '0 4px 20px rgba(139,26,26,0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              position: 'relative', zIndex: 1, lineHeight: 1,
              userSelect: 'none', WebkitUserSelect: 'none',
            }}
          >+</button>
        </div>
      )}

      <style>{`
        @keyframes commRecPulse  { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(1.3)} }
        @keyframes commRecRipple { 0%{transform:scale(0.8);opacity:0.8} 100%{transform:scale(1.8);opacity:0} }
      `}</style>
    </div>
  );
}
