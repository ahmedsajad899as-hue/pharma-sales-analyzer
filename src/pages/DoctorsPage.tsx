import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useBackHandler } from '../hooks/useBackHandler';
import { useAuth } from '../context/AuthContext';
import DoctorVisitsImportModal from '../components/DoctorVisitsImportModal';
import { Icon } from '../config/icons';

const API = import.meta.env.VITE_API_URL || '';

// ── Smart Search Component ─────────────────────────────────────
function SmartSearch({ value, onChange, suggestions, placeholder, style }: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = value.trim().toLowerCase();
  const filtered = q.length >= 1
    ? suggestions.filter(s => s.toLowerCase().includes(q) && s.toLowerCase() !== q).slice(0, 8)
    : [];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder || 'بحث...'}
        style={{ width: '100%', padding: '7px 12px', borderRadius: 8, border: '1.5px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', direction: 'rtl' }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 200,
          background: '#fff', border: '1px solid var(--c-border)', borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.1)', marginTop: 2, overflow: 'hidden',
        }}>
          {filtered.map(s => (
            <div key={s} onMouseDown={() => { onChange(s); setOpen(false); }}
              style={{ padding: '8px 14px', cursor: 'pointer', fontSize: 13, direction: 'rtl', borderBottom: '1px solid var(--c-border-light)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-bg)')}
              onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Area   { id: number; name: string; }
interface Item   { id: number; name: string; }
interface Doctor {
  id: number;
  name: string;
  specialty?: string;
  pharmacyName?: string;
  className?: string;
  notes?: string;
  isActive: boolean;
  area?: Area;
  targetItem?: Item;
}

interface VisitRecord {
  id: number;
  visitDate: string;
  feedback: string;
  notes?: string;
  item?: Item;
}
interface VisitDoctor {
  id: number; name: string; specialty?: string;
  pharmacyName?: string;
  area?: { id: number; name: string };
  targetItem?: Item; isActive: boolean;
  visited: boolean; isWriting: boolean;
  visits: VisitRecord[];
}
interface VisitArea {
  id: number | null; name: string;
  totalDoctors: number; visitedCount: number; writingCount: number;
  doctors: VisitDoctor[];
}

const FEEDBACK_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  writing:       { label: 'يكتب ✓',        color: 'var(--c-accent)', bg: 'var(--c-accent-light)' },
  interested:    { label: 'مهتم',           color: 'var(--c-text-secondary)', bg: 'var(--c-bg)' },
  stocked:       { label: 'مخزن',           color: 'var(--c-text-secondary)', bg: 'var(--c-bg)' },
  not_interested:{ label: 'غير مهتم',       color: 'var(--c-text-secondary)', bg: 'var(--c-bg)' },
  unavailable:   { label: 'غير متواجد',     color: 'var(--c-text-muted)', bg: 'var(--c-bg)' },
  pending:       { label: 'لم يُقرر',       color: 'var(--c-text-muted)', bg: 'var(--c-bg)' },
};

function fmt(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
}

interface NetPharm {
  name: string; areaName: string; repName?: string;
  totalOrders: number; totalValue: number;
  returnsQty: number; returnsValue: number;
  lastOrder: string | null;
}

interface PharmOrderEntry { date: string; qty: number; value: number; rep: string; type: string; }
interface PharmByItem { name: string; orders: PharmOrderEntry[]; totalQty: number; totalValue: number; }
interface PharmDetailData { byItem: PharmByItem[]; totalOrders: number; }

function normPharm(s: string) {
  let r = String(s || '').trim()
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْٰ]/g, '').replace(/ـ/g, '')
    .replace(/\s+/g, ' ').toLowerCase();
  // Step 1: strip full named noise words at start (after normalisation so ة→ه applied)
  r = r.replace(/^(الصيدليه|صيدليه|العميل|الزبون|الاسم)\s*/, '').trim();
  // Step 2: strip "ص" used as abbreviation for صيدلية — only when NOT followed by
  //         another Arabic letter (so "صوفيا" is safe), strip any trailing punctuation/slashes
  r = r.replace(/^ص(?!\p{L})[\s/\\.,،:;*\-]*/u, '').trim();
  return r;
}

function findNetMatches(pharmName: string, list: NetPharm[], areaName?: string | null): { exact: NetPharm | null; similar: NetPharm[] } {
  const q = normPharm(pharmName);
  const exact = list.find(p => normPharm(p.name) === q) ?? null;
  // When areaName provided, restrict similar matches to that area only
  const pool = areaName
    ? list.filter(p => normPharm(p.areaName) === normPharm(areaName))
    : list;
  const similar = pool.filter(p => {
    const n = normPharm(p.name);
    return n !== q && (n.includes(q) || q.includes(n));
  }).slice(0, 6);
  return { exact, similar };
}

function getAreaPharmStats(
  doctors: Array<{ pharmacyName?: string | null }>,
  netList: NetPharm[]
): { total: number; withSales: string[]; withReturnsOnly: string[]; noData: string[] } {
  const names = [...new Set(
    doctors.map(d => d.pharmacyName?.trim()).filter((n): n is string => Boolean(n))
  )];
  const withSales: string[] = [];
  const withReturnsOnly: string[] = [];
  const noData: string[] = [];
  for (const name of names) {
    const { exact } = findNetMatches(name, netList);
    if (exact && exact.totalValue > 0) withSales.push(name);
    else if (exact) withReturnsOnly.push(name);
    else noData.push(name);
  }
  return { total: names.length, withSales, withReturnsOnly, noData };
}

// O(1) lookup version — uses a pre-normalised Map instead of scanning the array
// Deduplication is done by NORMALISED name so "ص الوافي" and "الوافي" count as one
function getAreaPharmStatsFast(
  doctors: Array<{ pharmacyName?: string | null }>,
  normMap: Map<string, NetPharm>
): { total: number; withSales: string[]; withReturnsOnly: string[]; noData: string[] } {
  // Build a map: normalisedKey → first raw name seen (deduplicates by normalised name)
  const seen = new Map<string, string>();
  for (const d of doctors) {
    const raw = d.pharmacyName?.trim();
    if (!raw) continue;
    const key = normPharm(raw);
    if (!seen.has(key)) seen.set(key, raw);
  }
  const withSales: string[] = [];
  const withReturnsOnly: string[] = [];
  const noData: string[] = [];
  for (const [normKey, rawName] of seen) {
    const exact = normMap.get(normKey) ?? null;
    if (exact && exact.totalValue > 0) withSales.push(rawName);
    else if (exact) withReturnsOnly.push(rawName);
    else noData.push(rawName);
  }
  return { total: seen.size, withSales, withReturnsOnly, noData };
}

export default function DoctorsPage() {
  const { token, user, hasFeature } = useAuth();
  const isCommercialRep = user?.role === 'commercial_rep';
  const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'commercial_rep'];
  const isFieldRep  = FIELD_ROLES.includes(user?.role ?? '');
  const canSeePharmNet = ['company_manager', 'team_leader'].includes(user?.role ?? '');
  const showDoctorFields    = hasFeature('doctor_fields');
  const showVisitAnalysis   = hasFeature('visit_analysis_tab');
  const showDoctorsList     = hasFeature('doctors_list_tab');
  const showMyVisits        = hasFeature('my_visits_tab');
  const showPharmacies      = hasFeature('pharmacies_tab');
  const showArchiveTab      = hasFeature('archive_tab');
  const showVisitsImport    = hasFeature('visits_import');
  const [showVisitsImportModal, setShowVisitsImportModal] = useState(false);
  const [visitsImportMsg, setVisitsImportMsg] = useState('');
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  // ── Tab ──────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'list' | 'visits' | 'pharmacies' | 'myvisits' | 'archive'>(() => {
    // Always open on the Visits tab when it's available (user preference) —
    // ignore the previously-saved tab so entering the page always lands on الزيارات.
    if (showVisitAnalysis) return 'visits';
    if (showArchiveTab) return 'archive';
    const saved = localStorage.getItem('doctors_active_tab');
    return (saved && ['list','visits','pharmacies','myvisits','archive'].includes(saved)) ? saved as any : 'list';
  });
  useEffect(() => { localStorage.setItem('doctors_active_tab', activeTab); }, [activeTab]);

  // Redirect away from a tab that was disabled via permissions
  useEffect(() => {
    const allowed: Record<string, boolean> = {
      visits:      showVisitAnalysis,
      list:        showDoctorsList,
      myvisits:    isCommercialRep && showMyVisits,
      pharmacies:  isCommercialRep && showPharmacies,
      archive:     showArchiveTab,
    };
    if (!allowed[activeTab]) {
      const fallback = (['visits', 'list', 'archive', 'myvisits', 'pharmacies'] as const).find(t => allowed[t]);
      if (fallback) setActiveTab(fallback);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVisitAnalysis, showDoctorsList, showMyVisits, showPharmacies, showArchiveTab]);

  // ── Doctors list ─────────────────────────────────────────────
  const [doctors, setDoctors]   = useState<Doctor[]>([]);
  const [areas, setAreas]       = useState<Area[]>([]);
  const [items, setItems]       = useState<Item[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [filterArea, setFilterArea] = useState<string>('all');
  const [filterClass, setFilterClass] = useState<string>('all');

  // modal
  const [modal, setModal]     = useState<'add' | 'edit' | null>(null);
  const [selected, setSelected] = useState<Doctor | null>(null);
  const [saving, setSaving]   = useState(false);

  // form
  const [fName, setFName]               = useState('');
  const [fSpecialty, setFSpecialty]     = useState('');
  const [fPharmacy, setFPharmacy]       = useState('');
  const [fNotes, setFNotes]             = useState('');
  const [fAreaId, setFAreaId]           = useState('');
  const [fAreaName, setFAreaName]       = useState('');
  const [fAreaSugg, setFAreaSugg]       = useState<Area[]>([]);
  const [fAreaShowSugg, setFAreaShowSugg] = useState(false);
  const [fItemId, setFItemId]           = useState('');
  const [fItemName, setFItemName]       = useState('');
  const [fItemSugg, setFItemSugg]       = useState<Item[]>([]);
  const [fItemShowSugg, setFItemShowSugg] = useState(false);
  const [fActive, setFActive]           = useState(true);

  // excel import
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting]     = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number; skipped: number; errors: any[];
    colMap?: Record<string, string | null>;
    detectedCols?: string[];
    error?: string; hint?: string;
  } | null>(null);
  const [showImportPanel, setShowImportPanel] = useState(false);

  // ── Visits analysis ─────────────────────────────────────────
  const [visitAreas, setVisitAreas]         = useState<VisitArea[]>([]);
  const [noAreaStats, setNoAreaStats]       = useState<{ total: number; visited: number; writing: number }>({ total: 0, visited: 0, writing: 0 });
  const [visitLoading, setVisitLoading]     = useState(false);
  const [visitMonthFilter, setVisitMonthFilter] = useState<{ month: number; year: number } | null>(null);
  const [showVisitMonthPicker, setShowVisitMonthPicker] = useState(false);
  // ── Rep filter (for managers only) ─────────────────────────
  interface ManagerRep { userId: number; name: string; linkedRepId: number | null; }
  const [managerReps, setManagerReps]       = useState<ManagerRep[]>([]);
  const [visitRepFilter, setVisitRepFilter] = useState<number | null>(null); // null = all
  // Manager wishlist view — show each rep's wishlist
  interface RepWishEntry { doctorId: number; doctorName: string; specialty?: string; pharmacyName?: string; areaName?: string; itemName?: string; }
  interface RepWishData  { rep: { id: number; name: string }; wishlist: RepWishEntry[]; loading: boolean; open: boolean; openDetails: Set<number>; }
  const [repWishlists, setRepWishlists]     = useState<Record<number, RepWishData>>({});
  const [teamWishList, setTeamWishList]     = useState<Array<{ rep: { id: number; name: string }; wishlist: RepWishEntry[] }>>([]);
  const [teamWishLoaded, setTeamWishLoaded] = useState(false);
  const [teamWishLoading, setTeamWishLoading] = useState(false);
  const [teamWishPanelOpen, setTeamWishPanelOpen] = useState(false);

  const loadTeamWishlists = () => {
    if (teamWishLoading) return;
    setTeamWishLoading(true);
    fetch(`${API}/api/doctors/wishlist/teams`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { teams: [] })
      .then(data => {
        const teams: Array<{ rep: { id: number; name: string }; wishlist: RepWishEntry[] }> = data.teams ?? [];
        setTeamWishList(teams);
        setTeamWishLoaded(true);
        setTeamWishLoading(false);
        setRepWishlists(prev => {
          const next = { ...prev };
          for (const t of teams) {
            next[t.rep.id] = { rep: t.rep, wishlist: t.wishlist, loading: false, open: prev[t.rep.id]?.open ?? false, openDetails: prev[t.rep.id]?.openDetails ?? new Set() };
          }
          return next;
        });
      })
      .catch(() => { setTeamWishLoaded(true); setTeamWishLoading(false); });
  };

  const loadRepWishlist = (repUserId: number) => {
    setRepWishlists(prev => ({ ...prev, [repUserId]: { ...(prev[repUserId] ?? { rep: { id: repUserId, name: '' }, wishlist: [], openDetails: new Set() }), loading: true, open: true } }));
    fetch(`${API}/api/doctors/wishlist/rep/${repUserId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { rep: { id: repUserId, name: '—' }, wishlist: [] })
      .then(data => setRepWishlists(prev => ({ ...prev, [repUserId]: { rep: data.rep, wishlist: data.wishlist ?? [], loading: false, open: true, openDetails: prev[repUserId]?.openDetails ?? new Set() } })))
      .catch(() => setRepWishlists(prev => ({ ...prev, [repUserId]: { ...prev[repUserId], loading: false } })));
  };
  const [expandedAreas, setExpandedAreas]   = useState<Set<string>>(new Set());
  const [visitSearch, setVisitSearch]       = useState('');
  const [showOnlyVisited, setShowOnlyVisited] = useState(false);  const [showCoveragePopup, setShowCoveragePopup] = useState(false);
  const coverageCardRef = useRef<HTMLDivElement>(null);
  const [showTotalPopup, setShowTotalPopup] = useState(false);
  const totalCardRef = useRef<HTMLDivElement>(null);
  const [expandedVisits, setExpandedVisits] = useState<Set<number>>(new Set());
  const [openItemDropdowns, setOpenItemDropdowns] = useState<Set<number>>(new Set());
  const toggleItemDrop = (id: number, force?: boolean) => setOpenItemDropdowns(prev => {
    const next = new Set(prev);
    const open = force !== undefined ? force : !next.has(id);
    open ? next.add(id) : next.delete(id);
    return next;
  });
  // Per-user localStorage keys — prevents one user seeing another user's wish list
  const wishKey  = `wishedDoctors_${user?.id ?? 'guest'}`;
  const itemsKey = `wishedItems_${user?.id ?? 'guest'}`;
  const namesKey = `wishedDoctorNames_${user?.id ?? 'guest'}`;
  const infoKey  = `wishedDoctorInfo_${user?.id ?? 'guest'}`;

  const [wishedDoctors, setWishedDoctors] = useState<Set<number>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`wishedDoctors_${user?.id ?? 'guest'}`) || '[]')); }
    catch { return new Set(); }
  });
  const [wishedItems, setWishedItems] = useState<Record<number, string>>(() => {
    try { return JSON.parse(localStorage.getItem(`wishedItems_${user?.id ?? 'guest'}`) || '{}'); }
    catch { return {}; }
  });
  // Doctor id→name cache stored so MonthlyPlansPage can display names
  const [wishedNames, setWishedNames] = useState<Record<number, string>>(() => {
    try { return JSON.parse(localStorage.getItem(`wishedDoctorNames_${user?.id ?? 'guest'}`) || '{}'); }
    catch { return {}; }
  });
  // Extra doctor info (specialty, pharmacy, area, addedBy)
  const [wishedInfo, setWishedInfo] = useState<Record<number, { specialty?: string; pharmacyName?: string; areaName?: string; addedBy?: string }>>(() => {
    try { return JSON.parse(localStorage.getItem(`wishedDoctorInfo_${user?.id ?? 'guest'}`) || '{}'); }
    catch { return {}; }
  });
  const [openWishDetails, setOpenWishDetails] = useState<Set<number>>(new Set());
  const [showWishPanel, setShowWishPanel] = useState(false);
  const [wishSyncing, setWishSyncing] = useState(false);
  const [wishSyncMsg, setWishSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const syncWishlistToBackend = async () => {
    if (wishSyncing) return;
    setWishSyncing(true);
    setWishSyncMsg(null);
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const ids = [...wishedDoctors];
    if (ids.length === 0) {
      setWishSyncing(false);
      setWishSyncMsg({ ok: true, text: 'لا يوجد أطباء للمزامنة' });
      setTimeout(() => setWishSyncMsg(null), 3000);
      return;
    }
    let failed = 0;
    let errMsg = '';
    await Promise.all(ids.map(async docId => {
      const info = wishedInfo[docId] ?? {};
      try {
        const r = await fetch(`${API}/api/doctors/wishlist`, {
          method: 'POST', headers: h,
          body: JSON.stringify({ doctorId: docId, itemName: wishedItems[docId] ?? undefined, specialty: info.specialty, pharmacyName: info.pharmacyName, areaName: info.areaName }),
        });
        if (!r.ok) {
          failed++;
          const j = await r.json().catch(() => ({}));
          errMsg = j?.error ?? j?.message ?? `status ${r.status}`;
        }
      } catch (e: any) { failed++; errMsg = e?.message ?? 'network error'; }
    }));
    setWishSyncing(false);
    if (failed > 0) {
      setWishSyncMsg({ ok: false, text: `فشل ${failed} من ${ids.length} — ${errMsg}` });
    } else {
      setWishSyncMsg({ ok: true, text: `✓ تمت مزامنة ${ids.length} طبيب` });
    }
    setTimeout(() => setWishSyncMsg(null), 6000);
  };
  const [showWritingPopup, setShowWritingPopup] = useState(false);

  // ── Visits analysis toggle (doctors vs pharmacies) ─────────────
  const [visitAnalysisType, setVisitAnalysisType] = useState<'doctors' | 'pharmacies'>('doctors');
  // pharmacy visits state
  interface PharmVisitItem { id: number; name: string; }
  interface PharmVisitRecord { id: number; visitDate: string; notes?: string | null; items: PharmVisitItem[]; }
  interface PharmEntry { name: string; visits: PharmVisitRecord[]; }
  interface PharmAreaGroup { id: number | null; name: string; pharmacies: PharmEntry[]; totalPharmacies: number; totalVisits: number; }
  const [pharmVisitAreas, setPharmVisitAreas]       = useState<PharmAreaGroup[]>([]);
  const [pharmVisitLoading, setPharmVisitLoading]   = useState(false);
  const [pharmVisitMonthFilter, setPharmVisitMonthFilter] = useState<{ month: number; year: number } | null>(null);
  const [showPharmMonthPicker, setShowPharmMonthPicker] = useState(false);
  const [pharmExpandedAreas, setPharmExpandedAreas] = useState<Set<string>>(new Set());
  const [pharmSearch, setPharmSearch]               = useState('');
  const [expandedPharma, setExpandedPharma]         = useState<Set<string>>(new Set());

  // ── Visit fetch: abort + cache refs (for instant rep-switching) ────────────
  const visitFetchAbortRef      = useRef<AbortController | null>(null);
  const pharmVisitFetchAbortRef = useRef<AbortController | null>(null);
  const visitCacheRef      = useRef(new Map<string, { areas: VisitArea[]; noAreaStats: { total: number; visited: number; writing: number } }>());
  const pharmVisitCacheRef = useRef(new Map<string, PharmAreaGroup[]>());

  // ── Survey pharmacies (for commercial rep) ───────────────────
  interface SurveyPharmacy { id: number; name: string; ownerName?: string | null; phone?: string | null; address?: string | null; areaName?: string | null; area?: { id: number; name: string } | null; }
  const [surveyPharmacies, setSurveyPharmacies]         = useState<SurveyPharmacy[]>([]);
  const [surveyPharmLoading, setSurveyPharmLoading]     = useState(false);
  const [surveyPharmSearch, setSurveyPharmSearch]       = useState('');
  const [surveyPharmArea, setSurveyPharmArea]           = useState('all');
  const [surveyPharmLoaded, setSurveyPharmLoaded]       = useState(false);
  // Add pharmacy modal state
  const [pharmModal, setPharmModal]                     = useState<'add' | 'edit' | null>(null);
  const [pharmEditTarget, setPharmEditTarget]           = useState<SurveyPharmacy | null>(null);
  const [pharmFName, setPharmFName]                     = useState('');
  const [pharmFOwner, setPharmFOwner]                   = useState('');
  const [pharmFPhone, setPharmFPhone]                   = useState('');
  const [pharmFAddress, setPharmFAddress]               = useState('');
  const [pharmFAreaName, setPharmFAreaName]             = useState('');
  const [pharmSaving, setPharmSaving]                   = useState(false);
  const [pharmSaveErr, setPharmSaveErr]                 = useState('');
  // Import pharmacies state
  const [showPharmImport, setShowPharmImport]           = useState(false);
  const [pharmImporting, setPharmImporting]             = useState(false);
  const [pharmImportResult, setPharmImportResult]       = useState<{ imported: number; skipped: number; errors: {name:string;error:string}[]; detectedCols?: Record<string,string> } | null>(null);
  const pharmFileRef = useRef<HTMLInputElement>(null);
  const [writingItemFilter, setWritingItemFilter] = useState<string | null>(null);
  const [showVisitedPopup, setShowVisitedPopup] = useState(false);
  const [expandedDocIds, setExpandedDocIds] = useState<Set<number>>(() => new Set<number>());
  const toggleDocExpand = (id: number) => setExpandedDocIds(prev => { const s = new Set<number>(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const writingCardRef = useRef<HTMLDivElement>(null);
  const visitedCardRef = useRef<HTMLDivElement>(null);

  // ── Archive tab state ────────────────────────────────────────
  interface ArchiveDoctor {
    entryId: number | null; ownerUserId?: number | null; surveyDoctorId: number | null; doctorId?: number | null;
    name: string; specialty: string | null; areaName: string | null; pharmacyName: string | null; className: string | null;
    isVisited: boolean; isWriting: boolean; visitItems: string[]; writingItems: string[]; notes: string | null;
  }
  interface ArchiveArea { name: string; doctors: ArchiveDoctor[]; }
  const [archiveAreas, setArchiveAreas]           = useState<ArchiveArea[]>([]);
  const [archiveLoading, setArchiveLoading]       = useState(false);
  const [archiveTotal, setArchiveTotal]           = useState(0);
  const [archiveTotalVisited, setArchiveTotalVisited] = useState(0);
  const [archiveTotalWriting, setArchiveTotalWriting] = useState(0);
  const archiveStarKey = `archiveStarred_${user?.id ?? 'guest'}`;
  const [archiveStarred, setArchiveStarred]       = useState<Set<number>>(() => {
    try { return new Set<number>(JSON.parse(localStorage.getItem(`archiveStarred_${user?.id ?? 'guest'}`) || '[]')); }
    catch { return new Set<number>(); }
  });
  const [showArchiveWishPanel, setShowArchiveWishPanel] = useState(false);
  const [archiveSearch, setArchiveSearch]         = useState('');
  const [archiveAreaFilter, setArchiveAreaFilter] = useState('all');
  const [archiveExpandedAreas, setArchiveExpandedAreas] = useState<Set<string>>(new Set());
  const [archiveSubPopup, setArchiveSubPopup]     = useState<null | 'visited' | 'writing' | 'items'>(null);
  const [archiveRepFilter, setArchiveRepFilter]   = useState<number | null>(null);
  // ايتمات مقيّدة بشركات المندوب المعروض أرشيفه (null = استخدم items العامة)
  const [archiveRepItems, setArchiveRepItems]     = useState<Item[] | null>(null);
  const [importingFromVisits, setImportingFromVisits] = useState(false);
  const [importFromVisitsResult, setImportFromVisitsResult] = useState<{ imported: number; alreadyExists: number; total: number } | null>(null);
  // Add from survey modal
  const [showAddModal, setShowAddModal]           = useState(false);
  const [surveyDoctors, setSurveyDoctors]         = useState<{ id: number; name: string; specialty: string | null; areaName: string | null; pharmacyName: string | null; className: string | null }[]>([]);
  const [surveyDocLoading, setSurveyDocLoading]   = useState(false);
  const [surveyDocSearch, setSurveyDocSearch]     = useState('');
  const [surveyDocSelectedAreas, setSurveyDocSelectedAreas] = useState<Set<string>>(new Set()); // empty = all
  const [showAreaDropdown, setShowAreaDropdown]   = useState(false);
  const [addingIds, setAddingIds]                 = useState<Set<number>>(new Set());
  const [importingAll, setImportingAll]           = useState(false);
  // Inline item input per doctor
  const [itemInputId, setItemInputId]             = useState<number | null>(null);
  const [itemInputVal, setItemInputVal]           = useState('');
  // Inline visit item input per doctor
  const [visitItemInputId, setVisitItemInputId]   = useState<number | null>(null);
  const [visitItemInputVal, setVisitItemInputVal] = useState('');
  // Inline notes edit
  const [notesEditId, setNotesEditId]             = useState<number | null>(null);
  const [notesEditVal, setNotesEditVal]           = useState('');
  // Custom new doctor form
  const [showNewDocForm, setShowNewDocForm]       = useState(false);
  const [newDocName, setNewDocName]               = useState('');
  const [newDocSpecialty, setNewDocSpecialty]     = useState('');
  const [newDocArea, setNewDocArea]               = useState('');
  const [newDocPharmacy, setNewDocPharmacy]       = useState('');
  const [newDocClass, setNewDocClass]             = useState('');
  const [newDocSaving, setNewDocSaving]           = useState(false);
  const [newDocErr, setNewDocErr]                 = useState('');
  // Edit existing doctor form
  const [editDocId, setEditDocId]                 = useState<number | null>(null);
  const [editDocName, setEditDocName]             = useState('');
  const [editDocSpecialty, setEditDocSpecialty]   = useState('');
  const [editDocArea, setEditDocArea]             = useState('');
  const [editDocPharmacy, setEditDocPharmacy]     = useState('');
  const [editDocClass, setEditDocClass]           = useState('');
  const [editDocSaving, setEditDocSaving]         = useState(false);
  const [editDocErr, setEditDocErr]               = useState('');
  // Pharmacy Net comparison
  const [netPharmacies, setNetPharmacies]         = useState<NetPharm[]>([]);
  const [netPharmFileIds, setNetPharmFileIds]     = useState<string>('');
  const [pharmComparePopup, setPharmComparePopup] = useState<{ docName: string; pharmName: string; areaName: string | null; exact: NetPharm | null; similar: NetPharm[] } | null>(null);
  const [pharmDetail, setPharmDetail]             = useState<PharmDetailData | null>(null);
  const [pharmDetailLoading, setPharmDetailLoading] = useState(false);
  const [pharmDetailFor, setPharmDetailFor]       = useState<string | null>(null);
  const [areaStatsPopup, setAreaStatsPopup]       = useState<{ areaName: string; total: number; withSales: string[]; withReturnsOnly: string[]; noData: string[] } | null>(null);

  // Back button: close open modals/panels in priority order
  useBackHandler([
    [modal !== null,               () => setModal(null)],
    [pharmModal !== null,          () => setPharmModal(null)],
    [showImportPanel,              () => setShowImportPanel(false)],
    [showPharmImport,              () => setShowPharmImport(false)],
    [showWishPanel,                () => setShowWishPanel(false)],
    [showWritingPopup,             () => setShowWritingPopup(false)],
    [showCoveragePopup,            () => setShowCoveragePopup(false)],
    [showTotalPopup,               () => setShowTotalPopup(false)],
    [showVisitedPopup,             () => setShowVisitedPopup(false)],
    [showVisitMonthPicker,         () => setShowVisitMonthPicker(false)],
    [showPharmMonthPicker,         () => setShowPharmMonthPicker(false)],
    [expandedDocIds.size > 0,      () => setExpandedDocIds(new Set())],
    [expandedAreas.size > 0,       () => setExpandedAreas(new Set())],
    [expandedVisits.size > 0,      () => setExpandedVisits(new Set())],
    [expandedPharma.size > 0,      () => setExpandedPharma(new Set())],
    [pharmExpandedAreas.size > 0,  () => setPharmExpandedAreas(new Set())],
    [showAddModal,                 () => { setShowAddModal(false); setShowAreaDropdown(false); setSurveyDocSelectedAreas(new Set()); }],
    [showArchiveWishPanel,         () => setShowArchiveWishPanel(false)],
    [archiveSubPopup !== null,      () => setArchiveSubPopup(null)],
    [showNewDocForm,               () => { setShowNewDocForm(false); setNewDocErr(''); }],
    [editDocId !== null,           () => { setEditDocId(null); setEditDocErr(''); }],
    [archiveExpandedAreas.size > 0, () => setArchiveExpandedAreas(new Set())],
    [areaStatsPopup !== null,         () => setAreaStatsPopup(null)],
    [pharmComparePopup !== null,    () => setPharmComparePopup(null)],
  ]);

  const toggleWish = (id: number, name?: string, extra?: { specialty?: string; pharmacyName?: string; areaName?: string }) => {
    const adding = !wishedDoctors.has(id);
    setWishedDoctors(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem(wishKey, JSON.stringify([...next]));
      return next;
    });
    if (name) {
      setWishedNames(prev => {
        const next = { ...prev, [id]: name };
        localStorage.setItem(namesKey, JSON.stringify(next));
        return next;
      });
    }
    if (extra) {
      setWishedInfo(prev => {
        const next = { ...prev, [id]: { ...extra, addedBy: user?.displayName ?? user?.username ?? '' } };
        localStorage.setItem(infoKey, JSON.stringify(next));
        return next;
      });
    }
    // Sync to backend
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (adding) {
      fetch(`${API}/api/doctors/wishlist`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ doctorId: id, specialty: extra?.specialty, pharmacyName: extra?.pharmacyName, areaName: extra?.areaName }),
      }).catch(() => {/* silent */});
    } else {
      fetch(`${API}/api/doctors/wishlist/${id}`, { method: 'DELETE', headers: h }).catch(() => {/* silent */});
    }
  };
  const setWishedItem = (docId: number, itemName: string) => {
    setWishedItems(prev => {
      const next = { ...prev, [docId]: itemName };
      localStorage.setItem(itemsKey, JSON.stringify(next));
      return next;
    });
    // Update backend item name
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    fetch(`${API}/api/doctors/wishlist`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ doctorId: docId, itemName }),
    }).catch(() => {/* silent */});
  };
  const toggleVisitExpand = (id: number) => setExpandedVisits(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const [dr, ar, it] = await Promise.all([
        fetch(`${API}/api/doctors`, { headers: h }),
        fetch(`${API}/api/areas`,   { headers: h }),
        fetch(`${API}/api/items`,   { headers: h }),
      ]);
      const [drJson, arJson, itJson] = await Promise.all([dr.json(), ar.json(), it.json()]);
      if (!dr.ok) throw new Error(drJson.error ?? `خطأ ${dr.status}`);
      if (!ar.ok) throw new Error(arJson.error ?? `خطأ ${ar.status}`);
      if (!it.ok) throw new Error(itJson.error ?? `خطأ ${it.status}`);
      setDoctors(Array.isArray(drJson) ? drJson : []);
      const arArr = Array.isArray(arJson) ? arJson : (Array.isArray(arJson?.data) ? arJson.data : []);
      const itArr = Array.isArray(itJson) ? itJson : (Array.isArray(itJson?.data) ? itJson.data : []);
      setAreas(arArr);
      setItems(itArr);
    } catch (e: any) { setError(e.message ?? 'خطأ في التحميل'); }
    finally { setLoading(false); }
  }, [token]);

  const loadVisits = useCallback(async (forceRefresh = false) => {
    // Cancel any previous in-flight request
    if (visitFetchAbortRef.current) visitFetchAbortRef.current.abort();
    const ctrl = new AbortController();
    visitFetchAbortRef.current = ctrl;

    // Return cached data instantly if available (unless explicit refresh)
    const cacheKey = `${visitRepFilter ?? 'all'}_${visitMonthFilter?.month ?? 'all'}_${visitMonthFilter?.year ?? 'all'}`;
    if (!forceRefresh) {
      const cached = visitCacheRef.current.get(cacheKey);
      if (cached) {
        setVisitAreas(cached.areas);
        setNoAreaStats(cached.noAreaStats);
        return;
      }
    }

    setVisitLoading(true);
    try {
      const ps = new URLSearchParams();
      if (visitMonthFilter) { ps.set('month', String(visitMonthFilter.month)); ps.set('year', String(visitMonthFilter.year)); }
      if (visitRepFilter !== null) ps.set('repUserId', String(visitRepFilter));
      const r = await fetch(`${API}/api/doctors/visits-by-area?${ps}`, { headers: H(), signal: ctrl.signal });
      const j = await r.json();
      console.log('[visitsByArea] status:', r.status, 'response:', j);
      const areas = Array.isArray(j.areas) ? j.areas : [];
      const stats = j.noAreaStats ?? { total: 0, visited: 0, writing: 0 };
      setVisitAreas(areas);
      setNoAreaStats(stats);
      visitCacheRef.current.set(cacheKey, { areas, noAreaStats: stats });
    } catch (e: any) {
      if (e.name !== 'AbortError') console.error('[visitsByArea] fetch error:', e);
    } finally {
      if (!ctrl.signal.aborted) setVisitLoading(false);
    }
  }, [token, visitMonthFilter, visitRepFilter]);

  // Default the doctors-visits month filter to the current month, or — if it has
  // no reports yet — the most recent month that does. "الكل" stays one click away
  // via the month picker for anyone who wants every month at once.
  const visitMonthDefaultAppliedRef = useRef(false);
  useEffect(() => {
    if (visitMonthDefaultAppliedRef.current || !showVisitAnalysis) return;
    visitMonthDefaultAppliedRef.current = true;
    (async () => {
      try {
        const r = await fetch(`${API}/api/doctors/visits-latest-month`, { headers: H() });
        const j = await r.json();
        if (j.month && j.year) setVisitMonthFilter({ month: j.month, year: j.year });
      } catch (e) { console.error('[visitsLatestMonth] fetch error:', e); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVisitAnalysis]);

  const loadManagerReps = useCallback(async () => {
    if (isFieldRep) return;
    try {
      const r = await fetch(`${API}/api/doctors/sub-reps`, { headers: H() });
      const j = await r.json();
      setManagerReps(Array.isArray(j.reps) ? j.reps : []);
    } catch (e) { console.error('[sub-reps] fetch error:', e); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Re-fetch areas when they change (added/removed) or when user returns to the page
  useEffect(() => {
    const refreshAreas = () => {
      fetch(`${API}/api/areas`, { headers: H() })
        .then(r => r.json())
        .then(json => {
          const arr = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
          setAreas(arr);
        })
        .catch(() => {});
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refreshAreas(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('areas-changed', refreshAreas);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('areas-changed', refreshAreas);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // When user changes (login/switch), reload wishlist from correct per-user key
  // and remove old generic keys to prevent bleed-over
  useEffect(() => {
    if (!user?.id) return;
    const key  = `wishedDoctors_${user.id}`;
    const kIt  = `wishedItems_${user.id}`;
    const kNm  = `wishedDoctorNames_${user.id}`;
    const kInf = `wishedDoctorInfo_${user.id}`;
    try { setWishedDoctors(new Set(JSON.parse(localStorage.getItem(key) || '[]'))); } catch { setWishedDoctors(new Set()); }
    try { setWishedItems(JSON.parse(localStorage.getItem(kIt) || '{}')); }           catch { setWishedItems({}); }
    try { setWishedNames(JSON.parse(localStorage.getItem(kNm) || '{}')); }           catch { setWishedNames({}); }
    try { setWishedInfo(JSON.parse(localStorage.getItem(kInf) || '{}')); }           catch { setWishedInfo({}); }
    // Remove old generic keys so they no longer pollute any session
    localStorage.removeItem('wishedDoctors');
    localStorage.removeItem('wishedItems');
    localStorage.removeItem('wishedDoctorNames');

    // Load from backend and merge (backend is source of truth)
    // If backend returns empty but localStorage has data → re-sync localStorage → backend
    fetch(`${API}/api/doctors/wishlist`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then((items: Array<{ doctorId: number; doctorName: string; specialty?: string; pharmacyName?: string; areaName?: string; itemName?: string }> | null) => {
        if (!Array.isArray(items)) return; // error from backend — keep localStorage

        // ── Always re-sync: push any localStorage IDs that are missing from backend ──
        const backendIds = new Set(items.map(w => w.doctorId));
        let localIds: number[] = [];
        try { localIds = JSON.parse(localStorage.getItem(key) || '[]'); } catch { localIds = []; }
        const missingIds = localIds.filter(id => !backendIds.has(id));
        if (missingIds.length > 0) {
          let localItems: Record<number, string> = {};
          let localInfo: Record<number, { specialty?: string; pharmacyName?: string; areaName?: string }> = {};
          try { localItems = JSON.parse(localStorage.getItem(kIt) || '{}'); } catch { localItems = {}; }
          try { localInfo  = JSON.parse(localStorage.getItem(kInf) || '{}'); } catch { localInfo = {}; }
          const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
          // Fire-and-forget POSTs for missing entries
          missingIds.forEach(docId => {
            const info = localInfo[docId] ?? {};
            fetch(`${API}/api/doctors/wishlist`, {
              method: 'POST', headers: h,
              body: JSON.stringify({ doctorId: docId, itemName: localItems[docId] ?? undefined, specialty: info.specialty, pharmacyName: info.pharmacyName, areaName: info.areaName }),
            }).catch(() => {});
          });
        }

        if (items.length === 0) return; // backend empty — keep localStorage displayed

        // Backend has data — merge into state (UNION of backend + local, never wipes local picks)
        setWishedDoctors(prev => {
          const merged = new Set([...prev, ...items.map(w => w.doctorId)]);
          localStorage.setItem(key, JSON.stringify([...merged]));
          return merged;
        });
        setWishedNames(prev => {
          const next = { ...prev };
          items.forEach(w => { next[w.doctorId] = w.doctorName; });
          localStorage.setItem(kNm, JSON.stringify(next));
          return next;
        });
        setWishedItems(prev => {
          const next = { ...prev };
          items.forEach(w => { if (w.itemName) next[w.doctorId] = w.itemName; });
          localStorage.setItem(kIt, JSON.stringify(next));
          return next;
        });
        setWishedInfo(prev => {
          const next = { ...prev };
          items.forEach(w => {
            next[w.doctorId] = { specialty: w.specialty, pharmacyName: w.pharmacyName, areaName: w.areaName, addedBy: next[w.doctorId]?.addedBy };
          });
          localStorage.setItem(kInf, JSON.stringify(next));
          return next;
        });
      })
      .catch(() => {/* silent fallback to localStorage */});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // AI assistant page-action listener
  const pendingAreaRef = useRef<{ action: string; param: string } | null>(null);
  useEffect(() => {
    const normA = (s: string) => s.trim().toLowerCase().replace(/أ|إ|آ/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
    const matchArea = (param: string) => {
      if (!param?.trim() || areas.length === 0) return null;
      const q = normA(param);
      return areas.find(a => normA(a.name) === q)
        || areas.find(a => normA(a.name).includes(q) || q.includes(normA(a.name)))
        || null;
    };
    const applyAreaFilter = (action: string, param: string) => {
      const match = matchArea(param);
      if (match) {
        setFilterArea(String(match.id));
        pendingAreaRef.current = null;
      } else if (areas.length === 0) {
        // Areas not loaded yet — defer
        pendingAreaRef.current = { action, param };
      }
    };
    // Resolve any pending area filter now that areas may have loaded
    if (pendingAreaRef.current && areas.length > 0) {
      applyAreaFilter(pendingAreaRef.current.action, pendingAreaRef.current.param);
    }
    const handler = (e: Event) => {
      const { action, param } = (e as CustomEvent).detail || {};
      switch (action) {
        case 'open-add-doctor':     openAdd(); break;
        case 'open-import-doctors': setShowImportPanel(true); break;
        case 'open-coverage':       setShowCoveragePopup(true); break;
        case 'open-wish-list':      setActiveTab('list'); setShowWishPanel(true); break;
        case 'open-wish-list-area': {
          setActiveTab('list');
          setShowWishPanel(true);
          if (typeof param === 'string') applyAreaFilter(action, param);
          break;
        }
        case 'open-doctors-area': {
          setActiveTab('list');
          setShowWishPanel(false);
          if (typeof param === 'string') applyAreaFilter(action, param);
          break;
        }
      }
    };
    window.addEventListener('ai-page-action', handler);
    const pending = (window as any).__aiPendingAction;
    if (pending) { (window as any).__aiPendingAction = null; handler(new CustomEvent('ai-page-action', { detail: pending })); }
    return () => window.removeEventListener('ai-page-action', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areas]);

  // Sync wished doctor names to localStorage whenever doctors list loads
  useEffect(() => {
    if (doctors.length === 0) return;
    const stored = wishedDoctors;
    if (stored.size === 0) return;
    setWishedNames(prev => {
      const next = { ...prev };
      let changed = false;
      doctors.forEach(d => {
        if (stored.has(d.id) && !next[d.id]) {
          next[d.id] = d.name;
          changed = true;
        }
      });
      if (changed) localStorage.setItem('wishedDoctorNames', JSON.stringify(next));
      return changed ? next : prev;
    });
  }, [doctors]);
  useEffect(() => {
    if (activeTab === 'visits') {
      loadVisits();
      loadManagerReps();
    }
  }, [activeTab, loadVisits, loadManagerReps]);

  // Auto-load + auto-refresh team wishlists for managers (no clicks needed)
  useEffect(() => {
    if (activeTab !== 'visits' || isFieldRep) return;
    // Initial load
    loadTeamWishlists();
    // Refresh every 30 seconds while user is on visits tab
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') loadTeamWishlists();
    }, 30000);
    // Refresh when tab becomes visible again
    const onVisible = () => { if (document.visibilityState === 'visible') loadTeamWishlists(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isFieldRep]);

  // (auto-open removed — panel is collapsed by default, user must click to open)

  // Load Pharmacy Net data — filtered to pharmacy_net files only (managers only)
  const loadNetPharmacies = useCallback(() => {
    if (!canSeePharmNet) return;
    // Step 1: get the list of pharmacy_net files for this user
    fetch(`${API}/api/files?context=pharmacy_net`, { headers: H() })
      .then(r => r.ok ? r.json() : { data: [] })
      .then(async ({ data: files }) => {
        const fileList: { id: number }[] = Array.isArray(files) ? files : [];
        if (fileList.length === 0) {
          setNetPharmacies([]);
          setNetPharmFileIds('');
          return;
        }
        const ids = fileList.map(f => f.id).join(',');
        setNetPharmFileIds(ids);
        // Step 2: load pharmacies filtered by those file IDs only
        const r = await fetch(`${API}/api/pharmacy-analysis/pharmacies?fileIds=${ids}`, { headers: H() });
        const d = r.ok ? await r.json() : { pharmacies: [] };
        setNetPharmacies(d.pharmacies || []);
      })
      .catch(() => { setNetPharmacies([]); setNetPharmFileIds(''); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, canSeePharmNet]);

  useEffect(() => {
    loadNetPharmacies();
    // Re-fetch when the window regains focus — handles the case where files were
    // deleted in the Pharmacy Net page while this page was already open.
    window.addEventListener('focus', loadNetPharmacies);
    return () => window.removeEventListener('focus', loadNetPharmacies);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadNetPharmacies]);

  // Load detailed orders (all items + dates) for a specific pharmacy
  const loadPharmDetail = useCallback(async (pharmName: string) => {
    setPharmDetailLoading(true);
    setPharmDetail(null);
    setPharmDetailFor(pharmName);
    try {
      const fileParam = netPharmFileIds ? `?fileIds=${netPharmFileIds}` : '';
      const r = await fetch(`${API}/api/pharmacy-analysis/pharmacy/${encodeURIComponent(pharmName)}${fileParam}`, { headers: H() });
      if (r.ok) setPharmDetail(await r.json());
    } catch {}
    finally { setPharmDetailLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, netPharmFileIds]);

  // Auto-load detail when popup opens with an exact match
  useEffect(() => {
    if (!pharmComparePopup?.exact || !canSeePharmNet) {
      setPharmDetail(null); setPharmDetailFor(null); return;
    }
    loadPharmDetail(pharmComparePopup.exact.name);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pharmComparePopup?.exact?.name]);

  const loadPharmVisits = useCallback(async (forceRefresh = false) => {
    // Cancel any previous in-flight request
    if (pharmVisitFetchAbortRef.current) pharmVisitFetchAbortRef.current.abort();
    const ctrl = new AbortController();
    pharmVisitFetchAbortRef.current = ctrl;

    // Return cached data instantly if available (unless explicit refresh)
    const cacheKey = `${visitRepFilter ?? 'all'}_${pharmVisitMonthFilter?.month ?? 'all'}_${pharmVisitMonthFilter?.year ?? 'all'}`;
    if (!forceRefresh) {
      const cached = pharmVisitCacheRef.current.get(cacheKey);
      if (cached) {
        setPharmVisitAreas(cached);
        return;
      }
    }

    setPharmVisitLoading(true);
    try {
      const ps = new URLSearchParams();
      if (pharmVisitMonthFilter) { ps.set('month', String(pharmVisitMonthFilter.month)); ps.set('year', String(pharmVisitMonthFilter.year)); }
      if (visitRepFilter !== null) ps.set('repUserId', String(visitRepFilter));
      const r = await fetch(`${API}/api/doctors/pharmacy-visits-by-area?${ps}`, { headers: H(), signal: ctrl.signal });
      const j = await r.json();
      const areas = Array.isArray(j.areas) ? j.areas : [];
      setPharmVisitAreas(areas);
      pharmVisitCacheRef.current.set(cacheKey, areas);
    } catch (e: any) {
      if (e.name !== 'AbortError') console.error(e);
    } finally {
      if (!ctrl.signal.aborted) setPharmVisitLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, pharmVisitMonthFilter, visitRepFilter]);

  // Same default-month behavior as the doctors visits view, for the pharmacies sub-view.
  const pharmVisitMonthDefaultAppliedRef = useRef(false);
  useEffect(() => {
    if (pharmVisitMonthDefaultAppliedRef.current || !showVisitAnalysis) return;
    pharmVisitMonthDefaultAppliedRef.current = true;
    (async () => {
      try {
        const r = await fetch(`${API}/api/doctors/pharmacy-visits-latest-month`, { headers: H() });
        const j = await r.json();
        if (j.month && j.year) setPharmVisitMonthFilter({ month: j.month, year: j.year });
      } catch (e) { console.error('[pharmacyVisitsLatestMonth] fetch error:', e); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVisitAnalysis]);

  const loadSurveyPharmacies = useCallback(async () => {
    if (!isCommercialRep) return;
    setSurveyPharmLoading(true);
    try {
      const r = await fetch(`${API}/api/commercial/survey-pharmacies`, { headers: H() });
      const j = await r.json();
      setSurveyPharmacies(Array.isArray(j) ? j : []);
      setSurveyPharmLoaded(true);
    } catch (e) { console.error(e); }
    finally { setSurveyPharmLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isCommercialRep]);

  // ── Archive loaders ──────────────────────────────────────────
  const loadArchive = useCallback(async () => {
    setArchiveLoading(true);
    try {
      const url = archiveRepFilter !== null
        ? `${API}/api/doctor-archive?repUserId=${archiveRepFilter}`
        : `${API}/api/doctor-archive`;
      const r = await fetch(url, { headers: H() });
      const j = await r.json();
      if (j.success) {
        setArchiveAreas(j.areas ?? []);
        setArchiveTotal(j.total ?? 0);
        setArchiveTotalVisited(j.totalVisited ?? 0);
        setArchiveTotalWriting(j.totalWriting ?? 0);
      }
    } catch (e) { console.error(e); }
    finally { setArchiveLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, archiveRepFilter]);

  // ايتمات مقيّدة بشركات المندوب المعروض أرشيفه (لاقتراحات حقل الإيتم بالزيارة/الكتابة)
  const loadArchiveRepItems = useCallback(async () => {
    if (archiveRepFilter === null) { setArchiveRepItems(null); return; }
    try {
      const r = await fetch(`${API}/api/items?repUserId=${archiveRepFilter}`, { headers: H() });
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : []);
      setArchiveRepItems(arr);
    } catch (e) { console.error(e); setArchiveRepItems(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, archiveRepFilter]);

  const importFromVisitsHandler = useCallback(async () => {
    setImportingFromVisits(true);
    setImportFromVisitsResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (archiveRepFilter !== null) body.repUserId = archiveRepFilter;
      const r = await fetch(`${API}/api/doctor-archive/import-from-visits`, {
        method: 'POST',
        headers: { ...H(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.success) {
        setImportFromVisitsResult({ imported: j.imported, alreadyExists: j.alreadyExists, total: j.total });
        if (j.imported > 0) loadArchive();
      }
    } catch (e) { console.error(e); }
    finally { setImportingFromVisits(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, archiveRepFilter, loadArchive]);

  const loadSurveyDoctors = useCallback(async () => {
    setSurveyDocLoading(true);
    try {
      const r = await fetch(`${API}/api/doctor-archive/survey-doctors`, { headers: H() });
      const j = await r.json();
      setSurveyDoctors(j.success ? (j.doctors ?? []) : []);
    } catch (e) { console.error(e); }
    finally { setSurveyDocLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const addToArchive = async (surveyDoctorId: number) => {
    setAddingIds(prev => new Set(prev).add(surveyDoctorId));
    try {
      const r = await fetch(`${API}/api/doctor-archive/${surveyDoctorId}`, { method: 'POST', headers: H() });
      const j = await r.json();
      if (j.success) {
        setSurveyDoctors(prev => prev.filter(d => d.id !== surveyDoctorId));
        loadArchive();
      }
    } catch (e) { console.error(e); }
    finally { setAddingIds(prev => { const s = new Set(prev); s.delete(surveyDoctorId); return s; }); }
  };

  const submitCustomDoctor = async () => {
    if (!newDocName.trim()) { setNewDocErr('الاسم مطلوب'); return; }
    setNewDocSaving(true); setNewDocErr('');
    try {
      const r = await fetch(`${API}/api/doctor-archive/custom-doctor`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({
          name:         newDocName.trim(),
          specialty:    newDocSpecialty.trim() || null,
          areaName:     newDocArea.trim()      || null,
          pharmacyName: newDocPharmacy.trim()  || null,
          className:    newDocClass.trim()     || null,
        }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error ?? 'فشل الحفظ');
      setShowNewDocForm(false);
      setNewDocName(''); setNewDocSpecialty(''); setNewDocArea(''); setNewDocPharmacy(''); setNewDocClass(''); setNewDocErr('');
      loadArchive();
    } catch (e: any) { setNewDocErr(e.message); }
    finally { setNewDocSaving(false); }
  };

  const openEditDoc = (doc: ArchiveDoctor) => {
    setEditDocId(doc.surveyDoctorId);
    setEditDocName(doc.name);
    setEditDocSpecialty(doc.specialty ?? '');
    setEditDocArea(doc.areaName ?? '');
    setEditDocPharmacy(doc.pharmacyName ?? '');
    setEditDocClass(doc.className ?? '');
    setEditDocErr('');
  };

  const submitEditDoctor = async () => {
    if (!editDocName.trim()) { setEditDocErr('الاسم مطلوب'); return; }
    if (editDocId === null) return;
    setEditDocSaving(true); setEditDocErr('');
    try {
      const r = await fetch(`${API}/api/doctor-archive/doctor/${editDocId}`, {
        method: 'PATCH', headers: H(),
        body: JSON.stringify({
          name:         editDocName.trim(),
          specialty:    editDocSpecialty.trim() || null,
          areaName:     editDocArea.trim()      || null,
          pharmacyName: editDocPharmacy.trim()  || null,
          className:    editDocClass.trim()     || null,
        }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error ?? 'فشل الحفظ');
      setEditDocId(null);
      loadArchive();
    } catch (e: any) { setEditDocErr(e.message); }
    finally { setEditDocSaving(false); }
  };

  const addAllToArchive = async (ids: number[]) => {
    if (ids.length === 0 || importingAll) return;
    setImportingAll(true);
    setAddingIds(new Set(ids));
    try {
      await Promise.all(ids.map(id =>
        fetch(`${API}/api/doctor-archive/${id}`, { method: 'POST', headers: H() }).then(r => r.json())
      ));
      setSurveyDoctors(prev => prev.filter(d => !ids.includes(d.id)));
      loadArchive();
    } catch (e) { console.error(e); }
    finally { setAddingIds(new Set()); setImportingAll(false); }
  };

  const patchArchive = async (doc: ArchiveDoctor, patch: Record<string, unknown>) => {
    const surveyDoctorId = doc.surveyDoctorId;
    const doctorId = doc.doctorId;
    // Optimistic update on archiveAreas
    setArchiveAreas(prev => prev.map(area => ({
      ...area,
      doctors: area.doctors.map(d =>
        (surveyDoctorId && d.surveyDoctorId === surveyDoctorId) || (doctorId && d.doctorId === doctorId)
          ? { ...d, ...patch } : d
      ),
    })));
    // Recalculate stats optimistically
    setArchiveAreas(areas => {
      const allDocs = areas.flatMap(a => a.doctors);
      setArchiveTotalVisited(allDocs.filter(d => d.isVisited).length);
      setArchiveTotalWriting(allDocs.filter(d => d.isWriting).length);
      return areas;
    });
    try {
      const params = new URLSearchParams();
      // في عرض "الكل" (بدون فلتر مندوب) نستهدف صاحب الإدخال الفعلي (ownerUserId) بدل
      // إنشاء إدخال منفصل باسم المشاهد نفسه — وإلا يبقى إدخال المندوب الأصلي (isVisited)
      // كما هو ويظل يظهر مؤشَّراً رغم إلغاء التأشير من هذا العرض.
      const targetUserId = archiveRepFilter !== null ? archiveRepFilter : (doc.ownerUserId ?? null);
      if (targetUserId !== null) params.set('forUserId', String(targetUserId));
      if (!surveyDoctorId && doctorId) params.set('doctorId', String(doctorId));
      const qs = params.toString() ? `?${params}` : '';
      const sid = surveyDoctorId ?? 0;
      await fetch(`${API}/api/doctor-archive/${sid}${qs}`, {
        method: 'PATCH', headers: H(), body: JSON.stringify(patch),
      });
    } catch (e) { console.error(e); loadArchive(); }
  };

  const removeFromArchive = async (surveyDoctorId: number) => {
    if (!confirm('إزالة هذا الطبيب من الأرشيف؟')) return;
    setArchiveAreas(prev => {
      const next = prev.map(area => ({ ...area, doctors: area.doctors.filter(d => d.surveyDoctorId !== surveyDoctorId) }))
        .filter(area => area.doctors.length > 0);
      const allDocs = next.flatMap(a => a.doctors);
      setArchiveTotal(allDocs.length);
      setArchiveTotalVisited(allDocs.filter(d => d.isVisited).length);
      setArchiveTotalWriting(allDocs.filter(d => d.isWriting).length);
      return next;
    });
    try {
      const qs = archiveRepFilter !== null ? `?forUserId=${archiveRepFilter}` : '';
      await fetch(`${API}/api/doctor-archive/${surveyDoctorId}${qs}`, { method: 'DELETE', headers: H() });
      loadSurveyDoctors(); // refresh survey list so removed doctor reappears
    } catch (e) { console.error(e); loadArchive(); }
  };

  const removeAreaFromArchive = async (areaName: string, doctorIds: number[]) => {
    if (!confirm(`حذف منطقة "${areaName}" (${doctorIds.length} طبيب) من الأرشيف؟`)) return;
    setArchiveAreas(prev => {
      const next = prev.filter(a => a.name !== areaName);
      const allDocs = next.flatMap(a => a.doctors);
      setArchiveTotal(allDocs.length);
      setArchiveTotalVisited(allDocs.filter(d => d.isVisited).length);
      setArchiveTotalWriting(allDocs.filter(d => d.isWriting).length);
      return next;
    });
    try {
      const qs = archiveRepFilter !== null ? `?forUserId=${archiveRepFilter}` : '';
      await Promise.all(doctorIds.map(id =>
        fetch(`${API}/api/doctor-archive/${id}${qs}`, { method: 'DELETE', headers: H() })
      ));
      loadSurveyDoctors();
    } catch (e) { console.error(e); loadArchive(); }
  };

  const toggleArchiveStar = (surveyDoctorId: number) => {
    setArchiveStarred(prev => {
      const next = new Set(prev);
      next.has(surveyDoctorId) ? next.delete(surveyDoctorId) : next.add(surveyDoctorId);
      localStorage.setItem(archiveStarKey, JSON.stringify([...next]));
      return next;
    });
  };

  const openAddPharm = () => {
    setPharmEditTarget(null);
    setPharmFName(''); setPharmFOwner(''); setPharmFPhone(''); setPharmFAddress(''); setPharmFAreaName('');
    setPharmSaveErr(''); setPharmModal('add');
  };
  const openEditPharm = (p: SurveyPharmacy) => {
    setPharmEditTarget(p);
    setPharmFName(p.name); setPharmFOwner(p.ownerName ?? ''); setPharmFPhone(p.phone ?? '');
    setPharmFAddress(p.address ?? ''); setPharmFAreaName(p.areaName ?? '');
    setPharmSaveErr(''); setPharmModal('edit');
  };
  const savePharm = async () => {
    if (!pharmFName.trim()) { setPharmSaveErr('اسم الصيدلية مطلوب'); return; }
    setPharmSaving(true); setPharmSaveErr('');
    try {
      const body = { name: pharmFName.trim(), ownerName: pharmFOwner.trim() || null, phone: pharmFPhone.trim() || null, address: pharmFAddress.trim() || null, areaName: pharmFAreaName.trim() || null };
      const url    = pharmModal === 'edit' ? `${API}/api/commercial/pharmacies/${pharmEditTarget!.id}` : `${API}/api/commercial/pharmacies`;
      const method = pharmModal === 'edit' ? 'PATCH' : 'POST';
      const r = await fetch(url, { method, headers: H(), body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'فشل الحفظ');
      if (pharmModal === 'edit') {
        setSurveyPharmacies(prev => prev.map(p => p.id === j.id ? j : p));
      } else {
        setSurveyPharmacies(prev => [j, ...prev]);
      }
      setPharmModal(null);
    } catch (e: any) { setPharmSaveErr(e.message); }
    finally { setPharmSaving(false); }
  };
  const deletePharm = async (id: number) => {
    if (!confirm('هل تريد حذف هذه الصيدلية؟')) return;
    try {
      const r = await fetch(`${API}/api/commercial/pharmacies/${id}`, { method: 'DELETE', headers: H() });
      if (!r.ok) { const j = await r.json(); throw new Error(j.error ?? 'فشل الحذف'); }
      setSurveyPharmacies(prev => prev.filter(p => p.id !== id));
    } catch (e: any) { alert(e.message); }
  };
  const importPharmExcel = async (file: File) => {
    setPharmImporting(true); setPharmImportResult(null);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await fetch(`${API}/api/commercial/pharmacies/import`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const j = await r.json();
      setPharmImportResult(j);
      if (r.ok && j.imported > 0) { setSurveyPharmLoaded(false); loadSurveyPharmacies(); }
    } catch (e: any) { alert(e.message); }
    finally { setPharmImporting(false); if (pharmFileRef.current) pharmFileRef.current.value = ''; }
  };

  // Load pharmacy visits when toggling to pharmacies in visits tab
  useEffect(() => {
    if (activeTab === 'visits' && visitAnalysisType === 'pharmacies') loadPharmVisits();
  }, [activeTab, visitAnalysisType, loadPharmVisits]);

  // Load survey pharmacies when tab opens
  useEffect(() => {
    if (activeTab === 'pharmacies' && !surveyPharmLoaded) loadSurveyPharmacies();
  }, [activeTab, surveyPharmLoaded, loadSurveyPharmacies]);

  // Load archive when tab opens
  useEffect(() => {
    if (activeTab === 'archive') { loadArchive(); loadManagerReps(); loadArchiveRepItems(); }
  }, [activeTab, loadArchive, loadManagerReps, loadArchiveRepItems]);

  // Load survey doctors when add modal opens
  useEffect(() => {
    if (showAddModal) { loadSurveyDoctors(); }
  }, [showAddModal, loadSurveyDoctors]);
  useEffect(() => {
    if (!showCoveragePopup) return;
    const handler = (e: MouseEvent) => {
      if (coverageCardRef.current && !coverageCardRef.current.contains(e.target as Node))
        setShowCoveragePopup(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCoveragePopup]);
  useEffect(() => {
    if (!showTotalPopup) return;
    const handler = (e: MouseEvent) => {
      if (totalCardRef.current && !totalCardRef.current.contains(e.target as Node))
        setShowTotalPopup(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTotalPopup]);
  useEffect(() => {
    if (!showWritingPopup) return;
    const handler = (e: MouseEvent) => {
      if (writingCardRef.current && !writingCardRef.current.contains(e.target as Node))
        { setShowWritingPopup(false); setWritingItemFilter(null); setExpandedDocIds(new Set<number>()); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showWritingPopup]);
  useEffect(() => {
    if (!showVisitedPopup) return;
    const handler = (e: MouseEvent) => {
      if (visitedCardRef.current && !visitedCardRef.current.contains(e.target as Node))
        { setShowVisitedPopup(false); setExpandedDocIds(new Set<number>()); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showVisitedPopup]);

  const openAdd = () => {
    setSelected(null);
    setFName(''); setFSpecialty(''); setFPharmacy(''); setFNotes('');
    setFAreaId(''); setFAreaName(''); setFAreaSugg([]); setFAreaShowSugg(false);
    setFItemId(''); setFItemName(''); setFItemSugg([]); setFItemShowSugg(false);
    setFActive(true);
    setModal('add');
  };

  const openEdit = (d: Doctor) => {
    setSelected(d);
    setFName(d.name); setFSpecialty(d.specialty ?? ''); setFPharmacy(d.pharmacyName ?? '');
    setFNotes(d.notes ?? '');
    setFAreaId(d.area?.id?.toString() ?? ''); setFAreaName(d.area?.name ?? ''); setFAreaSugg([]); setFAreaShowSugg(false);
    setFItemId(d.targetItem?.id?.toString() ?? ''); setFItemName(d.targetItem?.name ?? ''); setFItemSugg([]); setFItemShowSugg(false);
    setFActive(d.isActive);
    setModal('edit');
  };

  const save = async () => {
    if (!fName.trim()) { alert('اسم الطبيب مطلوب'); return; }
    setSaving(true);
    try {
      // Resolve or create area
      let resolvedAreaId = fAreaId;
      if (fAreaName.trim() && !resolvedAreaId) {
        const r = await fetch(`${API}/api/areas`, { method: 'POST', headers: H(), body: JSON.stringify({ name: fAreaName.trim() }) });
        if (r.ok) { const j = await r.json(); resolvedAreaId = String(j.id); setAreas(prev => prev.some(a => a.id === j.id) ? prev : [...prev, j].sort((a, b) => a.name.localeCompare(b.name))); window.dispatchEvent(new Event('areas-changed')); }
      } else if (!fAreaName.trim()) { resolvedAreaId = ''; }
      // Resolve or create item
      let resolvedItemId = fItemId;
      if (fItemName.trim() && !resolvedItemId) {
        const r = await fetch(`${API}/api/items`, { method: 'POST', headers: H(), body: JSON.stringify({ name: fItemName.trim() }) });
        if (r.ok) { const j = await r.json(); const item = j.data ?? j; resolvedItemId = String(item.id); setItems(prev => prev.some(i => i.id === item.id) ? prev : [...prev, item].sort((a, b) => a.name.localeCompare(b.name))); }
      } else if (!fItemName.trim()) { resolvedItemId = ''; }

      const body = { name: fName.trim(), specialty: fSpecialty.trim() || null, pharmacyName: fPharmacy.trim() || null,
        notes: fNotes.trim() || null, areaId: resolvedAreaId || null, targetItemId: resolvedItemId || null, isActive: fActive };
      const url  = modal === 'edit' ? `${API}/api/doctors/${selected!.id}` : `${API}/api/doctors`;
      const resp = await fetch(url, { method: modal === 'edit' ? 'PUT' : 'POST', headers: H(), body: JSON.stringify(body) });
      if (!resp.ok) { const j = await resp.json(); throw new Error(j.error ?? 'فشل الحفظ'); }
      await load(); setModal(null);
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const remove = async (id: number) => {
    if (!confirm('هل تريد حذف هذا الطبيب؟')) return;
    await fetch(`${API}/api/doctors/${id}`, { method: 'DELETE', headers: H() });
    await load();
  };

  const deleteAll = async () => {
    if (!confirm(`⚠️ هل تريد مسح جميع الأطباء (${doctors.length} طبيب)؟\nهذه العملية لا يمكن التراجع عنها.`)) return;
    try {
      const r = await fetch(`${API}/api/doctors/all`, { method: 'DELETE', headers: H() });
      if (!r.ok) { const j = await r.json(); throw new Error(j.error ?? 'فشل الحذف'); }
      setImportResult(null);
      await load();
    } catch (e: any) { alert(e.message); }
  };

  const importExcel = async (file: File) => {
    setImporting(true); setImportResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch(`${API}/api/doctors/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const j = await r.json();
      // Always store the result (even errors contain detectedCols)
      setImportResult(j);
      if (r.ok && j.imported > 0) await load();
    } catch (e: any) { alert(e.message); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const filtered = useMemo(() => doctors.filter(d => {
    const matchSearch = !search || d.name.includes(search) || (d.specialty ?? '').includes(search) || (d.pharmacyName ?? '').includes(search);
    const matchArea   = filterArea === 'all' || d.area?.id?.toString() === filterArea;
    const matchClass  = filterClass === 'all' || (d.className ?? '') === filterClass;
    return matchSearch && matchArea && matchClass;
  }), [doctors, search, filterArea, filterClass]);

  const uniqueClasses = useMemo(
    () => [...new Set(doctors.map(d => d.className).filter(Boolean) as string[])].sort(),
    [doctors]
  );

  const doctorNameSuggestions = useMemo(
    () => doctors.flatMap(d => [d.name, d.specialty ?? '', d.pharmacyName ?? '']).filter(Boolean) as string[],
    [doctors]
  );

  // Fast normalised lookup map for pharmacy net — rebuilt only when netPharmacies changes
  const netPharmNormMap = useMemo(() => {
    const m = new Map<string, NetPharm>();
    for (const p of netPharmacies) m.set(normPharm(p.name), p);
    return m;
  }, [netPharmacies]);

  // Precomputed area stats for visits tab — rebuilt only when areas or net data changes
  const visitAreaStatsMap = useMemo(() => {
    const m = new Map<string, ReturnType<typeof getAreaPharmStatsFast>>();
    if (!canSeePharmNet || netPharmNormMap.size === 0) return m;
    for (const area of visitAreas) m.set(area.name, getAreaPharmStatsFast(area.doctors, netPharmNormMap));
    return m;
  }, [visitAreas, netPharmNormMap, canSeePharmNet]);

  // Precomputed area stats for archive tab
  const archiveAreaStatsMap = useMemo(() => {
    const m = new Map<string, ReturnType<typeof getAreaPharmStatsFast>>();
    if (!canSeePharmNet || netPharmNormMap.size === 0) return m;
    for (const area of archiveAreas) m.set(area.name, getAreaPharmStatsFast(area.doctors, netPharmNormMap));
    return m;
  }, [archiveAreas, netPharmNormMap, canSeePharmNet]);

  // Suggestions for archive item inputs = items linked to the viewed rep's companies
  // (archiveRepItems, scoped via ?repUserId= when viewing another rep's archive; falls
  // back to the viewer's own items) + all previously entered archive items
  const archiveItemSuggestions = useMemo(() => {
    const names = new Set<string>();
    (archiveRepItems ?? items).forEach(it => names.add(it.name));
    archiveAreas.forEach(area => area.doctors.forEach(doc => {
      doc.visitItems?.forEach(n => { if (n) names.add(n); });
      doc.writingItems?.forEach(n => { if (n) names.add(n); });
    }));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [items, archiveRepItems, archiveAreas]);

  // مناطق الزيارات مرتّبة + قائمة الأطباء بعد الفلترة/الترتيب لكل منطقة — محسوبة
  // مرة واحدة فقط عند تغيّر البيانات أو معايير الفلترة الفعلية. كانت هذه العملية
  // تُعاد لكل مناطق التبويب (482 طبيباً لمنطقة، 373 لأخرى، ...) في كل إعادة رسم
  // للمكوّن — بما فيها إعادة رسم لا علاقة لها بهذا التبويب إطلاقاً (فتح لوحة
  // جانبية، كتابة حرف في حقل آخر) — وهذا هو المصدر الرئيسي للتقطّع عند التنقّل.
  const visitAreasSorted = useMemo(
    () => [...visitAreas].sort((a, b) => b.totalDoctors - a.totalDoctors),
    [visitAreas],
  );
  const visitDoctorsByArea = useMemo(() => {
    const searchQ = visitSearch.trim().toLowerCase();
    const m = new Map<string, VisitDoctor[]>();
    for (const area of visitAreas) {
      const filtered = area.doctors.filter(d => {
        if (showOnlyVisited && !d.visited) return false;
        if (searchQ && !d.name.toLowerCase().includes(searchQ) && !(d.specialty ?? '').toLowerCase().includes(searchQ)) return false;
        return true;
      });
      const sorted = [...filtered].sort((a, b) => {
        if (a.visited !== b.visited) return a.visited ? -1 : 1;
        return (a.name ?? '').localeCompare(b.name ?? '');
      });
      m.set(String(area.id), sorted);
    }
    return m;
  }, [visitAreas, showOnlyVisited, visitSearch]);

  // مطابقة صيدلية الطبيب مع بيانات الصيدليات نت — نسخة سريعة تستعمل netPharmNormMap
  // (بحث O(1)) بدل findNetMatches التي كانت تُستدعى لكل طبيب ظاهر في كل إعادة رسم
  // وتفحص كامل قائمة netPharmacies ثلاث مرات (تطابق تام + فلترة منطقة + تشابه).
  const netPharmByAreaNorm = useMemo(() => {
    const m = new Map<string, NetPharm[]>();
    for (const p of netPharmacies) {
      const k = normPharm(p.areaName);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    return m;
  }, [netPharmacies]);
  const findNetMatchesFast = (pharmName: string, areaName?: string | null): { exact: NetPharm | null; similar: NetPharm[] } => {
    const q = normPharm(pharmName);
    const exact = netPharmNormMap.get(q) ?? null;
    const pool = areaName ? (netPharmByAreaNorm.get(normPharm(areaName)) ?? []) : netPharmacies;
    const similar = pool.filter(p => {
      const n = normPharm(p.name);
      return n !== q && (n.includes(q) || q.includes(n));
    }).slice(0, 6);
    return { exact, similar };
  };

  const toggleArea = (key: string) => setExpandedAreas(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const fieldLabels: Record<string, string> = {
    name: 'الاسم', specialty: 'التخصص', area: 'المنطقة',
    pharmacy: 'الصيدلية', item: 'الايتم', notes: 'ملاحظات',
  };

  return (
    <div className="page-container" dir="rtl">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--c-text-primary)' }}>🏥 قائمة السيرفي</h1>
        </div>
        {activeTab === 'list' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => { setShowImportPanel(v => !v); setImportResult(null); }}
              className="btn-icon btn-icon--green" title="استيراد Excel"><Icon name="import" /></button>
            <button onClick={openAdd} className="btn-icon btn-icon--blue" title="إضافة طبيب"><Icon name="add" /></button>
            {doctors.length > 0 && (
              <button onClick={deleteAll} className="btn-icon btn-icon--red" title="مسح جميع الأطباء"><Icon name="delete" /></button>
            )}
          </div>
        )}
        {activeTab === 'visits' && visitAnalysisType === 'doctors' && (
          <button onClick={() => loadVisits(true)} disabled={visitLoading}
            style={{ ...btnStyle('var(--c-accent)'), opacity: visitLoading ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="refresh" size={14} className={visitLoading ? 'icon-spin' : undefined} /> تحديث
          </button>
        )}
        {activeTab === 'visits' && visitAnalysisType === 'pharmacies' && (
          <button onClick={() => loadPharmVisits(true)} disabled={pharmVisitLoading}
            style={{ ...btnStyle('var(--c-accent)'), opacity: pharmVisitLoading ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="refresh" size={14} className={pharmVisitLoading ? 'icon-spin' : undefined} /> تحديث
          </button>
        )}
        {activeTab === 'pharmacies' && (
          <button onClick={loadSurveyPharmacies} disabled={surveyPharmLoading}
            style={{ ...btnStyle('var(--c-accent)'), opacity: surveyPharmLoading ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="refresh" size={14} className={surveyPharmLoading ? 'icon-spin' : undefined} /> تحديث
          </button>
        )}
        {activeTab === 'archive' && showArchiveTab && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setShowAddModal(true)}
              title="إضافة من السيرفي"
              className="btn-icon btn-icon--purple">
              <Icon name="navMasterSurvey" />
            </button>
            <button onClick={importFromVisitsHandler} disabled={importingFromVisits}
              title="استيراد من تحليل الزيارات"
              className="btn-icon btn-icon--blue" style={{ opacity: importingFromVisits ? 0.7 : 1 }}>
              {importingFromVisits ? <Icon name="loading" /> : <Icon name="import" />}
            </button>
            <button onClick={() => setShowNewDocForm(true)}
              title="إضافة طبيب جديد"
              className="btn-icon" style={{ background: 'var(--c-text-secondary)', color: '#fff' }}>
              <Icon name="add" />
            </button>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--c-border)', paddingBottom: 0 }}>
        {([
          ...(showVisitAnalysis                    ? [['visits',      '📍 الزيارات']]          : []),
          ...(showDoctorsList                       ? [['list',        '📋 الأطباء']]            : []),
          ...(showArchiveTab                        ? [['archive',     '📚 أرشيف']]              : []),
          ...(isCommercialRep && showMyVisits       ? [['myvisits',    '📝 زياراتي']]            : []),
          ...(isCommercialRep && showPharmacies     ? [['pharmacies',  '🏪 الصيدليات']]         : []),
        ] as ['list' | 'visits' | 'pharmacies' | 'myvisits' | 'archive', string][]).map(([tab, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '7px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', flex: 1,
            color: activeTab === tab ? 'var(--c-accent)' : 'var(--c-text-secondary)',
            borderBottom: activeTab === tab ? '2px solid var(--c-accent)' : '2px solid transparent',
            marginBottom: -2, transition: 'all 0.15s',
          }}>{label}</button>
        ))}
      </div>

      {/* ── LIST TAB ─────────────────────────────────────── */}
      {activeTab === 'list' && showDoctorsList && (<>
      {/* Excel import panel */}
      {showImportPanel && (
        <div style={{ background: 'var(--c-success-bg)', border: '1px solid var(--c-success-border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--c-success)' }}>📊 استيراد قائمة السيرفي من Excel</h3>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--c-success)', lineHeight: 1.7 }}>
            النظام يكتشف الأعمدة تلقائياً من ملفك. ارفع الملف وسيظهر لك أي أعمدة تم التعرف عليها.
            <br />
            <span style={{ fontSize: 12, color: 'var(--c-success)' }}>
              الأعمدة المدعومة (بأي تسمية): اسم الطبيب · التخصص · المنطقة · الصيدلية · الايتم · ملاحظات
            </span>
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
              onChange={e => e.target.files?.[0] && importExcel(e.target.files[0])} />
            <button onClick={() => fileRef.current?.click()} disabled={importing}
              style={{ ...btnStyle('var(--c-accent)'), opacity: importing ? 0.7 : 1 }}>
              {importing ? '⏳ جاري الاستيراد...' : '📂 اختر ملف Excel'}
            </button>
            {importResult && !importResult.error && (
              <div style={{ fontSize: 13, color: importResult.imported > 0 ? 'var(--c-success)' : 'var(--c-warning)', fontWeight: 600 }}>
                {importResult.imported > 0
                  ? `✅ تم استيراد ${importResult.imported} طبيب`
                  : '⚠️ لم يتم استيراد أي طبيب'}
                {(importResult.skipped ?? 0) > 0 && <span style={{ color: 'var(--c-warning)', marginRight: 8 }}> | تخطي صفوف: {importResult.skipped}</span>}
                {(importResult.errors?.length ?? 0) > 0 && <span style={{ color: 'var(--c-danger)', marginRight: 8 }}> | أخطاء: {importResult.errors.length}</span>}
              </div>
            )}
          </div>
          {importResult?.colMap && (
            <div style={{ marginTop: 12, background: '#fff', borderRadius: 8, padding: 12, border: '1px solid var(--c-success-bg)' }}>
              <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: 'var(--c-text-secondary)' }}>🔍 الأعمدة المكتشفة في ملفك:</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(importResult.colMap).map(([field, col]) => (
                  <span key={field} style={{ padding: '3px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: col ? 'var(--c-success-bg)' : 'var(--c-danger-bg)', color: col ? 'var(--c-success)' : 'var(--c-danger)' }}>
                    {fieldLabels[field] ?? field}: {col ? `"${col}"` : '❌ غير موجود'}
                  </span>
                ))}
              </div>
            </div>
          )}
          {importResult?.error && (
            <div style={{ marginTop: 10, background: 'var(--c-danger-bg)', borderRadius: 8, padding: 12, fontSize: 13 }}>
              <p style={{ margin: '0 0 6px', fontWeight: 700, color: 'var(--c-danger)' }}>❌ {importResult.error}</p>
              {importResult.hint && <p style={{ margin: '0 0 8px', color: 'var(--c-danger)' }}>{importResult.hint}</p>}
              {importResult.detectedCols && (
                <div>
                  <p style={{ margin: '0 0 4px', color: 'var(--c-text-secondary)', fontWeight: 600 }}>الأعمدة الموجودة في ملفك:</p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {importResult.detectedCols.map((c, i) => (
                      <span key={i} style={{ padding: '2px 8px', background: 'var(--c-warning-bg)', color: 'var(--c-warning)', borderRadius: 6, fontFamily: 'monospace', fontSize: 12 }}>{c}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {(importResult?.errors?.length ?? 0) > 0 && (
            <div style={{ marginTop: 10, background: 'var(--c-danger-bg)', borderRadius: 8, padding: 10, fontSize: 12, color: 'var(--c-danger)', maxHeight: 120, overflowY: 'auto' }}>
              {importResult!.errors.map((e, i) => (<div key={i}>صف {e.row}: {e.name} — {e.error}</div>))}
            </div>
          )}
        </div>
      )}

      {error && <div style={alertStyle}>{error}</div>}

      {/* Search & filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <SmartSearch
          value={search}
          onChange={setSearch}
          placeholder="🔍 بحث..."
          suggestions={doctorNameSuggestions}
          style={{ maxWidth: 260, minWidth: 180 }}
        />
        <select value={filterArea} onChange={e => setFilterArea(e.target.value)} style={{ ...inputStyle, maxWidth: 180 }}>
          <option value="all">📍 كل المناطق</option>
          {areas.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
        </select>
        {uniqueClasses.length > 0 && (
          <select value={filterClass} onChange={e => setFilterClass(e.target.value)} style={{ ...inputStyle, maxWidth: 130 }}>
            <option value="all">🏅 كل الكلاسات</option>
            {uniqueClasses.map(c => <option key={c} value={c}>كلاس {c}</option>)}
          </select>
        )}
        <span style={{ fontSize: 12, color: 'var(--c-text-muted)', marginRight: 'auto' }}>
          {filtered.length} طبيب
        </span>
      </div>

      {/* Cards list */}
      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: 40, fontSize: 15 }}>جاري التحميل...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: 40, fontSize: 14 }}>لا توجد بيانات</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((d, idx) => (
            <div key={d.id} style={{
              background: '#fff', borderRadius: 14, border: '1px solid var(--c-border)',
              boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
              padding: '12px 18px', direction: 'rtl',
              display: 'flex', alignItems: 'center', gap: 14,
            }}>
              {/* Number badge */}
              <span style={{
                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                background: 'var(--c-accent-light)', color: 'var(--c-accent)', fontSize: 12, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{idx + 1}</span>

              {/* Main info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)' }}>{d.name}</span>
                  {d.isActive === false && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
                      background: 'var(--c-danger-bg)', color: 'var(--c-danger)',
                    }}>غير نشط</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 5, flexWrap: 'wrap' }}>
                  {showDoctorFields && d.specialty && (
                    <span style={{ fontSize: 11, color: 'var(--c-text-secondary)', display: 'flex', alignItems: 'center', gap: 3 }}>
                      🩺 {d.specialty}
                    </span>
                  )}
                  {showDoctorFields && d.area && (
                    <span style={{ fontSize: 11, color: 'var(--c-accent)', display: 'flex', alignItems: 'center', gap: 3 }}>
                      📍 {d.area.name}
                    </span>
                  )}
                  {showDoctorFields && d.pharmacyName && (
                    <span style={{ fontSize: 11, color: '#0891b2', display: 'flex', alignItems: 'center', gap: 3 }}>
                      🏪 {d.pharmacyName}
                    </span>
                  )}
                  {showDoctorFields && d.targetItem && (
                    <span style={{ fontSize: 11, background: 'var(--c-purple-bg)', color: 'var(--c-purple)', borderRadius: 8, padding: '1px 8px', fontWeight: 600 }}>
                      💊 {d.targetItem.name}
                    </span>
                  )}
                  {showDoctorFields && d.className && (
                    <span style={{ fontSize: 11, background: 'var(--c-warning-bg)', color: 'var(--c-warning)', borderRadius: 8, padding: '1px 8px', fontWeight: 700, border: '1px solid var(--c-warning-border)' }}>
                      {d.className}
                    </span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
                {/* Wish star */}
                {(() => { const isW = wishedDoctors.has(d.id); return (
                  <button onClick={() => toggleWish(d.id, d.name, { specialty: d.specialty, pharmacyName: d.pharmacyName, areaName: d.area?.name })} title={isW ? 'إزالة من قائمة الطلبات' : 'أضف لقائمة الطلبات'} style={{
                    background: isW ? 'var(--c-accent-light)' : 'transparent', border: `1.5px solid ${isW ? 'var(--c-accent)' : 'var(--c-border)'}`,
                    borderRadius: 8, width: 30, height: 30, cursor: 'pointer', fontSize: 15,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    opacity: isW ? 1 : 0.45, transition: 'all 0.15s',
                  }}>⭐</button>
                ); })()}
                <button onClick={() => openEdit(d)} title="تعديل" style={{
                  fontSize: 15, padding: '4px 8px', borderRadius: 8,
                  border: '1px solid var(--c-accent)', background: 'var(--c-accent-light)', color: 'var(--c-accent)',
                  cursor: 'pointer',
                }}>✏️</button>
                <button onClick={() => remove(d.id)} title="حذف" style={{
                  fontSize: 15, padding: '4px 8px', borderRadius: 8,
                  border: '1px solid var(--c-danger-border)', background: 'var(--c-danger-bg)', color: 'var(--c-danger)',
                  cursor: 'pointer',
                }}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      )}
      </>)}

      {/* ── VISITS TAB ───────────────────────────────────── */}
      {activeTab === 'visits' && showVisitAnalysis && (
        <div>
          {/* Rep selector (managers only) */}
          {!isFieldRep && managerReps.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', marginBottom: 6 }}>👤 المندوب</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  onClick={() => setVisitRepFilter(null)}
                  style={{
                    padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: `1.5px solid ${visitRepFilter === null ? 'var(--c-accent)' : 'var(--c-border)'}`,
                    background: visitRepFilter === null ? 'var(--c-accent-light)' : 'var(--c-bg)',
                    color: visitRepFilter === null ? 'var(--c-accent)' : 'var(--c-text-secondary)',
                  }}>الكل</button>
                {managerReps.map(rep => (
                  <button
                    key={rep.userId}
                    onClick={() => setVisitRepFilter(rep.userId)}
                    style={{
                      padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `1.5px solid ${visitRepFilter === rep.userId ? 'var(--c-accent)' : 'var(--c-border)'}`,
                      background: visitRepFilter === rep.userId ? 'var(--c-accent-light)' : 'var(--c-bg)',
                      color: visitRepFilter === rep.userId ? 'var(--c-accent)' : 'var(--c-text-secondary)',
                    }}>{rep.name}</button>
                ))}
              </div>
            </div>
          )}

          {/* Analysis type toggle: doctors vs pharmacies */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {!isFieldRep && showVisitsImport && (
              <button
                onClick={() => setShowVisitsImportModal(true)}
                title="استيراد زيارات الأطباء بالجملة من ملف إكسل خارجي — بدل تسجيلها واحدة تلو الأخرى"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '6px 14px', borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                  border: '1.5px solid var(--c-accent)', background: 'var(--c-accent-light)', color: 'var(--c-accent)', marginInlineEnd: 4,
                }}><Icon name="import" size={13} /> استيراد من إكسل</button>
            )}
            <button
              onClick={() => setVisitAnalysisType('doctors')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                border: `1.5px solid ${visitAnalysisType === 'doctors' ? 'var(--c-accent)' : 'var(--c-border)'}`,
                background: visitAnalysisType === 'doctors' ? 'var(--c-accent-light)' : 'var(--c-bg)',
                color: visitAnalysisType === 'doctors' ? 'var(--c-accent)' : 'var(--c-text-secondary)',
              }}><Icon name="doctor" size={14} /> الأطباء</button>
            <button
              onClick={() => setVisitAnalysisType('pharmacies')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                border: `1.5px solid ${visitAnalysisType === 'pharmacies' ? 'var(--c-accent)' : 'var(--c-border)'}`,
                background: visitAnalysisType === 'pharmacies' ? 'var(--c-accent-light)' : 'var(--c-bg)',
                color: visitAnalysisType === 'pharmacies' ? 'var(--c-accent)' : 'var(--c-text-secondary)',
              }}><Icon name="pharmacy" size={14} /> الصيدليات</button>
          </div>

          {/* ─── DOCTORS ANALYSIS ───────────────────────────── */}
          {visitAnalysisType === 'doctors' && (<>
          {/* Month filter bar */}
          {(() => {
            const now = new Date();
            const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
            const options: { month: number; year: number; label: string }[] = [];
            for (let i = 0; i < 4; i++) {
              const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
              options.push({ month: d.getMonth() + 1, year: d.getFullYear(), label: `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` });
            }
            const currentLabel = visitMonthFilter
              ? (options.find(o => o.month === visitMonthFilter.month && o.year === visitMonthFilter.year)?.label
                  ?? `${MONTHS[visitMonthFilter.month - 1]} ${String(visitMonthFilter.year).slice(2)}`)
              : 'الكل';
            return (
              !showVisitMonthPicker ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 14, direction: 'rtl' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', flexShrink: 0 }}>📅</span>
                  <button
                    style={{
                      fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                      border: '1px solid var(--c-accent)', background: 'var(--c-accent-light)', color: 'var(--c-accent)',
                      cursor: 'default', whiteSpace: 'nowrap',
                    }}>{currentLabel}</button>
                  <button
                    onClick={() => setShowVisitMonthPicker(true)}
                    style={{
                      fontSize: 13, padding: '2px 8px', borderRadius: 14, flexShrink: 0,
                      border: '1px solid var(--c-border)', background: 'transparent', color: 'var(--c-text-muted)',
                      cursor: 'pointer', lineHeight: 1,
                    }}>‹</button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 14, direction: 'rtl', overflowX: 'auto', flexWrap: 'nowrap', paddingBottom: 2, WebkitOverflowScrolling: 'touch' as any }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', flexShrink: 0 }}>📅</span>
                  <button
                    onClick={() => { setVisitMonthFilter(null); setShowVisitMonthPicker(false); }}
                    style={{
                      fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                      border: `1px solid ${visitMonthFilter === null ? 'var(--c-accent)' : 'var(--c-border)'}`,
                      background: visitMonthFilter === null ? 'var(--c-accent-light)' : 'transparent',
                      color: visitMonthFilter === null ? 'var(--c-accent)' : 'var(--c-text-muted)',
                      cursor: 'pointer', whiteSpace: 'nowrap',
                    }}>الكل</button>
                  {options.map(o => {
                    const active = visitMonthFilter?.month === o.month && visitMonthFilter?.year === o.year;
                    return (
                      <button key={`${o.month}-${o.year}`}
                        onClick={() => setVisitMonthFilter({ month: o.month, year: o.year })}
                        style={{
                          fontSize: 11, fontWeight: active ? 700 : 400, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                          border: `1px solid ${active ? 'var(--c-accent)' : 'var(--c-border)'}`,
                          background: active ? 'var(--c-accent-light)' : 'transparent',
                          color: active ? 'var(--c-accent)' : 'var(--c-text-muted)',
                          cursor: 'pointer', whiteSpace: 'nowrap',
                        }}>{o.label}</button>
                    );
                  })}
                </div>
              )
            );
          })()}

          {/* Summary strip */}
          {!visitLoading && visitAreas.length > 0 && (() => {
            const total   = visitAreas.reduce((s, a) => s + a.totalDoctors, 0) + noAreaStats.total;
            const visited = visitAreas.reduce((s, a) => s + a.visitedCount, 0) + noAreaStats.visited;
            const writing = visitAreas.reduce((s, a) => s + a.writingCount, 0) + noAreaStats.writing;
            const pct = total > 0 ? Math.round(visited / total * 100) : 0;
            const sortedAreas = [...visitAreas].sort((a, b) => {
              const pa = a.totalDoctors > 0 ? a.visitedCount / a.totalDoctors : 0;
              const pb = b.totalDoctors > 0 ? b.visitedCount / b.totalDoctors : 0;
              return pb - pa;
            });
            return (
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'إجمالي الأطباء', value: total,   icon: 'doctor' as const,      accent: 'var(--c-accent)',  clickable: 'total' },
                  { label: 'تمت زيارتهم',    value: visited, icon: 'checkCircle' as const, accent: 'var(--c-success)', clickable: 'visited' },
                  { label: 'يكتبون الايتم',  value: writing, icon: 'edit' as const,        accent: 'var(--c-purple)',  clickable: 'writing' },
                  { label: 'نسبة التغطية',   value: `${pct}%`, icon: 'navSalesData' as const, accent: 'var(--c-warning)', clickable: 'coverage' },
                ].map(s => {
                  const isActiveCard = s.clickable === 'coverage' ? showCoveragePopup : s.clickable === 'writing' ? showWritingPopup : s.clickable === 'visited' ? showVisitedPopup : s.clickable === 'total' ? showTotalPopup : false;
                  const borderColor  = isActiveCard ? s.accent : 'var(--c-border)';
                  const handleClick  = s.clickable === 'coverage' ? () => setShowCoveragePopup(v => !v)
                                     : s.clickable === 'writing'  ? () => setShowWritingPopup(v => !v)
                                     : s.clickable === 'visited'  ? () => setShowVisitedPopup(v => !v)
                                     : s.clickable === 'total'    ? () => setShowTotalPopup(v => !v)
                                     : undefined;
                  return (
                  <div key={s.label}
                    ref={s.clickable === 'coverage' ? coverageCardRef : s.clickable === 'writing' ? writingCardRef : s.clickable === 'visited' ? visitedCardRef : s.clickable === 'total' ? totalCardRef : undefined}
                    onClick={handleClick}
                    style={{
                      flex: '1 1 120px', background: '#fff', borderRadius: 12, padding: '14px 18px',
                      border: `1.5px solid ${borderColor}`,
                      textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                      cursor: s.clickable ? 'pointer' : 'default',
                      position: 'relative', transition: 'border-color 0.15s',
                    }}>
                    <div style={{ color: s.accent, display: 'flex', justifyContent: 'center' }}><Icon name={s.icon} size={22} /></div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: s.accent, lineHeight: 1.2 }}>{s.value}</div>
                    <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginTop: 2 }}>{s.label}</div>
                    {s.clickable && <div style={{ fontSize: 10, color: 'var(--c-accent)', marginTop: 3 }}>▾</div>}

                    {/* Visited doctors popup */}
                    {s.clickable === 'total' && showTotalPopup && (() => {
                      const sorted = [...visitAreas].sort((a, b) => b.totalDoctors - a.totalDoctors);
                      return (
                        <>
                          <div onClick={e => { e.stopPropagation(); setShowTotalPopup(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
                          <div
                            onClick={e => e.stopPropagation()}
                            style={{
                              position: 'fixed', top: '50%', left: '50%',
                              transform: 'translate(-50%,-50%)',
                              background: '#fff', borderRadius: 16, border: '1px solid var(--c-border)',
                              boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                              width: 'min(92vw,380px)', maxHeight: '80vh',
                              display: 'flex', flexDirection: 'column', direction: 'rtl',
                            }}>
                          <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid var(--c-border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-accent)' }}>👥 توزيع الأطباء بالمناطق</span>
                            <button onClick={() => setShowTotalPopup(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 18, lineHeight: 1, display: 'flex' }}><Icon name="close" size={18} /></button>
                          </div>
                          <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
                            {sorted.map((area, idx) => {
                              const pctArea = area.totalDoctors > 0 ? Math.round(area.visitedCount / area.totalDoctors * 100) : 0;
                              const barColor = pctArea >= 80 ? 'var(--c-success)' : pctArea >= 50 ? 'var(--c-accent)' : pctArea > 0 ? 'var(--c-warning)' : 'var(--c-text-muted)';
                              return (
                                <div key={String(area.id)} style={{ padding: '7px 16px', borderBottom: idx < sorted.length - 1 ? '1px solid var(--c-bg)' : 'none' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>📍</span>
                                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text-primary)' }}>{area.name}</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-accent)', background: 'var(--c-accent-light)', padding: '1px 9px', borderRadius: 10 }}>{area.totalDoctors}</span>
                                      <span style={{ fontSize: 11, color: barColor, fontWeight: 600 }}>{pctArea}%</span>
                                    </div>
                                  </div>
                                  <div style={{ height: 4, background: 'var(--c-bg)', borderRadius: 4, overflow: 'hidden' }}>
                                    <div style={{ width: `${pctArea}%`, height: '100%', background: barColor, borderRadius: 4, transition: 'width 0.3s' }} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div style={{ padding: '8px 16px 2px', borderTop: '1px solid var(--c-border-light)', display: 'flex', justifyContent: 'space-between', flexShrink: 0 }}>
                            <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>الإجمالي</span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-accent)' }}>{total} طبيب في {sorted.length} منطقة</span>
                          </div>
                          </div>
                        </>
                      );
                    })()}

                    {/* Visited doctors popup */}
                    {s.clickable === 'visited' && showVisitedPopup && (() => {
                      const visitedDocs = visitAreas.flatMap(a => a.doctors.filter(d => d.visited));
                      return (
                        <>
                          <div onClick={e => { e.stopPropagation(); setShowVisitedPopup(false); setExpandedDocIds(new Set<number>()); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
                          <div
                            onClick={e => e.stopPropagation()}
                            style={{
                              position: 'fixed', top: '50%', left: '50%',
                              transform: 'translate(-50%,-50%)',
                              background: '#fff', borderRadius: 16, border: '1px solid var(--c-border)',
                              boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                              width: 'min(92vw,440px)', maxHeight: '80vh',
                              display: 'flex', flexDirection: 'column', direction: 'rtl',
                            }}>
                          <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--c-border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--c-success)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>✅</div>
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)' }}>الأطباء المُزارون</div>
                                <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{visitedDocs.length} طبيب</div>
                              </div>
                            </div>
                            <button onClick={() => { setShowVisitedPopup(false); setExpandedDocIds(new Set<number>()); }}
                              style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--c-bg)', border: 'none', cursor: 'pointer', color: 'var(--c-text-secondary)', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={14} /></button>
                          </div>
                          {visitedDocs.length === 0 ? (
                            <div style={{ padding: '14px 16px', color: 'var(--c-text-muted)', fontSize: 13 }}>لا توجد زيارات</div>
                          ) : (
                            <div style={{ overflowY: 'auto', flex: 1 }}>
                              {visitedDocs.map((doc, idx) => {
                                const lastVisit = doc.visits[0];
                                const item = lastVisit?.item ?? doc.targetItem;
                                const isExpanded = expandedDocIds.has(doc.id);
                                const hasDetails = showDoctorFields && (doc.specialty || doc.area || (doc as any).pharmacyName);
                                return (
                                  <div key={doc.id} style={{
                                    padding: '11px 16px',
                                    borderBottom: idx < visitedDocs.length - 1 ? '1px solid var(--c-border-light)' : 'none',
                                    direction: 'rtl',
                                  }}>
                                    {/* Name row */}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: hasDetails ? 5 : 0 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                        <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--c-success)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{idx + 1}</span>
                                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)' }}>{doc.name}</span>
                                        {hasDetails && (
                                          <button onClick={() => toggleDocExpand(doc.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: 'var(--c-text-muted)', fontSize: 11, lineHeight: 1, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</button>
                                        )}
                                      </div>
                                      {item && (
                                        <span style={{ fontSize: 10, background: '#fceaea', color: '#8B1C1C', borderRadius: 20, padding: '3px 9px', fontWeight: 700, whiteSpace: 'nowrap', border: '1px solid #f5c6c6' }}>💊 {item.name}</span>
                                      )}
                                    </div>
                                    {/* Collapsible detail chips */}
                                    {isExpanded && hasDetails && (
                                      <div style={{ paddingRight: 29, display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
                                        {doc.specialty && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: 'var(--c-bg)', color: 'var(--c-text-secondary)', borderRadius: 6, padding: '3px 8px', border: '1px solid var(--c-border)' }}>🩺 {doc.specialty}</span>
                                        )}
                                        {doc.area && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: '#FFF0F0', color: '#8B1C1C', borderRadius: 6, padding: '3px 8px', border: '1px solid #f5c6c6' }}>📍 {doc.area.name}</span>
                                        )}
                                        {(doc as any).pharmacyName && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: 'var(--c-accent-light)', color: 'var(--c-accent)', borderRadius: 6, padding: '3px 8px', border: '1px solid var(--c-accent)' }}>🏥 {(doc as any).pharmacyName}</span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          </div>
                        </>
                      );
                    })()}

                    {/* Coverage popup */}
                    {s.clickable === 'coverage' && showCoveragePopup && (
                      <>
                        <div onClick={e => { e.stopPropagation(); setShowCoveragePopup(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
                        <div
                          onClick={e => e.stopPropagation()}
                          style={{
                            position: 'fixed', top: '50%', left: '50%',
                            transform: 'translate(-50%,-50%)',
                            background: '#fff', borderRadius: 16, border: '1px solid var(--c-border)',
                            boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                            width: 'min(92vw,360px)', maxHeight: '80vh',
                            display: 'flex', flexDirection: 'column', direction: 'rtl',
                          }}>
                        <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid var(--c-border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, marginBottom: 6 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)' }}>📊 التغطية بالمناطق</span>
                          <button onClick={() => setShowCoveragePopup(false)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 18, lineHeight: 1, display: 'flex' }}><Icon name="close" size={18} /></button>
                        </div>
                        <div style={{ overflowY: 'auto', flex: 1, padding: '0 16px 8px' }}>
                          {sortedAreas.map(area => {
                            const ap = area.totalDoctors > 0 ? Math.round(area.visitedCount / area.totalDoctors * 100) : 0;
                            const barColor = ap >= 80 ? 'var(--c-success)' : ap >= 50 ? 'var(--c-accent)' : ap > 0 ? 'var(--c-warning)' : 'var(--c-border)';
                            return (
                              <div key={String(area.id)} style={{ marginBottom: 11 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-secondary)' }}>{area.name}</span>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{area.visitedCount}/{area.totalDoctors}</span>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: barColor, minWidth: 34, textAlign: 'left' }}>{ap}%</span>
                                  </div>
                                </div>
                                <div style={{ height: 6, borderRadius: 99, background: 'var(--c-bg)', overflow: 'hidden' }}>
                                  <div style={{
                                    height: '100%', borderRadius: 99,
                                    width: `${ap}%`, background: barColor,
                                    transition: 'width 0.4s ease',
                                  }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        </div>
                      </>
                    )}

                    {/* Writing doctors popup */}
                    {s.clickable === 'writing' && showWritingPopup && (() => {
                      const allWritingDocs = visitAreas.flatMap(a => a.doctors.filter(d => d.isWriting))
                        .map(doc => ({ ...doc, _item: doc.visits.find(v => v.feedback === 'writing')?.item ?? doc.targetItem }));
                      // collect unique item names sorted alphabetically
                      const itemNames = [...new Set(
                        allWritingDocs.map(d => d._item?.name).filter(Boolean) as string[]
                      )].sort((a, b) => a.localeCompare(b));
                      const filtered = writingItemFilter
                        ? allWritingDocs.filter(d => d._item?.name === writingItemFilter)
                        : allWritingDocs;
                      return (
                        <>
                          <div onClick={e => { e.stopPropagation(); setShowWritingPopup(false); setWritingItemFilter(null); setExpandedDocIds(new Set<number>()); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
                          <div
                            onClick={e => e.stopPropagation()}
                            style={{
                              position: 'fixed', top: '50%', left: '50%',
                              transform: 'translate(-50%,-50%)',
                              background: '#fff', borderRadius: 16, border: '1px solid var(--c-border)',
                              boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                              width: 'min(92vw,460px)', maxHeight: '80vh',
                              display: 'flex', flexDirection: 'column', direction: 'rtl',
                            }}>
                          {/* Header */}
                          <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--c-border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 32, height: 32, borderRadius: 8, background: '#8B1C1C', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>✏️</div>
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)' }}>الأطباء الكاتبون</div>
                                <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{filtered.length}{writingItemFilter ? `/${allWritingDocs.length}` : ''} طبيب</div>
                              </div>
                            </div>
                            <button onClick={() => { setShowWritingPopup(false); setWritingItemFilter(null); setExpandedDocIds(new Set()); }}
                              style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--c-bg)', border: 'none', cursor: 'pointer', color: 'var(--c-text-secondary)', fontSize: 14, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={14} /></button>
                          </div>
                          {/* Item filter pills */}
                          {itemNames.length > 0 && (
                            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--c-border-light)', display: 'flex', flexWrap: 'wrap', gap: 6, background: 'var(--c-bg)' }}>
                              <button
                                onClick={() => setWritingItemFilter(null)}
                                style={{
                                  fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 20,
                                  border: `1.5px solid ${writingItemFilter === null ? '#8B1C1C' : '#E0E0E0'}`,
                                  background: writingItemFilter === null ? '#8B1C1C' : '#fff',
                                  color: writingItemFilter === null ? '#fff' : 'var(--c-text-secondary)',
                                  cursor: 'pointer', transition: 'all 0.15s',
                                }}>الكل</button>
                              {itemNames.map(name => (
                                <button key={name}
                                  onClick={() => setWritingItemFilter(prev => prev === name ? null : name)}
                                  style={{
                                    fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 20,
                                    border: `1.5px solid ${writingItemFilter === name ? '#8B1C1C' : '#E0E0E0'}`,
                                    background: writingItemFilter === name ? '#fceaea' : '#fff',
                                    color: writingItemFilter === name ? '#8B1C1C' : 'var(--c-text-secondary)',
                                    cursor: 'pointer', transition: 'all 0.15s',
                                  }}>💊 {name}</button>
                              ))}
                            </div>
                          )}
                          {/* Doctors list */}
                          {filtered.length === 0 ? (
                            <div style={{ padding: '14px 16px', color: 'var(--c-text-muted)', fontSize: 13 }}>لا يوجد أطباء لهذا الايتم</div>
                          ) : (
                            <div style={{ overflowY: 'auto', flex: 1 }}>
                              {filtered.map((doc, idx) => {
                                const isExpanded = expandedDocIds.has(doc.id);
                                const hasDetails = showDoctorFields && (doc.specialty || doc.area || (doc as any).pharmacyName);
                                return (
                                  <div key={doc.id} style={{
                                    padding: '11px 16px',
                                    borderBottom: idx < filtered.length - 1 ? '1px solid var(--c-border-light)' : 'none',
                                    direction: 'rtl',
                                  }}>
                                    {/* Name row */}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: hasDetails ? 5 : 0 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                        <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#8B1C1C', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{idx + 1}</span>
                                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)' }}>{doc.name}</span>
                                        {hasDetails && (
                                          <button onClick={() => toggleDocExpand(doc.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: 'var(--c-text-muted)', fontSize: 11, lineHeight: 1, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</button>
                                        )}
                                      </div>
                                      {doc._item && !writingItemFilter && (
                                        <span style={{ fontSize: 10, background: '#fceaea', color: '#8B1C1C', borderRadius: 20, padding: '3px 9px', fontWeight: 700, whiteSpace: 'nowrap', border: '1px solid #f5c6c6' }}>💊 {doc._item.name}</span>
                                      )}
                                    </div>
                                    {/* Collapsible detail chips */}
                                    {isExpanded && hasDetails && (
                                      <div style={{ paddingRight: 29, display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
                                        {doc.specialty && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: 'var(--c-bg)', color: 'var(--c-text-secondary)', borderRadius: 6, padding: '3px 8px', border: '1px solid var(--c-border)' }}>🩺 {doc.specialty}</span>
                                        )}
                                        {doc.area && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: '#FFF0F0', color: '#8B1C1C', borderRadius: 6, padding: '3px 8px', border: '1px solid #f5c6c6' }}>📍 {doc.area.name}</span>
                                        )}
                                        {(doc as any).pharmacyName && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: 'var(--c-accent-light)', color: 'var(--c-accent)', borderRadius: 6, padding: '3px 8px', border: '1px solid var(--c-accent)' }}>🏥 {(doc as any).pharmacyName}</span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Search + filter */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <SmartSearch
              value={visitSearch}
              onChange={setVisitSearch}
              placeholder="بحث..."
              suggestions={visitAreas.flatMap(a => a.doctors.map((d: any) => d.name))}
              style={{ maxWidth: 260, minWidth: 180 }}
            />
            <button onClick={() => setShowOnlyVisited(v => !v)} style={{
              padding: '7px 14px', borderRadius: 8, border: `1.5px solid ${showOnlyVisited ? 'var(--c-success)' : 'var(--c-border)'}`,
              background: showOnlyVisited ? 'var(--c-success-bg)' : '#fff', color: showOnlyVisited ? 'var(--c-success)' : 'var(--c-text-secondary)',
              cursor: 'pointer', fontSize: 13, fontWeight: 600, transition: 'all 0.15s',
            }}>
              {showOnlyVisited ? '✅ المُزارون فقط' : '👥 جميع الأطباء'}
            </button>
            <button onClick={() => setExpandedAreas(
              expandedAreas.size > 0 ? new Set() : new Set(visitAreas.map(a => String(a.id)))
            )} style={{
              padding: '7px 14px', borderRadius: 8, border: '1.5px solid var(--c-border)',
              background: '#fff', color: 'var(--c-text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}>
              {expandedAreas.size > 0 ? '▲ طي الكل' : '▼ فتح الكل'}
            </button>
            {wishedDoctors.size > 0 && (
              <button onClick={() => setShowWishPanel(v => !v)} style={{
                padding: '7px 14px', borderRadius: 8,
                border: `1.5px solid ${showWishPanel ? 'var(--c-accent)' : 'var(--c-border)'}`,
                background: showWishPanel ? 'var(--c-accent-light)' : 'var(--c-bg)',
                color: 'var(--c-accent)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
              }}>
                ⭐ قائمة الطلبات ({wishedDoctors.size})
              </button>
            )}
          </div>

          {/* Wished doctors panel */}
          {showWishPanel && wishedDoctors.size > 0 && (() => {
            const allDocsMap: Record<number, (typeof visitAreas)[0]['doctors'][0]> = {};
            visitAreas.flatMap(a => a.doctors).forEach(d => { allDocsMap[d.id] = d; });
            // Build wished list from wishedDoctors Set — include doctors even if they have no visits
            const wished = [...wishedDoctors].map(id => allDocsMap[id] ?? { id, name: wishedNames[id] ?? `دكتور #${id}`, specialty: undefined, area: undefined, targetItem: undefined });
            return (
              <div style={{
                background: 'var(--c-bg)',
                border: '1.5px solid var(--c-border)', borderRadius: 16,
                padding: '16px 18px', marginBottom: 18,
                boxShadow: '0 2px 12px rgba(99,102,241,0.07)',
              }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>📋</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-accent)' }}>أطباء مطلوبون في البلان</span>
                    <span style={{
                      background: 'var(--c-accent)', color: '#fff', borderRadius: 99,
                      fontSize: 11, fontWeight: 700, padding: '1px 8px', minWidth: 22, textAlign: 'center',
                    }}>{wished.length}</span>
                  </div>
                  <button onClick={() => {
                    setWishedDoctors(new Set());
                    setWishedItems({});
                    setWishedNames({});
                    localStorage.removeItem(wishKey);
                    localStorage.removeItem(itemsKey);
                    localStorage.removeItem(namesKey);
                  }} style={{
                    background: 'none', border: '1px solid var(--c-border)', borderRadius: 7,
                    padding: '3px 10px', fontSize: 11, color: 'var(--c-text-secondary)', cursor: 'pointer', fontWeight: 600,
                  }}>مسح الكل</button>
                  <button
                    onClick={syncWishlistToBackend}
                    disabled={wishSyncing}
                    style={{
                      background: wishSyncMsg ? (wishSyncMsg.ok ? 'var(--c-success-bg)' : 'var(--c-danger-bg)') : 'var(--c-accent-light)',
                      border: `1px solid ${wishSyncMsg ? (wishSyncMsg.ok ? 'var(--c-success-border)' : 'var(--c-danger-border)') : 'var(--c-accent)'}`,
                      borderRadius: 7, padding: '3px 10px', fontSize: 11,
                      color: wishSyncMsg ? (wishSyncMsg.ok ? 'var(--c-success)' : 'var(--c-danger)') : 'var(--c-accent)',
                      cursor: wishSyncing ? 'default' : 'pointer', fontWeight: 600,
                    }}
                  >{wishSyncing ? '⏳ جاري...' : wishSyncMsg ? wishSyncMsg.text : '☁ مزامنة'}</button>
                </div>

                {/* Cards grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
                  {wished.map((d, idx) => {
                    const currentItem = wishedItems[d.id] ?? d.targetItem?.name ?? '';
                    const showDrop = openItemDropdowns.has(d.id);
                    const filteredItems = currentItem.trim()
                      ? items.filter(it => it.name.toLowerCase().includes(currentItem.toLowerCase()))
                      : items;
                    // Extra info: prefer live data from map, fall back to stored wishedInfo
                    const info = wishedInfo[d.id] ?? {};
                    const specialty   = (d as any).specialty   ?? info.specialty;
                    const pharmacyName= (d as any).pharmacyName?? info.pharmacyName;
                    const areaName    = (d as any).area?.name  ?? info.areaName;
                    const addedBy     = info.addedBy;
                    const hasDetails  = !!(specialty || pharmacyName || areaName || addedBy);
                    const detailOpen  = openWishDetails.has(d.id);
                    return (
                      <div key={d.id} style={{
                        background: '#fff', borderRadius: 12, padding: '12px 12px 10px',
                        border: '1.5px solid var(--c-border)', direction: 'rtl',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                        position: 'relative',
                      }}>
                        {/* Remove button */}
                        <button onClick={() => toggleWish(d.id, d.name)} style={{
                          position: 'absolute', top: 8, left: 8,
                          background: 'none', border: 'none', cursor: 'pointer',
                          fontSize: 15, color: 'var(--c-text-muted)', lineHeight: 1, padding: 2,
                        }}>×</button>

                        {/* Number badge */}
                        <span style={{
                          position: 'absolute', top: 8, right: 10,
                          background: 'var(--c-accent-light)', color: 'var(--c-accent)',
                          borderRadius: 99, fontSize: 10, fontWeight: 700,
                          padding: '1px 6px',
                        }}>{idx + 1}</span>

                        <div style={{ marginTop: 14, marginBottom: 6 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)' }}>{d.name}</div>
                        </div>

                        {/* Collapsible details */}
                        {hasDetails && (
                          <div style={{ marginBottom: 7 }}>
                            <button
                              onClick={() => setOpenWishDetails(prev => { const s = new Set(prev); s.has(d.id) ? s.delete(d.id) : s.add(d.id); return s; })}
                              style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--c-text-muted)' }}
                            >
                              <span style={{ fontSize: 10, display: 'inline-block', transition: 'transform 0.2s', transform: detailOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                              <span style={{ fontSize: 10, fontWeight: 600 }}>{detailOpen ? 'إخفاء التفاصيل' : 'تفاصيل'}</span>
                            </button>
                            {detailOpen && (
                              <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
                                {specialty && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                                    <span style={{ color: 'var(--c-text-muted)', flexShrink: 0 }}>🩺</span>
                                    <span style={{ color: 'var(--c-text-secondary)', fontWeight: 600 }}>{specialty}</span>
                                  </div>
                                )}
                                {pharmacyName && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                                    <span style={{ color: 'var(--c-text-muted)', flexShrink: 0 }}>🏥</span>
                                    <span style={{ color: 'var(--c-text-secondary)', fontWeight: 600 }}>{pharmacyName}</span>
                                  </div>
                                )}
                                {areaName && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                                    <span style={{ color: 'var(--c-text-muted)', flexShrink: 0 }}>📍</span>
                                    <span style={{ color: 'var(--c-text-secondary)', fontWeight: 600 }}>{areaName}</span>
                                  </div>
                                )}
                                {addedBy && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                                    <span style={{ color: 'var(--c-text-muted)', flexShrink: 0 }}>👤</span>
                                    <span style={{ color: 'var(--c-text-secondary)', fontWeight: 600 }}>{addedBy}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Item dropdown */}
                        <div style={{ position: 'relative' }}>
                          <div style={{
                            display: 'flex', alignItems: 'center',
                            border: '1.5px solid var(--c-border)', borderRadius: 8,
                            background: 'var(--c-bg)', overflow: 'hidden',
                          }}>
                            <input
                              value={currentItem}
                              onChange={e => { setWishedItem(d.id, e.target.value); toggleItemDrop(d.id, true); }}
                              onFocus={() => toggleItemDrop(d.id, true)}
                              onBlur={() => setTimeout(() => toggleItemDrop(d.id, false), 160)}
                              placeholder="اختر الايتم..."
                              style={{
                                flex: 1, padding: '5px 8px', fontSize: 12, border: 'none',
                                background: 'transparent', color: 'var(--c-accent)', fontWeight: 600,
                                outline: 'none', direction: 'rtl', minWidth: 0,
                              }}
                            />
                            <button
                              onMouseDown={e => { e.preventDefault(); toggleItemDrop(d.id); }}
                              style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                padding: '0 8px', color: 'var(--c-accent)', fontSize: 12, flexShrink: 0,
                              }}>▾</button>
                          </div>
                          {showDrop && filteredItems.length > 0 && (
                            <div style={{
                              position: 'absolute', top: 'calc(100% + 3px)', right: 0, left: 0, zIndex: 200,
                              background: '#fff', border: '1px solid var(--c-border)', borderRadius: 9,
                              boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
                              maxHeight: 160, overflowY: 'auto',
                            }}>
                              {filteredItems.map(it => (
                                <div key={it.id}
                                  onMouseDown={() => { setWishedItem(d.id, it.name); toggleItemDrop(d.id, false); }}
                                  style={{
                                    padding: '7px 12px', fontSize: 12, cursor: 'pointer',
                                    color: 'var(--c-accent)', fontWeight: 600,
                                    borderBottom: '1px solid var(--c-bg)',
                                    background: currentItem === it.name ? 'var(--c-accent-light)' : '#fff',
                                  }}
                                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-bg)')}
                                  onMouseLeave={e => (e.currentTarget.style.background = currentItem === it.name ? 'var(--c-accent-light)' : '#fff')}
                                >{it.name}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{
                  marginTop: 12, fontSize: 12, color: 'var(--c-accent)',
                  padding: '7px 12px', background: 'var(--c-accent-light)', borderRadius: 9,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span>💡</span>
                  <span>هؤلاء الأطباء محفوظون لتذكير المدير بتضمينهم في البلان القادم</span>
                </div>
              </div>
            );
          })()}

          {/* ── Manager: wishlists of assigned reps (collapsible panel) ── */}
          {!isFieldRep && (
            <div style={{ marginBottom: 18, border: '2px solid var(--c-accent)', borderRadius: 14, overflow: 'hidden', direction: 'rtl' }}>
              {/* Panel header — always visible, click to open/close */}
              <div
                onClick={() => {
                  const opening = !teamWishPanelOpen;
                  setTeamWishPanelOpen(opening);
                  if (opening) loadTeamWishlists(); // always refresh on open
                }}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', background: teamWishPanelOpen ? 'var(--c-accent-light)' : 'var(--c-bg)', cursor: 'pointer', userSelect: 'none' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 17 }}>👥</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-accent)' }}>قائمة طلبات المندوبين</span>
                  {teamWishLoaded && teamWishList.length > 0 && (
                    <span style={{ background: 'var(--c-accent)', color: '#fff', borderRadius: 99, fontSize: 11, fontWeight: 700, padding: '2px 9px' }}>
                      {teamWishList.length} مندوب
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {teamWishPanelOpen && (
                    <button
                      onClick={e => { e.stopPropagation(); loadTeamWishlists(); }}
                      disabled={teamWishLoading}
                      title="تحديث"
                      style={{ background: '#fff', border: '1px solid var(--c-accent)', borderRadius: 7, padding: '3px 9px', fontSize: 11, color: 'var(--c-accent)', cursor: teamWishLoading ? 'default' : 'pointer', fontWeight: 600 }}
                    >{teamWishLoading ? '⏳' : '🔄 تحديث'}</button>
                  )}
                  <span style={{ fontSize: 13, color: 'var(--c-text-muted)', display: 'inline-block', transition: 'transform 0.2s', transform: teamWishPanelOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                </div>
              </div>

              {/* Panel body */}
              {teamWishPanelOpen && (
                <div style={{ padding: '12px 14px', background: '#fff', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {teamWishLoading ? (
                    <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--c-text-muted)', fontSize: 13 }}>⏳ جاري تحميل البيانات...</div>
                  ) : !teamWishLoaded ? null
                  : teamWishList.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '18px 0', color: 'var(--c-text-muted)', fontSize: 13 }}>لا يوجد مندوبون معيّنون</div>
                  ) : (
                    teamWishList.map(teamEntry => {
                      const repId = teamEntry.rep.id;
                      const rw = repWishlists[repId] ?? { rep: teamEntry.rep, wishlist: teamEntry.wishlist, loading: false, open: false, openDetails: new Set() };
                      const isOpen = rw?.open ?? false;
                      const wishCount = rw?.wishlist?.length ?? 0;
                      return (
                        <div key={repId} style={{ border: '1.5px solid var(--c-accent-light)', borderRadius: 10, overflow: 'hidden' }}>
                          {/* Rep row */}
                          <div
                            onClick={() => {
                              if (isOpen) {
                                setRepWishlists(prev => ({ ...prev, [repId]: { ...prev[repId], open: false } }));
                              } else {
                                // Always re-fetch fresh data from backend on open
                                loadRepWishlist(repId);
                              }
                            }}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 13px', background: isOpen ? '#f0f4ff' : 'var(--c-bg)', cursor: 'pointer' }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 13 }}>👤</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text-primary)' }}>{teamEntry.rep.name}</span>
                              <span style={{ background: wishCount > 0 ? 'var(--c-accent)' : 'var(--c-border)', color: wishCount > 0 ? '#fff' : 'var(--c-text-muted)', borderRadius: 99, fontSize: 11, fontWeight: 700, padding: '1px 8px', minWidth: 20, textAlign: 'center' }}>
                                {rw?.loading ? '...' : wishCount}
                              </span>
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--c-text-muted)', display: 'inline-block', transition: 'transform 0.2s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                          </div>
                          {/* Rep wishlist */}
                          {isOpen && (
                            <div style={{ padding: '10px 13px', background: '#fff', borderTop: '1px solid var(--c-accent-light)' }}>
                              {rw?.loading ? (
                                <div style={{ textAlign: 'center', padding: '12px 0', color: 'var(--c-text-muted)', fontSize: 12 }}>⏳ جاري التحميل...</div>
                              ) : wishCount === 0 ? (
                                <div style={{ textAlign: 'center', padding: '10px 0', color: 'var(--c-text-muted)', fontSize: 12 }}>لا يوجد أطباء مطلوبون</div>
                              ) : (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 7 }}>
                                  {rw.wishlist.map((w, idx) => {
                                    const detailOpen = rw.openDetails.has(w.doctorId);
                                    const hasDetails = !!(w.specialty || w.pharmacyName || w.areaName);
                                    return (
                                      <div key={w.doctorId} style={{ background: 'var(--c-bg)', borderRadius: 9, padding: '9px 11px', border: '1px solid var(--c-border)', position: 'relative' }}>
                                        <span style={{ position: 'absolute', top: 6, right: 8, background: 'var(--c-accent-light)', color: 'var(--c-accent)', borderRadius: 99, fontSize: 9, fontWeight: 700, padding: '1px 5px' }}>{idx + 1}</span>
                                        <div style={{ marginTop: 13, marginBottom: 3, fontSize: 12, fontWeight: 700, color: 'var(--c-text-primary)' }}>{w.doctorName}</div>
                                        {w.itemName && <div style={{ fontSize: 10, color: 'var(--c-accent)', fontWeight: 600, marginBottom: 3 }}>💊 {w.itemName}</div>}
                                        {hasDetails && (
                                          <div>
                                            <button
                                              onClick={e => { e.stopPropagation(); setRepWishlists(prev => {
                                                const cur = prev[repId];
                                                const s = new Set(cur.openDetails);
                                                s.has(w.doctorId) ? s.delete(w.doctorId) : s.add(w.doctorId);
                                                return { ...prev, [repId]: { ...cur, openDetails: s } };
                                              }); }}
                                              style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--c-text-muted)' }}
                                            >
                                              <span style={{ fontSize: 9, display: 'inline-block', transition: 'transform 0.2s', transform: detailOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                                              <span style={{ fontSize: 10, fontWeight: 600 }}>{detailOpen ? 'إخفاء' : 'تفاصيل'}</span>
                                            </button>
                                            {detailOpen && (
                                              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                {w.specialty && <div style={{ fontSize: 10, color: 'var(--c-text-secondary)' }}>🩺 {w.specialty}</div>}
                                                {w.pharmacyName && <div style={{ fontSize: 10, color: 'var(--c-text-secondary)' }}>🏥 {w.pharmacyName}</div>}
                                                {w.areaName && <div style={{ fontSize: 10, color: 'var(--c-text-secondary)' }}>📍 {w.areaName}</div>}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}
          {visitLoading && visitAreas.length === 0 && (
            <div style={{ textAlign: 'center', padding: 60, color: 'var(--c-text-muted)' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
              جاري التحميل...
            </div>
          )}

          {!visitLoading && visitAreas.length === 0 && (
            <div style={{ textAlign: 'center', padding: 60, color: 'var(--c-text-muted)' }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>📭</div>
              لا توجد بيانات زيارات
            </div>
          )}

          <div style={{ opacity: visitLoading ? 0.45 : 1, transition: 'opacity 0.15s', pointerEvents: visitLoading ? 'none' : 'auto' }}>
          {visitAreasSorted.map(area => {
            const key     = String(area.id);
            const isOpen  = expandedAreas.has(key);
            const pct     = area.totalDoctors > 0 ? Math.round(area.visitedCount / area.totalDoctors * 100) : 0;
            const searchQ = visitSearch.trim().toLowerCase();

            const sorted = visitDoctorsByArea.get(key) ?? [];
            if (sorted.length === 0 && searchQ) return null;

            return (
              <div key={key} style={{
                background: '#fff', borderRadius: 14, border: '1px solid var(--c-border)',
                marginBottom: 12, overflow: 'hidden',
                boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
                transition: 'box-shadow 0.15s',
              }}>
                {/* Area header */}
                <button onClick={() => toggleArea(key)} style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                  padding: '11px 16px', background: 'var(--c-bg)', border: 'none', cursor: 'pointer',
                  textAlign: 'right', direction: 'rtl',
                }}>
                  <div style={{ flex: 1, textAlign: 'right' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)' }}>{area.name}</span>
                    <span style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginRight: 10 }}>
                      {area.totalDoctors} طبيب
                      {area.visitedCount > 0 && ` · ${area.visitedCount} زيارة`}
                      {area.writingCount > 0 && ` · ${area.writingCount} كتابة`}
                      {(area.totalDoctors - area.visitedCount) > 0 && ` · ${area.totalDoctors - area.visitedCount} لم يُزار`}
                    </span>
                  </div>
                  <span style={{
                    fontSize: 11, fontWeight: 700,
                    color: pct >= 80 ? 'var(--c-success)' : pct >= 50 ? 'var(--c-accent)' : 'var(--c-warning)',
                    background: pct >= 80 ? 'var(--c-success-bg)' : pct >= 50 ? 'var(--c-accent-light)' : 'var(--c-warning-bg)',
                    border: `1px solid ${pct >= 80 ? 'var(--c-success-border)' : pct >= 50 ? 'var(--c-accent)' : 'var(--c-warning-border)'}`,
                    borderRadius: 6, padding: '2px 8px', flexShrink: 0,
                  }}>{pct}%</span>
                  {canSeePharmNet && (() => {
                    const stats = visitAreaStatsMap.get(area.name);
                    if (!stats || stats.total === 0) return null;
                    const pctSales = Math.round(stats.withSales.length / stats.total * 100);
                    const bc = pctSales >= 80 ? 'var(--c-success)' : pctSales >= 50 ? 'var(--c-warning)' : 'var(--c-danger)';
                    return (
                      <button onClick={e => { e.stopPropagation(); setAreaStatsPopup({ areaName: area.name, ...stats }); }}
                        title="إحصائية الصيدليات"
                        style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: bc, background: `color-mix(in srgb, ${bc} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${bc} 31%, transparent)`, borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontWeight: 700, flexShrink: 0 }}>
                        {stats.withSales.length}/{stats.total} ص
                      </button>
                    );
                  })()}

                  <span style={{ fontSize: 18, color: 'var(--c-text-muted)', transition: 'transform 0.2s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                    ▾
                  </span>
                </button>

                {/* Doctors list */}
                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--c-border-light)', padding: '4px 0 8px' }}>
                    {sorted.length === 0 && (
                      <div style={{ padding: '16px 20px', color: 'var(--c-text-muted)', fontSize: 13 }}>لا توجد نتائج</div>
                    )}
                    {sorted.map(doc => {
                      const lastVisit = doc.visits[0];
                      const fb = lastVisit ? (FEEDBACK_LABEL[lastVisit.feedback] ?? FEEDBACK_LABEL.pending) : null;
                      const isVisitOpen = expandedVisits.has(doc.id);
                      const isWished    = wishedDoctors.has(doc.id);
                      return (
                        <div key={doc.id} style={{ borderBottom: '1px solid var(--c-border-light)' }}>
                          {/* Main row */}
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 18px', direction: 'rtl',
                          }}>
                            {/* Status dot */}
                            <span style={{
                              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                              background: doc.isWriting ? 'var(--c-accent)' : doc.visited ? 'var(--c-text-muted)' : 'var(--c-border)',
                            }} />

                            {/* Name + specialty */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {doc.name}
                                </span>
                                {doc.isWriting && (
                                  <span style={{
                                    fontSize: 10, padding: '1px 5px', borderRadius: 4,
                                    background: 'var(--c-accent-light)', border: '1px solid var(--c-accent)',
                                    flexShrink: 0, lineHeight: 1.4, color: 'var(--c-accent)', fontWeight: 600,
                                  }}>كتابة</span>
                                )}
                              </div>
                              {doc.specialty && <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 1 }}>{doc.specialty}</div>}
                              {doc.pharmacyName && (
                                <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <span>{doc.pharmacyName}</span>
                                  {canSeePharmNet && (() => {
                                    const { exact, similar } = findNetMatchesFast(doc.pharmacyName!, doc.area?.name);
                                    if (!exact && similar.length === 0) return null;
                                    const c = exact ? (exact.totalValue > 0 ? 'var(--c-success)' : 'var(--c-warning)') : 'var(--c-accent)';
                                    return (
                                      <button onClick={e => { e.stopPropagation(); setPharmComparePopup({ docName: doc.name, pharmName: doc.pharmacyName!, areaName: doc.area?.name ?? null, exact, similar }); }}
                                        title="مقارنة بيانات المبيع" style={{ background: `color-mix(in srgb, ${c} 15%, transparent)`, border: `2px solid ${c}`, borderRadius: 7, padding: '2px 7px', fontSize: 11, color: c, cursor: 'pointer', flexShrink: 0, lineHeight: 1.4, fontWeight: 700 }}>
                                        📊
                                      </button>
                                    );
                                  })()}
                                </div>
                              )}
                            </div>

                            {/* Wish button */}
                            <button onClick={() => toggleWish(doc.id, doc.name, { specialty: doc.specialty, pharmacyName: doc.pharmacyName, areaName: doc.area?.name })} title={isWished ? 'إزالة من القائمة' : 'أضف للبلان'} style={{
                              background: isWished ? 'var(--c-accent-light)' : 'transparent', border: `1.5px solid ${isWished ? 'var(--c-accent)' : 'var(--c-border)'}`,
                              borderRadius: 8, width: 30, height: 30, cursor: 'pointer', fontSize: 15,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                              opacity: isWished ? 1 : 0.45,
                              transition: 'all 0.15s',
                            }}>{'⭐'}</button>

                            {/* Visit count with expand toggle */}
                            {doc.visits.length > 0 ? (
                              <button onClick={() => toggleVisitExpand(doc.id)} style={{
                                display: 'flex', alignItems: 'center', gap: 4,
                                fontSize: 12, color: 'var(--c-accent)', fontWeight: 600,
                                background: isVisitOpen ? 'var(--c-accent-light)' : 'var(--c-accent-light)',
                                padding: '3px 8px', borderRadius: 10, flexShrink: 0,
                                border: 'none', cursor: 'pointer', transition: 'background 0.12s',
                              }}>
                                {doc.visits.length} زيارة
                                <span style={{ fontSize: 10, transition: 'transform 0.2s', display: 'inline-block', transform: isVisitOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
                              </button>
                            ) : (
                              <span style={{ fontSize: 12, color: 'var(--c-text-muted)', flexShrink: 0, minWidth: 58 }}>—</span>
                            )}

                            {/* Last visit date */}
                            <span className="doc-row-date" style={{ fontSize: 12, color: 'var(--c-text-secondary)', flexShrink: 0, minWidth: 72, textAlign: 'center' }}>
                              {lastVisit ? fmt(lastVisit.visitDate) : '—'}
                            </span>

                            {/* Item */}
                            <span className="doc-row-item" style={{ fontSize: 12, color: 'var(--c-text-secondary)', flexShrink: 0, minWidth: 70, textAlign: 'center' }}>
                              {lastVisit?.item?.name ?? doc.targetItem?.name ?? '—'}
                            </span>

                            {/* Feedback chip */}
                            {fb ? (
                              <span style={{
                                fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 10,
                                background: fb.bg, color: fb.color, flexShrink: 0, minWidth: 58, textAlign: 'center',
                              }}>{fb.label}</span>
                            ) : (
                              <span style={{ fontSize: 11, color: 'var(--c-text-muted)', flexShrink: 0, minWidth: 58, textAlign: 'center' }}>لم يُزر</span>
                            )}
                          </div>

                          {/* Expanded visits */}
                          {isVisitOpen && doc.visits.length > 0 && (
                            <div style={{ background: 'var(--c-bg)', borderTop: '1px solid var(--c-border-light)', padding: '8px 18px 8px 18px' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
                                <thead>
                                  <tr style={{ color: 'var(--c-text-muted)', fontWeight: 600 }}>
                                    <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>#</th>
                                    <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>التاريخ</th>
                                    <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>الايتم</th>
                                    <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>الفيدباك</th>
                                    <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>ملاحظات</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {doc.visits.map((v, idx) => {
                                    const vfb = FEEDBACK_LABEL[v.feedback] ?? FEEDBACK_LABEL.pending;
                                    return (
                                      <tr key={v.id} style={{ borderTop: '1px solid var(--c-border-light)' }}>
                                        <td style={{ padding: '5px 8px', color: 'var(--c-text-muted)' }}>{idx + 1}</td>
                                        <td style={{ padding: '5px 8px', color: 'var(--c-text-secondary)', whiteSpace: 'nowrap' }}>{fmt(v.visitDate)}</td>
                                        <td style={{ padding: '5px 8px', color: 'var(--c-text-secondary)' }}>{v.item?.name ?? '—'}</td>
                                        <td style={{ padding: '5px 8px' }}>
                                          <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: vfb.bg, color: vfb.color }}>{vfb.label}</span>
                                        </td>
                                        <td style={{ padding: '5px 8px', color: 'var(--c-text-secondary)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          {v.notes ?? '—'}
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
                    })}
                  </div>
                )}
              </div>
            );
          })}
          </div>{/* end opacity wrapper */}
          </>)}

          {/* ─── PHARMACIES ANALYSIS ────────────────────────── */}
          {visitAnalysisType === 'pharmacies' && (
            <div>
              {/* Month filter bar */}
              {(() => {
                const now = new Date();
                const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
                const options: { month: number; year: number; label: string }[] = [];
                for (let i = 0; i < 4; i++) {
                  const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                  options.push({ month: d.getMonth() + 1, year: d.getFullYear(), label: `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` });
                }
                const currentLabel = pharmVisitMonthFilter
                  ? (options.find(o => o.month === pharmVisitMonthFilter.month && o.year === pharmVisitMonthFilter.year)?.label
                      ?? `${MONTHS[pharmVisitMonthFilter.month - 1]} ${String(pharmVisitMonthFilter.year).slice(2)}`)
                  : 'الكل';
                return (
                  !showPharmMonthPicker ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 14, direction: 'rtl' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', flexShrink: 0 }}>📅</span>
                      <button style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                        border: '1px solid var(--c-accent)', background: 'var(--c-accent-light)', color: 'var(--c-accent)',
                        cursor: 'default', whiteSpace: 'nowrap',
                      }}>{currentLabel}</button>
                      <button
                        onClick={() => setShowPharmMonthPicker(true)}
                        style={{
                          fontSize: 13, padding: '2px 8px', borderRadius: 14, flexShrink: 0,
                          border: '1px solid var(--c-border)', background: 'transparent', color: 'var(--c-text-muted)',
                          cursor: 'pointer', lineHeight: 1,
                        }}>‹</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 14, direction: 'rtl', overflowX: 'auto', flexWrap: 'nowrap', paddingBottom: 2, WebkitOverflowScrolling: 'touch' as any }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', flexShrink: 0 }}>📅</span>
                      <button onClick={() => { setPharmVisitMonthFilter(null); setShowPharmMonthPicker(false); }} style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                        border: `1px solid ${pharmVisitMonthFilter === null ? 'var(--c-accent)' : 'var(--c-border)'}`,
                        background: pharmVisitMonthFilter === null ? 'var(--c-accent-light)' : 'transparent',
                        color: pharmVisitMonthFilter === null ? 'var(--c-accent)' : 'var(--c-text-muted)', cursor: 'pointer', whiteSpace: 'nowrap',
                      }}>الكل</button>
                      {options.map(o => {
                        const active = pharmVisitMonthFilter?.month === o.month && pharmVisitMonthFilter?.year === o.year;
                        return (
                          <button key={`${o.month}-${o.year}`}
                            onClick={() => setPharmVisitMonthFilter({ month: o.month, year: o.year })}
                            style={{
                              fontSize: 11, fontWeight: active ? 700 : 400, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                              border: `1px solid ${active ? 'var(--c-accent)' : 'var(--c-border)'}`,
                              background: active ? 'var(--c-accent-light)' : 'transparent',
                              color: active ? 'var(--c-accent)' : 'var(--c-text-muted)', cursor: 'pointer', whiteSpace: 'nowrap',
                            }}>{o.label}</button>
                        );
                      })}
                    </div>
                  )
                );
              })()}

              {/* Summary strip */}
              {!pharmVisitLoading && pharmVisitAreas.length > 0 && (() => {
                const totalPharma = pharmVisitAreas.reduce((s, a) => s + a.totalPharmacies, 0);
                const totalVisits = pharmVisitAreas.reduce((s, a) => s + a.totalVisits, 0);
                return (
                  <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                    {[
                      { label: 'إجمالي الصيدليات', value: totalPharma, icon: '🏪', accent: 'var(--c-accent)' },
                      { label: 'إجمالي الزيارات',  value: totalVisits, icon: '📍', accent: 'var(--c-accent)' },
                      { label: 'عدد المناطق',       value: pharmVisitAreas.length, icon: '🗺️', accent: 'var(--c-accent)' },
                    ].map(s => (
                      <div key={s.label} style={{
                        flex: '1 1 110px', background: '#fff', borderRadius: 12,
                        padding: '12px 16px', border: `1.5px solid var(--c-border)`,
                        textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                      }}>
                        <div style={{ fontSize: 20 }}>{s.icon}</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: s.accent, lineHeight: 1.2 }}>{s.value}</div>
                        <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 2 }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Search + expand/collapse */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <SmartSearch
                  value={pharmSearch}
                  onChange={setPharmSearch}
                  placeholder="بحث..."
                  suggestions={pharmVisitAreas.flatMap(a => a.pharmacies.map((p: any) => p.name))}
                  style={{ maxWidth: 260, minWidth: 180 }}
                />
                <button onClick={() => setPharmExpandedAreas(
                  pharmExpandedAreas.size > 0 ? new Set() : new Set(pharmVisitAreas.map((a, i) => a.id != null ? String(a.id) : `name-${i}-${a.name}`))
                )} style={{
                  padding: '7px 14px', borderRadius: 8, border: '1.5px solid var(--c-border)',
                  background: '#fff', color: 'var(--c-text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}>
                  {pharmExpandedAreas.size > 0 ? '▲ طي الكل' : '▼ فتح الكل'}
                </button>
              </div>

              {/* Loading — first load only */}
              {pharmVisitLoading && pharmVisitAreas.length === 0 && (
                <div style={{ textAlign: 'center', padding: 60, color: 'var(--c-text-muted)' }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                  جاري التحميل...
                </div>
              )}

              {/* Empty */}
              {!pharmVisitLoading && pharmVisitAreas.length === 0 && (
                <div style={{ textAlign: 'center', padding: 60, color: 'var(--c-text-muted)' }}>
                  <div style={{ fontSize: 44, marginBottom: 12 }}>🏪</div>
                  لا توجد بيانات زيارات صيدليات
                </div>
              )}

              {/* Area groups — keep visible during refresh with opacity */}
              <div style={{ opacity: pharmVisitLoading ? 0.45 : 1, transition: 'opacity 0.15s', pointerEvents: pharmVisitLoading ? 'none' : 'auto' }}>
              {pharmVisitAreas.map((area, aIdx) => {
                const key    = area.id != null ? String(area.id) : `name-${aIdx}-${area.name}`;
                const isOpen = pharmExpandedAreas.has(key);
                const searchQ = pharmSearch.trim().toLowerCase();
                const filteredPharmas = area.pharmacies.filter(p =>
                  !searchQ || p.name.toLowerCase().includes(searchQ)
                );
                if (filteredPharmas.length === 0 && searchQ) return null;
                return (
                  <div key={key} style={{
                    background: '#fff', borderRadius: 14, border: '1px solid var(--c-border)',
                    marginBottom: 12, overflow: 'hidden', boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
                  }}>
                    {/* Area header */}
                    <button onClick={() => setPharmExpandedAreas(prev => {
                      const next = new Set(prev);
                      next.has(key) ? next.delete(key) : next.add(key);
                      return next;
                    })} style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 14,
                      padding: '14px 18px', background: 'none', border: 'none', cursor: 'pointer',
                      textAlign: 'right', direction: 'rtl',
                    }}>
                      <div style={{
                        width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
                        background: 'var(--c-accent-light)', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', fontSize: 18,
                      }}>🏪</div>
                      <div style={{ flex: 1, textAlign: 'right' }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-primary)' }}>{area.name}</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, color: 'var(--c-accent)', background: 'var(--c-accent-light)', borderRadius: 20, padding: '2px 9px' }}>
                            🏪 {area.totalPharmacies} صيدلية
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--c-success)', background: 'var(--c-success-bg)', borderRadius: 20, padding: '2px 9px' }}>
                            📍 {area.totalVisits} زيارة
                          </span>
                        </div>
                      </div>
                      <span style={{ fontSize: 18, color: 'var(--c-text-muted)', transition: 'transform 0.2s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
                    </button>

                    {/* Pharmacies list */}
                    {isOpen && (
                      <div style={{ borderTop: '1px solid var(--c-border-light)', padding: '4px 0 8px' }}>
                        {filteredPharmas.map(pharm => {
                          const pharmKey = `${key}-${pharm.name}`;
                          const isExpanded = expandedPharma.has(pharmKey);
                          return (
                            <div key={pharmKey} style={{ borderBottom: '1px solid var(--c-border-light)' }}>
                              <div style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '10px 18px', direction: 'rtl',
                              }}>
                                <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: 'var(--c-accent)' }} />
                                <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--c-text-primary)' }}>{pharm.name}</div>
                                {pharm.visits.length > 0 ? (
                                  <button onClick={() => setExpandedPharma(prev => {
                                    const next = new Set(prev);
                                    next.has(pharmKey) ? next.delete(pharmKey) : next.add(pharmKey);
                                    return next;
                                  })} style={{
                                    fontSize: 12, color: 'var(--c-accent)', fontWeight: 600,
                                    background: isExpanded ? 'var(--c-accent-light)' : 'var(--c-accent-light)',
                                    padding: '3px 8px', borderRadius: 10, flexShrink: 0,
                                    border: 'none', cursor: 'pointer',
                                  }}>
                                    {pharm.visits.length} زيارة
                                    <span style={{ fontSize: 10, marginRight: 3, display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
                                  </button>
                                ) : (
                                  <span style={{ fontSize: 12, color: 'var(--c-text-muted)', minWidth: 58 }}>—</span>
                                )}
                                <span style={{ fontSize: 12, color: 'var(--c-text-secondary)', minWidth: 72, textAlign: 'center' }}>
                                  {pharm.visits[0] ? fmt(pharm.visits[0].visitDate) : '—'}
                                </span>
                              </div>
                              {isExpanded && pharm.visits.length > 0 && (
                                <div style={{ background: 'var(--c-bg)', borderTop: '1px solid var(--c-border-light)', padding: '8px 18px' }}>
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
                                    <thead>
                                      <tr style={{ color: 'var(--c-text-muted)', fontWeight: 600 }}>
                                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>#</th>
                                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>التاريخ</th>
                                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>الايتمات</th>
                                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>ملاحظات</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {pharm.visits.map((v, idx) => (
                                        <tr key={v.id} style={{ borderTop: '1px solid var(--c-border-light)' }}>
                                          <td style={{ padding: '5px 8px', color: 'var(--c-text-muted)' }}>{idx + 1}</td>
                                          <td style={{ padding: '5px 8px', color: 'var(--c-text-secondary)', whiteSpace: 'nowrap' }}>{fmt(v.visitDate)}</td>
                                          <td style={{ padding: '5px 8px' }}>
                                            {v.items.length > 0
                                              ? v.items.map(it => (
                                                  <span key={it.id} style={{ fontSize: 11, background: 'var(--c-purple-bg)', color: 'var(--c-purple)', borderRadius: 8, padding: '2px 7px', marginLeft: 4, fontWeight: 600 }}>💊 {it.name}</span>
                                                ))
                                              : <span style={{ color: 'var(--c-text-muted)' }}>—</span>
                                            }
                                          </td>
                                          <td style={{ padding: '5px 8px', color: 'var(--c-text-secondary)' }}>{v.notes ?? '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
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
              </div>{/* end opacity wrapper */}
            </div>
          )}
        </div>
      )}

      {/* ── PHARMACIES TAB ───────────────────────────────── */}
      {activeTab === 'pharmacies' && showPharmacies && (
        <div>
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <button onClick={openAddPharm} style={btnStyle('var(--c-success)')}>＋ إضافة صيدلية</button>
            <button onClick={() => { setShowPharmImport(v => !v); setPharmImportResult(null); }} style={btnStyle('var(--c-accent)')}>📊 استيراد Excel</button>
          </div>

          {/* Import panel */}
          {showPharmImport && (
            <div style={{ background: 'var(--c-success-bg)', border: '1px solid var(--c-success-border)', borderRadius: 12, padding: 18, marginBottom: 18 }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--c-success)' }}>📊 استيراد قائمة الصيدليات من Excel</h3>
              <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--c-success)', lineHeight: 1.7 }}>
                الأعمدة المدعومة: <strong>الاسم *</strong> · المالك · الهاتف · العنوان · المنطقة · ملاحظات
              </p>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <input ref={pharmFileRef} type="file" accept=".xlsx,.xls,.csv" disabled={pharmImporting}
                  onChange={e => { const f = e.target.files?.[0]; if (f) importPharmExcel(f); }}
                  style={{ fontSize: 13 }} />
                {pharmImporting && <span style={{ fontSize: 13, color: 'var(--c-success)' }}>⏳ جاري الاستيراد...</span>}
              </div>
              {pharmImportResult && (
                <div style={{ marginTop: 12, fontSize: 13 }}>
                  <div style={{ color: 'var(--c-success)', fontWeight: 700 }}>
                    ✅ تم استيراد {pharmImportResult.imported} صيدلية
                    {pharmImportResult.skipped > 0 && <span style={{ color: 'var(--c-warning)', marginRight: 8 }}>· تم تخطي {pharmImportResult.skipped} موجود مسبقاً</span>}
                  </div>
                  {pharmImportResult.detectedCols && (
                    <div style={{ marginTop: 6, color: 'var(--c-text-secondary)' }}>
                      الأعمدة المكتشفة: {Object.entries(pharmImportResult.detectedCols).map(([k, v]) => `${k} → "${v}"`).join(' · ')}
                    </div>
                  )}
                  {pharmImportResult.errors.length > 0 && (
                    <div style={{ marginTop: 6, color: 'var(--c-danger)' }}>
                      أخطاء: {pharmImportResult.errors.map(e => e.name).join('، ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Search + area filter */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <SmartSearch
              value={surveyPharmSearch}
              onChange={setSurveyPharmSearch}
              placeholder="بحث..."
              suggestions={surveyPharmacies.flatMap(p => [p.name, p.ownerName ?? '', p.areaName ?? '']).filter(Boolean)}
              style={{ maxWidth: 280, minWidth: 180 }}
            />
            {(() => {
              const areas = [...new Set(surveyPharmacies.map(p => p.areaName ?? '').filter(Boolean))].sort();
              return (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button onClick={() => setSurveyPharmArea('all')} style={{
                    fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
                    border: `1.5px solid ${surveyPharmArea === 'all' ? 'var(--c-accent)' : 'var(--c-border)'}`,
                    background: surveyPharmArea === 'all' ? 'var(--c-accent-light)' : 'var(--c-bg)',
                    color: surveyPharmArea === 'all' ? 'var(--c-accent)' : 'var(--c-text-secondary)',
                  }}>الكل</button>
                  {areas.map(a => (
                    <button key={a} onClick={() => setSurveyPharmArea(prev => prev === a ? 'all' : a)} style={{
                      fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
                      border: `1.5px solid ${surveyPharmArea === a ? 'var(--c-accent)' : 'var(--c-border)'}`,
                      background: surveyPharmArea === a ? 'var(--c-accent-light)' : 'var(--c-bg)',
                      color: surveyPharmArea === a ? 'var(--c-accent)' : 'var(--c-text-secondary)',
                    }}>{a}</button>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Loading */}
          {surveyPharmLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: 'var(--c-text-muted)' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
              جاري التحميل...
            </div>
          )}

          {/* Cards grid */}
          {!surveyPharmLoading && (() => {
            const q = surveyPharmSearch.trim().toLowerCase();
            const filtered = surveyPharmacies.filter(p => {
              if (surveyPharmArea !== 'all' && p.areaName !== surveyPharmArea) return false;
              if (q && !p.name.toLowerCase().includes(q) && !(p.ownerName ?? '').toLowerCase().includes(q)) return false;
              return true;
            });
            if (filtered.length === 0) return (
              <div style={{ textAlign: 'center', padding: 60, color: 'var(--c-text-muted)' }}>
                <div style={{ fontSize: 44, marginBottom: 12 }}>🏪</div>
                {surveyPharmacies.length === 0 ? 'لا توجد صيدليات — أضف أو استورد من Excel' : 'لا توجد نتائج للبحث'}
              </div>
            );
            return (
              <>
                <div style={{ fontSize: 13, color: 'var(--c-text-secondary)', marginBottom: 12 }}>
                  {filtered.length} صيدلية{surveyPharmArea !== 'all' && ` في ${surveyPharmArea}`}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                  {filtered.map(p => (
                    <div key={p.id} style={{
                      background: '#fff', borderRadius: 14, padding: '14px 16px',
                      border: '1.5px solid var(--c-border)', boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
                      direction: 'rtl', position: 'relative',
                    }}>
                      {/* Edit / Delete buttons */}
                      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4 }}>
                        <button onClick={() => openEditPharm(p)} title="تعديل"
                          style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: 7, padding: '3px 7px', fontSize: 12, cursor: 'pointer', color: 'var(--c-text-secondary)' }}>✏️</button>
                        <button onClick={() => deletePharm(p.id)} title="حذف"
                          style={{ background: 'var(--c-danger-bg)', border: '1px solid var(--c-danger-border)', borderRadius: 7, padding: '3px 7px', fontSize: 12, cursor: 'pointer', color: 'var(--c-danger)' }}>🗑</button>
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-primary)', marginBottom: 8, paddingLeft: 56 }}>🏪 {p.name}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {p.ownerName && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--c-text-secondary)' }}>
                            <span style={{ color: 'var(--c-text-muted)' }}>👤</span><span>{p.ownerName}</span>
                          </div>
                        )}
                        {p.phone && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--c-text-secondary)' }}>
                            <span style={{ color: 'var(--c-text-muted)' }}>📞</span><span dir="ltr">{p.phone}</span>
                          </div>
                        )}
                        {p.address && (
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13, color: 'var(--c-text-secondary)' }}>
                            <span style={{ color: 'var(--c-text-muted)', marginTop: 1 }}>📍</span><span>{p.address}</span>
                          </div>
                        )}
                        {p.areaName && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, background: 'var(--c-accent-light)', color: 'var(--c-accent)', borderRadius: 20, padding: '2px 10px' }}>
                              {p.areaName}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* ── MY VISITS TAB (زياراتي - for commercial rep) ─── */}
      {activeTab === 'myvisits' && showMyVisits && (
        <div style={{ background: '#fff', borderRadius: 14, padding: 24, boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
            <span style={{ fontSize: 24 }}>📝</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--c-text-primary)' }}>زياراتي الميدانية</div>
              <div style={{ fontSize: 13, color: 'var(--c-text-secondary)', marginTop: 2 }}>سجل زياراتك للأطباء والصيدليات</div>
            </div>
          </div>
          <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: '40px 0', fontSize: 14 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🚀</div>
            قريباً — سيتم إضافة سجل الزيارات الميدانية
          </div>
        </div>
      )}

      {/* ── ARCHIVE TAB (أرشيف السيرفي) ────────────────── */}
      {activeTab === 'archive' && showArchiveTab && (() => {
        const normQ = (s: string) => s.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
        const q = normQ(archiveSearch);
        const filteredAreas = archiveAreas
          .map(area => ({
            ...area,
            doctors: area.doctors.filter(d => {
              const matchArea = archiveAreaFilter === 'all' || normQ(area.name) === normQ(archiveAreaFilter);
              if (!matchArea) return false;
              if (!q) return true;
              return normQ(d.name).includes(q) || normQ(d.specialty ?? '').includes(q) || normQ(d.pharmacyName ?? '').includes(q) || normQ(d.areaName ?? '').includes(q);
            }),
          }))
          .filter(area => (archiveAreaFilter === 'all' || normQ(area.name) === normQ(archiveAreaFilter)) && area.doctors.length > 0);

        // Auto-expand areas that have matching doctors when searching
        const autoExpandedAreas: Set<string> = q
          ? new Set(filteredAreas.map(a => a.name))
          : archiveExpandedAreas;
        const effectiveExpanded = q ? autoExpandedAreas : archiveExpandedAreas;

        const uniqueAreas = [...new Set(archiveAreas.map(a => a.name))];

        return (
          <div>
            {/* Rep selector (managers only) */}
            {!isFieldRep && managerReps.length > 0 && (
              <div style={{ marginBottom: 14, direction: 'rtl' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', marginBottom: 6 }}>👤 المندوب</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => { setArchiveRepFilter(null); setArchiveAreaFilter('all'); }}
                    style={{
                      padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `1.5px solid ${archiveRepFilter === null ? 'var(--c-accent)' : 'var(--c-border)'}`,
                      background: archiveRepFilter === null ? 'var(--c-accent-light)' : 'var(--c-bg)',
                      color: archiveRepFilter === null ? 'var(--c-accent)' : 'var(--c-text-secondary)',
                    }}>الكل</button>
                  {managerReps.map(rep => (
                    <button
                      key={rep.userId}
                      onClick={() => { setArchiveRepFilter(rep.userId); setArchiveAreaFilter('all'); }}
                      style={{
                        padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        border: `1.5px solid ${archiveRepFilter === rep.userId ? 'var(--c-accent)' : 'var(--c-border)'}`,
                        background: archiveRepFilter === rep.userId ? 'var(--c-accent-light)' : 'var(--c-bg)',
                        color: archiveRepFilter === rep.userId ? 'var(--c-accent)' : 'var(--c-text-secondary)',
                      }}>{rep.name}</button>
                  ))}
                </div>
              </div>
            )}
            {/* Stats row */}
            {(() => {
              const allDocsFlat = archiveAreas.flatMap(a => a.doctors);
              const allUniqueItems = [...new Set(allDocsFlat.filter(d => d.isWriting).flatMap(d => d.writingItems))];
              const stats = [
                { icon: '👥', val: archiveTotal,          key: null,       label: 'إجمالي' },
                { icon: '✅', val: archiveTotalVisited,   key: 'visited',  label: 'زيارة' },
                { icon: '✍',  val: archiveTotalWriting,   key: 'writing',  label: 'كتابة' },
                { icon: '💊', val: allUniqueItems.length, key: 'items',    label: 'إيتم' },
              ] as const;
              return (
                <div style={{ display: 'flex', background: '#fff', border: '1px solid var(--c-border)', borderRadius: 10, marginBottom: 16, overflow: 'hidden', direction: 'rtl' }}>
                  {stats.map((s, i) => (
                    <div key={s.label}
                      onClick={() => s.key && (s.val as number) > 0 && setArchiveSubPopup(s.key as any)}
                      style={{
                        flex: 1, padding: '12px 10px', textAlign: 'center',
                        borderLeft: i < stats.length - 1 ? '1px solid var(--c-border)' : 'none',
                        cursor: s.key && (s.val as number) > 0 ? 'pointer' : 'default',
                        background: '#fff', transition: 'background .12s',
                      }}
                      onMouseEnter={e => { if (s.key && (s.val as number) > 0) (e.currentTarget as HTMLDivElement).style.background = 'var(--c-bg)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = '#fff'; }}>
                      <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 2 }}>{s.icon} {s.label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--c-text-primary)', lineHeight: 1 }}>{s.val}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Search + filter bar */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <input value={archiveSearch} onChange={e => setArchiveSearch(e.target.value)}
                placeholder="️و بحث..."
                style={{ flex: '1 1 160px', padding: '7px 11px', borderRadius: 8, border: '1px solid var(--c-border)', fontSize: 13, direction: 'rtl', outline: 'none', background: 'var(--c-bg)' }} />
              <select value={archiveAreaFilter} onChange={e => setArchiveAreaFilter(e.target.value)}
                style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--c-border)', fontSize: 13, direction: 'rtl', background: 'var(--c-bg)', outline: 'none', maxWidth: 160, color: 'var(--c-text-secondary)' }}>
                <option value="all">كل المناطق</option>
                {uniqueAreas.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              {archiveStarred.size > 0 && (
                <button onClick={() => setShowArchiveWishPanel(v => !v)}
                  title="للبلان"
                  style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${showArchiveWishPanel ? 'var(--c-text-secondary)' : 'var(--c-border)'}`,
                    background: showArchiveWishPanel ? 'var(--c-text-primary)' : 'var(--c-bg)', color: showArchiveWishPanel ? '#fff' : 'var(--c-text-secondary)',
                    fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
                  ★ {archiveStarred.size}
                </button>
              )}
              <button onClick={loadArchive} disabled={archiveLoading} title="تحديث"
                style={{ padding: '7px 11px', borderRadius: 8, border: '1px solid var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-text-secondary)', fontSize: 14, cursor: 'pointer', opacity: archiveLoading ? 0.5 : 1 }}>
                {archiveLoading ? '⏳' : '↻'}
              </button>
            </div>

            {/* Import from visits result banner */}
            {importFromVisitsResult && (
              <div style={{ background: importFromVisitsResult.imported > 0 ? 'var(--c-success-bg)' : 'var(--c-bg)', border: `1px solid ${importFromVisitsResult.imported > 0 ? 'var(--c-success-border)' : 'var(--c-border)'}`, borderRadius: 8, padding: '8px 14px', marginBottom: 12, direction: 'rtl', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, color: 'var(--c-text-secondary)' }}>
                  {importFromVisitsResult.imported > 0
                    ? `✅ تم استيراد ${importFromVisitsResult.imported} طبيب جديد من أصل ${importFromVisitsResult.total}`
                    : `ℹ️ جميع الأطباء (${importFromVisitsResult.total}) موجودون في الأرشيف مسبقاً`}
                </span>
                <button onClick={() => setImportFromVisitsResult(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--c-text-muted)', lineHeight: 1, padding: '0 4px', display: 'flex' }}><Icon name="close" size={14} /></button>
              </div>
            )}

            {/* Starred panel */}
            {showArchiveWishPanel && archiveStarred.size > 0 && (() => {
              const allDocsFlat = archiveAreas.flatMap(a => a.doctors);
              const starredDocs = allDocsFlat.filter(d => archiveStarred.has(d.surveyDoctorId));
              return (
                <div style={{ background: '#fff', border: '1px solid var(--c-border)', borderRadius: 10, padding: '12px 16px', marginBottom: 14, direction: 'rtl' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)' }}>★ للبلان <span style={{ fontWeight: 400, color: 'var(--c-text-secondary)', fontSize: 12 }}>({starredDocs.length})</span></span>
                    <button onClick={() => { setArchiveStarred(new Set()); localStorage.removeItem(archiveStarKey); }}
                      style={{ background: 'none', border: '1px solid var(--c-border)', borderRadius: 6, padding: '3px 9px', fontSize: 11, color: 'var(--c-text-muted)', cursor: 'pointer' }}>
                      مسح
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 6 }}>
                    {starredDocs.map((d, idx) => (
                      <div key={d.surveyDoctorId} style={{ background: 'var(--c-bg)', borderRadius: 8, padding: '8px 10px', border: '1px solid var(--c-border)', position: 'relative' }}>
                        <button onClick={() => toggleArchiveStar(d.surveyDoctorId)} style={{ position: 'absolute', top: 5, left: 7, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--c-text-muted)', lineHeight: 1, padding: 0 }}>×</button>
                        <span style={{ position: 'absolute', top: 5, right: 7, fontSize: 10, color: 'var(--c-text-muted)', fontWeight: 600 }}>{idx + 1}</span>
                        <div style={{ marginTop: 12, fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)' }}>{d.name}</div>
                        {d.specialty && <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 1 }}>{d.specialty}</div>}
                        {d.areaName && <div style={{ fontSize: 11, color: 'var(--c-text-secondary)', marginTop: 1 }}>📍 {d.areaName}</div>}
                        {d.isVisited && <div style={{ fontSize: 10, color: 'var(--c-text-secondary)', marginTop: 3 }}>✅{d.visitItems?.length > 0 ? ` ${d.visitItems.join(' · ')}` : ''}</div>}
                        {d.isWriting && d.writingItems.length > 0 && (
                          <div style={{ fontSize: 10, color: 'var(--c-text-secondary)', marginTop: 2 }}>✍ {d.writingItems.join(' · ')}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {archiveLoading ? (
              <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: 40 }}>جاري التحميل...</div>
            ) : filteredAreas.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', direction: 'rtl' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>📚</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-primary)', marginBottom: 8 }}>الأرشيف فارغ</div>
                <div style={{ fontSize: 13, color: 'var(--c-text-secondary)', marginBottom: 20 }}>أضف أطباء من السيرفي لتتبّعهم هنا بشكل مستقل عن الكولات</div>
                <button onClick={() => setShowAddModal(true)}
                  style={{ padding: '10px 24px', background: 'var(--c-purple)', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  ＋ إضافة من السيرفي
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {filteredAreas.map(area => {
                  const isExpanded = effectiveExpanded.has(area.name);
                  const visitedCount = area.doctors.filter(d => d.isVisited).length;
                  const writingCount = area.doctors.filter(d => d.isWriting).length;
                  const pct = area.doctors.length > 0 ? Math.round(visitedCount / area.doctors.length * 100) : 0;
                  return (
                    <div key={area.name} style={{
                      background: '#fff', borderRadius: 14, border: '1px solid var(--c-border)',
                      overflow: 'hidden', boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
                    }}>
                      {/* Area header — formal/clean */}
                      <button onClick={() => setArchiveExpandedAreas(prev => { const s = new Set(prev); s.has(area.name) ? s.delete(area.name) : s.add(area.name); return s; })}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', background: 'var(--c-bg)', border: 'none', cursor: 'pointer', textAlign: 'right', direction: 'rtl' }}>
                        <div style={{ flex: 1, textAlign: 'right' }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)' }}>{area.name}</span>
                          <span style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginRight: 10 }}>
                            {area.doctors.length} طبيب
                            {visitedCount > 0 && ` · ${visitedCount} زيارة`}
                            {writingCount > 0 && ` · ${writingCount} كتابة`}
                            {(area.doctors.length - visitedCount) > 0 && ` · ${area.doctors.length - visitedCount} لم يُزار`}
                          </span>
                        </div>
                        <span style={{
                          fontSize: 11, fontWeight: 700,
                          color: pct >= 80 ? 'var(--c-success)' : pct >= 50 ? 'var(--c-accent)' : 'var(--c-warning)',
                          background: pct >= 80 ? 'var(--c-success-bg)' : pct >= 50 ? 'var(--c-accent-light)' : 'var(--c-warning-bg)',
                          border: `1px solid ${pct >= 80 ? 'var(--c-success-border)' : pct >= 50 ? 'var(--c-accent)' : 'var(--c-warning-border)'}`,
                          borderRadius: 6, padding: '2px 8px', flexShrink: 0,
                        }}>{pct}%</span>
                        {canSeePharmNet && (() => {
                          const stats = archiveAreaStatsMap.get(area.name);
                          if (!stats || stats.total === 0) return null;
                          const pctSales = Math.round(stats.withSales.length / stats.total * 100);
                          const bc = pctSales >= 80 ? 'var(--c-success)' : pctSales >= 50 ? 'var(--c-warning)' : 'var(--c-danger)';
                          return (
                            <button onClick={e => { e.stopPropagation(); setAreaStatsPopup({ areaName: area.name, ...stats }); }}
                              title="إحصائية الصيدليات"
                              style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: bc, background: `color-mix(in srgb, ${bc} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${bc} 31%, transparent)`, borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontWeight: 700, flexShrink: 0 }}>
                              {stats.withSales.length}/{stats.total} ص
                            </button>
                          );
                        })()}
                        <button
                          onClick={e => { e.stopPropagation(); removeAreaFromArchive(area.name, area.doctors.map(d => d.surveyDoctorId)); }}
                          title="حذف المنطقة"
                          style={{ background: 'none', border: '1px solid var(--c-danger-border)', borderRadius: 6, padding: '3px 7px', fontSize: 12, cursor: 'pointer', color: 'var(--c-danger-border)', flexShrink: 0, lineHeight: 1 }}>
                          ×
                        </button>
                        <span style={{ fontSize: 16, color: 'var(--c-text-muted)', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0 }}>▾</span>
                      </button>

                      {/* Doctor list */}
                      {isExpanded && (
                        <div style={{ borderTop: '1px solid var(--c-border-light)', padding: '4px 0 8px' }}>
                          {[...area.doctors]
                            // Marked doctors (visited or writing) float to the top of the
                            // area, regardless of alphabetical order; unmarked keep their
                            // (alphabetical) order below. Array.sort is stable in V8.
                            .sort((a, b) => (a.isVisited || a.isWriting ? 0 : 1) - (b.isVisited || b.isWriting ? 0 : 1))
                            .map(doc => (
                            <div key={doc.surveyDoctorId} style={{ borderBottom: '1px solid var(--c-border-light)' }}>
                              <div style={{
                                display: 'flex', alignItems: 'flex-start', gap: 10,
                                padding: '11px 18px', direction: 'rtl',
                              }}>
                                {/* Status dot */}
                                <span style={{
                                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 6,
                                  background: doc.isWriting ? 'var(--c-accent)' : doc.isVisited ? 'var(--c-text-muted)' : 'var(--c-border)',
                                }} />

                                {/* Main info */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  {/* Name row */}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-primary)' }}>{doc.name}</span>
                                    {doc.isWriting && (
                                      <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--c-accent-light)', border: '1px solid var(--c-accent)', flexShrink: 0, lineHeight: 1.4, color: 'var(--c-accent)', fontWeight: 600 }}>كتابة</span>
                                    )}
                                    {doc.className && (
                                      <span style={{ fontSize: 10, background: 'var(--c-bg)', color: 'var(--c-text-secondary)', borderRadius: 6, padding: '1px 7px', fontWeight: 600 }}>{doc.className}</span>
                                    )}
                                  </div>
                                  {/* Specialty + area */}
                                  <div style={{ display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                                    {doc.specialty && <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{doc.specialty}</span>}
                                    {doc.pharmacyName && (
                                      <>
                                        <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>· {doc.pharmacyName}</span>
                                        {canSeePharmNet && (() => {
                                          const { exact, similar } = findNetMatchesFast(doc.pharmacyName!, doc.areaName);
                                          if (!exact && similar.length === 0) return null;
                                          const c = exact ? (exact.totalValue > 0 ? 'var(--c-success)' : 'var(--c-warning)') : 'var(--c-accent)';
                                          return (
                                            <button onClick={e => { e.stopPropagation(); setPharmComparePopup({ docName: doc.name, pharmName: doc.pharmacyName!, areaName: doc.areaName ?? null, exact, similar }); }}
                                              title="مقارنة بيانات المبيع" style={{ background: `color-mix(in srgb, ${c} 15%, transparent)`, border: `2px solid ${c}`, borderRadius: 7, padding: '2px 7px', fontSize: 11, color: c, cursor: 'pointer', flexShrink: 0, lineHeight: 1.4, fontWeight: 700 }}>
                                              📊
                                            </button>
                                          );
                                        })()}
                                      </>
                                    )}
                                  </div>

                                  {/* Toggle buttons row */}
                                  <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                                    <button onClick={() => patchArchive(doc, { isVisited: !doc.isVisited })}
                                      title="تمت الزيارة"
                                      style={{
                                        padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                        border: `1px solid ${doc.isVisited ? 'var(--c-success)' : 'var(--c-border)'}`,
                                        background: doc.isVisited ? 'var(--c-success-bg)' : 'var(--c-bg)',
                                        color: doc.isVisited ? 'var(--c-success)' : 'var(--c-text-muted)',
                                        transition: 'all .15s',
                                      }}>
                                      {doc.isVisited ? '✔ زيارة' : 'زيارة'}
                                    </button>
                                    <button onClick={() => patchArchive(doc, { isWriting: !doc.isWriting })}
                                      title="يكتب"
                                      style={{
                                        padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                        border: `1px solid ${doc.isWriting ? 'var(--c-accent)' : 'var(--c-border)'}`,
                                        background: doc.isWriting ? 'var(--c-accent-light)' : 'var(--c-bg)',
                                        color: doc.isWriting ? 'var(--c-accent)' : 'var(--c-text-muted)',
                                        transition: 'all .15s',
                                      }}>
                                      {doc.isWriting ? '✎ كتابة' : 'كتابة'}
                                    </button>
                                  </div>

                                  {/* Visit items */}
                                  {doc.isVisited && (
                                    <div style={{ marginTop: 7 }}>
                                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                                        {doc.visitItems.map((item, i) => (
                                          <span key={i} style={{ background: 'var(--c-bg)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)', borderRadius: 6, padding: '2px 9px', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                                            {item}
                                            <button onClick={() => patchArchive(doc, { visitItems: doc.visitItems.filter((_, idx) => idx !== i) })}
                                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', padding: 0, fontSize: 12, lineHeight: 1 }}>×</button>
                                          </span>
                                        ))}
                                        {visitItemInputId === (doc.surveyDoctorId ?? doc.doctorId) ? (
                                          <div style={{ position: 'relative' }}>
                                            <input autoFocus value={visitItemInputVal} onChange={e => setVisitItemInputVal(e.target.value)}
                                              onKeyDown={e => {
                                                if (e.key === 'Enter' && visitItemInputVal.trim()) {
                                                  patchArchive(doc, { visitItems: [...doc.visitItems, visitItemInputVal.trim()] });
                                                  setVisitItemInputVal(''); setVisitItemInputId(null);
                                                } else if (e.key === 'Escape') { setVisitItemInputVal(''); setVisitItemInputId(null); }
                                              }}
                                              onBlur={() => { if (visitItemInputVal.trim()) { patchArchive(doc, { visitItems: [...doc.visitItems, visitItemInputVal.trim()] }); } setVisitItemInputVal(''); setVisitItemInputId(null); }}
                                              style={{ padding: '3px 9px', borderRadius: 6, border: '1px solid var(--c-accent)', fontSize: 11, outline: 'none', width: 90, background: 'var(--c-bg)', color: 'var(--c-text-secondary)' }}
                                              placeholder="إيتم..." />
                                            {(() => {
                                              const q = visitItemInputVal.trim().toLowerCase();
                                              const sugs = q ? archiveItemSuggestions.filter(s => s.toLowerCase().includes(q) && !doc.visitItems.includes(s)) : [];
                                              return sugs.length > 0 ? (
                                                <div style={{ position: 'absolute', top: '100%', right: 0, background: '#fff', border: '1px solid var(--c-border)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 200, minWidth: 140, maxHeight: 150, overflowY: 'auto', marginTop: 2, direction: 'rtl' }}>
                                                  {sugs.slice(0, 8).map(s => (
                                                    <button key={s} onMouseDown={() => { patchArchive(doc, { visitItems: [...doc.visitItems, s] }); setVisitItemInputVal(''); setVisitItemInputId(null); }}
                                                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-bg)')}
                                                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                                                      style={{ display: 'block', width: '100%', background: 'none', border: 'none', padding: '5px 10px', textAlign: 'right', cursor: 'pointer', fontSize: 11, color: 'var(--c-text-secondary)' }}>
                                                      {s}
                                                    </button>
                                                  ))}
                                                </div>
                                              ) : null;
                                            })()}
                                          </div>
                                        ) : (
                                          <button onClick={() => setVisitItemInputId(doc.surveyDoctorId ?? doc.doctorId ?? null)}
                                            style={{ background: 'none', border: '1px dashed var(--c-border)', borderRadius: 4, padding: '1px 7px', fontSize: 11, color: 'var(--c-text-muted)', cursor: 'pointer' }}>
                                            +
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {/* Writing items */}
                                  {doc.isWriting && (
                                    <div style={{ marginTop: 7 }}>
                                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                                        {doc.writingItems.map((item, i) => (
                                          <span key={i} style={{ background: 'var(--c-accent-light)', color: 'var(--c-accent)', border: '1px solid var(--c-accent)', borderRadius: 6, padding: '2px 9px', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                                            {item}
                                            <button onClick={() => patchArchive(doc, { writingItems: doc.writingItems.filter((_, idx) => idx !== i) })}
                                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', padding: 0, fontSize: 12, lineHeight: 1 }}>×</button>
                                          </span>
                                        ))}
                                        {itemInputId === (doc.surveyDoctorId ?? doc.doctorId) ? (
                                          <div style={{ position: 'relative' }}>
                                            <input autoFocus value={itemInputVal} onChange={e => setItemInputVal(e.target.value)}
                                              onKeyDown={e => {
                                                if (e.key === 'Enter' && itemInputVal.trim()) {
                                                  patchArchive(doc, { writingItems: [...doc.writingItems, itemInputVal.trim()] });
                                                  setItemInputVal(''); setItemInputId(null);
                                                } else if (e.key === 'Escape') { setItemInputVal(''); setItemInputId(null); }
                                              }}
                                              onBlur={() => { if (itemInputVal.trim()) { patchArchive(doc, { writingItems: [...doc.writingItems, itemInputVal.trim()] }); } setItemInputVal(''); setItemInputId(null); }}
                                              style={{ padding: '3px 9px', borderRadius: 6, border: '1px solid var(--c-accent)', fontSize: 11, outline: 'none', width: 90, background: 'var(--c-bg)', color: 'var(--c-text-secondary)' }}
                                              placeholder="إيتم..." />
                                            {(() => {
                                              const q = itemInputVal.trim().toLowerCase();
                                              const sugs = q ? archiveItemSuggestions.filter(s => s.toLowerCase().includes(q) && !doc.writingItems.includes(s)) : [];
                                              return sugs.length > 0 ? (
                                                <div style={{ position: 'absolute', top: '100%', right: 0, background: '#fff', border: '1px solid var(--c-border)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 200, minWidth: 140, maxHeight: 150, overflowY: 'auto', marginTop: 2, direction: 'rtl' }}>
                                                  {sugs.slice(0, 8).map(s => (
                                                    <button key={s} onMouseDown={() => { patchArchive(doc, { writingItems: [...doc.writingItems, s] }); setItemInputVal(''); setItemInputId(null); }}
                                                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-bg)')}
                                                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                                                      style={{ display: 'block', width: '100%', background: 'none', border: 'none', padding: '5px 10px', textAlign: 'right', cursor: 'pointer', fontSize: 11, color: 'var(--c-text-secondary)' }}>
                                                      {s}
                                                    </button>
                                                  ))}
                                                </div>
                                              ) : null;
                                            })()}
                                          </div>
                                        ) : (
                                          <button onClick={() => setItemInputId(doc.surveyDoctorId ?? doc.doctorId ?? null)}
                                            style={{ background: 'none', border: '1px dashed var(--c-border)', borderRadius: 4, padding: '1px 7px', fontSize: 11, color: 'var(--c-text-muted)', cursor: 'pointer' }}>
                                            +
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {/* Notes */}
                                  {notesEditId === (doc.surveyDoctorId ?? doc.doctorId) ? (
                                    <div style={{ marginTop: 8 }}>
                                      <input autoFocus value={notesEditVal} onChange={e => setNotesEditVal(e.target.value)}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') { patchArchive(doc, { notes: notesEditVal || null }); setNotesEditId(null); }
                                          else if (e.key === 'Escape') setNotesEditId(null);
                                        }}
                                        onBlur={() => { patchArchive(doc, { notes: notesEditVal || null }); setNotesEditId(null); }}
                                        style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1.5px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', direction: 'rtl' }}
                                        placeholder="ملاحظات..." />
                                    </div>
                                  ) : doc.notes ? (
                                    <div onClick={() => { setNotesEditId(doc.surveyDoctorId ?? doc.doctorId ?? null); setNotesEditVal(doc.notes ?? ''); }}
                                      style={{ marginTop: 5, fontSize: 11, color: 'var(--c-text-secondary)', background: 'var(--c-bg)', padding: '3px 8px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--c-border)' }}>
                                      {doc.notes}
                                    </div>
                                  ) : (
                                    <button onClick={() => { setNotesEditId(doc.surveyDoctorId ?? doc.doctorId ?? null); setNotesEditVal(''); }}
                                      style={{ marginTop: 6, background: 'none', border: 'none', fontSize: 11, color: 'var(--c-border)', cursor: 'pointer', padding: 0 }}>
                                      + ملاحظة
                                    </button>
                                  )}
                                </div>

                                {/* Action buttons: star, edit, remove */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                                  <button onClick={() => toggleArchiveStar(doc.surveyDoctorId)} title={archiveStarred.has(doc.surveyDoctorId) ? 'إزالة من البلان' : 'أضف للبلان'}
                                    style={{
                                      background: archiveStarred.has(doc.surveyDoctorId) ? 'var(--c-warning-bg)' : 'transparent',
                                      border: `1px solid ${archiveStarred.has(doc.surveyDoctorId) ? 'var(--c-warning)' : 'var(--c-border)'}`,
                                      borderRadius: 6, width: 28, height: 28, cursor: 'pointer', fontSize: 14,
                                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      color: archiveStarred.has(doc.surveyDoctorId) ? 'var(--c-warning)' : 'var(--c-text-muted)',
                                      transition: 'all .15s', padding: 0,
                                    }}>
                                    {archiveStarred.has(doc.surveyDoctorId) ? '★' : '☆'}
                                  </button>
                                  <button onClick={() => openEditDoc(doc)} title="تعديل"
                                    style={{ background: 'transparent', border: '1px solid var(--c-border)', borderRadius: 6, width: 28, height: 28, fontSize: 13, cursor: 'pointer', color: 'var(--c-text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, transition: 'all .15s' }}>
                                    ✎
                                  </button>
                                  <button onClick={() => removeFromArchive(doc.surveyDoctorId)} title="إزالة"
                                    style={{ background: 'transparent', border: '1px solid var(--c-border)', borderRadius: 6, width: 28, height: 28, fontSize: 13, cursor: 'pointer', color: 'var(--c-text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, transition: 'all .15s' }}>
                                    ×
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Archive Sub-Popups (visited / writing / items) ─── */}
      {archiveSubPopup !== null && (() => {
        const allDocsFlat = archiveAreas.flatMap(a => a.doctors);
        let title = '';
        let body: React.ReactNode = null;

        if (archiveSubPopup === 'visited') {
          title = '✅ زيارات';
          const visitedDocs = allDocsFlat.filter(d => d.isVisited);
          if (visitedDocs.length === 0) {
            body = <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: 30 }}>لا يوجد</div>;
          } else {
            const areaMap = new Map<string, typeof visitedDocs>();
            visitedDocs.forEach(d => {
              const a = d.areaName ?? 'غير محددة';
              if (!areaMap.has(a)) areaMap.set(a, []);
              areaMap.get(a)!.push(d);
            });
            body = (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[...areaMap.entries()].map(([areaName, docs]) => (
                  <div key={areaName}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-text-secondary)', background: 'var(--c-bg)', borderRadius: 6, padding: '4px 10px', marginBottom: 5, direction: 'rtl', border: '1px solid var(--c-border)' }}>
                      📍 {areaName} <span style={{ fontWeight: 400 }}>({docs.length})</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {docs.map(d => (
                        <div key={d.surveyDoctorId} style={{ padding: '7px 12px', borderRadius: 6, background: 'var(--c-bg)', border: '1px solid var(--c-border)', direction: 'rtl' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text-primary)' }}>{d.name}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                            {d.specialty && <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{d.specialty}</span>}
                            {d.pharmacyName && <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>· {d.pharmacyName}</span>}
                          </div>
                          {d.visitItems.length > 0 && (
                            <div style={{ marginTop: 4, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                              {d.visitItems.map((item, i) => (
                                <span key={i} style={{ background: 'var(--c-bg)', color: 'var(--c-text-secondary)', borderRadius: 4, padding: '1px 7px', fontSize: 11 }}>{item}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          }
        } else if (archiveSubPopup === 'writing') {
          title = '✍ كتابة';
          const writingDocs = allDocsFlat.filter(d => d.isWriting);
          if (writingDocs.length === 0) {
            body = <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: 30 }}>لا يوجد</div>;
          } else {
            const areaMap = new Map<string, typeof writingDocs>();
            writingDocs.forEach(d => {
              const a = d.areaName ?? 'غير محددة';
              if (!areaMap.has(a)) areaMap.set(a, []);
              areaMap.get(a)!.push(d);
            });
            body = (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[...areaMap.entries()].map(([areaName, docs]) => (
                  <div key={areaName}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-text-secondary)', background: 'var(--c-bg)', borderRadius: 6, padding: '4px 10px', marginBottom: 5, direction: 'rtl', border: '1px solid var(--c-border)' }}>
                      📍 {areaName} <span style={{ fontWeight: 400 }}>({docs.length})</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {docs.map(d => (
                        <div key={d.surveyDoctorId} style={{ padding: '7px 12px', borderRadius: 6, background: 'var(--c-bg)', border: '1px solid var(--c-border)', direction: 'rtl' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text-primary)' }}>{d.name}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                            {d.specialty && <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{d.specialty}</span>}
                            {d.writingItems.length > 0 && (
                              <span style={{ fontSize: 11, color: 'var(--c-text-secondary)' }}>{d.writingItems.join(' · ')}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          }
        } else if (archiveSubPopup === 'items') {
          title = '💊 إيتمات';
          const writingDocs = allDocsFlat.filter(d => d.isWriting && d.writingItems.length > 0);
          const itemMap = new Map<string, typeof writingDocs>();
          writingDocs.forEach(d => {
            d.writingItems.forEach(item => {
              if (!itemMap.has(item)) itemMap.set(item, []);
              itemMap.get(item)!.push(d);
            });
          });
          const sortedItems = [...itemMap.entries()].sort((a, b) => b[1].length - a[1].length);
          body = sortedItems.length === 0
            ? <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: 30 }}>لا توجد إيتمات</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sortedItems.map(([item, docs]) => (
                  <div key={item} style={{ borderRadius: 6, border: '1px solid var(--c-border)', background: '#fff', overflow: 'hidden' }}>
                    <div style={{ padding: '7px 12px', background: 'var(--c-bg)', direction: 'rtl', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--c-border)' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text-primary)', flex: 1 }}>{item}</span>
                      <span style={{ fontSize: 11, color: 'var(--c-text-secondary)', background: 'var(--c-border)', borderRadius: 20, padding: '1px 8px' }}>{docs.length}</span>
                    </div>
                    <div style={{ padding: '6px 12px', direction: 'rtl', display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {docs.map(d => (
                        <div key={d.surveyDoctorId} style={{ fontSize: 12, color: 'var(--c-text-secondary)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, color: 'var(--c-text-primary)' }}>{d.name}</span>
                          {d.areaName && <span style={{ color: 'var(--c-text-muted)' }}>{d.areaName}</span>}
                          {d.specialty && <span style={{ color: 'var(--c-text-muted)' }}>· {d.specialty}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>;
        }

        return (
          <div style={overlayStyle} onClick={() => setArchiveSubPopup(null)}>
            <div style={{ ...modalStyle, maxWidth: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, direction: 'rtl' }}>{title}</h2>
                <button onClick={() => setArchiveSubPopup(null)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--c-text-secondary)', display: 'flex' }}><Icon name="close" size={18} /></button>
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>{body}</div>
            </div>
          </div>
        );
      })()}

      {/* ── Edit Doctor Modal ──────────────────────────────── */}
      {editDocId !== null && (
        <div style={overlayStyle} onClick={() => { setEditDocId(null); setEditDocErr(''); }}>
          <div style={{ ...modalStyle, maxWidth: 400 }} onClick={e => e.stopPropagation()} dir="rtl">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-primary)' }}>تعديل بيانات الطبيب</span>
              <button onClick={() => { setEditDocId(null); setEditDocErr(''); }} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--c-text-muted)', lineHeight: 1, display: 'flex' }}><Icon name="close" size={18} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>الاسم *</label>
                <input autoFocus value={editDocName} onChange={e => setEditDocName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && submitEditDoctor()}
                  style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: `1px solid ${editDocErr && !editDocName.trim() ? 'var(--c-danger)' : 'var(--c-border)'}`, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>التخصص</label>
                <input value={editDocSpecialty} onChange={e => setEditDocSpecialty(e.target.value)}
                  style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }}
                  placeholder="مثال: قلب، عيون..." />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>المنطقة</label>
                <input value={editDocArea} onChange={e => setEditDocArea(e.target.value)}
                  style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>الصيدلية</label>
                <input value={editDocPharmacy} onChange={e => setEditDocPharmacy(e.target.value)}
                  style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>الكلاس</label>
                <input value={editDocClass} onChange={e => setEditDocClass(e.target.value)}
                  style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }}
                  placeholder="مثال: A, B, C" />
              </div>
            </div>
            {editDocErr && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--c-danger)', background: 'var(--c-danger-bg)', borderRadius: 6, padding: '6px 10px' }}>{editDocErr}</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={submitEditDoctor} disabled={editDocSaving}
                style={{ flex: 1, padding: '9px 0', background: 'var(--c-text-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: editDocSaving ? 0.7 : 1 }}>
                {editDocSaving ? 'جاري الحفظ...' : 'حفظ التعديلات'}
              </button>
              <button onClick={() => { setEditDocId(null); setEditDocErr(''); }}
                style={{ padding: '9px 16px', background: 'var(--c-bg)', color: 'var(--c-text-secondary)', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── New Custom Doctor Modal ────────────────────────── */}
      {showNewDocForm && (() => {
        const areaOptions = [...new Set(archiveAreas.map(a => a.name))].sort();
        const normN = (s: string) => s.trim().toLowerCase()
          .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
          .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ').trim();
        const wordsOf = (s: string) => normN(s).split(' ').filter(Boolean);
        const namesOverlap = (a: string, b: string) => {
          const wa = wordsOf(a); const wb = wordsOf(b);
          if (wa.length === 0 || wb.length === 0) return false;
          const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
          return shorter.every(w => longer.includes(w));
        };
        const dupMatch = newDocName.trim().length > 1
          ? archiveAreas.flatMap(a => a.doctors).find(d => namesOverlap(d.name, newDocName))
          : null;
        return (
          <div style={overlayStyle} onClick={() => { setShowNewDocForm(false); setNewDocErr(''); }}>
            <div style={{ ...modalStyle, maxWidth: 400 }} onClick={e => e.stopPropagation()} dir="rtl">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-primary)' }}>طبيب جديد</span>
                <button onClick={() => { setShowNewDocForm(false); setNewDocErr(''); }} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--c-text-muted)', lineHeight: 1, display: 'flex' }}><Icon name="close" size={18} /></button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Name */}
                <div>
                  <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>الاسم *</label>
                  <input autoFocus value={newDocName} onChange={e => setNewDocName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && submitCustomDoctor()}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: `1px solid ${dupMatch ? 'var(--c-warning)' : newDocErr && !newDocName.trim() ? 'var(--c-danger)' : 'var(--c-border)'}`, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }}
                    placeholder="اسم الطبيب" />
                  {dupMatch && (
                    <div style={{ marginTop: 5, fontSize: 11, color: 'var(--c-warning)', background: 'var(--c-warning-bg)', border: '1px solid var(--c-warning-border)', borderRadius: 6, padding: '5px 9px' }}>
                      ⚠️ الاسم موجود مسبقاً في {dupMatch.areaName || 'الأرشيف'}
                    </div>
                  )}
                </div>

                {/* Specialty */}
                <div>
                  <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>التخصص</label>
                  <input value={newDocSpecialty} onChange={e => setNewDocSpecialty(e.target.value)}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }}
                    placeholder="مثال: قلب، عيون..." />
                </div>

                {/* Area — dropdown from existing areas + free text */}
                <div>
                  <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>المنطقة</label>
                  {areaOptions.length > 0 ? (
                    <select value={newDocArea} onChange={e => setNewDocArea(e.target.value)}
                      style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-border)', fontSize: 13, outline: 'none', background: 'var(--c-bg)', color: newDocArea ? 'var(--c-text-primary)' : 'var(--c-text-muted)' }}>
                      <option value="">— اختر منطقة —</option>
                      {areaOptions.map(a => <option key={a} value={a}>{a}</option>)}
                      <option value="__custom__">أخرى (أكتب يدوياً)</option>
                    </select>
                  ) : (
                    <input value={newDocArea} onChange={e => setNewDocArea(e.target.value)}
                      style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }}
                      placeholder="اسم المنطقة" />
                  )}
                  {newDocArea === '__custom__' && (
                    <input autoFocus value="" onChange={e => setNewDocArea(e.target.value)}
                      style={{ width: '100%', marginTop: 6, padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-text-muted)', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }}
                      placeholder="اكتب اسم المنطقة..." />
                  )}
                </div>

                {/* Pharmacy */}
                <div>
                  <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>الصيدلية</label>
                  <input value={newDocPharmacy} onChange={e => setNewDocPharmacy(e.target.value)}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }}
                    placeholder="اسم الصيدلية" />
                </div>

                {/* Class */}
                <div>
                  <label style={{ fontSize: 11, color: 'var(--c-text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>الكلاس</label>
                  <input value={newDocClass} onChange={e => setNewDocClass(e.target.value)}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--c-border)', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--c-bg)' }}
                    placeholder="مثال: A, B, C" />
                </div>
              </div>

              {newDocErr && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--c-danger)', background: 'var(--c-danger-bg)', borderRadius: 6, padding: '6px 10px' }}>{newDocErr}</div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button onClick={submitCustomDoctor} disabled={newDocSaving}
                  style={{ flex: 1, padding: '9px 0', background: 'var(--c-text-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: newDocSaving ? 0.7 : 1 }}>
                  {newDocSaving ? 'جاري الحفظ...' : 'حفظ'}
                </button>
                <button onClick={() => { setShowNewDocForm(false); setNewDocErr(''); }}
                  style={{ padding: '9px 16px', background: 'var(--c-bg)', color: 'var(--c-text-secondary)', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
                  إلغاء
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Add from Survey Modal ──────────────────────────── */}
      {showAddModal && (
        <div style={overlayStyle} onClick={() => { setShowAddModal(false); setShowAreaDropdown(false); setSurveyDocSelectedAreas(new Set()); }}>
          <div style={{ ...modalStyle, maxWidth: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>📚 إضافة أطباء من السيرفي</h2>
              <button onClick={() => { setShowAddModal(false); setShowAreaDropdown(false); setSurveyDocSelectedAreas(new Set()); }} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--c-text-secondary)', display: 'flex' }}><Icon name="close" size={18} /></button>
            </div>

            {/* Search + area multi-select */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <input value={surveyDocSearch} onChange={e => setSurveyDocSearch(e.target.value)}
                placeholder="🔍 بحث..."
                style={{ flex: '1 1 160px', padding: '7px 12px', borderRadius: 8, border: '1.5px solid var(--c-border)', fontSize: 13, direction: 'rtl', outline: 'none' }} />
              {/* Area multi-select dropdown */}
              {(() => {
                const allAreas = [...new Set(surveyDoctors.map(d => d.areaName).filter(Boolean) as string[])].sort();
                const selectedCount = surveyDocSelectedAreas.size;
                const label = selectedCount === 0 ? 'كل المناطق' : `${selectedCount} منطقة`;
                return (
                  <div style={{ position: 'relative' }}>
                    <button onClick={() => setShowAreaDropdown(v => !v)}
                      style={{ padding: '7px 12px', borderRadius: 8, border: '1.5px solid var(--c-border)', fontSize: 13, direction: 'rtl', background: selectedCount > 0 ? 'var(--c-purple-bg)' : '#fff', color: selectedCount > 0 ? 'var(--c-purple)' : 'var(--c-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                      📍 {label} <span style={{ fontSize: 10 }}>▼</span>
                    </button>
                    {showAreaDropdown && (
                      <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 999, background: '#fff', border: '1.5px solid var(--c-border)', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', minWidth: 200, maxHeight: 260, overflowY: 'auto', padding: '6px 0' }}>
                        {/* Select all / clear */}
                        <div style={{ display: 'flex', gap: 6, padding: '6px 12px 8px', borderBottom: '1px solid var(--c-border-light)' }}>
                          <button onClick={() => setSurveyDocSelectedAreas(new Set())}
                            style={{ flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--c-border)', background: 'var(--c-bg)', cursor: 'pointer', color: 'var(--c-text-secondary)' }}>
                            الكل
                          </button>
                          <button onClick={() => setSurveyDocSelectedAreas(new Set(allAreas))}
                            style={{ flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--c-border)', background: 'var(--c-bg)', cursor: 'pointer', color: 'var(--c-text-secondary)' }}>
                            تحديد الكل
                          </button>
                        </div>
                        {allAreas.map(a => (
                          <label key={a} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--c-text-primary)', direction: 'rtl' }}>
                            <input type="checkbox" checked={surveyDocSelectedAreas.has(a)}
                              onChange={() => setSurveyDocSelectedAreas(prev => {
                                const next = new Set(prev);
                                next.has(a) ? next.delete(a) : next.add(a);
                                return next;
                              })}
                              style={{ accentColor: 'var(--c-purple)', width: 14, height: 14 }} />
                            {a}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* List */}
            <div style={{ overflowY: 'auto', flex: 1 }} onClick={() => setShowAreaDropdown(false)}>
              {surveyDocLoading ? (
                <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: 30 }}>جاري التحميل...</div>
              ) : (() => {
                const normQ2 = (s: string) => s.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
                const sq = normQ2(surveyDocSearch);
                const filtered2 = surveyDoctors.filter(d => {
                  const matchArea = surveyDocSelectedAreas.size === 0 || surveyDocSelectedAreas.has(d.areaName ?? '');
                  if (!matchArea) return false;
                  if (!sq) return true;
                  return normQ2(d.name).includes(sq) || normQ2(d.specialty ?? '').includes(sq) || normQ2(d.areaName ?? '').includes(sq) || normQ2(d.pharmacyName ?? '').includes(sq);
                });
                if (filtered2.length === 0) return (
                  <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: 30 }}>لا توجد أطباء متاحون للإضافة</div>
                );
                const filteredIds = filtered2.map(d => d.id);
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {/* Import all bar */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--c-bg)', borderRadius: 10, border: '1px solid var(--c-border)', marginBottom: 2 }}>
                      <span style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{filtered2.length} طبيب</span>
                      <button onClick={() => addAllToArchive(filteredIds)} disabled={importingAll}
                        style={{ padding: '5px 14px', background: importingAll ? 'var(--c-purple)' : 'var(--c-purple)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: importingAll ? 'not-allowed' : 'pointer', opacity: importingAll ? 0.7 : 1 }}>
                        {importingAll ? '⏳ جاري الاستيراد...' : '⬇️ استيراد الكل'}
                      </button>
                    </div>
                    {filtered2.map(d => (
                      <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, border: '1px solid var(--c-border-light)', direction: 'rtl', background: 'var(--c-bg)' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)' }}>{d.name}</div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                            {d.specialty && <span style={{ fontSize: 11, color: 'var(--c-text-secondary)' }}>🩺 {d.specialty}</span>}
                            {d.areaName  && <span style={{ fontSize: 11, color: 'var(--c-accent)' }}>📍 {d.areaName}</span>}
                            {d.pharmacyName && <span style={{ fontSize: 11, color: '#0891b2' }}>🏪 {d.pharmacyName}</span>}
                          </div>
                        </div>
                        <button onClick={() => addToArchive(d.id)} disabled={addingIds.has(d.id)}
                          style={{ padding: '5px 12px', background: 'var(--c-purple)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: addingIds.has(d.id) ? 0.6 : 1, flexShrink: 0 }}>
                          {addingIds.has(d.id) ? '...' : '＋'}
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── Add/Edit Pharmacy Modal ───────────────────────── */}
      {pharmModal && (
        <div style={overlayStyle} onClick={() => setPharmModal(null)}>
          <div style={{ ...modalStyle, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 18px', fontSize: 17 }}>
              {pharmModal === 'add' ? '＋ إضافة صيدلية' : '✏️ تعديل الصيدلية'}
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={labelStyle}>
                اسم الصيدلية *
                <input value={pharmFName} onChange={e => setPharmFName(e.target.value)} style={inputStyle} placeholder="اسم الصيدلية" />
              </label>
              <label style={labelStyle}>
                اسم المالك
                <input value={pharmFOwner} onChange={e => setPharmFOwner(e.target.value)} style={inputStyle} placeholder="اسم صاحب الصيدلية" />
              </label>
              <label style={labelStyle}>
                رقم الهاتف
                <input value={pharmFPhone} onChange={e => setPharmFPhone(e.target.value)} style={inputStyle} placeholder="07xx xxx xxxx" dir="ltr" />
              </label>
              <label style={labelStyle}>
                العنوان / الموقع
                <input value={pharmFAddress} onChange={e => setPharmFAddress(e.target.value)} style={inputStyle} placeholder="الشارع / المنطقة التفصيلية" />
              </label>
              <label style={labelStyle}>
                المنطقة
                <input value={pharmFAreaName} onChange={e => setPharmFAreaName(e.target.value)} style={inputStyle} placeholder="اسم المنطقة" />
              </label>
            </div>
            {pharmSaveErr && (
              <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--c-danger-bg)', borderRadius: 8, color: 'var(--c-danger)', fontSize: 13 }}>
                ⚠️ {pharmSaveErr}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
              <button onClick={() => setPharmModal(null)} style={{ ...btnStyle('var(--c-text-muted)'), background: 'var(--c-bg)', color: 'var(--c-text-secondary)' }}>إلغاء</button>
              <button onClick={savePharm} disabled={pharmSaving} style={{ ...btnStyle('var(--c-success)'), opacity: pharmSaving ? 0.7 : 1 }}>
                {pharmSaving ? '⏳ جاري الحفظ...' : '💾 حفظ'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal */}
      {modal && (
        <div style={overlayStyle} onClick={() => setModal(null)}>
          <div style={modalStyle} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px', fontSize: 18 }}>{modal === 'add' ? '+ إضافة طبيب' : 'تعديل بيانات الطبيب'}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label style={labelStyle}>
                اسم الطبيب *
                <input value={fName} onChange={e => setFName(e.target.value)} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                التخصص
                <input value={fSpecialty} onChange={e => setFSpecialty(e.target.value)} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                المنطقة
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    value={fAreaName}
                    autoComplete="off"
                    placeholder="اكتب اسم المنطقة..."
                    style={{ ...inputStyle, paddingLeft: fAreaId ? '28px' : undefined }}
                    onChange={e => {
                      const v = e.target.value;
                      setFAreaName(v); setFAreaId('');
                      if (!v.trim()) { setFAreaSugg([]); setFAreaShowSugg(false); return; }
                      const lv = v.toLowerCase();
                      const m = areas.filter(a => a.name.toLowerCase().includes(lv)).slice(0, 7);
                      setFAreaSugg(m); setFAreaShowSugg(true);
                    }}
                    onBlur={() => setTimeout(() => setFAreaShowSugg(false), 180)}
                    onFocus={() => { if (fAreaSugg.length > 0) setFAreaShowSugg(true); }}
                  />
                  {fAreaId && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--c-success)', fontWeight: 700 }}>✓</span>}
                  {!fAreaId && fAreaName.trim() && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: 'var(--c-warning)', fontWeight: 600 }}>جديد</span>}
                  {fAreaShowSugg && fAreaSugg.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 300, background: '#fff', border: '1px solid var(--c-border)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', marginTop: 2, overflow: 'hidden' }}>
                      {fAreaSugg.map(a => (
                        <div key={a.id}
                          onMouseDown={() => { setFAreaId(String(a.id)); setFAreaName(a.name); setFAreaSugg([]); setFAreaShowSugg(false); }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid var(--c-border-light)' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-bg)')}
                          onMouseLeave={e => (e.currentTarget.style.background = '')}>
                          {a.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label style={labelStyle}>
                اسم الصيدلية
                <input value={fPharmacy} onChange={e => setFPharmacy(e.target.value)} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                الايتم المستهدف
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    value={fItemName}
                    autoComplete="off"
                    placeholder="اكتب اسم الصنف..."
                    style={{ ...inputStyle, paddingLeft: fItemId ? '28px' : undefined }}
                    onChange={e => {
                      const v = e.target.value;
                      setFItemName(v); setFItemId('');
                      if (!v.trim()) { setFItemSugg([]); setFItemShowSugg(false); return; }
                      const lv = v.toLowerCase();
                      const m = items.filter(i => i.name.toLowerCase().includes(lv)).slice(0, 7);
                      setFItemSugg(m); setFItemShowSugg(true);
                    }}
                    onBlur={() => setTimeout(() => setFItemShowSugg(false), 180)}
                    onFocus={() => { if (fItemSugg.length > 0) setFItemShowSugg(true); }}
                  />
                  {fItemId && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--c-success)', fontWeight: 700 }}>✓</span>}
                  {!fItemId && fItemName.trim() && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: 'var(--c-warning)', fontWeight: 600 }}>جديد</span>}
                  {fItemShowSugg && fItemSugg.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 300, background: '#fff', border: '1px solid var(--c-border)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', marginTop: 2, overflow: 'hidden' }}>
                      {fItemSugg.map(i => (
                        <div key={i.id}
                          onMouseDown={() => { setFItemId(String(i.id)); setFItemName(i.name); setFItemSugg([]); setFItemShowSugg(false); }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid var(--c-border-light)' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-bg)')}
                          onMouseLeave={e => (e.currentTarget.style.background = '')}>
                          {i.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label style={labelStyle}>
                الحالة
                <select value={fActive ? 'true' : 'false'} onChange={e => setFActive(e.target.value === 'true')} style={inputStyle}>
                  <option value="true">نشط</option>
                  <option value="false">غير نشط</option>
                </select>
              </label>
            </div>
            <label style={{ ...labelStyle, gridColumn: 'span 2', marginTop: 8 }}>
              ملاحظات
              <textarea value={fNotes} onChange={e => setFNotes(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setModal(null)} style={btnStyle('var(--c-text-muted)')}>إلغاء</button>
              <button onClick={save} disabled={saving} style={btnStyle('var(--c-accent)')}>{saving ? 'جاري الحفظ...' : 'حفظ'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Area Pharmacy Stats Popup ──────────────────────────── */}
      {areaStatsPopup && canSeePharmNet && (
        <>
          <div onClick={() => setAreaStatsPopup(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1200 }} />
          <div onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed', top: '50%', left: '50%',
              transform: 'translate(-50%,-50%)',
              background: '#fff', borderRadius: 16, border: '1px solid var(--c-border)',
              boxShadow: '0 16px 48px rgba(0,0,0,0.22)', zIndex: 1201,
              width: 'min(94vw,420px)', maxHeight: '85vh',
              display: 'flex', flexDirection: 'column', direction: 'rtl',
              overflow: 'hidden',
            }}>
            {/* Header */}
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--c-border-light)', background: 'var(--c-bg)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)' }}>🏪 إحصائية صيدليات المنطقة</div>
                  <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginTop: 2 }}>📍 {areaStatsPopup.areaName}</div>
                </div>
                <button onClick={() => setAreaStatsPopup(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 22, lineHeight: 1, padding: '0 4px', display: 'flex' }}><Icon name="close" size={20} /></button>
              </div>
              {/* Coverage bar */}
              {areaStatsPopup.total > 0 && (() => {
                const pct = Math.round(areaStatsPopup.withSales.length / areaStatsPopup.total * 100);
                const bc  = pct >= 80 ? 'var(--c-success)' : pct >= 50 ? 'var(--c-warning)' : 'var(--c-danger)';
                return (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                      <span style={{ fontSize: 11, color: 'var(--c-text-secondary)' }}>
                        نسبة الصيدليات مع مبيع: <strong style={{ color: bc }}>{areaStatsPopup.withSales.length}/{areaStatsPopup.total}</strong>
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: bc }}>{pct}%</span>
                    </div>
                    <div style={{ height: 8, borderRadius: 99, background: 'var(--c-bg)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: bc, transition: 'width 0.4s ease' }} />
                    </div>
                  </div>
                );
              })()}
            </div>
            {/* Body */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '12px 16px 16px' }}>
              {/* With Sales */}
              {areaStatsPopup.withSales.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-success)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                    ✅ مع مبيع ({areaStatsPopup.withSales.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {areaStatsPopup.withSales.map((n, i) => (
                      <div key={i} style={{ fontSize: 12, padding: '6px 10px', background: 'var(--c-success-bg)', borderRadius: 8, color: 'var(--c-success)', border: '1px solid var(--c-success-border)' }}>
                        🏪 {n}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Returns only */}
              {areaStatsPopup.withReturnsOnly.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-warning)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                    🔄 ارجاع فقط ({areaStatsPopup.withReturnsOnly.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {areaStatsPopup.withReturnsOnly.map((n, i) => (
                      <div key={i} style={{ fontSize: 12, padding: '6px 10px', background: 'var(--c-warning-bg)', borderRadius: 8, color: 'var(--c-warning)', border: '1px solid var(--c-warning-border)' }}>
                        🏪 {n}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* No data */}
              {areaStatsPopup.noData.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-danger)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                    ❌ بدون مبيع ({areaStatsPopup.noData.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {areaStatsPopup.noData.map((n, i) => (
                      <div key={i} style={{ fontSize: 12, padding: '6px 10px', background: 'var(--c-danger-bg)', borderRadius: 8, color: 'var(--c-danger)', border: '1px solid var(--c-danger-border)' }}>
                        🏪 {n}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {areaStatsPopup.total === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: '24px 0', fontSize: 13 }}>
                  لا توجد صيدليات مسجلة لأطباء هذه المنطقة
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Pharmacy Net Comparison Popup ──────────────────────── */}
      {pharmComparePopup && canSeePharmNet && (
        <>
          <div onClick={() => setPharmComparePopup(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1200 }} />
          <div onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed', top: '50%', left: '50%',
              transform: 'translate(-50%,-50%)',
              background: '#fff', borderRadius: 16, border: '1px solid var(--c-border)',
              boxShadow: '0 16px 48px rgba(0,0,0,0.22)', zIndex: 1201,
              width: 'min(94vw,440px)', maxHeight: '85vh',
              display: 'flex', flexDirection: 'column', direction: 'rtl',
              overflow: 'hidden',
            }}>
            {/* Header */}
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--c-border-light)', background: 'var(--c-bg)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)' }}>📊 مقارنة بيانات المبيع</div>
                  <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginTop: 3 }}>د. {pharmComparePopup.docName}</div>
                </div>
                <button onClick={() => setPharmComparePopup(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 22, lineHeight: 1, padding: '0 4px', display: 'flex' }}><Icon name="close" size={20} /></button>
              </div>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, background: 'var(--c-accent-light)', color: 'var(--c-accent)', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
                  🏪 {pharmComparePopup.pharmName}
                </span>
                {pharmComparePopup.areaName && (
                  <span style={{ fontSize: 11, background: 'var(--c-bg)', color: 'var(--c-text-secondary)', borderRadius: 6, padding: '2px 8px' }}>
                    📍 {pharmComparePopup.areaName}
                  </span>
                )}
              </div>
            </div>
            {/* Body */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '14px 16px 16px' }}>
              {pharmComparePopup.exact ? (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-success)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 14 }}>✅</span> تم العثور على الصيدلية في بيانات المبيع
                  </div>
                  {/* Summary cards */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                    {([
                      { label: 'عدد الطلبيات', value: String(pharmComparePopup.exact.totalOrders), color: 'var(--c-accent)', bg: 'var(--c-accent-light)' },
                      { label: 'إجمالي المبيع', value: pharmComparePopup.exact.totalValue > 0 ? `${pharmComparePopup.exact.totalValue.toLocaleString()} د.ع` : '—', color: 'var(--c-success)', bg: 'var(--c-success-bg)' },
                      { label: 'إجمالي الارجاع', value: pharmComparePopup.exact.returnsValue > 0 ? `${pharmComparePopup.exact.returnsValue.toLocaleString()} د.ع` : '—', color: 'var(--c-danger)', bg: 'var(--c-danger-bg)' },
                      { label: 'آخر طلبية', value: pharmComparePopup.exact.lastOrder ? fmt(pharmComparePopup.exact.lastOrder) : '—', color: 'var(--c-warning)', bg: 'var(--c-warning-bg)' },
                    ] as { label: string; value: string; color: string; bg: string }[]).map(card => (
                      <div key={card.label} style={{ background: card.bg, borderRadius: 10, padding: '10px 12px' }}>
                        <div style={{ fontSize: 10, color: 'var(--c-text-muted)', marginBottom: 3 }}>{card.label}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: card.color }}>{card.value}</div>
                      </div>
                    ))}
                  </div>
                  {pharmComparePopup.exact.areaName && (
                    <div style={{ fontSize: 11, color: 'var(--c-text-secondary)', marginBottom: 10 }}>
                      📍 المنطقة في ملف المبيع: <strong>{pharmComparePopup.exact.areaName}</strong>
                    </div>
                  )}
                  {/* Item breakdown with dates */}
                  {pharmDetailLoading && pharmDetailFor === pharmComparePopup.exact.name ? (
                    <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--c-text-muted)', fontSize: 12 }}>⏳ جاري تحميل تفاصيل الطلبيات...</div>
                  ) : pharmDetail && pharmDetailFor === pharmComparePopup.exact.name && pharmDetail.byItem.length > 0 ? (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-text-secondary)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span>📦</span> تفاصيل الإيتمات والطلبيات
                      </div>
                      {pharmDetail.byItem.map((item, idx) => {
                        const salesOrders   = item.orders.filter(o => o.type !== 'return');
                        const returnOrders  = item.orders.filter(o => o.type === 'return');
                        return (
                          <div key={idx} style={{ background: 'var(--c-bg)', borderRadius: 10, padding: '10px 12px', marginBottom: 8, border: '1px solid var(--c-border)' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-text-primary)', marginBottom: 6 }}>💊 {item.name}</div>
                            {salesOrders.length > 0 && (
                              <div style={{ marginBottom: returnOrders.length > 0 ? 6 : 0 }}>
                                <div style={{ fontSize: 10, color: 'var(--c-success)', fontWeight: 700, marginBottom: 3 }}>مبيع ({salesOrders.length})</div>
                                {salesOrders.map((o, i) => (
                                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '3px 8px', background: 'var(--c-success-bg)', borderRadius: 6, marginBottom: 2 }}>
                                    <span style={{ color: 'var(--c-text-secondary)' }}>{fmt(o.date)}</span>
                                    <span style={{ color: 'var(--c-text-secondary)' }}>كمية: {o.qty}</span>
                                    <span style={{ color: 'var(--c-success)', fontWeight: 600 }}>{o.value.toLocaleString()} د.ع</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {returnOrders.length > 0 && (
                              <div>
                                <div style={{ fontSize: 10, color: 'var(--c-danger)', fontWeight: 700, marginBottom: 3 }}>ارجاع ({returnOrders.length})</div>
                                {returnOrders.map((o, i) => (
                                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '3px 8px', background: 'var(--c-danger-bg)', borderRadius: 6, marginBottom: 2 }}>
                                    <span style={{ color: 'var(--c-text-secondary)' }}>{fmt(o.date)}</span>
                                    <span style={{ color: 'var(--c-text-secondary)' }}>كمية: {o.qty}</span>
                                    <span style={{ color: 'var(--c-danger)', fontWeight: 600 }}>{o.value.toLocaleString()} د.ع</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </>
              ) : (
                <div style={{ padding: '12px', background: 'var(--c-warning-bg)', borderRadius: 10, marginBottom: 12, fontSize: 12, color: 'var(--c-warning)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                  <span>لم يتم العثور على هذه الصيدلية بشكل مباشر في بيانات المبيع</span>
                </div>
              )}
              {/* Similar pharmacies */}
              {pharmComparePopup.similar.length > 0 && (
                <div style={{ marginTop: pharmComparePopup.exact ? 8 : 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-accent)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span>🔍</span> صيدليات مشابهة في الاسم ({pharmComparePopup.similar.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {pharmComparePopup.similar.map((p, i) => (
                      <div key={i} style={{ background: 'var(--c-bg)', borderRadius: 10, padding: '10px 12px', border: '1px solid var(--c-border)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-text-primary)' }}>🏪 {p.name}</div>
                          <button onClick={() => loadPharmDetail(p.name)}
                            style={{ background: pharmDetailFor === p.name ? 'var(--c-accent-light)' : 'none', border: '1px solid var(--c-accent)', borderRadius: 6, padding: '2px 8px', fontSize: 10, color: 'var(--c-accent)', cursor: 'pointer', flexShrink: 0 }}>
                            {pharmDetailFor === p.name && pharmDetailLoading ? '⏳' : 'تفاصيل'}
                          </button>
                        </div>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                          {p.totalValue > 0 && <span style={{ fontSize: 11, color: 'var(--c-success)', fontWeight: 600 }}>مبيع: {p.totalValue.toLocaleString()} د.ع</span>}
                          {p.returnsValue > 0 && <span style={{ fontSize: 11, color: 'var(--c-danger)', fontWeight: 600 }}>ارجاع: {p.returnsValue.toLocaleString()} د.ع</span>}
                          {p.areaName && <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>📍 {p.areaName}</span>}
                        </div>
                        {/* Inline detail for this similar pharmacy */}
                        {pharmDetailFor === p.name && !pharmDetailLoading && pharmDetail && pharmDetail.byItem.length > 0 && (
                          <div style={{ marginTop: 6 }}>
                            {pharmDetail.byItem.map((item, idx) => {
                              const salesOrders  = item.orders.filter(o => o.type !== 'return');
                              const returnOrders = item.orders.filter(o => o.type === 'return');
                              return (
                                <div key={idx} style={{ background: '#fff', borderRadius: 8, padding: '8px 10px', marginBottom: 6, border: '1px solid var(--c-border)' }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-text-primary)', marginBottom: 5 }}>💊 {item.name}</div>
                                  {salesOrders.length > 0 && (
                                    <div style={{ marginBottom: returnOrders.length > 0 ? 5 : 0 }}>
                                      <div style={{ fontSize: 10, color: 'var(--c-success)', fontWeight: 700, marginBottom: 2 }}>مبيع ({salesOrders.length})</div>
                                      {salesOrders.map((o, oi) => (
                                        <div key={oi} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 6px', background: 'var(--c-success-bg)', borderRadius: 5, marginBottom: 2 }}>
                                          <span style={{ color: 'var(--c-text-secondary)' }}>{fmt(o.date)}</span>
                                          <span style={{ color: 'var(--c-text-secondary)' }}>كمية: {o.qty}</span>
                                          <span style={{ color: 'var(--c-success)', fontWeight: 600 }}>{o.value.toLocaleString()} د.ع</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {returnOrders.length > 0 && (
                                    <div>
                                      <div style={{ fontSize: 10, color: 'var(--c-danger)', fontWeight: 700, marginBottom: 2 }}>ارجاع ({returnOrders.length})</div>
                                      {returnOrders.map((o, oi) => (
                                        <div key={oi} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 6px', background: 'var(--c-danger-bg)', borderRadius: 5, marginBottom: 2 }}>
                                          <span style={{ color: 'var(--c-text-secondary)' }}>{fmt(o.date)}</span>
                                          <span style={{ color: 'var(--c-text-secondary)' }}>كمية: {o.qty}</span>
                                          <span style={{ color: 'var(--c-danger)', fontWeight: 600 }}>{o.value.toLocaleString()} د.ع</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!pharmComparePopup.exact && pharmComparePopup.similar.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', padding: '20px 0', fontSize: 13 }}>
                  لا توجد بيانات مبيع مرتبطة بهذه الصيدلية
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {showVisitsImportModal && (
        <DoctorVisitsImportModal
          token={token ?? ''}
          onClose={() => { setShowVisitsImportModal(false); loadVisits(true); loadPharmVisits(true); }}
          onSaved={msg => {
            setVisitsImportMsg(msg);
            loadVisits(true);
            loadPharmVisits(true);
            setTimeout(() => setVisitsImportMsg(''), 15000);
          }}
        />
      )}
      {visitsImportMsg && (
        <div style={{
          position: 'fixed', bottom: 20, insetInlineStart: 20, zIndex: 10001, maxWidth: 380,
          background: 'var(--c-success-bg)', border: '1px solid var(--c-success-border)', borderRadius: 10, padding: '10px 14px',
          color: 'var(--c-success)', fontSize: 12.5, whiteSpace: 'pre-line', boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
        }}>
          ✅ {visitsImportMsg}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────
const btnStyle = (bg: string) => ({
  background: bg, color: '#fff', border: 'none', borderRadius: 8,
  padding: '8px 18px', cursor: 'pointer', fontWeight: 600, fontSize: 14,
});
const btnSmall = (bg: string) => ({
  background: bg, color: '#fff', border: 'none', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 12,
});
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid var(--c-border)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box', direction: 'rtl',
};
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: 'var(--c-text-secondary)' };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 14 };
const thStyle: React.CSSProperties    = { textAlign: 'right', padding: '10px 12px', fontWeight: 700, fontSize: 13, color: 'var(--c-text-secondary)', borderBottom: '2px solid var(--c-border)' };
const tdStyle: React.CSSProperties    = { padding: '10px 12px', color: 'var(--c-text-primary)', verticalAlign: 'middle' };
const alertStyle: React.CSSProperties = { background: 'var(--c-danger-bg)', color: 'var(--c-danger)', border: '1px solid var(--c-danger-border)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 };
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalStyle: React.CSSProperties   = { background: '#fff', borderRadius: 12, padding: 28, width: '90%', maxWidth: 620, maxHeight: '90vh', overflowY: 'auto', direction: 'rtl' };
