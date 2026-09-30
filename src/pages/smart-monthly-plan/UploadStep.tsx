import { useRef, useState } from 'react';
import { smartPlanApi } from './api';
import { Icon } from '../../config/icons';
import { UPLOAD_KIND_META } from './types';
import { btnMini, Tag } from './ui';
import type { SmartPlanUpload, UploadKind } from './types';

const KINDS: UploadKind[] = ['prescribers', 'candidates', 'survey', 'openPharmacies'];

const card = (filled: boolean): React.CSSProperties => ({
  background: 'var(--c-surface)',
  border: `1px solid ${filled ? 'var(--c-success-border)' : 'var(--c-border)'}`,
  borderRadius: 12, padding: '12px 13px',
  display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
});

/** خانات الملفات الأربع — بطاقة واحدة لكل ملف بحالة واضحة (مرفوع / لم يُرفع). */
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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))', gap: 10 }}>
      {KINDS.map(kind => {
        const meta = UPLOAD_KIND_META[kind];
        const upload = uploadByKind.get(kind);
        const auto = kind === 'survey' && isAutoSurvey;
        const busy = busyKind === kind;
        const filled = !!upload;
        return (
          <div key={kind} style={card(filled)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{
                width: 26, height: 26, borderRadius: 8, flexShrink: 0,
                background: filled ? 'var(--c-success-bg)' : 'var(--c-bg)',
                border: `1px solid ${filled ? 'var(--c-success-border)' : 'var(--c-border)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
              }}>{meta.icon}</span>
              <strong style={{ color: 'var(--c-text-primary)', fontSize: 12.5, lineHeight: 1.35, flex: 1, minWidth: 0 }}>{meta.label}</strong>
              {filled && <Icon name="checkCircle" size={14} style={{ color: 'var(--c-success)', flexShrink: 0 }} />}
            </div>

            <div
              title={meta.hint}
              style={{
                fontSize: 11, color: 'var(--c-text-muted)', lineHeight: 1.5, minHeight: 33,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}
            >{meta.hint}</div>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
              background: 'var(--c-bg)', border: '1px solid var(--c-border)',
              borderRadius: 8, padding: '5px 8px', fontSize: 11,
              color: filled ? 'var(--c-text-secondary)' : 'var(--c-text-muted)',
            }}>
              {auto ? (
                <>
                  <Icon name="aiBot" size={12} style={{ color: 'var(--c-accent)', flexShrink: 0 }} />
                  <span>تلقائي من السيرفي ({upload!.rowCount} طبيب)</span>
                </>
              ) : upload ? (
                <>
                  <Icon name="file" size={12} style={{ flexShrink: 0 }} />
                  <span
                    title={upload.fileName}
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'ltr', textAlign: 'right' }}
                  >{upload.fileName}</span>
                  <Tag tone="success">{upload.rowCount} صف</Tag>
                </>
              ) : (
                <>
                  <Icon name="empty" size={12} style={{ flexShrink: 0 }} />
                  <span>لم يُرفع بعد</span>
                </>
              )}
            </div>

            <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
              <input
                ref={el => { inputRefs.current[kind] = el; }}
                type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(kind, f); }}
              />
              <button
                disabled={busy}
                onClick={() => inputRefs.current[kind]?.click()}
                style={{
                  flex: 1, padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
                  fontSize: 12, fontWeight: 600, fontFamily: 'inherit', opacity: busy ? 0.6 : 1,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                  border: filled && !auto ? '1px solid var(--c-border)' : '1px solid var(--c-accent)',
                  background: filled && !auto ? 'var(--c-surface)' : 'var(--c-accent)',
                  color: filled && !auto ? 'var(--c-text-secondary)' : '#fff',
                }}
              >
                {busy
                  ? <><Icon name="loading" size={12} className="icon-spin" /> جارٍ الرفع…</>
                  : filled && !auto
                    ? <><Icon name="refresh" size={12} /> استبدال</>
                    : <><Icon name="import" size={12} /> رفع ملف</>}
              </button>
              {upload && (
                <button
                  disabled={busy}
                  onClick={() => handleClear(kind)}
                  title="حذف الملف"
                  style={{
                    ...btnMini, padding: '7px 9px',
                    border: '1px solid var(--c-danger-border)',
                    background: 'var(--c-danger-bg)', color: 'var(--c-danger)',
                  }}
                >
                  <Icon name="delete" size={12} />
                </button>
              )}
            </div>
            {errorByKind[kind] && <div style={{ color: 'var(--c-danger)', fontSize: 11.5 }}>{errorByKind[kind]}</div>}
          </div>
        );
      })}
    </div>
  );
}
