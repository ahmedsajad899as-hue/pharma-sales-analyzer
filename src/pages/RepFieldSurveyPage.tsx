import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';
import RepFieldSurveyMap from '../components/RepFieldSurveyMap';

// ════════════════════════════════════════════════════════════════════════════
// سيرفي المندوب العلمي الميداني
// — المندوب: يسجّل أطباء وصيدليات منطقته، وموقع كل اسم إلزامي بدقة عالية.
// — مدير الشركة / قائد الفريق: يرى سجلات مندوبيه كاملة للاطلاع والتصدير.
// أرشيف توثيقي معزول: لا يرتبط بالمبيعات أو الزيارات، ولا يقرأ من السيرفي
// الرئيسي ولا يكتب فيه.
// ════════════════════════════════════════════════════════════════════════════

type Kind = 'doctor' | 'pharmacy';

export interface Entry {
  id: number;
  userId: number;
  repName: string | null;
  kind: Kind;
  name: string;
  specialty: string | null;
  className: string | null;
  areaName: string;
  notes: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  nearPharmacies: string[];
  pharmacyIds: number[];
  createdAt: string;
  editedAt: string | null;
  editedByName: string | null;
  // المالك أو زميل مكتب يشاركه نفس المنطقة — الخادم هو من يقرّر
  canEdit: boolean;
}

interface RepOption { userId: number; name: string; company: string | null }
interface NearbyRow { name: string; specialty: string; className: string }
interface Coords { latitude: number; longitude: number; accuracy: number }
interface DupMatch { id: number; name: string; areaName: string; nearPharmacies: string[]; repName?: string | null }
interface DupState { kind: Kind; endpoint: string; body: Record<string, unknown>; matches: DupMatch[] }
interface Notice { kind: Kind; name: string; lines: string[] }

// دقة الموقع: ننتظر حتى تتحسن القراءة، ونرفض ما هو أسوأ من الحد
const TARGET_ACC_M = 15;
const WAIT_MS = 25000;
const MAX_ACC_M = 50; // يطابق الحد في الخادم

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('ar-IQ', {
    timeZone: 'Asia/Baghdad', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;
const normArea = (s: string) => s.trim().replace(/\s+/g, ' ');

const EMPTY_FORM = { name: '', specialty: '', className: '', areaName: '', notes: '' };

// الكلاس: خيارات ثابتة فقط. الاختصاص: نفس القائمة لكن تقبل كتابة اسم جديد أيضاً
const CLASS_OPTIONS = ['A', 'B', 'C'];
const SPECIALTY_OPTIONS = [
  'باطنية', 'قلبية', 'نسائية', 'تنفسية', 'كسور', 'مفاصل',
  'جراحة أعصاب', 'استشارة أعصاب', 'أطفال', 'جراحة', 'أورام', 'ENT',
];

// تذكّر المنطقة الأخيرة لمدة 4 ساعات من آخر اختيار لها (تفضيل على هذا المتصفح فقط)
const AREA_MEMORY_KEY = 'rfs-remembered-area';
const AREA_MEMORY_MS = 4 * 60 * 60 * 1000;

function readRememberedArea(): string {
  try {
    const raw = window.localStorage.getItem(AREA_MEMORY_KEY);
    if (!raw) return '';
    const { area, savedAt } = JSON.parse(raw);
    if (typeof area === 'string' && area && Date.now() - Number(savedAt) < AREA_MEMORY_MS) return area;
    window.localStorage.removeItem(AREA_MEMORY_KEY);
  } catch { /* وضع خاص أو تخزين معطّل */ }
  return '';
}

function rememberArea(area: string) {
  const clean = area.trim();
  if (!clean) return;
  try {
    window.localStorage.setItem(AREA_MEMORY_KEY, JSON.stringify({ area: clean, savedAt: Date.now() }));
  } catch { /* وضع خاص أو تخزين معطّل */ }
}

// قراءة متواصلة للموقع حتى تبلغ الدقة الهدف (أو تنتهي المهلة فنأخذ الأفضل)
function captureBestLocation(onLive: (acc: number) => void): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('المتصفح لا يدعم تحديد الموقع.'));
      return;
    }
    let best: GeolocationPosition | null = null;
    let watchId: number | null = null;
    let timer: number | undefined;
    let finished = false;

    const stop = () => {
      finished = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (timer !== undefined) window.clearTimeout(timer);
    };
    const finish = () => {
      if (finished) return;
      stop();
      if (!best) {
        reject(new Error('تعذّر تحديد الموقع. تأكد من تفعيل GPS وحاول في مكان مفتوح.'));
        return;
      }
      const acc = best.coords.accuracy;
      if (acc > MAX_ACC_M) {
        reject(new Error(`الدقة الحالية ±${Math.round(acc)} م غير كافية. اخرج إلى مكان مفتوح أو استخدم الهاتف مع GPS ثم أعد المحاولة.`));
        return;
      }
      resolve({ latitude: best.coords.latitude, longitude: best.coords.longitude, accuracy: acc });
    };

    watchId = navigator.geolocation.watchPosition(
      p => {
        if (finished) return;
        onLive(p.coords.accuracy);
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
        if (p.coords.accuracy <= TARGET_ACC_M) finish();
      },
      err => {
        if (finished) return;
        if (err.code === 1) {
          stop();
          reject(new Error('تم رفض إذن الموقع. فعّله من إعدادات المتصفح ثم أعد المحاولة.'));
        }
        // أخطاء مؤقتة (إشارة ضعيفة): ننتظر قراءة أخرى حتى المهلة
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: WAIT_MS },
    );
    timer = window.setTimeout(finish, WAIT_MS);
  });
}

// حقل قائمة صيدليات: كل ما يُكتب في الحقل هو الاسم مباشرة — لا حاجة لضغط زر
// لتثبيته. "+ إضافة" يفتح حقلاً إضافياً لصيدلية ثانية، لا يُستخدم لتأكيد الأولى.
// listId: اقتراحات بأسماء الصيدليات المسجَّلة فعلاً — تمنع كتابة اسم قريب
// (خطأ إملائي بسيط) يُنشئ سجلاً مكرراً بدل الربط بالصيدلية الموجودة.
function PharmacyFields({ value, onChange, placeholder, listId }: { value: string[]; onChange: (v: string[]) => void; placeholder: string; listId?: string }) {
  const rows = value.length ? value : [''];
  const update = (i: number, v: string) => onChange(rows.map((x, j) => (j === i ? v : x)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  return (
    <div className="rfs-pharmacy-fields">
      {rows.map((v, i) => (
        <div className="input-row" key={i}>
          <input className="form-input" list={listId} placeholder={placeholder} value={v} onChange={e => update(i, e.target.value)} />
          {rows.length > 1 && (
            <button type="button" className="btn btn--secondary btn--sm" title="حذف" onClick={() => remove(i)}>✕</button>
          )}
        </div>
      ))}
      <button type="button" className="rfs-add-more" onClick={() => onChange([...rows, ''])}>+ إضافة صيدلية أخرى</button>
    </div>
  );
}

function describeSave(kind: Kind, data: any): string[] {
  if (kind === 'doctor') {
    const lines: string[] = [];
    if (data.merged) lines.push('أُضيفت الصيدليات إلى الطبيب الموجود — بقي طبيباً واحداً.');
    if (data.pharmaciesCreated) lines.push(`أُنشئت ${data.pharmaciesCreated} صيدلية جديدة في الأرشيف وربطت بهذا الطبيب.`);
    return lines;
  }
  const lines: string[] = [data.nearbyCount ? `مع ${data.nearbyCount} طبيب قريب.` : 'بدون أطباء قريبين.'];
  if (data.nearby?.linkedOwn) lines.push(`ربط ${data.nearby.linkedOwn} من أطبائك المسجَّلين سابقاً بهذه الصيدلية.`);
  return lines;
}

export default function RepFieldSurveyPage() {
  const { user, token } = useAuth();
  const isRep = user?.role === 'scientific_rep';
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  // ── بيانات ─────────────────────────────────────────────────────────────
  const [entries, setEntries]     = useState<Entry[]>([]);
  const [reps, setReps]           = useState<RepOption[]>([]);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState('');
  const [repFilter, setRepFilter] = useState<number | ''>('');
  const [kindFilter, setKindFilter] = useState<'all' | Kind>('all');
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [search, setSearch]       = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const qs = repFilter ? `?repUserId=${repFilter}` : '';
      const r = await fetch(`/api/rep-field-survey/entries${qs}`, { headers: H() });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.message || 'تعذّر تحميل السيرفي');
      setEntries(j.data.entries);
      setReps(j.data.reps);
    } catch (e: any) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [H, repFilter]);

  useEffect(() => { load(); }, [load]);

  // مناطق المندوب المعيّنة — اقتراحات لحقل المنطقة لتوحيد الأسماء
  const [areaOptions, setAreaOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!isRep) return;
    fetch('/api/scientific-reps/my-areas', { headers: H() })
      .then(r => r.json())
      .then(j => setAreaOptions((j.data ?? []).map((a: { name: string }) => a.name)))
      .catch(() => setAreaOptions([]));
  }, [isRep, H]);

  const repCompany = useMemo(() => new Map(reps.map(r => [r.userId, r.company])), [reps]);
  const nearbyOf = (pharmacyId: number) => entries.filter(x => x.kind === 'doctor' && x.pharmacyIds.includes(pharmacyId));

  // أسماء الأطباء/الصيدليات المسجَّلة فعلاً — تُقترح أثناء الكتابة في أي حقل
  // اسم (مباشر أو "قريب من") لمنع اسم قريب إملائياً من إنشاء سجل مكرر بدل
  // الربط بالاسم الموجود فعلاً.
  const knownDoctorNames = useMemo(
    () => [...new Set(entries.filter(e => e.kind === 'doctor').map(e => e.name))].sort((a, b) => a.localeCompare(b, 'ar')),
    [entries],
  );
  const knownPharmacyNames = useMemo(
    () => [...new Set(entries.filter(e => e.kind === 'pharmacy').map(e => e.name))].sort((a, b) => a.localeCompare(b, 'ar')),
    [entries],
  );

  // ── الإحصاء حسب المنطقة ────────────────────────────────────────────────
  const areaSummary = useMemo(() => {
    const map = new Map<string, { area: string; doctors: number; pharmacies: number }>();
    for (const e of entries) {
      const key = normArea(e.areaName);
      const row = map.get(key) ?? { area: key, doctors: 0, pharmacies: 0 };
      if (e.kind === 'doctor') row.doctors++; else row.pharmacies++;
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => (b.doctors + b.pharmacies) - (a.doctors + a.pharmacies));
  }, [entries]);

  const totals = useMemo(() => ({
    all:        entries.length,
    doctors:    entries.filter(e => e.kind === 'doctor').length,
    pharmacies: entries.filter(e => e.kind === 'pharmacy').length,
    areas:      areaSummary.length,
  }), [entries, areaSummary]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter(e => {
      if (kindFilter !== 'all' && e.kind !== kindFilter) return false;
      if (!q) return true;
      return [e.name, e.areaName, e.specialty, e.repName, ...e.nearPharmacies]
        .some(v => (v ?? '').toLowerCase().includes(q));
    });
  }, [entries, kindFilter, search]);

  // ── نموذج التسجيل (للمندوب فقط) ────────────────────────────────────────
  const [kind, setKind]           = useState<Kind>('doctor');
  const [form, setForm]           = useState(() => ({ ...EMPTY_FORM, areaName: readRememberedArea() }));
  const [doctorNear, setDoctorNear] = useState<string[]>([]);
  const [nearby, setNearby]       = useState<NearbyRow[]>([]);
  const [coords, setCoords]       = useState<Coords | null>(null);
  const [locState, setLocState]   = useState<'idle' | 'loading' | 'error'>('idle');
  const [locError, setLocError]   = useState('');
  const [liveAcc, setLiveAcc]     = useState<number | null>(null);
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice]       = useState<Notice | null>(null);
  const [dup, setDup]             = useState<DupState | null>(null);

  const setField = (k: keyof typeof EMPTY_FORM, v: string) => setForm(f => ({ ...f, [k]: v }));

  const resetAfterSave = () => {
    setForm(f => ({ ...EMPTY_FORM, areaName: f.areaName }));
    setDoctorNear([]);
    setNearby([]);
    setCoords(null);
    setLocState('idle');
    setLocError('');
    setLiveAcc(null);
  };

  const switchKind = (k: Kind) => {
    setKind(k);
    setForm(f => ({ ...EMPTY_FORM, areaName: f.areaName }));
    setDoctorNear([]);
    setNearby([]);
    setCoords(null);
    setLocState('idle');
    setLocError('');
    setLiveAcc(null);
    setFormError('');
    setNotice(null);
    setDup(null);
  };

  const captureLocation = async () => {
    setLocState('loading');
    setLocError('');
    setLiveAcc(null);
    try {
      setCoords(await captureBestLocation(setLiveAcc));
      setLocState('idle');
    } catch (e: any) {
      setCoords(null);
      setLocState('error');
      setLocError(e.message);
    }
  };

  // إرسال تسجيل جديد. الاسم المكرر لا يُحفظ: يظهر تنبيه بالسجلات المطابقة
  const send = async (k: Kind, endpoint: string, body: Record<string, unknown>, name: string) => {
    setSaving(true);
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: H(), body: JSON.stringify(body) });
      const j = await r.json();
      if (r.status === 409 && j.code === 'DUPLICATE_NAME') {
        setDup({ kind: k, endpoint, body, matches: j.matches ?? [] });
        return;
      }
      if (!r.ok || !j.success) throw new Error(j.message || 'تعذّر الحفظ.');
      rememberArea(String(body.areaName ?? ''));
      setNotice({ kind: k, name, lines: describeSave(k, j.data) });
      resetAfterSave();
      setDup(null);
      load();
    } catch (e: any) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    setFormError('');
    setNotice(null);
    setDup(null);
    if (!form.name.trim()) { setFormError(kind === 'doctor' ? 'اسم الطبيب مطلوب.' : 'اسم الصيدلية مطلوب.'); return; }
    if (!form.areaName.trim()) { setFormError('المنطقة مطلوبة.'); return; }
    if (!coords) { setFormError('يجب تحديد الموقع على الخارطة قبل الحفظ.'); return; }

    const base = {
      name: form.name.trim(),
      areaName: form.areaName.trim(),
      notes: form.notes.trim() || null,
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: coords.accuracy,
    };
    if (kind === 'doctor') {
      await send('doctor', '/api/rep-field-survey/doctors', {
        ...base,
        specialty: form.specialty.trim() || null,
        className: form.className.trim() || null,
        nearPharmacies: doctorNear.filter(p => p.trim()),
      }, base.name);
    } else {
      await send('pharmacy', '/api/rep-field-survey/pharmacies', {
        ...base,
        doctors: nearby.filter(d => d.name.trim()),
      }, base.name);
    }
  };

  // قرار المستخدم عند الاسم المكرر: دمج الصيدليات مع الموجود، أو حفظه كسجل جديد
  const resolveDup = (choice: { mergeIntoId: number } | 'new') => {
    if (!dup) return;
    const body = choice === 'new'
      ? { ...dup.body, allowDuplicate: true }
      : { ...dup.body, mergeIntoId: choice.mergeIntoId };
    const name = String(dup.body.name ?? '');
    setDup(null);
    send(dup.kind, dup.endpoint, body, name);
  };

  // ── تفاصيل سجل (للجميع، للقراءة) ──────────────────────────────────────
  const [viewing, setViewing] = useState<Entry | null>(null);

  // ── تعديل سجل (المندوب على سجلاته فقط) ──────────────────────────────────
  const [editing, setEditing]       = useState<Entry | null>(null);
  const [editForm, setEditForm]     = useState(EMPTY_FORM);
  const [editNear, setEditNear]     = useState<string[]>([]);
  const [editAddDoctors, setEditAddDoctors] = useState<NearbyRow[]>([]);
  const [editCoords, setEditCoords] = useState<Coords | null>(null);
  const [editLoc, setEditLoc]       = useState<'idle' | 'loading' | 'error'>('idle');
  const [editLocError, setEditLocError] = useState('');
  const [editLiveAcc, setEditLiveAcc]   = useState<number | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError]   = useState('');

  const openEdit = (e: Entry) => {
    setEditing(e);
    setEditForm({
      name: e.name,
      specialty: e.specialty ?? '',
      className: e.className ?? '',
      areaName: e.areaName,
      notes: e.notes ?? '',
    });
    setEditNear(e.nearPharmacies);
    setEditAddDoctors([]);
    setEditCoords(null);
    setEditLoc('idle');
    setEditLocError('');
    setEditLiveAcc(null);
    setEditError('');
  };

  const captureEditLocation = async () => {
    setEditLoc('loading');
    setEditLocError('');
    setEditLiveAcc(null);
    try {
      setEditCoords(await captureBestLocation(setEditLiveAcc));
      setEditLoc('idle');
    } catch (e: any) {
      setEditCoords(null);
      setEditLoc('error');
      setEditLocError(e.message);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditError('');
    if (!editForm.name.trim()) { setEditError(editing.kind === 'doctor' ? 'اسم الطبيب مطلوب.' : 'اسم الصيدلية مطلوب.'); return; }
    if (!editForm.areaName.trim()) { setEditError('المنطقة مطلوبة.'); return; }

    const body: Record<string, unknown> = {
      name: editForm.name.trim(),
      areaName: editForm.areaName.trim(),
      notes: editForm.notes.trim() || null,
    };
    if (editing.kind === 'doctor') {
      body.specialty = editForm.specialty.trim() || null;
      body.className = editForm.className.trim() || null;
      body.nearPharmacies = editNear.filter(p => p.trim());
    } else {
      const addDoctors = editAddDoctors.filter(d => d.name.trim());
      if (addDoctors.length) body.addDoctors = addDoctors;
    }
    if (editCoords) {
      body.latitude = editCoords.latitude;
      body.longitude = editCoords.longitude;
      body.accuracy = editCoords.accuracy;
    }

    setEditSaving(true);
    try {
      const r = await fetch(`/api/rep-field-survey/entries/${editing.id}`, {
        method: 'PATCH', headers: H(), body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.message || 'تعذّر حفظ التعديل.');
      setEditing(null);
      load();
    } catch (err: any) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  };

  // ── تصدير Excel ────────────────────────────────────────────────────────
  const exportExcel = () => {
    const rows = visible.map(e => ({
      'النوع': e.kind === 'doctor' ? 'طبيب' : 'صيدلية',
      'الاسم': e.name,
      'الاختصاص': e.specialty ?? '',
      'الكلاس': e.className ?? '',
      'الصيدليات القريبة': e.nearPharmacies.join('، '),
      'المنطقة': e.areaName,
      'المندوب': e.repName ?? '',
      'الشركة': e.repName ? (repCompany.get(e.userId) ?? '') : '',
      'خط العرض': e.latitude,
      'خط الطول': e.longitude,
      'الدقة (م)': e.accuracy != null ? Math.round(e.accuracy) : '',
      'رابط الخريطة': mapsUrl(e.latitude, e.longitude),
      'تاريخ ووقت التسجيل': fmtDateTime(e.createdAt),
      'آخر تعديل': e.editedAt ? fmtDateTime(e.editedAt) : '',
      'ملاحظات': e.notes ?? '',
    }));
    const summary = areaSummary.map(a => ({
      'المنطقة': a.area, 'أطباء': a.doctors, 'صيدليات': a.pharmacies, 'الإجمالي': a.doctors + a.pharmacies,
    }));
    summary.push({
      'المنطقة': 'المجموع',
      'أطباء': areaSummary.reduce((s, a) => s + a.doctors, 0),
      'صيدليات': areaSummary.reduce((s, a) => s + a.pharmacies, 0),
      'الإجمالي': areaSummary.reduce((s, a) => s + a.doctors + a.pharmacies, 0),
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'السجلات');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'الملخص حسب المنطقة');
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `سيرفي_المندوب_${stamp}.xlsx`);
  };

  // ── عرض ────────────────────────────────────────────────────────────────
  const nameLabel = kind === 'doctor' ? 'اسم الطبيب' : 'اسم الصيدلية';
  const detailText = (e: Entry) => e.kind === 'doctor'
    ? [e.specialty, e.className, e.nearPharmacies.length ? `قرب: ${e.nearPharmacies.join('، ')}` : ''].filter(Boolean).join(' · ') || '—'
    : `${nearbyOf(e.id).length} طبيب قريب${e.notes ? ` · ${e.notes}` : ''}`;

  return (
    <div className="page rfs-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">سيرفي المندوب العلمي</h1>
          <div className="page-subtitle">
            {isRep
              ? 'سجّل الأطباء والصيدليات في مناطقك، مع تحديد موقع كل اسم بدقة. تظهر لك أيضاً أسماء زملاء مكتبك المسجَّلة في نفس مناطقك، ويمكنكم تعديلها جميعاً.'
              : 'السجلات الميدانية لمندوبي فريقك — للاطلاع والتصدير.'}
          </div>
        </div>
        <div className="rfs-actions">
          <button className="btn btn--secondary btn--sm" onClick={load} disabled={loading}>تحديث</button>
          <button className="btn btn--primary btn--sm" onClick={exportExcel} disabled={!visible.length}>تصدير Excel</button>
        </div>
      </div>

      {loadError && <div className="alert alert--error">{loadError}</div>}

      <div className="stats-grid stats-grid--4">
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon--blue">∑</div>
          <div className="stat-card-body">
            <div className="stat-card-value">{totals.all}</div>
            <div className="stat-card-label">إجمالي المسجَّل</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon--green">👨‍⚕️</div>
          <div className="stat-card-body">
            <div className="stat-card-value">{totals.doctors}</div>
            <div className="stat-card-label">أطباء</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon--purple">💊</div>
          <div className="stat-card-body">
            <div className="stat-card-value">{totals.pharmacies}</div>
            <div className="stat-card-label">صيدليات</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon--amber">📍</div>
          <div className="stat-card-body">
            <div className="stat-card-value">{totals.areas}</div>
            <div className="stat-card-label">مناطق</div>
          </div>
        </div>
      </div>

      {/* ── نموذج التسجيل ── */}
      {isRep && (
        <section className="card rfs-card">
          <div className="rfs-card-head">
            <div className="section-title">تسجيل جديد</div>
            <div className="tabs">
              <button className={`tab ${kind === 'doctor' ? 'tab--active' : ''}`} onClick={() => switchKind('doctor')}>طبيب</button>
              <button className={`tab ${kind === 'pharmacy' ? 'tab--active' : ''}`} onClick={() => switchKind('pharmacy')}>صيدلية</button>
            </div>
          </div>

          {notice && (
            <div className="alert rfs-notice">
              <strong>تم حفظ {notice.kind === 'doctor' ? 'الطبيب' : 'الصيدلية'} «{notice.name}»</strong>
              {notice.lines.map((l, i) => <div key={i} className="rfs-muted">{l}</div>)}
            </div>
          )}

          <div className="rfs-form-grid">
            <div className="form-group">
              <label className="form-label">{nameLabel} *</label>
              <input className="form-input" list={kind === 'doctor' ? 'rfs-doctor-names' : 'rfs-pharmacy-names'} value={form.name} onChange={e => setField('name', e.target.value)} placeholder={kind === 'doctor' ? 'مثال: أحمد علي' : 'مثال: الأمل'} />
              <div className="rfs-muted">{kind === 'doctor' ? 'اكتب الاسم مباشرة بدون «د.» أو «دكتور».' : 'اكتب الاسم مباشرة بدون كلمة «صيدلية».'} إن ظهر الاسم ضمن الاقتراحات فاختره لتفادي تكرار نفس الاسم بصياغة مختلفة.</div>
            </div>
            <div className="form-group">
              <label className="form-label">المنطقة *</label>
              <input className="form-input" list="rfs-area-options" value={form.areaName} onChange={e => { setField('areaName', e.target.value); if (areaOptions.includes(e.target.value)) rememberArea(e.target.value); }} placeholder="اختر أو اكتب اسم المنطقة" />
              <datalist id="rfs-area-options">
                {areaOptions.map(a => <option key={a} value={a} />)}
              </datalist>
            </div>
            {kind === 'doctor' && (
              <>
                <div className="form-group">
                  <label className="form-label">الاختصاص</label>
                  <input className="form-input" list="rfs-specialty-options" value={form.specialty} onChange={e => setField('specialty', e.target.value)} placeholder="اختر أو اكتب اختصاصاً جديداً" />
                </div>
                <div className="form-group">
                  <label className="form-label">الكلاس</label>
                  <select className="form-input" value={form.className} onChange={e => setField('className', e.target.value)}>
                    <option value="">—</option>
                    {CLASS_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </>
            )}
            <div className="form-group rfs-span-full">
              <label className="form-label">ملاحظات</label>
              <input className="form-input" value={form.notes} onChange={e => setField('notes', e.target.value)} />
            </div>
          </div>
          <datalist id="rfs-specialty-options">
            {SPECIALTY_OPTIONS.map(s => <option key={s} value={s} />)}
          </datalist>
          <datalist id="rfs-doctor-names">
            {knownDoctorNames.map(n => <option key={n} value={n} />)}
          </datalist>
          <datalist id="rfs-pharmacy-names">
            {knownPharmacyNames.map(n => <option key={n} value={n} />)}
          </datalist>

          {kind === 'doctor' && (
            <div className="rfs-nearby">
              <div className="form-label">الصيدليات القريبة من الطبيب</div>
              <div className="rfs-muted">اكتب كل صيدلية قريبة ثم اضغط إضافة. الطبيب يبقى سجلاً واحداً مهما عددت صيدلياته.</div>
              <div style={{ marginTop: 8 }}>
                <PharmacyFields value={doctorNear} onChange={setDoctorNear} placeholder="اسم الصيدلية القريبة" listId="rfs-pharmacy-names" />
              </div>
            </div>
          )}

          {kind === 'pharmacy' && (
            <div className="rfs-nearby">
              <div className="rfs-nearby-head">
                <div>
                  <div className="form-label">الأطباء القريبون من الصيدلية</div>
                  <div className="rfs-muted">يُحفظون في الأرشيف بنفس موقع الصيدلية. الطبيب المسجَّل مسبقاً بنفس الاسم يُربط بهذه الصيدلية.</div>
                </div>
                <button className="btn btn--secondary btn--sm" onClick={() => setNearby([...nearby, { name: '', specialty: '', className: '' }])}>+ إضافة طبيب</button>
              </div>
              {nearby.map((d, i) => (
                <div className="rfs-nearby-row" key={i}>
                  <input className="form-input" list="rfs-doctor-names" placeholder="اسم الطبيب" value={d.name}
                    onChange={e => setNearby(nearby.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                  <input className="form-input" list="rfs-specialty-options" placeholder="الاختصاص" value={d.specialty}
                    onChange={e => setNearby(nearby.map((x, j) => j === i ? { ...x, specialty: e.target.value } : x))} />
                  <select className="form-input" value={d.className}
                    onChange={e => setNearby(nearby.map((x, j) => j === i ? { ...x, className: e.target.value } : x))}>
                    <option value="">كلاس</option>
                    {CLASS_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button className="btn btn--secondary btn--sm" title="حذف" onClick={() => setNearby(nearby.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button type="button" className="rfs-add-more" onClick={() => setNearby([...nearby, { name: '', specialty: '', className: '' }])}>
                + إضافة طبيب آخر قريب من الصيدلية
              </button>
            </div>
          )}

          {/* ── الموقع (إلزامي) ── */}
          <div className={`rfs-location ${coords ? 'rfs-location--ok' : locState === 'error' ? 'rfs-location--err' : ''}`}>
            <div className="rfs-location-text">
              {locState === 'loading' ? (
                <>
                  <strong>جارٍ تحديد الموقع بدقة…</strong>
                  <div className="rfs-muted">الدقة الحالية: {liveAcc != null ? `±${Math.round(liveAcc)} م` : 'بانتظار الإشارة'} · الهدف ±{TARGET_ACC_M} م</div>
                </>
              ) : coords ? (
                <>
                  <strong>✓ تم تحديد الموقع</strong>
                  <div className="rfs-muted">
                    دقة ±{Math.round(coords.accuracy)} م ·{' '}
                    <a href={mapsUrl(coords.latitude, coords.longitude)} target="_blank" rel="noreferrer">عرض على الخارطة</a>
                  </div>
                </>
              ) : locState === 'error' ? (
                <span>{locError}</span>
              ) : (
                <span className="rfs-muted">الموقع إلزامي — يُلتقط بقراءات متواصلة حتى تتحسن الدقة، وأفضل نتيجة عند الهاتف مع GPS مفعّل.</span>
              )}
            </div>
            <button className="btn btn--secondary btn--sm" onClick={captureLocation} disabled={locState === 'loading'}>
              {locState === 'loading' ? 'جارٍ التحديد…' : coords ? 'إعادة تحديد الموقع' : '📍 تحديد الموقع'}
            </button>
          </div>

          {dup && (
            <div className="alert rfs-dup">
              <strong>الاسم «{String(dup.body.name ?? '')}» موجود بالفعل:</strong>
              <ul className="rfs-dup-list">
                {dup.matches.map(m => (
                  <li key={m.id}>
                    {m.name} · {m.areaName}
                    {m.repName && <span className="rfs-muted"> · مسجَّل لدى {m.repName}</span>}
                    {m.nearPharmacies.length > 0 && <span className="rfs-muted"> · قرب: {m.nearPharmacies.join('، ')}</span>}
                  </li>
                ))}
              </ul>
              <div className="rfs-dup-actions">
                {dup.kind === 'doctor' && dup.matches.map(m => (
                  <button key={m.id} className="btn btn--primary btn--sm" disabled={saving} onClick={() => resolveDup({ mergeIntoId: m.id })}>
                    إضافة الصيدليات إلى «{m.name}»
                  </button>
                ))}
                <button className="btn btn--secondary btn--sm" disabled={saving} onClick={() => resolveDup('new')}>حفظه كسجل جديد</button>
                <button className="btn btn--secondary btn--sm" disabled={saving} onClick={() => setDup(null)}>تعديل الاسم</button>
              </div>
            </div>
          )}

          {formError && <div className="alert alert--error">{formError}</div>}

          <div className="rfs-submit">
            <button className="btn btn--primary" onClick={submit} disabled={saving || !coords || !!dup}>
              {saving ? 'جارٍ الحفظ…' : `حفظ ${kind === 'doctor' ? 'الطبيب' : 'الصيدلية'}`}
            </button>
          </div>
        </section>
      )}

      {/* ── إحصاء حسب المنطقة ── */}
      <section className="card rfs-card">
        <div className="section-title">الإحصاء حسب المنطقة</div>
        {areaSummary.length === 0 && !loading ? (
          <div className="empty-row">لا توجد سجلات بعد.</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr><th>المنطقة</th><th>أطباء</th><th>صيدليات</th><th>الإجمالي</th></tr>
              </thead>
              <tbody>
                {areaSummary.map(a => (
                  <tr key={a.area}>
                    <td>{a.area}</td>
                    <td>{a.doctors}</td>
                    <td>{a.pharmacies}</td>
                    <td><strong>{a.doctors + a.pharmacies}</strong></td>
                  </tr>
                ))}
                <tr className="rfs-total-row">
                  <td>المجموع</td>
                  <td>{totals.doctors}</td>
                  <td>{totals.pharmacies}</td>
                  <td>{totals.all}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── قائمة السجلات ── */}
      <section className="card rfs-card">
        <div className="rfs-list-controls">
          <div className="section-title">السجلات</div>
          <div className="rfs-filters">
            <div className="tabs">
              <button className={`tab ${viewMode === 'list' ? 'tab--active' : ''}`} onClick={() => setViewMode('list')}>📋 قائمة</button>
              <button className={`tab ${viewMode === 'map' ? 'tab--active' : ''}`} onClick={() => setViewMode('map')}>🗺️ خريطة</button>
            </div>
            {reps.length > 1 && (
              <select className="form-input" value={repFilter} onChange={e => setRepFilter(e.target.value ? Number(e.target.value) : '')}>
                <option value="">كل المندوبين</option>
                {reps.map(r => (
                  <option key={r.userId} value={r.userId}>
                    {r.userId === user?.id ? `${r.name} (أنا)` : r.name}{r.company ? ` — ${r.company}` : ''}
                  </option>
                ))}
              </select>
            )}
            <div className="tabs">
              {(['all', 'doctor', 'pharmacy'] as const).map(k => (
                <button key={k} className={`tab ${kindFilter === k ? 'tab--active' : ''}`} onClick={() => setKindFilter(k)}>
                  {k === 'all' ? 'الكل' : k === 'doctor' ? 'أطباء' : 'صيدليات'}
                </button>
              ))}
            </div>
            <input className="form-input" placeholder="بحث بالاسم أو المنطقة أو الصيدلية…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        {loading ? (
          <div className="empty-row">جارٍ التحميل…</div>
        ) : visible.length === 0 ? (
          <div className="empty-row">{entries.length ? 'لا توجد نتائج مطابقة.' : 'لم يتم تسجيل أي اسم بعد.'}</div>
        ) : viewMode === 'map' ? (
          <RepFieldSurveyMap entries={visible} onEdit={openEdit} />
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>النوع</th>
                  <th>الاسم</th>
                  <th>المنطقة</th>
                  <th>التفاصيل</th>
                  <th>المندوب</th>
                  <th>الموقع</th>
                  <th>تاريخ ووقت التسجيل</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map(e => (
                  <tr key={e.id}>
                    <td>
                      <span className={`badge ${e.kind === 'doctor' ? 'badge--blue' : 'badge--gray'}`}>
                        {e.kind === 'doctor' ? 'طبيب' : 'صيدلية'}
                      </span>
                    </td>
                    <td>{e.name}</td>
                    <td>{e.areaName}</td>
                    <td className="rfs-muted">{detailText(e)}</td>
                    <td>{e.userId === user?.id ? 'أنا' : (e.repName ?? '—')}</td>
                    <td>
                      <a href={mapsUrl(e.latitude, e.longitude)} target="_blank" rel="noreferrer">عرض</a>
                    </td>
                    <td className="rfs-muted">
                      {fmtDateTime(e.createdAt)}
                      {e.editedAt && <div>معدّل: {fmtDateTime(e.editedAt)}</div>}
                    </td>
                    <td className="rfs-actions-cell">
                      <button className="btn btn--secondary btn--sm" onClick={() => setViewing(e)}>تفاصيل</button>
                      {e.canEdit && (
                        <button className="btn btn--secondary btn--sm" onClick={() => openEdit(e)}>تعديل</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── نافذة التفاصيل (للقراءة) ── */}
      {viewing && (
        <div className="modal-overlay rfs-modal-overlay" onClick={() => setViewing(null)}>
          <div className="modal rfs-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>تفاصيل {viewing.kind === 'doctor' ? 'الطبيب' : 'الصيدلية'}</h2>
              <button className="modal-close" onClick={() => setViewing(null)}>✕</button>
            </div>
            <div className="modal-body">
              <dl className="rfs-details">
                <dt>الاسم</dt><dd>{viewing.name}</dd>
                <dt>النوع</dt><dd>{viewing.kind === 'doctor' ? 'طبيب' : 'صيدلية'}</dd>
                <dt>المنطقة</dt><dd>{viewing.areaName}</dd>
                <dt>المندوب</dt><dd>{viewing.repName ?? '—'}{repCompany.get(viewing.userId) ? ` · ${repCompany.get(viewing.userId)}` : ''}</dd>
                {viewing.kind === 'doctor' && <>
                  <dt>الاختصاص</dt><dd>{viewing.specialty || '—'}</dd>
                  <dt>الكلاس</dt><dd>{viewing.className || '—'}</dd>
                  <dt>الصيدليات القريبة</dt>
                  <dd>{viewing.nearPharmacies.length ? viewing.nearPharmacies.join('، ') : '—'}</dd>
                </>}
                <dt>الملاحظات</dt><dd>{viewing.notes || '—'}</dd>
                <dt>الموقع</dt>
                <dd>
                  {viewing.latitude.toFixed(6)}, {viewing.longitude.toFixed(6)}
                  {' · '}<a href={mapsUrl(viewing.latitude, viewing.longitude)} target="_blank" rel="noreferrer">عرض على الخارطة</a>
                </dd>
                <dt>دقة الموقع</dt><dd>{viewing.accuracy != null ? `±${Math.round(viewing.accuracy)} م` : '—'}</dd>
                <dt>تاريخ ووقت التسجيل</dt><dd>{fmtDateTime(viewing.createdAt)}</dd>
                <dt>آخر تعديل</dt>
                <dd>
                  {viewing.editedAt
                    ? `${fmtDateTime(viewing.editedAt)}${viewing.editedByName ? ` · بواسطة ${viewing.editedByName}` : ''}`
                    : 'لم يُعدَّل'}
                </dd>
              </dl>

              {viewing.kind === 'pharmacy' && (
                <div className="rfs-nearby-view">
                  <div className="form-label">الأطباء القريبون ({nearbyOf(viewing.id).length})</div>
                  {nearbyOf(viewing.id).length === 0 ? (
                    <div className="rfs-muted">لا يوجد أطباء مسجلون قرب هذه الصيدلية.</div>
                  ) : (
                    <ul className="rfs-nearby-list">
                      {nearbyOf(viewing.id).map(d => (
                        <li key={d.id}>
                          <strong>{d.name}</strong>
                          <span className="rfs-muted"> · {[d.specialty, d.className].filter(Boolean).join(' · ') || 'بدون اختصاص/كلاس'}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              {viewing.canEdit && (
                <button className="btn btn--secondary" onClick={() => { const e = viewing; setViewing(null); openEdit(e); }}>تعديل</button>
              )}
              <button className="btn btn--primary" onClick={() => setViewing(null)}>إغلاق</button>
            </div>
          </div>
        </div>
      )}

      {/* ── نافذة التعديل ── */}
      {editing && (
        <div className="modal-overlay rfs-modal-overlay" onClick={() => !editSaving && setEditing(null)}>
          <div className="modal rfs-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>تعديل {editing.kind === 'doctor' ? 'الطبيب' : 'الصيدلية'}</h2>
              <button className="modal-close" onClick={() => setEditing(null)} disabled={editSaving}>✕</button>
            </div>
            <div className="modal-body">
              {editing.userId !== user?.id && (
                <div className="alert rfs-notice">
                  هذا السجل مسجَّل لدى <strong>{editing.repName ?? 'زميل في مكتبك'}</strong> ضمن منطقة مشتركة معك — تعديلك يظهر للجميع باسمك.
                </div>
              )}
              {editing.kind === 'pharmacy' && (
                <div className="rfs-muted">تعديل الاسم أو المنطقة أو الموقع ينتقل إلى الأطباء المرتبطين بهذه الصيدلية بالاسم.</div>
              )}
              <div className="rfs-form-grid">
                <div className="form-group">
                  <label className="form-label">{editing.kind === 'doctor' ? 'اسم الطبيب' : 'اسم الصيدلية'} *</label>
                  <input className="form-input" list={editing.kind === 'doctor' ? 'rfs-doctor-names' : 'rfs-pharmacy-names'} value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">المنطقة *</label>
                  <input className="form-input" list="rfs-area-options" value={editForm.areaName} onChange={e => setEditForm({ ...editForm, areaName: e.target.value })} />
                </div>
                {editing.kind === 'doctor' && (
                  <>
                    <div className="form-group">
                      <label className="form-label">الاختصاص</label>
                      <input className="form-input" list="rfs-specialty-options" value={editForm.specialty} onChange={e => setEditForm({ ...editForm, specialty: e.target.value })} placeholder="اختر أو اكتب اختصاصاً جديداً" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">الكلاس</label>
                      <select className="form-input" value={editForm.className} onChange={e => setEditForm({ ...editForm, className: e.target.value })}>
                        <option value="">—</option>
                        {CLASS_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  </>
                )}
                <div className="form-group rfs-span-full">
                  <label className="form-label">ملاحظات</label>
                  <input className="form-input" value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} />
                </div>
              </div>

              {editing.kind === 'doctor' && (
                <div className="rfs-nearby">
                  <div className="form-label">الصيدليات القريبة</div>
                  <div style={{ marginTop: 8 }}>
                    <PharmacyFields value={editNear} onChange={setEditNear} placeholder="اسم الصيدلية القريبة" listId="rfs-pharmacy-names" />
                  </div>
                </div>
              )}

              {editing.kind === 'pharmacy' && (
                <div className="rfs-nearby">
                  <div className="rfs-nearby-head">
                    <div>
                      <div className="form-label">الأطباء القريبون ({nearbyOf(editing.id).length})</div>
                      <div className="rfs-muted">
                        {nearbyOf(editing.id).length ? nearbyOf(editing.id).map(d => d.name).join('، ') : 'لا يوجد أطباء مرتبطون بعد.'}
                      </div>
                      <div className="rfs-muted">الطبيب الجديد يُحفظ بموقع الصيدلية؛ والمسجَّل مسبقاً بنفس الاسم يُربط بها فقط.</div>
                    </div>
                    <button type="button" className="btn btn--secondary btn--sm" onClick={() => setEditAddDoctors([...editAddDoctors, { name: '', specialty: '', className: '' }])}>+ إضافة طبيب</button>
                  </div>
                  {editAddDoctors.map((d, i) => (
                    <div className="rfs-nearby-row" key={i}>
                      <input className="form-input" list="rfs-doctor-names" placeholder="اسم الطبيب" value={d.name}
                        onChange={e => setEditAddDoctors(editAddDoctors.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                      <input className="form-input" list="rfs-specialty-options" placeholder="الاختصاص" value={d.specialty}
                        onChange={e => setEditAddDoctors(editAddDoctors.map((x, j) => j === i ? { ...x, specialty: e.target.value } : x))} />
                      <select className="form-input" value={d.className}
                        onChange={e => setEditAddDoctors(editAddDoctors.map((x, j) => j === i ? { ...x, className: e.target.value } : x))}>
                        <option value="">كلاس</option>
                        {CLASS_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <button type="button" className="btn btn--secondary btn--sm" title="حذف" onClick={() => setEditAddDoctors(editAddDoctors.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              <div className={`rfs-location ${editLoc === 'error' ? 'rfs-location--err' : editCoords ? 'rfs-location--ok' : ''}`}>
                <div className="rfs-location-text">
                  {editLoc === 'loading' ? (
                    <>
                      <strong>جارٍ تحديد الموقع بدقة…</strong>
                      <div className="rfs-muted">الدقة الحالية: {editLiveAcc != null ? `±${Math.round(editLiveAcc)} م` : 'بانتظار الإشارة'}</div>
                    </>
                  ) : editCoords ? (
                    <>
                      <strong>✓ سيُحفظ الموقع الجديد</strong>
                      <div className="rfs-muted">دقة ±{Math.round(editCoords.accuracy)} م</div>
                    </>
                  ) : editLoc === 'error' ? (
                    <span>{editLocError}</span>
                  ) : (
                    <>
                      <span>الموقع الحالي محفوظ.</span>
                      <div className="rfs-muted">
                        <a href={mapsUrl(editing.latitude, editing.longitude)} target="_blank" rel="noreferrer">عرض على الخارطة</a>
                      </div>
                    </>
                  )}
                </div>
                <button className="btn btn--secondary btn--sm" onClick={captureEditLocation} disabled={editLoc === 'loading'}>
                  {editLoc === 'loading' ? 'جارٍ التحديد…' : '📍 إعادة تحديد الموقع'}
                </button>
              </div>

              {editError && <div className="alert alert--error">{editError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setEditing(null)} disabled={editSaving}>إلغاء</button>
              <button className="btn btn--primary" onClick={saveEdit} disabled={editSaving}>
                {editSaving ? 'جارٍ الحفظ…' : 'حفظ التعديل'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
