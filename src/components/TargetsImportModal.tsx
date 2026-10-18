import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { fuzzyItemMatch, normalizeItemName, similarity } from '../utils/itemNameMatch';

/**
 * استيراد التارگت الشهري من إكسل وتعميمه على كل المندوبين أو قسم منهم.
 *
 * صيغ الملف المقبولة (أول عمود يُعرَف بعنوانه «الايتم/المادة/الصنف…»):
 *  1) عمود «التارگت» عام  → يُطبَّق على المندوبين المختارين في النافذة (الكل أو بعضهم).
 *  2) عمود لكل مندوب باسمه → قيمته لذلك المندوب تحديداً (تتقدّم على العمود العام).
 *  3) صيغة طولية: «المندوب | الايتم | التارگت» صف لكل مندوب×ايتم.
 * يمكن خلط 1 و2 في نفس الملف. الخلية الفارغة لا تمسّ التارگت المحفوظ؛ الصفر يُكتب صفراً.
 * الحفظ upsert عبر PUT /api/targets لكل مندوب — الايتمات غير المذكورة في الملف تبقى كما هي.
 */

const API = import.meta.env.VITE_API_URL || '';

interface NamedItem { id: number; name: string; }
interface RepLite { id: number; name: string; }

interface Props {
  repType: 'scientific' | 'commercial';
  reps: RepLite[];
  allItems: NamedItem[];
  month: number;
  year: number;
  monthLabel: string;
  token: string | null;
  onClose: () => void;
  onDone: () => void;
}

const ITEM_HDR    = ['الايتم', 'ايتم', 'المادة', 'ماده', 'اسم المادة', 'الصنف', 'صنف', 'المنتج', 'اسم الايتم', 'item', 'items', 'product', 'item name'];
const REP_HDR     = ['المندوب', 'مندوب', 'اسم المندوب', 'rep', 'representative', 'rep name'];
// عمود مرجعي في النموذج — يُتجاهل عند القراءة (لا يُحسب مندوباً ولا تارگت)
const COMPANY_HDR = ['الشركة', 'شركة', 'اسم الشركة', 'company', 'company name'];
const TARGET_HDR  = ['التارگت', 'التاركت', 'التارجت', 'تارگت', 'تاركت', 'الهدف', 'هدف', 'target', 'الكل', 'للكل', 'الكمية', 'كمية', 'qty', 'quantity'];

/** تطبيع عربي/لاتيني خفيف لمطابقة العناوين وأسماء المندوبين. */
function norm(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/گ/g, 'ك')
    .replace(/ـ/g, '').replace(/[ً-ٟ]/g, '')
    .replace(/[()[\]\-–—_.,،/\\:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const hdrIs = (h: string, list: string[]) => {
  const n = norm(h);
  return list.some(a => {
    const an = norm(a);
    return n === an || n.startsWith(an + ' ') || n.endsWith(' ' + an);
  });
};
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/,/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function matchRep(name: string, reps: RepLite[]): RepLite | null {
  const n = norm(name);
  if (!n) return null;
  const exact = reps.find(r => norm(r.name) === n);
  if (exact) return exact;
  // «أحمد علي/ الكرادة ph» ↔ «أحمد علي»: يطابق إن كان أحدهما يبدأ بالآخر بشكل فريد
  const pref = reps.filter(r => { const rn = norm(r.name); return rn.startsWith(n + ' ') || n.startsWith(rn + ' '); });
  return pref.length === 1 ? pref[0] : null;
}

function makeItemMatcher(items: NamedItem[]) {
  const byNorm = new Map<string, NamedItem>();
  for (const it of items) { const k = normalizeItemName(it.name); if (!byNorm.has(k)) byNorm.set(k, it); }
  return (raw: string): NamedItem | null => {
    const n = normalizeItemName(raw);
    if (!n) return null;
    const exact = byNorm.get(n);
    if (exact) return exact;
    let best: NamedItem | null = null; let bestScore = -1;
    for (const it of items) {
      if (!fuzzyItemMatch(raw, it.name)) continue;
      const sc = similarity(n, normalizeItemName(it.name));
      if (sc > bestScore) { bestScore = sc; best = it; }
    }
    return best;
  };
}

interface Parsed {
  generic: Map<number, number>;                    // itemId → target (للمندوبين المختارين)
  perRep: Map<number, Map<number, number>>;        // repId → itemId → target
  itemNames: Map<number, string>;
  unmatchedItems: string[];
  unmatchedReps: string[];
  ignoredCols: string[];
  rowCount: number;
}

function parseSheet(rows: unknown[][], reps: RepLite[], items: NamedItem[]): Parsed | string {
  // اكتشاف صف العناوين (قد يسبقه عنوان/شعار)
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if ((rows[i] || []).some(c => typeof c === 'string' && hdrIs(c, ITEM_HDR))) { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) return 'لم يُعثر على عمود الايتم — يجب أن يحمل عنواناً مثل «الايتم» أو «المادة».';
  const hdr = (rows[hdrIdx] || []).map(c => String(c ?? '').trim());

  const itemCol = hdr.findIndex(h => hdrIs(h, ITEM_HDR));
  const repCol = hdr.findIndex((h, i) => i !== itemCol && hdrIs(h, REP_HDR));
  const genericCol = hdr.findIndex((h, i) => i !== itemCol && i !== repCol && hdrIs(h, TARGET_HDR));
  const repCols: { col: number; rep: RepLite }[] = [];
  const unmatchedReps: string[] = [];
  const ignoredCols: string[] = [];

  if (repCol < 0) {
    hdr.forEach((h, i) => {
      if (!h || i === itemCol || i === genericCol || hdrIs(h, COMPANY_HDR)) return;
      if (/^(#|ت|م|تسلسل|الرقم|no)$/i.test(norm(h))) return;
      const rep = matchRep(h, reps);
      if (rep) repCols.push({ col: i, rep });
      else ignoredCols.push(h);
    });
  }
  if (genericCol < 0 && repCols.length === 0)
    return 'لم يُعثر على عمود تارگت — أضف عموداً بعنوان «التارگت» أو أعمدة بأسماء المندوبين.';
  if (repCol >= 0 && genericCol < 0)
    return 'الصيغة الطولية تحتاج عمود «التارگت» بجانب «المندوب» و«الايتم».';

  const match = makeItemMatcher(items);
  const generic = new Map<number, number>();
  const perRep = new Map<number, Map<number, number>>();
  const itemNames = new Map<number, string>();
  const unmatchedItems = new Set<string>();
  const unmatchedRepSet = new Set<string>();
  let rowCount = 0;
  const put = (repId: number, itemId: number, v: number) => {
    if (!perRep.has(repId)) perRep.set(repId, new Map());
    perRep.get(repId)!.set(itemId, v);
  };

  for (let r = hdrIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const rawItem = String(row[itemCol] ?? '').trim();
    if (!rawItem || /^(الاجمالي|الإجمالي|المجموع|total)$/i.test(rawItem)) continue;
    const it = match(rawItem);
    if (!it) { unmatchedItems.add(rawItem); continue; }
    itemNames.set(it.id, it.name);
    rowCount++;

    if (repCol >= 0) {
      const v = toNum(row[genericCol]);
      if (v === null) continue;
      const repName = String(row[repCol] ?? '').trim();
      if (!repName) { generic.set(it.id, v); continue; }
      const rep = matchRep(repName, reps);
      if (rep) put(rep.id, it.id, v); else unmatchedRepSet.add(repName);
      continue;
    }
    if (genericCol >= 0) {
      const v = toNum(row[genericCol]);
      if (v !== null) generic.set(it.id, v);
    }
    for (const { col, rep } of repCols) {
      const v = toNum(row[col]);
      if (v !== null) put(rep.id, it.id, v);
    }
  }
  unmatchedRepSet.forEach(n => unmatchedReps.push(n));
  // أعمدة لم تطابق مندوباً تُعرض كتحذير (في الصيغة العرضية)
  return { generic, perRep, itemNames, unmatchedItems: [...unmatchedItems], unmatchedReps: [...unmatchedReps, ...ignoredCols], ignoredCols, rowCount };
}

export default function TargetsImportModal({ repType, reps, allItems, month, year, monthLabel, token, onClose, onDone }: Props) {
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const items = useMemo(() => allItems.filter(i => !i.name.includes('(مؤقت)')), [allItems]);

  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set(reps.map(r => r.id)));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<string | null>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null); setParsed(null); setResult(null); setFileName(f.name);
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
      const p = parseSheet(rows, reps, items);
      if (typeof p === 'string') setError(p); else setParsed(p);
    } catch (e: any) {
      setError(`تعذّرت قراءة الملف: ${e?.message || e}`);
    }
  };

  const [downloading, setDownloading] = useState(false);

  /**
   * النموذج = شركات المستخدم المعيّنة وايتماته فقط (مدير الشركة: ايتماته؛ الأدوار
   * المكتبية كـ HR: كل شركات المكتب وايتماتها) عبر /api/items/assigned-scope — لا
   * القائمة الواسعة allItems التي تخلط ايتمات ملفات الرفع. إن لم يكن له أي تعيين
   * نرجع لـ allItems كي لا يخرج النموذج فارغاً.
   */
  const downloadTemplate = async () => {
    setDownloading(true);
    let rows: { name: string; companyName: string }[] = [];
    let companies: { id: number; name: string }[] = [];
    try {
      const r = await fetch(`${API}/api/items/assigned-scope`, { headers: H });
      const j = await r.json();
      rows = j?.data?.items ?? [];
      companies = j?.data?.companies ?? [];
    } catch { /* نرجع للقائمة العامة أدناه */ }
    if (rows.length === 0) {
      rows = items.map(i => ({ name: i.name, companyName: (i as any).scientificCompany?.name ?? (i as any).company?.name ?? '' }))
        .sort((a, b) => a.companyName.localeCompare(b.companyName) || a.name.localeCompare(b.name));
    }
    setDownloading(false);

    const aoa: (string | number | null)[][] = [['الشركة', 'الايتم', 'التارگت']];
    rows.forEach(i => aoa.push([i.companyName || null, i.name, null]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 28 }, { wch: 40 }, { wch: 14 }];

    // ورقة الشركات: كل شركة معيّنة وعدد ايتماتها في النموذج (حتى التي بلا ايتمات)
    const countBy = new Map<string, number>();
    rows.forEach(i => countBy.set(i.companyName, (countBy.get(i.companyName) ?? 0) + 1));
    const companyNames = [...new Set([...companies.map(c => c.name), ...[...countBy.keys()].filter(Boolean)])]
      .sort((a, b) => a.localeCompare(b));
    const wsCompanies = XLSX.utils.aoa_to_sheet([
      ['الشركة', 'عدد الايتمات'],
      ...companyNames.map(n => [n, countBy.get(n) ?? 0]),
    ]);
    wsCompanies['!cols'] = [{ wch: 32 }, { wch: 14 }];

    const help = XLSX.utils.aoa_to_sheet([
      ['طريقة الاستخدام'],
      ['• عمود «الشركة» للمرجع فقط ولا يُقرأ عند الاستيراد — لا حاجة لحذفه.'],
      ['• عمود «التارگت» يُطبَّق على كل المندوبين الذين تختارهم في نافذة الاستيراد.'],
      ['• لتارگت مختلف لمندوب معيّن: أضف عموداً عنوانه اسم المندوب كما هو في البرنامج — قيمته تتقدّم على عمود «التارگت».'],
      ['• أو الصيغة الطولية: أعمدة «المندوب | الايتم | التارگت» صف لكل مندوب وايتم.'],
      ['• الخلية الفارغة لا تغيّر التارگت المحفوظ، والصفر يُحفظ صفراً.'],
    ]);
    help['!cols'] = [{ wch: 110 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'التارگت');
    XLSX.utils.book_append_sheet(wb, wsCompanies, 'الشركات');
    XLSX.utils.book_append_sheet(wb, help, 'تعليمات');
    XLSX.writeFile(wb, `نموذج_تارگت_${monthLabel}_${year}.xlsx`);
  };

  // المندوبون الذين سيُكتب لهم: المختارون (للعمود العام) + أصحاب الأعمدة/الصفوف الخاصة
  const plan = useMemo(() => {
    if (!parsed) return [] as { rep: RepLite; targets: Map<number, number> }[];
    const ids = new Set<number>([...parsed.perRep.keys()]);
    if (parsed.generic.size > 0) sel.forEach(id => ids.add(id));
    return reps.filter(r => ids.has(r.id)).map(rep => {
      const t = new Map<number, number>();
      if (sel.has(rep.id)) parsed.generic.forEach((v, k) => t.set(k, v));
      parsed.perRep.get(rep.id)?.forEach((v, k) => t.set(k, v));
      return { rep, targets: t };
    }).filter(p => p.targets.size > 0);
  }, [parsed, sel, reps]);

  const run = async () => {
    if (plan.length === 0) return;
    setRunning(true); setResult(null);
    let ok = 0, fail = 0, skipped = 0;
    const failed: string[] = [];
    let done = 0;
    const queue = plan.slice();
    const worker = async () => {
      while (queue.length) {
        const { rep, targets } = queue.shift()!;
        try {
          let entries = [...targets.entries()];
          // العلمي: نفس نطاق ايتمات المندوب الذي تعرضه الصفحة (effective-items)؛
          // نطاق فارغ = يحمل كل الايتمات (نفس سلوك loadTargets)
          if (repType === 'scientific') {
            try {
              const r = await fetch(`${API}/api/scientific-reps/${rep.id}/effective-items`, { headers: H });
              const j = await r.json();
              const scope: NamedItem[] = Array.isArray(j.data) ? j.data : [];
              if (scope.length > 0) {
                const ids = new Set(scope.map(i => i.id));
                const before = entries.length;
                entries = entries.filter(([id]) => ids.has(id));
                skipped += before - entries.length;
              }
            } catch { /* لو فشل الجلب نكتب الكل */ }
          }
          if (entries.length === 0) { ok++; continue; }
          const res = await fetch(`${API}/api/targets`, {
            method: 'PUT', headers: H,
            body: JSON.stringify({ repType, repId: rep.id, month, year, targets: entries.map(([itemId, target]) => ({ itemId, target })) }),
          });
          if (res.ok) ok++; else { fail++; failed.push(rep.name); }
        } catch { fail++; failed.push(rep.name); }
        done++;
        setProgress(`${done} / ${plan.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, plan.length) }, worker));
    setRunning(false); setProgress('');
    setResult(fail === 0
      ? `✓ تم حفظ تارگت ${monthLabel} ${year} لـ ${ok} مندوب${skipped ? ` — تُجوهلت ${skipped} قيمة لايتمات خارج نطاق مندوبيها` : ''}`
      : `⚠ نجح ${ok} وفشل ${fail}: ${failed.join('، ')}`);
    onDone();
  };

  const explicitIds = parsed ? new Set(parsed.perRep.keys()) : new Set<number>();
  const genericCount = parsed?.generic.size ?? 0;

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="card" dir="rtl" style={{ width: 'min(760px, 100%)', margin: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--c-text-primary)' }}>📥 استيراد التارگت من إكسل</div>
            <div style={{ fontSize: 12.5, color: 'var(--c-text-secondary)', marginTop: 2 }}>
              {repType === 'scientific' ? 'المندوبون العلميون' : 'المندوبون التجاريون'} — شهر {monthLabel} {year}
            </div>
          </div>
          <button className="btn btn--secondary btn--sm" onClick={onClose} disabled={running}>✕</button>
        </div>

        <div className="info-banner" style={{ marginBottom: 14 }}>
          <span className="info-banner-icon">💡</span>
          <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            عمود <b>الايتم</b> + عمود <b>التارگت</b> يُعمَّم على المندوبين الذين تختارهم أدناه.
            ولتارگت خاص بمندوب أضف عموداً <b>باسمه</b> (يتقدّم على العام)، أو استعمل صيغة <b>المندوب | الايتم | التارگت</b>.
            الخلية الفارغة لا تغيّر المحفوظ.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <label className="btn btn--primary" style={{ cursor: running ? 'not-allowed' : 'pointer' }}>
            📂 اختر ملف إكسل
            <input type="file" accept=".xlsx,.xls,.csv" hidden disabled={running}
              onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <button className="btn btn--secondary" onClick={downloadTemplate} disabled={downloading}>
            {downloading ? '⏳ جارٍ التحضير…' : '⬇ تحميل نموذج'}
          </button>
          {fileName && <span style={{ fontSize: 12.5, color: 'var(--c-text-secondary)' }}>{fileName}</span>}
        </div>

        {error && <div style={{ color: 'var(--c-danger)', fontWeight: 700, fontSize: 13, marginBottom: 12 }}>⚠ {error}</div>}

        {parsed && (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <span className="badge badge--blue">{parsed.itemNames.size} ايتم مطابق</span>
              {genericCount > 0 && <span className="badge badge--green">تارگت عام لـ {genericCount} ايتم</span>}
              {explicitIds.size > 0 && <span className="badge badge--green">{explicitIds.size} مندوب بتارگت خاص</span>}
              {parsed.unmatchedItems.length > 0 && <span className="badge badge--red">{parsed.unmatchedItems.length} ايتم غير معروف</span>}
            </div>

            {parsed.unmatchedItems.length > 0 && (
              <details style={{ marginBottom: 10, fontSize: 12.5 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--c-danger)', fontWeight: 700 }}>ايتمات لم تُطابق (ستُتجاهل)</summary>
                <div style={{ marginTop: 6, color: 'var(--c-text-secondary)', lineHeight: 1.9 }}>{parsed.unmatchedItems.join(' • ')}</div>
              </details>
            )}
            {parsed.unmatchedReps.length > 0 && (
              <details style={{ marginBottom: 10, fontSize: 12.5 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--c-danger)', fontWeight: 700 }}>أعمدة/أسماء مندوبين لم تُطابق (ستُتجاهل)</summary>
                <div style={{ marginTop: 6, color: 'var(--c-text-secondary)', lineHeight: 1.9 }}>{parsed.unmatchedReps.join(' • ')}</div>
              </details>
            )}

            {genericCount > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>تعميم التارگت العام على: ({sel.size} / {reps.length})</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn--secondary btn--sm" onClick={() => setSel(new Set(reps.map(r => r.id)))}>تحديد الكل</button>
                    <button className="btn btn--secondary btn--sm" onClick={() => setSel(new Set())}>إلغاء الكل</button>
                  </div>
                </div>
                <div className="tag-list" style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {reps.map(r => {
                    const checked = sel.has(r.id);
                    return (
                      <div key={r.id}
                        onClick={() => setSel(prev => { const s = new Set(prev); checked ? s.delete(r.id) : s.add(r.id); return s; })}
                        className={`filter-chip ${checked ? 'filter-chip--active' : ''}`}
                        title={explicitIds.has(r.id) ? 'له عمود خاص في الملف — قيمه تتقدّم على العام' : undefined}>
                        {checked ? '✓' : '○'} {r.name}{explicitIds.has(r.id) ? ' ★' : ''}
                      </div>
                    );
                  })}
                  {reps.length === 0 && <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>لا يوجد مندوبون</span>}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn--primary" onClick={run} disabled={running || plan.length === 0} style={{ minWidth: 180 }}>
                {running ? `⏳ جاري الحفظ ${progress}` : `💾 حفظ لـ ${plan.length} مندوب`}
              </button>
              {repType === 'scientific' && !running && !result && (
                <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>يُكتب لكل مندوب علمي فقط ايتمات نطاقه</span>
              )}
              {result && (
                <span style={{ fontSize: 13, fontWeight: 700, color: result.startsWith('✓') ? 'var(--c-success)' : 'var(--c-danger)' }}>{result}</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9999, padding: '24px 12px', overflowY: 'auto' };
