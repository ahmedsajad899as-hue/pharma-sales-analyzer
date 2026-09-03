import { useState, useEffect, useCallback, useRef } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle } from './OfficesPage';
import * as XLSX from 'xlsx';

// ─── أنواع ──────────────────────────────────────────────────────────────────
interface Company { id: number; name: string; officeId?: number; office?: { name: string }; _count?: { items: number } }
interface Item    { id: number; name: string; scientificName?: string; dosage?: string; form?: string; price?: number | null; warehousePrice?: number | null; companyId?: number; companyName?: string }
interface Alias   { id: number; fromName: string; toName: string; toItemId: number | null; toItem?: { id: number; name: string } | null; updatedAt: string }
interface DupPair {
  identical: boolean; samePrice: boolean; sim: number;
  a: { id: number; name: string; price: number | null; sales: number };
  b: { id: number; name: string; price: number | null; sales: number };
}
interface ReviewItem { id: number; name: string; userName: string | null; salesCount: number; confidence: string; suggestions: { id: number; name: string; sim: number }[]; companyId?: number; companyName?: string }

type Tab = 'catalog' | 'aliases' | 'review' | 'import';

// ── استيراد الكتالوج الشامل ──
type ImpAction = 'item-link' | 'item-promote' | 'item-create' | 'item-confirm' | 'skip';
interface ImpItem {
  name: string; price: number | null; action: ImpAction; targetItemId: number | null;
  matchedName: string | null; confidence: string;
  suggestions: { id: number; name: string; sim: number }[];
  tempCandidates: { id: number; name: string; salesCount: number }[];
  currentPrice: number | null; priceChanged: boolean;
}
interface ImpCompany {
  extractedName: string;
  matched: { id: number; name: string } | null;
  confidence: string;
  suggestions: { id: number; name: string; sim: number }[];
  itemCount: number; items: ImpItem[];
  // قرار المدير (يُضاف في الواجهة)
  decision?: 'use' | 'create' | 'skip';
  decisionCompanyId?: number | null;
  rememberAlias?: boolean;
}

// شارات إجراءات الاستيراد الشامل
const ACT_META: Record<string, { label: string; color: string; bg: string }> = {
  'item-link':    { label: '🔗 مربوط',        color: '#059669', bg: '#ecfdf5' },
  'item-promote': { label: '⬆️ من الطابور',    color: '#7c3aed', bg: '#f5f3ff' },
  'item-create':  { label: '➕ جديد',          color: '#2563eb', bg: '#eff6ff' },
  'item-confirm': { label: '⚠️ يحتاج تأكيد',  color: '#b45309', bg: '#fffbeb' },
  'skip':         { label: '⏭ تخطّي',          color: '#64748b', bg: '#f1f5f9' },
};

const CONF_META: Record<string, { label: string; color: string; bg: string }> = {
  alias:  { label: 'قاعدة محفوظة', color: '#059669', bg: '#ecfdf5' },
  exact:  { label: 'تطابق تام',    color: '#059669', bg: '#ecfdf5' },
  high:   { label: 'تطابق قوي',    color: '#2563eb', bg: '#eff6ff' },
  medium: { label: 'محتمل',        color: '#d97706', bg: '#fffbeb' },
  none:   { label: 'جديد',         color: '#64748b', bg: '#f1f5f9' },
};

export default function ItemsCatalogPage({ defaultAll = false }: { defaultAll?: boolean }) {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | 'all' | null>(null);
  const [tab, setTab] = useState<Tab>('catalog');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');

  const [items, setItems]     = useState<Item[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [review, setReview]   = useState<ReviewItem[]>([]);

  // ── تحميل الشركات مرة واحدة ──
  useEffect(() => {
    fetch('/api/sa/companies', { headers: H() })
      .then(r => r.json())
      .then(d => {
        const list: Company[] = Array.isArray(d.data) ? d.data : [];
        setCompanies(list);
        setCompanyId(prev => prev ?? (defaultAll ? 'all' : (list[0]?.id ?? null)));
      })
      .catch(() => setErr('تعذّر تحميل الشركات'));
  }, [H, defaultAll]);

  // في وضع «كل الشركات» تبويبا قواعد التوحيد والاستيراد الشامل غير متاحين
  // (الأول يحتاج شركة محددة، والثاني أصلاً لا يتبع الشركة المختارة)
  useEffect(() => {
    if (companyId === 'all' && (tab === 'aliases' || tab === 'import')) setTab('catalog');
  }, [companyId, tab]);

  // ── تحميل بيانات التبويب للشركة المختارة (أو تجميعها من كل الشركات) ──
  const reload = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setErr('');
    try {
      if (companyId === 'all') {
        const itemResults = await Promise.all(companies.map(c =>
          fetch(`/api/sa/companies/${c.id}`, { headers: H() }).then(r => r.json())
            .then(d => ({ c, items: (d.data?.items || []) as Item[] }))
            .catch(() => ({ c, items: [] as Item[] }))
        ));
        setItems(itemResults.flatMap(({ c, items }) => items.map(i => ({ ...i, companyId: c.id, companyName: c.name }))));
        if (tab === 'review') {
          const revResults = await Promise.all(companies.map(c =>
            fetch(`/api/sa/companies/${c.id}/review-queue`, { headers: H() }).then(r => r.json())
              .then(d => ({ c, review: (Array.isArray(d.data) ? d.data : []) as ReviewItem[] }))
              .catch(() => ({ c, review: [] as ReviewItem[] }))
          ));
          // نفس الايتم المؤقت (نفس id) يظهر تحت كل شركة يرتبط مستخدمه بها — نفس
          // المستخدم قد يكون مربوطاً بعدة شركات. نجمّعه بصف واحد ونذكر كل الشركات
          // بدل تكراره حرفياً بالقائمة المجمّعة.
          const byId = new Map<number, ReviewItem>();
          const namesById = new Map<number, Set<string>>();
          for (const { c, review } of revResults) {
            for (const r of review) {
              if (!byId.has(r.id)) byId.set(r.id, { ...r, companyId: c.id });
              if (!namesById.has(r.id)) namesById.set(r.id, new Set());
              namesById.get(r.id)!.add(c.name);
            }
          }
          setReview(Array.from(byId.values()).map(r => ({
            ...r, companyName: Array.from(namesById.get(r.id) || []).join(' / '),
          })));
        } else {
          setReview([]);
        }
        setAliases([]);
      } else {
        // الكتالوج مطلوب في كل التبويبات (للاختيار/العرض)
        const detail = await fetch(`/api/sa/companies/${companyId}`, { headers: H() }).then(r => r.json());
        setItems(detail.data?.items || []);
        if (tab === 'aliases') {
          const d = await fetch(`/api/sa/companies/${companyId}/aliases`, { headers: H() }).then(r => r.json());
          setAliases(Array.isArray(d.data) ? d.data : []);
        } else if (tab === 'review') {
          const d = await fetch(`/api/sa/companies/${companyId}/review-queue`, { headers: H() }).then(r => r.json());
          setReview(Array.isArray(d.data) ? d.data : []);
        }
        // تبويب 'import' لا يجلب شيئاً — الملف يشمل عدة شركات ولا يتبع المختارة
      }
    } catch { setErr('تعذّر تحميل البيانات'); }
    setLoading(false);
  }, [companyId, tab, H, companies]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setSelectMode(false); setSelectedIds([]); }, [companyId, tab]);

  // ── حالة الاستيراد الشامل ──
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [impRows, setImpRows]       = useState<{ code: string; name: string; price: any }[]>([]);
  const [impPlan, setImpPlan]       = useState<ImpCompany[] | null>(null);
  const [impTotals, setImpTotals]   = useState<any>(null);
  const [impBusy, setImpBusy]       = useState(false);
  const [impResult, setImpResult]   = useState<any>(null);
  const [impFileName, setImpFileName] = useState('');
  const [impCols, setImpCols] = useState<{ code: string; name: string; price: string | null } | null>(null);

  // ── أفعال الاستيراد الشامل ──
  // الملف يُحلَّل في المتصفح ثم تُرسل الصفوف JSON (نفس نمط CompaniesPage)،
  // فلا حاجة لرفع multipart. المطابقة كلها في السيرفر لأنها تحتاج قاعدة البيانات.
  const onImportFile = async (file: File) => {
    setErr(''); setImpResult(null); setImpPlan(null); setImpTotals(null);
    setImpFileName(file.name); setImpCols(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw: any[] = XLSX.utils.sheet_to_json(ws, { defval: '' });

      // الأعمدة: A = كود يحمل اسم الشركة، B = اسم الايتم، C = السعر.
      // نطابق الترويسات بمرونة لأن التسمية تختلف بين الملفات.
      // خريطة الأعمدة: تمريران — تطابق تام أولاً ثم احتواء، مع منع عمود واحد
      // من خدمة حقلين. بدون ذلك كان حقل «الايتم» يلتقط ترويسة «item code»
      // (لأنها تحتوي كلمة item وتسبقه في الترتيب)، فيصير اسم الايتم = كود
      // الشركة، وتنهار كل صفوف الشركة الواحدة إلى صف واحد.
      const normHdr = (h: string) => String(h).toLowerCase().trim()
        .replace(/\u0629/g, '\u0647').replace(/\s+/g, ' ');

      const FIELD_HDRS: Record<string, { exact: string[]; contains: string[] }> = {
        code: {
          exact: ['item code', 'itemcode', 'code', 'كود', 'كود الايتم', 'الشركه', 'شركه',
                  'اسم الشركه', 'company', 'company name', 'الشركة'],
          contains: ['كود', 'code', 'شرك', 'company'],
        },
        name: {
          exact: ['item', 'item name', 'itemname', 'name', 'الايتم', 'ايتم', 'اسم الايتم',
                  'الصنف', 'اسم الصنف', 'الماده', 'اسم الماده', 'المنتج', 'الدواء'],
          contains: ['ايتم', 'صنف', 'ماده', 'منتج', 'دواء', 'item'],
        },
        price: {
          exact: ['price', 'السعر', 'سعر', 'سعر المكتب', 'office price'],
          contains: ['price', 'سعر'],
        },
      };

      const headers = raw.length ? Object.keys(raw[0]) : [];
      const chosen: Record<string, string | null> = { code: null, name: null, price: null };
      const used = new Set<string>();

      for (const f of ['code', 'name', 'price']) {
        const hit = headers.find(h => !used.has(h) && FIELD_HDRS[f].exact.includes(normHdr(h)));
        if (hit) { chosen[f] = hit; used.add(hit); }
      }
      for (const f of ['code', 'name', 'price']) {
        if (chosen[f]) continue;
        const hit = headers.find(h => !used.has(h) && FIELD_HDRS[f].contains.some(x => normHdr(h).includes(x)));
        if (hit) { chosen[f] = hit; used.add(hit); }
      }

      if (!chosen.code || !chosen.name) {
        setErr(`تعذّر تحديد الأعمدة. وُجد: ${headers.join(' | ')} — المطلوب عمود للشركة/الكود وعمود لاسم الايتم.`);
        return;
      }
      setImpCols({ code: chosen.code, name: chosen.name, price: chosen.price });

      const rows = raw.map(r => ({
        code:  String(r[chosen.code!] ?? '').trim(),
        name:  String(r[chosen.name!] ?? '').trim(),
        price: chosen.price ? r[chosen.price] : null,
      })).filter(r => r.code && r.name);

      if (rows.length === 0) { setErr('لم يُعثر على صفوف صالحة — تأكد من وجود أعمدة الكود والاسم والسعر'); return; }
      setImpRows(rows);
      await runPreview(rows);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّرت قراءة الملف');
    }
  };

  const runPreview = async (rows: { code: string; name: string; price: any }[]) => {
    setImpBusy(true); setErr('');
    try {
      const officeId = companies.find(c => c.id === companyId)?.officeId ?? 1;
      const r = await fetch('/api/sa/catalog-import/preview', {
        method: 'POST', headers: H(), body: JSON.stringify({ officeId, rows }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشلت المعاينة');
      // قرار مبدئي لكل شركة: المطابَقة بثقة عالية تُستخدم مباشرة، وغيرها تنتظر المدير
      const plan: ImpCompany[] = (d.data.companies || []).map((c: ImpCompany) => ({
        ...c,
        decision: c.matched ? 'use' : undefined,
        decisionCompanyId: c.matched?.id ?? null,
        rememberAlias: c.confidence !== 'exact' && c.confidence !== 'alias',
      }));
      setImpPlan(plan);
      setImpTotals(d.data.totals);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'فشلت المعاينة');
    }
    setImpBusy(false);
  };

  const setCompanyDecision = (idx: number, patch: Partial<ImpCompany>) =>
    setImpPlan(prev => prev ? prev.map((c, i) => i === idx ? { ...c, ...patch } : c) : prev);

  const setItemDecision = (ci: number, ii: number, patch: Partial<ImpItem>) =>
    setImpPlan(prev => prev ? prev.map((c, i) => i !== ci ? c : {
      ...c, items: c.items.map((it, j) => j === ii ? { ...it, ...patch } : it),
    }) : prev);

  // القرارات الناقصة تمنع التطبيق — هذا ما يحقق «نبّهني إذا هذا الاسم نفسه ذاك»
  const pendingCount = (impPlan ?? []).reduce((n, c) => {
    if (!c.decision) return n + 1;
    if (c.decision === 'skip') return n;
    if (c.decision === 'use' && !c.decisionCompanyId) return n + 1;
    return n + c.items.filter(it => it.action === 'item-confirm' && !it.targetItemId).length;
  }, 0);

  const commitImport = async () => {
    if (!impPlan) return;
    if (!confirm('سيتم تطبيق الخطة: إنشاء الشركات والايتمات الناقصة وتحديث الأسعار. متابعة؟')) return;
    setImpBusy(true); setErr('');
    try {
      const officeId = companies.find(c => c.id === companyId)?.officeId ?? 1;
      const payload = {
        officeId,
        companies: impPlan.map(c => ({
          extractedName: c.extractedName,
          action: c.decision ?? 'skip',
          companyId: c.decisionCompanyId ?? null,
          newName: c.extractedName,
          rememberAlias: !!c.rememberAlias,
          items: c.items.map(it => ({
            name: it.name, price: it.price,
            action: it.action === 'item-confirm' && !it.targetItemId ? 'skip' : it.action,
            targetItemId: it.targetItemId,
          })),
        })),
      };
      const r = await fetch('/api/sa/catalog-import/commit', {
        method: 'POST', headers: H(), body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل التطبيق');
      setImpResult(d.summary);
      setImpPlan(null);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'فشل التطبيق');
    }
    setImpBusy(false);
  };

  // ── أفعال الكتالوج ──
  const [itemModal, setItemModal] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', scientificName: '', dosage: '', form: '', price: '', warehousePrice: '' });
  const addItem = async () => {
    if (!newItem.name.trim() || !companyId || companyId === 'all') return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${companyId}/items`, { method: 'POST', headers: H(), body: JSON.stringify(newItem) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      setItemModal(false); setNewItem({ name: '', scientificName: '', dosage: '', form: '', price: '', warehousePrice: '' });
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل إضافة الايتم'); }
    setBusy(false);
  };
  const delItem = async (it: Item) => {
    const cid = it.companyId ?? companyId;
    if (!cid || cid === 'all' || !confirm('إزالة هذا الايتم من كتالوج الشركة؟')) return;
    setBusy(true);
    await fetch(`/api/sa/companies/${cid}/items/${it.id}`, { method: 'DELETE', headers: H() });
    setBusy(false); await reload();
  };

  // ── تعديل أسعار ايتم (مكتب / مذخر) ──
  const [priceFor, setPriceFor] = useState<Item | null>(null);
  const [priceForm, setPriceForm] = useState({ price: '', warehousePrice: '' });
  const openPriceEdit = (i: Item) => {
    setPriceFor(i);
    setPriceForm({ price: i.price != null ? String(i.price) : '', warehousePrice: i.warehousePrice != null ? String(i.warehousePrice) : '' });
  };
  const savePrice = async () => {
    const cid = priceFor?.companyId ?? companyId;
    if (!cid || cid === 'all' || !priceFor) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${cid}/items/${priceFor.id}`, {
        method: 'PATCH', headers: H(), body: JSON.stringify(priceForm),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      setPriceFor(null);
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل حفظ السعر'); }
    setBusy(false);
  };

  // ── نقل ايتم لشركة أخرى (أُدخل بالخطأ) ──
  const [transferFor, setTransferFor] = useState<Item | null>(null);
  const [transferTarget, setTransferTarget] = useState<string>('');
  const doTransfer = async () => {
    const cid = transferFor?.companyId ?? companyId;
    if (!cid || cid === 'all' || !transferFor || !transferTarget) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${cid}/items/${transferFor.id}/transfer`, {
        method: 'POST', headers: H(), body: JSON.stringify({ targetCompanyId: parseInt(transferTarget) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      setTransferFor(null); setTransferTarget('');
      await reload();
      const dest = companies.find(c => c.id === parseInt(transferTarget))?.name || 'الشركة الهدف';
      alert(d.action === 'merged' ? `تم دمج الايتم مع ايتم مطابق موجود في ${dest}` : `تم نقل الايتم إلى ${dest}`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل نقل الايتم'); }
    setBusy(false);
  };

  // ── اقتراحات دمج ايتمات مكررة (بتأكيد المدير — لا دمج تلقائي) ──
  const [dupPairs, setDupPairs] = useState<DupPair[] | null>(null);
  const [dupBusy, setDupBusy]   = useState(false);

  const loadDupSuggestions = async () => {
    if (!companyId || companyId === 'all') return;
    setDupBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${companyId}/item-merge-suggestions`, { headers: H() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      setDupPairs(Array.isArray(d.data) ? d.data : []);
    } catch (e) { setErr(e instanceof Error ? e.message : 'تعذّر جلب الاقتراحات'); }
    setDupBusy(false);
  };

  // fromId يُمتص في toId — كل مبيعاته وزياراته وتارگته تنتقل للهدف ثم يُحذف
  const mergeTwoItems = async (fromId: number, toId: number, fromName: string, toName: string) => {
    if (!companyId || companyId === 'all') return;
    if (!confirm(`دمج «${fromName}» داخل «${toName}»؟\n\nتنتقل كل مبيعات وزيارات «${fromName}» إلى «${toName}» ثم يُحذف، ويُحفظ اسمه كقاعدة توحيد.\n\nلا يمكن التراجع.`)) return;
    setDupBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${companyId}/items/merge`, {
        method: 'POST', headers: H(), body: JSON.stringify({ fromId, toId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل الدمج');
      setDupPairs(prev => prev ? prev.filter(p => p.a.id !== fromId && p.b.id !== fromId) : prev);
      exitSelectMode();
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل الدمج'); }
    setDupBusy(false);
  };

  // ── تحديد متعدد + نقل جماعي لشركة أخرى ──
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkTransferOpen, setBulkTransferOpen] = useState(false);
  const [bulkTarget, setBulkTarget] = useState('');
  const toggleSelected = (id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds([]); };
  const doBulkTransfer = async () => {
    if (!companyId || companyId === 'all' || !bulkTarget || selectedIds.length === 0) return;
    setBusy(true); setErr('');
    let transferred = 0, merged = 0, failed = 0;
    for (const id of selectedIds) {
      try {
        const r = await fetch(`/api/sa/companies/${companyId}/items/${id}/transfer`, {
          method: 'POST', headers: H(), body: JSON.stringify({ targetCompanyId: parseInt(bulkTarget) }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'فشل');
        if (d.action === 'merged') merged++; else transferred++;
      } catch { failed++; }
    }
    setBulkTransferOpen(false); setBulkTarget('');
    exitSelectMode();
    await reload();
    setBusy(false);
    const dest = companies.find(c => c.id === parseInt(bulkTarget))?.name || 'الشركة الهدف';
    alert(
      `تم نقل ${transferred + merged} ايتم إلى ${dest}` +
      (merged ? ` (منهم ${merged} تم دمجها مع ايتمات مطابقة)` : '') +
      (failed ? ` — تعذّر نقل ${failed}` : '')
    );
  };

  // ── أفعال قواعد التوحيد (aliases) ──
  const [aliasModal, setAliasModal] = useState(false);
  const [newAlias, setNewAlias] = useState({ fromName: '', toItemId: '' });
  const addAlias = async () => {
    if (!newAlias.fromName.trim() || !newAlias.toItemId || !companyId || companyId === 'all') return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${companyId}/aliases`, { method: 'POST', headers: H(), body: JSON.stringify(newAlias) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      setAliasModal(false); setNewAlias({ fromName: '', toItemId: '' });
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل إضافة القاعدة'); }
    setBusy(false);
  };
  const delAlias = async (id: number) => {
    if (!companyId || companyId === 'all' || !confirm('حذف قاعدة التوحيد هذه؟')) return;
    setBusy(true);
    await fetch(`/api/sa/companies/${companyId}/aliases/${id}`, { method: 'DELETE', headers: H() });
    setBusy(false); await reload();
  };

  // ── أفعال طابور المراجعة ──
  // reviewCompanyId: شركة الايتم المؤقت نفسه (وليس بالضرورة الشركة المختارة أعلاه —
  // في وضع «كل الشركات» كل صف بطابور المراجعة قد يخص شركة مختلفة).
  // targetCompanyId اختياري: يسمح بإضافة ايتم من الطابور لكتالوج شركة أخرى
  // مباشرةً بدل تبديل الشركة المعروضة أولاً. غيابه = شركة الايتم نفسها.
  const resolveReview = async (
    reviewCompanyId: number,
    tempItemId: number,
    action: 'link' | 'add' | 'delete',
    targetItemId?: number,
    targetCompanyId?: number,
  ) => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${reviewCompanyId}/review-queue/resolve`, {
        method: 'POST', headers: H(), body: JSON.stringify({ tempItemId, action, targetItemId, targetCompanyId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل المعالجة'); }
    setBusy(false);
  };

  const filteredItems = items.filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()));
  const filteredAliases = aliases.filter(a => !search || a.fromName.toLowerCase().includes(search.toLowerCase()) || a.toName.toLowerCase().includes(search.toLowerCase()));
  const filteredReview = review.filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase()));

  const tabs: { id: Tab; label: string; count: number; icon: string }[] = [
    { id: 'catalog', label: 'الكتالوج',       count: items.length,   icon: '💊' },
    ...(companyId !== 'all' ? [{ id: 'aliases' as Tab, label: 'قواعد التوحيد',  count: aliases.length, icon: '🔗' }] : []),
    { id: 'review',  label: 'طابور المراجعة', count: review.length,  icon: '🆕' },
    ...(companyId !== 'all' ? [{ id: 'import' as Tab, label: 'استيراد شامل',   count: impPlan ? impPlan.length : 0, icon: '📥' }] : []),
  ];

  return (
    <div style={{ direction: 'rtl' }}>
      {/* رأس: اختيار الشركة */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 18, color: '#1e1b4b' }}>💊 إدارة الايتمات</span>
        <select
          value={companyId ?? ''}
          onChange={e => setCompanyId(e.target.value === 'all' ? 'all' : (e.target.value ? parseInt(e.target.value) : null))}
          style={{ padding: '9px 14px', borderRadius: 10, border: '1.5px solid #e2e8f0', fontSize: 14, fontWeight: 600, minWidth: 220, background: '#fff', cursor: 'pointer' }}
        >
          <option value="all">🏢 كل الشركات (نظرة عامة)</option>
          {companies.map(c => (
            <option key={c.id} value={c.id}>{c.name}{c.office?.name ? ` — ${c.office.name}` : ''}</option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>
          {companyId === 'all'
            ? 'عرض مجمّع لايتمات كل الشركات — كل إجراء يُطبَّق تلقائياً على شركة الايتم نفسه'
            : 'الكتالوج والقواعد مشتركة بين كل مستخدمي الشركة'}
        </span>
      </div>

      {err && <ErrBox msg={err} />}

      {/* تبويبات */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => { setTab(t.id); setSearch(''); }} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 12,
              border: active ? '1.5px solid #6366f1' : '1.5px solid #e2e8f0',
              background: active ? '#eef2ff' : '#fff', cursor: 'pointer',
              fontSize: 14, fontWeight: active ? 800 : 600, color: active ? '#4338ca' : '#64748b',
            }}>
              <span>{t.icon}</span>{t.label}
              <span style={{ background: active ? '#6366f1' : '#e2e8f0', color: active ? '#fff' : '#64748b', borderRadius: 20, padding: '1px 9px', fontSize: 12, fontWeight: 800 }}>{t.count}</span>
            </button>
          );
        })}
        <div style={{ marginRight: 'auto', display: 'flex', gap: 8 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 بحث..."
            style={{ padding: '8px 14px', borderRadius: 10, border: '1.5px solid #e2e8f0', fontSize: 13, minWidth: 200 }} />
          {tab === 'catalog' && companyId !== 'all' && (
            <button onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)} style={btnStyle(selectMode ? '#64748b' : '#0891b2')}>
              {selectMode ? '✕ إلغاء التحديد' : '☑ تحديد متعدد'}
            </button>
          )}
          {tab === 'catalog' && companyId !== 'all' && (
            <button onClick={loadDupSuggestions} disabled={dupBusy} style={btnStyle('#d97706')}>
              {dupBusy ? '...' : '🔍 اقتراحات الدمج'}
            </button>
          )}
          {tab === 'catalog' && companyId !== 'all' && <button onClick={() => setItemModal(true)} style={btnStyle('#6366f1')}>+ إضافة ايتم</button>}
          {tab === 'aliases' && <button onClick={() => setAliasModal(true)} style={btnStyle('#0891b2')} disabled={items.length === 0}>+ قاعدة توحيد</button>}
        </div>
      </div>

      {loading ? <Spinner /> : (
        <>
          {/* ── الكتالوج ── */}
          {tab === 'catalog' && (
            <>
              {dupPairs !== null && (
                <div style={{ border: '1.5px solid #fcd34d', background: '#fffbeb', borderRadius: 12, padding: 14, marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13, color: '#92400e' }}>🔍 ايتمات متشابهة ({dupPairs.length})</strong>
                    <span style={{ fontSize: 11, color: '#a16207' }}>
                      راجع كل زوج بنفسك — التشابه لا يعني التطابق (عبوة 1 amp مقابل 5 amp، أو IM مقابل IV، منتجات مختلفة).
                    </span>
                    <button onClick={() => setDupPairs(null)} style={{ ...btnStyle('#64748b', true), fontSize: 11, padding: '3px 10px', marginRight: 'auto' }}>✕ إغلاق</button>
                  </div>
                  {dupPairs.length === 0 && <div style={{ fontSize: 12, color: '#64748b' }}>لا توجد ايتمات متشابهة في هذه الشركة 🎉</div>}
                  {dupPairs.map((pr, idx) => (
                    <div key={idx} style={{ background: '#fff', border: '1px solid #fde68a', borderRadius: 10, padding: 10, marginBottom: 8 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                        {pr.identical && <span style={{ fontSize: 10, fontWeight: 700, color: '#059669', background: '#ecfdf5', padding: '2px 8px', borderRadius: 20 }}>تطابق تام</span>}
                        {pr.samePrice && <span style={{ fontSize: 10, fontWeight: 700, color: '#2563eb', background: '#eff6ff', padding: '2px 8px', borderRadius: 20 }}>نفس السعر</span>}
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>تشابه {Math.round(pr.sim * 100)}%</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        {[pr.a, pr.b].map((side, k) => {
                          const other = k === 0 ? pr.b : pr.a;
                          return (
                            <div key={side.id} style={{ border: '1px solid #e8edf5', borderRadius: 8, padding: 8 }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: '#1e293b', marginBottom: 4 }}>{side.name}</div>
                              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
                                🏢 {side.price == null ? '—' : side.price.toLocaleString('ar-IQ')} · 📊 {side.sales} مبيعة
                              </div>
                              <button
                                disabled={dupBusy}
                                onClick={() => mergeTwoItems(other.id, side.id, other.name, side.name)}
                                style={{ ...btnStyle('#059669', true), fontSize: 11, padding: '4px 10px', width: '100%' }}
                              >⬅ أبقِ هذا وادمج الآخر فيه</button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {selectMode && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  background: '#eef2ff', border: '1.5px solid #c7d2fe', borderRadius: 12,
                  padding: '10px 14px', marginBottom: 12,
                }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: '#4338ca' }}>{selectedIds.length} محدد</span>
                  <button
                    onClick={() => setSelectedIds(
                      filteredItems.every(i => selectedIds.includes(i.id)) ? [] : filteredItems.map(i => i.id)
                    )}
                    style={{ ...btnStyle('#6366f1', true), fontSize: 12, padding: '4px 12px' }}
                  >
                    {filteredItems.length > 0 && filteredItems.every(i => selectedIds.includes(i.id)) ? 'إلغاء تحديد الكل' : '✓ تحديد الكل'}
                  </button>
                  {/* دمج يدوي لايتمين — يغطي الحالات التي لا تقترحها الخوارزمية
                      عمداً، مثل «AMOKLAVIN BID 400/57MG» و«... 457MG» حيث يمنع
                      حارس الجرعة الاقتراح لأنه لا يعرف أن 400+57 = 457. */}
                  {selectedIds.length === 2 && (() => {
                    const [x, y] = selectedIds.map(id => items.find(i => i.id === id)).filter(Boolean) as Item[];
                    if (!x || !y) return null;
                    return (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, color: '#4338ca', fontWeight: 700 }}>🔗 دمج:</span>
                        <button
                          disabled={dupBusy}
                          onClick={() => mergeTwoItems(y.id, x.id, y.name, x.name)}
                          title={`يُبقي «${x.name}» ويدمج «${y.name}» فيه`}
                          style={{ ...btnStyle('#059669', true), fontSize: 11, padding: '4px 10px' }}
                        >أبقِ «{x.name}»</button>
                        <button
                          disabled={dupBusy}
                          onClick={() => mergeTwoItems(x.id, y.id, x.name, y.name)}
                          title={`يُبقي «${y.name}» ويدمج «${x.name}» فيه`}
                          style={{ ...btnStyle('#059669', true), fontSize: 11, padding: '4px 10px' }}
                        >أبقِ «{y.name}»</button>
                      </div>
                    );
                  })()}
                  <button
                    onClick={() => setBulkTransferOpen(true)}
                    disabled={selectedIds.length === 0}
                    style={{ ...btnStyle('#0891b2', true), fontSize: 12, padding: '4px 12px', marginRight: 'auto' }}
                  >
                    ↔ نقل المحدد لشركة أخرى
                  </button>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
                {filteredItems.map(i => (
                  <div key={i.id} style={{
                    border: selectMode && selectedIds.includes(i.id) ? '1.5px solid #6366f1' : '1px solid #e8edf5',
                    background: selectMode && selectedIds.includes(i.id) ? '#eef2ff' : '#fff',
                    borderRadius: 12, padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
                    cursor: selectMode ? 'pointer' : 'default',
                  }} onClick={() => selectMode && toggleSelected(i.id)}>
                    <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                      {selectMode && (
                        <input type="checkbox" checked={selectedIds.includes(i.id)} onChange={() => toggleSelected(i.id)}
                          onClick={e => e.stopPropagation()} style={{ marginTop: 3, width: 16, height: 16, flexShrink: 0, cursor: 'pointer' }} />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{i.name}</div>
                        {i.companyName && (
                          <div style={{ fontSize: 11, color: '#7c3aed', marginTop: 2, fontWeight: 700 }}>🏢 {i.companyName}</div>
                        )}
                        {(i.scientificName || i.dosage || i.form) && (
                          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>
                            {[i.scientificName, i.dosage, i.form].filter(Boolean).join(' · ')}
                          </div>
                        )}
                        {(i.price != null || i.warehousePrice != null) && (
                          <div style={{ fontSize: 11, color: '#0891b2', marginTop: 4, display: 'flex', gap: 10 }}>
                            {i.price != null && <span>🏢 مكتب: {i.price.toLocaleString('ar-IQ')}</span>}
                            {i.warehousePrice != null && <span>📦 مذخر: {i.warehousePrice.toLocaleString('ar-IQ')}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                    {!selectMode && (
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button onClick={() => openPriceEdit(i)} title="تعديل السعر" style={btnStyle('#059669', true)}>💲</button>
                        <button onClick={() => { setTransferFor(i); setTransferTarget(''); }} title="نقل لشركة أخرى" style={btnStyle('#0891b2', true)}>↔</button>
                        <button onClick={() => delItem(i)} title="إزالة" style={btnStyle('#ef4444', true)}>🗑</button>
                      </div>
                    )}
                  </div>
                ))}
                {filteredItems.length === 0 && <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center', gridColumn: '1/-1' }}>لا توجد ايتمات في الكتالوج</div>}
              </div>
            </>
          )}

          {/* ── قواعد التوحيد ── */}
          {tab === 'aliases' && (
            <div style={{ border: '1px solid #e8edf5', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', padding: '10px 14px', background: '#f8fafc', fontWeight: 700, fontSize: 12, color: '#64748b' }}>
                <div style={{ flex: 1 }}>الاسم البديل (كما يظهر بالملفات)</div>
                <div style={{ flex: 1 }}>← الايتم القانوني</div>
                <div style={{ width: 80, textAlign: 'center' }}>حذف</div>
              </div>
              {filteredAliases.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderTop: '1px solid #f1f5f9', fontSize: 13 }}>
                  <div style={{ flex: 1, color: '#b45309' }}>{a.fromName}</div>
                  <div style={{ flex: 1, color: '#059669', fontWeight: 600 }}>{a.toItem?.name || a.toName}</div>
                  <div style={{ width: 80, textAlign: 'center' }}>
                    <button onClick={() => delAlias(a.id)} style={btnStyle('#ef4444', true)}>🗑</button>
                  </div>
                </div>
              ))}
              {filteredAliases.length === 0 && <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>لا توجد قواعد توحيد محفوظة بعد</div>}
            </div>
          )}

          {/* ── طابور المراجعة ── */}
          {tab === 'review' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredReview.map(r => {
                const cm = CONF_META[r.confidence] || CONF_META.none;
                const rCompanyId = r.companyId ?? (companyId as number);
                const companyItems = r.companyId ? items.filter(i => i.companyId === r.companyId) : items;
                return (
                  <div key={r.id} style={{ border: '1px solid #e8edf5', borderRadius: 12, padding: 14, background: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                      <span style={{ fontWeight: 800, fontSize: 15, color: '#1e293b' }}>{r.name}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: cm.color, background: cm.bg, padding: '2px 10px', borderRadius: 20 }}>{cm.label}</span>
                      {r.companyName && <span style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed' }}>🏢 {r.companyName}</span>}
                      {r.salesCount > 0 && <span style={{ fontSize: 11, color: '#64748b' }}>📊 {r.salesCount} مبيعة</span>}
                      {r.userName && <span style={{ fontSize: 11, color: '#94a3b8' }}>👤 {r.userName}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      {/* اقتراحات الربط */}
                      {r.suggestions.map(s => (
                        <button key={s.id} onClick={() => resolveReview(rCompanyId, r.id, 'link', s.id)} disabled={busy}
                          style={{ ...btnStyle('#2563eb', true), background: '#eff6ff', color: '#1d4ed8', border: '1.5px solid #bfdbfe' }}>
                          🔗 ربط بـ {s.name}
                        </button>
                      ))}
                      {/* ربط يدوي بأي ايتم من كتالوج نفس الشركة */}
                      <select defaultValue="" onChange={e => { if (e.target.value) resolveReview(rCompanyId, r.id, 'link', parseInt(e.target.value)); }}
                        style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 12 }} disabled={busy || companyItems.length === 0}>
                        <option value="">🔗 ربط بايتم آخر…</option>
                        {companyItems.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                      </select>
                      <button onClick={() => resolveReview(rCompanyId, r.id, 'add')} disabled={busy} style={btnStyle('#059669', true)}>➕ إضافة للكتالوج</button>
                      {/* نقل مباشر لكتالوج شركة أخرى — يوفّر تبديل الشركة المعروضة ثم البحث عن الايتم */}
                      <select
                        value=""
                        onChange={e => {
                          const cid = parseInt(e.target.value);
                          if (!cid) return;
                          const cname = companies.find(c => c.id === cid)?.name ?? '';
                          if (confirm(`نقل «${r.name}» إلى كتالوج شركة «${cname}»؟

تنتقل مبيعاته معه، وإن وُجد ايتم مطابق هناك فسيُدمج فيه.`)) {
                            resolveReview(rCompanyId, r.id, 'add', undefined, cid);
                          }
                        }}
                        disabled={busy || companies.length <= 1}
                        title="إضافة هذا الايتم لكتالوج شركة أخرى مباشرةً"
                        style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid #a7f3d0', background: '#ecfdf5', color: '#047857', fontSize: 12, fontWeight: 700 }}
                      >
                        <option value="">🏢 إضافة لشركة أخرى…</option>
                        {companies.filter(c => c.id !== rCompanyId).map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <button onClick={() => resolveReview(rCompanyId, r.id, 'delete')} disabled={busy} style={btnStyle('#ef4444', true)}>🗑 حذف</button>
                    </div>
                  </div>
                );
              })}
              {filteredReview.length === 0 && <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>لا توجد ايتمات بحاجة مراجعة 🎉</div>}
            </div>
          )}
          {/* ── استيراد شامل من إكسل ── */}
          {tab === 'import' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ border: '1px solid #bfdbfe', background: '#eff6ff', borderRadius: 12, padding: 14, fontSize: 13, color: '#1e3a8a', lineHeight: 1.9 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>📥 استيراد شامل للشركات والايتمات</div>
                هذا التبويب <b>لا يتبع الشركة المختارة أعلاه</b> — الملف يشمل عدة شركات ويُوزّعها بنفسه.<br />
                الأعمدة المتوقّعة: <b>كود الايتم</b> (يُستخرج منه اسم الشركة) · <b>اسم الايتم</b> · <b>السعر</b>.
                أعمدة المذاخر تُتجاهل. لا يُكتب شيء قبل ضغطك «تطبيق».
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <input ref={importInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) onImportFile(f); e.currentTarget.value = ''; }} />
                <button onClick={() => importInputRef.current?.click()} disabled={impBusy} style={btnStyle('#2563eb')}>
                  {impBusy ? '⏳ جاري التحليل...' : '📂 اختيار ملف إكسل'}
                </button>
                {impFileName && <span style={{ fontSize: 12, color: '#64748b' }}>📄 {impFileName}</span>}
                {impCols && (
                  <span style={{ fontSize: 11, color: '#475569', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '4px 10px' }}>
                    🔍 الأعمدة المكتشفة — الشركة: <b>{impCols.code}</b> · الايتم: <b>{impCols.name}</b> · السعر: <b>{impCols.price ?? '—'}</b>
                  </span>
                )}
                {impTotals && (
                  <span style={{ fontSize: 12, color: '#64748b' }}>
                    {impTotals.fileRows} صف · {impTotals.companies} شركة · {impTotals.items} ايتم
                    {impTotals.skippedRows > 0 && ` · تُخطّي ${impTotals.skippedRows}`}
                  </span>
                )}
              </div>

              {impResult && (
                <div style={{ border: '1px solid #86efac', background: '#f0fdf4', borderRadius: 12, padding: 14, fontSize: 13, color: '#166534', lineHeight: 2 }}>
                  <div style={{ fontWeight: 800, marginBottom: 4 }}>✅ تم التطبيق</div>
                  شركات جديدة: <b>{impResult.companiesCreated}</b> · شركات مطابَقة: <b>{impResult.companiesMatched}</b> ·
                  قواعد ربط محفوظة: <b>{impResult.aliasesSaved}</b><br />
                  ايتمات جديدة: <b>{impResult.itemsCreated}</b> · مُرقّاة من الطابور: <b>{impResult.itemsPromoted}</b> ·
                  مربوطة: <b>{impResult.itemsLinked}</b> · أسعار محدّثة: <b>{impResult.itemsPriceUpdated}</b> ·
                  متخطّاة: <b>{impResult.skipped}</b>
                  {impResult.errors?.length > 0 && (
                    <div style={{ marginTop: 8, color: '#b91c1c' }}>
                      <b>أخطاء ({impResult.errors.length}):</b>
                      <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
                        {impResult.errors.slice(0, 10).map((e: string, i: number) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {impPlan && (
                <>
                  <div style={{ position: 'sticky', top: 0, zIndex: 5, background: '#fff', padding: '10px 0', borderBottom: '1px solid #e8edf5', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button onClick={commitImport} disabled={impBusy || pendingCount > 0} style={{ ...btnStyle(pendingCount > 0 ? '#94a3b8' : '#059669'), cursor: pendingCount > 0 ? 'not-allowed' : 'pointer' }}>
                      {impBusy ? '⏳ جاري التطبيق...' : '✅ تطبيق الخطة'}
                    </button>
                    {pendingCount > 0
                      ? <span style={{ fontSize: 13, fontWeight: 700, color: '#b45309' }}>⚠️ {pendingCount} قرار بانتظارك قبل التطبيق</span>
                      : <span style={{ fontSize: 13, color: '#059669' }}>كل القرارات مكتملة</span>}
                    <button onClick={() => { setImpPlan(null); setImpTotals(null); setImpFileName(''); setImpCols(null); }} style={{ ...btnStyle('#94a3b8', true), marginRight: 'auto' }}>إلغاء</button>
                  </div>

                  {impPlan.map((c, ci) => {
                    const needsDecision = !c.decision || (c.decision === 'use' && !c.decisionCompanyId);
                    const cm = CONF_META[c.confidence] || CONF_META.none;
                    return (
                      <div key={c.extractedName + ci} style={{ border: `1px solid ${needsDecision ? '#fcd34d' : '#e8edf5'}`, background: needsDecision ? '#fffbeb' : '#fff', borderRadius: 12, padding: 14 }}>
                        {/* ترويسة الشركة */}
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                          <span style={{ fontWeight: 800, fontSize: 15, color: '#1e293b' }}>🏢 {c.extractedName}</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: cm.color, background: cm.bg, padding: '2px 10px', borderRadius: 20 }}>{cm.label}</span>
                          <span style={{ fontSize: 11, color: '#64748b' }}>{c.itemCount} ايتم</span>

                          <select
                            value={c.decision === 'create' ? '__new__' : c.decision === 'skip' ? '__skip__' : (c.decisionCompanyId ?? '')}
                            onChange={e => {
                              const v = e.target.value;
                              if (v === '__new__')       setCompanyDecision(ci, { decision: 'create', decisionCompanyId: null });
                              else if (v === '__skip__') setCompanyDecision(ci, { decision: 'skip',   decisionCompanyId: null });
                              else if (v === '')         setCompanyDecision(ci, { decision: undefined, decisionCompanyId: null });
                              else                       setCompanyDecision(ci, { decision: 'use', decisionCompanyId: parseInt(v) });
                            }}
                            style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 12, minWidth: 200 }}
                          >
                            <option value="">— اختر الوجهة —</option>
                            <option value="__new__">➕ إنشاء شركة جديدة باسم «{c.extractedName}»</option>
                            <option value="__skip__">⏭ تخطّي هذه الشركة وايتماتها</option>
                            {companies.map(co => <option key={co.id} value={co.id}>🏢 {co.name}</option>)}
                          </select>

                          {c.decision === 'use' && c.decisionCompanyId && (
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', cursor: 'pointer' }}
                              title="يحفظ أن هذا الاسم في الملف يعني هذه الشركة، فتُطابَق تلقائياً في كل رفع لاحق">
                              <input type="checkbox" checked={!!c.rememberAlias} onChange={e => setCompanyDecision(ci, { rememberAlias: e.target.checked })} />
                              تذكّر هذا الربط
                            </label>
                          )}
                        </div>

                        {/* ايتمات الشركة */}
                        {c.decision !== 'skip' && (
                          <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid #eef2f7', borderRadius: 8 }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead>
                                <tr style={{ background: '#f8fafc', position: 'sticky', top: 0 }}>
                                  <th style={{ padding: 8, textAlign: 'right' }}>الايتم</th>
                                  <th style={{ padding: 8, textAlign: 'right', width: 150 }}>الإجراء</th>
                                  <th style={{ padding: 8, textAlign: 'right', width: 130 }}>السعر</th>
                                  <th style={{ padding: 8, textAlign: 'right', width: 220 }}>المطابقة</th>
                                </tr>
                              </thead>
                              <tbody>
                                {c.items.map((it, ii) => {
                                  const am = ACT_META[it.action] || ACT_META['item-create'];
                                  const unresolved = it.action === 'item-confirm' && !it.targetItemId;
                                  return (
                                    <tr key={it.name + ii} style={{ borderTop: '1px solid #f1f5f9', background: unresolved ? '#fffbeb' : '#fff' }}>
                                      <td style={{ padding: 8, fontWeight: 600, color: '#1e293b' }}>
                                        {it.name}
                                        {it.action === 'item-confirm' && (
                                          <span data-x="conf-badge-import" title="مطابقة ضبابية — أكّدها قبل الربط" style={{ marginInlineStart: 6, fontSize: 9, fontWeight: 700, color: (CONF_META[it.confidence] || CONF_META.none).color, background: (CONF_META[it.confidence] || CONF_META.none).bg, padding: '1px 6px', borderRadius: 20 }}>
                                            {(CONF_META[it.confidence] || CONF_META.none).label}
                                          </span>
                                        )}
                                      </td>
                                      <td style={{ padding: 8 }}>
                                        <span style={{ fontSize: 10, fontWeight: 700, color: am.color, background: am.bg, padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap' }}>{am.label}</span>
                                      </td>
                                      <td style={{ padding: 8, color: '#475569', whiteSpace: 'nowrap' }}>
                                        {it.price == null ? '—' : it.price.toLocaleString('ar-IQ')}
                                        {it.priceChanged && it.currentPrice != null && (
                                          <span style={{ color: '#b45309', fontSize: 10 }}> (كان {it.currentPrice.toLocaleString('ar-IQ')})</span>
                                        )}
                                      </td>
                                      <td style={{ padding: 8 }}>
                                        {it.action === 'item-confirm' ? (
                                          <select
                                            value={it.targetItemId ?? ''}
                                            onChange={e => setItemDecision(ci, ii, {
                                              targetItemId: e.target.value === '__new__' ? null : parseInt(e.target.value),
                                              action: e.target.value === '__new__' ? 'item-create' : 'item-confirm',
                                            })}
                                            style={{ padding: '4px 8px', borderRadius: 6, border: `1.5px solid ${unresolved ? '#f59e0b' : '#e2e8f0'}`, fontSize: 11, width: '100%' }}
                                          >
                                            <option value="">— اختر المطابق —</option>
                                            {it.suggestions.map(s => <option key={s.id} value={s.id}>🔗 {s.name} ({Math.round(s.sim * 100)}%)</option>)}
                                            <option value="__new__">➕ إنشاؤه كايتم جديد</option>
                                          </select>
                                        ) : it.matchedName ? (
                                          <span style={{ color: '#64748b' }}>🔗 {it.matchedName}</span>
                                        ) : it.action === 'item-promote' ? (
                                          <span style={{ color: '#7c3aed' }}>
                                            من الطابور
                                            {it.tempCandidates[0]?.salesCount ? ` · ${it.tempCandidates[0].salesCount} مبيعة` : ''}
                                          </span>
                                        ) : <span style={{ color: '#94a3b8' }}>—</span>}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* مودال إضافة ايتم للكتالوج */}
      {itemModal && (
        <Modal title="إضافة ايتم للكتالوج" onClose={() => setItemModal(false)}>
          <Field label="اسم الايتم *" value={newItem.name} onChange={v => setNewItem({ ...newItem, name: v })} placeholder="مثال: AIRTIDE 100 50MCG 60CAP INHALER" />
          <Field label="الاسم العلمي" value={newItem.scientificName} onChange={v => setNewItem({ ...newItem, scientificName: v })} />
          <Field label="الجرعة" value={newItem.dosage} onChange={v => setNewItem({ ...newItem, dosage: v })} />
          <Field label="الشكل الدوائي" value={newItem.form} onChange={v => setNewItem({ ...newItem, form: v })} />
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <Field label="🏢 سعر مكتب" type="number" value={newItem.price} onChange={v => setNewItem({ ...newItem, price: v })} />
            </div>
            <div style={{ flex: 1 }}>
              <Field label="📦 سعر مذخر" type="number" value={newItem.warehousePrice} onChange={v => setNewItem({ ...newItem, warehousePrice: v })} />
            </div>
          </div>
          <button onClick={addItem} disabled={busy || !newItem.name.trim()} style={{ ...btnStyle('#6366f1'), width: '100%', marginTop: 8 }}>حفظ</button>
        </Modal>
      )}

      {/* مودال تعديل سعر ايتم */}
      {priceFor && (
        <Modal title={`تعديل سعر «${priceFor.name}»`} onClose={() => setPriceFor(null)}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <Field label="🏢 سعر مكتب" type="number" value={priceForm.price} onChange={v => setPriceForm({ ...priceForm, price: v })} />
            </div>
            <div style={{ flex: 1 }}>
              <Field label="📦 سعر مذخر" type="number" value={priceForm.warehousePrice} onChange={v => setPriceForm({ ...priceForm, warehousePrice: v })} />
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>سعر المكتب هو الذي يُعبَّأ تلقائياً في خانة «الحساب» عند اختيار الايتم.</div>
          <button onClick={savePrice} disabled={busy} style={{ ...btnStyle('#059669'), width: '100%', marginTop: 8 }}>حفظ السعر</button>
        </Modal>
      )}

      {/* مودال نقل ايتم لشركة أخرى */}
      {transferFor && (
        <Modal title={`نقل «${transferFor.name}» لشركة أخرى`} onClose={() => setTransferFor(null)}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12, lineHeight: 1.7 }}>
            المبيعات والزيارات والتارگت المرتبطة بالايتم ستنتقل معه تلقائياً. لو وُجد ايتم مطابق بالاسم في الشركة الهدف سيتم الدمج بدل التكرار.
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 5 }}>الشركة الهدف *</label>
            <select value={transferTarget} onChange={e => setTransferTarget(e.target.value)}
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 14 }}>
              <option value="">— اختر الشركة الهدف —</option>
              {companies.filter(c => c.id !== (transferFor?.companyId ?? companyId)).map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.office?.name ? ` — ${c.office.name}` : ''}</option>
              ))}
            </select>
          </div>
          <button onClick={doTransfer} disabled={busy || !transferTarget} style={{ ...btnStyle('#0891b2'), width: '100%', marginTop: 4 }}>نقل الايتم</button>
        </Modal>
      )}

      {/* مودال نقل جماعي لعدة ايتمات */}
      {bulkTransferOpen && (
        <Modal title={`نقل ${selectedIds.length} ايتم لشركة أخرى`} onClose={() => setBulkTransferOpen(false)}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12, lineHeight: 1.7 }}>
            المبيعات والزيارات والتارگت المرتبطة بكل ايتم ستنتقل معه تلقائياً. لو وُجد ايتم مطابق بالاسم في الشركة الهدف سيتم الدمج بدل التكرار.
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 5 }}>الشركة الهدف *</label>
            <select value={bulkTarget} onChange={e => setBulkTarget(e.target.value)}
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 14 }}>
              <option value="">— اختر الشركة الهدف —</option>
              {companies.filter(c => c.id !== companyId).map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.office?.name ? ` — ${c.office.name}` : ''}</option>
              ))}
            </select>
          </div>
          <button onClick={doBulkTransfer} disabled={busy || !bulkTarget} style={{ ...btnStyle('#0891b2'), width: '100%', marginTop: 4 }}>
            {busy ? 'جارٍ النقل...' : `نقل ${selectedIds.length} ايتم`}
          </button>
        </Modal>
      )}

      {/* مودال إضافة قاعدة توحيد */}
      {aliasModal && (
        <Modal title="قاعدة توحيد جديدة" onClose={() => setAliasModal(false)}>
          <Field label="الاسم البديل (كما يظهر في الملفات) *" value={newAlias.fromName} onChange={v => setNewAlias({ ...newAlias, fromName: v })} placeholder="مثال: air tide" />
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 5 }}>← يُوحَّد إلى الايتم القانوني *</label>
            <select value={newAlias.toItemId} onChange={e => setNewAlias({ ...newAlias, toItemId: e.target.value })}
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 14 }}>
              <option value="">— اختر ايتماً من الكتالوج —</option>
              {items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <button onClick={addAlias} disabled={busy || !newAlias.fromName.trim() || !newAlias.toItemId} style={{ ...btnStyle('#0891b2'), width: '100%', marginTop: 4 }}>حفظ القاعدة</button>
        </Modal>
      )}
    </div>
  );
}
