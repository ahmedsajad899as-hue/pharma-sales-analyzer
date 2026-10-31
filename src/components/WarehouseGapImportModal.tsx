import { useEffect, useMemo, useRef, useState } from 'react';
import SmartSuggestInput from './SmartSuggestInput';

/**
 * Modal for company_manager / team_leader: download a personal Excel template
 * (their companies/items/team-rep names), fill in pharmacy sales that went
 * through a warehouse (مذخر) but never made it into the Mercato file, then
 * re-upload it here. Saved rows go to the account's «ملف اللكوديشن» (POST
 * /api/sales/manual with target.condition) — tagged sourceSystem 'mercato' so every
 * Mercato-based report/KPI counts them automatically — see
 * scientific-reps.service.js's office/mercato split.
 *
 * provinceMode («مندوبين المحافظات»): يقبل أيضاً ملف مهام المسوقين كما تصدّره المنصة
 * (task_id/product_name/brand/…/rep_name/status) — المحافظة من اسم المندوب — ويطابق
 * أسماء الايتمات والشركات بكتالوج المكتب قبل الحفظ (/api/sales/condition-match).
 */

const API = '';

interface Props {
  token: string;
  onClose: () => void;
  onSaved: (msg: string, fileId?: number) => void;
  /** «مندوبين المحافظات»: عمود محافظة لكل صف (نموذج الإكسل أيضاً) — عليه تُقارَن
   *  مبيعات اللكوديشن بمبيع المحافظة الكلي. */
  provinceMode?: boolean;
}

interface GapRow {
  date: string; pharmacy: string; area: string; repName: string; company: string;
  item: string; quantity: string; bonus: string; unitPrice: string; totalValue: string;
  warehouse: string; invoiceNumber: string; notes: string; province: string;
  /** ايتم النظام المؤكَّد في «مطابقة الأسماء» — يُحفظ عليه حرفياً. */
  itemId?: number;
}
type TextKey = Exclude<keyof GapRow, 'itemId'>;

type NameCheck = {
  raw: string; status: 'exact' | 'ask' | 'new';
  canonical?: { id: number; name: string };
  suggestions: { id: number; name: string; sim: number }[];
};

// ── مطابقة الأسماء بكتالوج المكتب (provinceMode) ──
type ItemOpt = { id: number; name: string; company: string | null; team: string | null };
type MatchStatus = 'exact' | 'auto' | 'ask' | 'none';
type ItemMatch = { raw: string; status: MatchStatus; match: ItemOpt | null; suggestions: ItemOpt[] };
type CompMatch = { raw: string; status: MatchStatus; match: string | null; via: 'name' | 'items' | null; suggestions: string[] };
interface MatchData { catalog: ItemOpt[]; companyList: string[]; items: ItemMatch[]; companies: CompMatch[] }
type Picks = Record<string, string>;
type Remember = { from: string; toItemId: number };

const num = (v: any) => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return isFinite(n) ? n : ''; };
const emptyRow = (): GapRow => ({ date: '', pharmacy: '', area: '', repName: '', company: '', item: '', quantity: '', bonus: '', unitPrice: '', totalValue: '', warehouse: '', invoiceNumber: '', notes: '', province: '' });

interface Scope { reps: string[]; items: string[]; companies: string[]; warehouses: string[]; provinces?: string[]; }

/** ايتم النظام المختار لاسم خام: المطابق أو أحد المقترحات أو أي ايتم كتالوج بنفس الاسم. */
function pickedItem(e: ItemMatch, value: string, byName: Map<string, ItemOpt>): ItemOpt | null {
  const v = value.trim();
  if (!v) return null;
  if (e.match?.name === v) return e.match;
  return e.suggestions.find(s => s.name === v) ?? byName.get(v) ?? null;
}

/**
 * يحسم المطابقة: لكل اسم خام ايتم/شركة النظام، أو «يُترك كما هو» بقرار صريح.
 * pending = أسماء بلا قرار بعد (لا اختيار من النظام ولا «اتركه»).
 */
function resolveMatch(d: MatchData, ip: Picks, cp: Picks, keep: Record<string, boolean>) {
  const byName = new Map(d.catalog.map(c => [c.name, c]));
  const companySet = new Set(d.companyList);
  const items = new Map<string, ItemOpt>();
  const comps = new Map<string, string>();
  let pending = 0;
  for (const e of d.items) {
    const o = pickedItem(e, ip[e.raw] ?? '', byName);
    if (o) items.set(e.raw, o);
    else if (!keep['i|' + e.raw]) pending++;
  }
  for (const e of d.companies) {
    const v = (cp[e.raw] ?? '').trim();
    if (v && companySet.has(v)) comps.set(e.raw, v);
    else if (!keep['c|' + e.raw]) pending++;
  }
  // قرارات المستخدم (لا التطابق التام/التلقائي كما هو) تُحفظ قواعدَ توحيد فيُطابَق الاسم تلقائياً لاحقاً.
  const remember: Remember[] = d.items
    .filter(e => items.has(e.raw) && (e.status === 'ask' || e.status === 'none' || items.get(e.raw)!.id !== e.match?.id))
    .map(e => ({ from: e.raw, toItemId: items.get(e.raw)!.id }));
  return { items, comps, pending, remember };
}

function applyToRows(rs: GapRow[], items: Map<string, ItemOpt>, comps: Map<string, string>): GapRow[] {
  return rs.map(r => {
    const io = items.get(r.item.trim());
    const co = comps.get(r.company.trim());
    return {
      ...r,
      item: io ? io.name : r.item,
      itemId: io ? io.id : r.itemId,
      company: co ?? (io && !r.company.trim() ? (io.company ?? '') : r.company),
    };
  });
}

export default function WarehouseGapImportModal({ token, onClose, onSaved, provinceMode = false }: Props) {
  const authH = { Authorization: `Bearer ${token}` };
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<GapRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fileFormat, setFileFormat] = useState<'template' | 'tasks' | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [currency, setCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [nameAsk, setNameAsk] = useState<{ items: NameCheck[]; companies: NameCheck[] } | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  // نطاق المستخدم (شركاته/ايتماته/فريقه/مذاخره) لتغذية الاقتراحات الذكية في
  // جدول المراجعة — نفس البيانات المبنيّة منها نموذج الإكسل، بصيغة JSON.
  const [scope, setScope] = useState<Scope>({ reps: [], items: [], companies: [], warehouses: [] });
  const provinceOptions = (scope.provinces ?? []).filter(p => p.trim() !== 'بغداد');
  // «المحافظة/التاريخ لكل الصفوف»: تملأ الخانات الفارغة فقط — ما اختير صفاً بصف يبقى.
  const fillProvince = (p: string) => setRows(rs => rs.map(r => (r.province.trim() ? r : { ...r, province: p })));
  const fillDate = (d: string) => setRows(rs => rs.map(r => (r.date ? r : { ...r, date: d })));

  // مطابقة الأسماء بكتالوج المكتب
  const [match, setMatch] = useState<MatchData | null>(null);
  const [matching, setMatching] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);
  const [itemPick, setItemPick] = useState<Picks>({});
  const [compPick, setCompPick] = useState<Picks>({});
  const [keepRaw, setKeepRaw] = useState<Record<string, boolean>>({});
  const [remember, setRemember] = useState<Remember[]>([]);
  const [matchMsg, setMatchMsg] = useState('');

  useEffect(() => {
    fetch(`${API}/api/sales/warehouse-gap-scope`, { headers: authH })
      .then(r => r.json())
      .then(j => { if (j?.data) setScope(j.data); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addManualRow = () => setRows(rs => [...rs, emptyRow()]);

  const downloadTemplate = async () => {
    setError(''); setDownloading(true);
    try {
      const res = await fetch(`${API}/api/sales/warehouse-gap-template${provinceMode ? '?province=1' : ''}`, { headers: authH });
      if (!res.ok) throw new Error('تعذّر تنزيل النموذج');
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const m = disposition.match(/filename="?([^"]+)"?/);
      const filename = m ? decodeURIComponent(m[1]) : 'نموذج مبيعات مذاخر.xlsx';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message || 'تعذّر تنزيل النموذج');
    } finally {
      setDownloading(false);
    }
  };

  /** يطابق أسماء الصفوف بكتالوج المكتب ويفتح لوحة المطابقة باختيارات أولية (التام والتلقائي). */
  const runMatch = async (rs: GapRow[]): Promise<MatchData | null> => {
    const seen = new Set<string>();
    const pairs: { item: string; company: string }[] = [];
    for (const r of rs) {
      const item = r.item.trim(), company = r.company.trim();
      if (!item || seen.has(item + '|' + company)) continue;
      seen.add(item + '|' + company);
      pairs.push({ item, company });
    }
    if (!pairs.length) return null;
    setMatching(true);
    try {
      const res = await fetch(`${API}/api/sales/condition-match`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'تعذّرت مطابقة الأسماء');
      const d: MatchData = j.data;
      setMatch(d);
      setItemPick(Object.fromEntries(d.items.map(e => [e.raw, e.match?.name ?? ''])));
      setCompPick(Object.fromEntries(d.companies.map(e => [e.raw, e.match ?? ''])));
      setKeepRaw({});
      setMatchOpen(true);
      setMatchMsg('');
      return d;
    } catch (e: any) {
      setError(e.message || 'تعذّرت مطابقة الأسماء');
      return null;
    } finally {
      setMatching(false);
    }
  };

  const onFile = async (f: File | null) => {
    if (!f) return;
    setError(''); setWarnings([]); setParsing(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch(`${API}/api/sales/warehouse-gap-parse`, { method: 'POST', body: fd, headers: authH });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'فشل قراءة الملف');
      const parsed: any[] = j.data?.rows ?? [];
      setWarnings(j.data?.warnings ?? []);
      setFileFormat(j.data?.format === 'tasks' ? 'tasks' : 'template');
      const next: GapRow[] = parsed.map(r => ({
        date: String(r.date ?? '').slice(0, 10), pharmacy: String(r.pharmacy ?? ''), area: String(r.area ?? ''),
        repName: String(r.repName ?? ''), company: String(r.company ?? ''), item: String(r.item ?? ''),
        quantity: r.quantity != null ? String(num(r.quantity)) : '',
        bonus: r.bonus != null ? String(num(r.bonus)) : '',
        unitPrice: r.unitPrice != null ? String(num(r.unitPrice)) : '',
        totalValue: r.totalValue != null ? String(num(r.totalValue)) : '',
        warehouse: String(r.warehouse ?? ''), invoiceNumber: String(r.invoiceNumber ?? ''), notes: String(r.notes ?? ''),
        province: String(r.province ?? ''),
      }));
      setRows(next);
      setMatch(null); setMatchOpen(false); setRemember([]); setMatchMsg('');
      if (parsed.length === 0) setError('لم يتم العثور على أي صف صالح في الملف.');
      else if (provinceMode) await runMatch(next);
    } catch (e: any) {
      setError(e.message || 'تعذّر قراءة الملف');
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // تعديل اسم الايتم يدوياً يُلغي ربطه بايتم النظام — يُطابَق من جديد عند الحفظ.
  const setCell = (i: number, key: TextKey, val: string) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, [key]: val, ...(key === 'item' ? { itemId: undefined } : {}) } : r)));
  const removeRow = (i: number) => setRows(rs => rs.filter((_, idx) => idx !== i));

  const buildPayload = (rs: GapRow[] = rows) => rs
    .filter(r => r.item.trim() && r.repName.trim() && Number(r.quantity) > 0)
    .map(r => ({
      repName: r.repName.trim(),
      item: r.item.trim(),
      itemId: r.itemId,
      company: r.company.trim() || undefined,
      quantity: Number(r.quantity),
      bonus: r.bonus !== '' && Number(r.bonus) > 0 ? Number(r.bonus) : undefined,
      totalValue: r.totalValue !== '' ? Number(r.totalValue) : undefined,
      unitPrice: r.unitPrice !== '' ? Number(r.unitPrice) : undefined,
      pharmacy: r.pharmacy.trim() || undefined,
      warehouse: r.warehouse.trim() || undefined,
      area: r.area.trim() || undefined,
      date: r.date || undefined,
      invoiceNumber: r.invoiceNumber.trim() || undefined,
      notes: r.notes.trim() || undefined,
      province: r.province.trim() || undefined,
      source: 'warehouse-gap-template',
    }));

  const doSave = async (payloadRows: any[], rememberItems: Remember[] = []) => {
    setSaving(true); setError('');
    try {
      const res = await fetch(`${API}/api/sales/manual`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: payloadRows,
          // ملف اللكوديشن: حاوية تراكمية واحدة تُعرض ملتصقة بملف ميركاتو وتُحتسب معه.
          target: { condition: true, sourceCurrency: currency },
          rememberItems,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || 'فشل الحفظ');
      const added = j.data?.addedCount ?? payloadRows.length;
      const skipped = j.data?.skippedCount ?? 0;
      onSaved(`تمت إضافة ${added} عملية بيع إلى ملف اللكوديشن${skipped ? ` (أُسقط ${skipped} مكرر)` : ''}.`, j.data?.uploadedFile?.id);
    } catch (e: any) {
      setError(e.message || 'تعذّر الحفظ');
    } finally {
      setSaving(false);
      setNameAsk(null);
    }
  };

  const applyUnification = (payloadRows: any[], items: NameCheck[], companies: NameCheck[], picks: Record<string, string>) => {
    const build = (list: NameCheck[], prefix: string) => {
      const map = new Map<string, string>();
      for (const e of list) {
        if (e.status === 'exact' && e.canonical) { map.set(e.raw, e.canonical.name); continue; }
        if (e.status !== 'ask') continue;
        const pick = picks[prefix + e.raw];
        if (!pick || pick === 'new') continue;
        const s = e.suggestions.find(x => String(x.id) === pick);
        if (s) map.set(e.raw, s.name);
      }
      return map;
    };
    const itemMap = build(items, 'i|');
    const compMap = build(companies, 'c|');
    return payloadRows.map(r => ({ ...r, item: itemMap.get(r.item) ?? r.item, company: r.company ? (compMap.get(r.company) ?? r.company) : r.company }));
  };

  /** «تطبيق المطابقة»: يكتب أسماء النظام ومعرّفات الايتمات في الجدول. */
  const applyMatch = () => {
    if (!match) return;
    const res = resolveMatch(match, itemPick, compPick, keepRaw);
    if (res.pending > 0) { setError(`${res.pending} اسم بانتظار قرارك في «مطابقة الأسماء» — اختر من النظام أو «اتركه كما هو».`); return; }
    setError('');
    setRows(rs => applyToRows(rs, res.items, res.comps));
    setRemember(prev => [...prev.filter(p => !res.remember.some(x => x.from === p.from)), ...res.remember]);
    const outside = [...res.items.values()].filter(o => !o.team).length;
    setMatchMsg(`✅ طُبّقت المطابقة: ${res.items.size} ايتم و${res.comps.size} شركة بأسماء النظام`
      + (outside ? ` — ${outside} ايتم بلا مدير شركة فلن تدخل مقارنة المحافظات.` : '.'));
    setMatchOpen(false);
  };

  const onSave = async () => {
    setError('');
    let payloadRows = buildPayload();
    if (payloadRows.length === 0) { setError('لا توجد صفوف صالحة — كل صف يحتاج مندوباً ومادة وكمية أكبر من صفر.'); return; }

    if (provinceMode) {
      // صف بلا محافظة ولا منطقة لا يُعرف مكانه فيضيع من مقارنة المحافظات.
      const lost = payloadRows.filter(r => !r.province && !r.area).length;
      if (lost > 0) { setError(`${lost} صف بلا محافظة ولا منطقة — اختر المحافظة (أو «المحافظة لكل الصفوف») قبل الحفظ.`); return; }
      // صف بلا تاريخ لا يظهر في أي شهر من المقارنة.
      const undated = payloadRows.filter(r => !r.date).length;
      if (undated > 0) { setError(`${undated} صف بلا تاريخ — اختر «التاريخ لكل الصفوف الفارغة» قبل الحفظ.`); return; }

      // أسماء لم تُطابَق بعد (صفوف أُضيفت أو عُدّلت بعد المطابقة): تُطابَق الآن، وتُطبَّق
      // تلقائياً إن لم يبقَ ما يحتاج قراراً — وإلا تُفتح اللوحة.
      let rs = rows;
      let rem = remember;
      const unresolved = (list: GapRow[]) => list.some(r => r.item.trim() && !r.itemId && !keepRaw['i|' + r.item.trim()]);
      if (unresolved(rs)) {
        const covered = !!match && rs.every(r => !r.item.trim() || r.itemId || match.items.some(e => e.raw === r.item.trim()));
        const d = covered ? match! : await runMatch(rs);
        if (!d) return;
        const res = covered
          ? resolveMatch(d, itemPick, compPick, keepRaw)
          : resolveMatch(d, Object.fromEntries(d.items.map(e => [e.raw, e.match?.name ?? ''])), Object.fromEntries(d.companies.map(e => [e.raw, e.match ?? ''])), {});
        if (res.pending > 0) {
          setMatchOpen(true);
          setError(`راجع «مطابقة الأسماء» أولاً: ${res.pending} اسم لم يُحسم بعد.`);
          return;
        }
        rs = applyToRows(rs, res.items, res.comps);
        rem = [...rem.filter(p => !res.remember.some(x => x.from === p.from)), ...res.remember];
        setRows(rs); setRemember(rem); setMatchOpen(false);
      }
      payloadRows = buildPayload(rs);
      await doSave(payloadRows, rem);
      return;
    }

    setChecking(true);
    let check: { items: NameCheck[]; companies: NameCheck[] } | null = null;
    try {
      const res = await fetch(`${API}/api/sales/check-names`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: payloadRows.map(r => ({ item: r.item, company: r.company })) }),
      });
      if (res.ok) check = (await res.json()).data ?? null;
    } catch { /* فحص الأسماء رفاهية — نكمل بلا توحيد لو تعذّر */ }
    setChecking(false);

    const asks = check ? [...check.items, ...check.companies].filter(e => e.status === 'ask') : [];
    if (asks.length > 0) { setChoice({}); setNameAsk(check); return; }

    const unified = check ? applyUnification(payloadRows, check.items, check.companies, {}) : payloadRows;
    await doSave(unified);
  };

  const confirmNames = async () => {
    if (!nameAsk) return;
    const unified = applyUnification(buildPayload(), nameAsk.items, nameAsk.companies, choice);
    await doSave(unified);
  };

  const askList = nameAsk
    ? [...nameAsk.items.filter(e => e.status === 'ask').map(e => ({ e, kind: 'i' as const })),
       ...nameAsk.companies.filter(e => e.status === 'ask').map(e => ({ e, kind: 'c' as const }))]
    : [];
  const allAnswered = askList.every(({ e, kind }) => choice[kind + '|' + e.raw]);

  // ── لوحة المطابقة: عدد الصفوف لكل اسم + حالة كل اختيار ──
  const catalogByName = useMemo(() => new Map((match?.catalog ?? []).map(c => [c.name, c])), [match]);
  const catalogNames = useMemo(() => [...new Set((match?.catalog ?? []).map(c => c.name))], [match]);
  const rowCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      m.set('i|' + r.item.trim(), (m.get('i|' + r.item.trim()) ?? 0) + 1);
      m.set('c|' + r.company.trim(), (m.get('c|' + r.company.trim()) ?? 0) + 1);
    }
    return m;
  }, [rows]);
  const matchState = match ? resolveMatch(match, itemPick, compPick, keepRaw) : null;
  const unresolvedRows = rows.filter(r => r.item.trim() && !r.itemId && !keepRaw['i|' + r.item.trim()]).length;

  const cols: { key: TextKey; label: string; w: number; numeric?: boolean }[] = [
    { key: 'date', label: 'التاريخ', w: 110 },
    { key: 'pharmacy', label: 'الصيدلية', w: 150 },
    { key: 'area', label: 'المنطقة', w: 110 },
    { key: 'repName', label: 'المندوب*', w: 140 },
    { key: 'company', label: 'الشركة', w: 120 },
    { key: 'item', label: 'الايتم*', w: 180 },
    { key: 'quantity', label: 'الكمية*', w: 64, numeric: true },
    { key: 'unitPrice', label: 'سعر الوحدة (اختياري)', w: 100, numeric: true },
    { key: 'totalValue', label: 'الإجمالي (اختياري)', w: 100, numeric: true },
    { key: 'warehouse', label: 'المذخر', w: 110 },
    { key: 'invoiceNumber', label: 'رقم الفاتورة', w: 90 },
    { key: 'notes', label: 'ملاحظات', w: 140 },
  ];
  if (provinceMode) {
    cols.splice(3, 0, { key: 'province', label: 'المحافظة*', w: 120 });
    cols.splice(cols.findIndex(c => c.key === 'quantity') + 1, 0, { key: 'bonus', label: 'البونص', w: 60, numeric: true });
  }

  const statusBadge = (kind: 'ok' | 'auto' | 'keep' | 'pending' | 'unknown', team?: string | null, isItem = true) => {
    const base: React.CSSProperties = { fontSize: 11, fontWeight: 800, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' };
    const b = kind === 'ok' ? <span style={{ ...base, background: '#dcfce7', color: '#166534' }}>✅ مطابق</span>
      : kind === 'auto' ? <span style={{ ...base, background: '#fef9c3', color: '#854d0e' }} title="تطابق تقريبي بالاسم/الجرعة — تأكّد منه">🟡 تقريبي — تأكّد</span>
      : kind === 'keep' ? <span style={{ ...base, background: '#f1f5f9', color: '#475569' }}>🆕 يُحفظ باسمه</span>
      : kind === 'unknown' ? <span style={{ ...base, background: '#fee2e2', color: '#b91c1c' }}>⚠️ ليس من النظام — اختر من القائمة</span>
      : <span style={{ ...base, background: '#fee2e2', color: '#b91c1c' }}>❓ اختر</span>;
    if (!isItem || (kind !== 'ok' && kind !== 'auto')) return b;
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
        {b}
        {team
          ? <span style={{ fontSize: 10.5, color: '#0e7490' }}>يُحتسب ضمن {team}</span>
          : <span style={{ fontSize: 10.5, color: '#b45309' }}>⚠️ بلا مدير شركة — خارج المقارنة</span>}
      </span>
    );
  };

  return (
    <div style={overlay}>
      {nameAsk && (
        <div style={askOverlay} dir="rtl">
          <div style={askPanel}>
            <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 800, color: '#1e293b' }}>⚠️ أسماء متشابهة — تأكيد قبل الإضافة</h3>
            <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#64748b', lineHeight: 1.7 }}>
              وجدنا أسماء قريبة مما هو مسجَّل عندك. أكّد لكل اسم: هل هو نفس الموجود أم اسم جديد؟
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <button style={bulkBtn} onClick={() => setChoice(Object.fromEntries(askList.map(({ e, kind }) => [kind + '|' + e.raw, String(e.suggestions[0]?.id ?? 'new')])))}>✅ الكل: نفس المقترح الأول</button>
              <button style={bulkBtn} onClick={() => setChoice(Object.fromEntries(askList.map(({ e, kind }) => [kind + '|' + e.raw, 'new'])))}>🆕 الكل: أسماء جديدة</button>
            </div>
            <div style={{ maxHeight: '48vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {askList.map(({ e, kind }) => {
                const key = kind + '|' + e.raw;
                return (
                  <div key={key} style={askCard}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{kind === 'i' ? '💊 مادة' : '🏭 شركة'} في ملفك:</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>{e.raw}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {e.suggestions.map(s => (
                        <label key={s.id} style={{ ...askOpt, ...(choice[key] === String(s.id) ? askOptOn : null) }}>
                          <input type="radio" name={key} checked={choice[key] === String(s.id)} onChange={() => setChoice(p => ({ ...p, [key]: String(s.id) }))} />
                          <span>نعم، هو نفسه: <b>{s.name}</b></span>
                          <span style={{ marginInlineStart: 'auto', fontSize: 11, color: '#94a3b8' }}>تشابه {Math.round(s.sim * 100)}%</span>
                        </label>
                      ))}
                      <label style={{ ...askOpt, ...(choice[key] === 'new' ? askOptNew : null) }}>
                        <input type="radio" name={key} checked={choice[key] === 'new'} onChange={() => setChoice(p => ({ ...p, [key]: 'new' }))} />
                        <span>لا، اسم مختلف — أضِفه كما هو</span>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={() => setNameAsk(null)} disabled={saving} style={askCancel}>رجوع للتعديل</button>
              <button onClick={confirmNames} disabled={!allAnswered || saving} style={{ ...askOk, opacity: allAnswered && !saving ? 1 : 0.5 }}>
                {saving ? '⏳ جاري الحفظ…' : `تأكيد وحفظ (${askList.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={panel} dir="rtl">
        <div style={header}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1e293b' }}>{provinceMode ? '📑 إدخال مبيعات اللكوديشن — المحافظات' : '📑 مبيعات مذاخر ناقصة من ميركاتو'}</h3>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>

        {provinceMode && (
          <p style={{ margin: '0 0 10px', fontSize: 13, color: '#1e3a8a', lineHeight: 1.7, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '8px 12px' }}>
            تُحفظ في «ملف اللكوديشن» وتظهر في «مندوبين المحافظات» مقارنةً بمبيع كل محافظة الكلي. ارفع <b>ملف مهام المسوقين</b> كما
            تصدّره المنصة (task_id · product_name · brand · price · quantity · total_price · bonus · rep_name · client ·
            associated_client · status) — المحافظة تُعرف من اسم المندوب («… - مسوقين - الديوانية»، «… فارمسي الكوت»)،
            والمهام المكتملة (Completed) فقط تُحتسب — أو نموذج الإكسل الخاص بك (عمود <b>المحافظة</b> آخر عمود).
            بعد الرفع تُطابَق أسماء الايتمات والشركات مع النظام قبل الحفظ.
          </p>
        )}
        {!provinceMode && (
          <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b', lineHeight: 1.7 }}>
            مبيعات صيدليات تمّت فعلاً عبر أحد المذاخر لكنها لم توثَّق ضمن ملف ميركاتو. حمّل نموذج الإكسل الخاص بك
            (مبني على شركاتك وايتماتك وأسماء فريقك). في الملف: المندوب والشركة والايتم قوائم منسدلة جاهزة للاختيار،
            اليوم يُختار برقم فقط (1-31، الشهر مكتوب بعنوان العمود)، المذخر قائمة اقتراحية يمكن تجاوزها بالكتابة،
            والقيمة الإجمالية تُحسب وتتحدّث تلقائياً داخل الملف بمجرد إدخال الكمية والسعر. اترك السعر فارغاً إن لم
            تعرفه — يُستكمل تلقائياً من سعر المذخر المسجَّل لكل ايتم. ستُحتسب هذه المبيعات تلقائياً ضمن ميركاتو في كل
            التقارير.
          </p>
        )}

        <div style={topBar}>
          <button onClick={downloadTemplate} disabled={downloading} style={downloadBtn}>
            {downloading ? '⏳ جاري التنزيل…' : '⬇️ تنزيل نموذج الإكسل الخاص بي'}
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => onFile(e.target.files?.[0] ?? null)} />
          <button onClick={() => fileRef.current?.click()} disabled={parsing} style={uploadBtn}>
            {parsing ? '⏳ جاري القراءة…' : provinceMode ? '📤 رفع ملف المسوقين / النموذج المعبّأ' : '📤 رفع الملف المعبّأ'}
          </button>
          <button onClick={addManualRow} style={addBtn}>✍️ إضافة صف يدوياً هنا</button>
          {provinceMode && rows.length > 0 && (
            <button onClick={() => (matchOpen ? setMatchOpen(false) : runMatch(rows))} disabled={matching} style={matchBtn}>
              {matching ? '⏳ جاري المطابقة…' : `🔗 مطابقة الأسماء مع النظام${unresolvedRows ? ` (${unresolvedRows} صف)` : ''}`}
            </button>
          )}
        </div>

        {fileFormat === 'tasks' && (
          <div style={{ ...warnBox, background: '#ecfeff', borderColor: '#a5f3fc', color: '#155e75' }}>
            📋 تم التعرف على <b>ملف مهام المسوقين</b>: {rows.length} صف مكتمل — المحافظة من اسم المندوب، رقم المهمة = رقم الفاتورة،
            والمذخر من associated_client. الملف بلا تاريخ: اختر «التاريخ لكل الصفوف الفارغة» أسفل الجدول.
          </div>
        )}

        {warnings.length > 0 && (
          <div style={warnBox}>
            {warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
          </div>
        )}

        {provinceMode && matchMsg && !matchOpen && (
          <div style={{ ...warnBox, background: '#f0fdf4', borderColor: '#bbf7d0', color: '#166534' }}>{matchMsg}</div>
        )}

        {provinceMode && match && matchOpen && matchState && (
          <div style={matchBox}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 900, color: '#0f172a' }}>🔗 مطابقة الأسماء مع النظام</span>
              <span style={{ fontSize: 12, color: '#64748b' }}>{match.items.length} ايتم · {match.companies.length} شركة</span>
              <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button style={bulkBtn} onClick={() => {
                  setItemPick(p => ({ ...p, ...Object.fromEntries(match.items.filter(e => !(p[e.raw] ?? '').trim() && e.suggestions[0]).map(e => [e.raw, e.suggestions[0].name])) }));
                  setCompPick(p => ({ ...p, ...Object.fromEntries(match.companies.filter(e => !(p[e.raw] ?? '').trim() && e.suggestions[0]).map(e => [e.raw, e.suggestions[0]])) }));
                }}>✅ قبول المقترح الأول للباقي</button>
                <button style={bulkBtn} onClick={() => setKeepRaw(k => ({
                  ...k,
                  ...Object.fromEntries(match.items.filter(e => !pickedItem(e, itemPick[e.raw] ?? '', catalogByName)).map(e => ['i|' + e.raw, true])),
                  ...Object.fromEntries(match.companies.filter(e => !match.companyList.includes((compPick[e.raw] ?? '').trim())).map(e => ['c|' + e.raw, true])),
                }))}>🆕 اترك غير المطابق كما هو</button>
                <button style={bulkBtn} onClick={() => setMatchOpen(false)}>إخفاء</button>
              </span>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: '#475569', lineHeight: 1.7 }}>
              الايتم المطابق يُحفظ على ايتم النظام نفسه فيدخل مقارنة المحافظة ضمن تيم مديره. ما يُترك باسمه يُحفظ كما هو
              ولا يدخل المقارنة. اختياراتك للأسماء غير المتطابقة تُحفظ فيُطابَق الاسم تلقائياً في الرفع القادم.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: 12 }} className="m-stack">
              <div style={matchList}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
                  <thead><tr style={{ background: '#f8fafc' }}>
                    <th style={th}>💊 الايتم في الملف</th><th style={th}>صفوف</th><th style={{ ...th, minWidth: 220 }}>ايتم النظام</th><th style={th}>الحالة</th>
                  </tr></thead>
                  <tbody>
                    {[...match.items].sort((a, b) => order(a.status) - order(b.status)).map(e => {
                      const val = itemPick[e.raw] ?? '';
                      const o = pickedItem(e, val, catalogByName);
                      const kind = o ? (e.status === 'auto' && o.id === e.match?.id ? 'auto' : 'ok')
                        : val.trim() ? 'unknown' : keepRaw['i|' + e.raw] ? 'keep' : 'pending';
                      return (
                        <tr key={e.raw} style={{ borderBottom: '1px solid #f1f5f9', background: kind === 'pending' || kind === 'unknown' ? '#fff7f7' : undefined }}>
                          <td style={{ ...td, fontWeight: 700, color: '#0f172a', direction: 'ltr', textAlign: 'left' }}>{e.raw}</td>
                          <td style={{ ...td, color: '#64748b', textAlign: 'center' }}>{rowCount.get('i|' + e.raw) ?? 0}</td>
                          <td style={td}>
                            <SmartSuggestInput value={val} options={catalogNames} placeholder="ابحث في ايتمات النظام…"
                              onChange={v => { setItemPick(p => ({ ...p, [e.raw]: v })); setKeepRaw(k => ({ ...k, ['i|' + e.raw]: false })); }} />
                            {!o && (e.suggestions.length > 0 || !keepRaw['i|' + e.raw]) && (
                              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                                {e.suggestions.slice(0, 4).map(s => (
                                  <button key={s.id} style={chip} onClick={() => setItemPick(p => ({ ...p, [e.raw]: s.name }))}>{s.name}</button>
                                ))}
                                <button style={{ ...chip, background: '#f8fafc', color: '#475569' }} onClick={() => { setItemPick(p => ({ ...p, [e.raw]: '' })); setKeepRaw(k => ({ ...k, ['i|' + e.raw]: true })); }}>🆕 اتركه كما هو</button>
                              </div>
                            )}
                          </td>
                          <td style={td}>{statusBadge(kind, o?.team)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={matchList}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
                  <thead><tr style={{ background: '#f8fafc' }}>
                    <th style={th}>🏭 الشركة في الملف</th><th style={th}>صفوف</th><th style={{ ...th, minWidth: 130 }}>شركة النظام</th><th style={th}>الحالة</th>
                  </tr></thead>
                  <tbody>
                    {[...match.companies].sort((a, b) => order(a.status) - order(b.status)).map(e => {
                      const val = compPick[e.raw] ?? '';
                      const ok = match.companyList.includes(val.trim());
                      const kind = ok ? (e.status === 'auto' && val.trim() === e.match ? 'auto' : 'ok')
                        : val.trim() ? 'unknown' : keepRaw['c|' + e.raw] ? 'keep' : 'pending';
                      return (
                        <tr key={e.raw} style={{ borderBottom: '1px solid #f1f5f9', background: kind === 'pending' || kind === 'unknown' ? '#fff7f7' : undefined }}>
                          <td style={{ ...td, fontWeight: 700, color: '#0f172a', direction: 'ltr', textAlign: 'left' }}>{e.raw}</td>
                          <td style={{ ...td, color: '#64748b', textAlign: 'center' }}>{rowCount.get('c|' + e.raw) ?? 0}</td>
                          <td style={td}>
                            <SmartSuggestInput value={val} options={match.companyList} placeholder="شركات النظام…"
                              onChange={v => { setCompPick(p => ({ ...p, [e.raw]: v })); setKeepRaw(k => ({ ...k, ['c|' + e.raw]: false })); }} />
                            {!ok && (
                              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                                {e.suggestions.slice(0, 3).map(s => (
                                  <button key={s} style={chip} onClick={() => setCompPick(p => ({ ...p, [e.raw]: s }))}>{s}</button>
                                ))}
                                <button style={{ ...chip, background: '#f8fafc', color: '#475569' }} onClick={() => { setCompPick(p => ({ ...p, [e.raw]: '' })); setKeepRaw(k => ({ ...k, ['c|' + e.raw]: true })); }}>🆕 اتركها</button>
                              </div>
                            )}
                            {ok && e.via === 'items' && val.trim() === e.match && <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}>من شركة ايتماتها المطابقة</div>}
                          </td>
                          <td style={td}>{statusBadge(kind, null, false)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button onClick={applyMatch} disabled={matchState.pending > 0} style={{ ...saveBtn, padding: '8px 18px', fontSize: 13, opacity: matchState.pending > 0 ? 0.5 : 1 }}>
                ✔ تطبيق المطابقة على الجدول
              </button>
              <span style={{ fontSize: 12, fontWeight: 700, color: matchState.pending ? '#b91c1c' : '#166534' }}>
                {matchState.pending ? `${matchState.pending} اسم بانتظار قرارك` : 'كل الأسماء محسومة'}
              </span>
              <span style={{ fontSize: 12, color: '#64748b' }}>
                {[...matchState.items.values()].filter(o => o.team).length} ايتم يُحتسب ضمن تيم ·{' '}
                {[...matchState.items.values()].filter(o => !o.team).length} بلا مدير شركة
              </span>
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div style={{ overflowX: 'auto', margin: '12px 0', border: '1px solid #e2e8f0', borderRadius: 10, maxHeight: '55vh', overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {cols.map(c => <th key={c.key} style={{ ...th, minWidth: c.w }}>{c.label}</th>)}
                    <th style={{ ...th, minWidth: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      {cols.map(c => (
                        <td key={c.key} style={td}>
                          {c.key === 'date' ? (
                            <input type="date" value={r.date} onChange={e => setCell(i, 'date', e.target.value)} style={cell} />
                          ) : c.key === 'repName' ? (
                            <SmartSuggestInput value={r.repName} onChange={v => setCell(i, 'repName', v)} options={scope.reps} />
                          ) : c.key === 'company' ? (
                            <SmartSuggestInput value={r.company} onChange={v => setCell(i, 'company', v)} options={match?.companyList ?? scope.companies} />
                          ) : c.key === 'item' ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <div style={{ flex: 1 }}>
                                <SmartSuggestInput value={r.item} onChange={v => setCell(i, 'item', v)} options={provinceMode && catalogNames.length ? catalogNames : scope.items} />
                              </div>
                              {provinceMode && (r.itemId
                                ? <span title="مربوط بايتم النظام" style={{ color: '#16a34a', fontSize: 13 }}>🔗</span>
                                : r.item.trim() && !keepRaw['i|' + r.item.trim()] && <span title="لم يُطابَق بعد مع ايتم النظام" style={{ color: '#d97706', fontSize: 13 }}>⚠️</span>)}
                            </div>
                          ) : c.key === 'warehouse' ? (
                            <SmartSuggestInput value={r.warehouse} onChange={v => setCell(i, 'warehouse', v)} options={scope.warehouses} />
                          ) : c.key === 'province' ? (
                            <SmartSuggestInput value={r.province} onChange={v => setCell(i, 'province', v)} options={provinceOptions} />
                          ) : c.numeric ? (
                            <input value={r[c.key]} inputMode="decimal" onChange={e => setCell(i, c.key, e.target.value)} style={{ ...cell, textAlign: 'left' }} />
                          ) : (
                            <input value={r[c.key]} onChange={e => setCell(i, c.key, e.target.value)} style={cell} />
                          )}
                        </td>
                      ))}
                      <td style={{ ...td, textAlign: 'center' }}>
                        <button onClick={() => removeRow(i)} style={delBtn} title="حذف الصف">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ padding: 14, background: '#f8fafc', borderRadius: 12, border: '1px solid #e2e8f0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>تُضاف الصفوف إلى «ملف اللكوديشن» (مرتبط بميركاتو، المكرر يُسقَط تلقائياً) — العملة:</span>
              <select value={currency} onChange={e => setCurrency(e.target.value as 'IQD' | 'USD')} style={{ ...cell, background: '#fff', width: 'auto' }}>
                <option value="IQD">IQD</option>
                <option value="USD">USD</option>
              </select>
              {provinceMode && (
                <>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155', marginInlineStart: 8 }}>المحافظة لكل الصفوف الفارغة:</span>
                  <select value="" onChange={e => { if (e.target.value) fillProvince(e.target.value); }} style={{ ...cell, background: '#fff', width: 'auto' }}>
                    <option value="">— اختر —</option>
                    {provinceOptions.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <span style={{ fontSize: 11.5, color: '#64748b' }}>
                    {rows.filter(r => !r.province.trim()).length} صف بلا محافظة
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155', marginInlineStart: 8 }}>التاريخ لكل الصفوف الفارغة:</span>
                  <input type="date" value="" onChange={e => { if (e.target.value) fillDate(e.target.value); }} style={{ ...cell, background: '#fff', width: 'auto' }} />
                  <span style={{ fontSize: 11.5, color: rows.some(r => !r.date) ? '#b91c1c' : '#64748b' }}>
                    {rows.filter(r => !r.date).length} صف بلا تاريخ
                  </span>
                </>
              )}
            </div>
          </>
        )}

        {error && <div style={errBox}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-start', marginTop: 16 }}>
          <button onClick={onSave} disabled={rows.length === 0 || saving || parsing || checking || matching} style={saveBtn}>
            {checking ? '🔎 جاري فحص الأسماء…' : matching ? '🔗 جاري المطابقة…' : saving ? '⏳ جاري الحفظ…' : '💾 حفظ في ملف اللكوديشن'}
          </button>
          <button onClick={onClose} style={cancelBtn}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

/** ترتيب لوحة المطابقة: ما يحتاج قراراً أولاً. */
const order = (s: MatchStatus) => (s === 'ask' ? 0 : s === 'none' ? 1 : s === 'auto' ? 2 : 3);

// ── styles ──
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9999, padding: '24px 12px', overflowY: 'auto' };
const panel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 22, width: '100%', maxWidth: 1180, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' };
const header: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 };
const xBtn: React.CSSProperties = { background: 'none', border: 'none', fontSize: 20, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 };
const topBar: React.CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap' };
const downloadBtn: React.CSSProperties = { padding: '9px 18px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const uploadBtn: React.CSSProperties = { padding: '9px 18px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const addBtn: React.CSSProperties = { padding: '9px 18px', background: '#f1f5f9', color: '#334155', border: '1px dashed #cbd5e1', borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const matchBtn: React.CSSProperties = { padding: '9px 18px', background: '#0891b2', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const matchBox: React.CSSProperties = { marginTop: 12, padding: 14, border: '1px solid #a5f3fc', background: '#f0fdff', borderRadius: 12 };
const matchList: React.CSSProperties = { maxHeight: '42vh', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' };
const chip: React.CSSProperties = { border: '1px solid #c7d2fe', background: '#eef2ff', color: '#3730a3', borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', direction: 'ltr' };
const th: React.CSSProperties = { padding: '8px 6px', fontSize: 11, fontWeight: 700, color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '3px 4px', verticalAlign: 'top' };
const cell: React.CSSProperties = { width: '100%', padding: '6px 8px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, direction: 'rtl', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' };
const delBtn: React.CSSProperties = { background: 'none', border: '1px solid #fecaca', color: '#f87171', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 14, lineHeight: 1 };
const warnBox: React.CSSProperties = { marginTop: 10, padding: '9px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, color: '#92400e', fontSize: 12.5, lineHeight: 1.8 };
const errBox: React.CSSProperties = { marginTop: 12, padding: '9px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 };
const saveBtn: React.CSSProperties = { padding: '10px 24px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const cancelBtn: React.CSSProperties = { padding: '10px 20px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const askOverlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10050, padding: 16 };
const askPanel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 20, width: '100%', maxWidth: 620, boxShadow: '0 20px 60px rgba(0,0,0,0.35)' };
const askCard: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 12, padding: 12, background: '#f8fafc' };
const askOpt: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 10px', cursor: 'pointer' };
const askOptOn: React.CSSProperties = { borderColor: '#6366f1', background: '#eef2ff', fontWeight: 700 };
const askOptNew: React.CSSProperties = { borderColor: '#f59e0b', background: '#fffbeb', fontWeight: 700 };
const bulkBtn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const askCancel: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 10, padding: '9px 16px', fontSize: 13, fontWeight: 700, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' };
const askOk: React.CSSProperties = { border: 'none', background: '#4f46e5', color: '#fff', borderRadius: 10, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' };
