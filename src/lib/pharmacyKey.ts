// نسخة الواجهة من مفتاح مطابقة الصيدليات — يجب أن تبقى مطابقة حرفياً لـ
// server/lib/pharmacyKey.js (تغطيها scripts/test-pharmacy-key.mjs).

const GENERIC_TOKENS = new Set(['صيدليه', 'صيدلي', 'ص', 'مكتب', 'مذخر']);

export function pharmacyKey(name: string | null | undefined): string {
  const s = String(name ?? '')
    .trim()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ء/g, '')
    .replace(/[ً-ٟ]/g, '')
    .replace(/ـ/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map(t => (t.length > 3 && t.startsWith('ال') ? t.slice(2) : t))
    .filter(t => !GENERIC_TOKENS.has(t))
    .join(' ');
}

export interface NetPharmacyLike {
  name: string;
  key?: string;
  areaName?: string | null;
}

/**
 * مطابقة اسم صيدلية (من الطبيب/السيرفي) مع قائمة صيدليات المبيع.
 * exact = تطابق تام على المفتاح، similar = صيدليات يحتوي مفتاحها المفتاح أو العكس
 * (مرشّحون للدمج). إن وُجدت منطقة تُقيَّد المقارنة بصيدليات تلك المنطقة أولاً.
 */
export function matchNetPharmacies<T extends NetPharmacyLike>(
  list: T[], pharmName: string, areaName?: string | null,
): { exact: T | null; similar: T[] } {
  const q = pharmacyKey(pharmName);
  const keyOf = (p: T) => p.key ?? pharmacyKey(p.name);
  const exact = q ? (list.find(p => keyOf(p) === q) ?? null) : null;
  const areaKey = areaName ? pharmacyKey(areaName) : '';
  const pool = areaKey ? list.filter(p => pharmacyKey(p.areaName ?? '') === areaKey) : list;
  const similar = q
    ? pool.filter(p => { const n = keyOf(p); return n !== q && n !== '' && (n.includes(q) || q.includes(n)); }).slice(0, 6)
    : [];
  return { exact, similar };
}
