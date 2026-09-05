import { useEffect, useMemo, useRef, useState } from 'react';

// نافذة كبيرة لاختيار ايتم من الكتالوج (بدل القائمة المنسدلة الصغيرة تحت حقل الإدخال).
// تُستخدم في صفحة «الحساب» — تفتح عند الضغط على حقل اسم الايتم.
interface PickerItem {
  id: number;
  name: string;
  price?: number | null;
  company?: { id: number; name: string } | null;
  scientificCompany?: { id: number; name: string } | null;
}

interface ItemPickerModalProps {
  items: PickerItem[];
  currentName?: string;
  onSelect: (item: PickerItem) => void;
  onCustom: (name: string) => void;
  onClose: () => void;
}

export default function ItemPickerModal({ items, currentName, onSelect, onCustom, onClose }: ItemPickerModalProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(it =>
      it.name.toLowerCase().includes(q) ||
      it.company?.name?.toLowerCase().includes(q) ||
      it.scientificCompany?.name?.toLowerCase().includes(q)
    );
  }, [items, query]);

  const exactMatch = items.some(it => it.name.trim().toLowerCase() === query.trim().toLowerCase());

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} dir="rtl" style={{ background: '#fff', borderRadius: 16, width: 'min(640px, 96vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px 12px', borderBottom: '1px solid #f1f5f9' }}>
          <span style={{ fontWeight: 800, fontSize: 15, color: '#1e293b' }}>اختر الايتم</span>
          <span style={{ marginRight: 'auto', fontSize: 11, color: '#94a3b8' }}>{filtered.length} من {items.length}</span>
          <button onClick={onClose} style={{ border: 'none', background: '#f1f5f9', color: '#64748b', borderRadius: 8, width: 28, height: 28, cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '12px 18px' }}>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && query.trim() && !exactMatch) { onCustom(query.trim()); onClose(); }
            }}
            placeholder="ابحث باسم الايتم أو الشركة..."
            style={{ width: '100%', padding: '10px 14px', borderRadius: 10, border: '1.5px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '0 10px 10px' }}>
          {query.trim() && !exactMatch && (
            <div
              onClick={() => { onCustom(query.trim()); onClose(); }}
              style={{ padding: '10px 12px', margin: '2px 8px 8px', borderRadius: 8, cursor: 'pointer', background: '#fffbeb', border: '1px dashed #fbbf24', color: '#92400e', fontSize: 12.5, fontWeight: 600 }}
            >
              ➕ استخدام «{query.trim()}» كاسم غير مدرج بالقائمة
            </div>
          )}
          {filtered.map(it => {
            const companyName = it.scientificCompany?.name || it.company?.name || '';
            const selected = currentName?.trim() === it.name.trim();
            return (
              <div
                key={it.id}
                onClick={() => { onSelect(it); onClose(); }}
                style={{
                  padding: '10px 12px', margin: '2px 8px', borderRadius: 8, cursor: 'pointer',
                  background: selected ? '#eff6ff' : 'transparent',
                  border: selected ? '1px solid #bfdbfe' : '1px solid transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                }}
                onMouseEnter={e => { if (!selected) e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>{it.name}</div>
                  {companyName && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{companyName}</div>}
                </div>
                {it.price != null && <div style={{ fontSize: 11.5, fontWeight: 700, color: '#047857', whiteSpace: 'nowrap' }}>{it.price.toLocaleString('ar-IQ')}</div>}
              </div>
            );
          })}
          {filtered.length === 0 && !query.trim() && (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>لا توجد ايتمات بالكتالوج</div>
          )}
          {filtered.length === 0 && query.trim() && (
            <div style={{ textAlign: 'center', padding: '16px 0 30px', color: '#cbd5e1', fontSize: 12 }}>لا توجد نتائج مطابقة بالكتالوج</div>
          )}
        </div>
      </div>
    </div>
  );
}
