import { useState } from 'react';

// زر «من يقرأ الطلبية» لكل كروب (تلكرام + واتساب). القيم تطابق AI_MODES في
// server/modules/orders/order-extract.js — الخادم يرفض أي قيمة أخرى.
export const AI_MODES = ['both', 'parser', 'ai', 'off'] as const;
export type AiMode = typeof AI_MODES[number];

const OPTS: Record<AiMode, { label: string; title: string; color: string }> = {
  both:   { label: '⚡+🤖 الاثنين', title: 'المحلل أولاً (مجاني وفوري)، وما لا يحسمه يذهب للذكاء — الافتراضي', color: '#7c3aed' },
  parser: { label: '⚡ المحلل',     title: 'بلا ذكاء إطلاقاً: يقرأ الطلبيات الواضحة فقط، والغامضة والصور تُتجاهل', color: '#0891b2' },
  ai:     { label: '🤖 الذكاء',     title: 'Gemini لكل رسالة (السلوك القديم)', color: '#2563eb' },
  off:    { label: '⏸ إطفاء',      title: 'لا تحليل لأي رسالة في هذا الكروب', color: '#dc2626' },
};

export function AiModeButtons({ value, onChange }: { value?: string | null; onChange: (v: AiMode) => Promise<unknown> | void }) {
  const cur: AiMode = (AI_MODES as readonly string[]).includes(value || '') ? (value as AiMode) : 'both';
  const [busy, setBusy] = useState<AiMode | null>(null);
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 3 }}>تحليل الطلبيات:</div>
      <div style={{ display: 'inline-flex', flexWrap: 'wrap', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
        {AI_MODES.map(m => {
          const on = m === cur;
          return (
            <button key={m} type="button" title={OPTS[m].title} disabled={busy !== null}
              onClick={async () => { if (on) return; setBusy(m); try { await onChange(m); } finally { setBusy(null); } }}
              style={{
                padding: '4px 8px', fontSize: 11.5, fontWeight: 700, border: 'none', cursor: on ? 'default' : 'pointer',
                borderInlineEnd: '1px solid #e2e8f0', whiteSpace: 'nowrap',
                background: on ? OPTS[m].color : '#fff', color: on ? '#fff' : '#475569',
                opacity: busy && busy !== m ? 0.5 : 1,
              }}>
              {busy === m ? '…' : OPTS[m].label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
