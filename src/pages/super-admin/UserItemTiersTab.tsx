// تبويب «⭐ الفئات» للمسوقين: ايتمات رئيسية / ثانوية + كيف تُحسب الثانوية.
// تُحدَّد عند المدير ويرثها من تحته؛ تغيير ايتم لمندوب بعينه يُحفظ له وحده.
// يُخزَّن ما يخالف الموروث فقط — راجع server/lib/itemTiers.js.
import { useEffect, useMemo, useState } from 'react';
import { SectionHead, Note, GroupCard, ScrollList, Empty, SaveBar, softBtn, ACCENT } from './AssignUI';

type Tier = 'main' | 'secondary';
type Mode = 'count' | 'separate' | 'hide';
interface CatalogItem { id: number; name: string; companyName?: string }
interface TiersResp {
  own: Record<string, Tier>;
  inherited: Record<string, { tier: Tier; from: string | null }>;
  ownMode: Mode | null;
  inheritedMode: { mode: Mode; from: string | null } | null;
  defaultMode: Mode;
  managers: { id: number; name: string }[];
}

const MODE_LABEL: Record<Mode, string> = {
  count:    'تُحسب ضمن المجموع',
  separate: 'تظهر للمقارنة ولا تُحسب',
  hide:     'مخفية تماماً',
};
const MODE_HINT: Record<Mode, string> = {
  count:    'الثانوية تدخل رقم المسوّق كالرئيسية، والتقرير يعرض المقارنة بينهما.',
  separate: 'رقم المسوّق = الرئيسية فقط. الثانوية تظهر في خانة المقارنة بالتقرير ولا تدخل المجموع ولا التصدير.',
  hide:     'مبيع الثانوية لا يُحسب ولا يظهر للمسوّق إطلاقاً.',
};

export default function UserItemTiersTab({ userId, items, whitelistIds, headers, onToast }: {
  userId: number;
  items: CatalogItem[];
  whitelistIds: number[];
  headers: () => Record<string, string>;
  onToast: (msg: string, color?: string) => void;
}) {
  const [data, setData] = useState<TiersResp | null>(null);
  const [draft, setDraft] = useState<Record<number, Tier>>({});
  const [draftMode, setDraftMode] = useState<Mode | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const load = () => {
    setErr('');
    fetch(`/api/sa/users/${userId}/item-tiers`, { headers: headers() })
      .then(r => r.json())
      .then(d => {
        if (!d.success) { setErr(d.error || 'تعذّر تحميل الفئات'); return; }
        setData(d);
        setDraftMode(d.ownMode);
        setDraft({});
      })
      .catch(() => setErr('تعذّر تحميل الفئات'));
  };
  useEffect(load, [userId]);

  // القائمة البيضاء إن وُجدت، وإلا كل كتالوج شركاته — نفس ما يعمل عليه فعلاً.
  const shown = useMemo(() => {
    const wl = new Set(whitelistIds);
    return wl.size ? items.filter(i => wl.has(i.id)) : items;
  }, [items, whitelistIds]);

  if (err) return <Note tone="warn">{err} <button onClick={load} style={softBtn('#dc2626')}>إعادة المحاولة</button></Note>;
  if (!data) return <Empty>جارٍ التحميل…</Empty>;

  const inheritedTier = (id: number): Tier => data.inherited[id]?.tier ?? 'main';
  const savedTier = (id: number): Tier => data.own[id] ?? inheritedTier(id);
  const tierOf = (id: number): Tier => draft[id] ?? savedTier(id);
  const setTier = (ids: number[], tier: Tier) => setDraft(prev => {
    const next = { ...prev };
    for (const id of ids) next[id] = tier;
    return next;
  });
  const hasParent = data.managers.length > 0 || !!data.inheritedMode || Object.keys(data.inherited).length > 0;

  const q = search.trim().toLowerCase();
  const filtered = shown.filter(i => !q || i.name.toLowerCase().includes(q));
  const groups = Object.entries(filtered.reduce<Record<string, CatalogItem[]>>((acc, i) => {
    (acc[i.companyName || '—'] ||= []).push(i);
    return acc;
  }, {}));

  const mainCount = shown.filter(i => tierOf(i.id) === 'main').length;
  const secCount = shown.length - mainCount;
  const dirty = draftMode !== data.ownMode || shown.some(i => tierOf(i.id) !== savedTier(i.id));
  const effectiveMode: Mode = draftMode ?? data.inheritedMode?.mode ?? data.defaultMode;

  const save = async () => {
    // ما يخالف الموروث فقط؛ ايتمات خارج القائمة المعروضة تبقى كما حُفظت.
    const shownIds = new Set(shown.map(i => i.id));
    const tiers: { itemId: number; tier: Tier }[] = [];
    for (const i of shown) if (tierOf(i.id) !== inheritedTier(i.id)) tiers.push({ itemId: i.id, tier: tierOf(i.id) });
    for (const [id, tier] of Object.entries(data.own)) if (!shownIds.has(Number(id))) tiers.push({ itemId: Number(id), tier });
    setSaving(true);
    try {
      const r = await fetch(`/api/sa/users/${userId}/item-tiers`, {
        method: 'PUT', headers: headers(), body: JSON.stringify({ mode: draftMode, tiers }),
      }).then(x => x.json());
      if (!r.success) throw new Error(r.error || 'فشل الحفظ');
      onToast('✅ حُفظت فئات الايتمات');
      load();
    } catch (e: any) {
      onToast(`❌ ${e.message || 'فشل الحفظ'}`, '#dc2626');
    } finally {
      setSaving(false);
    }
  };

  const modeBtn = (m: Mode | null, label: string, sub?: string) => {
    const on = draftMode === m;
    return (
      <button key={String(m)} onClick={() => setDraftMode(m)} style={{
        padding: '7px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'right',
        border: `1.5px solid ${on ? ACCENT : '#e2e8f0'}`, background: on ? '#eef2ff' : '#fff',
        color: on ? '#3730a3' : '#334155', fontWeight: on ? 800 : 600, fontSize: 12.5,
      }}>
        {label}
        {sub && <span style={{ display: 'block', fontSize: 11, fontWeight: 500, color: '#64748b', marginTop: 2 }}>{sub}</span>}
      </button>
    );
  };

  return (
    <div>
      <SectionHead
        icon="⭐"
        title="فئات الايتمات (رئيسية / ثانوية)"
        hint={<>اضغط على الايتم ليتحوّل بين <b>⭐ رئيسي</b> و<b>◽ ثانوي</b>. ما يُحدَّد هنا يرثه كل من تحت هذا الحساب (التيم ليدر ومندوبوه)، ويمكن تغيير ايتم لمندوب بعينه من حسابه.</>}
      />

      {hasParent && (
        <Note>
          يرث من: <b>{data.managers.map(m => m.name).join('، ') || '—'}</b>. الايتم المعلَّم بـ<b>●</b> مُغيَّر لهذا الحساب وحده.
        </Note>
      )}

      <div style={{ fontSize: 12.5, fontWeight: 800, color: '#334155', marginBottom: 6 }}>الايتمات الثانوية في التقارير:</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        {modeBtn(null, hasParent ? 'موروث' : 'الافتراضي',
          data.inheritedMode ? `${MODE_LABEL[data.inheritedMode.mode]}${data.inheritedMode.from ? ` — من ${data.inheritedMode.from}` : ''}` : MODE_LABEL[data.defaultMode])}
        {(['count', 'separate', 'hide'] as Mode[]).map(m => modeBtn(m, MODE_LABEL[m]))}
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>{MODE_HINT[effectiveMode]}</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: '#a16207' }}>⭐ {mainCount} رئيسي</span>
        <span style={{ color: '#cbd5e1' }}>|</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: '#475569' }}>◽ {secCount} ثانوي</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setTier(filtered.map(i => i.id), 'main')} style={softBtn('#a16207')}>⭐ الكل رئيسي</button>
        <button onClick={() => setTier(filtered.map(i => i.id), 'secondary')} style={softBtn('#475569')}>◽ الكل ثانوي</button>
        {hasParent && (
          <button onClick={() => setDraft(Object.fromEntries(shown.map(i => [i.id, inheritedTier(i.id)])))} style={softBtn(ACCENT)}>↺ إرجاع للموروث</button>
        )}
      </div>
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="🔍 بحث عن ايتم..."
        style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 10, fontSize: 13, marginBottom: 10 }}
      />

      {shown.length === 0 ? (
        <Empty>لا توجد ايتمات — عيّن شركات أو ايتمات لهذا المستخدم أولاً.</Empty>
      ) : (
        <ScrollList>
          {groups.length === 0 && <Empty>لا توجد ايتمات مطابقة</Empty>}
          {groups.map(([company, list]) => {
            const ids = list.map(i => i.id);
            return (
              <GroupCard
                key={company}
                icon="🏭"
                title={company}
                sel={ids.filter(id => tierOf(id) === 'main').length}
                total={ids.length}
                onToggleAll={on => setTier(ids, on ? 'main' : 'secondary')}
                forceOpen={!!q}
                defaultOpen={groups.length <= 3}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 5, padding: 8 }}>
                  {list.map(i => {
                    const t = tierOf(i.id);
                    const main = t === 'main';
                    const overridden = hasParent && t !== inheritedTier(i.id);
                    const changed = t !== savedTier(i.id);
                    return (
                      <button
                        key={i.id}
                        title={`${i.name} — ${main ? 'رئيسي' : 'ثانوي'}${overridden ? ' (مُغيَّر لهذا الحساب)' : hasParent ? ' (موروث)' : ''}`}
                        onClick={() => setTier([i.id], main ? 'secondary' : 'main')}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', borderRadius: 8, cursor: 'pointer',
                          textAlign: 'right', fontSize: 13, minWidth: 0,
                          background: main ? '#fefce8' : '#f1f5f9',
                          border: `1px ${changed ? 'dashed' : 'solid'} ${main ? '#fcd34d' : '#cbd5e1'}`,
                          color: main ? '#713f12' : '#64748b', fontWeight: main ? 700 : 500,
                        }}
                      >
                        <span style={{ flexShrink: 0 }}>{main ? '⭐' : '◽'}</span>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
                        {overridden && <span style={{ color: ACCENT, fontSize: 10, flexShrink: 0 }}>●</span>}
                      </button>
                    );
                  })}
                </div>
              </GroupCard>
            );
          })}
        </ScrollList>
      )}

      <SaveBar
        tone={dirty ? 'warn' : 'muted'}
        status={dirty ? 'تغييرات غير محفوظة' : `⭐ ${mainCount} رئيسي · ◽ ${secCount} ثانوي — ${MODE_LABEL[effectiveMode]}`}
        onSave={save}
        saving={saving}
        disabled={!dirty}
      />
    </div>
  );
}
