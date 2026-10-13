// «الجهد الشخصي»: إدخال ما باعه المندوب بنفسه + طابور اعتماد التيم ليدر.
// المندوب يُدخل لنفسه (أو عبر البوت بكلمة «مبيعي»)، والقائد يعتمد أو يرفض،
// ويحدّد المندوب لصفوف البوت التي لم يُعرف مرسِلها. المعتمد وحده يُحتسب.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Check, X, Send, Smartphone, Warehouse, Building2, RotateCcw } from 'lucide-react';
import { api, jsonBody } from './api';
import type { CatalogItem, PersonalSale, Team, Viewer } from './types';
import { fmtDate, fmtInt, type Money } from './format';

type StatusFilter = 'pending' | 'approved' | 'rejected' | 'all';

interface Props {
  token: string | null;
  viewer: Viewer;
  teams: Team[];
  month: string;
  money: Money;
  teamFilter: number | null;
  onTeamFilter: (id: number | null) => void;
  onChanged: () => void;
}

const STATUS_LABEL: Record<PersonalSale['status'], string> = { pending: 'بانتظار الاعتماد', approved: 'معتمد', rejected: 'مرفوض' };
const SOURCE_LABEL: Record<string, string> = { app: 'التطبيق', telegram: 'تلكرام', viber: 'فايبر', whatsapp: 'واتساب' };

export default function PersonalTab({ token, viewer, teams, month, money, teamFilter, onTeamFilter, onChanged }: Props) {
  const reviewTeams = teams.filter(t => t.canReview);
  const isReviewer = reviewTeams.length > 0;
  const [status, setStatus] = useState<StatusFilter>(isReviewer ? 'pending' : 'all');
  const [rows, setRows] = useState<PersonalSale[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  // من يُدخَل باسمه: المندوب لنفسه، والقائد/الإدارة لمندوبي فرقهم.
  const enterableReps = useMemo(() => {
    const m = new Map<number, string>();
    if (viewer.mode === 'rep' || teams.some(t => t.reps.some(r => r.repUserId === viewer.id))) m.set(viewer.id, `${viewer.name} (أنا)`);
    for (const t of reviewTeams) for (const r of t.reps) if (!m.has(r.repUserId)) m.set(r.repUserId, r.repName);
    return [...m].map(([id, name]) => ({ id, name }));
  }, [teams, reviewTeams, viewer]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setErr(null);
    const q = new URLSearchParams();
    if (status !== 'all') q.set('status', status);
    if (month) q.set('month', month);
    if (teamFilter) q.set('teamId', String(teamFilter));
    try {
      const r = await api<{ rows: PersonalSale[] }>(token, `/personal-sales?${q}`);
      setRows(r.rows); setSelected(new Set());
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [token, status, month, teamFilter]);

  useEffect(() => { load(); }, [load]);

  const refreshAll = () => { load(); onChanged(); };

  const review = async (ids: number[], action: 'approve' | 'reject' | 'reopen') => {
    let reason: string | null = null;
    if (action === 'reject') {
      reason = window.prompt('سبب الرفض (اختياري):') ?? null;
      if (reason === null && !window.confirm('رفض بلا سبب؟')) return;
    }
    setBusy(true);
    try {
      const r = await api<{ updated: number; skipped: { noRep: number; forbidden: number } }>(token, '/personal-sales/review', { method: 'POST', ...jsonBody({ ids, action, reason }) });
      if (r.skipped?.noRep) alert(`${r.skipped.noRep} سطر بلا مندوب لم يُعتمد — حدّد المندوب أولاً.`);
      refreshAll();
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  const remove = async (id: number) => {
    if (!window.confirm('حذف هذا السطر نهائياً؟')) return;
    try { await api(token, `/personal-sales/${id}`, { method: 'DELETE' }); refreshAll(); } catch (e: any) { alert(e.message); }
  };

  const assignRep = async (row: PersonalSale, repUserId: number) => {
    try { await api(token, `/personal-sales/${row.id}`, { method: 'PATCH', ...jsonBody({ repUserId }) }); load(); } catch (e: any) { alert(e.message); }
  };

  const pendingReviewable = rows.filter(r => r.status === 'pending' && r.canReview);
  const allChecked = pendingReviewable.length > 0 && pendingReviewable.every(r => selected.has(r.id));
  const toggle = (id: number) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="pt-note">
        <span>💡</span>
        <span>
          الجهد الشخصي = ما باعه المندوب <strong>بنفسه</strong> للصيدليات (من مذخر أو من المكتب). هو مؤشّر بجانب تغطية المحافظة
          و<strong>لا يُجمع معها</strong>، لأن نفس الطلبية قد تظهر لاحقاً في ملف المكتب. يُحتسب بعد اعتماد التيم ليدر فقط.
          من البوت: ابدأ الرسالة بكلمة <strong>«مبيعي»</strong> ثم الصيدلية والأصناف، أو أرسل صورة الفاتورة مع «مبيعي».
        </span>
      </div>

      <div className="pt-toolbar">
        <div className="pt-segment" role="group" aria-label="الحالة">
          {(['pending', 'approved', 'rejected', 'all'] as StatusFilter[]).map(s => (
            <button key={s} className={status === s ? 'is-active' : ''} onClick={() => setStatus(s)}>
              {s === 'all' ? 'الكل' : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        {teams.length > 1 && (
          <select className="form-input" style={{ width: 'auto', minWidth: 160 }} value={teamFilter ?? ''} onChange={e => onTeamFilter(e.target.value ? Number(e.target.value) : null)}>
            <option value="">كل المحافظات</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.provinceName}</option>)}
          </select>
        )}
        <span className="pt-toolbar__spacer" />
        {status !== 'pending' && <span className="pt-toolbar__meta">«بانتظار الاعتماد» يُعرض كاملاً بلا قيد شهر</span>}
        {enterableReps.length > 0 && (
          <button className="btn btn--primary btn--sm" onClick={() => setShowForm(v => !v)}>
            <Plus size={14} /> {showForm ? 'إغلاق النموذج' : 'إدخال مبيع شخصي'}
          </button>
        )}
      </div>

      {showForm && (
        <EntryForm token={token} reps={enterableReps} defaultRep={viewer.mode === 'rep' ? viewer.id : (enterableReps[0]?.id ?? null)}
          money={money} onSaved={() => { setShowForm(false); refreshAll(); }} />
      )}

      {err && <div className="pt-note pt-note--warn">⚠️ {err}</div>}

      <div className="pt-panel">
        <div className="pt-panel__head">
          <div className="pt-panel__title">السجل {loading && <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--c-text-muted)' }}>— جارٍ التحميل…</span>}</div>
          <span style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{fmtInt(rows.length)} سطر</span>
        </div>
        {rows.length === 0 && !loading ? (
          <div className="pt-empty">
            <div className="pt-empty__title">{status === 'pending' ? 'لا شيء بانتظار الاعتماد' : 'لا سجلات في هذا الشهر'}</div>
          </div>
        ) : (
          <div className="pt-scroll">
            <table className="pt-table">
              <thead>
                <tr>
                  {isReviewer && (
                    <th style={{ width: 34 }}>
                      <input type="checkbox" checked={allChecked} disabled={!pendingReviewable.length}
                        onChange={() => setSelected(allChecked ? new Set() : new Set(pendingReviewable.map(r => r.id)))} aria-label="تحديد الكل" />
                    </th>
                  )}
                  <th>التاريخ</th>
                  <th>المندوب</th>
                  <th>الصيدلية</th>
                  <th>الصنف</th>
                  <th className="num">الكمية</th>
                  <th className="num">القيمة</th>
                  <th>المصدر</th>
                  <th>الحالة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    {isReviewer && (
                      <td>{r.status === 'pending' && r.canReview && <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />}</td>
                    )}
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.saleDate)}</td>
                    <td>
                      {r.repName ?? (r.canReview ? (
                        <RepPicker team={teams.find(t => t.id === r.teamId) ?? null} teams={reviewTeams} onPick={id => assignRep(r, id)} />
                      ) : <span className="pt-chip pt-chip--red">غير محدّد</span>)}
                      {r.senderName && !r.repName && <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>المرسِل: {r.senderName}</div>}
                      {r.provinceName && <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{r.provinceName}</div>}
                    </td>
                    <td>
                      <div>{r.pharmacyName}</div>
                      <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>
                        {r.channel === 'warehouse'
                          ? <><Warehouse size={11} style={{ verticalAlign: -1 }} /> {r.warehouseName ? `مذخر ${r.warehouseName}` : 'من مذخر'}</>
                          : <><Building2 size={11} style={{ verticalAlign: -1 }} /> من المكتب</>}
                        {r.areaName ? ` · ${r.areaName}` : ''}
                      </div>
                    </td>
                    <td>
                      {r.itemName}
                      {!r.itemId && <span className="pt-chip pt-chip--red" style={{ marginRight: 6 }}>غير مطابَق</span>}
                      {r.companyName && <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{r.companyName}</div>}
                    </td>
                    <td className="num">{fmtInt(r.quantity)}{r.bonusQty ? ` +${fmtInt(r.bonusQty)}` : ''}</td>
                    <td className="num">{r.totalValue ? money.native(r.totalValue, r.currency) : '—'}</td>
                    <td>
                      <span className="pt-chip">
                        {r.entrySource === 'app' ? <Smartphone size={11} style={{ verticalAlign: -1 }} /> : <Send size={11} style={{ verticalAlign: -1 }} />} {SOURCE_LABEL[r.entrySource] ?? r.entrySource}
                      </span>
                    </td>
                    <td>
                      <span className={`pt-status pt-status--${r.status}`}>{STATUS_LABEL[r.status]}</span>
                      {r.status === 'rejected' && r.rejectReason && <div style={{ fontSize: 11, color: 'var(--c-danger)' }}>{r.rejectReason}</div>}
                      {r.reviewedBy && r.status !== 'pending' && <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{r.reviewedBy}</div>}
                    </td>
                    <td>
                      <div className="pt-actions" style={{ flexWrap: 'nowrap' }}>
                        {r.canReview && r.status === 'pending' && (
                          <>
                            <button className="pt-icon-btn" style={{ color: 'var(--c-success)' }} title="اعتماد" disabled={busy || !r.repUserId} onClick={() => review([r.id], 'approve')}><Check size={15} /></button>
                            <button className="pt-icon-btn" title="رفض" disabled={busy} onClick={() => review([r.id], 'reject')}><X size={15} /></button>
                          </>
                        )}
                        {r.canReview && r.status !== 'pending' && (
                          <button className="pt-icon-btn" title="إرجاع للمراجعة" disabled={busy} onClick={() => review([r.id], 'reopen')}><RotateCcw size={14} /></button>
                        )}
                        {(r.canEdit || r.canReview) && (
                          <button className="pt-icon-btn" title="حذف" onClick={() => remove(r.id)}><Trash2 size={14} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="pt-bulkbar">
          <span>{selected.size} سطر محدّد</span>
          <span className="pt-toolbar__spacer" />
          <button className="btn btn--success btn--sm" disabled={busy} onClick={() => review([...selected], 'approve')}><Check size={14} /> اعتماد</button>
          <button className="btn btn--secondary btn--sm" disabled={busy} onClick={() => review([...selected], 'reject')}><X size={14} /> رفض</button>
          <button className="btn btn--secondary btn--sm" onClick={() => setSelected(new Set())}>إلغاء التحديد</button>
        </div>
      )}
    </div>
  );
}

function RepPicker({ team, teams, onPick }: { team: Team | null; teams: Team[]; onPick: (id: number) => void }) {
  const reps = useMemo(() => {
    const src = team ? [team] : teams;
    const m = new Map<number, string>();
    for (const t of src) for (const r of t.reps) m.set(r.repUserId, r.repName);
    return [...m];
  }, [team, teams]);
  return (
    <select className="form-input" style={{ padding: '4px 8px', fontSize: 12, width: 'auto' }} defaultValue=""
      onChange={e => e.target.value && onPick(Number(e.target.value))}>
      <option value="" disabled>حدّد المندوب…</option>
      {reps.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select>
  );
}

// ─── نموذج الإدخال ───────────────────────────────────────────────────────────

interface Line { key: number; itemId: number | ''; quantity: string; bonusQty: string; unitPrice: string }
const newLine = (): Line => ({ key: Date.now() + Math.random(), itemId: '', quantity: '', bonusQty: '', unitPrice: '' });
const today = () => new Date().toISOString().slice(0, 10);

function EntryForm({ token, reps, defaultRep, money, onSaved }: {
  token: string | null; reps: { id: number; name: string }[]; defaultRep: number | null; money: Money; onSaved: () => void;
}) {
  const [repUserId, setRepUserId] = useState<number | null>(defaultRep);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [head, setHead] = useState({ saleDate: today(), channel: 'warehouse' as 'warehouse' | 'office', warehouseName: '', pharmacyName: '', areaName: '', invoiceNo: '', notes: '' });
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !repUserId) return;
    setItemsLoading(true);
    api<{ items: CatalogItem[] }>(token, `/rep-items?repUserId=${repUserId}`)
      .then(r => setItems(r.items))
      .catch(() => setItems([]))
      .finally(() => setItemsLoading(false));
  }, [token, repUserId]);

  const itemById = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const priceFor = (l: Line) => {
    if (l.unitPrice !== '') return Number(l.unitPrice) || 0;
    const it = l.itemId ? itemById.get(l.itemId) : null;
    if (!it) return 0;
    return head.channel === 'office' ? (it.price ?? it.warehousePrice ?? 0) : (it.warehousePrice ?? it.price ?? 0);
  };
  const lineTotal = (l: Line) => (Number(l.quantity) || 0) * priceFor(l);
  const total = lines.reduce((s, l) => s + lineTotal(l), 0);
  const setLine = (key: number, patch: Partial<Line>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async () => {
    setErr(null);
    const valid = lines.filter(l => l.itemId && Number(l.quantity) > 0);
    if (!head.pharmacyName.trim()) return setErr('اسم الصيدلية مطلوب');
    if (!valid.length) return setErr('أضف صنفاً واحداً على الأقل مع كميته');
    setSaving(true);
    try {
      const r = await api<{ created: number; approved: number }>(token, '/personal-sales', {
        method: 'POST',
        ...jsonBody({
          repUserId,
          rows: valid.map(l => ({
            ...head,
            itemId: l.itemId,
            quantity: Number(l.quantity),
            bonusQty: Number(l.bonusQty) || 0,
            unitPrice: l.unitPrice === '' ? null : Number(l.unitPrice),
          })),
        }),
      });
      alert(r.approved ? `حُفظ ${r.created} صنف (معتمد مباشرة).` : `حُفظ ${r.created} صنف — بانتظار اعتماد التيم ليدر.`);
      onSaved();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  };

  return (
    <div className="pt-panel">
      <div className="pt-panel__head"><div className="pt-panel__title">إدخال مبيع شخصي</div></div>
      <div className="pt-panel__body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="pt-form-grid">
          {reps.length > 1 && (
            <div className="pt-field">
              <label>المندوب</label>
              <select className="form-input" value={repUserId ?? ''} onChange={e => { setRepUserId(Number(e.target.value)); setLines([newLine()]); }}>
                {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          <div className="pt-field">
            <label>التاريخ</label>
            <input className="form-input" type="date" value={head.saleDate} max={today()} onChange={e => setHead(h => ({ ...h, saleDate: e.target.value }))} />
          </div>
          <div className="pt-field">
            <label>مصدر البضاعة</label>
            <div className="pt-segment">
              <button className={head.channel === 'warehouse' ? 'is-active' : ''} onClick={() => setHead(h => ({ ...h, channel: 'warehouse' }))}>من مذخر</button>
              <button className={head.channel === 'office' ? 'is-active' : ''} onClick={() => setHead(h => ({ ...h, channel: 'office' }))}>من المكتب</button>
            </div>
          </div>
          {head.channel === 'warehouse' && (
            <div className="pt-field">
              <label>اسم المذخر</label>
              <input className="form-input" value={head.warehouseName} onChange={e => setHead(h => ({ ...h, warehouseName: e.target.value }))} placeholder="مثال: الناقوس" />
            </div>
          )}
          <div className="pt-field">
            <label>الصيدلية *</label>
            <input className="form-input" value={head.pharmacyName} onChange={e => setHead(h => ({ ...h, pharmacyName: e.target.value }))} />
          </div>
          <div className="pt-field">
            <label>المنطقة</label>
            <input className="form-input" value={head.areaName} onChange={e => setHead(h => ({ ...h, areaName: e.target.value }))} />
          </div>
          <div className="pt-field">
            <label>رقم الفاتورة</label>
            <input className="form-input" value={head.invoiceNo} onChange={e => setHead(h => ({ ...h, invoiceNo: e.target.value }))} />
          </div>
        </div>

        <div className="pt-lines">
          <div className="pt-line" style={{ background: 'none', border: 0, padding: '0 8px', fontSize: 11.5, color: 'var(--c-text-secondary)', fontWeight: 600 }}>
            <span>الصنف {itemsLoading && '…'}</span><span>الكمية</span><span>بونص</span><span>سعر المفرد</span><span style={{ textAlign: 'left' }}>المجموع</span><span />
          </div>
          {lines.map(l => {
            const it = l.itemId ? itemById.get(l.itemId) : null;
            const auto = it ? (head.channel === 'office' ? (it.price ?? it.warehousePrice) : (it.warehousePrice ?? it.price)) : null;
            return (
              <div key={l.key} className="pt-line">
                <select className="form-input" value={l.itemId} onChange={e => setLine(l.key, { itemId: e.target.value ? Number(e.target.value) : '' })}>
                  <option value="">{items.length ? 'اختر الصنف…' : 'لا ايتمات معيّنة لهذا المندوب'}</option>
                  {items.map(i => <option key={i.id} value={i.id}>{i.name}{i.companyName ? ` — ${i.companyName}` : ''}</option>)}
                </select>
                <input className="form-input" type="number" min={1} inputMode="numeric" value={l.quantity} onChange={e => setLine(l.key, { quantity: e.target.value })} />
                <input className="form-input" type="number" min={0} inputMode="numeric" value={l.bonusQty} onChange={e => setLine(l.key, { bonusQty: e.target.value })} />
                <input className="form-input" type="number" min={0} value={l.unitPrice} placeholder={auto != null ? String(auto) : 'السعر'} onChange={e => setLine(l.key, { unitPrice: e.target.value })} />
                <span className="pt-line__total">{lineTotal(l) ? money.native(lineTotal(l), 'IQD') : '—'}</span>
                <button className="pt-icon-btn" title="حذف السطر" disabled={lines.length === 1} onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}><Trash2 size={14} /></button>
              </div>
            );
          })}
          <div className="pt-actions">
            <button className="btn btn--secondary btn--sm" onClick={() => setLines(ls => [...ls, newLine()])}><Plus size={14} /> صنف آخر</button>
            <span className="pt-toolbar__spacer" />
            <span style={{ fontSize: 13, color: 'var(--c-text-secondary)' }}>المجموع: <strong style={{ color: 'var(--c-primary)' }}>{money.native(total, 'IQD')}</strong></span>
          </div>
        </div>

        <div className="pt-field">
          <label>ملاحظات</label>
          <input className="form-input" value={head.notes} onChange={e => setHead(h => ({ ...h, notes: e.target.value }))} />
        </div>

        {err && <div className="pt-note pt-note--warn">⚠️ {err}</div>}
        <div className="pt-actions">
          <button className="btn btn--primary" disabled={saving} onClick={submit}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
          <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>السعر الافتراضي: سعر المذخر عند البيع من مذخر، وسعر المكتب عند البيع من المكتب.</span>
        </div>
      </div>
    </div>
  );
}
