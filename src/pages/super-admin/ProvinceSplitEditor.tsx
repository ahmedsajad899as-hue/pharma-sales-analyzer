// ════════════════════════════════════════════════════════════════════════════
// ProvinceSplitEditor — كيف يُقسَّم مبيع مقعد شركة بين مندوبيه داخل المحافظة.
// يظهر حين يكون للمقعد أكثر من مندوب. القاعدة في attributeLine (province-teams.rules.js).
// ════════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import type { ProvSplit, SeatOptions } from './ProvinceSeatsPanel';

type Mode = 'order' | 'item' | 'area' | 'customer';
type Scopes = Record<string, { areas?: string[]; customers?: string[] }>;

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'order', label: 'حسب من أرسل الطلبية', hint: 'كل مبيع لمن أرسله: ميركاتو باسمه ومبيعاته المؤكدة، أياً كان الايتم والمنطقة.' },
  { value: 'item', label: 'تقسيم بالايتمات', hint: 'كل ايتم لمندوبه. حدّد ايتمات كل مندوب من زر «المقاعد والايتمات».' },
  { value: 'area', label: 'تقسيم بالمناطق', hint: 'حدّد مناطق كل مندوب.' },
  { value: 'customer', label: 'تقسيم بالزبائن', hint: 'حدّد صيدليات كل مندوب.' },
];

interface Props {
  officeId: number;
  provinceId: number;
  managerUserId: number;
  reps: { userId: number; name: string }[];
  split: ProvSplit | undefined;
  options: SeatOptions | null;
  token: string | null;
  onSaved: () => void;
}

function NamePicker({ values, choices, placeholder, listId, onChange }: { values: string[]; choices: string[]; placeholder: string; listId: string; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.replace(/\s+/g, ' ').trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={draft} list={listId} placeholder={placeholder} autoComplete="off"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          style={{ flex: 1, minWidth: 0, padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 7, fontSize: 12, fontFamily: 'inherit' }} />
        <button type="button" className="ud-btn is-sm" onClick={add}>إضافة</button>
        <datalist id={listId}>{choices.map(c => <option key={c} value={c} />)}</datalist>
      </div>
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {values.map(v => (
            <button key={v} type="button" onClick={() => onChange(values.filter(x => x !== v))} title="إزالة"
              style={{ fontSize: 11, fontFamily: 'inherit', background: '#ecfeff', color: '#0e7490', border: '1px solid #a5f3fc', borderRadius: 14, padding: '1px 8px', cursor: 'pointer' }}>
              {v} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ProvinceSplitEditor({ officeId, provinceId, managerUserId, reps, split, options, token, onSaved }: Props) {
  const [mode, setMode] = useState<Mode>((split?.mode as Mode) ?? 'order');
  const [scopes, setScopes] = useState<Scopes>((split?.scopes as Scopes) ?? {});
  const [state, setState] = useState<{ busy: boolean; note: string; error: string }>({ busy: false, note: '', error: '' });
  const hint = MODES.find(m => m.value === mode)?.hint;
  const field = mode === 'area' ? 'areas' : 'customers';

  const save = async () => {
    setState({ busy: true, note: '', error: '' });
    try {
      const res = await fetch('/api/sa/users/province-structure/seat-split', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ officeId, provinceId, managerUserId, mode, scopes }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) { setState({ busy: false, note: '', error: j.error || 'تعذّر الحفظ' }); return; }
      setState({ busy: false, note: 'تم الحفظ', error: '' });
      onSaved();
    } catch {
      setState({ busy: false, note: '', error: 'تعذّر الاتصال بالخادم' });
    }
  };

  return (
    <div className="ud-split">
      <div className="ud-split-line">
        <span>حساب المبيع بين مندوبي المقعد:</span>
        <select value={mode} disabled={state.busy} aria-label="طريقة حساب المبيع" onChange={e => { setMode(e.target.value as Mode); setState(s => ({ ...s, note: '' })); }}>
          {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <button type="button" className="ud-btn is-sm" onClick={save} disabled={state.busy}>{state.busy ? 'جارٍ الحفظ...' : 'حفظ'}</button>
        {state.note && <span style={{ fontSize: 11.5, color: '#15803d', fontWeight: 700 }}>{state.note}</span>}
      </div>
      <div className="ud-split-hint">{hint}{mode !== 'order' && ' وما لا يطابق أحداً يبقى لمن أرسله.'}</div>
      {(mode === 'area' || mode === 'customer') && reps.map(r => (
        <div key={r.userId} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>{r.name}</span>
          <NamePicker
            values={scopes[r.userId]?.[field] ?? []}
            choices={(mode === 'area' ? options?.areas : options?.customers) ?? []}
            placeholder={mode === 'area' ? 'اسم المنطقة' : 'اسم الصيدلية'}
            listId={`split-${managerUserId}-${r.userId}-${mode}`}
            onChange={next => setScopes(s => ({ ...s, [r.userId]: { ...s[r.userId], [field]: next } }))} />
        </div>
      ))}
      {state.error && <div style={{ fontSize: 12, color: '#b91c1c', fontWeight: 600 }}>{state.error}</div>}
    </div>
  );
}
