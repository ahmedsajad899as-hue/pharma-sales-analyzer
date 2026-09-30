// ════════════════════════════════════════════════════════════════════════════
// SurveySyncPanel — تبويب «التحديثات الواردة» في لوحة السوبر أدمن
// ────────────────────────────────────────────────────────────────────────────
// يعرض الدفعات المرفوعة من المندوبين، وداخل كل دفعة يعرض لكل صف ما تغيّر
// بالضبط: القيمة الحالية ← القيمة الواردة، حقلاً بحقل. لا شيء يُطبَّق قبل
// اعتماد صريح، والتطبيق مقفل ما دام هناك تعارض أو صف بلا مطابقة لم يُحسم.
// ════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CHANGE_LABELS, CHANGE_COLORS, SHEET_DEF, downloadSurveySheet,
  readSurveySheetFile, type SyncEntryType,
} from '../lib/surveySheet';

// ── أنواع ───────────────────────────────────────────────────────────────────
interface Counts { unchanged: number; update: number; move: number; new: number; delete: number; conflict: number; unmatched: number; }
interface Batch {
  id: number; surveyId: number; entryType: SyncEntryType; fileName: string;
  status: 'pending' | 'applied' | 'discarded'; counts: Counts; createdAt: string; reviewedAt?: string | null;
  exportId?: number | null;
  uploadedBy?: { id: number; username: string; displayName?: string } | null;
}
interface Candidate { id: number; name: string; score: number; areaName?: string | null; specialty?: string | null; ownerName?: string | null; }
interface DiffField { field: string; from: string | null; to: string | null; }
interface RowDiffs { fields: DiffField[]; impact?: { affectedDoctors: number; affectedVisits: number; affectedLinks: number } | null; }
interface SyncRow {
  id: number; entryId: number | null; code: string; rowNumber: number;
  changeType: keyof Counts; decision: 'pending' | 'approved' | 'rejected';
  appliedAt?: string | null;
  incoming: Record<string, string | null>;
  current: Record<string, any> | null;
  diffs: RowDiffs | null;
  candidates: Candidate[] | null;
}
interface BatchDetail {
  batch: Batch; fields: string[]; headers: Record<string, string>;
  rows: SyncRow[]; total: number; page: number; limit: number;
}

type Headers = () => Record<string, string>;

const ORDER: (keyof Counts)[] = ['conflict', 'unmatched', 'delete', 'move', 'update', 'new', 'unchanged'];
const NEEDS_DECISION = new Set<string>(['conflict', 'unmatched', 'delete', 'move', 'update', 'new']);

function fmtDate(s?: string | null) {
  if (!s) return '—';
  return new Date(s).toLocaleString('ar-IQ', { dateStyle: 'short', timeStyle: 'short' });
}

// ════════════════════════════════════════════════════════════════════════════
export default function SurveySyncPanel({
  surveyId, surveyName, H,
}: { surveyId: number; surveyName: string; H: Headers }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await fetch(`/api/super-admin/surveys/${surveyId}/sync/batches`, { headers: H() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `خطأ ${r.status}`);
      setBatches(d.data ?? []);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [surveyId, H]);

  useEffect(() => { load(); }, [load]);

  if (openId != null) {
    return <BatchDetailView batchId={openId} H={H} onBack={() => { setOpenId(null); load(); }} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <ExportControls surveyId={surveyId} surveyName={surveyName} H={H} />
        <div style={{ flex: 1 }} />
        <button onClick={load} style={btnSecondary}>↻ تحديث</button>
      </div>

      <div style={infoBox}>
        المندوب ينزّل ملف مناطقه، يعدّل فيه، ثم يرفعه — ويظهر هنا. <b>لا شيء يُطبَّق قبل اعتمادك.</b>
        {' '}حذف صف من الملف لا يحذفه من النظام؛ الحذف يُطلب بكتابة «حذف» في عمود الإجراء.
      </div>

      {err && <div style={errBox}>{err}</div>}
      {loading && <div style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>جارٍ التحميل…</div>}

      {!loading && batches.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
          لا توجد ملفات مرفوعة بعد.
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {batches.map(b => (
          <div key={b.id} onClick={() => setOpenId(b.id)} style={batchCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 18 }}>{b.entryType === 'doctor' ? '🩺' : '🏪'}</span>
              <b style={{ fontSize: 14 }}>{b.fileName}</b>
              <StatusChip status={b.status} />
              {!b.exportId && <span style={{ ...chip, background: '#fffbeb', color: '#b45309', borderColor: '#fde68a' }}>
                بلا رمز تصدير — كشف التعارض معطّل
              </span>}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: '#64748b' }}>
                {b.uploadedBy ? (b.uploadedBy.displayName || b.uploadedBy.username) : 'السوبر أدمن'} · {fmtDate(b.createdAt)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {ORDER.filter(k => (b.counts?.[k] ?? 0) > 0).map(k => (
                <span key={k} style={{ ...chip, color: CHANGE_COLORS[k], borderColor: CHANGE_COLORS[k] + '55', background: CHANGE_COLORS[k] + '12' }}>
                  {CHANGE_LABELS[k]} {b.counts[k]}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: Batch['status'] }) {
  const map = {
    pending:   { t: 'بانتظار المراجعة', c: '#ea580c' },
    applied:   { t: 'طُبّقت',           c: '#059669' },
    discarded: { t: 'مهملة',            c: '#94a3b8' },
  }[status];
  return <span style={{ ...chip, color: map.c, borderColor: map.c + '55', background: map.c + '12' }}>{map.t}</span>;
}

// ── تصدير ───────────────────────────────────────────────────────────────────
function ExportControls({ surveyId, surveyName, H }: { surveyId: number; surveyName: string; H: Headers }) {
  const [busy, setBusy] = useState<SyncEntryType | null>(null);
  const [users, setUsers] = useState<{ id: number; name: string; role: string }[]>([]);
  const [userId, setUserId] = useState('');

  useEffect(() => {
    // نعيد استعمال نقطة «فحص الظهور» لأنها تُرجع قائمة المستخدمين جاهزة.
    fetch(`/api/super-admin/surveys/${surveyId}/coverage`, { headers: H() })
      .then(r => r.json())
      .then(d => { if (d?.success) setUsers(d.data.users ?? []); })
      .catch(() => {});
  }, [surveyId, H]);

  const doExport = async (entryType: SyncEntryType) => {
    setBusy(entryType);
    try {
      const qs = userId ? `?userId=${userId}` : '';
      const r = await fetch(`/api/super-admin/surveys/${surveyId}/${entryType}/export${qs}`, { headers: H() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `خطأ ${r.status}`);
      if (!d.data.rows.length) { alert('لا توجد صفوف ضمن هذا النطاق'); return; }
      const who = d.data.forUser ? (d.data.forUser.displayName || d.data.forUser.username) : '';
      downloadSurveySheet({
        entryType, rows: d.data.rows, token: d.data.token,
        surveyName, scopeLabel: who ? `مناطق ${who}` : 'كل الصفوف',
        fileName: `سيرفي-${SHEET_DEF[entryType].fileLabel}${who ? '-' + who : ''}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch (e: any) { alert(`❌ فشل التصدير: ${e.message}`); }
    finally { setBusy(null); }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <select value={userId} onChange={e => setUserId(e.target.value)} style={{ ...inputStyle, width: 'auto', minWidth: 190 }}>
        <option value="">كل صفوف السيرفي</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      <button onClick={() => doExport('doctor')} disabled={!!busy} style={btnPrimary}>
        {busy === 'doctor' ? '…' : '⬇ تصدير الأطباء'}
      </button>
      <button onClick={() => doExport('pharmacy')} disabled={!!busy} style={btnPrimary}>
        {busy === 'pharmacy' ? '…' : '⬇ تصدير الصيدليات'}
      </button>
    </div>
  );
}

// ── تفاصيل دفعة ─────────────────────────────────────────────────────────────
function BatchDetailView({ batchId, H, onBack }: { batchId: number; H: Headers; onBack: () => void }) {
  const [data, setData] = useState<BatchDetail | null>(null);
  const [filter, setFilter] = useState<keyof Counts | ''>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [applyResult, setApplyResult] = useState<any>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const qs = filter ? `?changeType=${filter}&limit=500` : '?limit=500';
      const r = await fetch(`/api/super-admin/surveys/sync/batches/${batchId}${qs}`, { headers: H() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `خطأ ${r.status}`);
      setData(d.data);
    } catch (e: any) { setErr(e.message); }
  }, [batchId, filter, H]);

  useEffect(() => { load(); }, [load]);

  const call = async (url: string, method: string, body?: any) => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(url, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `خطأ ${r.status}`);
      return d.data;
    } catch (e: any) { setErr(e.message); return null; }
    finally { setBusy(false); }
  };

  const decide = async (rowId: number, decision: string, targetEntryId?: number | null) => {
    const out = await call(`/api/super-admin/surveys/sync/rows/${rowId}`, 'PATCH',
      targetEntryId === undefined ? { decision } : { decision, targetEntryId });
    if (out) load();
  };
  const decideBulk = async (changeType: keyof Counts, decision: string) => {
    const out = await call(`/api/super-admin/surveys/sync/batches/${batchId}/decide-bulk`, 'POST', { changeType, decision });
    if (out) load();
  };
  const apply = async () => {
    const out = await call(`/api/super-admin/surveys/sync/batches/${batchId}/apply`, 'POST');
    if (out) { setApplyResult(out); load(); }
  };
  const discard = async () => {
    if (!confirm('إهمال هذه الدفعة؟ لن يُطبَّق أي تعديل منها.')) return;
    const r = await fetch(`/api/super-admin/surveys/sync/batches/${batchId}`, { method: 'DELETE', headers: H() });
    if (r.ok) onBack(); else setErr('تعذّر إهمال الدفعة');
  };

  const blocking = useMemo(() => {
    if (!data) return 0;
    // العدّ من counts لا من الصفوف المعروضة: الفلتر قد يخفي ما يمنع التطبيق.
    return (data.batch.counts.conflict ?? 0) + (data.batch.counts.unmatched ?? 0);
  }, [data]);

  if (!data) {
    return <div style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>
      {err ? <span style={{ color: '#ef4444' }}>{err}</span> : 'جارٍ التحميل…'}
      <div><button onClick={onBack} style={{ ...btnSecondary, marginTop: 14 }}>← رجوع</button></div>
    </div>;
  }

  const { batch, headers } = data;
  const isPending = batch.status === 'pending';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button onClick={onBack} style={btnSecondary}>← الدفعات</button>
        <b style={{ fontSize: 15 }}>{batch.fileName}</b>
        <StatusChip status={batch.status} />
        <div style={{ flex: 1 }} />
        {isPending && <>
          <button onClick={discard} disabled={busy} style={btnDanger}>إهمال</button>
          <button onClick={apply} disabled={busy || blocking > 0} style={{ ...btnPrimary, opacity: blocking > 0 ? 0.5 : 1 }}
            title={blocking > 0 ? `${blocking} صفاً يحتاج قراراً أولاً` : ''}>
            ✓ تطبيق المعتمَد
          </button>
        </>}
      </div>

      {blocking > 0 && isPending && (
        <div style={{ ...infoBox, background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>
          يوجد <b>{blocking}</b> صفاً بتعارض أو بلا مطابقة. التطبيق مقفل حتى تحسمها — هذه هي الحالات
          التي لا يجوز فيها تخمين النية.
        </div>
      )}

      {applyResult && (
        <div style={{ ...infoBox, background: '#ecfdf5', borderColor: '#a7f3d0', color: '#065f46' }}>
          طُبّق {applyResult.applied} صفاً (جديد {applyResult.created} · تعديل {applyResult.updated} · تعطيل {applyResult.deactivated}).
          {applyResult.skippedStale > 0 && <> · <b>{applyResult.skippedStale}</b> صفاً تغيّر داخل التطبيق أثناء المراجعة فأُعيد للتعارض بلا تطبيق.</>}
          {applyResult.failed > 0 && <> · فشل {applyResult.failed}.</>}
        </div>
      )}

      {err && <div style={errBox}>{err}</div>}

      {/* شرائح التصفية */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={() => setFilter('')} style={{ ...chipBtn, ...(filter === '' ? chipBtnOn : {}) }}>
          الكل {data.total}
        </button>
        {ORDER.filter(k => (batch.counts?.[k] ?? 0) > 0).map(k => (
          <button key={k} onClick={() => setFilter(k)}
            style={{ ...chipBtn, ...(filter === k ? { ...chipBtnOn, borderColor: CHANGE_COLORS[k], color: CHANGE_COLORS[k] } : { color: CHANGE_COLORS[k] }) }}>
            {CHANGE_LABELS[k]} {batch.counts[k]}
          </button>
        ))}
      </div>

      {/* قرار جماعي */}
      {isPending && filter && NEEDS_DECISION.has(filter) && filter !== 'unmatched' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#64748b' }}>على كل صفوف «{CHANGE_LABELS[filter]}»:</span>
          <button onClick={() => decideBulk(filter, 'approved')} disabled={busy} style={{ ...btnSecondary, padding: '6px 14px' }}>اعتماد الكل</button>
          <button onClick={() => decideBulk(filter, 'rejected')} disabled={busy} style={{ ...btnSecondary, padding: '6px 14px' }}>رفض الكل</button>
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {data.rows.map(row => (
          <RowCard key={row.id} row={row} headers={headers} entryType={batch.entryType}
            editable={isPending} busy={busy} onDecide={decide} />
        ))}
      </div>
      {data.rows.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>لا صفوف بهذا التصنيف</div>}
    </div>
  );
}

// ── بطاقة صف ────────────────────────────────────────────────────────────────
function RowCard({ row, headers, entryType, editable, busy, onDecide }: {
  row: SyncRow; headers: Record<string, string>; entryType: SyncEntryType;
  editable: boolean; busy: boolean;
  onDecide: (rowId: number, decision: string, targetEntryId?: number | null) => void;
}) {
  const [target, setTarget] = useState<string>('');
  const color = CHANGE_COLORS[row.changeType] ?? '#64748b';
  const name = row.incoming.name || row.current?.name || '—';
  const diffs = row.diffs?.fields ?? [];
  const impact = row.diffs?.impact;

  return (
    <div style={{ ...batchCard, cursor: 'default', borderInlineStartWidth: 4, borderInlineStartColor: color, borderInlineStartStyle: 'solid' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ ...chip, color, borderColor: color + '55', background: color + '12' }}>{CHANGE_LABELS[row.changeType]}</span>
        <b style={{ fontSize: 14 }}>{name}</b>
        {row.code && <span style={{ ...chip, fontFamily: 'monospace' }}>{row.code}</span>}
        <span style={{ fontSize: 11, color: '#94a3b8' }}>صف {row.rowNumber} في الملف</span>
        <div style={{ flex: 1 }} />
        <DecisionChip decision={row.decision} applied={!!row.appliedAt} />
      </div>

      {/* الفروق: الحالي ← الوارد */}
      {diffs.length > 0 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          {diffs.map(d => (
            <div key={d.field} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, flexWrap: 'wrap' }}>
              <span style={{ color: '#64748b', minWidth: 90 }}>{headers[d.field] ?? d.field}</span>
              <span style={{ color: '#b91c1c', textDecoration: 'line-through', opacity: 0.75 }}>{d.from ?? '—'}</span>
              <span style={{ color: '#94a3b8' }}>←</span>
              <b style={{ color: '#047857' }}>{d.to ?? '(مسح)'}</b>
            </div>
          ))}
        </div>
      )}

      {row.changeType === 'new' && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: '#475569', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {Object.entries(row.incoming).filter(([k, v]) => k !== 'name' && v).map(([k, v]) => (
            <span key={k} style={chip}>{headers[k] ?? k}: {v}</span>
          ))}
        </div>
      )}

      {row.changeType === 'delete' && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: '#9a3412' }}>
          سيُعطَّل ويختفي من كل القوائم — وتبقى زياراته وتاريخه كاملة، ويمكن إرجاعه لاحقاً.
        </div>
      )}

      {impact && (impact.affectedDoctors > 0 || impact.affectedVisits > 0) && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '6px 10px' }}>
          إعادة التسمية ستتبعها {impact.affectedDoctors > 0 && <b>{impact.affectedDoctors} طبيباً</b>}
          {impact.affectedDoctors > 0 && impact.affectedVisits > 0 && ' و'}
          {impact.affectedVisits > 0 && <b>{impact.affectedVisits} زيارة</b>}
          {impact.affectedLinks > 0 && <> و{impact.affectedLinks} رابط صيدلية مفتوحة</>}.
        </div>
      )}

      {/* التعارض: الطرفان */}
      {row.changeType === 'conflict' && (
        <div style={{ marginTop: 8, fontSize: 12.5, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '8px 10px', color: '#9a3412' }}>
          عُدِّل هذا الصف داخل التطبيق بعد أن استلم المندوب ملفه. الاعتماد هنا يعني
          <b> تثبيت ما في الملف فوق القيمة الحالية</b>، والرفض يبقي الحالية.
        </div>
      )}

      {/* بلا مطابقة: اختيار الهدف */}
      {row.changeType === 'unmatched' && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
            لم يُعرف هذا الاسم — اختر من هو، أو أنشئه جديداً:
          </div>
          <div style={{ display: 'grid', gap: 5 }}>
            {(row.candidates ?? []).map(c => (
              <label key={c.id} style={{ ...candidateRow, ...(target === String(c.id) ? candidateRowOn : {}) }}>
                <input type="radio" name={`t-${row.id}`} checked={target === String(c.id)} onChange={() => setTarget(String(c.id))} />
                <b style={{ fontSize: 13 }}>{c.name}</b>
                {c.areaName && <span style={matchChip}>{c.areaName}</span>}
                {(c.specialty || c.ownerName) && <span style={matchChip}>{c.specialty || c.ownerName}</span>}
                <span style={{ marginInlineStart: 'auto', fontSize: 11, color: '#64748b' }}>{Math.round((c.score ?? 0) * 100)}%</span>
              </label>
            ))}
            <label style={{ ...candidateRow, ...(target === 'new' ? candidateRowOn : {}) }}>
              <input type="radio" name={`t-${row.id}`} checked={target === 'new'} onChange={() => setTarget('new')} />
              <span style={{ fontSize: 13 }}>ليس أياً منهم — أنشئه {entryType === 'doctor' ? 'طبيباً' : 'صيدلية'} جديداً</span>
            </label>
          </div>
        </div>
      )}

      {editable && row.changeType !== 'unchanged' && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button
            disabled={busy || (row.changeType === 'unmatched' && !target)}
            onClick={() => onDecide(row.id, 'approved',
              row.changeType === 'unmatched' ? (target === 'new' ? null : Number(target)) : undefined)}
            style={{ ...btnPrimary, padding: '6px 16px', opacity: (row.changeType === 'unmatched' && !target) ? 0.5 : 1 }}>
            اعتماد
          </button>
          <button disabled={busy} onClick={() => onDecide(row.id, 'rejected')} style={{ ...btnSecondary, padding: '6px 16px' }}>
            رفض
          </button>
          {row.decision !== 'pending' && (
            <button disabled={busy} onClick={() => onDecide(row.id, 'pending')} style={{ ...btnSecondary, padding: '6px 12px' }}>
              تراجع
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionChip({ decision, applied }: { decision: SyncRow['decision']; applied: boolean }) {
  if (applied) return <span style={{ ...chip, color: '#059669', borderColor: '#a7f3d0', background: '#ecfdf5' }}>طُبّق</span>;
  const map = {
    pending:  { t: 'بانتظار قرار', c: '#94a3b8' },
    approved: { t: 'معتمَد',        c: '#059669' },
    rejected: { t: 'مرفوض',         c: '#dc2626' },
  }[decision];
  return <span style={{ ...chip, color: map.c, borderColor: map.c + '55', background: map.c + '12' }}>{map.t}</span>;
}

// ── رفع ملف (يُستعمل من صفحة المندوب أيضاً) ─────────────────────────────────
export async function uploadSurveySheet(
  file: File, entryType: SyncEntryType, url: string, H: Headers,
): Promise<{ batchId: number; counts: Counts; exportMatched: boolean }> {
  const parsed = await readSurveySheetFile(file, entryType);
  if (!parsed.rows.length) throw new Error('الملف لا يحتوي صفوفاً');
  if (parsed.entryType && parsed.entryType !== entryType) {
    throw new Error(`هذا ملف ${SHEET_DEF[parsed.entryType].fileLabel} — اخترت رفعه كملف ${SHEET_DEF[entryType].fileLabel}`);
  }
  const r = await fetch(url, {
    method: 'POST', headers: H(),
    body: JSON.stringify({ entryType, fileName: file.name, token: parsed.token, rows: parsed.rows }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `خطأ ${r.status}`);
  return d.data;
}

// ── أنماط ───────────────────────────────────────────────────────────────────
const chip: React.CSSProperties = {
  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 20,
  padding: '2px 10px', color: '#475569', fontWeight: 600, fontSize: 11.5,
};
const chipBtn: React.CSSProperties = {
  background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 20,
  padding: '5px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit', color: '#475569',
};
const chipBtnOn: React.CSSProperties = { background: '#eef2ff', borderColor: '#6366f1', color: '#4f46e5' };
const batchCard: React.CSSProperties = {
  border: '1px solid #e2e8f0', borderRadius: 12, padding: 12,
  background: '#fff', cursor: 'pointer',
};
const infoBox: React.CSSProperties = {
  background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
  padding: '10px 14px', fontSize: 12.5, color: '#475569', marginBottom: 12, lineHeight: 1.7,
};
const errBox: React.CSSProperties = {
  background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
  padding: '10px 14px', fontSize: 13, color: '#b91c1c', marginBottom: 12,
};
const inputStyle: React.CSSProperties = {
  border: '1.5px solid #e2e8f0', borderRadius: 9, padding: '8px 12px',
  fontSize: 13, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
};
const btnPrimary: React.CSSProperties = {
  background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff',
  border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 700,
  fontSize: 13, padding: '9px 20px', fontFamily: 'inherit',
};
const btnSecondary: React.CSSProperties = {
  background: '#f1f5f9', color: '#374151', border: '1.5px solid #e2e8f0',
  borderRadius: 9, cursor: 'pointer', fontWeight: 600, fontSize: 13,
  padding: '9px 20px', fontFamily: 'inherit',
};
const btnDanger: React.CSSProperties = {
  background: '#fef2f2', color: '#ef4444', border: '1.5px solid #fecaca',
  borderRadius: 9, cursor: 'pointer', fontWeight: 600, fontSize: 13,
  padding: '9px 20px', fontFamily: 'inherit',
};
const matchChip: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 20, padding: '2px 9px', color: '#475569', fontWeight: 500, fontSize: 11 };
const candidateRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 8, border: '1.5px solid #e2e8f0', background: '#fff', cursor: 'pointer' };
const candidateRowOn: React.CSSProperties = { borderColor: '#6366f1', background: '#eef2ff' };
