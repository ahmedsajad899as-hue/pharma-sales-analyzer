/**
 * نافذة تأكيد التطابق عند رفع ملف لصفحة «رصيد المذاخر» — تُعرض فقط حين توجد
 * أسماء (مذخر/ايتم/شركة) لم تُحسم تلقائياً (مرشّحان فأكثر مُلتبسان). المستخدم
 * يختار لكل اسم: أحد المرشّحين المقترحين، أو «ليس أي منها / جديد». الاختيار
 * يُحفظ دائماً (WarehouseNameLink / ItemMergeRule / StockCompanyNameLink) فلا
 * يتكرّر السؤال لاحقاً لنفس الاسم — نفس نظام «تحليل الزيارات» بالضبط.
 */
import { useState } from 'react';
import { Icon } from '../config/icons';

export interface WarehouseSuggestion { id: number; name: string; region: string; score: number }
export interface ItemSuggestion { id: number; name: string; sim: number }
export interface CompanySuggestion { id: number; name: string; score: number }
export interface PendingWarehouse { key: string; raw: string; region: string | null; suggestions: WarehouseSuggestion[] }
export interface PendingItem { key: string; raw: string; suggestions: ItemSuggestion[] }
export interface PendingCompany { key: string; raw: string; suggestions: CompanySuggestion[] }
export interface PendingMatches { warehouses: PendingWarehouse[]; items: PendingItem[]; companies: PendingCompany[] }

export const emptyPending = (): PendingMatches => ({ warehouses: [], items: [], companies: [] });
export const isPendingEmpty = (p: PendingMatches) => !p.warehouses.length && !p.items.length && !p.companies.length;

export interface StockNameChoices {
  warehouseChoices: { fromName: string; region: string | null; warehouseId: number | null }[];
  itemChoices: { fromName: string; toItemId: number }[];
  companyChoices: { fromName: string; companyId: number | null }[];
}

type Decision = { type: 'link'; id: number } | { type: 'new' };

export default function StockMovementImportModal(p: {
  pending: PendingMatches;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choices: StockNameChoices) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const get = (ns: string, key: string): Decision => decisions[`${ns}:${key}`] ?? { type: 'new' };
  const pick = (ns: string, key: string, d: Decision) => setDecisions(prev => ({ ...prev, [`${ns}:${key}`]: d }));

  const confirm = () => {
    const warehouseChoices = p.pending.warehouses.map(w => {
      const d = get('wh', w.key);
      return { fromName: w.raw, region: w.region, warehouseId: d.type === 'link' ? d.id : null };
    });
    const companyChoices = p.pending.companies.map(c => {
      const d = get('co', c.key);
      return { fromName: c.raw, companyId: d.type === 'link' ? d.id : null };
    });
    // الايتمات لا تدعم «مؤكَّد جديد» محفوظاً (محرّك التوحيد المشترك بكل التطبيق
    // لا يملك هذا المفهوم) — فقط قرارات الربط الفعلية تُرسَل لتُحفظ.
    const itemChoices = p.pending.items
      .map(it => { const d = get('item', it.key); return d.type === 'link' ? { fromName: it.raw, toItemId: d.id } : null; })
      .filter((x): x is { fromName: string; toItemId: number } => x !== null);
    p.onConfirm({ warehouseChoices, itemChoices, companyChoices });
  };

  const total = p.pending.warehouses.length + p.pending.items.length + p.pending.companies.length;

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div style={{ fontWeight: 700 }}>تأكيد أسماء مشكوك فيها ({total})</div>
            <div className="sl-hint">اختر التطابق الصحيح لكل اسم — سيُحفظ اختيارك ولن يُسأل عنه مرة أخرى.</div>
          </div>
          <button className="btn-icon btn-icon--red" onClick={p.onCancel}><Icon name="close" size={16} /></button>
        </div>
        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {p.pending.warehouses.length > 0 && (
            <PendingSection title="المذاخر">
              {p.pending.warehouses.map(w => (
                <PendingCard key={w.key} title={w.raw} subtitle={w.region || undefined}>
                  {w.suggestions.map(s => (
                    <Choice key={s.id}
                      label={`${s.name} — ${s.region}`} score={s.score}
                      checked={get('wh', w.key).type === 'link' && (get('wh', w.key) as { type: 'link'; id: number }).id === s.id}
                      onClick={() => pick('wh', w.key, { type: 'link', id: s.id })} />
                  ))}
                  <Choice label="ليس أي منها — مذخر جديد" checked={get('wh', w.key).type === 'new'}
                    onClick={() => pick('wh', w.key, { type: 'new' })} />
                </PendingCard>
              ))}
            </PendingSection>
          )}
          {p.pending.items.length > 0 && (
            <PendingSection title="الايتمات">
              {p.pending.items.map(it => (
                <PendingCard key={it.key} title={it.raw}>
                  {it.suggestions.map(s => (
                    <Choice key={s.id} label={s.name} score={s.sim}
                      checked={get('item', it.key).type === 'link' && (get('item', it.key) as { type: 'link'; id: number }).id === s.id}
                      onClick={() => pick('item', it.key, { type: 'link', id: s.id })} />
                  ))}
                  <Choice label="ليس أي منها — ايتم جديد" checked={get('item', it.key).type === 'new'}
                    onClick={() => pick('item', it.key, { type: 'new' })} />
                </PendingCard>
              ))}
            </PendingSection>
          )}
          {p.pending.companies.length > 0 && (
            <PendingSection title="الشركات">
              {p.pending.companies.map(c => (
                <PendingCard key={c.key} title={c.raw}>
                  {c.suggestions.map(s => (
                    <Choice key={s.id} label={s.name} score={s.score}
                      checked={get('co', c.key).type === 'link' && (get('co', c.key) as { type: 'link'; id: number }).id === s.id}
                      onClick={() => pick('co', c.key, { type: 'link', id: s.id })} />
                  ))}
                  <Choice label="ليست أياً منها — شركة جديدة" checked={get('co', c.key).type === 'new'}
                    onClick={() => pick('co', c.key, { type: 'new' })} />
                </PendingCard>
              ))}
            </PendingSection>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn--secondary btn--sm" onClick={p.onCancel} disabled={p.busy}>إلغاء</button>
          <button className="btn btn--primary btn--sm" onClick={confirm} disabled={p.busy}>
            {p.busy ? 'جارٍ الحفظ…' : 'تأكيد وحفظ'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PendingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="sl-review-sub" style={{ marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function PendingCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="table-wrapper sl-table-wrap" style={{ padding: 10 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        {title} {subtitle && <span className="sl-dim" style={{ fontWeight: 400 }}>— {subtitle}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function Choice({ label, score, checked, onClick }: { label: string; score?: number; checked: boolean; onClick: () => void }) {
  return (
    <label className="sl-review-line" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
      <input type="radio" checked={checked} onChange={onClick} />
      <span>{label}</span>
      {score !== undefined && <span className="sl-dim">({Math.round(score * 100)}%)</span>}
    </label>
  );
}
