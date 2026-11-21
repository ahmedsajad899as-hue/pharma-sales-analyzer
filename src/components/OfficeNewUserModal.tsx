import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Modal, ErrBox, btnStyle } from '../pages/super-admin/OfficesPage';
import NewUserAssignments from '../pages/super-admin/NewUserAssignments';
import { Note } from '../pages/super-admin/AssignUI';

// ════════════════════════════════════════════════════════════════════════════
// «إضافة مستخدم» لإدارة المكتب (مدير/HR/موظف مكتب) — مندوب علمي أو مسوّق.
// نفس تبويبات نموذج السوبر أدمن (NewUserAssignments) لكن بيانات مكتب المُنشئ فقط،
// والحفظ طلب واحد إلى POST /api/company-members/new-user الذي يمرّر كل خطوة بمعالجات
// السوبر أدمن نفسها (server/modules/company-members/company-members.create.js).
// ════════════════════════════════════════════════════════════════════════════

type Kind = 'scientific' | 'marketer';
interface Named { id: number; name: string }
interface Manager {
  id: number; username: string; displayName?: string | null; role: string; officeId: number; isActive: boolean;
  isMarketer: boolean; companyIds: number[]; primaryCompanyId: number | null; itemIds: number[];
  companyAssignments: { isPrimary?: boolean; company?: { name: string } | null }[];
}
interface Options {
  office: Named | null;
  companies: (Named & { officeId: number })[];
  provinces: Named[];
  subProvinces: (Named & { provinceId: number })[];
  areas: (Named & { provinceId?: number | null; subProvinceId?: number | null })[];
  managers: Manager[];
  provinceLeaders: { provinceId: number; userId: number; name: string }[];
  marketerManagers: { userId: number; name: string; handlesProvinces: boolean }[];
  baghdadName: string;
}
interface Created { id: number; username: string; displayName: string; kind: Kind; areaCount: number }

const DEFAULT_PASSWORD = '123456789';
const ITEMS_URL = (ids: number[]) => `/api/company-members/new-user/company-items?companyIds=${ids.join(',')}`;
const managerName = (m: { displayName?: string | null; username: string }) => m.displayName || m.username;

const emptyForm = (officeId: number | null, kind: Kind = 'scientific') => ({
  kind, displayName: '', username: '', password: DEFAULT_PASSWORD, phone: '',
  officeId, provinceId: null as number | null,
  companyIds: [] as number[], primaryCompanyId: null as number | null, itemIds: [] as number[],
  areaIds: [] as number[], subProvinceIds: [] as number[], managerIds: [] as number[],
});

export default function OfficeNewUserModal({ token, onClose, onCreated }: {
  token: string | null; onClose: () => void; onCreated: () => void;
}) {
  const H = { Authorization: `Bearer ${token}` };
  const [opts, setOpts] = useState<Options | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [form, setForm] = useState<any>(() => emptyForm(null));
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    fetch('/api/company-members/new-user/options', { headers: H })
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'تعذّر تحميل بيانات المكتب');
        setOpts(j as Options);
        setForm((f: any) => ({ ...f, officeId: j.office?.id ?? null }));
      })
      .catch(e => setLoadErr(e.message || 'تعذّر تحميل بيانات المكتب'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kind: Kind = form.kind;
  const isMarketer = kind === 'marketer';
  const geo = useMemo(() => opts ? { areas: opts.areas, provinces: opts.provinces, subProvinces: opts.subProvinces } : undefined, [opts]);
  // المدير من نفس الجهة فقط: لا صلة بين المسوقين والعلميين.
  const managers = useMemo(() => (opts?.managers ?? [])
    .filter(m => m.isMarketer === isMarketer)
    .map(m => ({ ...m, displayName: m.displayName ?? undefined })), [opts, isMarketer]);
  const roleLabels = useMemo(() => [
    { value: 'company_manager', label: isMarketer ? 'مدير المسوقين' : 'مدير شركة' },
    { value: 'team_leader',     label: isMarketer ? 'قائد فريق المسوقين' : 'قائد فريق' },
    { value: 'supervisor',      label: 'مشرف' },
    { value: 'product_manager', label: 'مدير منتج' },
  ], [isMarketer]);

  const province = opts?.provinces.find(p => p.id === form.provinceId) ?? null;
  const isProvinceOutsideBaghdad = !!province && province.name !== opts?.baghdadName;
  const provinceLeader = province ? opts?.provinceLeaders.find(l => l.provinceId === province.id) ?? null : null;
  const provinceMarketerManagers = (opts?.marketerManagers ?? []).filter(m => m.handlesProvinces);

  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));
  const setKind = (k: Kind) => {
    if (k === kind) return;
    // المدراء يختلفون بين الجهتين؛ الشركات والايتمات والمناطق تبقى.
    set({ kind: k, managerIds: [] });
  };
  const setDisplayName = (v: string) => set(usernameTouched ? { displayName: v } : { displayName: v, username: v.replace(/\s+/g, ' ').trim() });

  // مسوّق محافظة (خارج بغداد): يتبع مدير مسوقي المحافظات — يُختار تلقائياً إن كان واحداً.
  useEffect(() => {
    if (!isMarketer || !isProvinceOutsideBaghdad || form.managerIds.length) return;
    if (provinceMarketerManagers.length === 1) set({ managerIds: [provinceMarketerManagers[0].userId] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMarketer, isProvinceOutsideBaghdad, form.provinceId]);

  const selectedManagers = managers.filter(m => form.managerIds.includes(m.id));
  const copyFromManager = async (m: Pick<Manager, 'companyIds' | 'itemIds' | 'primaryCompanyId'>) => {
    const officeIds = new Set((opts?.companies ?? []).map(c => c.id));
    const companyIds = m.companyIds.filter(id => officeIds.has(id));
    let itemIds = m.itemIds;
    setCopying(true);
    try {
      if (itemIds.length && companyIds.length) {
        const j = await fetch(ITEMS_URL(companyIds), { headers: H }).then(r => r.json());
        const valid = new Set<number>((j?.data ?? []).map((i: { id: number }) => i.id));
        itemIds = itemIds.filter(id => valid.has(id));
      } else itemIds = [];
    } catch { itemIds = []; }
    finally { setCopying(false); }
    set({
      companyIds, itemIds,
      primaryCompanyId: m.primaryCompanyId && companyIds.includes(m.primaryCompanyId) ? m.primaryCompanyId : companyIds[0] ?? null,
    });
  };

  const areaChosen = form.provinceId != null || form.subProvinceIds.length > 0 || form.areaIds.length > 0;
  const missing: string[] = [];
  if (!form.displayName.trim()) missing.push('الاسم');
  if (!form.username.trim()) missing.push('اسم الدخول');
  if (form.password.trim().length < 6) missing.push('كلمة مرور (6 أحرف على الأقل)');
  if (!form.companyIds.length) missing.push('شركة واحدة على الأقل');
  if (!areaChosen) missing.push('محافظة أو مناطق العمل');

  const save = async () => {
    if (missing.length) { setError(`أكمل: ${missing.join('، ')}`); return; }
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/company-members/new-user', {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind, displayName: form.displayName, username: form.username, password: form.password, phone: form.phone,
          provinceId: form.provinceId, companyIds: form.companyIds, primaryCompanyId: form.primaryCompanyId,
          itemIds: form.itemIds, areaIds: form.areaIds, subProvinceIds: form.subProvinceIds, managerIds: form.managerIds,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || 'تعذّر إنشاء الحساب'); return; }
      setCreated(j.data);
      onCreated();
    } catch {
      setError('تعذّر الاتصال بالخادم');
    } finally { setSaving(false); }
  };

  const again = () => {
    setCreated(null); setError(''); setUsernameTouched(false);
    setForm(emptyForm(opts?.office?.id ?? null, kind));
  };

  // ── بعد الإنشاء: بيانات الدخول لتسليمها للمندوب ────────────────────────────
  if (created) {
    return (
      <Modal onClose={onClose} title="تم إنشاء الحساب" maxWidth={460}>
        <div style={{ textAlign: 'center', fontSize: 40, marginBottom: 6 }}>✅</div>
        <div style={{ textAlign: 'center', fontWeight: 800, fontSize: 16, color: '#1e293b' }}>{created.displayName}</div>
        <div style={{ textAlign: 'center', fontSize: 12.5, color: '#64748b', marginTop: 4 }}>
          {created.kind === 'marketer' ? '🏪 مسوّق' : '🩺 مندوب علمي'} · 📍 {created.areaCount} منطقة
        </div>
        <div style={{ margin: '16px 0', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px', fontSize: 13.5, lineHeight: 2 }}>
          <div>اسم الدخول: <b style={{ userSelect: 'all' }}>{created.username}</b></div>
          <div>كلمة المرور: <b style={{ userSelect: 'all', fontFamily: 'monospace' }}>{form.password}</b></div>
        </div>
        <Note>الحساب ظاهر الآن عند السوبر أدمن وفي قوائم المكتب والتقارير. يبدأ بالصفحات الأساسية فقط، ويفعّل السوبر أدمن الباقي من «المميزات».</Note>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={again} style={btnStyle('#4f46e5', true)}>➕ إضافة آخر</button>
          <button onClick={onClose} style={btnStyle('#0f172a', true)}>إغلاق</button>
        </div>
      </Modal>
    );
  }

  const title = `إضافة مستخدم${opts?.office ? ` — ${opts.office.name}` : ''}`;
  if (!opts) {
    return (
      <Modal onClose={onClose} title={title}>
        {loadErr ? <ErrBox msg={loadErr} /> : <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>جاري التحميل...</div>}
      </Modal>
    );
  }

  const inp: CSSProperties = { width: '100%', padding: '8px 11px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13.5, boxSizing: 'border-box', fontFamily: 'inherit' };
  const lbl: CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 };
  const sec: CSSProperties = { fontSize: 11.5, fontWeight: 800, color: '#94a3b8', margin: '4px 0 8px', letterSpacing: 0.3 };
  const kindBtn = (k: Kind, icon: string, label: string, sub: string) => {
    const on = kind === k;
    return (
      <button type="button" onClick={() => setKind(k)} style={{
        flex: 1, padding: '9px 8px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
        border: `1.5px solid ${on ? '#4f46e5' : '#e2e8f0'}`, background: on ? '#eef2ff' : '#fff', color: on ? '#3730a3' : '#475569',
      }}>
        <div style={{ fontSize: 13.5, fontWeight: 800 }}>{icon} {label}</div>
        <div style={{ fontSize: 10.5, marginTop: 2, color: on ? '#6366f1' : '#94a3b8' }}>{sub}</div>
      </button>
    );
  };

  const footer = (
    <div style={{ paddingTop: 14, marginTop: 14, borderTop: '1px solid #e2e8f0' }}>
      {error && <ErrBox msg={error} />}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: missing.length ? '#b45309' : '#059669' }}>
          {missing.length ? `ناقص: ${missing.join('، ')}` : '✓ جاهز للحفظ'}
        </span>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={btnStyle('#6b7280', true)}>إلغاء</button>
          <button onClick={save} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? 'جاري الإنشاء...' : 'إنشاء الحساب'}</button>
        </div>
      </div>
    </div>
  );

  return (
    <Modal onClose={onClose} title={title} maxWidth={1040} footer={footer}>
      <div className="m-nu-layout" style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', gap: 22, height: 'min(calc(90vh - 170px), 620px)', minHeight: 360 }}>
        <form className="m-nu-col" autoComplete="off" onSubmit={e => e.preventDefault()} style={{ minHeight: 0, overflowY: 'auto', paddingInlineEnd: 4 }}>
          <div style={sec}>نوع الحساب</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {kindBtn('scientific', '🩺', 'مندوب علمي', 'أطباء وصيدليات · شركة رئيسية')}
            {kindBtn('marketer', '🏪', 'مسوّق', 'صيدليات فقط · للمكتب كله')}
          </div>

          <div style={sec}>الحساب</div>
          <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
            <div><label style={lbl}>الاسم *</label>
              <input style={inp} value={form.displayName} onChange={e => setDisplayName(e.target.value)} autoComplete="off" name="nu-display-name" placeholder="اسم المندوب كما يظهر في التقارير" /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div><label style={lbl}>اسم الدخول *</label>
                <input style={inp} value={form.username} onChange={e => { setUsernameTouched(true); set({ username: e.target.value }); }} autoComplete="off" name="nu-username" /></div>
              <div><label style={lbl}>كلمة المرور *</label>
                <input style={{ ...inp, fontFamily: 'monospace' }} value={form.password} onChange={e => set({ password: e.target.value })} autoComplete="new-password" name="nu-password" /></div>
            </div>
            <div><label style={lbl}>الهاتف</label>
              <input style={inp} value={form.phone} onChange={e => set({ phone: e.target.value })} autoComplete="off" name="nu-phone" placeholder="07xxxxxxxxx" /></div>
          </div>

          <div style={sec}>مكان العمل</div>
          <div style={{ marginBottom: 8 }}>
            <label style={lbl}>المحافظة</label>
            <select style={inp} value={form.provinceId ?? ''} onChange={e => set({ provinceId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">— بلا محافظة كاملة (مناطق محددة) —</option>
              {opts.provinces.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 11.5, color: '#0e7490', lineHeight: 1.7, marginBottom: 12 }}>
            {!province && 'اختر المناطق أو القسم (الكرخ / الرصافة) من تبويب «المناطق».'}
            {province && !isProvinceOutsideBaghdad && 'تُضاف كل مناطق بغداد. لقسم واحد (الكرخ أو الرصافة) اترك المحافظة فارغة واختر القسم من تبويب «المناطق».'}
            {isProvinceOutsideBaghdad && !isMarketer && (provinceLeader
              ? <>تُضاف كل مناطق {province!.name}، ويُسجَّل في فريقها ويُربط تلقائياً بقائدها <b>{provinceLeader.name}</b> مديراً له.</>
              : <>تُضاف كل مناطق {province!.name} ويُسجَّل في فريقها. الفريق بلا قائد حالياً.</>)}
            {isProvinceOutsideBaghdad && isMarketer && <>مسوّق محافظة: كل مناطق {province!.name}، ويتبع مدير مسوقي المحافظات{provinceMarketerManagers.length === 1 ? <> (<b>{provinceMarketerManagers[0].name}</b>)</> : ''}. لا يدخل فريق العلميين.</>}
          </div>

          {selectedManagers.length > 0 && (
            <>
              <div style={sec}>نسخ من المدير</div>
              <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
                {selectedManagers.map(m => (
                  <button key={m.id} type="button" disabled={copying || !m.companyIds.length} onClick={() => copyFromManager(m)}
                    title="تعبئة الشركات والايتمات بنفس شركات وايتمات هذا المدير (يمكن تعديلها بعدها)"
                    style={{ ...btnStyle('#4f46e5', true), width: '100%', whiteSpace: 'normal', opacity: m.companyIds.length ? 1 : 0.5 }}>
                    {copying ? '...' : `📋 شركات وايتمات ${managerName(m)}`}
                  </button>
                ))}
              </div>
            </>
          )}
        </form>

        <div className="m-nu-col" style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={sec}>الشركات والايتمات والمناطق والمدير</div>
          <NewUserAssignments
            form={form} setForm={setForm} role="scientific_rep"
            companies={opts.companies} offices={opts.office ? [opts.office] : []}
            users={managers} roles={roleLabels} token={token ?? undefined}
            isOfficeRole={false} isMarketer={isMarketer}
            geo={geo} companyItemsUrl={ITEMS_URL} hideSubs />
        </div>
      </div>
    </Modal>
  );
}
