// ════════════════════════════════════════════════════════════════════════════
// SurveySyncRepBar — شريط المندوب في صفحة السيرفيات
// ────────────────────────────────────────────────────────────────────────────
// تنزيل ملف مناطقه، ورفعه بعد التعديل، ومتابعة حالته. الرفع لا يكتب شيئاً على
// السيرفي — ينشئ دفعة تنتظر مراجعة الإدارة، ولذلك تُوضَّح هذه الحقيقة في نص
// التأكيد نفسه: المندوب يجب أن يعرف أن تعديله لم يُطبَّق بعد.
//
// هذا الشريط هو الشقّ الجماعي من النموذج الهجين؛ التعديل المباشر داخل الصفحة
// (طبيب واحد الآن) يبقى كما هو ويمرّ بنفس المكتبة ونفس السجل.
// ════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  downloadSurveySheet, SHEET_DEF, CHANGE_LABELS, CHANGE_COLORS, type SyncEntryType,
} from '../lib/surveySheet';
import { uploadSurveySheet } from './SurveySyncPanel';

interface Counts { unchanged: number; update: number; move: number; new: number; delete: number; conflict: number; unmatched: number; }
interface MyBatch {
  id: number; entryType: SyncEntryType; fileName: string;
  status: 'pending' | 'applied' | 'discarded'; counts: Counts; createdAt: string;
}

const ORDER: (keyof Counts)[] = ['conflict', 'unmatched', 'delete', 'move', 'update', 'new'];

export default function SurveySyncRepBar({
  surveyId, surveyName, entryType, H, onApplied,
}: {
  surveyId: number; surveyName: string; entryType: SyncEntryType;
  H: () => Record<string, string>;
  onApplied?: () => void;
}) {
  const [busy, setBusy] = useState<'export' | 'upload' | null>(null);
  const [batches, setBatches] = useState<MyBatch[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const label = SHEET_DEF[entryType].fileLabel;

  const loadBatches = useCallback(async () => {
    try {
      const r = await fetch(`/api/master-surveys/${surveyId}/sync/my-batches`, { headers: H() });
      const d = await r.json();
      if (d?.success) setBatches((d.data ?? []).filter((b: MyBatch) => b.entryType === entryType));
    } catch { /* الشريط ثانوي — لا يُفشل الصفحة */ }
  }, [surveyId, entryType, H]);

  useEffect(() => { loadBatches(); }, [loadBatches]);

  const doExport = async () => {
    setBusy('export'); setMsg(null);
    try {
      const r = await fetch(`/api/master-surveys/${surveyId}/sync/${entryType}/export`, { headers: H() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `خطأ ${r.status}`);
      if (!d.data.rows.length) { setMsg({ kind: 'err', text: 'لا توجد صفوف ضمن مناطقك' }); return; }
      downloadSurveySheet({
        entryType, rows: d.data.rows, token: d.data.token,
        surveyName, scopeLabel: 'مناطقك',
      });
      setMsg({ kind: 'ok', text: `نُزّل ${d.data.rows.length} صفاً. عدّل الملف ثم ارفعه من هنا.` });
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
    finally { setBusy(null); }
  };

  const doUpload = async (file: File) => {
    setBusy('upload'); setMsg(null);
    try {
      const out = await uploadSurveySheet(
        file, entryType, `/api/master-surveys/${surveyId}/sync/upload`, H,
      );
      const changed = ORDER.reduce((s, k) => s + (out.counts[k] ?? 0), 0);
      setMsg({
        kind: 'ok',
        text: changed === 0
          ? 'لم يُعثر على أي تغيير في الملف.'
          : `أُرسل ${changed} تغييراً للمراجعة. لن يُطبَّق شيء قبل اعتماد الإدارة.`,
      });
      loadBatches();
      onApplied?.();
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
    finally { setBusy(null); }
  };

  const last = batches[0];

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={doExport} disabled={!!busy} style={btn}>
          {busy === 'export' ? '…' : `⬇ تنزيل ملف مراجعة ال${label}`}
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={!!busy} style={btn}>
          {busy === 'upload' ? '…' : '⬆ رفع الملف بعد التعديل'}
        </button>
        <input
          ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) doUpload(f); }}
        />
        <span style={{ fontSize: 11.5, color: 'var(--c-text-muted)' }}>
          عدّل في الملف ولا تغيّر عمود «الرمز» · لطلب حذف اكتب «حذف» في عمود الإجراء
        </span>
      </div>

      {msg && (
        <div style={{
          marginTop: 8, fontSize: 12.5, borderRadius: 8, padding: '7px 11px',
          background: msg.kind === 'ok' ? 'rgba(5,150,105,.08)' : 'rgba(220,38,38,.08)',
          color: msg.kind === 'ok' ? 'var(--c-success)' : 'var(--c-danger)',
        }}>{msg.text}</div>
      )}

      {last && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
          <span style={{ color: 'var(--c-text-muted)' }}>آخر ملف رفعته:</span>
          <b style={{ fontSize: 12 }}>{last.fileName}</b>
          <StatusChip status={last.status} />
          {ORDER.filter(k => (last.counts?.[k] ?? 0) > 0).map(k => (
            <span key={k} style={{ ...chip, color: CHANGE_COLORS[k], borderColor: CHANGE_COLORS[k] + '55' }}>
              {CHANGE_LABELS[k]} {last.counts[k]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: MyBatch['status'] }) {
  const map = {
    pending:   { t: 'بانتظار مراجعة الإدارة', c: '#ea580c' },
    applied:   { t: 'اعتُمد وطُبّق',            c: '#059669' },
    discarded: { t: 'أُهمل',                    c: '#94a3b8' },
  }[status];
  return <span style={{ ...chip, color: map.c, borderColor: map.c + '55', background: map.c + '12' }}>{map.t}</span>;
}

const wrap: React.CSSProperties = {
  background: 'var(--c-surface-alt, #f8fafc)', border: '1px solid var(--c-border-light)',
  borderRadius: 12, padding: '10px 12px', marginBottom: 14,
};
const btn: React.CSSProperties = {
  background: 'var(--c-surface, #fff)', color: 'var(--c-text-primary)',
  border: '1.5px solid var(--c-border)', borderRadius: 9, cursor: 'pointer',
  fontWeight: 700, fontSize: 12.5, padding: '7px 14px', fontFamily: 'inherit',
};
const chip: React.CSSProperties = {
  background: 'var(--c-surface, #fff)', border: '1px solid var(--c-border-light)',
  borderRadius: 20, padding: '2px 9px', fontWeight: 600, fontSize: 11,
};
