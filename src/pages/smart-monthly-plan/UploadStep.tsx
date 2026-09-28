import { useRef, useState } from 'react';
import { smartPlanApi } from './api';
import { UPLOAD_KIND_META } from './types';
import type { SmartPlanUpload, UploadKind } from './types';

const KINDS: UploadKind[] = ['prescribers', 'candidates', 'survey', 'openPharmacies'];

const card: React.CSSProperties = {
  background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 'var(--radius-md)',
  padding: 16, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 240, flex: '1 1 240px',
};

export default function UploadStep({
  token, planId, uploads, onChanged,
}: {
  token: string; planId: number; uploads: SmartPlanUpload[]; onChanged: () => void;
}) {
  const [busyKind, setBusyKind] = useState<UploadKind | null>(null);
  const [errorByKind, setErrorByKind] = useState<Partial<Record<UploadKind, string>>>({});
  const inputRefs = useRef<Partial<Record<UploadKind, HTMLInputElement | null>>>({});

  const uploadByKind = new Map(uploads.map(u => [u.kind, u]));
  const isAutoSurvey = uploadByKind.get('survey')?.fileName?.startsWith('(تلقائي');

  const handleFile = async (kind: UploadKind, file: File) => {
    setBusyKind(kind);
    setErrorByKind(prev => ({ ...prev, [kind]: undefined }));
    try {
      await smartPlanApi.uploadFile(token, planId, kind, file);
      onChanged();
    } catch (e: any) {
      setErrorByKind(prev => ({ ...prev, [kind]: e.message }));
    } finally {
      setBusyKind(null);
      const input = inputRefs.current[kind];
      if (input) input.value = '';
    }
  };

  const handleClear = async (kind: UploadKind) => {
    setBusyKind(kind);
    try {
      await smartPlanApi.clearUpload(token, planId, kind);
      onChanged();
    } catch (e: any) {
      setErrorByKind(prev => ({ ...prev, [kind]: e.message }));
    } finally {
      setBusyKind(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      {KINDS.map(kind => {
        const meta = UPLOAD_KIND_META[kind];
        const upload = uploadByKind.get(kind);
        const auto = kind === 'survey' && isAutoSurvey;
        const busy = busyKind === kind;
        return (
          <div key={kind} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 20 }}>{meta.icon}</span>
              <strong style={{ color: 'var(--c-text-primary)', fontSize: 14 }}>{meta.label}</strong>
            </div>
            <div style={{ fontSize: 12, color: 'var(--c-text-muted)', lineHeight: 1.6 }}>{meta.hint}</div>

            {upload && !auto && (
              <div style={{
                background: 'var(--c-success-bg)', border: '1px solid var(--c-success-border)',
                borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 12, color: 'var(--c-text-primary)',
              }}>
                📄 {upload.fileName}<br />
                {upload.rowCount} صف — {upload.matchedCount} مطابَق/جديد
              </div>
            )}
            {auto && (
              <div style={{
                background: 'var(--c-accent-light)', border: '1px solid var(--c-purple-border,var(--c-border))',
                borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 12, color: 'var(--c-text-primary)',
              }}>
                ✨ يُستخدَم تلقائياً من بيانات السيرفي ({upload!.rowCount} طبيب ضمن مناطق المندوب)
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
              <input
                ref={el => { inputRefs.current[kind] = el; }}
                type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(kind, f); }}
              />
              <button
                disabled={busy}
                onClick={() => inputRefs.current[kind]?.click()}
                style={{
                  flex: 1, padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                  background: 'var(--c-accent)', color: '#fff', fontSize: 12, fontWeight: 600, opacity: busy ? 0.6 : 1,
                }}
              >
                {busy ? 'جارٍ الرفع...' : upload && !auto ? 'استبدال الملف' : 'رفع ملف'}
              </button>
              {upload && (
                <button
                  disabled={busy}
                  onClick={() => handleClear(kind)}
                  title="حذف"
                  style={{
                    padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-danger-border)',
                    background: 'var(--c-danger-bg)', color: 'var(--c-danger)', cursor: 'pointer', fontSize: 12,
                  }}
                >
                  حذف
                </button>
              )}
            </div>
            {errorByKind[kind] && <div style={{ color: 'var(--c-danger)', fontSize: 12 }}>{errorByKind[kind]}</div>}
          </div>
        );
      })}
    </div>
  );
}
