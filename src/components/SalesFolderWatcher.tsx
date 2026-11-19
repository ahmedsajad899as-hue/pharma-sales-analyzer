// ════════════════════════════════════════════════════════════════════════════
// SalesFolderWatcher — يعمل على مستوى App أياً كانت الصفحة المفتوحة: يشغّل فحص
// «مجلد المبيعات» (lib/salesFolder.ts) ويعرض شريطاً صغيراً أسفل يسار الشاشة:
//   • رُفع ملف تلقائياً (يختفي بعد ثوانٍ)
//   • ملفات تحتاج مراجعة ← «مراجعة» يفتح «الرفع الذكي» بها هنا مباشرةً (صفحة الرفع
//     مركّبة في مكانين — «تحليل المبيعات» و«رفع الملفات» — فالفتح عبرها كان يصيب
//     النسخة المخفية)
//   • المتصفح يطلب إذن القراءة من جديد بعد إعادة فتحه ← «متابعة»
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';
import * as folder from '../lib/salesFolder';
import type { FolderStatus, FolderUploadResult } from '../lib/salesFolder';
import SmartUploadModal from './SmartUploadModal';

interface Props {
  userId: number;
  token: string;
  onUploaded: (r: FolderUploadResult) => void;
}

const baseName = (n: string) => n.replace(/\.(xlsx|xls|csv)$/i, '');

export default function SalesFolderWatcher({ userId, token, onUploaded }: Props) {
  const [s, setS] = useState<FolderStatus>(folder.getStatus());
  const [notice, setNotice] = useState<string | null>(null);
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [reviewFiles, setReviewFiles] = useState<File[] | null>(null);
  const lastSeenLog = useRef<number>(Date.now());
  const uploadedRef = useRef(onUploaded);
  uploadedRef.current = onUploaded;

  useEffect(() => {
    void folder.start({ userId, token, onUploaded: (r) => uploadedRef.current(r) });
  }, [userId, token]);
  useEffect(() => () => folder.stop(), []);

  useEffect(() => folder.subscribe(setS), []);

  // إشعار «رُفع تلقائياً» لكل رفعة جديدة في السجل منذ فتح التطبيق.
  useEffect(() => {
    const fresh = s.log.filter(e => e.at > lastSeenLog.current && e.action === 'uploaded');
    if (!fresh.length) return;
    lastSeenLog.current = Math.max(...s.log.map(e => e.at));
    setNotice(fresh.map(e => `📁 «${baseName(e.file)}» رُفع تلقائياً — ${e.text}`).join('\n'));
    const t = setTimeout(() => setNotice(null), 12_000);
    return () => clearTimeout(t);
  }, [s.log]);

  // أسفل اليسار: اليمين للقائمة الجانبية وزر المساعد.
  const bar: React.CSSProperties = {
    position: 'fixed', left: 16, bottom: 16, zIndex: 1050, maxWidth: 'min(520px, calc(100vw - 32px))',
    background: 'var(--c-surface, #fff)', color: 'var(--c-text-primary, #1e293b)', border: '1px solid var(--c-border, #e2e8f0)',
    borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,0.18)', padding: '10px 14px', fontSize: 12.5, lineHeight: 1.6,
    direction: 'rtl', display: 'flex', flexDirection: 'column', gap: 6,
  };
  const btn = (primary: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
    border: primary ? 'none' : '1px solid var(--c-border, #d1d5db)',
    background: primary ? 'var(--c-success, #059669)' : 'var(--c-bg, #f3f4f6)', color: primary ? '#fff' : 'var(--c-text-primary, #374151)',
  });

  if (reviewFiles) {
    return (
      <SmartUploadModal
        token={token}
        initialFiles={reviewFiles}
        onClose={() => setReviewFiles(null)}
        onUploaded={(rs) => rs.forEach(r => uploadedRef.current(r))}
      />
    );
  }

  if (s.linked && s.permission === 'prompt' && !promptDismissed) {
    return (
      <div style={bar}>
        <span>📁 متابعة مراقبة مجلد المبيعات «{s.folderName}»؟ المتصفح يطلب الإذن بعد إعادة فتحه.</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btn(true)} onClick={() => void folder.requestAccess()}>متابعة</button>
          <button style={btn(false)} onClick={() => setPromptDismissed(true)}>لاحقاً</button>
        </div>
      </div>
    );
  }

  if (s.review.length) {
    return (
      <div style={{ ...bar, borderColor: 'var(--c-warning-border, #fde68a)' }}>
        <b>📁 {s.review.length} ملف في مجلد «{s.folderName}» يحتاج مراجعة قبل الرفع</b>
        <div style={{ fontSize: 11.5, color: 'var(--c-text-secondary, #64748b)' }}>
          {s.review.slice(0, 3).map(r => <div key={r.file.name}>• {baseName(r.file.name)}: {r.reasons.join('، ')}</div>)}
          {s.review.length > 3 && <div>… و{s.review.length - 3} غيرها</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btn(true)} onClick={() => setReviewFiles(folder.takeReview())}>مراجعة</button>
          <button style={btn(false)} onClick={() => folder.dismissReview()}>تجاهل</button>
        </div>
      </div>
    );
  }

  if (notice) {
    return (
      <div style={{ ...bar, borderColor: 'var(--c-success-border, #6ee7b7)', whiteSpace: 'pre-line', cursor: 'pointer' }} onClick={() => setNotice(null)}>
        {notice}
      </div>
    );
  }
  return null;
}
