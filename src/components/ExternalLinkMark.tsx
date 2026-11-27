import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';

/**
 * علامة صغيرة بجانب اسم المندوب: هل هو مربوط باسم في دوفايد (D) / ميركاتو (M)؟
 * ممتلئة خضراء = مربوط (التلميح يذكر الاسم/الأسماء)، مفرّغة حمراء = غير مربوط.
 * المصدر: GET /api/scientific-reps/external-links (server/lib/externalRepNames.js).
 * الربط والتعديل من السوبر أدمن ← «ربط دوفايد وميركاتو».
 */

const API = import.meta.env.VITE_API_URL || '';

export type ExtSource = 'dofied' | 'mercato';
export interface ExtLinkInfo {
  dofied: { linked: boolean; names: string[]; visits?: number };
  mercato: { linked: boolean; names: string[] };
}
interface Sources { dofied: { names: number; evidenceReps: number }; mercato: { names: number } }

const LABEL: Record<ExtSource, { letter: string; name: string }> = {
  dofied: { letter: 'D', name: 'دوفايد' },
  mercato: { letter: 'M', name: 'ميركاتو' },
};

/** حالة الربط لقائمة معرّفات — حسابات (userIds) أو سجلات مندوبين (repIds). */
export function useExternalRepLinks(kind: 'userIds' | 'repIds', ids: number[], enabled = true) {
  const { token } = useAuth();
  const key = useMemo(() => [...new Set(ids.filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b).join(','), [ids]);
  const [state, setState] = useState<{ byId: Record<number, ExtLinkInfo | null>; sources: Sources | null }>({ byId: {}, sources: null });
  useEffect(() => {
    if (!enabled || !key || !token) return;
    let alive = true;
    fetch(`${API}/api/scientific-reps/external-links?${kind}=${key}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(j => {
        if (!alive || !j?.success) return;
        setState({ byId: kind === 'userIds' ? j.data.users : j.data.reps, sources: j.data.sources });
      })
      .catch(() => { /* علامة تجميلية — فشلها لا يُظهر شيئاً */ });
    return () => { alive = false; };
  }, [kind, key, token, enabled]);

  /** هل للمصدر بيانات أصلاً؟ بلا أسماء دوفايد مسجَّلة لا معنى لعلامة «غير مربوط». */
  const known = (source: ExtSource) => {
    const s = state.sources;
    if (!s) return false;
    return source === 'dofied' ? s.dofied.names > 0 || s.dofied.evidenceReps > 0 : s.mercato.names > 0;
  };
  return { byId: state.byId, known };
}

export function ExternalLinkMark({ source, info, known, quiet = false }: {
  source: ExtSource; info: ExtLinkInfo | null | undefined; known: boolean;
  /** هادئ: لا شيء للمربوط، ونقطة حمراء صغيرة فقط لغير المربوط (صفحة المبيعات — طلب 2026-11-27) */
  quiet?: boolean;
}) {
  if (!known || info === undefined) return null;
  const s = info?.[source];
  const linked = !!s?.linked;
  const { letter, name } = LABEL[source];
  if (quiet) {
    if (linked) return null;
    const t = `غير مربوط بأي اسم في ${name}`;
    return <span title={t} aria-label={t} style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#f87171', marginInlineStart: 4, verticalAlign: 'middle', opacity: .85 }} />;
  }
  const title = linked
    ? (s!.names.length ? `مربوط باسم في ${name}: ${s!.names.join('، ')}` : `مربوط بـ${name} (زياراته تُسحب من ${name})`)
    : `غير مربوط بأي اسم في ${name}`;
  return (
    <span
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle',
        width: 15, height: 15, borderRadius: '50%', marginInlineStart: 5, flexShrink: 0,
        fontSize: 8.5, fontWeight: 800, lineHeight: 1, fontFamily: 'system-ui, sans-serif',
        background: linked ? '#16a34a' : 'transparent',
        color: linked ? '#fff' : '#dc2626',
        border: linked ? '1px solid #16a34a' : '1px dashed #f87171',
      }}
    >{letter}</span>
  );
}

/** سطر شرح صغير تحت الشرائح. */
export function ExternalLinkLegend({ source }: { source: ExtSource }) {
  const { name } = LABEL[source];
  const yes = { linked: true, names: [] };
  const no = { linked: false, names: [] };
  const info = (v: typeof yes): ExtLinkInfo => ({ dofied: v, mercato: v });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--c-text-muted, #94a3b8)', marginTop: 6 }}>
      <ExternalLinkMark source={source} info={info(yes)} known /> مربوط باسم في {name}
      <span style={{ width: 8 }} />
      <ExternalLinkMark source={source} info={info(no)} known /> غير مربوط
    </div>
  );
}
