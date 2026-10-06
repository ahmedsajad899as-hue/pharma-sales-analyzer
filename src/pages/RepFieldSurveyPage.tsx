import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';

// ════════════════════════════════════════════════════════════════════════════
// سيرفي المندوب العلمي الميداني
// — المندوب: يسجّل أطباء وصيدليات منطقته، وموقع كل اسم إلزامي (يُلتقط لحظة التسجيل).
// — مدير الشركة: يرى سجلات مندوبيه للاطلاع والتصدير فقط.
// أرشيف توثيقي؛ لا يرتبط بالمبيعات أو الزيارات. أطباء الصيدليات القريبون
// يُنشرون في سيرفي الأطباء الرئيسي (يحدده الخادم).
// ════════════════════════════════════════════════════════════════════════════

type Kind = 'doctor' | 'pharmacy';

interface Entry {
  id: number;
  userId: number;
  repName: string | null;
  kind: Kind;
  name: string;
  specialty: string | null;
  className: string | null;
  pharmacyName: string | null;
  areaName: string;
  notes: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  parentId: number | null;
  parentName: string | null;
  publishedToDoctorSurvey: boolean;
  createdAt: string;
  editedAt: string | null;
}

interface RepOption { userId: number; name: string; company: string | null }
interface NearbyRow { name: string; specialty: string; className: string }
interface Coords { latitude: number; longitude: number; accuracy: number | null }
interface SaveNotice { kind: Kind; name: string; nearbyCount?: number; publish?: { hostSurvey: boolean; published: number; linkedExisting: number; failed: number } }

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('ar-IQ', {
    timeZone: 'Asia/Baghdad', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

const normArea = (s: string) => s.trim().replace(/\s+/g, ' ');

const EMPTY_FORM = { name: '', specialty: '', className: '', pharmacyName: '', areaName: '', notes: '' };

export default function RepFieldSurveyPage() {
  const { user, token } = useAuth();
  const isRep = user?.role === 'scientific_rep';
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  // ── بيانات ─────────────────────────────────────────────────────────────
  const [entries, setEntries]   = useState<Entry[]>([]);
  const [reps, setReps]         = useState<RepOption[]>([]);
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');
  const [repFilter, setRepFilter] = useState<number | ''>('');
  const [kindFilter, setKindFilter] = useState<'all' | Kind>('all');
  const [search, setSearch]     = useState('');

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
      return [e.name, e.areaName, e.pharmacyName, e.parentName, e.specialty, e.repName]
        .some(v => (v ?? '').toLowerCase().includes(q));
    });
  }, [entries, kindFilter, search]);

  // ── نموذج التسجيل (للمندوب فقط) ────────────────────────────────────────
  const [kind, setKind]         = useState<Kind>('doctor');
  const [form, setForm]         = useState(EMPTY_FORM);
  const [nearby, setNearby]     = useState<NearbyRow[]>([]);
  const [coords, setCoords]     = useState<Coords | null>(null);
  const [locState, setLocState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [locError, setLocError] = useState('');
  const [saving, setSaving]     = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice]     = useState<SaveNotice | null>(null);

  const setField = (k: keyof typeof EMPTY_FORM, v: string) => setForm(f => ({ ...f, [k]: v }));

  const switchKind = (k: Kind) => {
    setKind(k);
    setForm(f => ({ ...EMPTY_FORM, areaName: f.areaName }));
    setNearby([]);
    setCoords(null);
    setLocState('idle');
    setLocError('');
    setFormError('');
    setNotice(null);
  };

  const captureLocation = () => {
    if (!navigator.geolocation) {
      setLocState('error');
      setLocError('المتصفح لا يدعم تحديد الموقع.');
      return;
    }
    setLocState('loading');
    setLocError('');
    navigator.geolocation.getCurrentPosition(
      p => {
        setCoords({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? null });
        setLocState('idle');
      },
      err => {
        setLocState('error');
        setLocError(err.code === 1
          ? 'تم رفض إذن الموقع. فعّله من إعدادات المتصفح ثم أعد المحاولة.'
          : 'تعذّر تحديد الموقع. تأكد من تفعيل GPS وحاول في مكان مفتوح.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const resetAfterSave = () => {
    setForm(f => ({ ...EMPTY_FORM, areaName: f.areaName }));
    setNearby([]);
    setCoords(null);
    setLocState('idle');
    setLocError('');
  };

  const submit = async () => {
    setFormError('');
    setNotice(null);
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

    setSaving(true);
    try {
      const body = kind === 'doctor'
        ? { ...base, specialty: form.specialty.trim() || null, className: form.className.trim() || null, pharmacyName: form.pharmacyName.trim() || null }
        : { ...base, doctors: nearby.filter(d => d.name.trim()) };
      const r = await fetch(kind === 'doctor' ? '/api/rep-field-survey/doctors' : '/api/rep-field-survey/pharmacies', {
        method: 'POST', headers: H(), body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.message || 'تعذّر الحفظ.');

      setNotice({
        kind,
        name: base.name,
        nearbyCount: j.data.nearbyCount,
        publish: j.data.publish,
      });
      resetAfterSave();
      load();
    } catch (e: any) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── تفاصيل سجل (للجميع، للقراءة) ──────────────────────────────────────
  const [viewing, setViewing] = useState<Entry | null>(null);
  const repCompany = useMemo(() => new Map(reps.map(r => [r.userId, r.company])), [reps]);
  const nearbyOf = (pharmacyId: number) => entries.filter(x => x.parentId === pharmacyId);

  // ── تعديل سجل (المندوب على سجلاته فقط) ──────────────────────────────────
  const [editing, setEditing]   = useState<Entry | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editCoords, setEditCoords] = useState<Coords | null>(null); // null = يبقى الموقع الحالي
  const [editLoc, setEditLoc]   = useState<'idle' | 'loading' | 'error'>('idle');
  const [editLocError, setEditLocError] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError]   = useState('');

  const openEdit = (e: Entry) => {
    setEditing(e);
    setEditForm({
      name: e.name,
      specialty: e.specialty ?? '',
      className: e.className ?? '',
      pharmacyName: e.pharmacyName ?? '',
      areaName: e.areaName,
      notes: e.notes ?? '',
    });
    setEditCoords(null);
    setEditLoc('idle');
    setEditLocError('');
    setEditError('');
  };

  const captureEditLocation = () => {
    if (!navigator.geolocation) {
      setEditLoc('error');
      setEditLocError('المتصفح لا يدعم تحديد الموقع.');
      return;
    }
    setEditLoc('loading');
    setEditLocError('');
    navigator.geolocation.getCurrentPosition(
      p => {
        setEditCoords({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? null });
        setEditLoc('idle');
      },
      err => {
        setEditLoc('error');
        setEditLocError(err.code === 1
          ? 'تم رفض إذن الموقع. فعّله من إعدادات المتصفح ثم أعد المحاولة.'
          : 'تعذّر تحديد الموقع. تأكد من تفعيل GPS وحاول في مكان مفتوح.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
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
      if (!editing.parentId) body.pharmacyName = editForm.pharmacyName.trim() || null;
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
      'الصيدلية / العيادة': e.pharmacyName ?? '',
      'ضمن صيدلية': e.parentName ?? '',
      'المنطقة': e.areaName,
      'المندوب': e.repName ?? '',
      'خط العرض': e.latitude,
      'خط الطول': e.longitude,
      'الدقة (م)': e.accuracy != null ? Math.round(e.accuracy) : '',
      'رابط الخريطة': mapsUrl(e.latitude, e.longitude),
      'تاريخ ووقت التسجيل': fmtDateTime(e.createdAt),
      'منشور في سيرفي الأطباء': e.publishedToDoctorSurvey ? 'نعم' : 'لا',
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

  return (
    <div className="page rfs-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">سيرفي المندوب العلمي</h1>
          <div className="page-subtitle">
            {isRep
              ? 'سجّل الأطباء والصيدليات في مناطقك، مع تحديد موقع كل اسم على الخارطة.'
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
              {notice.kind === 'pharmacy' && (
                <div className="rfs-muted">
                  {notice.nearbyCount ? `مع ${notice.nearbyCount} طبيب قريب` : 'بدون أطباء قريبين'}
                  {notice.publish && (
                    notice.publish.hostSurvey
                      ? ` · نُشر ${notice.publish.published} طبيب في سيرفي الأطباء${notice.publish.linkedExisting ? ` (${notice.publish.linkedExisting} موجودون مسبقاً)` : ''}`
                      : ' · لا يوجد سيرفي أطباء نشط — حُفظ في الأرشيف فقط'
                  )}
                  {notice.publish && notice.publish.failed > 0 && ` · تعذّر نشر ${notice.publish.failed}`}
                </div>
              )}
            </div>
          )}

          <div className="rfs-form-grid">
            <div className="form-group">
              <label className="form-label">{nameLabel} *</label>
              <input className="form-input" value={form.name} onChange={e => setField('name', e.target.value)} placeholder={kind === 'doctor' ? 'مثال: د. أحمد علي' : 'مثال: صيدلية الأمل'} />
            </div>
            <div className="form-group">
              <label className="form-label">المنطقة *</label>
              <input className="form-input" list="rfs-area-options" value={form.areaName} onChange={e => setField('areaName', e.target.value)} placeholder="اختر أو اكتب اسم المنطقة" />
              <datalist id="rfs-area-options">
                {areaOptions.map(a => <option key={a} value={a} />)}
              </datalist>
            </div>
            {kind === 'doctor' && (
              <>
                <div className="form-group">
                  <label className="form-label">الاختصاص</label>
                  <input className="form-input" value={form.specialty} onChange={e => setField('specialty', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">الكلاس</label>
                  <input className="form-input" value={form.className} onChange={e => setField('className', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">اسم الصيدلية / العيادة</label>
                  <input className="form-input" value={form.pharmacyName} onChange={e => setField('pharmacyName', e.target.value)} />
                </div>
              </>
            )}
            <div className="form-group rfs-span-full">
              <label className="form-label">ملاحظات</label>
              <input className="form-input" value={form.notes} onChange={e => setField('notes', e.target.value)} />
            </div>
          </div>

          {kind === 'pharmacy' && (
            <div className="rfs-nearby">
              <div className="rfs-nearby-head">
                <div>
                  <div className="form-label">الأطباء القريبون من الصيدلية</div>
                  <div className="rfs-muted">يُحفظون كأطباء في سيرفي الأطباء أيضاً، بنفس موقع الصيدلية.</div>
                </div>
                <button className="btn btn--secondary btn--sm" onClick={() => setNearby([...nearby, { name: '', specialty: '', className: '' }])}>+ إضافة طبيب</button>
              </div>
              {nearby.map((d, i) => (
                <div className="rfs-nearby-row" key={i}>
                  <input className="form-input" placeholder="اسم الطبيب" value={d.name}
                    onChange={e => setNearby(nearby.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                  <input className="form-input" placeholder="الاختصاص" value={d.specialty}
                    onChange={e => setNearby(nearby.map((x, j) => j === i ? { ...x, specialty: e.target.value } : x))} />
                  <input className="form-input" placeholder="الكلاس" value={d.className}
                    onChange={e => setNearby(nearby.map((x, j) => j === i ? { ...x, className: e.target.value } : x))} />
                  <button className="btn btn--secondary btn--sm" title="حذف" onClick={() => setNearby(nearby.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
            </div>
          )}

          {/* ── الموقع (إلزامي) ── */}
          <div className={`rfs-location ${coords ? 'rfs-location--ok' : locState === 'error' ? 'rfs-location--err' : ''}`}>
            <div className="rfs-location-text">
              {coords ? (
                <>
                  <strong>✓ تم تحديد الموقع</strong>
                  <div className="rfs-muted">
                    دقة ±{coords.accuracy != null ? Math.round(coords.accuracy) : '?'} م ·{' '}
                    <a href={mapsUrl(coords.latitude, coords.longitude)} target="_blank" rel="noreferrer">عرض على الخارطة</a>
                  </div>
                </>
              ) : locState === 'error' ? (
                <span>{locError}</span>
              ) : (
                <span className="rfs-muted">الموقع إلزامي — سيُلتقط من جهازك لحظة الحفظ على هذا الاسم.</span>
              )}
            </div>
            <button className="btn btn--secondary btn--sm" onClick={captureLocation} disabled={locState === 'loading'}>
              {locState === 'loading' ? 'جارٍ التحديد…' : coords ? 'إعادة تحديد الموقع' : '📍 تحديد الموقع'}
            </button>
          </div>

          {formError && <div className="alert alert--error">{formError}</div>}

          <div className="rfs-submit">
            <button className="btn btn--primary" onClick={submit} disabled={saving || !coords}>
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
            {!isRep && (
              <select className="form-input" value={repFilter} onChange={e => setRepFilter(e.target.value ? Number(e.target.value) : '')}>
                <option value="">كل المندوبين</option>
                {reps.map(r => (
                  <option key={r.userId} value={r.userId}>{r.name}{r.company ? ` — ${r.company}` : ''}</option>
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
            <input className="form-input" placeholder="بحث بالاسم أو المنطقة…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        {loading ? (
          <div className="empty-row">جارٍ التحميل…</div>
        ) : visible.length === 0 ? (
          <div className="empty-row">{entries.length ? 'لا توجد نتائج مطابقة.' : 'لم يتم تسجيل أي اسم بعد.'}</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>النوع</th>
                  <th>الاسم</th>
                  <th>المنطقة</th>
                  <th>التفاصيل</th>
                  {!isRep && <th>المندوب</th>}
                  <th>الموقع</th>
                  <th>تاريخ ووقت التسجيل</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map(e => (
                  <tr key={e.id} className={e.parentId ? 'rfs-child-row' : ''}>
                    <td>
                      <span className={`badge ${e.kind === 'doctor' ? 'badge--blue' : 'badge--gray'}`}>
                        {e.kind === 'doctor' ? 'طبيب' : 'صيدلية'}
                      </span>
                    </td>
                    <td>
                      {e.parentId && <span className="rfs-muted">↳ </span>}
                      {e.name}
                    </td>
                    <td>{e.areaName}</td>
                    <td className="rfs-muted">
                      {e.parentName
                        ? `ضمن: ${e.parentName}${e.specialty ? ` · ${e.specialty}` : ''}`
                        : e.kind === 'doctor'
                          ? [e.specialty, e.className, e.pharmacyName].filter(Boolean).join(' · ') || '—'
                          : e.notes || '—'}
                    </td>
                    {!isRep && <td>{e.repName ?? '—'}</td>}
                    <td>
                      <a href={mapsUrl(e.latitude, e.longitude)} target="_blank" rel="noreferrer">عرض</a>
                    </td>
                    <td className="rfs-muted">
                      {fmtDateTime(e.createdAt)}
                      {e.editedAt && <div>معدّل: {fmtDateTime(e.editedAt)}</div>}
                    </td>
                    <td className="rfs-actions-cell">
                      <button className="btn btn--secondary btn--sm" onClick={() => setViewing(e)}>تفاصيل</button>
                      {e.userId === user?.id && (
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

      {viewing && (
        <div className="modal-overlay" onClick={() => setViewing(null)}>
          <div className="modal rfs-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>تفاصيل {viewing.kind === 'doctor' ? 'الطبيب' : 'الصيدلية'}</h2>
              <button className="modal-close" onClick={() => setViewing(null)}>✕</button>
            </div>
            <div className="modal-body">
              <dl className="rfs-details">
                <dt>الاسم</dt><dd>{viewing.name}</dd>
                <dt>النوع</dt><dd>{viewing.kind === 'doctor' ? 'طبيب' : 'صيدلية'}{viewing.parentName ? ` · ضمن: ${viewing.parentName}` : ''}</dd>
                <dt>المنطقة</dt><dd>{viewing.areaName}</dd>
                <dt>المندوب</dt><dd>{viewing.repName ?? '—'}{repCompany.get(viewing.userId) ? ` · ${repCompany.get(viewing.userId)}` : ''}</dd>
                {viewing.kind === 'doctor' && <>
                  <dt>الاختصاص</dt><dd>{viewing.specialty || '—'}</dd>
                  <dt>الكلاس</dt><dd>{viewing.className || '—'}</dd>
                  <dt>الصيدلية / العيادة</dt><dd>{viewing.pharmacyName || '—'}</dd>
                </>}
                <dt>الملاحظات</dt><dd>{viewing.notes || '—'}</dd>
                <dt>الموقع</dt>
                <dd>
                  {viewing.latitude.toFixed(6)}, {viewing.longitude.toFixed(6)}
                  {' · '}<a href={mapsUrl(viewing.latitude, viewing.longitude)} target="_blank" rel="noreferrer">عرض على الخارطة</a>
                </dd>
                <dt>دقة الموقع</dt><dd>{viewing.accuracy != null ? `±${Math.round(viewing.accuracy)} م` : '—'}</dd>
                <dt>تاريخ ووقت التسجيل</dt><dd>{fmtDateTime(viewing.createdAt)}</dd>
                <dt>آخر تعديل</dt><dd>{viewing.editedAt ? fmtDateTime(viewing.editedAt) : 'لم يُعدَّل'}</dd>
                <dt>سيرفي الأطباء الرئيسي</dt><dd>{viewing.publishedToDoctorSurvey ? 'منشور' : 'أرشيف فقط'}</dd>
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
                          {d.publishedToDoctorSurvey && <span className="badge badge--blue rfs-mini-badge">سيرفي الأطباء</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              {viewing.userId === user?.id && (
                <button className="btn btn--secondary" onClick={() => { const e = viewing; setViewing(null); openEdit(e); }}>تعديل</button>
              )}
              <button className="btn btn--primary" onClick={() => setViewing(null)}>إغلاق</button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-overlay" onClick={() => !editSaving && setEditing(null)}>
          <div className="modal rfs-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>تعديل {editing.kind === 'doctor' ? 'الطبيب' : 'الصيدلية'}</h2>
              <button className="modal-close" onClick={() => setEditing(null)} disabled={editSaving}>✕</button>
            </div>
            <div className="modal-body">
              {editing.publishedToDoctorSurvey && (
                <div className="rfs-muted">هذا الاسم منشور في سيرفي الأطباء الرئيسي؛ التعديل هنا لا يغيّر السيرفي الرئيسي.</div>
              )}
              {editing.kind === 'pharmacy' && (
                <div className="rfs-muted">تعديل الاسم أو المنطقة أو الموقع ينتقل إلى الأطباء القريبين الذين يرثون بيانات هذه الصيدلية.</div>
              )}
              <div className="rfs-form-grid">
                <div className="form-group">
                  <label className="form-label">{editing.kind === 'doctor' ? 'اسم الطبيب' : 'اسم الصيدلية'} *</label>
                  <input className="form-input" value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">المنطقة *</label>
                  <input className="form-input" list="rfs-area-options" value={editForm.areaName} onChange={e => setEditForm({ ...editForm, areaName: e.target.value })} />
                </div>
                {editing.kind === 'doctor' && (
                  <>
                    <div className="form-group">
                      <label className="form-label">الاختصاص</label>
                      <input className="form-input" value={editForm.specialty} onChange={e => setEditForm({ ...editForm, specialty: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">الكلاس</label>
                      <input className="form-input" value={editForm.className} onChange={e => setEditForm({ ...editForm, className: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">اسم الصيدلية / العيادة</label>
                      <input className="form-input" value={editForm.pharmacyName} disabled={!!editing.parentId}
                        onChange={e => setEditForm({ ...editForm, pharmacyName: e.target.value })} />
                      {editing.parentId && <span className="rfs-muted">يتبع الصيدلية الأم</span>}
                    </div>
                  </>
                )}
                <div className="form-group rfs-span-full">
                  <label className="form-label">ملاحظات</label>
                  <input className="form-input" value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} />
                </div>
              </div>

              <div className={`rfs-location ${editLoc === 'error' ? 'rfs-location--err' : editCoords ? 'rfs-location--ok' : ''}`}>
                <div className="rfs-location-text">
                  {editCoords ? (
                    <>
                      <strong>✓ سيُحفظ الموقع الجديد</strong>
                      <div className="rfs-muted">دقة ±{editCoords.accuracy != null ? Math.round(editCoords.accuracy) : '?'} م</div>
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
