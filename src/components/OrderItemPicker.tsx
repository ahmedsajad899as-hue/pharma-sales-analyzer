// OrderItemPicker — اختيار الايتمات بمربعات اختيار، عدة ايتمات دفعة واحدة ثم الكميات.
// مشترك بين «طلبيات المذاخر» و«مبيعات المندوبين». أصنافه ro- في RepOrdersPage.css.

import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';

export interface CatalogItem { id: number; name: string; company?: { name: string } | null; scientificCompany?: { name: string } | null }

export const itemCompany = (i: CatalogItem) => i.scientificCompany?.name ?? i.company?.name ?? null;
const itemLabel = (i: CatalogItem) => (itemCompany(i) ? `${i.name} — ${itemCompany(i)}` : i.name);

// البحث الذكي يطبّع الهمزات والتاء المربوطة والياء والتشكيل
export const normSearch = (v: unknown) => String(v ?? '').toLowerCase()
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ً-ْـ]/g, '');

export function ItemPicker({ items, have, onAdd, onClose }: {
  items: CatalogItem[]; have: Set<number>;
  onAdd: (picked: CatalogItem[], freeText: string | null) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const terms = useMemo(() => normSearch(q).split(/\s+/).filter(Boolean), [q]);
  const list = useMemo(() => items.filter(i => !terms.length || terms.every(t => normSearch(itemLabel(i)).includes(t))).slice(0, 300), [items, terms]);
  const typed = q.trim();
  const exists = typed && items.some(i => normSearch(i.name) === normSearch(typed));
  const toggle = (id: number) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const picked = () => items.filter(i => sel.has(i.id));

  // زر الرجوع يغلق القائمة وحدها لا نموذج الطلبية: مستمع capture يسبق مستمع الصفحة
  useEffect(() => {
    const onBack = (e: Event) => { e.preventDefault(); onClose(); };
    window.addEventListener('before-navigate-back', onBack, true);
    return () => window.removeEventListener('before-navigate-back', onBack, true);
  }, [onClose]);

  return (
    <div className="ro-modal" onClick={onClose}>
      <div className="ro-dialog ro-dialog--narrow" onClick={e => e.stopPropagation()}>
        <div className="ro-dialog__head">
          <strong>اختيار الايتمات</strong>
          <button className="ro-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ro-dialog__body">
          <input className="form-input" type="search" autoFocus value={q} onChange={e => setQ(e.target.value)} aria-label="بحث" />
          <div className="ro-ipick">
            {list.map(i => {
              const done = have.has(i.id);
              const on = sel.has(i.id);
              return (
                <label key={i.id} className={`ro-ipick__row ${on ? 'is-on' : ''} ${done ? 'is-done' : ''}`}>
                  <input type="checkbox" checked={on || done} disabled={done} onChange={() => toggle(i.id)} />
                  <span className="ro-strong">{i.name}</span>
                  {itemCompany(i) && <span className="ro-muted ro-small">{itemCompany(i)}</span>}
                </label>
              );
            })}
            {!list.length && <div className="ro-muted ro-ipick__empty">لا نتائج</div>}
          </div>
          {typed && !exists && (
            <button className="ro-link ro-self-start" onClick={() => onAdd(picked(), typed)}><Plus size={13} /> إضافة «{typed}» كايتم غير موجود بالقائمة</button>
          )}
        </div>
        <div className="ro-dialog__foot">
          <button className="btn btn--primary" disabled={!sel.size} onClick={() => onAdd(picked(), null)}>إضافة{sel.size ? ` ${sel.size}` : ''}</button>
          <button className="btn btn--secondary" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}
