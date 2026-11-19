// «مجلد المبيعات» في صفحة رفع الملفات: ربط المجلد، حالته، وآخر ما عولج — lib/salesFolder.ts.

import { useEffect, useState } from 'react';
import * as folder from '../lib/salesFolder';
import type { FolderStatus } from '../lib/salesFolder';

const timeOf = (t: number | null) => (t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
const ACTION_ICON: Record<string, string> = { uploaded: '✓', review: '⏸', nothing: '·', error: '✗' };
const ACTION_COLOR: Record<string, string> = {
  uploaded: 'var(--c-success, #059669)', review: 'var(--c-warning, #b45309)', nothing: 'var(--c-text-muted, #94a3b8)', error: 'var(--c-danger, #dc2626)',
};

export default function SalesFolderPanel() {
  const [s, setS] = useState<FolderStatus>(folder.getStatus());
  const [showLog, setShowLog] = useState(false);
  useEffect(() => folder.subscribe(setS), []);

  const box: React.CSSProperties = {
    marginTop: 12, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--c-border, #e2e8f0)',
    background: 'var(--c-surface, #fff)', fontSize: 12, textAlign: 'right', direction: 'rtl', lineHeight: 1.7,
  };
  const link: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--c-accent)', cursor: 'pointer', fontSize: 12, padding: 0, fontWeight: 700 };

  if (!s.supported) {
    return <div style={{ ...box, color: 'var(--c-text-muted, #94a3b8)' }}>📁 ربط مجلد المبيعات متاح في Chrome أو Edge على الحاسبة.</div>;
  }

  if (!s.linked) {
    return (
      <div style={box}>
        <button style={link} onClick={() => void folder.link()}>📁 ربط مجلد المبيعات</button>
        <span style={{ color: 'var(--c-text-secondary, #64748b)' }}>
          {' '}— احفظ إكسلات المكتب وميركاتو اليومية في مجلد على الحاسبة، والتطبيق يرفع الجديد منها وحده ما دام مفتوحاً.
          الملف غير المألوف يُحجز لتراجعه.
        </span>
      </div>
    );
  }

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b>📁 مجلد المبيعات: «{s.folderName}»</b>
        {s.permission !== 'granted'
          ? <button style={{ ...link, color: 'var(--c-warning, #b45309)' }} onClick={() => void folder.requestAccess()}>اضغط لمتابعة المراقبة</button>
          : <span style={{ color: 'var(--c-text-secondary, #64748b)' }}>{s.scanning ? '⏳ يُفحص…' : `آخر فحص ${timeOf(s.lastScan)} · كل 3 دقائق`}</span>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'var(--c-text-secondary, #64748b)' }}
          title="مُطفأ: كل ملف جديد يُعرض للمراجعة قبل رفعه">
          <input type="checkbox" checked={s.auto} onChange={e => folder.setAuto(e.target.checked)} style={{ accentColor: 'var(--c-success, #059669)' }} />
          رفع تلقائي للملفات السليمة
        </label>
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 12 }}>
          {s.permission === 'granted' && <button style={link} disabled={s.scanning} onClick={() => void folder.scan()}>فحص الآن</button>}
          {s.log.length > 0 && <button style={link} onClick={() => setShowLog(v => !v)}>{showLog ? 'إخفاء السجل' : `السجل (${s.log.length})`}</button>}
          <button style={{ ...link, color: 'var(--c-text-muted, #94a3b8)', fontWeight: 400 }}
            onClick={() => { if (window.confirm(`إلغاء ربط المجلد «${s.folderName}»؟ لا يُحذف شيء مما رُفع.`)) void folder.unlink(); }}>
            إلغاء الربط
          </button>
        </span>
      </div>
      {s.error && <div style={{ color: 'var(--c-danger, #dc2626)' }}>✗ {s.error}</div>}
      {showLog && (
        <div style={{ marginTop: 4, fontSize: 11.5 }}>
          {s.log.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 6 }}>
              <span style={{ color: ACTION_COLOR[e.action], width: 12, textAlign: 'center' }}>{ACTION_ICON[e.action]}</span>
              <span style={{ color: 'var(--c-text-muted, #94a3b8)', minWidth: 38 }}>{timeOf(e.at)}</span>
              <span style={{ fontWeight: 700 }}>{e.file.replace(/\.(xlsx|xls|csv)$/i, '')}</span>
              <span style={{ color: ACTION_COLOR[e.action] }}>{e.text}</span>
            </div>
          ))}
          <button style={{ ...link, fontWeight: 400, fontSize: 11 }}
            onClick={() => { if (window.confirm('إعادة فحص كل ملفات المجلد؟ المكرر لا يُضاف مرة ثانية.')) folder.rescanAll(); }}>
            إعادة فحص كل الملفات
          </button>
        </div>
      )}
    </div>
  );
}
