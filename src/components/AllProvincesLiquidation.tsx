// ════════════════════════════════════════════════════════════════════════════
// AllProvincesLiquidation — «لكوديشن كل المحافظات» سطراً سطراً، من زر بجانب العملة في
// «مندوبين المحافظات». محافظة ← مندوب ← سطوره (كنافذة لكوديشن المندوب الواحد).
// GET /api/province-teams/all-lines: نفس سطور rep-lines لكل مندوب في جدول الأسماء، فمجموع
// المندوب = رقم «اللكوديشن» أمامه. الفترة: شهر الصفحة أو يوم واحد (اليوم افتراضاً بزرّه).
// الفلاتر (محافظة / مندوب / ايتم / بحث) في المتصفح. القيم بالدولار و fmtVal تحوّلها.
// ════════════════════════════════════════════════════════════════════════════

import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

interface Line {
  date: string; invoice: string; pharmacy: string; area: string; province: string; warehouse: string;
  itemId: number | null; item: string; company: string; quantity: number; bonus: number; usd: number; source: string;
  repUserId: number; repName: string; leaderName: string;
}

interface Props {
  token: string | null;
  fileIds: number[];
  applyMonth: (p: URLSearchParams) => void;
  fmtVal: (n: number) => string;
  currencyLabel: string;
  /** وصف فترة الصفحة (الشهر المختار) لاسم الملف وعنوان الصورة. */
  periodLabel?: string;
  onClose: () => void;
}

const nf = (n: number) => Math.round(n).toLocaleString('en-US');
const todayBaghdad = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
const SOURCE_STYLE: Record<string, React.CSSProperties> = {
  'ميركاتو':          { background: '#ede9fe', color: '#6d28d9', borderColor: '#c4b5fd' },
  'مبيعات المندوب':   { background: '#dcfce7', color: '#15803d', borderColor: '#86efac' },
  'إرجاع':            { background: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5' },
};
const DEFAULT_SOURCE: React.CSSProperties = { background: '#e0f2fe', color: '#0369a1', borderColor: '#7dd3fc' };
const COLS = 12;

type Sum = { qty: number; bonus: number; usd: number; orders: Set<string> };
const newSum = (): Sum => ({ qty: 0, bonus: 0, usd: 0, orders: new Set() });
const addTo = (s: Sum, r: Line) => { s.qty += r.quantity; s.bonus += r.bonus || 0; s.usd += r.usd; s.orders.add(r.invoice || `${r.date}|${r.pharmacy}`); };

export default function AllProvincesLiquidation({ token, fileIds, applyMonth, fmtVal, currencyLabel, periodLabel, onClose }: Props) {
  // '' = فترة الصفحة (الشهر المختار)، وإلا يوم واحد YYYY-MM-DD
  const [day, setDay] = useState<string>('');
  const [rows, setRows] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [province, setProvince] = useState('');
  const [repId, setRepId] = useState<number | ''>('');
  const [item, setItem] = useState('');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const today = todayBaghdad();
  const tableRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<'' | 'xlsx' | 'png'>('');

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true); setErr('');
    (async () => {
      try {
        const p = new URLSearchParams();
        if (day) p.set('day', day); else applyMonth(p);
        if (fileIds.length) p.set('fileIds', fileIds.join(','));
        const r = await fetch(`/api/province-teams/all-lines?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
        const j = await r.json();
        if (!r.ok || j.success === false) throw new Error(j.message || 'تعذّر تحميل اللكوديشن');
        setRows(j.rows ?? []);
      } catch (e: any) { if (e.name !== 'AbortError') setErr(e.message || 'تعذّر تحميل اللكوديشن'); }
      finally { if (!ac.signal.aborted) setLoading(false); }
    })();
    return () => ac.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  // خيارات الفلاتر من السطور المحمّلة (المندوب والايتم يتقيّدان بما فوقهما)
  const provinces = useMemo(() => [...new Set(rows.map(r => r.province))].sort((a, b) => a.localeCompare(b, 'ar')), [rows]);
  const reps = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) if (!province || r.province === province) m.set(r.repUserId, r.repName);
    return [...m].sort((a, b) => a[1].localeCompare(b[1], 'ar'));
  }, [rows, province]);
  const items = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if ((!province || r.province === province) && (repId === '' || r.repUserId === repId)) s.add(r.item);
    return [...s].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [rows, province, repId]);

  const shown = useMemo(() => {
    const s = q.trim();
    return rows.filter(r =>
      (!province || r.province === province) &&
      (repId === '' || r.repUserId === repId) &&
      (!item || r.item === item) &&
      (!s || [r.pharmacy, r.item, r.area, r.warehouse, r.invoice, r.company, r.source, r.date].some(x => (x || '').includes(s))));
  }, [rows, province, repId, item, q]);

  // محافظة ← مندوب، الأكبر قيمةً أولاً
  const groups = useMemo(() => {
    const byProv = new Map<string, { province: string; leader: string; sum: Sum; reps: Map<number, { repUserId: number; repName: string; sum: Sum; lines: Line[] }> }>();
    for (const r of shown) {
      let g = byProv.get(r.province);
      if (!g) { g = { province: r.province, leader: r.leaderName, sum: newSum(), reps: new Map() }; byProv.set(r.province, g); }
      addTo(g.sum, r);
      let rp = g.reps.get(r.repUserId);
      if (!rp) { rp = { repUserId: r.repUserId, repName: r.repName, sum: newSum(), lines: [] }; g.reps.set(r.repUserId, rp); }
      addTo(rp.sum, r); rp.lines.push(r);
    }
    return [...byProv.values()].sort((a, b) => b.sum.usd - a.sum.usd)
      .map(g => ({ ...g, reps: [...g.reps.values()].sort((a, b) => b.sum.usd - a.sum.usd) }));
  }, [shown]);
  const total = useMemo(() => { const s = newSum(); for (const r of shown) addTo(s, r); return s; }, [shown]);

  const toggle = (k: string) => setCollapsed(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allKeys = groups.flatMap(g => [`p:${g.province}`]);
  const anyOpen = allKeys.some(k => !collapsed.has(k));

  // وصف ما يُعرض: الفترة + الفلاتر — لاسم الملف وعنوان الصورة
  const period = day ? (day === today ? `اليوم ${day}` : day) : (periodLabel || 'الشهر المختار');
  const filterDesc = [province, repId !== '' ? reps.find(([id]) => id === repId)?.[1] : '', item, q.trim() ? `بحث «${q.trim()}»` : '']
    .filter(Boolean).join(' · ');
  const fileBase = `لكوديشن كل المحافظات - ${period}${filterDesc ? ` - ${filterDesc}` : ''}`.replace(/[\\/:*?"<>|]/g, '-').slice(0, 150);

  // ── إكسل: كل السطور المعروضة بعد الفلاتر (حتى المطوية)، مجمّعة كالشاشة + ورقة ملخص ──
  const exportExcel = async () => {
    if (busy || !shown.length) return;
    setBusy('xlsx');
    try {
      const XLSX = await import('xlsx-js-style');
      // fmtVal يحوّل لعملة العرض ويقرّب — نأخذ الرقم منه كي يطابق الملف الشاشة
      const toNum = (n: number) => Number(fmtVal(n).replace(/[^\d.-]/g, '')) || 0;
      const cur = currencyLabel;
      const border = { style: 'thin', color: { rgb: 'D5DCE6' } };
      const borders = { top: border, bottom: border, left: border, right: border };
      const head = ['المحافظة', 'التيم ليدر', 'المندوب', 'التاريخ', 'رقم الفاتورة', 'الصيدلية', 'المنطقة', 'المذخر', 'الايتم', 'الشركة', 'الكمية', 'البونص', `السعر (${cur})`, `القيمة (${cur})`, 'المصدر'];
      const NUM_COLS = [10, 11, 12, 13];
      type Kind = 'title' | 'head' | 'prov' | 'rep' | 'line' | 'total';
      const aoa: any[][] = [[`لكوديشن كل المحافظات — ${period}${filterDesc ? ` — ${filterDesc}` : ''}`], head];
      const kinds: Kind[] = ['title', 'head'];
      for (const g of groups) {
        aoa.push([g.province, g.leader, `${g.reps.length} مندوب`, '', '', `${g.sum.orders.size} طلبية`, '', '', '', '', g.sum.qty, g.sum.bonus || null, null, toNum(g.sum.usd), '']);
        kinds.push('prov');
        for (const rp of g.reps) {
          aoa.push([g.province, g.leader, rp.repName, '', '', `${rp.sum.orders.size} طلبية`, '', '', '', '', rp.sum.qty, rp.sum.bonus || null, null, toNum(rp.sum.usd), '']);
          kinds.push('rep');
          for (const r of rp.lines) {
            aoa.push([g.province, g.leader, rp.repName, r.date, r.invoice, r.pharmacy, r.area, r.warehouse, r.item, r.company,
              r.quantity, r.bonus || null, r.quantity ? toNum(r.usd / r.quantity) : null, toNum(r.usd), r.source]);
            kinds.push('line');
          }
        }
      }
      aoa.push(['المجموع', '', `${groups.length} محافظة`, '', '', `${total.orders.size} طلبية`, '', '', '', '', total.qty, total.bonus || null, null, toNum(total.usd), '']);
      kinds.push('total');

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [12, 16, 18, 11, 14, 24, 14, 20, 30, 12, 9, 8, 11, 14, 14].map(wch => ({ wch }));
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: head.length - 1 } }];
      const FILL: Partial<Record<Kind, string>> = { head: 'F1F5F9', prov: 'E8EEFB', rep: 'F5F3FB', total: 'E2E8F0' };
      const COLOR: Partial<Record<Kind, string>> = { prov: '1F4FB4', rep: '4C1D95' };
      aoa.forEach((row, ri) => {
        const kind = kinds[ri];
        for (let c = 0; c < head.length; c++) {
          const ref = XLSX.utils.encode_cell({ r: ri, c });
          if (!ws[ref]) { if (kind === 'title') continue; ws[ref] = { t: 's', v: '' }; }
          ws[ref].s = {
            font: { bold: kind !== 'line', sz: kind === 'title' ? 14 : 11, ...(COLOR[kind] && c <= 2 ? { color: { rgb: COLOR[kind] } } : {}) },
            ...(FILL[kind] ? { fill: { patternType: 'solid', fgColor: { rgb: FILL[kind] } } } : {}),
            alignment: { horizontal: NUM_COLS.includes(c) ? 'left' : 'right', vertical: 'center', readingOrder: 2 },
            ...(kind === 'title' ? {} : { border: borders }),
          };
          if (NUM_COLS.includes(c) && typeof row[c] === 'number') ws[ref].z = '#,##0';
        }
      });

      // ملخص: محافظة ← مندوب بمجموعه
      const s2: any[][] = [['المحافظة', 'التيم ليدر', 'المندوب', 'الطلبيات', 'السطور', 'الكمية', `القيمة (${cur})`]];
      const strongRows = new Set<number>([0]);
      for (const g of groups) {
        for (const rp of g.reps) s2.push([g.province, g.leader, rp.repName, rp.sum.orders.size, rp.lines.length, rp.sum.qty, toNum(rp.sum.usd)]);
        strongRows.add(s2.length);
        s2.push([`مجموع ${g.province}`, g.leader, `${g.reps.length} مندوب`, g.sum.orders.size, g.reps.reduce((a, x) => a + x.lines.length, 0), g.sum.qty, toNum(g.sum.usd)]);
      }
      strongRows.add(s2.length);
      s2.push(['المجموع الكلي', '', `${groups.length} محافظة`, total.orders.size, shown.length, total.qty, toNum(total.usd)]);
      const ws2 = XLSX.utils.aoa_to_sheet(s2);
      ws2['!cols'] = [18, 16, 20, 10, 10, 10, 16].map(wch => ({ wch }));
      s2.forEach((row, ri) => {
        const strong = strongRows.has(ri);
        for (let c = 0; c < 7; c++) {
          const ref = XLSX.utils.encode_cell({ r: ri, c });
          if (!ws2[ref]) ws2[ref] = { t: 's', v: '' };
          ws2[ref].s = {
            font: { bold: strong },
            ...(strong ? { fill: { patternType: 'solid', fgColor: { rgb: ri === 0 ? 'F1F5F9' : 'E8EEFB' } } } : {}),
            alignment: { horizontal: c >= 3 ? 'left' : 'right', readingOrder: 2 }, border: borders,
          };
          if (c >= 3 && typeof row[c] === 'number') ws2[ref].z = '#,##0';
        }
      });

      const wb = XLSX.utils.book_new();
      (wb as any).Workbook = { Views: [{ RTL: true }] };
      XLSX.utils.book_append_sheet(wb, ws, 'السطور');
      XLSX.utils.book_append_sheet(wb, ws2, 'الملخص');
      XLSX.writeFile(wb, `${fileBase}.xlsx`);
    } catch (e: any) { alert(e?.message || 'تعذّر تصدير الإكسل'); }
    finally { setBusy(''); }
  };

  // ── صورة: الجدول كما يظهر (المطوي يبقى مطوياً) مع عنوان الفترة والفلاتر ──
  const exportImage = async () => {
    const src = tableRef.current?.querySelector('table');
    if (busy || !src) return;
    setBusy('png');
    const wrap = document.createElement('div');
    wrap.setAttribute('dir', 'rtl');
    wrap.style.cssText = `position:fixed;top:0;left:-99999px;background:#fff;padding:16px;font-family:Arial,Tahoma,sans-serif;width:${src.scrollWidth + 32}px;box-sizing:border-box;`;
    const title = document.createElement('div');
    title.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:10px;color:#0f172a;';
    const left = document.createElement('div');
    const t1 = document.createElement('div');
    t1.style.cssText = 'font-size:18px;font-weight:900;';
    t1.textContent = `لكوديشن كل المحافظات — ${period}`;
    const t2 = document.createElement('div');
    t2.style.cssText = 'font-size:12.5px;color:#64748b;margin-top:2px;';
    t2.textContent = filterDesc || 'كل المحافظات والمندوبين والايتمات';
    left.append(t1, t2);
    const stats = document.createElement('div');
    stats.style.cssText = 'font-size:13px;font-weight:700;color:#334155;';
    stats.textContent = `${nf(groups.length)} محافظة · ${nf(total.orders.size)} طلبية · ${nf(shown.length)} سطر · ${fmtVal(total.usd)} ${currencyLabel}`;
    title.append(left, stats);
    wrap.appendChild(title);
    const clone = src.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('th').forEach(el => { (el as HTMLElement).style.position = 'static'; });
    wrap.appendChild(clone);
    document.body.appendChild(wrap);
    try {
      // حدّ ارتفاع الكانفس في المتصفحات ~32 ألف بكسل: نصغّر الدقة للجداول الطويلة
      const scale = Math.min(2, 30000 / wrap.offsetHeight);
      if (scale < 0.6) throw new Error('النتائج أطول من أن تُحفظ صورةً واحدة — اطوِ بعض المحافظات/المندوبين أو اختر فلتراً ثم أعد المحاولة (أو صدّر إكسل).');
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(wrap, { backgroundColor: '#ffffff', scale, useCORS: true, logging: false, width: wrap.offsetWidth, windowWidth: wrap.offsetWidth });
      const blob: Blob | null = await new Promise(res => canvas.toBlob(b => res(b), 'image/png'));
      if (!blob) throw new Error('تعذّر إنشاء الصورة');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${fileBase}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e: any) { alert(e?.message || 'تعذّر حفظ الصورة'); }
    finally { wrap.remove(); setBusy(''); }
  };

  const th: React.CSSProperties = { padding: '8px 8px', fontSize: 12, fontWeight: 800, color: '#334155', background: '#f1f5f9', borderBottom: '1px solid #cbd5e1', textAlign: 'right', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2 };
  const td: React.CSSProperties = { padding: '6px 8px', fontSize: 12.5, color: '#0f172a', borderBottom: '1px solid #eef2f7', whiteSpace: 'nowrap' };
  const num: React.CSSProperties = { ...td, textAlign: 'left', direction: 'ltr', fontVariantNumeric: 'tabular-nums' };
  const dash = <span style={{ color: '#cbd5e1' }}>—</span>;
  const sel: React.CSSProperties = { border: '1px solid #cbd5e1', borderRadius: 999, padding: '6px 10px', fontSize: 12.5, background: '#fff', maxWidth: 220 };
  const chip = (on: boolean): React.CSSProperties => ({ border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12.5, cursor: 'pointer', background: on ? '#fff' : 'transparent', color: on ? '#0f172a' : '#64748b', fontWeight: on ? 800 : 600, boxShadow: on ? '0 1px 2px rgba(0,0,0,.08)' : 'none' });
  const sumLine = (s: Sum) => (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'baseline', fontSize: 12, color: '#475569', fontWeight: 700 }}>
      <span>{nf(s.orders.size)} طلبية</span>
      <span>· كمية {nf(s.qty)}</span>
      <bdi dir="ltr" style={{ fontWeight: 900, color: s.usd < 0 ? '#be123c' : '#0f766e', fontSize: 13 }}>{fmtVal(s.usd)} {currencyLabel}</bdi>
    </span>
  );

  return (
    <div dir="rtl" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: 'min(1500px, 100%)', height: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(15,23,42,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 8px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: '#0f172a' }}>لكوديشن كل المحافظات</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>كل مندوب: مبيعاته المؤكدة + ميركاتو وملف اللكوديشن باسمه، بلا تكرار</div>
          </div>
          <span style={{ flex: 1 }} />
          {!loading && !err && (
            <span style={{ fontSize: 12.5, color: '#334155', fontWeight: 700 }}>
              {nf(groups.length)} محافظة · {nf(total.orders.size)} طلبية · {nf(shown.length)} سطر · <bdi dir="ltr">{fmtVal(total.usd)} {currencyLabel}</bdi>
            </span>
          )}
          <button type="button" onClick={onClose} style={{ border: 'none', background: '#f1f5f9', borderRadius: 999, width: 32, height: 32, cursor: 'pointer', fontSize: 16 }} aria-label="إغلاق">✕</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 10px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', gap: 2, background: '#f1f5f9', borderRadius: 8, padding: 2 }}>
            <button type="button" style={chip(day === '')} onClick={() => setDay('')} title="كل أيام الشهر المختار في الصفحة">كل الأيام</button>
            <button type="button" style={chip(day === today)} onClick={() => setDay(today)}>اليوم</button>
          </div>
          <input type="date" value={day} max={today} onChange={e => setDay(e.target.value)} title="يوم معيّن"
            style={{ ...sel, padding: '5px 10px', direction: 'ltr' }} />
          <select value={province} onChange={e => { setProvince(e.target.value); setRepId(''); setItem(''); }} style={sel}>
            <option value="">كل المحافظات</option>
            {provinces.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={repId === '' ? '' : String(repId)} onChange={e => { setRepId(e.target.value ? Number(e.target.value) : ''); setItem(''); }} style={sel}>
            <option value="">كل المندوبين</option>
            {reps.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={item} onChange={e => setItem(e.target.value)} style={{ ...sel, direction: item ? 'ltr' : 'rtl' }}>
            <option value="">كل الايتمات</option>
            {items.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="بحث: صيدلية / منطقة / مذخر / فاتورة"
            style={{ ...sel, flex: 1, minWidth: 180, maxWidth: 'none', padding: '6px 14px' }} />
          {(province || repId !== '' || item || q) && (
            <button type="button" onClick={() => { setProvince(''); setRepId(''); setItem(''); setQ(''); }}
              style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#475569', cursor: 'pointer' }}>مسح الفلاتر</button>
          )}
          {groups.length > 1 && (
            <button type="button" onClick={() => setCollapsed(anyOpen ? new Set(allKeys) : new Set())}
              style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#475569', cursor: 'pointer' }}>{anyOpen ? 'طيّ الكل' : 'فتح الكل'}</button>
          )}
          <button type="button" onClick={exportExcel} disabled={!!busy || loading || !shown.length} title="كل السطور المعروضة بعد الفلاتر (مع المطوية) + ورقة ملخص لكل مندوب"
            style={{ border: '1px solid #86efac', background: '#f0fdf4', color: '#15803d', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 800, cursor: busy || !shown.length ? 'default' : 'pointer', opacity: busy && busy !== 'xlsx' ? 0.5 : 1, whiteSpace: 'nowrap' }}>
            {busy === 'xlsx' ? 'جاري التصدير…' : '⬇ إكسل'}
          </button>
          <button type="button" onClick={exportImage} disabled={!!busy || loading || !shown.length} title="صورة PNG للجدول كما يظهر الآن (المطوي يبقى مطوياً)"
            style={{ border: '1px solid #c4b5fd', background: '#f5f3ff', color: '#6d28d9', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 800, cursor: busy || !shown.length ? 'default' : 'pointer', opacity: busy && busy !== 'png' ? 0.5 : 1, whiteSpace: 'nowrap' }}>
            {busy === 'png' ? 'جاري الحفظ…' : '🖼 صورة'}
          </button>
        </div>

        <div ref={tableRef} style={{ flex: 1, overflow: 'auto', padding: '0 12px 12px' }}>
          {loading && <div style={{ color: '#64748b', padding: 24, textAlign: 'center' }}>جاري التحميل…</div>}
          {err && <div style={{ color: '#be123c', padding: 12 }}>{err}</div>}
          {!loading && !err && shown.length === 0 && (
            <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>
              {rows.length ? 'لا نتائج لهذه الفلاتر.' : day ? `لا يوجد لكوديشن يوم ${day}.` : 'لا يوجد لكوديشن للفترة المختارة.'}
            </div>
          )}
          {!loading && !err && shown.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>التاريخ</th>
                  <th style={th}>رقم الفاتورة</th>
                  <th style={th}>الصيدلية</th>
                  <th style={th}>المنطقة</th>
                  <th style={th}>المذخر</th>
                  <th style={th}>الايتم</th>
                  <th style={th}>الشركة</th>
                  <th style={{ ...th, textAlign: 'left' }}>الكمية</th>
                  <th style={{ ...th, textAlign: 'left' }}>البونص</th>
                  <th style={{ ...th, textAlign: 'left' }}>السعر</th>
                  <th style={{ ...th, textAlign: 'left' }}>القيمة ({currencyLabel})</th>
                  <th style={th}>المصدر</th>
                </tr>
              </thead>
              {groups.map(g => {
                const pk = `p:${g.province}`;
                const pOpen = !collapsed.has(pk);
                return (
                  <tbody key={pk}>
                    <tr onClick={() => toggle(pk)} style={{ cursor: 'pointer' }}>
                      <td colSpan={COLS} style={{ padding: '9px 10px', background: '#e8eefb', borderTop: '2px solid #c7d4f0', borderBottom: '1px solid #c7d4f0' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 15, fontWeight: 900, color: '#1f4fb4' }}>{pOpen ? '▾' : '◂'} {g.province}</span>
                          {g.leader && <span style={{ fontSize: 12, color: '#475569' }}>التيم ليدر: <b>{g.leader}</b></span>}
                          <span style={{ fontSize: 12, color: '#64748b' }}>{nf(g.reps.length)} مندوب</span>
                          <span style={{ flex: 1 }} />
                          {sumLine(g.sum)}
                        </span>
                      </td>
                    </tr>
                    {pOpen && g.reps.map(rp => {
                      const rk = `r:${g.province}|${rp.repUserId}`;
                      const rOpen = !collapsed.has(rk);
                      return [
                        <tr key={rk} onClick={() => toggle(rk)} style={{ cursor: 'pointer' }}>
                          <td colSpan={COLS} style={{ padding: '7px 10px 7px 10px', paddingRight: 22, background: '#f5f3fb', borderBottom: '1px solid #e4e0f2' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 13.5, fontWeight: 800, color: '#4c1d95' }}>{rOpen ? '▾' : '◂'} {rp.repName}</span>
                              <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{nf(rp.lines.length)} سطر</span>
                              <span style={{ flex: 1 }} />
                              {sumLine(rp.sum)}
                            </span>
                          </td>
                        </tr>,
                        ...(rOpen ? rp.lines.map((r, i) => (
                          <tr key={`${rk}#${i}`} style={{ background: i % 2 ? '#fbfcfe' : '#fff' }}>
                            <td style={{ ...num, textAlign: 'right' }}>{r.date || dash}</td>
                            <td style={{ ...td, direction: 'ltr', textAlign: 'right' }}>{r.invoice || dash}</td>
                            <td style={{ ...td, whiteSpace: 'normal', minWidth: 140 }}>{r.pharmacy || dash}</td>
                            <td style={td}>{r.area || dash}</td>
                            <td style={{ ...td, whiteSpace: 'normal' }}>{r.warehouse || dash}</td>
                            <td style={{ ...td, direction: 'ltr', textAlign: 'right', fontWeight: 600 }}>{r.item || dash}</td>
                            <td style={{ ...td, color: '#64748b' }}>{r.company || dash}</td>
                            <td style={{ ...num, color: r.quantity < 0 ? '#be123c' : undefined }}>{nf(r.quantity)}</td>
                            <td style={num}>{r.bonus ? nf(r.bonus) : dash}</td>
                            <td style={num}>{r.quantity ? fmtVal(r.usd / r.quantity) : dash}</td>
                            <td style={{ ...num, fontWeight: 700, color: r.usd < 0 ? '#be123c' : undefined }}>{fmtVal(r.usd)}</td>
                            <td style={td}>
                              <span style={{ border: '1px solid', borderRadius: 6, padding: '1px 8px', fontSize: 11.5, fontWeight: 700, ...(SOURCE_STYLE[r.source] ?? DEFAULT_SOURCE) }}>{r.source}</span>
                            </td>
                          </tr>
                        )) : []),
                      ];
                    })}
                  </tbody>
                );
              })}
              <tfoot>
                <tr style={{ fontWeight: 900 }}>
                  <td colSpan={7} style={{ ...td, background: '#f1f5f9', borderTop: '2px solid #cbd5e1', textAlign: 'center' }}>المجموع — {nf(total.orders.size)} طلبية</td>
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>{nf(total.qty)}</td>
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>{total.bonus ? nf(total.bonus) : ''}</td>
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }} />
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>{fmtVal(total.usd)}</td>
                  <td style={{ ...td, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }} />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
