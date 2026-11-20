// ════════════════════════════════════════════════════════════════════════════
// SmartUploadModal — «رفع ذكي»: ملفات اليوم كلها مرة واحدة بلا اختيار نوع.
//
// كل ملف يُفحص أولاً بـPOST /api/upload-sales/preview (بلا أي كتابة — lib/uploadPreview.js):
// المكتب أم ميركاتو، مبيعات/ارجاعات/مختلط، العملة، الملف التراكمي الهدف، وكم صفاً
// جديداً مقابل الموجود أصلاً. الحفظ بعدها يرسل كل ملف إلى /api/upload-sales بالنوع
// والعملة المحسومَين — المسار القائم نفسه، فالرفع الفعلي لا يختلف عن الأزرار الثلاثة.
// ملف بلا صف جديد لا يُرفع افتراضياً (لا نسخة جديدة على القرص بلا داعٍ).
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../config/icons';

type FileType = 'sales' | 'returns' | 'auto';
type Currency = 'IQD' | 'USD';

interface Preview {
  fileType: FileType;
  smartReason: string | null;
  source: 'office' | 'mercato';
  currency: Currency;
  currencyReason: 'chosen' | 'existing' | 'existing-other' | 'detected';
  counts: { sales: number; returns: number; skipped: number; total: number };
  newCounts: { sales: number; returns: number; total: number; salesValue: number; returnsValue: number };
  existing: number;
  existingHidden: number;
  dates: { first: string | null; last: string | null; undated: number; newFirst: string | null; newLast: string | null; months: string };
  target: { fileId: number | null; name: string; exists: boolean } | null;
  yazen: { rows: number; newRows: number } | null;
  /** «أحدث ملف هو الصحيح لفترته» — server/lib/cumulativeSupersede.js */
  supersede: Supersede | null;
  sheets: Array<{ name: string; rows: number; hidden: number; read: boolean; mercato: boolean; forceReturn: boolean }>;
  hiddenByFilter: number;
  droppedCrossSheet: number;
  approximate: boolean;
}

interface SupersedeGroup {
  count: number;
  value: number;
  sample: Array<{ date: string | null; pharmacy: string | null; item: string | null; quantity: number; value: number; type: string }>;
}
interface Supersede {
  range: { first: string; last: string };
  inRange: number;
  matched: number;
  coverage: number;
  /** طلبيتها ما زالت في الملف الجديد بأسطر أخرى (كمية/قيمة/مادة تعدّلت أو سطر حُذف) */
  changed: SupersedeGroup;
  /** الطلبية غابت، ورفعتها السابقة نسخة أقدم من هذا الملف ← ملغاة */
  vanished: SupersedeGroup;
  /** الطلبية غابت، لكن رفعتها ملف آخر (مكمّل، أو هذا الملف جزئي) — لا تُخفى افتراضياً */
  foreign: SupersedeGroup & { files: string[] };
}
type SupersedeKind = 'changed' | 'vanished' | 'foreign';
const SUPERSEDE_KINDS: SupersedeKind[] = ['changed', 'vanished', 'foreign'];
const supersedeCount = (s: Supersede | null | undefined) => (s ? s.changed.count + s.vanished.count + s.foreign.count : 0);

type Status = 'queued' | 'previewing' | 'ready' | 'error' | 'uploading' | 'done';

interface Item {
  key: string;
  file: File;
  status: Status;
  preview?: Preview;
  error?: string;
  /** اختيار المستخدم يغلب الحسم التلقائي عند إعادة الفحص */
  override: { fileType?: FileType; currency?: Currency };
  include: boolean;
  /** الأقسام المختارة لإخفاء صفوف رفعات سابقة غابت عن هذا الملف */
  hide: Record<SupersedeKind, boolean>;
  result?: { added: number; skipped: number; hidden: number; hideSkipped: boolean };
}

const defaultHide = (s: Supersede | null): Record<SupersedeKind, boolean> => ({
  changed: !!s && s.changed.count > 0,
  vanished: !!s && s.vanished.count > 0,
  foreign: false,
});

export interface SmartUploadResult {
  fileId: number;
  sourceSystem: string | null;
  unknownItems: string[];
}

interface Props {
  token: string | null;
  initialFiles: File[];
  onClose: () => void;
  /** بعد انتهاء الحفظ: الصفحة تحدّث القائمة وتفعّل الملفات وتفحص أسماء ميركاتو */
  onUploaded: (results: SmartUploadResult[]) => void;
}

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
const isExcel = (f: File) => /\.(xlsx|xls|csv)$/i.test(f.name);
const num = (n: number) => Math.round(n).toLocaleString('en-US');
const shortDate = (d: string | null) => (d ? `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}` : '');
const range = (a: string | null, b: string | null) => (!a ? '' : a === b ? shortDate(a) : `${shortDate(a)} ← ${shortDate(b)}`);

const TYPE_LABEL: Record<FileType, string> = { sales: 'مبيعات', returns: 'ارجاعات', auto: 'مختلط (كل الأوراق)' };
const REASON_LABEL: Record<string, string> = {
  'file-name': 'من اسم الملف', 'sheet-name': 'من اسم الورقة', 'multi-sheet': 'أوراق بالأعمدة نفسها', content: 'من محتوى الملف (الموقع/الكميات/الأسعار)', mercato: '', default: '',
};
const CURRENCY_NOTE: Record<Preview['currencyReason'], string> = {
  existing: 'عملة ملفك الحالي', 'existing-other': 'عملة ملفاتك الأخرى — تأكد منها', detected: 'مكتشفة من القيم — تأكد منها', chosen: '',
};

export default function SmartUploadModal({ token, initialFiles, onClose, onUploaded }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [saving, setSaving] = useState(false);
  const [finished, setFinished] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  const patch = useCallback((key: string, p: Partial<Item>) => {
    setItems(prev => prev.map(it => (it.key === key ? { ...it, ...p } : it)));
  }, []);

  const addFiles = useCallback((files: File[]) => {
    setFinished(false);
    setItems(prev => {
      const seen = new Set(prev.map(i => i.key));
      const fresh = files.filter(isExcel).filter(f => !seen.has(fileKey(f)))
        .map<Item>(f => ({ key: fileKey(f), file: f, status: 'queued', override: {}, include: true, hide: { changed: false, vanished: false, foreign: false } }));
      return [...prev, ...fresh];
    });
  }, []);

  useEffect(() => { if (initialFiles.length) addFiles(initialFiles); }, [initialFiles, addFiles]);

  // فحص ملف واحد في كل مرة — السيرفر بنواة واحدة، وملف مكتب قد يحمل عشرات آلاف الصفوف.
  useEffect(() => {
    if (busyRef.current) return;
    const next = items.find(i => i.status === 'queued');
    if (!next) return;
    busyRef.current = true;
    patch(next.key, { status: 'previewing', error: undefined });
    (async () => {
      try {
        const fd = new FormData();
        fd.append('file', next.file);
        fd.append('fileType', next.override.fileType ?? 'smart');
        if (next.override.currency) fd.append('sourceCurrency', next.override.currency);
        const res = await fetch('/api/upload-sales/preview', { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` } });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.success) throw new Error(String(j.message || j.error || 'تعذّر فحص الملف').split('\n')[0]);
        const p: Preview = j.data;
        const hide = defaultHide(p.supersede);
        // ملف بلا صف جديد يُرفع فقط إن كان سيصحّح صفوفاً قديمة (أُلغيت أو تعدّلت).
        patch(next.key, { status: 'ready', preview: p, hide, include: p.newCounts.total > 0 || hide.changed || hide.vanished });
      } catch (e: any) {
        patch(next.key, { status: 'error', error: e.message || 'تعذّر فحص الملف', include: false });
      } finally {
        busyRef.current = false;
        setItems(prev => [...prev]); // يوقظ التأثير للملف التالي
      }
    })();
  }, [items, patch, token]);

  const reprobe = (it: Item, override: Item['override']) => {
    patch(it.key, { status: 'queued', override: { ...it.override, ...override } });
  };

  const remove = (key: string) => setItems(prev => prev.filter(i => i.key !== key));

  const toSave = items.filter(i => i.status === 'ready' && i.include && i.preview);
  const scanning = items.some(i => i.status === 'queued' || i.status === 'previewing');
  const newTotal = toSave.reduce((s, i) => s + (i.preview?.newCounts.total ?? 0), 0);
  const hideTotal = toSave.reduce((s, i) => s + SUPERSEDE_KINDS
    .reduce((a, k) => a + (i.hide[k] ? (i.preview?.supersede?.[k].count ?? 0) : 0), 0), 0);

  const saveAll = async () => {
    if (!toSave.length) return;
    setSaving(true);
    const results: SmartUploadResult[] = [];
    for (const it of toSave) {
      const p = it.preview!;
      patch(it.key, { status: 'uploading' });
      try {
        const fd = new FormData();
        fd.append('file', it.file);
        fd.append('fileType', p.fileType);
        fd.append('sourceCurrency', p.currency);
        // الحد الأقصى = ما رآه المستخدم هنا؛ إن وجد السيرفر أكثر وقت الحفظ لا يُخفي شيئاً.
        const kinds = p.supersede ? SUPERSEDE_KINDS.filter(k => it.hide[k] && p.supersede![k].count > 0) : [];
        if (kinds.length) {
          fd.append('supersede', kinds.join(','));
          fd.append('supersedeMax', String(kinds.reduce((s, k) => s + p.supersede![k].count, 0)));
        }
        const res = await fetch('/api/upload-sales', { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` } });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(String(j.message || j.error || 'فشل الرفع').split('\n')[0]);
        const d = j.data ?? j;
        const sup = d.merge?.superseded;
        patch(it.key, { status: 'done', result: {
          added: d.merge?.added ?? d.rowCount ?? 0, skipped: d.merge?.skipped ?? 0,
          hidden: sup && !sup.skipped ? sup.count : 0, hideSkipped: !!sup?.skipped,
        } });
        if (d.uploadedFile?.id) results.push({ fileId: d.uploadedFile.id, sourceSystem: d.uploadedFile.sourceSystem ?? null, unknownItems: d.unknownItems ?? [] });
      } catch (e: any) {
        patch(it.key, { status: 'error', error: e.message || 'فشل الرفع', include: false });
      }
    }
    setSaving(false);
    setFinished(true);
    if (results.length) onUploaded(results);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files || []));
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        className="m-dialog"
        style={{ background: 'var(--c-surface, #fff)', color: 'var(--c-text-primary, #1e293b)', borderRadius: 16, padding: '1.25rem 1.4rem', width: 'min(760px, calc(100vw - 32px))', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.22)', direction: 'rtl' }}
        onClick={e => e.stopPropagation()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={onDrop}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Icon name="import" size={18} style={{ color: 'var(--c-success, #059669)' }} />
          <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800 }}>رفع ذكي</h3>
          <button onClick={onClose} disabled={saving} aria-label="إغلاق"
            style={{ marginInlineStart: 'auto', background: 'none', border: 'none', cursor: saving ? 'default' : 'pointer', color: 'var(--c-text-muted, #94a3b8)' }}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--c-text-secondary, #64748b)', lineHeight: 1.7 }}>
          اختر ملفات اليوم كلها (المكتب، الإرجاع، ميركاتو) بأي ترتيب. كل ملف يُفحص قبل الحفظ ويذهب لملفه التراكمي،
          والصفوف الموجودة سابقاً لا تُضاف مرة ثانية.
        </p>

        <div
          onClick={() => pickRef.current?.click()}
          style={{
            border: `1.5px dashed ${dragging ? 'var(--c-accent)' : 'var(--c-border, #cbd5e1)'}`, borderRadius: 10,
            background: dragging ? 'var(--c-accent-light)' : 'var(--c-bg, #f8fafc)',
            padding: items.length ? '8px' : '22px 8px', textAlign: 'center', cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
            color: 'var(--c-accent)', marginBottom: 10, flexShrink: 0,
          }}
        >
          <input ref={pickRef} type="file" multiple accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
          {items.length ? '+ إضافة ملفات' : 'اسحب الملفات هنا أو اضغط للاختيار (.xlsx · .xls · .csv)'}
        </div>

        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          {items.map(it => <FileCard key={it.key} it={it} saving={saving}
            onToggle={() => patch(it.key, { include: !it.include })}
            onHide={(k, v) => patch(it.key, { hide: { ...it.hide, [k]: v } })}
            onType={t => reprobe(it, { fileType: t })}
            onCurrency={c => reprobe(it, { currency: c })}
            onRetry={() => reprobe(it, {})}
            onRemove={() => remove(it.key)} />)}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--c-text-secondary, #64748b)' }}>
            {scanning ? '⏳ جاري فحص الملفات…'
              : finished ? 'تم الحفظ — الملفات المرفوعة فُعّلت في التحليل.'
              : toSave.length ? `سيُرفع ${toSave.length} ملف · ${num(newTotal)} صف جديد${hideTotal ? ` · يُخفى ${num(hideTotal)} صف قديم` : ''}` : items.length ? 'لا ملف محدد للرفع' : ''}
          </span>
          <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={saving}
              style={{ padding: '8px 16px', background: 'var(--c-bg, #f3f4f6)', color: 'var(--c-text-primary, #374151)', border: '1px solid var(--c-border, #d1d5db)', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
              {finished ? 'إغلاق' : 'إلغاء'}
            </button>
            {!finished && (
              <button onClick={saveAll} disabled={saving || scanning || !toSave.length}
                style={{ padding: '8px 20px', background: 'var(--c-success, #059669)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 800, fontSize: 13,
                  cursor: saving || scanning || !toSave.length ? 'default' : 'pointer', opacity: saving || scanning || !toSave.length ? 0.55 : 1 }}>
                {saving ? '⏳ جاري الحفظ…' : `حفظ (${toSave.length})`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── بطاقة ملف واحد ──────────────────────────────────────────────────────────

function FileCard({ it, saving, onToggle, onHide, onType, onCurrency, onRetry, onRemove }: {
  it: Item; saving: boolean;
  onToggle: () => void; onHide: (k: SupersedeKind, v: boolean) => void;
  onType: (t: FileType) => void; onCurrency: (c: Currency) => void; onRetry: () => void; onRemove: () => void;
}) {
  const p = it.preview;
  const locked = saving || it.status === 'uploading' || it.status === 'done';
  // أثناء إعادة الفحص: تغيير ثانٍ كان سيضيع حين يعود ردّ الفحص الأول.
  const selLocked = locked || it.status === 'queued' || it.status === 'previewing';
  const nothingNew = p && p.newCounts.total === 0;
  const selectStyle: React.CSSProperties = {
    fontSize: 11.5, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--c-border, #d1d5db)',
    background: 'var(--c-surface, #fff)', color: 'var(--c-text-primary, #1e293b)',
  };
  const chip = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, whiteSpace: 'nowrap' });

  return (
    <div style={{
      border: '1px solid var(--c-border, #e2e8f0)', borderRadius: 10, padding: '9px 11px',
      background: it.status === 'done' ? 'var(--c-success-bg, #ecfdf5)' : it.status === 'error' ? 'var(--c-danger-bg, #fef2f2)' : 'var(--c-surface, #fff)',
      opacity: p && !it.include && it.status === 'ready' ? 0.7 : 1,
    }}>
      {/* السطر الأول: التحديد + الاسم + الحالة */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {it.status === 'ready' && (
          <input type="checkbox" checked={it.include} onChange={onToggle} disabled={locked} style={{ accentColor: 'var(--c-success, #059669)' }} />
        )}
        <Icon name="excel" size={15} style={{ color: 'var(--c-success, #059669)', flexShrink: 0 }} />
        {/* الاسم بلا الامتداد: «20-11.xlsx» بعد اسم عربي كان يُعرض مقلوباً («xlsx.11-20 …»). الكامل في title. */}
        <span style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }} title={it.file.name}>
          {it.file.name.replace(/\.(xlsx|xls|csv)$/i, '')}
        </span>
        <span style={{ fontSize: 11.5, whiteSpace: 'nowrap', color: 'var(--c-text-secondary, #64748b)' }}>
          {it.status === 'queued' && 'بالانتظار'}
          {it.status === 'previewing' && '⏳ يُفحص…'}
          {it.status === 'uploading' && '⏳ يُرفع…'}
          {it.status === 'done' && it.result && <b style={{ color: 'var(--c-success, #059669)' }}>
            ✓ أُضيف {num(it.result.added)}{it.result.skipped ? ` · أُسقط ${num(it.result.skipped)} مكرر` : ''}
            {it.result.hidden ? ` · أُخفي ${num(it.result.hidden)} صف قديم` : ''}
          </b>}
          {it.status === 'done' && it.result?.hideSkipped && (
            <b style={{ color: 'var(--c-warning, #b45309)' }}> · لم يُخفَ شيء (تغيّر الملف منذ الفحص)</b>
          )}
        </span>
        {!locked && it.status !== 'previewing' && (
          <button onClick={onRemove} aria-label="إزالة" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted, #94a3b8)', padding: 0 }}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      {it.status === 'error' && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--c-danger, #dc2626)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          ✗ {it.error}
          {!p && !saving && <button onClick={onRetry} style={{ fontSize: 11.5, border: '1px solid currentColor', background: 'none', color: 'inherit', borderRadius: 6, padding: '1px 8px', cursor: 'pointer' }}>إعادة الفحص</button>}
        </div>
      )}

      {p && (
        <>
          {/* السطر الثاني: المصدر + النوع + العملة + الوجهة */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
            {p.source === 'mercato'
              ? <span style={chip('var(--c-purple-bg, #f5f3ff)', 'var(--c-purple, #7c3aed)')}>🏬 ميركاتو</span>
              : <span style={chip('var(--c-accent-light, #eff6ff)', 'var(--c-accent, #2563eb)')}>🏢 المكتب</span>}
            <select value={p.fileType} disabled={selLocked} onChange={e => onType(e.target.value as FileType)} style={selectStyle} title="نوع الملف">
              {(Object.keys(TYPE_LABEL) as FileType[]).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            {REASON_LABEL[p.smartReason ?? ''] && !it.override.fileType && (
              <span style={{ fontSize: 10.5, color: 'var(--c-text-muted, #94a3b8)' }}>{REASON_LABEL[p.smartReason ?? '']}</span>
            )}
            <select value={p.currency} disabled={selLocked} onChange={e => onCurrency(e.target.value as Currency)} style={selectStyle} title="العملة">
              <option value="IQD">د.ع</option>
              <option value="USD">$</option>
            </select>
            {CURRENCY_NOTE[p.currencyReason] && !it.override.currency && (
              <span style={{ fontSize: 10.5, color: p.currencyReason === 'existing' ? 'var(--c-text-muted, #94a3b8)' : 'var(--c-warning, #b45309)' }}>{CURRENCY_NOTE[p.currencyReason]}</span>
            )}
            {p.target && (
              // ملف جديد = لا ملف تراكمي لهذا المصدر بهذه العملة في حسابك — يُلفت النظر قبل إنشائه.
              <span style={{ fontSize: 11, marginInlineStart: 'auto', color: p.target.exists ? 'var(--c-text-secondary, #64748b)' : 'var(--c-warning, #b45309)', fontWeight: p.target.exists ? 400 : 700 }}>
                ← {p.target.exists ? p.target.name : `ملف جديد: ${p.target.name}`}
              </span>
            )}
          </div>

          {/* السطر الثالث: الأرقام */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 7, fontSize: 12 }}>
            <span>
              <b style={{ color: nothingNew ? 'var(--c-text-muted, #94a3b8)' : 'var(--c-success, #059669)', fontSize: 13.5 }}>{num(p.newCounts.total)}</b> جديد
              {p.newCounts.returns > 0 && p.newCounts.sales > 0 && (
                <span style={{ color: 'var(--c-text-muted, #94a3b8)' }}> (مبيعات {num(p.newCounts.sales)} · ارجاع {num(p.newCounts.returns)})</span>
              )}
            </span>
            <span style={{ color: 'var(--c-text-secondary, #64748b)' }}>{num(p.existing)} موجود سابقاً</span>
            {(p.dates.newFirst || p.dates.first) && (
              <span style={{ color: 'var(--c-text-secondary, #64748b)' }}>
                <Icon name="calendar" size={12} style={{ verticalAlign: -2 }} /> {p.newCounts.total ? `الجديد: ${range(p.dates.newFirst, p.dates.newLast)}` : `الملف: ${range(p.dates.first, p.dates.last)}`}
              </span>
            )}
            {p.counts.skipped > 0 && <span style={{ color: 'var(--c-text-muted, #94a3b8)' }}>{num(p.counts.skipped)} صف متروك (بلا كمية)</span>}
          </div>

          {/* اليزن */}
          {p.yazen && p.yazen.rows > 0 && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--c-purple, #7c3aed)' }}>
              🏬 منها {num(p.yazen.rows)} صف مذخر اليزن — تُحسب مكتباً للمسوّقين، ولا تُحسب للمندوب العلمي (مكتبه من ملف المكتب).
            </div>
          )}

          {p.supersede && supersedeCount(p.supersede) > 0 && (
            <SupersedeBox s={p.supersede} hide={it.hide} currency={p.currency} disabled={locked || !it.include} onHide={onHide} />
          )}

          {/* التنبيهات */}
          {p.hiddenByFilter > 0 && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--c-danger, #dc2626)', fontWeight: 700 }}>
              ⚠️ فلتر إكسل يخفي {num(p.hiddenByFilter)} صف — لن تُرفع. إن كانت مطلوبة امسح الفلتر في الإكسل واختر الملف مرة ثانية.
            </div>
          )}
          {nothingNew && p.counts.total > 0 && !supersedeCount(p.supersede) && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--c-text-muted, #94a3b8)' }}>كل صفوفه موجودة سابقاً — لا حاجة لرفعه.</div>
          )}
          {p.existingHidden > 0 && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--c-warning, #b45309)' }}>
              {num(p.existingHidden)} من الصفوف الموجودة مخفية الآن (رفعة موقوفة أو فلتر أعمدة) — رفع الملف يعيد إظهار ما في رفعة موقوفة.
            </div>
          )}
          {p.approximate && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--c-warning, #b45309)' }}>العدّ تقريبي: الملف التراكمي يُعاد ختمه تلقائياً عند الرفع، والمكرر يُسقط عندها.</div>
          )}
          {p.sheets.filter(s => s.read).length > 1 && (
            <div style={{ marginTop: 5, fontSize: 10.5, color: 'var(--c-text-muted, #94a3b8)' }}>
              الأوراق المقروءة: {p.sheets.filter(s => s.read).map(s => `${s.name} (${num(s.rows)})`).join('، ')}
              {p.droppedCrossSheet > 0 && ` · أُسقط ${num(p.droppedCrossSheet)} صف مكرر بين الأوراق`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── «أحدث ملف هو الصحيح لفترته» ─────────────────────────────────────────────

function SupersedeBox({ s, hide, currency, disabled, onHide }: {
  s: Supersede; hide: Record<SupersedeKind, boolean>; currency: Currency; disabled: boolean;
  onHide: (k: SupersedeKind, v: boolean) => void;
}) {
  const [open, setOpen] = useState<SupersedeKind | null>(null);
  const cur = currency === 'USD' ? '$' : 'د.ع';
  const pct = Math.round(s.coverage * 100);
  const line = (k: SupersedeKind, label: React.ReactNode) => {
    const g = s[k];
    if (!g.count) return null;
    return (
      <div style={{ marginTop: 5 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: disabled ? 'default' : 'pointer' }}>
          <input type="checkbox" checked={hide[k]} disabled={disabled} onChange={e => onHide(k, e.target.checked)}
            style={{ accentColor: 'var(--c-warning, #b45309)', marginTop: 2 }} />
          <span>
            <b>{num(g.count)}</b> {label} <span style={{ color: 'var(--c-text-muted, #94a3b8)' }}>({num(g.value)} {cur})</span>
            <button type="button" onClick={() => setOpen(open === k ? null : k)}
              style={{ marginInlineStart: 6, fontSize: 10.5, background: 'none', border: 'none', color: 'var(--c-accent)', cursor: 'pointer', padding: 0 }}>
              {open === k ? 'إخفاء القائمة' : 'عرض'}
            </button>
          </span>
        </label>
        {open === k && (
          <div style={{ margin: '4px 22px 0 0', fontSize: 10.5, color: 'var(--c-text-secondary, #64748b)', lineHeight: 1.7 }}>
            {g.sample.map((r, i) => (
              <div key={i}>{shortDate(r.date)} · {r.pharmacy || '—'} · {r.item || '—'} · {num(r.quantity)}{r.type === 'return' ? ' (ارجاع)' : ''}</div>
            ))}
            {g.count > g.sample.length && <div>… و{num(g.count - g.sample.length)} غيرها</div>}
          </div>
        )}
      </div>
    );
  };
  return (
    <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.6,
      background: 'var(--c-warning-bg, #fffbeb)', border: '1px solid var(--c-warning-border, #fde68a)', color: 'var(--c-text-primary, #1e293b)' }}>
      <div style={{ fontWeight: 700 }}>
        🔄 صفوف رُفعت سابقاً للفترة {range(s.range.first, s.range.last)} وليست في هذا الملف
        <span style={{ fontWeight: 400, color: 'var(--c-text-muted, #94a3b8)' }}> — الملف يحوي {pct}% من صفوف الفترة السابقة</span>
      </div>
      {line('changed', 'صف تعدّل في طلبيات ما زالت في الملف (كمية أو قيمة أو مادة) — تُخفى النسخة القديمة')}
      {line('vanished', 'صف لطلبيات لم تعد في الملف، من نسخة سابقة منه (ملغاة أو محذوفة) — تُخفى')}
      {line('foreign', <>
        صف من ملف آخر رُفع لنفس الفترة{s.foreign.files.length ? <> («{s.foreign.files.slice(0, 3).join('»، «')}»)</> : null}
        {' '}<span style={{ color: 'var(--c-danger, #dc2626)', fontWeight: 700 }}>— غالباً مكمّل لا ملغى، أو هذا الملف جزئي (منطقة/شركة). لا تُخفِها إلا إن كنت متأكداً.</span>
      </>)}
      <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--c-text-muted, #94a3b8)' }}>
        لا يُحذف شيء: المخفي يُحفظ كرفعة موقوفة «مُستبدَل بـ…» في قائمة رفعات الملف، ويعود بتفعيلها.
      </div>
    </div>
  );
}
