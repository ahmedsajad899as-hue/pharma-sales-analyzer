import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useBackHandler } from '../hooks/useBackHandler';
import { useAuth } from '../context/AuthContext';

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
        style={{ width: '100%', padding: '7px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box', direction: 'rtl' }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 200,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.1)', marginTop: 2, overflow: 'hidden',
        }}>
          {filtered.map(s => (
            <div key={s} onMouseDown={() => { onChange(s); setOpen(false); }}
              style={{ padding: '8px 14px', cursor: 'pointer', fontSize: 13, direction: 'rtl', borderBottom: '1px solid #f1f5f9' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
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
  writing:       { label: 'يكتب ✓',        color: '#4338ca', bg: '#eef2ff' },
  interested:    { label: 'مهتم',           color: '#475569', bg: '#f1f5f9' },
  stocked:       { label: 'مخزن',           color: '#475569', bg: '#f1f5f9' },
  not_interested:{ label: 'غير مهتم',       color: '#475569', bg: '#f1f5f9' },
  unavailable:   { label: 'غير متواجد',     color: '#94a3b8', bg: '#f8fafc' },
  pending:       { label: 'لم يُقرر',       color: '#94a3b8', bg: '#f8fafc' },
};

function fmt(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
}

export default function DoctorsPage() {
  const { token, user, hasFeature } = useAuth();
  const isCommercialRep = user?.role === 'commercial_rep';
  const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
  const isFieldRep  = FIELD_ROLES.includes(user?.role ?? '');
  const showDoctorFields    = hasFeature('doctor_fields');
  const showVisitAnalysis   = hasFeature('visit_analysis_tab');
  const showDoctorsList     = hasFeature('doctors_list_tab');
  const showMyVisits        = hasFeature('my_visits_tab');
  const showPharmacies      = hasFeature('pharmacies_tab');
  const showArchiveTab      = hasFeature('archive_tab');
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  // ── Tab ──────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'list' | 'visits' | 'pharmacies' | 'myvisits' | 'archive'>(() => {
    const saved = localStorage.getItem('doctors_active_tab');
    return (saved && ['list','visits','pharmacies','myvisits','archive'].includes(saved)) ? saved as any : 'visits';
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
  const [visitLoading, setVisitLoading]     = useState(false);
  const [visitMonthFilter, setVisitMonthFilter] = useState<{ month: number; year: number } | null>(null);
  const [showVisitMonthPicker, setShowVisitMonthPicker] = useState(false);
  // ── Rep filter (for managers only) ─────────────────────────
  interface ManagerRep { userId: number; name: string; linkedRepId: number | null; }
  const [managerReps, setManagerReps]       = useState<ManagerRep[]>([]);
  const [visitRepFilter, setVisitRepFilter] = useState<number | null>(null); // null = all
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
  const [showWishPanel, setShowWishPanel] = useState(false);
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
    entryId: number; surveyDoctorId: number;
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
    [archiveExpandedAreas.size > 0, () => setArchiveExpandedAreas(new Set())],
  ]);

  const toggleWish = (id: number, name?: string) => {
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
  };
  const setWishedItem = (docId: number, itemName: string) => {
    setWishedItems(prev => {
      const next = { ...prev, [docId]: itemName };
      localStorage.setItem(itemsKey, JSON.stringify(next));
      return next;
    });
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

  const loadVisits = useCallback(async () => {
    setVisitLoading(true);
    try {
      const ps = new URLSearchParams();
      if (visitMonthFilter) { ps.set('month', String(visitMonthFilter.month)); ps.set('year', String(visitMonthFilter.year)); }
      if (visitRepFilter !== null) ps.set('repUserId', String(visitRepFilter));
      const r = await fetch(`${API}/api/doctors/visits-by-area?${ps}`, { headers: H() });
      const j = await r.json();
      console.log('[visitsByArea] status:', r.status, 'response:', j);
      setVisitAreas(Array.isArray(j.areas) ? j.areas : []);
    } catch (e) { console.error('[visitsByArea] fetch error:', e); }
    finally { setVisitLoading(false); }
  }, [token, visitMonthFilter, visitRepFilter]);

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
    try { setWishedDoctors(new Set(JSON.parse(localStorage.getItem(key) || '[]'))); } catch { setWishedDoctors(new Set()); }
    try { setWishedItems(JSON.parse(localStorage.getItem(kIt) || '{}')); }           catch { setWishedItems({}); }
    try { setWishedNames(JSON.parse(localStorage.getItem(kNm) || '{}')); }           catch { setWishedNames({}); }
    // Remove old generic keys so they no longer pollute any session
    localStorage.removeItem('wishedDoctors');
    localStorage.removeItem('wishedItems');
    localStorage.removeItem('wishedDoctorNames');
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
  useEffect(() => { if (activeTab === 'visits') { loadVisits(); loadManagerReps(); } }, [activeTab, loadVisits, loadManagerReps]);

  const loadPharmVisits = useCallback(async () => {
    setPharmVisitLoading(true);
    try {
      const ps = new URLSearchParams();
      if (pharmVisitMonthFilter) { ps.set('month', String(pharmVisitMonthFilter.month)); ps.set('year', String(pharmVisitMonthFilter.year)); }
      if (visitRepFilter !== null) ps.set('repUserId', String(visitRepFilter));
      const r = await fetch(`${API}/api/doctors/pharmacy-visits-by-area?${ps}`, { headers: H() });
      const j = await r.json();
      setPharmVisitAreas(Array.isArray(j.areas) ? j.areas : []);
    } catch (e) { console.error(e); }
    finally { setPharmVisitLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, pharmVisitMonthFilter, visitRepFilter]);

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

  const patchArchive = async (surveyDoctorId: number, patch: Record<string, unknown>) => {
    // Optimistic update on archiveAreas
    setArchiveAreas(prev => prev.map(area => ({
      ...area,
      doctors: area.doctors.map(d => d.surveyDoctorId === surveyDoctorId ? { ...d, ...patch } : d),
    })));
    // Recalculate stats optimistically
    setArchiveAreas(areas => {
      const allDocs = areas.flatMap(a => a.doctors);
      setArchiveTotalVisited(allDocs.filter(d => d.isVisited).length);
      setArchiveTotalWriting(allDocs.filter(d => d.isWriting).length);
      return areas;
    });
    try {
      const qs = archiveRepFilter !== null ? `?forUserId=${archiveRepFilter}` : '';
      await fetch(`${API}/api/doctor-archive/${surveyDoctorId}${qs}`, {
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
    if (activeTab === 'archive') { loadArchive(); loadManagerReps(); }
  }, [activeTab, loadArchive, loadManagerReps]);

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
    return matchSearch && matchArea;
  }), [doctors, search, filterArea]);

  const doctorNameSuggestions = useMemo(
    () => doctors.flatMap(d => [d.name, d.specialty ?? '', d.pharmacyName ?? '']).filter(Boolean) as string[],
    [doctors]
  );

  // Suggestions for archive item inputs = system items + all previously entered archive items
  const archiveItemSuggestions = useMemo(() => {
    const names = new Set<string>();
    items.forEach(it => names.add(it.name));
    archiveAreas.forEach(area => area.doctors.forEach(doc => {
      doc.visitItems?.forEach(n => { if (n) names.add(n); });
      doc.writingItems?.forEach(n => { if (n) names.add(n); });
    }));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [items, archiveAreas]);

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
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1e293b' }}>🏥 قائمة السيرفي</h1>
        </div>
        {activeTab === 'list' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => { setShowImportPanel(v => !v); setImportResult(null); }}
              style={{ ...btnStyle('#10b981'), padding: '6px 10px', fontSize: 16 }} title="استيراد Excel">📊</button>
            <button onClick={openAdd} style={{ ...btnStyle('#3b82f6'), padding: '6px 10px', fontSize: 16 }} title="إضافة طبيب">+</button>
            {doctors.length > 0 && (
              <button onClick={deleteAll} style={{ ...btnStyle('#ef4444'), padding: '6px 10px', fontSize: 16 }} title="مسح جميع الأطباء">🗑</button>
            )}
          </div>
        )}
        {activeTab === 'visits' && visitAnalysisType === 'doctors' && (
          <button onClick={loadVisits} disabled={visitLoading}
            style={{ ...btnStyle('#6366f1'), opacity: visitLoading ? 0.7 : 1 }}>
            {visitLoading ? '⏳ تحديث...' : '↻ تحديث'}
          </button>
        )}
        {activeTab === 'visits' && visitAnalysisType === 'pharmacies' && (
          <button onClick={loadPharmVisits} disabled={pharmVisitLoading}
            style={{ ...btnStyle('#6366f1'), opacity: pharmVisitLoading ? 0.7 : 1 }}>
            {pharmVisitLoading ? '⏳ تحديث...' : '↻ تحديث'}
          </button>
        )}
        {activeTab === 'pharmacies' && (
          <button onClick={loadSurveyPharmacies} disabled={surveyPharmLoading}
            style={{ ...btnStyle('#6366f1'), opacity: surveyPharmLoading ? 0.7 : 1 }}>
            {surveyPharmLoading ? '⏳ تحديث...' : '↻ تحديث'}
          </button>
        )}
        {activeTab === 'archive' && showArchiveTab && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setShowAddModal(true)}
              style={{ ...btnStyle('#8b5cf6') }}>
              ＋ من السيرفي
            </button>
            <button onClick={() => setShowNewDocForm(true)}
              style={{ ...btnStyle('#475569') }}>
              ＋ طبيب جديد
            </button>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e2e8f0', paddingBottom: 0, overflowX: 'auto' }}>
        {([
          ...(showVisitAnalysis                    ? [['visits',      '📍 تحليل الزيارات']]      : []),
          ...(showDoctorsList                       ? [['list',        '📋 قائمة الأطباء']]        : []),
          ...(showArchiveTab                        ? [['archive',     '📚 أرشيف السيرفي']]        : []),
          ...(isCommercialRep && showMyVisits       ? [['myvisits',    '📝 زياراتي']]              : []),
          ...(isCommercialRep && showPharmacies     ? [['pharmacies',  '🏪 قائمة الصيدليات']]     : []),
        ] as ['list' | 'visits' | 'pharmacies' | 'myvisits' | 'archive', string][]).map(([tab, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 18px', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap',
            color: activeTab === tab ? '#6366f1' : '#64748b',
            borderBottom: activeTab === tab ? '2px solid #6366f1' : '2px solid transparent',
            marginBottom: -2, transition: 'all 0.15s',
          }}>{label}</button>
        ))}
      </div>

      {/* ── LIST TAB ─────────────────────────────────────── */}
      {activeTab === 'list' && showDoctorsList && (<>
      {/* Excel import panel */}
      {showImportPanel && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15, color: '#166534' }}>📊 استيراد قائمة السيرفي من Excel</h3>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#15803d', lineHeight: 1.7 }}>
            النظام يكتشف الأعمدة تلقائياً من ملفك. ارفع الملف وسيظهر لك أي أعمدة تم التعرف عليها.
            <br />
            <span style={{ fontSize: 12, color: '#166534' }}>
              الأعمدة المدعومة (بأي تسمية): اسم الطبيب · التخصص · المنطقة · الصيدلية · الايتم · ملاحظات
            </span>
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
              onChange={e => e.target.files?.[0] && importExcel(e.target.files[0])} />
            <button onClick={() => fileRef.current?.click()} disabled={importing}
              style={{ ...btnStyle('#3b82f6'), opacity: importing ? 0.7 : 1 }}>
              {importing ? '⏳ جاري الاستيراد...' : '📂 اختر ملف Excel'}
            </button>
            {importResult && !importResult.error && (
              <div style={{ fontSize: 13, color: importResult.imported > 0 ? '#166534' : '#92400e', fontWeight: 600 }}>
                {importResult.imported > 0
                  ? `✅ تم استيراد ${importResult.imported} طبيب`
                  : '⚠️ لم يتم استيراد أي طبيب'}
                {(importResult.skipped ?? 0) > 0 && <span style={{ color: '#92400e', marginRight: 8 }}> | تخطي صفوف: {importResult.skipped}</span>}
                {(importResult.errors?.length ?? 0) > 0 && <span style={{ color: '#991b1b', marginRight: 8 }}> | أخطاء: {importResult.errors.length}</span>}
              </div>
            )}
          </div>
          {importResult?.colMap && (
            <div style={{ marginTop: 12, background: '#fff', borderRadius: 8, padding: 12, border: '1px solid #d1fae5' }}>
              <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#374151' }}>🔍 الأعمدة المكتشفة في ملفك:</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(importResult.colMap).map(([field, col]) => (
                  <span key={field} style={{ padding: '3px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: col ? '#dcfce7' : '#fee2e2', color: col ? '#166534' : '#991b1b' }}>
                    {fieldLabels[field] ?? field}: {col ? `"${col}"` : '❌ غير موجود'}
                  </span>
                ))}
              </div>
            </div>
          )}
          {importResult?.error && (
            <div style={{ marginTop: 10, background: '#fee2e2', borderRadius: 8, padding: 12, fontSize: 13 }}>
              <p style={{ margin: '0 0 6px', fontWeight: 700, color: '#991b1b' }}>❌ {importResult.error}</p>
              {importResult.hint && <p style={{ margin: '0 0 8px', color: '#7f1d1d' }}>{importResult.hint}</p>}
              {importResult.detectedCols && (
                <div>
                  <p style={{ margin: '0 0 4px', color: '#374151', fontWeight: 600 }}>الأعمدة الموجودة في ملفك:</p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {importResult.detectedCols.map((c, i) => (
                      <span key={i} style={{ padding: '2px 8px', background: '#fef3c7', color: '#92400e', borderRadius: 6, fontFamily: 'monospace', fontSize: 12 }}>{c}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {(importResult?.errors?.length ?? 0) > 0 && (
            <div style={{ marginTop: 10, background: '#fee2e2', borderRadius: 8, padding: 10, fontSize: 12, color: '#991b1b', maxHeight: 120, overflowY: 'auto' }}>
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
        <span style={{ fontSize: 12, color: '#94a3b8', marginRight: 'auto' }}>
          {filtered.length} طبيب
        </span>
      </div>

      {/* Cards list */}
      {loading ? (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: 40, fontSize: 15 }}>جاري التحميل...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: 40, fontSize: 14 }}>لا توجد بيانات</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((d, idx) => (
            <div key={d.id} style={{
              background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0',
              boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
              padding: '12px 18px', direction: 'rtl',
              display: 'flex', alignItems: 'center', gap: 14,
            }}>
              {/* Number badge */}
              <span style={{
                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                background: '#eef2ff', color: '#6366f1', fontSize: 12, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{idx + 1}</span>

              {/* Main info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b' }}>{d.name}</span>
                  {d.isActive === false && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
                      background: '#fee2e2', color: '#991b1b',
                    }}>غير نشط</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 5, flexWrap: 'wrap' }}>
                  {showDoctorFields && d.specialty && (
                    <span style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 3 }}>
                      🩺 {d.specialty}
                    </span>
                  )}
                  {showDoctorFields && d.area && (
                    <span style={{ fontSize: 11, color: '#6366f1', display: 'flex', alignItems: 'center', gap: 3 }}>
                      📍 {d.area.name}
                    </span>
                  )}
                  {showDoctorFields && d.pharmacyName && (
                    <span style={{ fontSize: 11, color: '#0891b2', display: 'flex', alignItems: 'center', gap: 3 }}>
                      🏪 {d.pharmacyName}
                    </span>
                  )}
                  {showDoctorFields && d.targetItem && (
                    <span style={{ fontSize: 11, background: '#ede9fe', color: '#6d28d9', borderRadius: 8, padding: '1px 8px', fontWeight: 600 }}>
                      💊 {d.targetItem.name}
                    </span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
                {/* Wish star */}
                {(() => { const isW = wishedDoctors.has(d.id); return (
                  <button onClick={() => toggleWish(d.id, d.name)} title={isW ? 'إزالة من قائمة الطلبات' : 'أضف لقائمة الطلبات'} style={{
                    background: isW ? '#eef2ff' : 'transparent', border: `1.5px solid ${isW ? '#6366f1' : '#cbd5e1'}`,
                    borderRadius: 8, width: 30, height: 30, cursor: 'pointer', fontSize: 15,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    opacity: isW ? 1 : 0.45, transition: 'all 0.15s',
                  }}>⭐</button>
                ); })()}
                <button onClick={() => openEdit(d)} title="تعديل" style={{
                  fontSize: 15, padding: '4px 8px', borderRadius: 8,
                  border: '1px solid #c7d2fe', background: '#eef2ff', color: '#4338ca',
                  cursor: 'pointer',
                }}>✏️</button>
                <button onClick={() => remove(d.id)} title="حذف" style={{
                  fontSize: 15, padding: '4px 8px', borderRadius: 8,
                  border: '1px solid #fecaca', background: '#fff1f2', color: '#b91c1c',
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
              <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>👤 المندوب</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  onClick={() => setVisitRepFilter(null)}
                  style={{
                    padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: `1.5px solid ${visitRepFilter === null ? '#6366f1' : '#e2e8f0'}`,
                    background: visitRepFilter === null ? '#eef2ff' : '#f8fafc',
                    color: visitRepFilter === null ? '#4338ca' : '#64748b',
                  }}>الكل</button>
                {managerReps.map(rep => (
                  <button
                    key={rep.userId}
                    onClick={() => setVisitRepFilter(rep.userId)}
                    style={{
                      padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `1.5px solid ${visitRepFilter === rep.userId ? '#6366f1' : '#e2e8f0'}`,
                      background: visitRepFilter === rep.userId ? '#eef2ff' : '#f8fafc',
                      color: visitRepFilter === rep.userId ? '#4338ca' : '#64748b',
                    }}>{rep.name}</button>
                ))}
              </div>
            </div>
          )}

          {/* Analysis type toggle: doctors vs pharmacies */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <button
              onClick={() => setVisitAnalysisType('doctors')}
              style={{
                padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                border: `1.5px solid ${visitAnalysisType === 'doctors' ? '#6366f1' : '#e2e8f0'}`,
                background: visitAnalysisType === 'doctors' ? '#eef2ff' : '#f8fafc',
                color: visitAnalysisType === 'doctors' ? '#4338ca' : '#64748b',
              }}>👨‍⚕️ الأطباء</button>
            <button
              onClick={() => setVisitAnalysisType('pharmacies')}
              style={{
                padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                border: `1.5px solid ${visitAnalysisType === 'pharmacies' ? '#6366f1' : '#e2e8f0'}`,
                background: visitAnalysisType === 'pharmacies' ? '#eef2ff' : '#f8fafc',
                color: visitAnalysisType === 'pharmacies' ? '#4338ca' : '#64748b',
              }}>🏪 الصيدليات</button>
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
            return (
              !showVisitMonthPicker ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 14, direction: 'rtl' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', flexShrink: 0 }}>📅</span>
                  <button
                    style={{
                      fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                      border: '1px solid #6366f1', background: '#eef2ff', color: '#4338ca',
                      cursor: 'default', whiteSpace: 'nowrap',
                    }}>الكل</button>
                  <button
                    onClick={() => setShowVisitMonthPicker(true)}
                    style={{
                      fontSize: 13, padding: '2px 8px', borderRadius: 14, flexShrink: 0,
                      border: '1px solid #e2e8f0', background: 'transparent', color: '#94a3b8',
                      cursor: 'pointer', lineHeight: 1,
                    }}>‹</button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 14, direction: 'rtl', overflowX: 'auto', flexWrap: 'nowrap', paddingBottom: 2, WebkitOverflowScrolling: 'touch' as any }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', flexShrink: 0 }}>📅</span>
                  <button
                    onClick={() => { setVisitMonthFilter(null); setShowVisitMonthPicker(false); }}
                    style={{
                      fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                      border: `1px solid ${visitMonthFilter === null ? '#6366f1' : '#e2e8f0'}`,
                      background: visitMonthFilter === null ? '#eef2ff' : 'transparent',
                      color: visitMonthFilter === null ? '#4338ca' : '#94a3b8',
                      cursor: 'pointer', whiteSpace: 'nowrap',
                    }}>الكل</button>
                  {options.map(o => {
                    const active = visitMonthFilter?.month === o.month && visitMonthFilter?.year === o.year;
                    return (
                      <button key={`${o.month}-${o.year}`}
                        onClick={() => setVisitMonthFilter({ month: o.month, year: o.year })}
                        style={{
                          fontSize: 11, fontWeight: active ? 700 : 400, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                          border: `1px solid ${active ? '#6366f1' : '#e2e8f0'}`,
                          background: active ? '#eef2ff' : 'transparent',
                          color: active ? '#4338ca' : '#94a3b8',
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
            const total   = visitAreas.reduce((s, a) => s + a.totalDoctors, 0);
            const visited = visitAreas.reduce((s, a) => s + a.visitedCount, 0);
            const writing = visitAreas.reduce((s, a) => s + a.writingCount, 0);
            const pct = total > 0 ? Math.round(visited / total * 100) : 0;
            const sortedAreas = [...visitAreas].sort((a, b) => {
              const pa = a.totalDoctors > 0 ? a.visitedCount / a.totalDoctors : 0;
              const pb = b.totalDoctors > 0 ? b.visitedCount / b.totalDoctors : 0;
              return pb - pa;
            });
            return (
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'إجمالي الأطباء', value: total,   icon: '👥', accent: '#6366f1', clickable: 'total' },
                  { label: 'تمت زيارتهم',    value: visited, icon: '✅', accent: '#6366f1', clickable: 'visited' },
                  { label: 'يكتبون الايتم',  value: writing, icon: '✍️', accent: '#6366f1', clickable: 'writing' },
                  { label: 'نسبة التغطية',   value: `${pct}%`, icon: '📊', accent: '#6366f1', clickable: 'coverage' },
                ].map(s => {
                  const isActiveCard = s.clickable === 'coverage' ? showCoveragePopup : s.clickable === 'writing' ? showWritingPopup : s.clickable === 'visited' ? showVisitedPopup : s.clickable === 'total' ? showTotalPopup : false;
                  const borderColor  = isActiveCard ? s.accent : '#e2e8f0';
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
                    <div style={{ fontSize: 22 }}>{s.icon}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: s.accent, lineHeight: 1.2 }}>{s.value}</div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{s.label}</div>
                    {s.clickable && <div style={{ fontSize: 10, color: '#93c5fd', marginTop: 3 }}>▾</div>}

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
                              background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
                              boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                              width: 'min(92vw,380px)', maxHeight: '80vh',
                              display: 'flex', flexDirection: 'column', direction: 'rtl',
                            }}>
                          <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                            <span style={{ fontSize: 14, fontWeight: 700, color: '#4338ca' }}>👥 توزيع الأطباء بالمناطق</span>
                            <button onClick={() => setShowTotalPopup(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1 }}>×</button>
                          </div>
                          <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
                            {sorted.map((area, idx) => {
                              const pctArea = area.totalDoctors > 0 ? Math.round(area.visitedCount / area.totalDoctors * 100) : 0;
                              const barColor = pctArea >= 80 ? '#10b981' : pctArea >= 50 ? '#6366f1' : pctArea > 0 ? '#f59e0b' : '#d1d5db';
                              return (
                                <div key={String(area.id)} style={{ padding: '7px 16px', borderBottom: idx < sorted.length - 1 ? '1px solid #f8fafc' : 'none' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span style={{ fontSize: 12, color: '#94a3b8' }}>📍</span>
                                      <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{area.name}</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: '#6366f1', background: '#eef2ff', padding: '1px 9px', borderRadius: 10 }}>{area.totalDoctors}</span>
                                      <span style={{ fontSize: 11, color: barColor, fontWeight: 600 }}>{pctArea}%</span>
                                    </div>
                                  </div>
                                  <div style={{ height: 4, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                                    <div style={{ width: `${pctArea}%`, height: '100%', background: barColor, borderRadius: 4, transition: 'width 0.3s' }} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div style={{ padding: '8px 16px 2px', borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', flexShrink: 0 }}>
                            <span style={{ fontSize: 11, color: '#94a3b8' }}>الإجمالي</span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#4338ca' }}>{total} طبيب في {sorted.length} منطقة</span>
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
                              background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
                              boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                              width: 'min(92vw,440px)', maxHeight: '80vh',
                              display: 'flex', flexDirection: 'column', direction: 'rtl',
                            }}>
                          <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 32, height: 32, borderRadius: 8, background: '#2E7D32', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>✅</div>
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: '#1A1A1A' }}>الأطباء المُزارون</div>
                                <div style={{ fontSize: 11, color: '#999' }}>{visitedDocs.length} طبيب</div>
                              </div>
                            </div>
                            <button onClick={() => { setShowVisitedPopup(false); setExpandedDocIds(new Set<number>()); }}
                              style={{ width: 28, height: 28, borderRadius: '50%', background: '#F5F5F5', border: 'none', cursor: 'pointer', color: '#555', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                          </div>
                          {visitedDocs.length === 0 ? (
                            <div style={{ padding: '14px 16px', color: '#94a3b8', fontSize: 13 }}>لا توجد زيارات</div>
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
                                    borderBottom: idx < visitedDocs.length - 1 ? '1px solid #F0F0F0' : 'none',
                                    direction: 'rtl',
                                  }}>
                                    {/* Name row */}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: hasDetails ? 5 : 0 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                        <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#2E7D32', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{idx + 1}</span>
                                        <span style={{ fontSize: 14, fontWeight: 700, color: '#1A1A1A' }}>{doc.name}</span>
                                        {hasDetails && (
                                          <button onClick={() => toggleDocExpand(doc.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#999', fontSize: 11, lineHeight: 1, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</button>
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
                                          <span style={{ fontSize: 10, fontWeight: 600, background: '#F5F5F5', color: '#555', borderRadius: 6, padding: '3px 8px', border: '1px solid #E8E8E8' }}>🩺 {doc.specialty}</span>
                                        )}
                                        {doc.area && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: '#FFF0F0', color: '#8B1C1C', borderRadius: 6, padding: '3px 8px', border: '1px solid #f5c6c6' }}>📍 {doc.area.name}</span>
                                        )}
                                        {(doc as any).pharmacyName && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: '#F0F7FF', color: '#1D5FA4', borderRadius: 6, padding: '3px 8px', border: '1px solid #C5DCF5' }}>🏥 {(doc as any).pharmacyName}</span>
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
                            background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
                            boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                            width: 'min(92vw,360px)', maxHeight: '80vh',
                            display: 'flex', flexDirection: 'column', direction: 'rtl',
                          }}>
                        <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, marginBottom: 6 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b' }}>📊 التغطية بالمناطق</span>
                          <button onClick={() => setShowCoveragePopup(false)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1 }}>×</button>
                        </div>
                        <div style={{ overflowY: 'auto', flex: 1, padding: '0 16px 8px' }}>
                          {sortedAreas.map(area => {
                            const ap = area.totalDoctors > 0 ? Math.round(area.visitedCount / area.totalDoctors * 100) : 0;
                            const barColor = ap >= 80 ? '#10b981' : ap >= 50 ? '#6366f1' : ap > 0 ? '#f59e0b' : '#e2e8f0';
                            return (
                              <div key={String(area.id)} style={{ marginBottom: 11 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                  <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{area.name}</span>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 11, color: '#94a3b8' }}>{area.visitedCount}/{area.totalDoctors}</span>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: barColor, minWidth: 34, textAlign: 'left' }}>{ap}%</span>
                                  </div>
                                </div>
                                <div style={{ height: 6, borderRadius: 99, background: '#f1f5f9', overflow: 'hidden' }}>
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
                              background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
                              boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                              width: 'min(92vw,460px)', maxHeight: '80vh',
                              display: 'flex', flexDirection: 'column', direction: 'rtl',
                            }}>
                          {/* Header */}
                          <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 32, height: 32, borderRadius: 8, background: '#8B1C1C', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>✏️</div>
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: '#1A1A1A' }}>الأطباء الكاتبون</div>
                                <div style={{ fontSize: 11, color: '#999' }}>{filtered.length}{writingItemFilter ? `/${allWritingDocs.length}` : ''} طبيب</div>
                              </div>
                            </div>
                            <button onClick={() => { setShowWritingPopup(false); setWritingItemFilter(null); setExpandedDocIds(new Set()); }}
                              style={{ width: 28, height: 28, borderRadius: '50%', background: '#F5F5F5', border: 'none', cursor: 'pointer', color: '#555', fontSize: 14, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                          </div>
                          {/* Item filter pills */}
                          {itemNames.length > 0 && (
                            <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', flexWrap: 'wrap', gap: 6, background: '#FAFAFA' }}>
                              <button
                                onClick={() => setWritingItemFilter(null)}
                                style={{
                                  fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 20,
                                  border: `1.5px solid ${writingItemFilter === null ? '#8B1C1C' : '#E0E0E0'}`,
                                  background: writingItemFilter === null ? '#8B1C1C' : '#fff',
                                  color: writingItemFilter === null ? '#fff' : '#555',
                                  cursor: 'pointer', transition: 'all 0.15s',
                                }}>الكل</button>
                              {itemNames.map(name => (
                                <button key={name}
                                  onClick={() => setWritingItemFilter(prev => prev === name ? null : name)}
                                  style={{
                                    fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 20,
                                    border: `1.5px solid ${writingItemFilter === name ? '#8B1C1C' : '#E0E0E0'}`,
                                    background: writingItemFilter === name ? '#fceaea' : '#fff',
                                    color: writingItemFilter === name ? '#8B1C1C' : '#555',
                                    cursor: 'pointer', transition: 'all 0.15s',
                                  }}>💊 {name}</button>
                              ))}
                            </div>
                          )}
                          {/* Doctors list */}
                          {filtered.length === 0 ? (
                            <div style={{ padding: '14px 16px', color: '#94a3b8', fontSize: 13 }}>لا يوجد أطباء لهذا الايتم</div>
                          ) : (
                            <div style={{ overflowY: 'auto', flex: 1 }}>
                              {filtered.map((doc, idx) => {
                                const isExpanded = expandedDocIds.has(doc.id);
                                const hasDetails = showDoctorFields && (doc.specialty || doc.area || (doc as any).pharmacyName);
                                return (
                                  <div key={doc.id} style={{
                                    padding: '11px 16px',
                                    borderBottom: idx < filtered.length - 1 ? '1px solid #F0F0F0' : 'none',
                                    direction: 'rtl',
                                  }}>
                                    {/* Name row */}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: hasDetails ? 5 : 0 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                        <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#8B1C1C', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{idx + 1}</span>
                                        <span style={{ fontSize: 14, fontWeight: 700, color: '#1A1A1A' }}>{doc.name}</span>
                                        {hasDetails && (
                                          <button onClick={() => toggleDocExpand(doc.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#999', fontSize: 11, lineHeight: 1, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</button>
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
                                          <span style={{ fontSize: 10, fontWeight: 600, background: '#F5F5F5', color: '#555', borderRadius: 6, padding: '3px 8px', border: '1px solid #E8E8E8' }}>🩺 {doc.specialty}</span>
                                        )}
                                        {doc.area && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: '#FFF0F0', color: '#8B1C1C', borderRadius: 6, padding: '3px 8px', border: '1px solid #f5c6c6' }}>📍 {doc.area.name}</span>
                                        )}
                                        {(doc as any).pharmacyName && (
                                          <span style={{ fontSize: 10, fontWeight: 600, background: '#F0F7FF', color: '#1D5FA4', borderRadius: 6, padding: '3px 8px', border: '1px solid #C5DCF5' }}>🏥 {(doc as any).pharmacyName}</span>
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
              padding: '7px 14px', borderRadius: 8, border: `1.5px solid ${showOnlyVisited ? '#10b981' : '#e2e8f0'}`,
              background: showOnlyVisited ? '#f0fdf4' : '#fff', color: showOnlyVisited ? '#065f46' : '#64748b',
              cursor: 'pointer', fontSize: 13, fontWeight: 600, transition: 'all 0.15s',
            }}>
              {showOnlyVisited ? '✅ المُزارون فقط' : '👥 جميع الأطباء'}
            </button>
            <button onClick={() => setExpandedAreas(
              expandedAreas.size > 0 ? new Set() : new Set(visitAreas.map(a => String(a.id)))
            )} style={{
              padding: '7px 14px', borderRadius: 8, border: '1.5px solid #e2e8f0',
              background: '#fff', color: '#64748b', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}>
              {expandedAreas.size > 0 ? '▲ طي الكل' : '▼ فتح الكل'}
            </button>
            {wishedDoctors.size > 0 && (
              <button onClick={() => setShowWishPanel(v => !v)} style={{
                padding: '7px 14px', borderRadius: 8,
                border: `1.5px solid ${showWishPanel ? '#6366f1' : '#e2e8f0'}`,
                background: showWishPanel ? '#eef2ff' : '#f8fafc',
                color: '#4338ca', cursor: 'pointer', fontSize: 13, fontWeight: 700,
              }}>
                ⭐ قائمة الطلبات ({wishedDoctors.size})
              </button>
            )}
          </div>

          {/* Wished doctors panel */}
          {showWishPanel && wishedDoctors.size > 0 && (() => {
            const allDocs = visitAreas.flatMap(a => a.doctors);
            const wished  = allDocs.filter(d => wishedDoctors.has(d.id));
            return (
              <div style={{
                background: '#f8fafc',
                border: '1.5px solid #e2e8f0', borderRadius: 16,
                padding: '16px 18px', marginBottom: 18,
                boxShadow: '0 2px 12px rgba(99,102,241,0.07)',
              }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>📋</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#4338ca' }}>أطباء مطلوبون في البلان</span>
                    <span style={{
                      background: '#6366f1', color: '#fff', borderRadius: 99,
                      fontSize: 11, fontWeight: 700, padding: '1px 8px', minWidth: 22, textAlign: 'center',
                    }}>{wished.length}</span>
                  </div>
                  <button onClick={() => {
                    setWishedDoctors(new Set());
                    setWishedItems({});
                    setWishedNames({});
                    localStorage.removeItem('wishedDoctors');
                    localStorage.removeItem('wishedItems');
                    localStorage.removeItem('wishedDoctorNames');
                  }} style={{
                    background: 'none', border: '1px solid #e2e8f0', borderRadius: 7,
                    padding: '3px 10px', fontSize: 11, color: '#64748b', cursor: 'pointer', fontWeight: 600,
                  }}>مسح الكل</button>
                </div>

                {/* Cards grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
                  {wished.map((d, idx) => {
                    const currentItem = wishedItems[d.id] ?? d.targetItem?.name ?? '';
                    const showDrop = openItemDropdowns.has(d.id);
                    const filteredItems = currentItem.trim()
                      ? items.filter(it => it.name.toLowerCase().includes(currentItem.toLowerCase()))
                      : items;
                    return (
                      <div key={d.id} style={{
                        background: '#fff', borderRadius: 12, padding: '12px 12px 10px',
                        border: '1.5px solid #e2e8f0', direction: 'rtl',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                        position: 'relative',
                      }}>
                        {/* Remove button */}
                        <button onClick={() => toggleWish(d.id, d.name)} style={{
                          position: 'absolute', top: 8, left: 8,
                          background: 'none', border: 'none', cursor: 'pointer',
                          fontSize: 15, color: '#94a3b8', lineHeight: 1, padding: 2,
                        }}>×</button>

                        {/* Number badge */}
                        <span style={{
                          position: 'absolute', top: 8, right: 10,
                          background: '#eef2ff', color: '#4338ca',
                          borderRadius: 99, fontSize: 10, fontWeight: 700,
                          padding: '1px 6px',
                        }}>{idx + 1}</span>

                        <div style={{ marginTop: 14, marginBottom: 8 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{d.name}</div>
                          {d.specialty && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{d.specialty}</div>}
                        </div>

                        {/* Item dropdown */}
                        <div style={{ position: 'relative' }}>
                          <div style={{
                            display: 'flex', alignItems: 'center',
                            border: '1.5px solid #e2e8f0', borderRadius: 8,
                            background: '#f8fafc', overflow: 'hidden',
                          }}>
                            <input
                              value={currentItem}
                              onChange={e => { setWishedItem(d.id, e.target.value); toggleItemDrop(d.id, true); }}
                              onFocus={() => toggleItemDrop(d.id, true)}
                              onBlur={() => setTimeout(() => toggleItemDrop(d.id, false), 160)}
                              placeholder="اختر الايتم..."
                              style={{
                                flex: 1, padding: '5px 8px', fontSize: 12, border: 'none',
                                background: 'transparent', color: '#4338ca', fontWeight: 600,
                                outline: 'none', direction: 'rtl', minWidth: 0,
                              }}
                            />
                            <button
                              onMouseDown={e => { e.preventDefault(); toggleItemDrop(d.id); }}
                              style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                padding: '0 8px', color: '#a5b4fc', fontSize: 12, flexShrink: 0,
                              }}>▾</button>
                          </div>
                          {showDrop && filteredItems.length > 0 && (
                            <div style={{
                              position: 'absolute', top: 'calc(100% + 3px)', right: 0, left: 0, zIndex: 200,
                              background: '#fff', border: '1px solid #e2e8f0', borderRadius: 9,
                              boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
                              maxHeight: 160, overflowY: 'auto',
                            }}>
                              {filteredItems.map(it => (
                                <div key={it.id}
                                  onMouseDown={() => { setWishedItem(d.id, it.name); toggleItemDrop(d.id, false); }}
                                  style={{
                                    padding: '7px 12px', fontSize: 12, cursor: 'pointer',
                                    color: '#4338ca', fontWeight: 600,
                                    borderBottom: '1px solid #f8fafc',
                                    background: currentItem === it.name ? '#eef2ff' : '#fff',
                                  }}
                                  onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                                  onMouseLeave={e => (e.currentTarget.style.background = currentItem === it.name ? '#eef2ff' : '#fff')}
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
                  marginTop: 12, fontSize: 12, color: '#4338ca',
                  padding: '7px 12px', background: '#eef2ff', borderRadius: 9,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span>💡</span>
                  <span>هؤلاء الأطباء محفوظون لتذكير المدير بتضمينهم في البلان القادم</span>
                </div>
              </div>
            );
          })()}
          {visitLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
              جاري التحميل...
            </div>
          )}

          {!visitLoading && visitAreas.length === 0 && (
            <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>📭</div>
              لا توجد بيانات زيارات
            </div>
          )}

          {!visitLoading && [...visitAreas].sort((a, b) => b.totalDoctors - a.totalDoctors).map(area => {
            const key     = String(area.id);
            const isOpen  = expandedAreas.has(key);
            const pct     = area.totalDoctors > 0 ? Math.round(area.visitedCount / area.totalDoctors * 100) : 0;
            const searchQ = visitSearch.trim().toLowerCase();

            const filtered = area.doctors.filter(d => {
              if (showOnlyVisited && !d.visited) return false;
              if (searchQ && !d.name.toLowerCase().includes(searchQ) && !(d.specialty ?? '').toLowerCase().includes(searchQ)) return false;
              return true;
            });
            if (filtered.length === 0 && searchQ) return null;
            const sorted = [...filtered].sort((a, b) => {
              if (a.visited !== b.visited) return a.visited ? -1 : 1;
              return (a.name ?? '').localeCompare(b.name ?? '');
            });

            return (
              <div key={key} style={{
                background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0',
                marginBottom: 12, overflow: 'hidden',
                boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
                transition: 'box-shadow 0.15s',
              }}>
                {/* Area header */}
                <button onClick={() => toggleArea(key)} style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 14,
                  padding: '14px 18px', background: 'none', border: 'none', cursor: 'pointer',
                  textAlign: 'right', direction: 'rtl',
                }}>
                  {/* Progress ring placeholder — use bar */}
                  <div style={{ position: 'relative', width: 44, height: 44, flexShrink: 0 }}>
                    <svg width="44" height="44" viewBox="0 0 44 44" style={{ transform: 'rotate(-90deg)' }}>
                      <circle cx="22" cy="22" r="18" fill="none" stroke="#e2e8f0" strokeWidth="4" />
                      <circle cx="22" cy="22" r="18" fill="none"
                        stroke={pct >= 80 ? '#10b981' : pct >= 50 ? '#6366f1' : '#f59e0b'}
                        strokeWidth="4"
                        strokeDasharray={`${2 * Math.PI * 18}`}
                        strokeDashoffset={`${2 * Math.PI * 18 * (1 - pct / 100)}`}
                        strokeLinecap="round" />
                    </svg>
                    <span style={{
                      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: 10, fontWeight: 700,
                      color: pct >= 80 ? '#065f46' : pct >= 50 ? '#4338ca' : '#92400e',
                    }}>{pct}%</span>
                  </div>

                  <div style={{ flex: 1, textAlign: 'right' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#1e293b' }}>{area.name}</div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                      {/* total */}
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#64748b', background: '#f1f5f9', borderRadius: 20, padding: '2px 9px' }}>
                        👥 {area.totalDoctors} طبيب
                      </span>
                      {/* visited → writing pill */}
                      <span style={{ display: 'inline-flex', alignItems: 'center', background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 20, overflow: 'hidden', fontSize: 12 }}>
                        <span style={{ padding: '2px 9px', color: '#065f46', fontWeight: 700 }}>{area.visitedCount} ✅</span>
                        {area.writingCount > 0 && (
                          <>
                            <span style={{ color: '#34d399', fontSize: 11, padding: '0 2px' }}>←</span>
                            <span style={{ padding: '2px 9px', color: '#0d9488', fontWeight: 700, borderRight: '1px solid #6ee7b7' }}>{area.writingCount} ✏️</span>
                          </>
                        )}
                      </span>
                      {/* not visited */}
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#94a3b8', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 20, padding: '2px 9px' }}>
                        🔲 {area.totalDoctors - area.visitedCount} لم يُزار
                      </span>
                    </div>
                  </div>

                  <span style={{ fontSize: 18, color: '#94a3b8', transition: 'transform 0.2s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                    ▾
                  </span>
                </button>

                {/* Doctors list */}
                {isOpen && (
                  <div style={{ borderTop: '1px solid #f1f5f9', padding: '4px 0 8px' }}>
                    {sorted.length === 0 && (
                      <div style={{ padding: '16px 20px', color: '#94a3b8', fontSize: 13 }}>لا توجد نتائج</div>
                    )}
                    {sorted.map(doc => {
                      const lastVisit = doc.visits[0];
                      const fb = lastVisit ? (FEEDBACK_LABEL[lastVisit.feedback] ?? FEEDBACK_LABEL.pending) : null;
                      const isVisitOpen = expandedVisits.has(doc.id);
                      const isWished    = wishedDoctors.has(doc.id);
                      return (
                        <div key={doc.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          {/* Main row */}
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 18px', direction: 'rtl',
                            opacity: doc.visited ? 1 : 0.5,
                          }}>
                            {/* Status dot */}
                            <span style={{
                              width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                              background: doc.isWriting ? '#10b981' : doc.visited ? '#6366f1' : '#d1d5db',
                            }} />

                            {/* Name + specialty */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ fontSize: 14, fontWeight: 600, color: '#1e293b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {doc.name}
                                </span>
                                {doc.isWriting && (
                                  <span style={{
                                    fontSize: 13, padding: '1px 4px', borderRadius: 8,
                                    background: '#d1fae5', border: '1px solid #6ee7b7',
                                    flexShrink: 0, lineHeight: 1,
                                  }}>✏️</span>
                                )}
                              </div>
                              {doc.specialty && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{doc.specialty}</div>}
                            </div>

                            {/* Wish button */}
                            <button onClick={() => toggleWish(doc.id, doc.name)} title={isWished ? 'إزالة من القائمة' : 'أضف للبلان'} style={{
                              background: isWished ? '#eef2ff' : 'transparent', border: `1.5px solid ${isWished ? '#6366f1' : '#cbd5e1'}`,
                              borderRadius: 8, width: 30, height: 30, cursor: 'pointer', fontSize: 15,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                              opacity: isWished ? 1 : 0.45,
                              transition: 'all 0.15s',
                            }}>{'⭐'}</button>

                            {/* Visit count with expand toggle */}
                            {doc.visits.length > 0 ? (
                              <button onClick={() => toggleVisitExpand(doc.id)} style={{
                                display: 'flex', alignItems: 'center', gap: 4,
                                fontSize: 12, color: '#6366f1', fontWeight: 600,
                                background: isVisitOpen ? '#e0e7ff' : '#eef2ff',
                                padding: '3px 8px', borderRadius: 10, flexShrink: 0,
                                border: 'none', cursor: 'pointer', transition: 'background 0.12s',
                              }}>
                                {doc.visits.length} زيارة
                                <span style={{ fontSize: 10, transition: 'transform 0.2s', display: 'inline-block', transform: isVisitOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
                              </button>
                            ) : (
                              <span style={{ fontSize: 12, color: '#d1d5db', flexShrink: 0, minWidth: 58 }}>—</span>
                            )}

                            {/* Last visit date */}
                            <span className="doc-row-date" style={{ fontSize: 12, color: '#64748b', flexShrink: 0, minWidth: 72, textAlign: 'center' }}>
                              {lastVisit ? fmt(lastVisit.visitDate) : '—'}
                            </span>

                            {/* Item */}
                            <span className="doc-row-item" style={{ fontSize: 12, color: '#475569', flexShrink: 0, minWidth: 70, textAlign: 'center' }}>
                              {lastVisit?.item?.name ?? doc.targetItem?.name ?? '—'}
                            </span>

                            {/* Feedback chip */}
                            {fb ? (
                              <span style={{
                                fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 10,
                                background: fb.bg, color: fb.color, flexShrink: 0, minWidth: 58, textAlign: 'center',
                              }}>{fb.label}</span>
                            ) : (
                              <span style={{ fontSize: 11, color: '#d1d5db', flexShrink: 0, minWidth: 58, textAlign: 'center' }}>لم يُزر</span>
                            )}
                          </div>

                          {/* Expanded visits */}
                          {isVisitOpen && doc.visits.length > 0 && (
                            <div style={{ background: '#f8fafc', borderTop: '1px solid #f1f5f9', padding: '8px 18px 8px 18px' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
                                <thead>
                                  <tr style={{ color: '#94a3b8', fontWeight: 600 }}>
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
                                      <tr key={v.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                                        <td style={{ padding: '5px 8px', color: '#94a3b8' }}>{idx + 1}</td>
                                        <td style={{ padding: '5px 8px', color: '#374151', whiteSpace: 'nowrap' }}>{fmt(v.visitDate)}</td>
                                        <td style={{ padding: '5px 8px', color: '#475569' }}>{v.item?.name ?? '—'}</td>
                                        <td style={{ padding: '5px 8px' }}>
                                          <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: vfb.bg, color: vfb.color }}>{vfb.label}</span>
                                        </td>
                                        <td style={{ padding: '5px 8px', color: '#64748b', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                return (
                  !showPharmMonthPicker ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 14, direction: 'rtl' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', flexShrink: 0 }}>📅</span>
                      <button style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                        border: '1px solid #6366f1', background: '#eef2ff', color: '#4338ca',
                        cursor: 'default', whiteSpace: 'nowrap',
                      }}>الكل</button>
                      <button
                        onClick={() => setShowPharmMonthPicker(true)}
                        style={{
                          fontSize: 13, padding: '2px 8px', borderRadius: 14, flexShrink: 0,
                          border: '1px solid #e2e8f0', background: 'transparent', color: '#94a3b8',
                          cursor: 'pointer', lineHeight: 1,
                        }}>‹</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 14, direction: 'rtl', overflowX: 'auto', flexWrap: 'nowrap', paddingBottom: 2, WebkitOverflowScrolling: 'touch' as any }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', flexShrink: 0 }}>📅</span>
                      <button onClick={() => { setPharmVisitMonthFilter(null); setShowPharmMonthPicker(false); }} style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                        border: `1px solid ${pharmVisitMonthFilter === null ? '#6366f1' : '#e2e8f0'}`,
                        background: pharmVisitMonthFilter === null ? '#eef2ff' : 'transparent',
                        color: pharmVisitMonthFilter === null ? '#4338ca' : '#94a3b8', cursor: 'pointer', whiteSpace: 'nowrap',
                      }}>الكل</button>
                      {options.map(o => {
                        const active = pharmVisitMonthFilter?.month === o.month && pharmVisitMonthFilter?.year === o.year;
                        return (
                          <button key={`${o.month}-${o.year}`}
                            onClick={() => setPharmVisitMonthFilter({ month: o.month, year: o.year })}
                            style={{
                              fontSize: 11, fontWeight: active ? 700 : 400, padding: '3px 9px', borderRadius: 14, flexShrink: 0,
                              border: `1px solid ${active ? '#6366f1' : '#e2e8f0'}`,
                              background: active ? '#eef2ff' : 'transparent',
                              color: active ? '#4338ca' : '#94a3b8', cursor: 'pointer', whiteSpace: 'nowrap',
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
                      { label: 'إجمالي الصيدليات', value: totalPharma, icon: '🏪', accent: '#6366f1' },
                      { label: 'إجمالي الزيارات',  value: totalVisits, icon: '📍', accent: '#6366f1' },
                      { label: 'عدد المناطق',       value: pharmVisitAreas.length, icon: '🗺️', accent: '#6366f1' },
                    ].map(s => (
                      <div key={s.label} style={{
                        flex: '1 1 110px', background: '#fff', borderRadius: 12,
                        padding: '12px 16px', border: `1.5px solid #e2e8f0`,
                        textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                      }}>
                        <div style={{ fontSize: 20 }}>{s.icon}</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: s.accent, lineHeight: 1.2 }}>{s.value}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{s.label}</div>
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
                  padding: '7px 14px', borderRadius: 8, border: '1.5px solid #e2e8f0',
                  background: '#fff', color: '#64748b', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}>
                  {pharmExpandedAreas.size > 0 ? '▲ طي الكل' : '▼ فتح الكل'}
                </button>
              </div>

              {/* Loading */}
              {pharmVisitLoading && (
                <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                  جاري التحميل...
                </div>
              )}

              {/* Empty */}
              {!pharmVisitLoading && pharmVisitAreas.length === 0 && (
                <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
                  <div style={{ fontSize: 44, marginBottom: 12 }}>🏪</div>
                  لا توجد بيانات زيارات صيدليات
                </div>
              )}

              {/* Area groups */}
              {!pharmVisitLoading && pharmVisitAreas.map((area, aIdx) => {
                const key    = area.id != null ? String(area.id) : `name-${aIdx}-${area.name}`;
                const isOpen = pharmExpandedAreas.has(key);
                const searchQ = pharmSearch.trim().toLowerCase();
                const filteredPharmas = area.pharmacies.filter(p =>
                  !searchQ || p.name.toLowerCase().includes(searchQ)
                );
                if (filteredPharmas.length === 0 && searchQ) return null;
                return (
                  <div key={key} style={{
                    background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0',
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
                        background: '#eef2ff', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', fontSize: 18,
                      }}>🏪</div>
                      <div style={{ flex: 1, textAlign: 'right' }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#1e293b' }}>{area.name}</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, color: '#4338ca', background: '#eef2ff', borderRadius: 20, padding: '2px 9px' }}>
                            🏪 {area.totalPharmacies} صيدلية
                          </span>
                          <span style={{ fontSize: 12, color: '#065f46', background: '#d1fae5', borderRadius: 20, padding: '2px 9px' }}>
                            📍 {area.totalVisits} زيارة
                          </span>
                        </div>
                      </div>
                      <span style={{ fontSize: 18, color: '#94a3b8', transition: 'transform 0.2s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
                    </button>

                    {/* Pharmacies list */}
                    {isOpen && (
                      <div style={{ borderTop: '1px solid #f1f5f9', padding: '4px 0 8px' }}>
                        {filteredPharmas.map(pharm => {
                          const pharmKey = `${key}-${pharm.name}`;
                          const isExpanded = expandedPharma.has(pharmKey);
                          return (
                            <div key={pharmKey} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <div style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '10px 18px', direction: 'rtl',
                              }}>
                                <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: '#6366f1' }} />
                                <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{pharm.name}</div>
                                {pharm.visits.length > 0 ? (
                                  <button onClick={() => setExpandedPharma(prev => {
                                    const next = new Set(prev);
                                    next.has(pharmKey) ? next.delete(pharmKey) : next.add(pharmKey);
                                    return next;
                                  })} style={{
                                    fontSize: 12, color: '#4338ca', fontWeight: 600,
                                    background: isExpanded ? '#e0e7ff' : '#eef2ff',
                                    padding: '3px 8px', borderRadius: 10, flexShrink: 0,
                                    border: 'none', cursor: 'pointer',
                                  }}>
                                    {pharm.visits.length} زيارة
                                    <span style={{ fontSize: 10, marginRight: 3, display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
                                  </button>
                                ) : (
                                  <span style={{ fontSize: 12, color: '#d1d5db', minWidth: 58 }}>—</span>
                                )}
                                <span style={{ fontSize: 12, color: '#64748b', minWidth: 72, textAlign: 'center' }}>
                                  {pharm.visits[0] ? fmt(pharm.visits[0].visitDate) : '—'}
                                </span>
                              </div>
                              {isExpanded && pharm.visits.length > 0 && (
                                <div style={{ background: '#f8fafc', borderTop: '1px solid #f1f5f9', padding: '8px 18px' }}>
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
                                    <thead>
                                      <tr style={{ color: '#94a3b8', fontWeight: 600 }}>
                                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>#</th>
                                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>التاريخ</th>
                                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>الايتمات</th>
                                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>ملاحظات</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {pharm.visits.map((v, idx) => (
                                        <tr key={v.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                                          <td style={{ padding: '5px 8px', color: '#94a3b8' }}>{idx + 1}</td>
                                          <td style={{ padding: '5px 8px', color: '#374151', whiteSpace: 'nowrap' }}>{fmt(v.visitDate)}</td>
                                          <td style={{ padding: '5px 8px' }}>
                                            {v.items.length > 0
                                              ? v.items.map(it => (
                                                  <span key={it.id} style={{ fontSize: 11, background: '#ede9fe', color: '#6d28d9', borderRadius: 8, padding: '2px 7px', marginLeft: 4, fontWeight: 600 }}>💊 {it.name}</span>
                                                ))
                                              : <span style={{ color: '#d1d5db' }}>—</span>
                                            }
                                          </td>
                                          <td style={{ padding: '5px 8px', color: '#64748b' }}>{v.notes ?? '—'}</td>
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
            </div>
          )}
        </div>
      )}

      {/* ── PHARMACIES TAB ───────────────────────────────── */}
      {activeTab === 'pharmacies' && showPharmacies && (
        <div>
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <button onClick={openAddPharm} style={btnStyle('#10b981')}>＋ إضافة صيدلية</button>
            <button onClick={() => { setShowPharmImport(v => !v); setPharmImportResult(null); }} style={btnStyle('#6366f1')}>📊 استيراد Excel</button>
          </div>

          {/* Import panel */}
          {showPharmImport && (
            <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: 18, marginBottom: 18 }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#166534' }}>📊 استيراد قائمة الصيدليات من Excel</h3>
              <p style={{ margin: '0 0 12px', fontSize: 12, color: '#15803d', lineHeight: 1.7 }}>
                الأعمدة المدعومة: <strong>الاسم *</strong> · المالك · الهاتف · العنوان · المنطقة · ملاحظات
              </p>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <input ref={pharmFileRef} type="file" accept=".xlsx,.xls,.csv" disabled={pharmImporting}
                  onChange={e => { const f = e.target.files?.[0]; if (f) importPharmExcel(f); }}
                  style={{ fontSize: 13 }} />
                {pharmImporting && <span style={{ fontSize: 13, color: '#15803d' }}>⏳ جاري الاستيراد...</span>}
              </div>
              {pharmImportResult && (
                <div style={{ marginTop: 12, fontSize: 13 }}>
                  <div style={{ color: '#166534', fontWeight: 700 }}>
                    ✅ تم استيراد {pharmImportResult.imported} صيدلية
                    {pharmImportResult.skipped > 0 && <span style={{ color: '#92400e', marginRight: 8 }}>· تم تخطي {pharmImportResult.skipped} موجود مسبقاً</span>}
                  </div>
                  {pharmImportResult.detectedCols && (
                    <div style={{ marginTop: 6, color: '#64748b' }}>
                      الأعمدة المكتشفة: {Object.entries(pharmImportResult.detectedCols).map(([k, v]) => `${k} → "${v}"`).join(' · ')}
                    </div>
                  )}
                  {pharmImportResult.errors.length > 0 && (
                    <div style={{ marginTop: 6, color: '#dc2626' }}>
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
                    border: `1.5px solid ${surveyPharmArea === 'all' ? '#6366f1' : '#e2e8f0'}`,
                    background: surveyPharmArea === 'all' ? '#eef2ff' : '#f8fafc',
                    color: surveyPharmArea === 'all' ? '#4338ca' : '#64748b',
                  }}>الكل</button>
                  {areas.map(a => (
                    <button key={a} onClick={() => setSurveyPharmArea(prev => prev === a ? 'all' : a)} style={{
                      fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
                      border: `1.5px solid ${surveyPharmArea === a ? '#6366f1' : '#e2e8f0'}`,
                      background: surveyPharmArea === a ? '#eef2ff' : '#f8fafc',
                      color: surveyPharmArea === a ? '#4338ca' : '#64748b',
                    }}>{a}</button>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Loading */}
          {surveyPharmLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
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
              <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
                <div style={{ fontSize: 44, marginBottom: 12 }}>🏪</div>
                {surveyPharmacies.length === 0 ? 'لا توجد صيدليات — أضف أو استورد من Excel' : 'لا توجد نتائج للبحث'}
              </div>
            );
            return (
              <>
                <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                  {filtered.length} صيدلية{surveyPharmArea !== 'all' && ` في ${surveyPharmArea}`}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                  {filtered.map(p => (
                    <div key={p.id} style={{
                      background: '#fff', borderRadius: 14, padding: '14px 16px',
                      border: '1.5px solid #e2e8f0', boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
                      direction: 'rtl', position: 'relative',
                    }}>
                      {/* Edit / Delete buttons */}
                      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4 }}>
                        <button onClick={() => openEditPharm(p)} title="تعديل"
                          style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: '3px 7px', fontSize: 12, cursor: 'pointer', color: '#64748b' }}>✏️</button>
                        <button onClick={() => deletePharm(p.id)} title="حذف"
                          style={{ background: '#fff1f2', border: '1px solid #fecaca', borderRadius: 7, padding: '3px 7px', fontSize: 12, cursor: 'pointer', color: '#dc2626' }}>🗑</button>
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 8, paddingLeft: 56 }}>🏪 {p.name}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {p.ownerName && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
                            <span style={{ color: '#94a3b8' }}>👤</span><span>{p.ownerName}</span>
                          </div>
                        )}
                        {p.phone && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
                            <span style={{ color: '#94a3b8' }}>📞</span><span dir="ltr">{p.phone}</span>
                          </div>
                        )}
                        {p.address && (
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13, color: '#374151' }}>
                            <span style={{ color: '#94a3b8', marginTop: 1 }}>📍</span><span>{p.address}</span>
                          </div>
                        )}
                        {p.areaName && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, background: '#eef2ff', color: '#4338ca', borderRadius: 20, padding: '2px 10px' }}>
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
              <div style={{ fontWeight: 700, fontSize: 16, color: '#1e293b' }}>زياراتي الميدانية</div>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>سجل زياراتك للأطباء والصيدليات</div>
            </div>
          </div>
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px 0', fontSize: 14 }}>
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
                <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>👤 المندوب</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => { setArchiveRepFilter(null); setArchiveAreaFilter('all'); }}
                    style={{
                      padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `1.5px solid ${archiveRepFilter === null ? '#6366f1' : '#e2e8f0'}`,
                      background: archiveRepFilter === null ? '#eef2ff' : '#f8fafc',
                      color: archiveRepFilter === null ? '#4338ca' : '#64748b',
                    }}>الكل</button>
                  {managerReps.map(rep => (
                    <button
                      key={rep.userId}
                      onClick={() => { setArchiveRepFilter(rep.userId); setArchiveAreaFilter('all'); }}
                      style={{
                        padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        border: `1.5px solid ${archiveRepFilter === rep.userId ? '#6366f1' : '#e2e8f0'}`,
                        background: archiveRepFilter === rep.userId ? '#eef2ff' : '#f8fafc',
                        color: archiveRepFilter === rep.userId ? '#4338ca' : '#64748b',
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
                <div style={{ display: 'flex', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, marginBottom: 16, overflow: 'hidden', direction: 'rtl' }}>
                  {stats.map((s, i) => (
                    <div key={s.label}
                      onClick={() => s.key && (s.val as number) > 0 && setArchiveSubPopup(s.key as any)}
                      style={{
                        flex: 1, padding: '12px 10px', textAlign: 'center',
                        borderLeft: i < stats.length - 1 ? '1px solid #e2e8f0' : 'none',
                        cursor: s.key && (s.val as number) > 0 ? 'pointer' : 'default',
                        background: '#fff', transition: 'background .12s',
                      }}
                      onMouseEnter={e => { if (s.key && (s.val as number) > 0) (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = '#fff'; }}>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{s.icon} {s.label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', lineHeight: 1 }}>{s.val}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Search + filter bar */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <input value={archiveSearch} onChange={e => setArchiveSearch(e.target.value)}
                placeholder="️و بحث..."
                style={{ flex: '1 1 160px', padding: '7px 11px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, direction: 'rtl', outline: 'none', background: '#fafafa' }} />
              <select value={archiveAreaFilter} onChange={e => setArchiveAreaFilter(e.target.value)}
                style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, direction: 'rtl', background: '#fafafa', outline: 'none', maxWidth: 160, color: '#334155' }}>
                <option value="all">كل المناطق</option>
                {uniqueAreas.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              {archiveStarred.size > 0 && (
                <button onClick={() => setShowArchiveWishPanel(v => !v)}
                  title="للبلان"
                  style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${showArchiveWishPanel ? '#475569' : '#e2e8f0'}`,
                    background: showArchiveWishPanel ? '#1e293b' : '#f8fafc', color: showArchiveWishPanel ? '#fff' : '#475569',
                    fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
                  ★ {archiveStarred.size}
                </button>
              )}
              <button onClick={loadArchive} disabled={archiveLoading} title="تحديث"
                style={{ padding: '7px 11px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569', fontSize: 14, cursor: 'pointer', opacity: archiveLoading ? 0.5 : 1 }}>
                {archiveLoading ? '⏳' : '↻'}
              </button>
            </div>

            {/* Starred panel */}
            {showArchiveWishPanel && archiveStarred.size > 0 && (() => {
              const allDocsFlat = archiveAreas.flatMap(a => a.doctors);
              const starredDocs = allDocsFlat.filter(d => archiveStarred.has(d.surveyDoctorId));
              return (
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 16px', marginBottom: 14, direction: 'rtl' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>★ للبلان <span style={{ fontWeight: 400, color: '#64748b', fontSize: 12 }}>({starredDocs.length})</span></span>
                    <button onClick={() => { setArchiveStarred(new Set()); localStorage.removeItem(archiveStarKey); }}
                      style={{ background: 'none', border: '1px solid #e2e8f0', borderRadius: 6, padding: '3px 9px', fontSize: 11, color: '#94a3b8', cursor: 'pointer' }}>
                      مسح
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 6 }}>
                    {starredDocs.map((d, idx) => (
                      <div key={d.surveyDoctorId} style={{ background: '#fafafa', borderRadius: 8, padding: '8px 10px', border: '1px solid #e2e8f0', position: 'relative' }}>
                        <button onClick={() => toggleArchiveStar(d.surveyDoctorId)} style={{ position: 'absolute', top: 5, left: 7, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#94a3b8', lineHeight: 1, padding: 0 }}>×</button>
                        <span style={{ position: 'absolute', top: 5, right: 7, fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>{idx + 1}</span>
                        <div style={{ marginTop: 12, fontSize: 13, fontWeight: 700, color: '#1e293b' }}>{d.name}</div>
                        {d.specialty && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{d.specialty}</div>}
                        {d.areaName && <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>📍 {d.areaName}</div>}
                        {d.isVisited && <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>✅{d.visitItems?.length > 0 ? ` ${d.visitItems.join(' · ')}` : ''}</div>}
                        {d.isWriting && d.writingItems.length > 0 && (
                          <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>✍ {d.writingItems.join(' · ')}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {archiveLoading ? (
              <div style={{ textAlign: 'center', color: '#94a3b8', padding: 40 }}>جاري التحميل...</div>
            ) : filteredAreas.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', direction: 'rtl' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>📚</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#1e293b', marginBottom: 8 }}>الأرشيف فارغ</div>
                <div style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>أضف أطباء من السيرفي لتتبّعهم هنا بشكل مستقل عن الكولات</div>
                <button onClick={() => setShowAddModal(true)}
                  style={{ padding: '10px 24px', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  ＋ إضافة من السيرفي
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {filteredAreas.map(area => {
                  const isExpanded = effectiveExpanded.has(area.name);
                  const visitedCount = area.doctors.filter(d => d.isVisited).length;
                  const writingCount = area.doctors.filter(d => d.isWriting).length;
                  return (
                    <div key={area.name} style={{ background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                      {/* Area header */}
                      <div onClick={() => setArchiveExpandedAreas(prev => { const s = new Set(prev); s.has(area.name) ? s.delete(area.name) : s.add(area.name); return s; })}
                        style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', background: isExpanded ? '#fafafa' : '#fff', direction: 'rtl' }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', flex: 1 }}>📍 {area.name}</span>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>{area.doctors.length}</span>
                        {visitedCount > 0 && <span style={{ fontSize: 11, color: '#475569', background: '#f1f5f9', borderRadius: 6, padding: '1px 7px' }}>✅ {visitedCount}</span>}
                        {writingCount > 0 && <span style={{ fontSize: 11, color: '#475569', background: '#f1f5f9', borderRadius: 6, padding: '1px 7px' }}>✍ {writingCount}</span>}
                        <button
                          onClick={e => { e.stopPropagation(); removeAreaFromArchive(area.name, area.doctors.map(d => d.surveyDoctorId)); }}
                          title="حذف المنطقة"
                          style={{ background: 'none', border: 'none', padding: '2px 6px', fontSize: 13, cursor: 'pointer', color: '#94a3b8', flexShrink: 0, lineHeight: 1, borderRadius: 4 }}>
                          🗑
                        </button>
                        <span style={{ color: '#cbd5e1', fontSize: 11 }}>{isExpanded ? '▴' : '▾'}</span>
                      </div>

                      {/* Doctor list */}
                      {isExpanded && (
                        <div style={{ borderTop: '1px solid #f1f5f9' }}>
                          {area.doctors.map(doc => (
                            <div key={doc.surveyDoctorId} style={{ padding: '10px 14px', borderBottom: '1px solid #f1f5f9', direction: 'rtl' }}>
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                {/* Info */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{doc.name}</span>
                                    {doc.specialty && <span style={{ fontSize: 11, color: '#94a3b8' }}>{doc.specialty}</span>}
                                    {doc.pharmacyName && <span style={{ fontSize: 11, color: '#94a3b8' }}>· {doc.pharmacyName}</span>}
                                    {doc.className && <span style={{ fontSize: 10, background: '#f1f5f9', color: '#475569', borderRadius: 4, padding: '1px 6px' }}>{doc.className}</span>}
                                  </div>

                                  {/* Toggles row */}
                                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                    {/* Visited toggle */}
                                    <button onClick={() => patchArchive(doc.surveyDoctorId, { isVisited: !doc.isVisited })}
                                      title="تمت الزيارة"
                                      style={{ padding: '3px 9px', borderRadius: 6, border: `1px solid ${doc.isVisited ? '#94a3b8' : '#e2e8f0'}`,
                                        background: doc.isVisited ? '#1e293b' : '#f8fafc', color: doc.isVisited ? '#fff' : '#94a3b8',
                                        fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
                                      {doc.isVisited ? '✅' : '○'} زيارة
                                    </button>

                                    {/* Writing toggle */}
                                    <button onClick={() => patchArchive(doc.surveyDoctorId, { isWriting: !doc.isWriting })}
                                      title="يكتب"
                                      style={{ padding: '3px 9px', borderRadius: 6, border: `1px solid ${doc.isWriting ? '#94a3b8' : '#e2e8f0'}`,
                                        background: doc.isWriting ? '#1e293b' : '#f8fafc', color: doc.isWriting ? '#fff' : '#94a3b8',
                                        fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
                                      {doc.isWriting ? '✍' : '○'} كتابة
                                    </button>
                                  </div>

                                  {/* Visit items (shown when visited) */}
                                  {doc.isVisited && (
                                    <div style={{ marginTop: 6 }}>
                                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                                        {doc.visitItems.map((item, i) => (
                                          <span key={i} style={{ background: '#f1f5f9', color: '#334155', borderRadius: 4, padding: '2px 7px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                                            {item}
                                            <button onClick={() => patchArchive(doc.surveyDoctorId, { visitItems: doc.visitItems.filter((_, idx) => idx !== i) })}
                                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 0, fontSize: 11, lineHeight: 1 }}>×</button>
                                          </span>
                                        ))}
                                        {visitItemInputId === doc.surveyDoctorId ? (
                                          <div style={{ position: 'relative' }}>
                                            <input autoFocus value={visitItemInputVal} onChange={e => setVisitItemInputVal(e.target.value)}
                                              onKeyDown={e => {
                                                if (e.key === 'Enter' && visitItemInputVal.trim()) {
                                                  patchArchive(doc.surveyDoctorId, { visitItems: [...doc.visitItems, visitItemInputVal.trim()] });
                                                  setVisitItemInputVal(''); setVisitItemInputId(null);
                                                } else if (e.key === 'Escape') { setVisitItemInputVal(''); setVisitItemInputId(null); }
                                              }}
                                              onBlur={() => { if (visitItemInputVal.trim()) { patchArchive(doc.surveyDoctorId, { visitItems: [...doc.visitItems, visitItemInputVal.trim()] }); } setVisitItemInputVal(''); setVisitItemInputId(null); }}
                                              style={{ padding: '2px 7px', borderRadius: 4, border: '1px solid #94a3b8', fontSize: 11, outline: 'none', width: 90, background: '#fafafa' }}
                                              placeholder="إيتم..." />
                                            {(() => {
                                              const q = visitItemInputVal.trim().toLowerCase();
                                              const sugs = q ? archiveItemSuggestions.filter(s => s.toLowerCase().includes(q) && !doc.visitItems.includes(s)) : [];
                                              return sugs.length > 0 ? (
                                                <div style={{ position: 'absolute', top: '100%', right: 0, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 200, minWidth: 140, maxHeight: 150, overflowY: 'auto', marginTop: 2, direction: 'rtl' }}>
                                                  {sugs.slice(0, 8).map(s => (
                                                    <button key={s} onMouseDown={() => { patchArchive(doc.surveyDoctorId, { visitItems: [...doc.visitItems, s] }); setVisitItemInputVal(''); setVisitItemInputId(null); }}
                                                      onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                                                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                                                      style={{ display: 'block', width: '100%', background: 'none', border: 'none', padding: '5px 10px', textAlign: 'right', cursor: 'pointer', fontSize: 11, color: '#334155' }}>
                                                      {s}
                                                    </button>
                                                  ))}
                                                </div>
                                              ) : null;
                                            })()}
                                          </div>
                                        ) : (
                                          <button onClick={() => setVisitItemInputId(doc.surveyDoctorId)}
                                            style={{ background: 'none', border: '1px dashed #cbd5e1', borderRadius: 4, padding: '2px 7px', fontSize: 11, color: '#94a3b8', cursor: 'pointer' }}>
                                            +
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {/* Writing items */}
                                  {doc.isWriting && (
                                    <div style={{ marginTop: 6 }}>
                                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                                        {doc.writingItems.map((item, i) => (
                                          <span key={i} style={{ background: '#f1f5f9', color: '#334155', borderRadius: 4, padding: '2px 7px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                                            {item}
                                            <button onClick={() => patchArchive(doc.surveyDoctorId, { writingItems: doc.writingItems.filter((_, idx) => idx !== i) })}
                                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 0, fontSize: 11, lineHeight: 1 }}>×</button>
                                          </span>
                                        ))}
                                        {itemInputId === doc.surveyDoctorId ? (
                                          <div style={{ position: 'relative' }}>
                                            <input autoFocus value={itemInputVal} onChange={e => setItemInputVal(e.target.value)}
                                              onKeyDown={e => {
                                                if (e.key === 'Enter' && itemInputVal.trim()) {
                                                  patchArchive(doc.surveyDoctorId, { writingItems: [...doc.writingItems, itemInputVal.trim()] });
                                                  setItemInputVal(''); setItemInputId(null);
                                                } else if (e.key === 'Escape') { setItemInputVal(''); setItemInputId(null); }
                                              }}
                                              onBlur={() => { if (itemInputVal.trim()) { patchArchive(doc.surveyDoctorId, { writingItems: [...doc.writingItems, itemInputVal.trim()] }); } setItemInputVal(''); setItemInputId(null); }}
                                              style={{ padding: '2px 7px', borderRadius: 4, border: '1px solid #94a3b8', fontSize: 11, outline: 'none', width: 90, background: '#fafafa' }}
                                              placeholder="إيتم..." />
                                            {(() => {
                                              const q = itemInputVal.trim().toLowerCase();
                                              const sugs = q ? archiveItemSuggestions.filter(s => s.toLowerCase().includes(q) && !doc.writingItems.includes(s)) : [];
                                              return sugs.length > 0 ? (
                                                <div style={{ position: 'absolute', top: '100%', right: 0, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 200, minWidth: 140, maxHeight: 150, overflowY: 'auto', marginTop: 2, direction: 'rtl' }}>
                                                  {sugs.slice(0, 8).map(s => (
                                                    <button key={s} onMouseDown={() => { patchArchive(doc.surveyDoctorId, { writingItems: [...doc.writingItems, s] }); setItemInputVal(''); setItemInputId(null); }}
                                                      onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                                                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                                                      style={{ display: 'block', width: '100%', background: 'none', border: 'none', padding: '5px 10px', textAlign: 'right', cursor: 'pointer', fontSize: 11, color: '#334155' }}>
                                                      {s}
                                                    </button>
                                                  ))}
                                                </div>
                                              ) : null;
                                            })()}
                                          </div>
                                        ) : (
                                          <button onClick={() => setItemInputId(doc.surveyDoctorId)}
                                            style={{ background: 'none', border: '1px dashed #cbd5e1', borderRadius: 4, padding: '2px 7px', fontSize: 11, color: '#94a3b8', cursor: 'pointer' }}>
                                            +
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {/* Notes */}
                                  {notesEditId === doc.surveyDoctorId ? (
                                    <div style={{ marginTop: 8 }}>
                                      <input autoFocus value={notesEditVal} onChange={e => setNotesEditVal(e.target.value)}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') { patchArchive(doc.surveyDoctorId, { notes: notesEditVal || null }); setNotesEditId(null); }
                                          else if (e.key === 'Escape') setNotesEditId(null);
                                        }}
                                        onBlur={() => { patchArchive(doc.surveyDoctorId, { notes: notesEditVal || null }); setNotesEditId(null); }}
                                        style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box', direction: 'rtl' }}
                                        placeholder="ملاحظات..." />
                                    </div>
                                  ) : doc.notes ? (
                                    <div onClick={() => { setNotesEditId(doc.surveyDoctorId); setNotesEditVal(doc.notes ?? ''); }}
                                      style={{ marginTop: 5, fontSize: 11, color: '#64748b', background: '#fafafa', padding: '3px 8px', borderRadius: 4, cursor: 'pointer', display: 'inline-block', border: '1px solid #f1f5f9' }}>
                                      📝 {doc.notes}
                                    </div>
                                  ) : (
                                    <button onClick={() => { setNotesEditId(doc.surveyDoctorId); setNotesEditVal(''); }}
                                      style={{ marginTop: 5, background: 'none', border: 'none', fontSize: 11, color: '#cbd5e1', cursor: 'pointer', padding: 0 }}>
                                      + ملاحظة
                                    </button>
                                  )}
                                </div>

                                {/* Star + Remove buttons */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
                                  <button onClick={() => toggleArchiveStar(doc.surveyDoctorId)} title={archiveStarred.has(doc.surveyDoctorId) ? 'إزالة من البلان' : 'أضف للبلان'}
                                    style={{ background: 'none', border: 'none',
                                      width: 26, height: 26, cursor: 'pointer', fontSize: 14,
                                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      color: archiveStarred.has(doc.surveyDoctorId) ? '#1e293b' : '#cbd5e1',
                                      transition: 'color .15s', padding: 0 }}>
                                    {archiveStarred.has(doc.surveyDoctorId) ? '★' : '☆'}
                                  </button>
                                  <button onClick={() => removeFromArchive(doc.surveyDoctorId)} title="إزالة"
                                    style={{ background: 'none', border: 'none', width: 26, height: 26, fontSize: 13, cursor: 'pointer', color: '#cbd5e1', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, borderRadius: 4 }}>
                                    ️️
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
            body = <div style={{ textAlign: 'center', color: '#94a3b8', padding: 30 }}>لا يوجد</div>;
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
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', background: '#f8fafc', borderRadius: 6, padding: '4px 10px', marginBottom: 5, direction: 'rtl', border: '1px solid #e2e8f0' }}>
                      📍 {areaName} <span style={{ fontWeight: 400 }}>({docs.length})</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {docs.map(d => (
                        <div key={d.surveyDoctorId} style={{ padding: '7px 12px', borderRadius: 6, background: '#fafafa', border: '1px solid #e2e8f0', direction: 'rtl' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{d.name}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                            {d.specialty && <span style={{ fontSize: 11, color: '#94a3b8' }}>{d.specialty}</span>}
                            {d.pharmacyName && <span style={{ fontSize: 11, color: '#94a3b8' }}>· {d.pharmacyName}</span>}
                          </div>
                          {d.visitItems.length > 0 && (
                            <div style={{ marginTop: 4, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                              {d.visitItems.map((item, i) => (
                                <span key={i} style={{ background: '#f1f5f9', color: '#475569', borderRadius: 4, padding: '1px 7px', fontSize: 11 }}>{item}</span>
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
            body = <div style={{ textAlign: 'center', color: '#94a3b8', padding: 30 }}>لا يوجد</div>;
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
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', background: '#f8fafc', borderRadius: 6, padding: '4px 10px', marginBottom: 5, direction: 'rtl', border: '1px solid #e2e8f0' }}>
                      📍 {areaName} <span style={{ fontWeight: 400 }}>({docs.length})</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {docs.map(d => (
                        <div key={d.surveyDoctorId} style={{ padding: '7px 12px', borderRadius: 6, background: '#fafafa', border: '1px solid #e2e8f0', direction: 'rtl' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{d.name}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                            {d.specialty && <span style={{ fontSize: 11, color: '#94a3b8' }}>{d.specialty}</span>}
                            {d.writingItems.length > 0 && (
                              <span style={{ fontSize: 11, color: '#475569' }}>{d.writingItems.join(' · ')}</span>
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
            ? <div style={{ textAlign: 'center', color: '#94a3b8', padding: 30 }}>لا توجد إيتمات</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sortedItems.map(([item, docs]) => (
                  <div key={item} style={{ borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', overflow: 'hidden' }}>
                    <div style={{ padding: '7px 12px', background: '#f8fafc', direction: 'rtl', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #e2e8f0' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', flex: 1 }}>{item}</span>
                      <span style={{ fontSize: 11, color: '#64748b', background: '#e2e8f0', borderRadius: 20, padding: '1px 8px' }}>{docs.length}</span>
                    </div>
                    <div style={{ padding: '6px 12px', direction: 'rtl', display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {docs.map(d => (
                        <div key={d.surveyDoctorId} style={{ fontSize: 12, color: '#475569', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, color: '#1e293b' }}>{d.name}</span>
                          {d.areaName && <span style={{ color: '#94a3b8' }}>{d.areaName}</span>}
                          {d.specialty && <span style={{ color: '#94a3b8' }}>· {d.specialty}</span>}
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
                <button onClick={() => setArchiveSubPopup(null)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#64748b' }}>✕</button>
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>{body}</div>
            </div>
          </div>
        );
      })()}

      {/* ── New Custom Doctor Modal ────────────────────────── */}
      {showNewDocForm && (() => {
        const areaOptions = [...new Set(archiveAreas.map(a => a.name))].sort();
        return (
          <div style={overlayStyle} onClick={() => { setShowNewDocForm(false); setNewDocErr(''); }}>
            <div style={{ ...modalStyle, maxWidth: 400 }} onClick={e => e.stopPropagation()} dir="rtl">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#1e293b' }}>طبيب جديد</span>
                <button onClick={() => { setShowNewDocForm(false); setNewDocErr(''); }} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#94a3b8', lineHeight: 1 }}>×</button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Name */}
                <div>
                  <label style={{ fontSize: 11, color: '#64748b', fontWeight: 600, display: 'block', marginBottom: 4 }}>الاسم *</label>
                  <input autoFocus value={newDocName} onChange={e => setNewDocName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && submitCustomDoctor()}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: `1px solid ${newDocErr && !newDocName.trim() ? '#f87171' : '#e2e8f0'}`, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
                    placeholder="اسم الطبيب" />
                </div>

                {/* Specialty */}
                <div>
                  <label style={{ fontSize: 11, color: '#64748b', fontWeight: 600, display: 'block', marginBottom: 4 }}>التخصص</label>
                  <input value={newDocSpecialty} onChange={e => setNewDocSpecialty(e.target.value)}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
                    placeholder="مثال: قلب، عيون..." />
                </div>

                {/* Area — dropdown from existing areas + free text */}
                <div>
                  <label style={{ fontSize: 11, color: '#64748b', fontWeight: 600, display: 'block', marginBottom: 4 }}>المنطقة</label>
                  {areaOptions.length > 0 ? (
                    <select value={newDocArea} onChange={e => setNewDocArea(e.target.value)}
                      style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #e2e8f0', fontSize: 13, outline: 'none', background: '#fafafa', color: newDocArea ? '#1e293b' : '#94a3b8' }}>
                      <option value="">— اختر منطقة —</option>
                      {areaOptions.map(a => <option key={a} value={a}>{a}</option>)}
                      <option value="__custom__">أخرى (أكتب يدوياً)</option>
                    </select>
                  ) : (
                    <input value={newDocArea} onChange={e => setNewDocArea(e.target.value)}
                      style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
                      placeholder="اسم المنطقة" />
                  )}
                  {newDocArea === '__custom__' && (
                    <input autoFocus value="" onChange={e => setNewDocArea(e.target.value)}
                      style={{ width: '100%', marginTop: 6, padding: '7px 10px', borderRadius: 7, border: '1px solid #94a3b8', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
                      placeholder="اكتب اسم المنطقة..." />
                  )}
                </div>

                {/* Pharmacy */}
                <div>
                  <label style={{ fontSize: 11, color: '#64748b', fontWeight: 600, display: 'block', marginBottom: 4 }}>الصيدلية</label>
                  <input value={newDocPharmacy} onChange={e => setNewDocPharmacy(e.target.value)}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
                    placeholder="اسم الصيدلية" />
                </div>

                {/* Class */}
                <div>
                  <label style={{ fontSize: 11, color: '#64748b', fontWeight: 600, display: 'block', marginBottom: 4 }}>التصنيف</label>
                  <input value={newDocClass} onChange={e => setNewDocClass(e.target.value)}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
                    placeholder="مثال: A, B, C" />
                </div>
              </div>

              {newDocErr && (
                <div style={{ marginTop: 10, fontSize: 12, color: '#ef4444', background: '#fef2f2', borderRadius: 6, padding: '6px 10px' }}>{newDocErr}</div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button onClick={submitCustomDoctor} disabled={newDocSaving}
                  style={{ flex: 1, padding: '9px 0', background: '#1e293b', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: newDocSaving ? 0.7 : 1 }}>
                  {newDocSaving ? 'جاري الحفظ...' : 'حفظ'}
                </button>
                <button onClick={() => { setShowNewDocForm(false); setNewDocErr(''); }}
                  style={{ padding: '9px 16px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
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
              <button onClick={() => { setShowAddModal(false); setShowAreaDropdown(false); setSurveyDocSelectedAreas(new Set()); }} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#64748b' }}>✕</button>
            </div>

            {/* Search + area multi-select */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <input value={surveyDocSearch} onChange={e => setSurveyDocSearch(e.target.value)}
                placeholder="🔍 بحث..."
                style={{ flex: '1 1 160px', padding: '7px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13, direction: 'rtl', outline: 'none' }} />
              {/* Area multi-select dropdown */}
              {(() => {
                const allAreas = [...new Set(surveyDoctors.map(d => d.areaName).filter(Boolean) as string[])].sort();
                const selectedCount = surveyDocSelectedAreas.size;
                const label = selectedCount === 0 ? 'كل المناطق' : `${selectedCount} منطقة`;
                return (
                  <div style={{ position: 'relative' }}>
                    <button onClick={() => setShowAreaDropdown(v => !v)}
                      style={{ padding: '7px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13, direction: 'rtl', background: selectedCount > 0 ? '#ede9fe' : '#fff', color: selectedCount > 0 ? '#7c3aed' : '#334155', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                      📍 {label} <span style={{ fontSize: 10 }}>▼</span>
                    </button>
                    {showAreaDropdown && (
                      <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 999, background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', minWidth: 200, maxHeight: 260, overflowY: 'auto', padding: '6px 0' }}>
                        {/* Select all / clear */}
                        <div style={{ display: 'flex', gap: 6, padding: '6px 12px 8px', borderBottom: '1px solid #f1f5f9' }}>
                          <button onClick={() => setSurveyDocSelectedAreas(new Set())}
                            style={{ flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', cursor: 'pointer', color: '#475569' }}>
                            الكل
                          </button>
                          <button onClick={() => setSurveyDocSelectedAreas(new Set(allAreas))}
                            style={{ flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', cursor: 'pointer', color: '#475569' }}>
                            تحديد الكل
                          </button>
                        </div>
                        {allAreas.map(a => (
                          <label key={a} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: '#1e293b', direction: 'rtl' }}>
                            <input type="checkbox" checked={surveyDocSelectedAreas.has(a)}
                              onChange={() => setSurveyDocSelectedAreas(prev => {
                                const next = new Set(prev);
                                next.has(a) ? next.delete(a) : next.add(a);
                                return next;
                              })}
                              style={{ accentColor: '#8b5cf6', width: 14, height: 14 }} />
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
                <div style={{ textAlign: 'center', color: '#94a3b8', padding: 30 }}>جاري التحميل...</div>
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
                  <div style={{ textAlign: 'center', color: '#94a3b8', padding: 30 }}>لا توجد أطباء متاحون للإضافة</div>
                );
                const filteredIds = filtered2.map(d => d.id);
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {/* Import all bar */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0', marginBottom: 2 }}>
                      <span style={{ fontSize: 12, color: '#64748b' }}>{filtered2.length} طبيب</span>
                      <button onClick={() => addAllToArchive(filteredIds)} disabled={importingAll}
                        style={{ padding: '5px 14px', background: importingAll ? '#a78bfa' : '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: importingAll ? 'not-allowed' : 'pointer', opacity: importingAll ? 0.7 : 1 }}>
                        {importingAll ? '⏳ جاري الاستيراد...' : '⬇️ استيراد الكل'}
                      </button>
                    </div>
                    {filtered2.map(d => (
                      <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, border: '1px solid #f1f5f9', direction: 'rtl', background: '#fafafa' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>{d.name}</div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                            {d.specialty && <span style={{ fontSize: 11, color: '#64748b' }}>🩺 {d.specialty}</span>}
                            {d.areaName  && <span style={{ fontSize: 11, color: '#6366f1' }}>📍 {d.areaName}</span>}
                            {d.pharmacyName && <span style={{ fontSize: 11, color: '#0891b2' }}>🏪 {d.pharmacyName}</span>}
                          </div>
                        </div>
                        <button onClick={() => addToArchive(d.id)} disabled={addingIds.has(d.id)}
                          style={{ padding: '5px 12px', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: addingIds.has(d.id) ? 0.6 : 1, flexShrink: 0 }}>
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
              <div style={{ marginTop: 10, padding: '8px 12px', background: '#fee2e2', borderRadius: 8, color: '#dc2626', fontSize: 13 }}>
                ⚠️ {pharmSaveErr}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
              <button onClick={() => setPharmModal(null)} style={{ ...btnStyle('#94a3b8'), background: '#f1f5f9', color: '#475569' }}>إلغاء</button>
              <button onClick={savePharm} disabled={pharmSaving} style={{ ...btnStyle('#10b981'), opacity: pharmSaving ? 0.7 : 1 }}>
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
                  {fAreaId && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: '#059669', fontWeight: 700 }}>✓</span>}
                  {!fAreaId && fAreaName.trim() && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: '#f59e0b', fontWeight: 600 }}>جديد</span>}
                  {fAreaShowSugg && fAreaSugg.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 300, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', marginTop: 2, overflow: 'hidden' }}>
                      {fAreaSugg.map(a => (
                        <div key={a.id}
                          onMouseDown={() => { setFAreaId(String(a.id)); setFAreaName(a.name); setFAreaSugg([]); setFAreaShowSugg(false); }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f1f5f9' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
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
                  {fItemId && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: '#059669', fontWeight: 700 }}>✓</span>}
                  {!fItemId && fItemName.trim() && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: '#f59e0b', fontWeight: 600 }}>جديد</span>}
                  {fItemShowSugg && fItemSugg.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 300, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', marginTop: 2, overflow: 'hidden' }}>
                      {fItemSugg.map(i => (
                        <div key={i.id}
                          onMouseDown={() => { setFItemId(String(i.id)); setFItemName(i.name); setFItemSugg([]); setFItemShowSugg(false); }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f1f5f9' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
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
              <button onClick={() => setModal(null)} style={btnStyle('#94a3b8')}>إلغاء</button>
              <button onClick={save} disabled={saving} style={btnStyle('#3b82f6')}>{saving ? 'جاري الحفظ...' : 'حفظ'}</button>
            </div>
          </div>
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
  width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box', direction: 'rtl',
};
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: '#374151' };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 14 };
const thStyle: React.CSSProperties    = { textAlign: 'right', padding: '10px 12px', fontWeight: 700, fontSize: 13, color: '#475569', borderBottom: '2px solid #e2e8f0' };
const tdStyle: React.CSSProperties    = { padding: '10px 12px', color: '#1e293b', verticalAlign: 'middle' };
const alertStyle: React.CSSProperties = { background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', marginBottom: 16 };
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalStyle: React.CSSProperties   = { background: '#fff', borderRadius: 12, padding: 28, width: '90%', maxWidth: 620, maxHeight: '90vh', overflowY: 'auto', direction: 'rtl' };
